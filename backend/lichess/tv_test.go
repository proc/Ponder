package lichess

import (
	"context"
	"strings"
	"testing"
	"time"

	"board/backend/game"
)

func TestSpectateTV(t *testing.T) {
	h := newSpect(t)
	h.fake.MaxPlies = 24
	h.sp.TVHold, h.sp.TVWait = 300*time.Millisecond, 5*time.Second
	if err := h.sp.StartTV(h.srv.URL, "nonsense"); err == nil {
		t.Fatal("an unknown channel was accepted")
	}
	first := h.fake.AutoGame("maia1", "SlowBot", 60, 0)
	if err := h.sp.StartTV(h.srv.URL, "blitz"); err != nil {
		t.Fatal(err)
	}
	v := h.waitFor("the TV game", func(v game.ExternalView, st SpectateStatus) bool {
		return st.State == "live" && v.ID == first && len(v.Moves) >= 2
	})
	if st := h.sp.Status(); st.TV != "blitz" || st.User != "Lichess TV · Blitz" || !strings.HasPrefix(v.Label, "Lichess TV · Blitz · ") || v.Side != "white" {
		t.Fatalf("status %+v, view %+v", st, v)
	}
	// A game that starts meanwhile comes on once the first is over, which
	// stays on the board a moment with its result.
	second := h.fake.AutoGame("SlowBot", "grumpy", 60, 0)
	v = h.waitFor("the first game over", func(v game.ExternalView, _ SpectateStatus) bool { return v.ID == first && v.Finished })
	moves, _, _, _ := h.fake.Game(first)
	if len(v.Moves) != len(moves) || v.Result == "" {
		t.Fatalf("finished view has %d moves (server %d): %+v", len(v.Moves), len(moves), v)
	}
	ended := time.Now()
	h.waitFor("the next TV game", func(v game.ExternalView, _ SpectateStatus) bool { return v.ID == second })
	if d := time.Since(ended); d < 250*time.Millisecond {
		t.Fatalf("the next game came on after %v, before the result was seen", d)
	}
	if st := h.sp.Status(); len(st.Games) != 1 || st.Games[0].ID != second || !st.Games[0].Shown {
		t.Fatalf("games %+v", st.Games)
	}
	h.sp.Stop()
	if st := h.sp.Status(); st.Active || st.TV != "" {
		t.Fatalf("still active %+v", st)
	}
}

func TestTVNow(t *testing.T) {
	h := newSpect(t)
	id := h.fake.AutoGame("maia1", "SlowBot", 60, 0)
	list, err := NewClient(h.srv.URL, "").TVNow(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != len(TVChannels) || list[0].Key != "best" || list[0].Name != "Top rated" {
		t.Fatalf("channels %+v", list)
	}
	for _, c := range list {
		want := c.Key == "best" || c.Key == "blitz" || c.Key == "bot"
		if want != (c.GameID == id && c.Player == "maia1" && c.Rating == 2000) {
			t.Fatalf("channel %+v", c)
		}
	}
}
