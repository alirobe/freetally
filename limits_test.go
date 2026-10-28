package main

import (
	"net/http/httptest"
	"testing"
	"time"
)

func TestBuckets(t *testing.T) {
	b := newBuckets(1, 3)
	for i := range 3 {
		if !b.Take("a") {
			t.Fatalf("take %d refused within the burst", i+1)
		}
	}
	if b.Take("a") {
		t.Fatal("take allowed past the burst")
	}
	if !b.Take("b") {
		t.Fatal("one key's limit held up another")
	}

	b.m["a"].at = b.m["a"].at.Add(-2 * time.Second)
	if !b.Take("a") || !b.Take("a") || b.Take("a") {
		t.Fatal("two seconds at 1 a second should refill exactly two tokens")
	}

	b.m["b"].at = time.Now().Add(-6 * time.Minute)
	b.Sweep()
	if _, ok := b.m["b"]; ok {
		t.Fatal("sweep kept an idle key")
	}
	if _, ok := b.m["a"]; !ok {
		t.Fatal("sweep dropped an active key")
	}
}

func TestClientAddr(t *testing.T) {
	for _, c := range []struct {
		name, ipHeader, remote, header, value, want string
	}{
		{"connection address", "", "1.2.3.4:5678", "", "", "1.2.3.4"},
		{"headers ignored without a named proxy", "", "1.2.3.4:5678", "X-Forwarded-For", "9.9.9.9", "1.2.3.4"},
		{"last X-Forwarded-For entry", "X-Forwarded-For", "10.0.0.1:80", "X-Forwarded-For", "9.9.9.9, 5.6.7.8", "5.6.7.8"},
		{"named header", "Fly-Client-IP", "10.0.0.1:80", "Fly-Client-IP", "5.6.7.8", "5.6.7.8"},
		{"missing header falls back", "Fly-Client-IP", "1.2.3.4:5678", "", "", "1.2.3.4"},
		{"IPv6 cut to /64", "Fly-Client-IP", "10.0.0.1:80", "Fly-Client-IP", "2001:db8:1:2:3:4:5:6", "2001:db8:1:2::/64"},
		{"IPv6 connection cut to /64", "", "[2001:db8::1]:443", "", "", "2001:db8::/64"},
		{"IPv4-mapped kept whole", "Fly-Client-IP", "10.0.0.1:80", "Fly-Client-IP", "::ffff:1.2.3.4", "::ffff:1.2.3.4"},
	} {
		t.Run(c.name, func(t *testing.T) {
			r := httptest.NewRequest("GET", "/", nil)
			r.RemoteAddr = c.remote
			if c.header != "" {
				r.Header.Set(c.header, c.value)
			}
			a := &App{ipHeader: c.ipHeader}
			if got := a.clientAddr(r); got != c.want {
				t.Errorf("clientAddr = %q, want %q", got, c.want)
			}
		})
	}
}
