package main

import "testing"

func TestCSVCell(t *testing.T) {
	for _, c := range []struct {
		in   any
		want string
	}{
		{"plain", "plain"},
		{"", ""},
		{nil, ""},
		{int64(-5), "-5"},
		{"=SUM(A1)", "'=SUM(A1)"},
		{"-5", "'-5"},
		{"@cmd", "'@cmd"},
		{"a,b", `"a,b"`},
		{`say "hi"`, `"say ""hi"""`},
		{"+1\n", "\"'+1\n\""},
	} {
		if got := csvCell(c.in); got != c.want {
			t.Errorf("csvCell(%#v) = %q, want %q", c.in, got, c.want)
		}
	}
}
