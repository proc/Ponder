package lichess

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"board/backend/chess"
	"board/backend/game"
	"board/backend/lichess/fake"
)

type playHarness struct {
	t     *testing.T
	fake  *fake.Server
	srv   *httptest.Server
	p     *Player
	mu    sync.Mutex
	shown []game.ExternalView
	takes int
	saved []string
}

func newPlayHarness(t *testing.T) *playHarness {
	h := &playHarness{t: t, fake: fake.New("secret", "Alice")}
	h.fake.Bot = false
	h.fake.Delay = 20 * time.Millisecond
	h.srv = httptest.NewServer(h.fake)
	h.p = NewPlayer(PlayHooks{
		Show: func(v game.ExternalView, takeOver bool) {
			h.mu.Lock()
			h.shown = append(h.shown, v)
			if takeOver {
				h.takes++
			}
			h.mu.Unlock()
		},
		Save: func(pgn string) {
			h.mu.Lock()
			h.saved = append(h.saved, pgn)
			h.mu.Unlock()
		},
	})
	t.Cleanup(func() {
		h.p.Disconnect()
		h.srv.CloseClientConnections()
		h.srv.Close()
	})
	return h
}

func (h *playHarness) wait(what string, cond func(PlayStatus) bool) PlayStatus {
	h.t.Helper()
	end := time.Now().Add(5 * time.Second)
	for time.Now().Before(end) {
		if st := h.p.Status(); cond(st) {
			return st
		}
		time.Sleep(10 * time.Millisecond)
	}
	h.t.Fatalf("timed out waiting for %s; status %+v", what, h.p.Status())
	return PlayStatus{}
}

func (h *playHarness) last() game.ExternalView {
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.shown) == 0 {
		return game.ExternalView{}
	}
	return h.shown[len(h.shown)-1]
}

// playMyMoves plays random legal moves on the account's turns until n plies.
func (h *playHarness) playUntil(id string, plies int) {
	h.t.Helper()
	end := time.Now().Add(10 * time.Second)
	for time.Now().Before(end) {
		st := h.p.Status()
		g := st.Games[0]
		if g.Finished || g.Moves >= plies {
			return
		}
		if g.MyTurn {
			v := h.last()
			pos, _ := chess.ParseFEN(v.StartFEN)
			for _, m := range v.Moves {
				mv, _ := pos.ParseUCIMove(m)
				pos = pos.Make(mv)
			}
			if colorName(pos.Turn) == v.Side {
				moves := pos.LegalMoves()
				if err := h.p.Move(id, moves[0].UCI()); err != nil && !strings.Contains(err.Error(), "on its way") {
					h.t.Fatalf("move: %v", err)
				}
			}
		}
		time.Sleep(15 * time.Millisecond)
	}
	h.t.Fatalf("game did not reach %d plies", plies)
}

func TestPlayerRejectsBotAccount(t *testing.T) {
	h := newPlayHarness(t)
	h.fake.Bot = true
	st, err := h.p.Connect(h.srv.URL, "secret")
	if err != nil || st.State != "bot" {
		t.Fatalf("state %q err %v", st.State, err)
	}
	if err := h.p.Seek(LobbySeek{Limit: 600}); err == nil {
		t.Fatal("seek allowed while not signed in to a personal account")
	}
}

