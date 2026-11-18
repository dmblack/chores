package main

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
)

// roundTripFunc supplies local HTTP stubs without contacting AWS or requiring credentials.
type roundTripFunc func(*http.Request) (*http.Response, error)

// RoundTrip delegates a test request to its local fixture.
func (function roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}

// testConfig creates a valid fixed regional origin for tests that never resolve its hostname.
func testConfig(t *testing.T) configuration {
	t.Helper()
	values := map[string]string{"AWS_REGION": "us-west-2", "AWS_WEB_FUNCTION_URL": "https://example.shard.lambda-web.us-west-2.on.aws"}
	config, err := configFromEnv(func(name string) string { return values[name] })
	if err != nil {
		t.Fatal(err)
	}
	return config
}

// testCredentials returns explicitly fake keys through the SDK provider interface, not the environment.
func testCredentials() aws.CredentialsProvider {
	return aws.CredentialsProviderFunc(func(context.Context) (aws.Credentials, error) {
		return aws.Credentials{AccessKeyID: "fixture-key", SecretAccessKey: "fixture-secret", SessionToken: "fixture-token"}, nil
	})
}

// responseWith builds a bounded local upstream response for proxy contract tests.
func responseWith(body string) *http.Response {
	return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}
}

// TestConfigurationAndLoopback rejects URL injection and verifies the listener cannot be exposed by environment variables.
func TestConfigurationAndLoopback(t *testing.T) {
	invalid := []string{"http://example.shard.lambda-web.us-west-2.on.aws", "https://example.shard.lambda-web.us-east-1.on.aws",
		"https://example.shard.lambda-web.us-west-2.on.aws:443", "https://user:secret@example.shard.lambda-web.us-west-2.on.aws",
		"https://example.shard.lambda-web.us-west-2.on.aws/other", "https://example.shard.lambda-web.us-west-2.on.aws?x=1",
		"https://example.shard.lambda-web.us-west-2.on.aws#fragment", "https://example.shard.lambda-web.us-west-2.on.aws.attacker.test", ""}
	for _, origin := range invalid {
		_, err := configFromEnv(func(name string) string {
			if name == "AWS_REGION" {
				return "us-west-2"
			}
			return origin
		})
		if err == nil {
			t.Fatalf("accepted an invalid origin: %q", origin)
		}
		if strings.Contains(err.Error(), "secret") {
			t.Fatal("configuration errors must not expose URL credentials")
		}
	}
	server := localServer(http.NotFoundHandler())
	host, port, err := net.SplitHostPort(server.Addr)
	if err != nil || !net.ParseIP(host).IsLoopback() || port != "8787" {
		t.Fatal("the signer must bind only to the fixed loopback port")
	}
	if server.ReadHeaderTimeout <= 0 || server.ReadTimeout <= 0 || server.MaxHeaderBytes > 32<<10 || server.WriteTimeout != 0 {
		t.Fatal("request bounds must coexist with unbounded streaming responses")
	}
	reads, writes := upstreamTransports()
	defer reads.CloseIdleConnections()
	defer writes.CloseIdleConnections()
	if reads.Proxy != nil || reads.TLSClientConfig.InsecureSkipVerify || reads.TLSClientConfig.MinVersion < tls.VersionTLS12 {
		t.Fatal("upstream TLS must be verified without environment proxy routing")
	}
	if !writes.DisableKeepAlives {
		t.Fatal("write connections must not be reused for automatic transport retries")
	}
}

