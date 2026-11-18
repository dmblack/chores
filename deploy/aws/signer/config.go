package main

import (
	"errors"
	"net/url"
	"regexp"
	"strings"
)

// listenAddress is deliberately fixed: this credential-bearing proxy is never a public listener.
const listenAddress = "127.0.0.1:8787"

// configuration contains only a validated, fixed AWS destination and its signing region.
type configuration struct {
	origin *url.URL
	region string
}

// configFromEnv accepts one regional HTTPS Web Function origin, without URL credentials or paths.
func configFromEnv(getenv func(string) string) (configuration, error) {
	region := getenv("AWS_REGION")
	if !regexp.MustCompile(`^[a-z]{2}(?:-[a-z]+)+-\d+$`).MatchString(region) {
		return configuration{}, errors.New("AWS_REGION must identify the Web Function's region")
	}
	origin, err := url.Parse(getenv("AWS_WEB_FUNCTION_URL"))
	hostPattern := `^[a-z0-9-]+\.[a-z0-9-]+\.lambda-web\.` + regexp.QuoteMeta(region) + `\.on\.aws$`
	if err != nil || origin == nil || origin.Scheme != "https" || origin.User != nil ||
		origin.Opaque != "" || origin.Host != origin.Hostname() || !regexp.MustCompile(hostPattern).MatchString(origin.Host) ||
		(origin.Path != "" && origin.Path != "/") || origin.RawPath != "" || origin.RawQuery != "" ||
		origin.ForceQuery || origin.Fragment != "" || origin.RawFragment != "" {
		return configuration{}, errors.New("AWS_WEB_FUNCTION_URL must be the HTTPS origin of a regional Lambda Web Function in AWS_REGION")
	}
	origin.Path = ""
	return configuration{origin: origin, region: region}, nil
}

// isSigningHeader identifies caller-supplied credentials and AWS signature context to discard.
func isSigningHeader(name string) bool {
	lower := strings.ToLower(name)
	return lower == "authorization" || strings.HasPrefix(lower, "x-amz-") || strings.HasPrefix(lower, "x-amzn-")
}
