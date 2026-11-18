# Chores signing helper

This small Go reverse proxy lets the existing HAProxy host authenticate to one Lambda Web Function using its EC2 instance role. It uses the AWS SDK for Go v2 credential cache and SigV4 signer; it does not implement cryptography or load a general AWS credential chain.

- The listener is fixed at `127.0.0.1:8787`.
- `AWS_WEB_FUNCTION_URL` must be a regional HTTPS Lambda Web Function origin in `AWS_REGION`. Paths, credentials, ports and arbitrary hosts are rejected.
- Credentials come exclusively from IMDSv2 at the fixed EC2 metadata address. Static environment keys, AWS profiles, alternate metadata endpoints and IMDSv1 fallback are unavailable.
- Viewer AWS signature headers and parameters are removed. The SDK signs the fixed destination with the required `X-Amz-Content-SHA256: UNSIGNED-PAYLOAD` header over verified TLS.
- Request bodies are limited to 1 MiB and preserved byte for byte. Responses stream immediately; disconnecting an SSE client cancels its upstream request.
- At most 32 requests, including open SSE streams, are active together. Overflow receives an uncached 503 before its body is read or credentials are fetched.
- Non-streaming requests have a one-minute limit. The SSE endpoint has no overall proxy timeout. Header, body-read, connection and TLS-handshake waits are bounded separately.
- Shutdown allows active requests five seconds to finish, then closes remaining connections and cancels their upstream requests before the process exits.
- Write connections are not reused, preventing automatic transport retries. The application retains responsibility for its durable action IDs.
- Logs contain startup status only. Request headers, cookies, bodies, credentials and upstream error details are not logged.

From the repository root:

```sh
# Run local-only tests, including the race detector, then build both static Linux architectures.
npm run build:signer

# Verify the two release binaries against their deterministic checksum manifest.
cd .deploy/signer
sha256sum -c SHA256SUMS
```

The build uses a pinned official Go Docker image, checked-in dependency checksums and `CGO_ENABLED=0`. It does not require Go on the host. Build/module caches stay outside the release directory. Tests use local fixtures and never contact an AWS endpoint or the real instance metadata service.

Installation, the instance IAM policy and HAProxy configuration are covered by the parent [deployment instructions](../README.md). See [AWS Web Function IAM authentication](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-endpoint-access-control.html) and the [SDK EC2 role provider](https://pkg.go.dev/github.com/aws/aws-sdk-go-v2/credentials/ec2rolecreds).
