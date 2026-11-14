package main

import (
	"os"
	"path/filepath"
	"testing"

	"board/backend/chess"
	"board/backend/game"
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

// A game played here is found again in the file it was added to, and is
// written back with the file's own tags.
func TestFindGameAndKeepItsTags(t *testing.T) {
	path := filepath.Join(t.TempDir(), "Games.pgn")
	text := "[Event \"One\"]\n[White \"Anna\"]\n[Black \"Bot\"]\n[Result \"1-0\"]\n\n1. e4 e5 2. Qh5 Nc6 1-0\n\n" +
		"[Event \"Two\"]\n[Site \"Ponder\"]\n[White \"Anna\"]\n[Black \"Bot\"]\n[Result \"0-1\"]\n[WhiteElo \"1500\"]\n\n1. f3 e5 2. g4 Qh4# 0-1\n\n" +
		"[Event \"Three\"]\n[White \"Other\"]\n[Black \"Bot\"]\n[Result \"0-1\"]\n\n1. f3 e5 2. g4 Qh4# 0-1\n"
	if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
	c, err := pgn.Open(path, nil)
	if err != nil {
		t.Fatal(err)
	}
	st := game.State{
		StartFEN: chess.StartFEN,
		Players:  map[string]game.PlayerConfig{"white": {Name: "Anna"}, "black": {Name: "Bot"}},
		Moves:    []game.MoveRecord{{SAN: "f3"}, {SAN: "e5"}, {SAN: "g4"}, {SAN: "Qh4#"}},
	}
	if i := findGame(c, st); i != 1 {
		t.Fatalf("found entry %d, want 1 (the same moves by other players are not it)", i)
	}
	st.Moves = st.Moves[:3]
	if i := findGame(c, st); i != -1 {
		t.Errorf("a game with other moves was found at %d", i)
	}
	raw, _ := c.Raw(1)
	got := withTagsOf(raw, "[Event \"Casual game\"]\n[White \"Anna\"]\n\n1. f3 e5 { weak } 2. g4 $4 Qh4# 0-1\n")
	want := "[Event \"Two\"]\n[Site \"Ponder\"]\n[White \"Anna\"]\n[Black \"Bot\"]\n[Result \"0-1\"]\n[WhiteElo \"1500\"]\n\n1. f3 e5 { weak } 2. g4 $4 Qh4# 0-1\n"
	if got != want {
		t.Errorf("got:\n%s\nwant:\n%s", got, want)
	}
}
