package lichess

import (
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"board/backend/chess"
	"board/backend/game"
	"board/backend/uci"
)

// ponderGame plays a game with the scripted ponder engine as White, the
// opponent answering as reply says, until the engine was sent a line that
// starts with every prefix of want, in that order. It returns what the
// engine was sent from its first position on.
func ponderGame(t *testing.T, ponder bool, reply func(sorted []string, ply int) string, want ...string) []string {
	t.Helper()
	dir := t.TempDir()
	engine := filepath.Join(dir, "ponderengine")
	if out, err := exec.Command("go", "build", "-o", engine, "./testdata/ponderengine").CombinedOutput(); err != nil {
		t.Fatal(string(out))
	}
	log := filepath.Join(dir, "engine.log")
	t.Setenv("PONDER_LOG", log)

	h := newHarness(t, Policy{Casual: true, Humans: true, MaxGames: 1})
	h.cfg.Engine = EngineConfig{Name: "Ponder Tester", Path: engine}
	h.cfg.Ponder = ponder
	h.fake.Delay = 150 * time.Millisecond
	h.fake.Reply = func(pos chess.Position, ply int) string {
		var moves []string
		for _, m := range pos.LegalMoves() {
			moves = append(moves, m.UCI())
		}
		sort.Strings(moves)
		return reply(moves, ply)
	}
	h.connect()
	if err := h.bot.SetAutoAccept(true); err != nil {
		t.Fatal(err)
	}
	h.waitListening()
	id := h.fake.Challenge("Alice", false, false, 120, 1, "black", "standard")
	h.waitFor("game start", func(s Status) bool { return len(s.Games) == 1 })

	sent := func() []string {
		data, _ := os.ReadFile(log)
		lines := strings.Split(strings.TrimSpace(string(data)), "\n")
		for i, l := range lines {
			if strings.HasPrefix(l, "position") {
				return lines[i:]
			}
		}
		return nil
	}
	// follows reports whether lines has the prefixes of want in order.
	follows := func(lines []string) bool {
		i := 0
		for _, l := range lines {
			if i < len(want) && strings.HasPrefix(l, want[i]) {
				i++
			}
		}
		return i == len(want)
	}
	deadline := time.Now().Add(15 * time.Second)
	for !follows(sent()) {
		if time.Now().After(deadline) {
			t.Fatalf("the engine was never sent %q in order; it was sent:\n%s", want, strings.Join(sent(), "\n"))
		}
		time.Sleep(20 * time.Millisecond)
	}
	lines := sent()
	h.bot.Resign(id)
	h.waitFor("the end", func(s Status) bool { _, ok := finishedGame(s); return ok })
	data, _ := os.ReadFile(log)
	if on := strings.Contains(string(data), "setoption name Ponder value true"); on != ponder {
		t.Errorf("Ponder option set: %v, want %v", on, ponder)
	}
	return lines
}

const startPos = "position fen " + chess.StartFEN

