package lichess

import (
	"context"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"board/backend/chess"
	"board/backend/uci"
)

func drawRunner(t *testing.T, d DrawOffer, fen string) *runner {
	t.Helper()
	b := NewBot(Hooks{})
	b.cfg.Draw = d
	r := newRunner(b, "g", &GameInfo{Color: "white"})
	pos, err := chess.ParseFEN(fen)
	if err != nil {
		t.Fatal(err)
	}
	r.pos, r.play = pos, true
	return r
}

// choose is the engine choosing a move with this score.
func choose(r *runner, cp int) bool {
	r.lastLine, r.lastLinePly = uci.Info{HasScore: true, ScoreCP: cp, PV: []string{"e2e4"}}, len(r.moves)
	return r.offerDrawLocked()
}

func TestDrawOfferRules(t *testing.T) {
	const rookEnding = "8/5k2/8/8/8/8/4RK2/3r4 w - - 0 1" // 4 pieces
	// Three moves in a row within 10 centipawns.
	r := drawRunner(t, DrawOffer{Enabled: true, Score: 10, Moves: 3, Pieces: 10}, rookEnding)
	for i, tc := range []struct {
		cp   int
		want bool
	}{{0, false}, {-10, false}, {10, true}, {11, false}, {0, false}, {5, false}, {-5, true}} {
		if got := choose(r, tc.cp); got != tc.want {
			t.Errorf("move %d (score %d): offer %v, want %v", i+1, tc.cp, got, tc.want)
		}
	}
	// A mate is no draw, whatever the limit.
	r.lastLine, r.lastLinePly = uci.Info{HasScore: true, IsMate: true, Mate: 3}, 0
	if r.offerDrawLocked() {
		t.Error("offered a draw with a mate in sight")
	}

	// Too many pieces on the board.
	r = drawRunner(t, DrawOffer{Enabled: true, Score: 0, Moves: 1, Pieces: 10}, chess.StartFEN)
	if choose(r, 0) {
		t.Error("offered a draw with 32 pieces on the board")
	}
	// Turned off.
	r = drawRunner(t, DrawOffer{Score: 0, Moves: 1, Pieces: 32, EGTBZero: true}, rookEnding)
	r.tbDraw = map[int]bool{0: true}
	if choose(r, 0) {
		t.Error("offered a draw though draw offers are off")
	}
	// A move without a score does not count as a drawn one.
	r = drawRunner(t, DrawOffer{Enabled: true, Score: 0, Moves: 1, Pieces: 32}, rookEnding)
	if r.offerDrawLocked() {
		t.Error("offered a draw without a score")
	}
}

func TestDrawOfferForTablebaseDraw(t *testing.T) {
	h := newHarness(t, Policy{})
	const rookEnding = "8/5k2/8/8/8/8/4RK2/3r4 w - - 0 1"
	base := h.srv.URL + "/tablebase"
	h.fake.Tablebase = "draw"
	if draw, err := TablebaseDraw(context.Background(), base, rookEnding); err != nil || !draw {
		t.Fatalf("TablebaseDraw = %v, %v", draw, err)
	}

	asked := func(d DrawOffer, fen, category string) (*runner, int) {
		h.fake.Tablebase = category
		_, before := h.fake.Draws()
		r := drawRunner(t, d, fen)
		r.b.cfg.TablebaseURL = base
		r.b.mu.Lock()
		r.lookupTablebaseLocked()
		r.lookupTablebaseLocked() // once for a position
		r.b.mu.Unlock()
		time.Sleep(150 * time.Millisecond)
		_, after := h.fake.Draws()
		r.b.mu.Lock()
		return r, after - before
	}
	on := DrawOffer{Enabled: true, Score: 0, Moves: 10, Pieces: 10, EGTBZero: true}
	// The engine thinks it is winning, the tablebase knows better.
	if r, n := asked(on, rookEnding, "draw"); n != 1 || !choose(r, 150) {
		t.Errorf("drawn by the tablebase: asked %d times, want once and a draw offer", n)
	}
	if r, n := asked(on, rookEnding, "win"); n != 1 || choose(r, 150) {
		t.Errorf("won by the tablebase: asked %d times, want once and no offer", n)
	}
	off := on
	off.EGTBZero = false
	if _, n := asked(off, rookEnding, "draw"); n != 0 {
		t.Errorf("asked the tablebase %d times with that turned off", n)
	}
	if _, n := asked(on, chess.StartFEN, "draw"); n != 0 {
		t.Errorf("asked the tablebase %d times about a position with 32 pieces", n)
	}
}