func TestPlayerSeekPlayAndDraw(t *testing.T) {
	h := newPlayHarness(t)
	if st, err := h.p.Connect(h.srv.URL, "secret"); err != nil || st.State != "connected" || st.Account.Username != "Alice" {
		t.Fatalf("connect: %+v %v", st, err)
	}
	// Blitz cannot be sought through the Board API.
	if err := h.p.Seek(LobbySeek{Limit: 180, Increment: 2}); err == nil || !strings.Contains(err.Error(), "rapid") {
		t.Fatalf("blitz seek: %v", err)
	}
	if err := h.p.Seek(LobbySeek{Limit: 600, Increment: 0, Color: "white"}); err != nil {
		t.Fatal(err)
	}
	if st := h.p.Status(); st.Seek == nil || st.Seek.Limit != 600 {
		t.Fatalf("seek not shown: %+v", st.Seek)
	}
	st := h.wait("game start", func(s PlayStatus) bool { return len(s.Games) == 1 && s.Seek == nil })
	g := st.Games[0]
	if g.Color != "white" || g.Opponent != "Rival" || st.Current != g.ID {
		t.Fatalf("game %+v current %q", g, st.Current)
	}
	h.wait("board", func(PlayStatus) bool { return h.last().ID == g.ID })
	v := h.last()
	if v.Kind != "play" || !v.Playable || v.Side != "white" || v.White.Type != "human" || v.White.Name != "Alice" || v.Black.Type != "lichess" {
		t.Fatalf("view %+v", v)
	}
	if h.takes != 1 {
		t.Fatalf("the new game should take over the board once, took %d", h.takes)
	}
	// Not your move: refused at once.
	if err := h.p.Move(g.ID, "e7e5"); err == nil {
		t.Fatal("illegal move accepted")
	}
	// A move shows before Lichess confirms it.
	if err := h.p.Move(g.ID, "e2e4"); err != nil {
		t.Fatal(err)
	}
	if v := h.last(); len(v.Moves) != 1 || v.Moves[0] != "e2e4" {
		t.Fatalf("move not shown at once: %v", v.Moves)
	}
	h.wait("reply", func(s PlayStatus) bool { return s.Games[0].Moves == 2 && s.Games[0].MyTurn })
	h.playUntil(g.ID, 8)
	h.wait("my turn", func(s PlayStatus) bool { return s.Games[0].MyTurn })

	// Takeback: the opponent accepts; it is our turn again with fewer moves.
	before := h.p.Status().Games[0].Moves
	if err := h.p.Takeback(g.ID, true); err != nil {
		t.Fatal(err)
	}
	st = h.wait("takeback", func(s PlayStatus) bool { return s.Games[0].Moves == before-2 && s.Games[0].MyTurn })

	// The opponent offers a draw: shown, then declined.
	if _, err := httpGet(h.srv.URL + "/_fake/offer?kind=draw&game=" + g.ID); err != nil {
		t.Fatal(err)
	}
	h.wait("draw offer", func(s PlayStatus) bool { return s.Games[0].Draw == "theirs" })
	if err := h.p.Draw(g.ID, false); err != nil {
		t.Fatal(err)
	}
	h.wait("declined", func(s PlayStatus) bool { return s.Games[0].Draw == "" })

	// Our offer is accepted: the game ends drawn and is saved.
	if err := h.p.Draw(g.ID, true); err != nil {
		t.Fatal(err)
	}
	st = h.wait("draw", func(s PlayStatus) bool { return s.Games[0].Finished })
	if st.Games[0].Result != "1/2-1/2" {
		t.Fatalf("result %q", st.Games[0].Result)
	}
	if v := h.last(); !v.Finished || v.Result != "1/2-1/2" {
		t.Fatalf("final view %+v", v)
	}
	time.Sleep(50 * time.Millisecond)
	h.mu.Lock()
	saved := append([]string(nil), h.saved...)
	h.mu.Unlock()
	if len(saved) != 1 || !strings.Contains(saved[0], `[White "Alice"]`) || !strings.Contains(saved[0], `[Black "Rival"]`) {
		t.Fatalf("saved %q", saved)
	}
	if err := h.p.Move(g.ID, "e2e4"); err == nil {
		t.Fatal("move after the end accepted")
	}
	calls := strings.Join(h.fake.Calls(), "\n")
	for _, want := range []string{"POST /api/board/seek", "GET /api/board/game/stream/", "POST /api/board/game/" + g.ID + "/move/e2e4",
		"/takeback/yes", "/draw/no", "/draw/yes"} {
		if !strings.Contains(calls, want) {
			t.Errorf("no call %q in\n%s", want, calls)
		}
	}
}

func TestPlayerSeekCancel(t *testing.T) {
	h := newPlayHarness(t)
	h.fake.Delay = 300 * time.Millisecond
	if _, err := h.p.Connect(h.srv.URL, "secret"); err != nil {
		t.Fatal(err)
	}
	if err := h.p.Seek(LobbySeek{Limit: 900, Increment: 10}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond)
	h.p.StopSeek()
	if h.p.Status().Seek != nil {
		t.Fatal("still seeking")
	}
	time.Sleep(1500 * time.Millisecond)
	if st := h.p.Status(); len(st.Games) != 0 {
		t.Fatalf("a game started after cancelling: %+v", st.Games)
	}
	if !strings.Contains(strings.Join(h.fake.Calls(), " "), "seek-cancelled") {
		t.Fatal("the seek request was not closed")
	}
}

func TestPlayerChallengeAndResign(t *testing.T) {
	h := newPlayHarness(t)
	if _, err := h.p.Connect(h.srv.URL, "secret"); err != nil {
		t.Fatal(err)
	}
	// Direct challenges may be blitz.
	if err := h.p.Challenge(ChallengeParams{Username: "Bob", Limit: 180, Increment: 2, Color: "black"}); err != nil {
		t.Fatal(err)
	}
	st := h.wait("game", func(s PlayStatus) bool { return len(s.Games) == 1 && len(s.Outgoing) == 0 })
	g := st.Games[0]
	if g.Color != "black" {
		t.Fatalf("color %q", g.Color)
	}
	h.wait("first move", func(s PlayStatus) bool { return s.Games[0].Moves >= 1 && s.Games[0].MyTurn })
	if err := h.p.Resign(g.ID); err != nil {
		t.Fatal(err)
	}
	st = h.wait("resigned", func(s PlayStatus) bool { return s.Games[0].Finished })
	if st.Games[0].Result != "1-0" {
		t.Fatalf("result %q", st.Games[0].Result)
	}
	// An incoming challenge can be accepted.
	cid := h.fake.Challenge("Carol", false, false, 600, 0, "random", "")
	h.wait("challenge", func(s PlayStatus) bool { return len(s.Incoming) == 1 })
	if err := h.p.Accept(cid); err != nil {
		t.Fatal(err)
	}
	st = h.wait("second game", func(s PlayStatus) bool { return len(s.Games) == 2 && len(s.Incoming) == 0 })
	if st.Current != st.Games[0].ID || st.Games[0].Opponent != "Carol" {
		t.Fatalf("current %q games %+v", st.Current, st.Games)
	}
	// Show switches the board back to the first game.
	if err := h.p.Show(g.ID); err != nil {
		t.Fatal(err)
	}
	if v := h.last(); v.ID != g.ID || !v.Finished {
		t.Fatalf("shown %+v", v)
	}
}

func httpGet(url string) (string, error) {
	res, err := http.Get(url)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	b, err := io.ReadAll(res.Body)
	return string(b), err
}