// TestFixedOriginAndBody verifies host isolation, exact request bytes, signature headers and trusted forwarding values.
func TestFixedOriginAndBody(t *testing.T) {
	config := testConfig(t)
	payload := "{\"value\":\"unchanged\\ntext\"}\n"
	var called atomic.Int32
	upstream := roundTripFunc(func(request *http.Request) (*http.Response, error) {
		called.Add(1)
		if request.Host != config.origin.Host || request.URL.Host != config.origin.Host || request.URL.Scheme != "https" {
			t.Error("viewer Host escaped the fixed destination")
		}
		body, err := io.ReadAll(request.Body)
		if err != nil || string(body) != payload {
			t.Error("request body bytes changed")
		}
		if request.Header.Get("X-Amz-Content-Sha256") != unsignedPayload {
			t.Error("mandatory payload header is absent")
		}
		authorization := request.Header.Get("Authorization")
		if !strings.Contains(authorization, "Credential=fixture-key/") || !strings.Contains(authorization, "/us-west-2/lambda/aws4_request") ||
			!strings.Contains(authorization, "x-amz-content-sha256") {
			t.Error("the AWS SDK did not sign the required region, service and hash header")
		}
		if request.Header.Get("X-Amz-Security-Token") != "fixture-token" || request.Header.Get("X-Amzn-Trace-Id") != "" ||
			request.URL.Query().Get("X-Amz-Signature") != "" {
			t.Error("viewer AWS signing context survived sanitization")
		}
		if request.Header.Get("Cookie") != "sid=fixture-session" || request.Header.Get("X-App-Origin-Secret") != "fixture-origin" ||
			request.Header.Get("X-Forwarded-For") != "192.0.2.1" {
			t.Error("application cookies or HAProxy context were lost")
		}
		return responseWith("ok"), nil
	})
	proxy := proxyHandler(config, testCredentials(), upstream, upstream)
	request := httptest.NewRequest(http.MethodPost, "/api/actions?normal=value&X-Amz-Signature=attacker", strings.NewReader(payload))
	request.Host = "attacker.test"
	request.Header = http.Header{"Authorization": {"attacker"}, "X-Amz-Security-Token": {"attacker"}, "X-Amz-Content-Sha256": {"attacker"},
		"X-Amzn-Trace-Id": {"attacker"}, "Cookie": {"sid=fixture-session"}, "X-App-Origin-Secret": {"fixture-origin"}, "X-Forwarded-For": {"192.0.2.1"}}
	writer := httptest.NewRecorder()
	proxy.ServeHTTP(writer, request)
	if writer.Code != http.StatusOK || writer.Body.String() != "ok" || called.Load() != 1 {
		t.Fatal("the fixed-origin request did not complete once")
	}
	for _, invalid := range []*http.Request{httptest.NewRequest(http.MethodGet, "https://attacker.test/api/state", nil),
		httptest.NewRequest(http.MethodConnect, "/", nil)} {
		writer = httptest.NewRecorder()
		proxy.ServeHTTP(writer, invalid)
		if writer.Code != http.StatusBadRequest {
			t.Fatal("a generic forward-proxy request was accepted")
		}
	}
	if called.Load() != 1 {
		t.Fatal("rejected forward-proxy requests reached the upstream")
	}
}

// TestBodyLimitAndWriteFailure prevents oversized requests, automatic retries and diagnostic leakage.
func TestBodyLimitAndWriteFailure(t *testing.T) {
	var calls atomic.Int32
	upstream := roundTripFunc(func(*http.Request) (*http.Response, error) {
		calls.Add(1)
		return nil, errors.New("upstream error containing a private diagnostic")
	})
	proxy := proxyHandler(testConfig(t), testCredentials(), upstream, upstream)
	oversized := httptest.NewRequest(http.MethodPost, "/api/actions", strings.NewReader(strings.Repeat("x", maxRequestBytes+1)))
	oversized.ContentLength = -1
	writer := httptest.NewRecorder()
	proxy.ServeHTTP(writer, oversized)
	if writer.Code != http.StatusRequestEntityTooLarge || calls.Load() != 0 {
		t.Fatal("an oversized body reached the upstream")
	}
	request := httptest.NewRequest(http.MethodPost, "/api/actions", strings.NewReader("{}"))
	request.Header.Set("Idempotency-Key", "viewer-retry")
	writer = httptest.NewRecorder()
	proxy.ServeHTTP(writer, request)
	if writer.Code != http.StatusServiceUnavailable || calls.Load() != 1 || strings.Contains(writer.Body.String(), "private diagnostic") {
		t.Fatal("a write was retried or an upstream diagnostic leaked")
	}
}

// countedBody detects whether an overloaded request was read before receiving its rejection.
type countedBody struct{ reads atomic.Int32 }

// Read records an attempted body read without exposing data to the local fixture.
func (body *countedBody) Read([]byte) (int, error) {
	body.reads.Add(1)
	return 0, io.EOF
}

// Close satisfies the request-body contract without allocating external resources.
func (*countedBody) Close() error { return nil }

