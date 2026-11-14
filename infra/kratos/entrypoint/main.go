// Command montra-kratos starts Kratos with its secrets read from files (ADR-0050 §2).
//
// NAME_FILE in the environment, a path to a file, becomes NAME with the file's contents, the way Docker and
// Kubernetes secrets arrive. Setting both NAME and NAME_FILE is an error. Then it runs /usr/bin/kratos with the same
// arguments, in its place. The image is distroless, with no shell, which is why this is a program and not a script.
//
// Only Kratos settings that can hold a secret are read this way (see secretSetting). Other variables that end in
// _FILE, such as SSL_CERT_FILE in the base image, are paths meant for other programs and are passed on unchanged.
package main

import (
	"fmt"
	"os"
	"strings"
	"syscall"
)

const kratos = "/usr/bin/kratos"

// The Kratos settings whose environment names can be given as NAME_FILE: the database, its secrets, the courier's
// SMTP or SMS credentials, the hook and OIDC secrets under selfservice, and the OAuth2 provider's.
var secretPrefixes = []string{"SECRETS_", "COURIER_", "SELFSERVICE_", "OAUTH2_PROVIDER_"}

func secretSetting(name string) bool {
	if name == "DSN" {
		return true
	}
	for _, p := range secretPrefixes {
		if strings.HasPrefix(name, p) {
			return true
		}
	}
	return false
}

// resolve returns environ with each NAME_FILE replaced by NAME and the file's contents. Empty values count as not
// set, as ECS fills every secret it's given.
func resolve(environ []string, read func(string) ([]byte, error)) ([]string, error) {
	values := map[string]string{}
	var order []string
	for _, kv := range environ {
		name, value, _ := strings.Cut(kv, "=")
		if _, seen := values[name]; !seen {
			order = append(order, name)
		}
		values[name] = value
	}
	for _, name := range order {
		path := values[name]
		target, isFile := strings.CutSuffix(name, "_FILE")
		if !isFile || !secretSetting(target) || path == "" {
			continue
		}
		if values[target] != "" {
			return nil, fmt.Errorf("set %s or %s, not both", target, name)
		}
		b, err := read(path)
		if err != nil {
			return nil, fmt.Errorf("%s: can't read %s: %w", name, path, err)
		}
		// One trailing line break is dropped, since editors and echo add one.
		value := strings.TrimSuffix(strings.TrimSuffix(string(b), "\n"), "\r")
		if _, seen := values[target]; !seen {
			order = append(order, target)
		}
		values[target] = value
		delete(values, name)
	}
	out := make([]string, 0, len(values))
	for _, name := range order {
		if value, ok := values[name]; ok {
			out = append(out, name+"="+value)
		}
	}
	return out, nil
}

func main() {
	env, err := resolve(os.Environ(), os.ReadFile)
	if err != nil {
		fmt.Fprintln(os.Stderr, "montra-kratos:", err)
		os.Exit(1)
	}
	args := append([]string{kratos}, os.Args[1:]...)
	if err := syscall.Exec(kratos, args, env); err != nil {
		fmt.Fprintln(os.Stderr, "montra-kratos: can't start kratos:", err)
		os.Exit(1)
	}
}
