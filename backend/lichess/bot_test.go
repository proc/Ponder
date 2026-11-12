package lichess

import (
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"board/backend/game"
	"board/backend/lichess/fake"
)

var enginePath string

func TestMain(m *testing.M) {
	dir, _ := os.MkdirTemp("", "lichess-test")
	enginePath = filepath.Join(dir, "randomengine")
	if out, err := exec.Command("go", "build", "-o", enginePath, "../cmd/randomengine").CombinedOutput(); err != nil {
		panic(string(out))
	}
	code := m.Run()
	os.RemoveAll(dir)
	os.Exit(code)
}

type harness struct {
	t     *testing.T
	fake  *fake.Server
	srv   *httptest.Server
	bot   *Bot
	mu    sync.Mutex
	last  Status
	shown []game.ExternalView
	infos int
	cfg   Config
}

func newHarness(t *testing.T, policy Policy) *harness {
	h := &harness{t: t, fake: fake.New("secret", "TestBot")}
	h.fake.Delay = 20 * time.Millisecond
	h.fake.MaxPlies = 40
	h.srv = httptest.NewServer(h.fake)
	h.bot = NewBot(Hooks{
		Emit: func(ev string, data any) {
			h.mu.Lock()
			defer h.mu.Unlock()
			switch ev {
			case "lichess":
				h.last = data.(Status)
			case "engineInfo":
				h.infos++
			}
		},
		Show: func(v game.ExternalView) {
			h.mu.Lock()
			h.shown = append(h.shown, v)
			h.mu.Unlock()
		},
		AutoWatch: func() bool { return true },
	})
	h.cfg = Config{BaseURL: h.srv.URL, Token: "secret", Engine: EngineConfig{Name: "Random", Path: enginePath}, Policy: policy}
	t.Cleanup(func() {
		h.bot.Disconnect(false)
		h.srv.CloseClientConnections()
		h.srv.Close()
	})
	return h
}

func (h *harness) status() Status {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.last
}

func (h *harness) waitFor(what string, cond func(Status) bool) Status {
	h.t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		if s := h.bot.Status(); cond(s) {
			return s
		}
		time.Sleep(20 * time.Millisecond)
	}
	h.t.Fatalf("timed out waiting for %s; status %+v", what, h.bot.Status())
	return Status{}
}

func (h *harness) connect() {
	h.t.Helper()
	s, err := h.bot.Connect(h.cfg)
	if err != nil || s.State != "connected" {
		h.t.Fatalf("connect: %v %+v", err, s)
	}
}