// TestConcurrencyLimit rejects overflow before reading or signing, then reuses released capacity.
func TestConcurrencyLimit(t *testing.T) {
	entered := make(chan struct{}, maxConcurrentRequests+1)
	release := make(chan struct{})
	finished := make(chan int, maxConcurrentRequests)
	var retrievals atomic.Int32
	credentials := aws.CredentialsProviderFunc(func(ctx context.Context) (aws.Credentials, error) {
		retrievals.Add(1)
		return testCredentials().Retrieve(ctx)
	})
	upstream := roundTripFunc(func(*http.Request) (*http.Response, error) {
		entered <- struct{}{}
		<-release
		return responseWith("ok"), nil
	})
	proxy := proxyHandler(testConfig(t), credentials, upstream, upstream)
	for range maxConcurrentRequests {
		go func() {
			writer := httptest.NewRecorder()
			proxy.ServeHTTP(writer, httptest.NewRequest(http.MethodGet, "/api/stream", nil))
			finished <- writer.Code
		}()
	}
	// Every admitted request must be active before the overflow assertion can be meaningful.
	for range maxConcurrentRequests {
		select {
		case <-entered:
		case <-time.After(3 * time.Second):
			close(release)
			t.Fatal("admitted requests did not occupy their concurrency slots")
		}
	}
	body := &countedBody{}
	request := httptest.NewRequest(http.MethodPost, "/api/actions", nil)
	request.Body = body
	writer := httptest.NewRecorder()
	proxy.ServeHTTP(writer, request)
	if writer.Code != http.StatusServiceUnavailable || writer.Header().Get("Cache-Control") != "no-store" ||
		body.reads.Load() != 0 || retrievals.Load() != maxConcurrentRequests || len(entered) != 0 {
		close(release)
		t.Fatal("overflow must be rejected before reading, credentials or forwarding")
	}
	close(release)
	for range maxConcurrentRequests {
		select {
		case status := <-finished:
			if status != http.StatusOK {
				t.Fatal("an admitted request failed after capacity was released")
			}
		case <-time.After(3 * time.Second):
			t.Fatal("an admitted request did not release its slot")
		}
	}
	writer = httptest.NewRecorder()
	proxy.ServeHTTP(writer, httptest.NewRequest(http.MethodGet, "/api/state", nil))
	if writer.Code != http.StatusOK || retrievals.Load() != maxConcurrentRequests+1 {
		t.Fatal("released concurrency slots were not reusable")
	}
}

// TestShutdownWaits allows active writes to finish and cancels remaining streams at the grace deadline.
func TestShutdownWaits(t *testing.T) {
	for _, force := range []bool{false, true} {
		t.Run(fmt.Sprintf("forced=%t", force), func(t *testing.T) {
			started := make(chan struct{})
			release := make(chan struct{})
			canceled := make(chan struct{})
			server := localServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				close(started)
				select {
				case <-release:
					_, _ = io.WriteString(writer, "finished")
				case <-request.Context().Done():
					close(canceled)
				}
			}))
			listener, err := net.Listen("tcp4", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()
			defer server.Close()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			grace := 2 * time.Second
			if force {
				grace = 100 * time.Millisecond
			}
			done := make(chan error, 1)
			go func() { done <- serveUntilCanceled(ctx, server, listener, grace) }()
			clientDone := make(chan struct{})
			go func() {
				defer close(clientDone)
				response, requestErr := (&http.Client{Timeout: 3 * time.Second}).Get("http://" + listener.Addr().String())
				if requestErr == nil {
					_, _ = io.Copy(io.Discard, response.Body)
					_ = response.Body.Close()
				}
			}()
			select {
			case <-started:
			case <-time.After(2 * time.Second):
				t.Fatal("shutdown fixture never received its active request")
			}
			cancel()
			select {
			case <-done:
				t.Fatal("serving returned before active requests drained or the grace deadline")
			case <-time.After(25 * time.Millisecond):
			}
			if !force {
				close(release)
			}
			select {
			case err := <-done:
				if err != nil {
					t.Fatal(err)
				}
			case <-time.After(3 * time.Second):
				t.Fatal("bounded shutdown did not complete")
			}
			if force {
				select {
				case <-canceled:
				case <-time.After(time.Second):
					t.Fatal("forced shutdown did not cancel the active request")
				}
			}
			<-clientDone
		})
	}
}