// drawGame starts a game with the scripted engine, which gives every
// position this score.
func drawGame(t *testing.T, score string, d DrawOffer) (*harness, string) {
	t.Helper()
	engine := filepath.Join(t.TempDir(), "ponderengine")
	if out, err := exec.Command("go", "build", "-o", engine, "./testdata/ponderengine").CombinedOutput(); err != nil {
		t.Fatal(string(out))
	}
	t.Setenv("PONDER_SCORE", score)
	h := newHarness(t, Policy{Casual: true, Humans: true, MaxGames: 1})
	h.cfg.Engine = EngineConfig{Name: "Scripted", Path: engine}
	h.cfg.Draw = d
	h.fake.MaxPlies = 200
	h.connect()
	if err := h.bot.SetAutoAccept(true); err != nil {
		t.Fatal(err)
	}
	h.waitListening()
	id := h.fake.Challenge("Alice", false, false, 120, 1, "black", "standard")
	h.waitFor("game start", func(s Status) bool { return len(s.Games) == 1 })
	return h, id
}

func TestEngineOffersAndAcceptsDraw(t *testing.T) {
	h, id := drawGame(t, "0", DrawOffer{Enabled: true, Score: 0, Moves: 3, Pieces: 32})
	deadline := time.Now().Add(15 * time.Second)
	for {
		if n, _ := h.fake.Draws(); n > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the engine never offered a draw")
		}
		time.Sleep(5 * time.Millisecond)
	}
	// Not before its third move.
	if moves, _, _, _ := h.fake.Game(id); len(moves) < 5 {
		t.Errorf("offered a draw after %d moves, before its third", len(moves))
	}
	// The opponent offers one: the engine's next move accepts it.
	h.fake.OfferDraw(id)
	s := h.waitFor("the draw", func(s Status) bool { _, ok := finishedGame(s); return ok })
	g, _ := finishedGame(s)
	if moves, status, _, _ := h.fake.Game(id); status != "draw" || len(moves) > 60 || g.Result != "1/2-1/2" {
		t.Errorf("the game ended %q (%s) after %d moves, want a draw by agreement", status, g.Result, len(moves))
	}
}

func TestEngineKeepsPlayingWithAScore(t *testing.T) {
	h, id := drawGame(t, "10", DrawOffer{Enabled: true, Score: 0, Moves: 3, Pieces: 32})
	h.waitFor("ten moves", func(Status) bool { moves, _, _, _ := h.fake.Game(id); return len(moves) >= 10 })
	if n, _ := h.fake.Draws(); n != 0 {
		t.Errorf("%d draw offers with a score of 10", n)
	}
	h.bot.Resign(id)
	h.waitFor("the end", func(s Status) bool { _, ok := finishedGame(s); return ok })
}

// The opponent's draw offer shows in the game's status, and can be accepted
// by hand when the engine's own rules would not.
func TestDrawOfferCanBeAnsweredByHand(t *testing.T) {
	h, id := drawGame(t, "10", DrawOffer{Enabled: false})
	h.waitFor("a few moves", func(Status) bool { moves, _, _, _ := h.fake.Game(id); return len(moves) >= 4 })
	seen := false
	deadline := time.Now().Add(15 * time.Second)
	for {
		if _, status, _, _ := h.fake.Game(id); status != "started" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the draw was never agreed")
		}
		// The engine's next move declines an offer, so offer until one is
		// still open when it is looked at.
		h.fake.OfferDraw(id)
		for _, g := range h.bot.Status().Games {
			if g.ID == id && g.DrawOffer == "theirs" {
				seen = true
				h.bot.Draw(id, true)
			}
		}
		time.Sleep(2 * time.Millisecond)
	}
	if !seen {
		t.Error("the offer never showed in the status")
	}
	if _, status, _, _ := h.fake.Game(id); status != "draw" {
		t.Errorf("the game ended %q, want a draw", status)
	}
	s := h.waitFor("the end", func(s Status) bool { _, ok := finishedGame(s); return ok })
	if g, _ := finishedGame(s); g.Result != "1/2-1/2" || g.DrawOffer != "" {
		t.Errorf("result %s, offer %q", g.Result, g.DrawOffer)
	}
}