func TestPonderHitAndMiss(t *testing.T) {
	// The engine plays a2a3 expecting a7a5. The opponent plays it (a hit),
	// then answers the engine's second move with something else (a miss).
	reply := func(sorted []string, ply int) string {
		if ply == 1 {
			return sorted[0]
		}
		return sorted[len(sorted)-1]
	}
	lines := ponderGame(t, true, reply,
		startPos, "go wtime",
		startPos+" moves a2a3 a7a5", "go ponder wtime",
		"ponderhit",
		startPos+" moves a2a3 a7a5 ", "go ponder wtime",
		"stop",
		startPos+" moves a2a3 a7a5 ", "go wtime",
	)
	text := strings.Join(lines, "\n")
	t.Log("\n" + text)

	// Exactly as UCI has it: the first lines, one by one.
	head := []string{startPos, "go wtime", startPos + " moves a2a3 a7a5", "go ponder wtime", "ponderhit"}
	for i, want := range head {
		if i >= len(lines) || !strings.HasPrefix(lines[i], want) {
			t.Fatalf("line %d sent to the engine is %q, want %q…", i+1, lines[i], want)
		}
	}
	// The ponder position is the game's moves and the expected reply; a
	// search is never stopped before the opponent has moved.
	if lines[2] != startPos+" moves a2a3 a7a5" {
		t.Errorf("ponder position %q", lines[2])
	}
	for i, l := range lines {
		switch {
		case l == "ponderhit" || l == "stop":
			if i == 0 || !strings.HasPrefix(lines[i-1], "go ponder") {
				t.Errorf("%q follows %q, not a ponder search", l, lines[i-1])
			}
		case strings.HasPrefix(l, "go ponder"):
			if i+1 < len(lines) && lines[i+1] != "ponderhit" && lines[i+1] != "stop" && lines[i+1] != "quit" {
				t.Errorf("a ponder search was followed by %q", lines[i+1])
			}
		case strings.HasPrefix(l, "go "):
			for _, part := range []string{"wtime ", "btime ", "winc ", "binc "} {
				if !strings.Contains(l, part) {
					t.Errorf("%q has no %s", l, part)
				}
			}
		}
	}
	// After the hit, no new position or go: the search carries on.
	if strings.HasPrefix(lines[5], "position") && !strings.Contains(lines[6], "ponder") {
		t.Errorf("after ponderhit the engine was sent %q, %q", lines[5], lines[6])
	}
	// After the miss the search is for the position that came about: the
	// opponent's actual move, not the expected one.
	stop := -1
	for i, l := range lines {
		if l == "stop" {
			stop = i
			break
		}
	}
	if stop < 2 || stop+2 >= len(lines) {
		t.Fatalf("no search after the miss:\n%s", text)
	}
	pondered, played := strings.Fields(lines[stop-2]), strings.Fields(lines[stop+1])
	if len(pondered) != len(played) || pondered[len(pondered)-1] == played[len(played)-1] ||
		strings.Join(pondered[:len(pondered)-1], " ") != strings.Join(played[:len(played)-1], " ") {
		t.Errorf("after the miss: pondered %q, then searched %q", lines[stop-2], lines[stop+1])
	}
	if !strings.HasPrefix(lines[stop+2], "go wtime") {
		t.Errorf("after the miss the engine was sent %q", lines[stop+2])
	}
}

func TestNoPonderWhenOff(t *testing.T) {
	lines := ponderGame(t, false, func(sorted []string, ply int) string { return sorted[0] },
		startPos, "go wtime", startPos+" moves a2a3 a7a5 ", "go wtime")
	for _, l := range lines {
		if strings.Contains(l, "ponder") || l == "stop" {
			t.Fatalf("the engine was sent %q with pondering off:\n%s", l, strings.Join(lines, "\n"))
		}
	}
}