// TestCredentialRefresh signs subsequent requests with refreshed SDK-cached credentials rather than freezing startup keys.
func TestCredentialRefresh(t *testing.T) {
	var retrievals atomic.Int32
	cache := aws.NewCredentialsCache(aws.CredentialsProviderFunc(func(context.Context) (aws.Credentials, error) {
		return aws.Credentials{AccessKeyID: fmt.Sprintf("key-%d", retrievals.Add(1)), SecretAccessKey: "fixture-secret",
			CanExpire: true, Expires: time.Now().Add(time.Hour)}, nil
	}))
	var authorizations []string
	upstream := roundTripFunc(func(request *http.Request) (*http.Response, error) {
		authorizations = append(authorizations, request.Header.Get("Authorization"))
		return responseWith("ok"), nil
	})
	proxy := proxyHandler(testConfig(t), cache, upstream, upstream)
	proxy.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/api/state", nil))
	cache.Invalidate()
	proxy.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/api/state", nil))
	if retrievals.Load() != 2 || !strings.Contains(authorizations[0], "Credential=key-1/") || !strings.Contains(authorizations[1], "Credential=key-2/") {
		t.Fatal("requests did not use refreshed role credentials")
	}
}

// TestIMDSv2Only proves token usage, ignores static environment credentials and refuses IMDSv1 fallback.
func TestIMDSv2Only(t *testing.T) {
	t.Setenv("AWS_ACCESS_KEY_ID", "environment-key")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "environment-secret")
	t.Setenv("AWS_EC2_METADATA_SERVICE_ENDPOINT", "http://attacker.test")
	var requests atomic.Int32
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		requests.Add(1)
		if request.URL.Hostname() != "169.254.169.254" {
			t.Error("metadata endpoint was overridden")
		}
		if request.URL.Path == "/latest/api/token" {
			if request.Method != http.MethodPut {
				t.Error("IMDSv2 must request its token with PUT")
			}
			response := responseWith("fixture-imds-token")
			response.Header.Set("X-aws-ec2-metadata-token-ttl-seconds", "21600")
			return response, nil
		}
		if request.Header.Get("X-aws-ec2-metadata-token") != "fixture-imds-token" {
			t.Error("metadata request omitted its IMDSv2 token")
		}
		if strings.HasSuffix(strings.TrimRight(request.URL.Path, "/"), "/security-credentials") {
			return responseWith("fixture-role"), nil
		}
		body, _ := json.Marshal(map[string]string{"Code": "Success", "AccessKeyId": "instance-key", "SecretAccessKey": "instance-secret",
			"Token": "instance-token", "Expiration": time.Now().Add(time.Hour).UTC().Format(time.RFC3339)})
		return responseWith(string(body)), nil
	})}
	credentials, err := instanceCredentials(client).Retrieve(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if credentials.AccessKeyID != "instance-key" || requests.Load() != 3 {
		t.Fatal("the provider did not use only EC2 instance-role credentials")
	}
	requests.Store(0)
	denied := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		requests.Add(1)
		if request.URL.Path != "/latest/api/token" {
			t.Error("the provider fell back to an unauthenticated metadata request")
		}
		response := responseWith("denied")
		response.StatusCode = http.StatusForbidden
		return response, nil
	})}
	if _, err := instanceCredentials(denied).Retrieve(context.Background()); err == nil || requests.Load() != 1 {
		t.Fatal("failed IMDSv2 must not fall back to IMDSv1 or static credentials")
	}
}

// TestSSEStreamsAndCancels proves the first event arrives before completion and disconnect cancels its upstream.
func TestSSEStreamsAndCancels(t *testing.T) {
	canceled := make(chan struct{})
	release := make(chan struct{})
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(writer, "data: ready\n\n")
		writer.(http.Flusher).Flush()
		select {
		case <-request.Context().Done():
			close(canceled)
		case <-release:
		}
	}))
	defer upstream.Close()
	defer close(release)
	origin, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(proxyHandler(configuration{origin: origin, region: "us-west-2"}, testCredentials(),
		upstream.Client().Transport, upstream.Client().Transport))
	defer proxy.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	request, _ := http.NewRequestWithContext(ctx, http.MethodGet, proxy.URL+"/api/stream", nil)
	client := &http.Client{Timeout: 5 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	event := make(chan string, 1)
	go func() { line, _ := bufio.NewReader(response.Body).ReadString('\n'); event <- line }()
	select {
	case line := <-event:
		if line != "data: ready\n" {
			t.Fatal("the SSE event was changed")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the SSE event was buffered until response completion")
	}
	cancel()
	select {
	case <-canceled:
	case <-time.After(3 * time.Second):
		t.Fatal("client disconnect did not cancel the upstream SSE request")
	}
}
