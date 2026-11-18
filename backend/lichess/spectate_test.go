package lichess

import (
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"board/backend/chess"
	"board/backend/game"
	"board/backend/lichess/fake"
)

type spectHarness struct {
	t      *testing.T
	fake   *fake.Server
	srv    *httptest.Server
	sp     *Spectator
	mu     sync.Mutex
	views  []game.ExternalView
	status SpectateStatus
}

func newSpect(t *testing.T) *spectHarness {
	h := &spectHarness{t: t, fake: fake.New("secret", "TestBot")}
	h.fake.Delay = 15 * time.Millisecond
	h.fake.MaxPlies = 30
	h.srv = httptest.NewServer(h.fake)
	h.sp = NewSpectator(func(ev string, data any) {
		h.mu.Lock()
		h.status = data.(SpectateStatus)
		h.mu.Unlock()
	}, func(v game.ExternalView) {
		h.mu.Lock()
		h.views = append(h.views, v)
		h.mu.Unlock()
	})
	h.sp.Poll = 100 * time.Millisecond
	t.Cleanup(func() {
		h.sp.Stop()
		h.srv.CloseClientConnections()
		h.srv.Close()
	})
	return h
}

func (h *spectHarness) last() (game.ExternalView, SpectateStatus, int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.views) == 0 {
		return game.ExternalView{}, h.status, 0
	}
	return h.views[len(h.views)-1], h.status, len(h.views)
}

func (h *spectHarness) waitFor(what string, cond func(game.ExternalView, SpectateStatus) bool) game.ExternalView {
	h.t.Helper()
	end := time.Now().Add(15 * time.Second)
	for time.Now().Before(end) {
		v, st, _ := h.last()
		if cond(v, st) {
			return v
		}
		time.Sleep(10 * time.Millisecond)
	}
	v, st, n := h.last()
	h.t.Fatalf("timed out waiting for %s: %d views, last %+v, status %+v", what, n, v, st)
	return v
}

func TestSpectateFollowsGamesOneAfterAnother(t *testing.T) {
	h := newSpect(t)
	if err := h.sp.Start(h.srv.URL, "SlowBot"); err != nil {
		t.Fatal(err)
	}
	h.waitFor("waiting with no games", func(_ game.ExternalView, st SpectateStatus) bool {
		return st.State == "waiting" && strings.Contains(st.Message, "no games")
	})
	first := h.fake.AutoGame("maia1", "SlowBot", 60, 0)
	v := h.waitFor("live game", func(v game.ExternalView, st SpectateStatus) bool {
		return st.State == "live" && v.ID == first && len(v.Moves) >= 4
	})
	if v.Side != "black" || v.White.Name != "maia1" || v.Black.Type != "lichess" || !strings.Contains(v.Label, "Watching SlowBot") {
		t.Fatalf("view %+v", v)
	}
	v = h.waitFor("game over", func(v game.ExternalView, _ SpectateStatus) bool { return v.ID == first && v.Finished })
	moves, status, _, _ := h.fake.Game(first)
	if len(v.Moves) != len(moves) || v.Result == "" || status == "started" {
		t.Fatalf("finished view has %d moves (server %d, %s): %+v", len(v.Moves), len(moves), status, v)
	}
	// The moves shown are the moves played, in order.
	for i := range moves {
		if v.Moves[i] != moves[i] {
			t.Fatalf("move %d: %s, want %s", i, v.Moves[i], moves[i])
		}
	}
	h.waitFor("waiting for the next game", func(_ game.ExternalView, st SpectateStatus) bool { return st.State == "waiting" })
	second := h.fake.AutoGame("SlowBot", "grumpy", 60, 0)
	v = h.waitFor("next game", func(v game.ExternalView, st SpectateStatus) bool { return v.ID == second })
	if v.Side != "white" {
		t.Fatalf("side %q", v.Side)
	}
	h.sp.Stop()
	if st := h.sp.Status(); st.Active {
		t.Fatalf("still active %+v", st)
	}
}

