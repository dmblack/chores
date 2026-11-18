// Command chores-signer signs only this household's AWS Web Function requests using the EC2 role.
package main

import (
	"context"
	"errors"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

// run owns the loopback listener and cancels active upstream requests during bounded shutdown.
func run() error {
	config, err := configFromEnv(os.Getenv)
	if err != nil {
		return err
	}
	reads, writes := upstreamTransports()
	defer reads.CloseIdleConnections()
	defer writes.CloseIdleConnections()
	metadata := metadataHTTPClient()
	defer metadata.CloseIdleConnections()
	server := localServer(proxyHandler(config, instanceCredentials(metadata), reads, writes))
	listener, err := net.Listen("tcp4", listenAddress)
	if err != nil {
		return errors.New("could not bind the loopback signing listener")
	}
	defer listener.Close()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	log.Print("Chores signing proxy listening on " + listenAddress)
	return serveUntilCanceled(ctx, server, listener, 5*time.Second)
}

// serveUntilCanceled waits for graceful shutdown and force-closes remaining streams after its deadline.
func serveUntilCanceled(ctx context.Context, server *http.Server, listener net.Listener, grace time.Duration) error {
	shutdownContext, stop := context.WithCancel(ctx)
	defer stop()
	shutdownDone := make(chan struct{})
	go func() {
		defer close(shutdownDone)
		<-shutdownContext.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), grace)
		defer cancel()
		_ = server.Shutdown(shutdown)
		_ = server.Close()
	}()
	err := server.Serve(listener)
	stop()
	<-shutdownDone
	if err != nil && !errors.Is(err, http.ErrServerClosed) {
		return errors.New("the loopback signing listener stopped unexpectedly")
	}
	return nil
}

// main reports only safe startup failures, never request, credential or upstream response contents.
func main() {
	if err := run(); err != nil {
		log.Print(err.Error())
		os.Exit(1)
	}
}
