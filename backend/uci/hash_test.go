package uci

import (
	"strings"
	"testing"
)

func TestParseHashfull(t *testing.T) {
	in, ok := parseInfo(strings.Fields("info depth 12 score cp 5 nodes 100 hashfull 374 pv e2e4"))
	if !ok || !in.HasHashfull || in.Hashfull != 374 {
		t.Fatalf("hashfull: %+v", in)
	}
	in, _ = parseInfo(strings.Fields("info depth 12 score cp 5 pv e2e4"))
	if in.HasHashfull {
		t.Fatal("hashfull without one sent")
	}
}

func TestHashMB(t *testing.T) {
	e := &Engine{Options: []Option{{Name: "Threads", Type: "spin", Default: "1"}, {Name: "Hash", Type: "spin", Default: "16"}}}
	e.noteHash(nil)
	if e.HashMB() != 16 {
		t.Fatalf("default: %d", e.HashMB())
	}
	e.OptionChanges(map[string]string{"hash": "256"})
	if e.HashMB() != 256 {
		t.Fatalf("set: %d", e.HashMB())
	}
	e.OptionChanges(map[string]string{})
	if e.HashMB() != 16 {
		t.Fatalf("back to default: %d", e.HashMB())
	}
}