func TestSpectateJoinsMidGame(t *testing.T) {
	h := newSpect(t)
	h.fake.MaxPlies = 200
	id := h.fake.AutoGame("maia1", "SlowBot", 60, 0)
	for {
		if m, _, _, _ := h.fake.Game(id); len(m) >= 10 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	h.sp.Start(h.srv.URL, "maia1")
	v := h.waitFor("caught up", func(v game.ExternalView, st SpectateStatus) bool { return st.State == "live" && len(v.Moves) >= 14 })
	moves, _, _, _ := h.fake.Game(id)
	for i := range v.Moves {
		if v.Moves[i] != moves[i] {
			t.Fatalf("move %d: %s, want %s", i, v.Moves[i], moves[i])
		}
	}
	if v.Side != "white" || v.WhiteMs <= 0 {
		t.Fatalf("view %+v", v)
	}
}

func TestBridgeFillsSkippedMoves(t *testing.T) {
	pos, _ := chess.ParseFEN(chess.StartFEN)
	p := pos
	var played []string
	for _, s := range []string{"e2e4", "e7e5", "g1f3"} {
		m, _ := p.ParseUCIMove(s)
		p = p.Make(m)
		played = append(played, s)
	}
	ms, ok := bridge(pos, fenKey(p.FEN()), "g1f3", 4)
	if !ok || len(ms) != 3 {
		t.Fatalf("bridge: %v %v", ms, ok)
	}
	for i, m := range ms {
		if m.UCI() != played[i] {
			t.Fatalf("move %d %s", i, m.UCI())
		}
	}
}

// Lichess replays the whole game when the stream opens and sends positions
// late; a gap in the stream is filled from the exported game. Either way
// the list keeps every move from the first.
func TestSpectateKeepsAllMoves(t *testing.T) {
	for _, tc := range []struct {
		name string
		lag  int
		drop map[int]bool
	}{{"replay", 0, nil}, {"lagging", 3, nil}, {"gap", 0, map[int]bool{16: true, 17: true, 18: true, 19: true, 20: true, 21: true, 22: true}}} {
		t.Run(tc.name, func(t *testing.T) {
			h := newSpect(t)
			h.fake.MaxPlies = 40
			h.fake.StreamLag, h.fake.Drop = tc.lag, tc.drop
			id := h.fake.AutoGame("maia1", "SlowBot", 60, 0)
			for {
				if m, _, _, _ := h.fake.Game(id); len(m) >= 8 {
					break
				}
				time.Sleep(5 * time.Millisecond)
			}
			h.sp.Start(h.srv.URL, "maia1")
			// Never fewer moves than when joining, never a list that starts mid-game.
			end := time.Now().Add(15 * time.Second)
			for time.Now().Before(end) {
				v, _, _ := h.last()
				if v.ID == id && v.StartFEN != "" && fenKey(v.StartFEN) != fenKey(chess.StartFEN) {
					t.Fatalf("the list restarted mid-game at %s", v.StartFEN)
				}
				if v.ID == id && v.Finished {
					break
				}
				time.Sleep(5 * time.Millisecond)
			}
			v := h.waitFor("finished", func(v game.ExternalView, _ SpectateStatus) bool { return v.ID == id && v.Finished })
			moves, _, _, _ := h.fake.Game(id)
			if len(v.Moves) != len(moves) {
				t.Fatalf("%d moves shown, %d played", len(v.Moves), len(moves))
			}
			for i := range moves {
				if v.Moves[i] != moves[i] {
					t.Fatalf("move %d: %s, want %s", i, v.Moves[i], moves[i])
				}
			}
		})
	}
}

// A player in two games at once: both are followed, one is on the board,
// and Show puts the other one there.
func TestSpectateFollowsSeveralGames(t *testing.T) {
	h := newSpect(t)
	h.fake.MaxPlies = 60
	first := h.fake.AutoGame("maia1", "SlowBot", 60, 0)
	second := h.fake.AutoGame("SlowBot", "grumpy", 60, 0)
	if err := h.sp.Start(h.srv.URL, "SlowBot"); err != nil {
		t.Fatal(err)
	}
	games := func(st SpectateStatus) map[string]SpectateGame {
		m := map[string]SpectateGame{}
		for _, g := range st.Games {
			m[g.ID] = g
		}
		return m
	}
	h.waitFor("both games followed", func(_ game.ExternalView, st SpectateStatus) bool {
		g := games(st)
		return len(g) == 2 && g[first].Moves >= 4 && g[second].Moves >= 4
	})
	_, st, _ := h.last()
	g := games(st)
	onBoard := st.GameID
	other := first
	if onBoard == first {
		other = second
	}
	if !g[onBoard].Shown || g[other].Shown || g[first].Side != "black" || g[second].Side != "white" || g[second].Black != "grumpy" {
		t.Fatalf("games %+v, on the board %q", st.Games, onBoard)
	}
	// Only the game on the board is sent to it.
	h.mu.Lock()
	for _, v := range h.views {
		if v.ID != onBoard {
			h.mu.Unlock()
			t.Fatalf("a view of %s while %s is on the board", v.ID, onBoard)
		}
	}
	h.mu.Unlock()
	if err := h.sp.Show(other); err != nil {
		t.Fatal(err)
	}
	h.waitFor("the other game on the board", func(v game.ExternalView, st SpectateStatus) bool {
		return v.ID == other && st.GameID == other && games(st)[other].Shown
	})
	if err := h.sp.Show("nosuchgame"); err == nil {
		t.Fatal("showing an unknown game did not fail")
	}
	// Both are followed to the end, each with all its moves.
	h.waitFor("both over", func(_ game.ExternalView, st SpectateStatus) bool {
		g := games(st)
		return len(g) == 2 && !g[first].Live && !g[second].Live && st.State == "waiting"
	})
	_, st, _ = h.last()
	for _, id := range []string{first, second} {
		moves, _, _, _ := h.fake.Game(id)
		if g := games(st)[id]; g.Moves != len(moves) || g.Result == "" || g.Result == "*" {
			t.Fatalf("%s: %+v, %d moves played", id, g, len(moves))
		}
	}
	// The next game takes the board, and the finished ones go.
	third := h.fake.AutoGame("SlowBot", "maia5", 60, 0)
	h.waitFor("the next game", func(v game.ExternalView, st SpectateStatus) bool {
		return v.ID == third && len(st.Games) == 1 && st.Games[0].ID == third
	})
}

// The game on the board ends while the player has another going: after a
// moment (the result shows first), that one takes the board.
func TestSpectateSwitchesToALiveGameWhenTheShownOneEnds(t *testing.T) {
	h := newSpect(t)
	h.fake.MaxPlies = 400
	h.fake.Delay = 40 * time.Millisecond
	h.sp.SwitchHold = 300 * time.Millisecond
	first := h.fake.AutoGame("maia1", "SlowBot", 600, 0)
	second := h.fake.AutoGame("SlowBot", "grumpy", 600, 0)
	if err := h.sp.Start(h.srv.URL, "SlowBot"); err != nil {
		t.Fatal(err)
	}
	h.waitFor("both games followed", func(_ game.ExternalView, st SpectateStatus) bool { return len(st.Games) == 2 })
	_, st, _ := h.last()
	shown, other := st.GameID, first
	if shown == first {
		other = second
	}
	h.fake.Resign(shown, "white")
	ended := time.Now()
	h.waitFor("the result on the board", func(v game.ExternalView, _ SpectateStatus) bool { return v.ID == shown && v.Finished })
	h.waitFor("the other game on the board", func(v game.ExternalView, st SpectateStatus) bool { return v.ID == other && st.GameID == other })
	if d := time.Since(ended); d < 250*time.Millisecond {
		t.Fatalf("switched after %v, before the result had a moment on the board", d)
	}
	// With nothing else going, the last game's end stays on the board.
	h.fake.Resign(other, "black")
	h.waitFor("the last result", func(v game.ExternalView, _ SpectateStatus) bool { return v.ID == other && v.Finished })
	time.Sleep(500 * time.Millisecond)
	if v, st, _ := h.last(); v.ID != other || st.GameID != other {
		t.Fatalf("moved off the last game to %s / %s", v.ID, st.GameID)
	}
}

// A game picked by hand meanwhile is not taken off the board.
func TestSpectateKeepsTheGamePickedAfterOneEnds(t *testing.T) {
	h := newSpect(t)
	h.fake.MaxPlies = 400
	h.fake.Delay = 40 * time.Millisecond
	h.sp.SwitchHold = 300 * time.Millisecond
	a := h.fake.AutoGame("maia1", "SlowBot", 600, 0)
	b := h.fake.AutoGame("SlowBot", "grumpy", 600, 0)
	if err := h.sp.Start(h.srv.URL, "SlowBot"); err != nil {
		t.Fatal(err)
	}
	h.waitFor("both games followed", func(_ game.ExternalView, st SpectateStatus) bool { return len(st.Games) == 2 })
	_, st, _ := h.last()
	shown := st.GameID
	h.fake.Resign(shown, "white")
	h.waitFor("the result", func(v game.ExternalView, _ SpectateStatus) bool { return v.ID == shown && v.Finished })
	// Picked again by hand at once: the finished one stays.
	h.sp.Show(shown)
	time.Sleep(500 * time.Millisecond)
	if _, st, _ := h.last(); st.GameID != shown {
		t.Fatalf("switched to %s although %s was picked (games %s %s)", st.GameID, shown, a, b)
	}
}
