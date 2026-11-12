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
