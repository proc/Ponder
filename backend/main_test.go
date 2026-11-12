package main

import (
	"os"
	"path/filepath"
	"testing"

	"board/backend/pgn"
)

func TestAppendPGN(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sub", "db.pgn")
	game := "[Event \"A\"]\n[Result \"1-0\"]\n\n1. e4 e5 1-0\n"
	if err := appendPGN(path, game); err != nil {
		t.Fatal(err)
	}
	// A file not ending in a newline still gets a blank line between games.
	f, _ := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	f.WriteString("\n[Event \"B\"]\n[Result \"0-1\"]\n\n1. d4 0-1")
	f.Close()
	if err := appendPGN(path, game); err != nil {
		t.Fatal(err)
	}
	c, err := pgn.Open(path, nil)
	if err != nil || c.Len() != 3 {
		t.Fatalf("%v games, %v", c.Len(), err)
	}
	for i := 0; i < 3; i++ {
		if _, err := c.Read(i); err != nil {
			t.Fatalf("game %d: %v", i, err)
		}
	}
}
