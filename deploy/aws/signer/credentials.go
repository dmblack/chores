package main

import (
	"net"
	"net/http"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/aws/retry"
	"github.com/aws/aws-sdk-go-v2/credentials/ec2rolecreds"
	"github.com/aws/aws-sdk-go-v2/feature/ec2/imds"
)

// metadataEndpoint cannot be overridden by environment variables or incoming requests.
const metadataEndpoint = "http://169.254.169.254"

// instanceCredentials builds an IMDSv2-only cache; it never reads static keys, profiles or STS roles.
func instanceCredentials(client *http.Client) *aws.CredentialsCache {
	metadata := imds.New(imds.Options{
		Endpoint:          metadataEndpoint,
		HTTPClient:        client,
		ClientEnableState: imds.ClientEnabled,
		EnableFallback:    aws.FalseTernary,
		Retryer:           retry.NewStandard(func(options *retry.StandardOptions) { options.MaxAttempts = 1 }),
	})
	provider := ec2rolecreds.New(func(options *ec2rolecreds.Options) { options.Client = metadata })
	return aws.NewCredentialsCache(provider, func(options *aws.CredentialsCacheOptions) {
		options.ExpiryWindow = 5 * time.Minute
		options.ExpiryWindowJitterFrac = 0.2
	})
}

// metadataHTTPClient avoids environment proxies, bounds IMDS requests and rejects redirects.
func metadataHTTPClient() *http.Client {
	return &http.Client{
		Timeout: 2 * time.Second,
		Transport: &http.Transport{
			Proxy:                 nil,
			DialContext:           (&net.Dialer{Timeout: time.Second, KeepAlive: 30 * time.Second}).DialContext,
			ResponseHeaderTimeout: time.Second,
			MaxIdleConns:          1,
			MaxIdleConnsPerHost:   1,
			IdleConnTimeout:       time.Minute,
		},
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse },
	}
}