// The search reaches the UI as it goes: lines, the depth between them, and
// the search on the opponent's time, marked as pondering.
func TestSearchInfoInRealTime(t *testing.T) {
	var events []game.EngineInfo
	b := NewBot(Hooks{Emit: func(ev string, data any) {
		if in, ok := data.(game.EngineInfo); ok && ev == "engineInfo" {
			events = append(events, in)
		}
	}})
	r := newRunner(b, "g1", &GameInfo{Color: "white"})
	b.games["g1"], b.watching = r, "g1"
	take := func() []game.EngineInfo { out := events; events = nil; return out }

	// Its own move: a line, then the depth climbing without one.
	r.thinking = 0
	r.onInfo(uci.Info{Depth: 5, HasScore: true, ScoreCP: 20, Nodes: 1000, NPS: 50000, PV: []string{"e2e4", "e7e5"}})
	r.onInfo(uci.Info{Depth: 6, HasScore: true, ScoreCP: 25, PV: []string{"e2e4", "e7e5"}}) // too soon after the first
	if got := take(); len(got) != 1 || got[0].Depth != 5 || got[0].Stats || got[0].Pondering || got[0].Best != "e2e4" || got[0].Ponder != "e7e5" {
		t.Fatalf("lines: %+v", got)
	}
	time.Sleep(infoEvery + 10*time.Millisecond)
	r.onInfo(uci.Info{Depth: 7}) // "info depth 7 currmove …"
	r.onInfo(uci.Info{Depth: 8})
	if got := take(); len(got) != 1 || !got[0].Stats || got[0].Depth != 7 || got[0].Ply != 0 || len(got[0].PV) != 0 {
		t.Fatalf("depth alone: %+v", got)
	}
	// Nothing to tell: not sent.
	time.Sleep(infoEvery + 10*time.Millisecond)
	r.onInfo(uci.Info{})
	if got := take(); len(got) != 0 {
		t.Fatalf("an empty line was sent: %+v", got)
	}

	// 1. e4 is played; it ponders on 1… e5.
	m, _ := r.pos.ParseUCIMove("e2e4")
	r.pos, r.moves = r.pos.Make(m), []string{"e2e4"}
	r.pondering, r.ponderBase = "e7e5", 1
	time.Sleep(infoEvery + 10*time.Millisecond)
	r.onInfo(uci.Info{Depth: 9, HasScore: true, ScoreCP: 30, PV: []string{"g1f3", "b8c6"}})
	got := take()
	if len(got) != 1 || !got[0].Pondering || got[0].Stats || got[0].Ply != 1 || got[0].Depth != 9 ||
		strings.Join(got[0].PV, " ") != "e5 Nf3 Nc6" || got[0].Ponder != "e7e5" || got[0].Best != "" || got[0].CP != 30 {
		t.Fatalf("pondering: %+v", got)
	}
	time.Sleep(infoEvery + 10*time.Millisecond)
	r.onInfo(uci.Info{Depth: 10})
	if got := take(); len(got) != 1 || !got[0].Stats || !got[0].Pondering || got[0].Depth != 10 {
		t.Fatalf("depth while pondering: %+v", got)
	}

	// The reply comes: what it found while pondering is its line now.
	m, _ = r.pos.ParseUCIMove("e7e5")
	r.pos, r.moves = r.pos.Make(m), []string{"e2e4", "e7e5"}
	r.canPonder = true
	if cmds := r.engineCommandsLocked(GameState{}); len(cmds) != 1 || cmds[0] != "ponderhit" {
		t.Fatalf("commands %q", cmds)
	}
	out, ok := r.chosenLocked("g1f3")
	if !ok || out.Depth != 9 || strings.Join(out.PV, " ") != "Nf3 Nc6" || out.Ponder != "b8c6" || !out.HasEval {
		t.Fatalf("chosen after a hit: %+v", out)
	}
	// The move is marked as a ponder hit, in its lines and once chosen.
	time.Sleep(infoEvery + 10*time.Millisecond)
	r.onInfo(uci.Info{Depth: 12, PV: []string{"g1f3"}})
	if got := take(); !out.PonderHit || len(got) != 1 || !got[0].PonderHit || got[0].Pondering {
		t.Fatalf("hit not marked: chosen %+v, line %+v", out, got)
	}

	// A miss is not: the opponent plays something else next time.
	for _, mv := range []string{"g1f3", "b8c6"} {
		m, _ = r.pos.ParseUCIMove(mv)
		r.pos, r.moves = r.pos.Make(m), append(r.moves, mv)
	}
	r.pondering, r.ponderBase = "g8f6", 3 // it expected 2… Nf6 after 2. Nf3
	if cmds := r.engineCommandsLocked(GameState{}); len(cmds) != 3 || cmds[0] != "stop" {
		t.Fatalf("commands after a miss %q", cmds)
	}
	time.Sleep(infoEvery + 10*time.Millisecond)
	r.onInfo(uci.Info{Depth: 3, PV: []string{"f1b5"}})
	if got := take(); len(got) != 1 || got[0].PonderHit || got[0].Ply != 4 {
		t.Fatalf("a miss marked as a hit: %+v", got)
	}

	// A game that is not on the board sends nothing.
	b.watching = ""
	time.Sleep(infoEvery + 10*time.Millisecond)
	r.onInfo(uci.Info{Depth: 11, PV: []string{"g1f3"}})
	if got := take(); len(got) != 0 {
		t.Fatalf("sent for a game not shown: %+v", got)
	}
}
