package main

import (
	"errors"
	"reflect"
	"slices"
	"strings"
	"testing"
)

func files(m map[string]string) func(string) ([]byte, error) {
	return func(path string) ([]byte, error) {
		v, ok := m[path]
		if !ok {
			return nil, errors.New("no such file")
		}
		return []byte(v), nil
	}
}

func TestReadsNameFileIntoName(t *testing.T) {
	got, err := resolve(
		[]string{"DSN_FILE=/run/secrets/dsn", "SECRETS_COOKIE_FILE=/s/c", "SERVE_PUBLIC_BASE_URL=https://auth.example", "EMPTY_FILE="},
		files(map[string]string{"/run/secrets/dsn": "postgres://k@db/kratos\n", "/s/c": "cookie-secret\r\n"}),
	)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"DSN=postgres://k@db/kratos", "EMPTY_FILE=", "SECRETS_COOKIE=cookie-secret", "SERVE_PUBLIC_BASE_URL=https://auth.example"}
	slices.Sort(got)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestLeavesOtherFileVariablesAlone(t *testing.T) {
	// The distroless base image sets SSL_CERT_FILE; reading it in would pass the whole CA bundle on as SSL_CERT.
	env := []string{"SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt", "LOG_FILE=/tmp/x"}
	got, err := resolve(env, files(nil))
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, env) {
		t.Fatalf("got %v", got)
	}
}

func TestRefusesBoth(t *testing.T) {
	_, err := resolve([]string{"DSN=postgres://x", "DSN_FILE=/s/dsn"}, files(map[string]string{"/s/dsn": "y"}))
	if err == nil || !strings.Contains(err.Error(), "set DSN or DSN_FILE, not both") {
		t.Fatalf("got %v", err)
	}
}

func TestEmptyMeansNotSet(t *testing.T) {
	got, err := resolve([]string{"DSN=", "DSN_FILE=/s/dsn"}, files(map[string]string{"/s/dsn": "y"}))
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, []string{"DSN=y"}) {
		t.Fatalf("got %v", got)
	}
}

func TestNamesAnUnreadableFile(t *testing.T) {
	_, err := resolve([]string{"SECRETS_CIPHER_FILE=/s/missing"}, files(nil))
	if err == nil || !strings.Contains(err.Error(), "SECRETS_CIPHER_FILE: can't read /s/missing") {
		t.Fatalf("got %v", err)
	}
}
