package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/aws/signer/v4"
)

// maxRequestBytes matches the application's default one-megabyte JSON body limit.
const maxRequestBytes = 1 << 20

// maxConcurrentRequests bounds buffered bodies and active streams on the small HAProxy host.
const maxConcurrentRequests = 32

// unsignedPayload is explicitly supported by the Lambda Web Function IAM frontend over TLS.
const unsignedPayload = "UNSIGNED-PAYLOAD"

// signingTransport signs each outgoing request with the current cached EC2 credentials.
type signingTransport struct {
	credentials aws.CredentialsProvider
	signer      *v4.Signer
	region      string
	clock       func() time.Time
	reads       http.RoundTripper
	writes      http.RoundTripper
}

// RoundTrip removes viewer signatures, signs the unchanged body and attempts its upstream request once.
func (transport *signingTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	outgoing := request.Clone(request.Context())
	outgoing.GetBody = nil
	for name := range outgoing.Header {
		if isSigningHeader(name) {
			outgoing.Header.Del(name)
		}
	}
	// Prevent caller idempotency headers from enabling an implicit transport replay.
	outgoing.Header.Del("Idempotency-Key")
	outgoing.Header.Del("X-Idempotency-Key")
	query := outgoing.URL.Query()
	for name := range query {
		if strings.HasPrefix(strings.ToLower(name), "x-amz-") {
			query.Del(name)
		}
	}
	outgoing.URL.RawQuery = query.Encode()
	outgoing.Header.Set("X-Amz-Content-Sha256", unsignedPayload)
	credentialContext, cancel := context.WithTimeout(outgoing.Context(), 5*time.Second)
	credentials, err := transport.credentials.Retrieve(credentialContext)
	cancel()
	if err != nil {
		return nil, errors.New("instance credentials are unavailable")
	}
	if err := transport.signer.SignHTTP(outgoing.Context(), credentials, outgoing, unsignedPayload,
		"lambda", transport.region, transport.clock()); err != nil {
		return nil, errors.New("request signing failed")
	}
	if outgoing.Method == http.MethodGet || outgoing.Method == http.MethodHead || outgoing.Method == http.MethodOptions {
		return transport.reads.RoundTrip(outgoing)
	}
	return transport.writes.RoundTrip(outgoing)
}

// upstreamTransports reuse read connections but forbid connection-reuse retries for application writes.
func upstreamTransports() (*http.Transport, *http.Transport) {
	reads := &http.Transport{
		Proxy:                  nil,
		DialContext:            (&net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		TLSClientConfig:        &tls.Config{MinVersion: tls.VersionTLS12},
		TLSHandshakeTimeout:    5 * time.Second,
		ResponseHeaderTimeout:  20 * time.Second,
		ExpectContinueTimeout:  time.Second,
		MaxResponseHeaderBytes: 64 << 10,
		MaxIdleConns:           4,
		MaxIdleConnsPerHost:    2,
		MaxConnsPerHost:        16,
		IdleConnTimeout:        time.Minute,
	}
	writes := reads.Clone()
	writes.DisableKeepAlives = true
	return reads, writes
}

// proxyHandler constructs a fixed-destination reverse proxy with immediate SSE flushing and safe errors.
func proxyHandler(config configuration, credentials aws.CredentialsProvider, reads, writes http.RoundTripper) http.Handler {
	active := make(chan struct{}, maxConcurrentRequests)
	proxy := &httputil.ReverseProxy{
		Rewrite: func(request *httputil.ProxyRequest) {
			request.SetURL(config.origin)
			request.Out.Host = config.origin.Host
			// HAProxy owns these values; Rewrite removes them unless explicitly preserved.
			for _, header := range []string{"X-Forwarded-For", "X-Forwarded-Proto", "X-Forwarded-Host"} {
				request.Out.Header.Del(header)
				for _, value := range request.In.Header.Values(header) {
					request.Out.Header.Add(header, value)
				}
			}
		},
		Transport: &signingTransport{credentials: credentials, signer: v4.NewSigner(), region: config.region,
			clock: time.Now, reads: reads, writes: writes},
		FlushInterval: -1,
		ErrorLog:      log.New(io.Discard, "", 0),
		ErrorHandler: func(writer http.ResponseWriter, _ *http.Request, _ error) {
			writer.Header().Set("Cache-Control", "no-store")
			http.Error(writer, "The application could not be reached. Retry safely.", http.StatusServiceUnavailable)
		},
	}
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.IsAbs() || request.Method == http.MethodConnect {
			http.Error(writer, "Forward proxy requests are not supported.", http.StatusBadRequest)
			return
		}
		switch request.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions, http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
		default:
			http.Error(writer, "Unsupported method.", http.StatusMethodNotAllowed)
			return
		}
		// Acquire before reading bodies or credentials; a stream holds its slot until it disconnects.
		select {
		case active <- struct{}{}:
			defer func() { <-active }()
		default:
			writer.Header().Set("Cache-Control", "no-store")
			http.Error(writer, "The signing proxy is busy. Retry safely.", http.StatusServiceUnavailable)
			return
		}
		if request.ContentLength > maxRequestBytes {
			http.Error(writer, "Request body exceeds the application limit.", http.StatusRequestEntityTooLarge)
			return
		}
		// Buffer only bounded requests, never responses, to reject partial oversized JSON before forwarding.
		if request.Body == nil {
			request.Body = http.NoBody
		}
		defer request.Body.Close()
		body, err := io.ReadAll(http.MaxBytesReader(writer, request.Body, maxRequestBytes))
		if err != nil {
			var limit *http.MaxBytesError
			if errors.As(err, &limit) {
				http.Error(writer, "Request body exceeds the application limit.", http.StatusRequestEntityTooLarge)
			} else {
				http.Error(writer, "Could not read the request body.", http.StatusBadRequest)
			}
			return
		}
		request.Body = io.NopCloser(bytes.NewReader(body))
		request.ContentLength = int64(len(body))
		request.TransferEncoding = nil
		request.GetBody = nil
		if request.Method != http.MethodGet || request.URL.Path != "/api/stream" {
			ctx, cancel := context.WithTimeout(request.Context(), time.Minute)
			defer cancel()
			request = request.WithContext(ctx)
		}
		proxy.ServeHTTP(writer, request)
	})
}

// localServer bounds request reads and headers while leaving streaming response duration unbounded.
func localServer(handler http.Handler) *http.Server {
	return &http.Server{Addr: listenAddress, Handler: handler, ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout: 15 * time.Second, IdleTimeout: time.Minute, MaxHeaderBytes: 32 << 10,
		ErrorLog: log.New(io.Discard, "", 0)}
}