func (h *harness) waitListening() {
	h.t.Helper()
	for i := 0; h.fake.Listeners() == 0; i++ {
		if i > 500 {
			h.t.Fatal("the bot never opened the event stream")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func finishedGame(s Status) (GameView, bool) {
	for _, g := range s.Games {
		if g.Finished {
			return g, true
		}
	}
	return GameView{}, false
}

func TestBadToken(t *testing.T) {
	h := newHarness(t, Policy{})
	h.cfg.Token = "wrong"
	s, err := h.bot.Connect(h.cfg)
	if err == nil || s.State != "error" {
		t.Fatalf("want error, got %v %+v", err, s)
	}
}

func TestNotBotThenUpgrade(t *testing.T) {
	h := newHarness(t, Policy{})
	h.fake.Bot = false
	s, err := h.bot.Connect(h.cfg)
	if err != nil || s.State != "notBot" {
		t.Fatalf("want notBot, got %v %+v", err, s)
	}
	if s, err = h.bot.UpgradeToBot(); err != nil || s.State != "connected" || s.Account.Title != "BOT" {
		t.Fatalf("upgrade: %v %+v", err, s)
	}
}

func TestAcceptAndPlayToTheEnd(t *testing.T) {
	h := newHarness(t, Policy{})
	h.connect()
	id := h.fake.Challenge("Alice", false, false, 60, 0, "random", "standard")
	s := h.waitFor("incoming challenge", func(s Status) bool { return len(s.Incoming) == 1 })
	if c := s.Incoming[0]; c.ID != id || c.User != "Alice" || !c.Supported {
		t.Fatalf("bad challenge view %+v", c)
	}
	if err := h.bot.Accept(id); err != nil {
		t.Fatal(err)
	}
	s = h.waitFor("game over", func(s Status) bool { _, ok := finishedGame(s); return ok })
	g, _ := finishedGame(s)
	moves, status, _, _ := h.fake.Game(id)
	if status == "started" || len(moves) < 2 || g.Moves != len(moves) {
		t.Fatalf("game %+v; server has %d moves, status %s", g, len(moves), status)
	}
	if g.Result == "" || g.Result == "*" && status != "aborted" {
		t.Fatalf("no result: %+v", g)
	}
	if s.Watching != id {
		t.Fatalf("watching %q, want %q", s.Watching, id)
	}
	h.mu.Lock()
	shown := h.shown
	h.mu.Unlock()
	if len(shown) == 0 || !shown[len(shown)-1].Finished || len(shown[len(shown)-1].Moves) != len(moves) {
		t.Fatalf("board was not kept up to date: %d views", len(shown))
	}
}

func TestDeclineUnsupportedAndPolicy(t *testing.T) {
	h := newHarness(t, Policy{Casual: true, Humans: true, MaxMinutes: 10, MaxGames: 1})
	h.connect()
	if err := h.bot.SetAutoAccept(true); err != nil {
		t.Fatal(err)
	}
	h.fake.Challenge("Variant", false, false, 60, 0, "random", "atomic")
	h.fake.Challenge("Corr", false, false, -1, 0, "random", "standard")
	h.fake.Challenge("Rated", false, true, 60, 0, "random", "standard")
	h.fake.Challenge("Slow", false, false, 3600, 0, "random", "standard")
	h.fake.Challenge("Robot", true, false, 60, 0, "random", "standard")
	deadline := time.Now().Add(5 * time.Second)
	want := []string{"decline-reason standard", "decline-reason timeControl", "decline-reason casual", "decline-reason tooSlow", "decline-reason noBot"}
	for {
		calls := strings.Join(h.fake.Calls(), "\n")
		missing := ""
		for _, w := range want {
			if !strings.Contains(calls, w) {
				missing = w
			}
		}
		if missing == "" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("missing %q in calls:\n%s", missing, calls)
		}
		time.Sleep(20 * time.Millisecond)
	}
	if s := h.bot.Status(); len(s.Incoming) != 0 || len(s.Games) != 0 {
		t.Fatalf("nothing should be pending or played: %+v", s)
	}
}

func TestAutoAcceptPlaysAndLimitsGames(t *testing.T) {
	h := newHarness(t, Policy{Casual: true, Humans: true, MaxGames: 1})
	h.connect()
	if err := h.bot.SetAutoAccept(true); err != nil {
		t.Fatal(err)
	}
	first := h.fake.Challenge("Alice", false, false, 120, 1, "white", "standard")
	h.waitFor("game start", func(s Status) bool { return len(s.Games) == 1 })
	h.fake.Challenge("Bob", false, false, 120, 1, "white", "standard")
	deadline := time.Now().Add(5 * time.Second)
	for !strings.Contains(strings.Join(h.fake.Calls(), "\n"), "decline-reason later") {
		if time.Now().After(deadline) {
			t.Fatalf("second game was not declined: %v", h.fake.Calls())
		}
		time.Sleep(20 * time.Millisecond)
	}
	// The challenger took white, so the bot plays black.
	if g := h.bot.Status().Games[0]; g.ID != first || g.Color != "black" {
		t.Fatalf("game %+v", g)
	}
	if err := h.bot.Resign(first); err != nil {
		t.Fatal(err)
	}
	s := h.waitFor("resignation", func(s Status) bool { _, ok := finishedGame(s); return ok })
	if g, _ := finishedGame(s); g.Result != "1-0" || g.Status != "resign" {
		t.Fatalf("after resigning: %+v", g)
	}
}

func TestOutgoingChallenge(t *testing.T) {
	h := newHarness(t, Policy{})
	h.connect()
	bots, err := h.bot.OnlineBots()
	if err != nil || len(bots) != 6 || bots[0].RatingFor("blitz") != 1500 {
		t.Fatalf("online bots: %v %v", bots, err)
	}
	if err := h.bot.Challenge(ChallengeParams{Username: "grumpy", Limit: 180, Increment: 2, Color: "random"}); err != nil {
		t.Fatal(err)
	}
	s := h.waitFor("decline", func(s Status) bool { return strings.Contains(s.Message, "declined") })
	if len(s.Outgoing) != 0 {
		t.Fatalf("outgoing should be cleared: %+v", s.Outgoing)
	}
	if err := h.bot.Challenge(ChallengeParams{Username: "maia1", Limit: 60, Increment: 0, Color: "white"}); err != nil {
		t.Fatal(err)
	}
	s = h.waitFor("game", func(s Status) bool { return len(s.Games) == 1 && s.Games[0].Moves >= 1 })
	if g := s.Games[0]; g.Color != "white" || g.Opponent != "maia1" {
		t.Fatalf("game %+v", g)
	}
	if err := h.bot.Abort(s.Games[0].ID); err == nil {
		// Abort is allowed only before both sides moved; either outcome is fine,
		// but a successful abort must finish the game.
		h.waitFor("abort", func(s Status) bool { _, ok := finishedGame(s); return ok })
	}
}

func TestReconnect(t *testing.T) {
	h := newHarness(t, Policy{})
	h.connect()
	h.waitListening()
	h.fake.DropStreams()
	h.waitFor("reconnecting", func(s Status) bool { return s.State == "reconnecting" })
	h.waitFor("reconnected", func(s Status) bool { return s.State == "connected" })
	h.waitListening()
	id := h.fake.Challenge("Carol", false, false, 60, 0, "random", "standard")
	h.waitFor("challenge after reconnect", func(s Status) bool { return len(s.Incoming) == 1 && s.Incoming[0].ID == id })
}

func TestParseCastlingKingToRook(t *testing.T) {
	r := newRunner(NewBot(Hooks{}), "x", &GameInfo{Color: "white"})
	pos := r.start
	for _, s := range []string{"e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "g8f6"} {
		m, err := parseMove(&pos, s)
		if err != nil {
			t.Fatal(err)
		}
		pos = pos.Make(m)
	}
	m, err := parseMove(&pos, "e1h1")
	if err != nil || m.UCI() != "e1g1" {
		t.Fatalf("e1h1 → %v %v", m.UCI(), err)
	}
}

func TestConnectingPlaysNothing(t *testing.T) {
	h := newHarness(t, Policy{Casual: true, Humans: true, Bots: true, MaxGames: 4})
	h.connect()
	// A game the engine was playing before; the app then went away without
	// resigning it.
	id := h.fake.Challenge("Alice", false, false, 300, 0, "white", "standard")
	h.waitFor("challenge", func(s Status) bool { return len(s.Incoming) == 1 })
	if err := h.bot.Accept(id); err != nil {
		t.Fatal(err)
	}
	h.waitFor("engine moved", func(s Status) bool { return len(s.Games) == 1 && s.Games[0].Moves >= 2 && s.Games[0].Playing })
	h.bot.Disconnect(false)

	// A challenge waiting, and the old game still going: connecting again
	// accepts nothing and plays nothing, even with rules that would accept.
	h.fake.Challenge("Bob", false, false, 300, 0, "random", "standard")
	h.connect()
	s := h.waitFor("listed", func(s Status) bool { return len(s.Games) == 1 && len(s.Incoming) == 1 })
	if s.AutoAccept || s.Games[0].Playing {
		t.Fatalf("connecting should be passive: %+v", s)
	}
	h.waitFor("in sync", func(s Status) bool { return s.Games[0].MyTurn })
	before, _, _, _ := h.fake.Game(id)
	time.Sleep(time.Second)
	after, _, _, _ := h.fake.Game(id)
	if len(after) != len(before) {
		t.Fatalf("the engine moved without Play: %d → %d moves", len(before), len(after))
	}
	for _, c := range h.fake.Calls() {
		if strings.Contains(c, "/accept") && !strings.Contains(c, id) || strings.Contains(c, "decline") {
			t.Fatalf("answered a challenge by itself: %v", h.fake.Calls())
		}
	}
	// Play hands the game to the engine.
	if err := h.bot.Play(id); err != nil {
		t.Fatal(err)
	}
	h.waitFor("engine plays", func(s Status) bool { return s.Games[0].Playing && s.Games[0].Moves > len(before) })
	// Turning automatic accepting on answers the waiting challenge.
	if err := h.bot.SetAutoAccept(true); err != nil {
		t.Fatal(err)
	}
	h.waitFor("auto accepted", func(s Status) bool { return len(s.Incoming) == 0 && len(s.Games) == 2 && s.Games[0].Playing })
}

func TestSeekChallengesRandomBotsUntilOneAccepts(t *testing.T) {
	seekAnswerTimeout, seekPause, seekRetry = 300*time.Millisecond, 20*time.Millisecond, 200*time.Millisecond
	h := newHarness(t, Policy{})
	// Only the bots that will not play are in range at first.
	h.fake.Online = []fake.OnlineBot{{Name: "grumpy", Rating: 1700}, {Name: "picky", Rating: 1750}, {Name: "sleepy", Rating: 1650},
		{Name: "maia1", Rating: 1200}, {Name: "strongbot", Rating: 2600}}
	h.connect()
	err := h.bot.StartSeek(SeekParams{ChallengeParams: ChallengeParams{Limit: 180, Increment: 2, Color: "random"}, MinRating: 1600, MaxRating: 1800})
	if err != nil {
		t.Fatal(err)
	}
	s := h.waitFor("all three asked", func(s Status) bool { return s.Seek != nil && strings.Contains(s.Seek.Message, "has been asked") })
	if s.Seek.Speed != "blitz" || s.Seek.Tried != 3 || len(s.Games) != 0 {
		t.Fatalf("seek %+v games %d", s.Seek, len(s.Games))
	}
	calls := strings.Join(h.fake.Calls(), "\n")
	for _, bot := range []string{"grumpy", "picky", "sleepy"} {
		if !strings.Contains(calls, "/api/challenge/"+bot) {
			t.Fatalf("%s was not challenged:\n%s", bot, calls)
		}
	}
	if strings.Contains(calls, "maia1") || strings.Contains(calls, "strongbot") {
		t.Fatalf("challenged a bot outside the range:\n%s", calls)
	}
	if !strings.Contains(calls, "/cancel") {
		t.Fatalf("the unanswered challenge was not cancelled:\n%s", calls)
	}
	// A bot in range comes online and accepts.
	h.fake.SetOnline(fake.OnlineBot{Name: "grumpy", Rating: 1700}, fake.OnlineBot{Name: "SlowBot", Rating: 1700})
	s = h.waitFor("accepted", func(s Status) bool { return s.Seek == nil && len(s.Games) == 1 && s.Games[0].Playing })
	if g := s.Games[0]; !strings.EqualFold(g.Opponent, "SlowBot") || !strings.Contains(s.Message, "accepted") {
		t.Fatalf("game %+v message %q", g, s.Message)
	}
	if len(s.Outgoing) != 0 {
		t.Fatalf("challenges left open: %+v", s.Outgoing)
	}
}

func TestSeekStop(t *testing.T) {
	seekAnswerTimeout, seekPause, seekRetry = 5*time.Second, 20*time.Millisecond, 200*time.Millisecond
	h := newHarness(t, Policy{})
	h.fake.Online = []fake.OnlineBot{{Name: "sleepy", Rating: 1650}}
	h.connect()
	h.bot.StartSeek(SeekParams{ChallengeParams: ChallengeParams{Limit: 60, Color: "random"}})
	h.waitFor("waiting on sleepy", func(s Status) bool { return s.Seek != nil && s.Seek.Current == "sleepy" && len(s.Outgoing) == 1 })
	h.bot.StopSeek()
	h.waitFor("cancelled", func(s Status) bool {
		return s.Seek == nil && len(s.Outgoing) == 0 && strings.Contains(strings.Join(h.fake.Calls(), " "), "/cancel")
	})
}
