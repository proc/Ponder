package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
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

// The comments on a game watched or played here are written into its entry
// in the game database, whether another file is open in the Games tab or
// none: the entry keeps its tags, and the other file is left as it was.
func TestAnnotateInDatabase(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "Games.pgn")
	entry := "[Event \"Rated blitz game\"]\n[Site \"https://lichess.org/abcd1234\"]\n[White \"Anna\"]\n[Black \"Bot\"]\n[Result \"0-1\"]\n[WhiteElo \"1500\"]\n\n1. f3 e5 2. g4 Qh4# 0-1\n"
	if err := os.WriteFile(dbPath, []byte("[Event \"Older\"]\n[White \"X\"]\n[Black \"Y\"]\n[Result \"1-0\"]\n\n1. e4 1-0\n\n"+entry), 0o644); err != nil {
		t.Fatal(err)
	}
	otherPath := filepath.Join(dir, "Other.pgn")
	other := "[Event \"Else\"]\n[White \"P\"]\n[Black \"Q\"]\n[Result \"*\"]\n\n1. d4 *\n"
	if err := os.WriteFile(otherPath, []byte(other), 0o644); err != nil {
		t.Fatal(err)
	}
	saved := database.path
	savedC, savedName, savedPath := collection.c, collection.name, collection.path
	t.Cleanup(func() {
		database.path = saved
		collection.c, collection.name, collection.path = savedC, savedName, savedPath
	})
	database.path = dbPath

	mgr := game.NewManager(func(string, any) {})
	defer mgr.Shutdown()
	if err := mgr.ShowExternal(game.ExternalView{
		ID: "abcd1234", Kind: "spectate", Label: "Rated blitz game",
		White: game.PlayerConfig{Name: "Anna"}, Black: game.PlayerConfig{Name: "Bot"},
		StartFEN: chess.StartFEN, Moves: []string{"f2f3", "e7e5", "g2g4", "d8h4"},
		Finished: true, Result: "0-1", Reason: "Checkmate",
	}); err != nil {
		t.Fatal(err)
	}
	annotate := func(comment string) {
		t.Helper()
		args, _ := json.Marshal(map[string]any{"annotations": map[string]any{"comments": map[string]string{"2": "[%ai] " + comment}}})
		if _, err := handle(mgr, request{Cmd: "pgnAnnotate", Args: args}); err != nil {
			t.Fatal(err)
		}
		raw, _ := os.ReadFile(dbPath)
		c, err := pgn.Open(dbPath, nil)
		if err != nil || c.Len() != 2 {
			t.Fatalf("%d games, %v", c.Len(), err)
		}
		got, _ := c.Raw(1)
		if !strings.Contains(got, "{ [%ai] "+comment+" }") || !strings.Contains(got, "[WhiteElo \"1500\"]") || !strings.Contains(got, "lichess.org/abcd1234") {
			t.Errorf("the entry is now:\n%s", raw)
		}
	}

	// Another file is open: it is not the game's, and is not changed.
	c, err := pgn.Open(otherPath, nil)
	if err != nil {
		t.Fatal(err)
	}
	setCollection(c, "Other.pgn", otherPath)
	annotate("A bold reply.")
	if b, _ := os.ReadFile(otherPath); string(b) != other {
		t.Errorf("the other file was changed:\n%s", b)
	}
	// No file open at all.
	collection.c, collection.name, collection.path = nil, "", ""
	annotate("Black is better already.")
	// A game that is in neither file has nowhere to go.
	database.path = filepath.Join(dir, "missing.pgn")
	args, _ := json.Marshal(map[string]any{"annotations": map[string]any{}})
	if _, err := handle(mgr, request{Cmd: "pgnAnnotate", Args: args}); !errors.Is(err, errNotInFile) {
		t.Errorf("with no database file: %v, want errNotInFile", err)
	}
}
