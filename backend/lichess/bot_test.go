package lichess

import (
	"errors"
	"fmt"
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
	"board/backend/uci"
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
	// Every engineInfo event, in order.
	engineInfos []game.EngineInfo
	// Every ponderHit event, and how many moves the board showed then.
	ponderHits  []PonderHit
	hitsShownAt []int
	// Every random-bot run status emitted, in order.
	seeks []SeekStatus
	// Every lichessBotMove event, and how many moves Lichess had then.
	botMoves         []BotMove
	gameEnds         []BotGameEnd
	botMovesOnServer []int
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
				if sk := h.last.Seek; sk != nil {
					h.seeks = append(h.seeks, *sk)
				}
			case "engineInfo":
				h.infos++
				h.engineInfos = append(h.engineInfos, data.(game.EngineInfo))
			case "lichessBotMove":
				m := data.(BotMove)
				moves, _, _, _ := h.fake.Game(m.GameID)
				h.botMoves = append(h.botMoves, m)
				h.botMovesOnServer = append(h.botMovesOnServer, len(moves))
			case "lichessBotGameEnd":
				h.gameEnds = append(h.gameEnds, data.(BotGameEnd))
			case "ponderHit":
				h.ponderHits = append(h.ponderHits, data.(PonderHit))
				n := -1
				if len(h.shown) > 0 {
					n = len(h.shown[len(h.shown)-1].Moves)
				}
				h.hitsShownAt = append(h.hitsShownAt, n)
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

func TestPolicyGameTypes(t *testing.T) {
	ch := func(limit, inc, rating int, variant string) *Challenge {
		c := &Challenge{Variant: Variant{Key: variant}, TimeControl: TimeControl{Type: "clock", Limit: limit, Increment: inc}}
		c.Challenger.Rating = rating
		return c
	}
	base := Policy{Rated: true, Casual: true, Humans: true, Bots: true, MaxGames: 1}
	with := func(f func(*Policy)) Policy { p := base; f(&p); return p }
	onlyBlitzRapid := map[string]bool{"ultraBullet": false, "bullet": false, "classical": false}
	for _, tc := range []struct {
		name   string
		policy Policy
		ch     *Challenge
		want   string
	}{
		{"any speed", base, ch(60, 0, 1500, "standard"), ""},
		{"bullet off", with(func(p *Policy) { p.Speeds = onlyBlitzRapid }), ch(60, 0, 1500, "standard"), "tooFast"},
		{"blitz on", with(func(p *Policy) { p.Speeds = onlyBlitzRapid }), ch(180, 2, 1500, "standard"), ""},
		{"rapid on", with(func(p *Policy) { p.Speeds = onlyBlitzRapid }), ch(600, 0, 1500, "standard"), ""},
		{"classical off", with(func(p *Policy) { p.Speeds = onlyBlitzRapid }), ch(1800, 0, 1500, "standard"), "tooSlow"},
		{"a speed in the middle off", with(func(p *Policy) { p.Speeds = map[string]bool{"blitz": false} }), ch(180, 0, 1500, "standard"), "timeControl"},
		{"every speed off", with(func(p *Policy) {
			p.Speeds = map[string]bool{"ultraBullet": false, "bullet": false, "blitz": false, "rapid": false, "classical": false}
		}), ch(180, 0, 1500, "standard"), "timeControl"},
		{"increment too small", with(func(p *Policy) { p.MinIncrement = 1 }), ch(180, 0, 1500, "standard"), "timeControl"},
		{"increment too large", with(func(p *Policy) { p.MaxIncrement = 5 }), ch(180, 10, 1500, "standard"), "timeControl"},
		{"increment fits", with(func(p *Policy) { p.MinIncrement, p.MaxIncrement = 1, 5 }), ch(180, 2, 1500, "standard"), ""},
		{"rating too low", with(func(p *Policy) { p.MinRating = 1800 }), ch(180, 0, 1500, "standard"), "generic"},
		{"rating too high", with(func(p *Policy) { p.MaxRating = 2000 }), ch(180, 0, 2400, "standard"), "generic"},
		{"rating fits", with(func(p *Policy) { p.MinRating, p.MaxRating = 1400, 2000 }), ch(180, 0, 1500, "standard"), ""},
		{"rating unknown", with(func(p *Policy) { p.MinRating = 1800 }), ch(180, 0, 0, "standard"), ""},
		{"from position", base, ch(180, 0, 1500, "fromPosition"), ""},
		{"no from position", with(func(p *Policy) { p.NoFromPosition = true }), ch(180, 0, 1500, "fromPosition"), "standard"},
	} {
		b := NewBot(Hooks{})
		b.cfg.Policy = tc.policy
		if got := b.declineReason(tc.ch, true); got != tc.want {
			t.Errorf("%s: declined with %q, want %q", tc.name, got, tc.want)
		}
		if got := b.declineReason(tc.ch, false); got != "" {
			t.Errorf("%s: declined by hand with %q", tc.name, got)
		}
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

func TestConnectingAnswersNoChallengeAndTakesOverGames(t *testing.T) {
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
	// answers no challenge, even with rules that would accept, but the
	// engine takes the game back.
	h.fake.Challenge("Bob", false, false, 300, 0, "random", "standard")
	before, _, _, _ := h.fake.Game(id)
	h.connect()
	s := h.waitFor("listed", func(s Status) bool { return len(s.Games) == 1 && len(s.Incoming) == 1 })
	if s.AutoAccept {
		t.Fatalf("connecting turned automatic accepting on: %+v", s)
	}
	h.waitFor("engine plays the old game", func(s Status) bool { return s.Games[0].Playing && s.Games[0].Moves > len(before) })
	for _, c := range h.fake.Calls() {
		if strings.Contains(c, "/accept") && !strings.Contains(c, id) || strings.Contains(c, "decline") {
			t.Fatalf("answered a challenge by itself: %v", h.fake.Calls())
		}
	}

	// A game started elsewhere while connected (by another program, say)
	// is listed but not played until Play.
	other := h.fake.StartGame("Carol", true, 300, 0)
	h.waitFor("other game listed", func(s Status) bool {
		g := gameView(s, other)
		return g != nil && g.MyTurn
	})
	time.Sleep(500 * time.Millisecond)
	if moves, _, _, _ := h.fake.Game(other); len(moves) != 0 || gameView(h.bot.Status(), other).Playing {
		t.Fatalf("the engine played a game started elsewhere without Play: %v", moves)
	}
	if err := h.bot.Play(other); err != nil {
		t.Fatal(err)
	}
	h.waitFor("engine plays", func(s Status) bool { g := gameView(s, other); return g.Playing && g.Moves > 0 })
	// Turning automatic accepting on answers the waiting challenge.
	if err := h.bot.SetAutoAccept(true); err != nil {
		t.Fatal(err)
	}
	h.waitFor("auto accepted", func(s Status) bool { return len(s.Incoming) == 0 && len(s.Games) == 3 })
}

func gameView(s Status, id string) *GameView {
	for i := range s.Games {
		if s.Games[i].ID == id {
			return &s.Games[i]
		}
	}
	return nil
}

// Games in progress when Ponder connects are played by the engine from
// where they stand, and the one where it is the engine's move is shown on
// the board. A game the engine cannot play (correspondence) is left alone.
func TestConnectTakesOverGamesInProgress(t *testing.T) {
	h := newHarness(t, Policy{})
	h.fake.Delay = 400 * time.Millisecond
	theirs := h.fake.StartGame("Alice", false, 300, 2) // the bot is Black; White to move
	mine := h.fake.StartGame("Bob", true, 300, 2, "e2e4", "e7e5", "g1f3", "b8c6")
	corr := h.fake.StartGame("Carol", true, -1, 0, "d2d4", "d7d5")

	h.connect()
	h.waitFor("engine moved in the game on its move", func(s Status) bool {
		g := gameView(s, mine)
		return g != nil && g.Playing && g.Moves >= 5
	})
	h.waitFor("engine plays the other game", func(s Status) bool {
		g := gameView(s, theirs)
		return g != nil && g.Playing && g.Moves >= 2
	})
	if moves, _, _, _ := h.fake.Game(mine); len(moves) < 5 || moves[3] != "b8c6" {
		t.Fatalf("the engine did not go on from the position: %v", moves)
	}
	s := h.bot.Status()
	if g := gameView(s, corr); g == nil || g.Playing {
		t.Fatalf("a correspondence game was taken over: %+v", g)
	}
	if moves, _, _, _ := h.fake.Game(corr); len(moves) != 2 {
		t.Fatalf("the engine moved in a correspondence game: %v", moves)
	}
	if w := h.bot.Watching(); w != mine {
		t.Fatalf("the board shows %q, want the game on the engine's move %q", w, mine)
	}
	h.mu.Lock()
	shown := len(h.shown) > 0 && h.shown[len(h.shown)-1].ID == mine
	h.mu.Unlock()
	if !shown {
		t.Fatal("the game was not put on the board")
	}
	if g := gameView(s, mine); !strings.Contains(g.Message, "took over") {
		t.Errorf("no word that the game was taken over: %q", g.Message)
	}
}

// A game that starts while the connection to Lichess is lost is taken
// over when it comes back; games the engine was playing go on.
func TestReconnectTakesOverGameStartedMeanwhile(t *testing.T) {
	h := newHarness(t, Policy{})
	h.fake.Delay = 300 * time.Millisecond
	first := h.fake.StartGame("Alice", true, 300, 2)
	h.connect()
	h.waitFor("first game played", func(s Status) bool { g := gameView(s, first); return g != nil && g.Playing && g.Moves >= 1 })

	h.fake.DropStreams()
	h.waitFor("connection lost", func(s Status) bool { return s.State == "reconnecting" })
	later := h.fake.StartGame("Bob", true, 300, 2)
	h.waitFor("game started meanwhile played", func(s Status) bool {
		g := gameView(s, later)
		return s.State == "connected" && g != nil && g.Playing && g.Moves >= 1
	})
	before, _, _, _ := h.fake.Game(first)
	h.waitFor("first game goes on", func(s Status) bool { g := gameView(s, first); return g.Playing && g.Moves > len(before) })
	if n := len(h.bot.Status().Games); n != 2 {
		t.Fatalf("%d games listed, want 2", n)
	}
	// The board stays on the game it showed.
	if w := h.bot.Watching(); w != first {
		t.Errorf("the board switched to %q, want %q", w, first)
	}
}

func TestSeekChallengesRandomBotsUntilOneAccepts(t *testing.T) {
	seekAnswerTimeout, seekPause, seekRetry, seekGap = 300*time.Millisecond, 20*time.Millisecond, 200*time.Millisecond, 20*time.Millisecond
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
	seekAnswerTimeout, seekPause, seekRetry, seekGap = 5*time.Second, 20*time.Millisecond, 200*time.Millisecond, 20*time.Millisecond
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

func TestOneChallengeAtATime(t *testing.T) {
	seekAnswerTimeout, seekPause, seekRetry, seekGap = 5*time.Second, 20*time.Millisecond, 200*time.Millisecond, 20*time.Millisecond
	h := newHarness(t, Policy{})
	h.fake.Online = []fake.OnlineBot{{Name: "sleepy", Rating: 1650}}
	h.connect()
	if err := h.bot.Challenge(ChallengeParams{Username: "sleepy", Limit: 60, Color: "random"}); err != nil {
		t.Fatal(err)
	}
	s := h.waitFor("waiting on sleepy", func(s Status) bool { return len(s.Outgoing) == 1 })
	err := h.bot.Challenge(ChallengeParams{Username: "grumpy", Limit: 60, Color: "random"})
	if err == nil || !strings.Contains(err.Error(), "waiting for an answer") {
		t.Fatalf("second challenge: %v", err)
	}
	if err := h.bot.StartSeek(SeekParams{ChallengeParams: ChallengeParams{Limit: 60, Color: "random"}}); err == nil {
		t.Fatal("random-bot search started with a challenge waiting")
	}
	if strings.Contains(strings.Join(h.fake.Calls(), " "), "/api/challenge/grumpy") {
		t.Fatal("grumpy was challenged")
	}
	if err := h.bot.Cancel(s.Outgoing[0].ID); err != nil {
		t.Fatal(err)
	}
	if err := h.bot.Challenge(ChallengeParams{Username: "grumpy", Limit: 60, Color: "random"}); err != nil {
		t.Fatalf("after cancelling: %v", err)
	}
}

func TestSeekWaitsAMinuteBetweenChallenges(t *testing.T) {
	seekAnswerTimeout, seekPause, seekRetry, seekGap = 5*time.Second, 20*time.Millisecond, 200*time.Millisecond, 600*time.Millisecond
	defer func() { seekGap = time.Minute }()
	h := newHarness(t, Policy{})
	h.fake.Online = []fake.OnlineBot{{Name: "grumpy", Rating: 1700}, {Name: "picky", Rating: 1750}}
	h.connect()
	start := time.Now()
	if err := h.bot.StartSeek(SeekParams{ChallengeParams: ChallengeParams{Limit: 180, Increment: 2, Color: "random"}}); err != nil {
		t.Fatal(err)
	}
	// (A short pause after the answer counts down too; then the rest of the minute.)
	h.waitFor("waiting after the first answer", func(s Status) bool {
		return s.Seek != nil && s.Seek.Tried == 1 && s.Seek.Phase == "pause" && time.Until(time.UnixMilli(s.Seek.NextAt)) > 300*time.Millisecond
	})
	if err := h.bot.Challenge(ChallengeParams{Username: "x", Limit: 60}); err == nil {
		t.Fatal("manual challenge allowed during the search")
	}
	h.waitFor("second challenge", func(s Status) bool { return s.Seek != nil && s.Seek.Tried == 2 })
	if d := time.Since(start); d < 600*time.Millisecond {
		t.Fatalf("second challenge after %v", d)
	}
}

// declines counts the challenges declined with a reason so far.
func (h *harness) declines(reason string) int {
	return strings.Count(strings.Join(h.fake.Calls(), "\n")+"\n", "decline-reason "+reason+"\n")
}

func (h *harness) waitDeclines(reason string, n int) {
	h.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for h.declines(reason) < n {
		if time.Now().After(deadline) {
			h.t.Fatalf("%d challenges declined with %q, want %d: %v", h.declines(reason), reason, n, h.fake.Calls())
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func activeGames(s Status) int {
	n := 0
	for _, g := range s.Games {
		if !g.Finished {
			n++
		}
	}
	return n
}

// Challenges that arrive together do not all get in: one accepted, whose
// game has not started yet, already takes its place under the limit.
func TestGameLimitWithChallengesAtOnce(t *testing.T) {
	h := newHarness(t, Policy{Casual: true, Humans: true, Bots: true, MaxGames: 1})
	h.connect()
	if err := h.bot.SetAutoAccept(true); err != nil {
		t.Fatal(err)
	}
	h.waitListening()
	for _, from := range []string{"Alice", "Bob", "Carol"} {
		h.fake.Challenge(from, false, false, 120, 1, "white", "standard")
	}
	h.waitDeclines("later", 2)
	s := h.waitFor("the game", func(s Status) bool { return len(s.Games) >= 1 })
	time.Sleep(300 * time.Millisecond)
	if s = h.bot.Status(); len(s.Games) != 1 || activeGames(s) != 1 {
		t.Fatalf("games %+v", s.Games)
	}
}

// With two games at once allowed, the third of three is declined.
func TestGameLimitOfTwo(t *testing.T) {
	h := newHarness(t, Policy{Casual: true, Humans: true, Bots: true, MaxGames: 2})
	h.connect()
	if err := h.bot.SetAutoAccept(true); err != nil {
		t.Fatal(err)
	}
	h.waitListening()
	for _, from := range []string{"Alice", "Bob", "Carol"} {
		h.fake.Challenge(from, true, false, 120, 1, "white", "standard")
	}
	h.waitDeclines("later", 1)
	h.waitFor("two games", func(s Status) bool { return activeGames(s) == 2 })
	time.Sleep(300 * time.Millisecond)
	if s := h.bot.Status(); len(s.Games) != 2 || h.declines("later") != 1 {
		t.Fatalf("games %+v, %d declined", s.Games, h.declines("later"))
	}
}

// Challenges waiting when automatic accepting is turned on are held to the
// limit too.
func TestGameLimitWhenTurningAutoAcceptOn(t *testing.T) {
	h := newHarness(t, Policy{Casual: true, Humans: true, MaxGames: 1})
	h.connect()
	h.waitListening()
	h.fake.Challenge("Alice", false, false, 120, 1, "white", "standard")
	h.fake.Challenge("Bob", false, false, 120, 1, "white", "standard")
	h.waitFor("two challenges", func(s Status) bool { return len(s.Incoming) == 2 })
	if err := h.bot.SetAutoAccept(true); err != nil {
		t.Fatal(err)
	}
	h.waitDeclines("later", 1)
	h.waitFor("the game", func(s Status) bool { return activeGames(s) == 1 })
	time.Sleep(300 * time.Millisecond)
	if s := h.bot.Status(); len(s.Games) != 1 || len(s.Incoming) != 0 {
		t.Fatalf("status %+v", s)
	}
}

// A challenge the engine sent to another bot holds a place while it waits
// for the answer: accepted, it is a game.
func TestGameLimitCountsOwnChallenge(t *testing.T) {
	h := newHarness(t, Policy{Casual: true, Humans: true, Bots: true, MaxGames: 1})
	h.connect()
	if err := h.bot.SetAutoAccept(true); err != nil {
		t.Fatal(err)
	}
	h.waitListening()
	// sleepy never answers.
	if err := h.bot.Challenge(ChallengeParams{Username: "sleepy", Limit: 120, Increment: 1, Color: "white"}); err != nil {
		t.Fatal(err)
	}
	s := h.waitFor("the challenge to sleepy", func(s Status) bool { return len(s.Outgoing) == 1 })
	h.fake.Challenge("Robot", true, false, 120, 1, "white", "standard")
	h.waitDeclines("later", 1)
	if s = h.bot.Status(); len(s.Games) != 0 {
		t.Fatalf("games %+v", s.Games)
	}
	// Once it is cancelled, the place is free again.
	if err := h.bot.Cancel(s.Outgoing[0].ID); err != nil {
		t.Fatal(err)
	}
	h.waitFor("the cancellation", func(s Status) bool { return len(s.Outgoing) == 0 })
	h.fake.Challenge("Robot", true, false, 120, 1, "white", "standard")
	h.waitFor("the game", func(s Status) bool { return activeGames(s) == 1 })
}

// The moves for the arrows: the engine's line while it thinks, then the
// move it chose with the reply it expects.
func TestEngineArrowMoves(t *testing.T) {
	b := NewBot(Hooks{})
	r := newRunner(b, "g1", &GameInfo{Color: "white"})
	r.thinking = 0
	line := uci.Info{Depth: 9, HasScore: true, ScoreCP: 30, PV: []string{"e2e4", "e7e5", "g1f3"}}

	b.mu.Lock()
	out := r.infoLocked(line)
	b.mu.Unlock()
	if out.Best != "e2e4" || out.Ponder != "e7e5" || out.Played || strings.Join(out.PV, " ") != "e4 e5 Nf3" {
		t.Fatalf("while thinking: %+v", out)
	}

	r.onInfo(line) // remembered though the game is not on the board
	// The engine names its own reply: that one counts.
	r.onPonder("c7c5")
	b.mu.Lock()
	out, ok := r.chosenLocked("e2e4")
	b.mu.Unlock()
	if !ok || !out.Played || out.Best != "e2e4" || out.Ponder != "c7c5" || out.Depth != 9 {
		t.Fatalf("chosen with a ponder move: %+v", out)
	}
	// Without one, the next move of its line.
	r.onPonder("")
	b.mu.Lock()
	out, _ = r.chosenLocked("e2e4")
	b.mu.Unlock()
	if out.Ponder != "e7e5" {
		t.Fatalf("chosen without a ponder move: %+v", out)
	}
	// A move other than its line's: no reply is guessed.
	b.mu.Lock()
	out, _ = r.chosenLocked("d2d4")
	b.mu.Unlock()
	if out.Best != "d2d4" || out.Ponder != "" || strings.Join(out.PV, " ") != "d4" {
		t.Fatalf("chosen off its line: %+v", out)
	}
	// An illegal ponder move is dropped, an illegal move reports nothing.
	r.onPonder("e2e5")
	b.mu.Lock()
	out, _ = r.chosenLocked("d2d4")
	_, bad := r.chosenLocked("e2e5")
	b.mu.Unlock()
	if out.Ponder != "" || bad {
		t.Fatalf("illegal moves: %+v %v", out, bad)
	}
}

// A game put on the board after it began brings the engine's score for
// every move it has played, not only for the moves watched live.
func TestWatchBringsTheScoresSoFar(t *testing.T) {
	h := newHarness(t, Policy{Casual: true, Humans: true, MaxGames: 1})
	h.fake.MaxPlies = 300
	h.connect()
	if err := h.bot.SetAutoAccept(true); err != nil {
		t.Fatal(err)
	}
	h.waitListening()
	id := h.fake.Challenge("Alice", false, false, 120, 1, "black", "standard") // the engine is White
	h.waitFor("game start", func(s Status) bool { return len(s.Games) == 1 })
	h.bot.Unwatch()
	h.waitFor("a few moves", func(s Status) bool { return s.Games[0].Moves >= 7 || s.Games[0].Finished })
	h.mu.Lock()
	h.engineInfos = nil
	h.mu.Unlock()
	if err := h.bot.Watch(id); err != nil {
		t.Fatal(err)
	}
	moves, _, _, _ := h.fake.Game(id)
	h.mu.Lock()
	got := append([]game.EngineInfo(nil), h.engineInfos...)
	h.mu.Unlock()
	// One for each move the engine had played when the game was shown, in
	// order: plies 0, 2, 4, …
	played := 0
	for i, in := range got {
		if !in.Played {
			continue // the move it is thinking about now, or a live line
		}
		if in.Ply != 2*i || in.Side != "white" || !in.HasEval || in.Depth == 0 || in.Ply >= len(moves) || in.Best != moves[in.Ply] {
			t.Fatalf("score %d is %+v; the moves are %v", i, in, moves)
		}
		played++
	}
	if played < 3 {
		t.Fatalf("%d scores came with the game, for moves %v: %+v", played, moves, got)
	}
}

// A challenge sent is withdrawn when it has had no answer for the time set.
func TestSentChallengeExpires(t *testing.T) {
	h := newHarness(t, Policy{Casual: true, Humans: true, MaxGames: 1})
	h.cfg.ChallengeTimeout = 1
	h.connect()
	h.waitListening()
	if err := h.bot.Challenge(ChallengeParams{Username: "sleepy", Limit: 60, Color: "random"}); err != nil {
		t.Fatal(err)
	}
	s := h.bot.Status()
	if len(s.Outgoing) != 1 || s.Outgoing[0].ExpiresAt == 0 {
		t.Fatalf("outgoing %+v", s.Outgoing)
	}
	s = h.waitFor("the challenge to be withdrawn", func(s Status) bool { return len(s.Outgoing) == 0 && s.Message != "" })
	if !strings.Contains(s.Message, "did not answer in 1 s") {
		t.Errorf("message %q", s.Message)
	}
	// And another can go out.
	if err := h.bot.Challenge(ChallengeParams{Username: "sleepy", Limit: 60, Color: "random"}); err != nil {
		t.Fatal(err)
	}
}

// With several games asked for, the search challenges another bot after each
// game ends, never while one is being played, and stops at the number set.
func TestSeekPlaysGamesOneAfterAnother(t *testing.T) {
	seekAnswerTimeout, seekPause, seekRetry, seekGap, seekPoll = 2*time.Second, 20*time.Millisecond, 100*time.Millisecond, 20*time.Millisecond, 20*time.Millisecond
	h := newHarness(t, Policy{})
	h.fake.MaxPlies = 8 // short games
	h.fake.Online = []fake.OnlineBot{{Name: "SlowBot", Rating: 1700}, {Name: "FastBot", Rating: 1710}, {Name: "OtherBot", Rating: 1720}}
	h.connect()
	err := h.bot.StartSeek(SeekParams{ChallengeParams: ChallengeParams{Limit: 180, Increment: 2, Color: "random"}, Games: 3})
	if err != nil {
		t.Fatal(err)
	}
	// Watch every status: a challenge must never be out while a game is on.
	overlap := ""
	seen := 0
	s := h.waitFor("three games played", func(s Status) bool {
		live := 0
		for _, g := range s.Games {
			if !g.Finished {
				live++
			}
		}
		if live > 1 || (live > 0 && len(s.Outgoing) > 0) {
			overlap = fmt.Sprintf("%d games in progress with %d challenges out", live, len(s.Outgoing))
		}
		if s.Seek != nil && s.Seek.Played > seen {
			seen = s.Seek.Played
			if s.Seek.Games != 3 {
				overlap = fmt.Sprintf("the search says %d games, want 3", s.Seek.Games)
			}
		}
		done := 0
		for _, g := range s.Games {
			if g.Finished {
				done++
			}
		}
		return s.Seek == nil && done == 3
	})
	if overlap != "" {
		t.Error(overlap)
	}
	if seen != 2 {
		t.Errorf("the search counted %d games before its last, want 2", seen)
	}
	if len(s.Games) != 3 || len(s.Outgoing) != 0 {
		t.Errorf("%d games, %d challenges out", len(s.Games), len(s.Outgoing))
	}
	// No fourth challenge.
	time.Sleep(300 * time.Millisecond)
	if n := strings.Count(strings.Join(h.fake.Calls(), "\n"), "POST /api/challenge/"); n != 3 {
		t.Errorf("%d challenges sent, want 3:\n%s", n, strings.Join(h.fake.Calls(), "\n"))
	}
}

// Two games at once: each is listed with its position, for the small
// boards; one is on the board and Watch puts the other there.
func TestTwoGamesListedWithPositions(t *testing.T) {
	h := newHarness(t, Policy{Casual: true, Humans: true, MaxGames: 2})
	h.fake.Delay = 30 * time.Millisecond
	h.connect()
	if err := h.bot.SetAutoAccept(true); err != nil {
		t.Fatal(err)
	}
	h.waitListening()
	h.fake.Challenge("Alice", false, false, 120, 1, "black", "standard")
	h.fake.Challenge("Bob", false, false, 120, 1, "white", "standard")
	s := h.waitFor("two games under way", func(s Status) bool {
		if len(s.Games) != 2 {
			return false
		}
		for _, g := range s.Games {
			if g.Finished || g.Moves < 2 || g.Fen == "" || g.LastMove == "" {
				return false
			}
		}
		return true
	})
	for _, g := range s.Games {
		if f := strings.Fields(g.Fen); len(f) != 6 || strings.HasPrefix(g.Fen, "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w") {
			t.Fatalf("game %s: position %q", g.ID, g.Fen)
		}
	}
	other := s.Games[0].ID
	if other == s.Watching {
		other = s.Games[1].ID
	}
	if s.Watching == "" || other == s.Watching {
		t.Fatalf("watching %q of %+v", s.Watching, s.Games)
	}
	if err := h.bot.Watch(other); err != nil {
		t.Fatal(err)
	}
	h.waitFor("the other game on the board", func(s Status) bool { return s.Watching == other })
	h.mu.Lock()
	last := h.shown[len(h.shown)-1]
	h.mu.Unlock()
	if last.ID != other {
		t.Fatalf("the board shows %s, want %s", last.ID, other)
	}
}

// With room for two games at once the search does not wait for a game to
// end: it challenges again while one is being played, and holds back only
// when two are.
func TestSeekChallengesUpToTheGamesAtOnce(t *testing.T) {
	seekAnswerTimeout, seekPause, seekRetry, seekGap, seekPoll = 2*time.Second, 20*time.Millisecond, 100*time.Millisecond, 20*time.Millisecond, 20*time.Millisecond
	h := newHarness(t, Policy{MaxGames: 2})
	h.fake.MaxPlies = 16
	h.fake.Delay = 20 * time.Millisecond
	h.fake.Online = []fake.OnlineBot{{Name: "SlowBot", Rating: 1700}, {Name: "FastBot", Rating: 1710}, {Name: "OtherBot", Rating: 1720}}
	h.connect()
	// A game in progress does not stop the search from starting.
	err := h.bot.StartSeek(SeekParams{ChallengeParams: ChallengeParams{Limit: 180, Increment: 2, Color: "random"}, Games: 3})
	if err != nil {
		t.Fatal(err)
	}
	wrong := ""
	most := 0
	challengedWhilePlaying := false
	s := h.waitFor("three games played", func(s Status) bool {
		live, done := 0, 0
		for _, g := range s.Games {
			if g.Finished {
				done++
			} else {
				live++
			}
		}
		most = max(most, live)
		if live > 2 || (live == 2 && len(s.Outgoing) > 0) {
			wrong = fmt.Sprintf("%d games in progress with %d challenges out", live, len(s.Outgoing))
		}
		if live == 1 && len(s.Outgoing) > 0 {
			challengedWhilePlaying = true
		}
		return s.Seek == nil && done == 3
	})
	if wrong != "" {
		t.Error(wrong)
	}
	if most != 2 || !challengedWhilePlaying {
		t.Errorf("at most %d games at once (want 2); challenged while playing: %v", most, challengedWhilePlaying)
	}
	if len(s.Games) != 3 {
		t.Errorf("%d games", len(s.Games))
	}
	time.Sleep(300 * time.Millisecond)
	if n := strings.Count(strings.Join(h.fake.Calls(), "\n"), "POST /api/challenge/"); n != 3 {
		t.Errorf("%d challenges sent, want 3", n)
	}
}

// The engine of a game in progress is started again, and goes on playing
// from where the game is.
func TestReloadEngineMidGame(t *testing.T) {
	h := newHarness(t, Policy{})
	h.fake.MaxPlies = 200
	h.connect()
	id := h.fake.Challenge("Alice", false, false, 600, 0, "random", "standard")
	h.waitFor("incoming challenge", func(s Status) bool { return len(s.Incoming) == 1 })
	if err := h.bot.Accept(id); err != nil {
		t.Fatal(err)
	}
	s := h.waitFor("a few moves", func(s Status) bool { return len(s.Games) == 1 && s.Games[0].Moves >= 4 })
	at := s.Games[0].Moves
	h.bot.mu.Lock()
	before := h.bot.games[id].eng
	h.bot.mu.Unlock()
	if err := h.bot.ReloadEngine(id, nil); err != nil {
		t.Fatal(err)
	}
	h.bot.mu.Lock()
	after := h.bot.games[id].eng
	h.bot.mu.Unlock()
	if after == nil || after == before {
		t.Fatal("the engine was not started again")
	}
	h.waitFor("more moves after the reload", func(s Status) bool {
		return len(s.Games) == 1 && (s.Games[0].Moves >= at+4 || s.Games[0].Finished)
	})
	if err := h.bot.ReloadEngine("nope", nil); err == nil {
		t.Fatal("reloaded a game that is not there")
	}
}

// A challenge that cannot be answered stays until dismissed, and Dismiss
// takes it off without asking Lichess; one Lichess no longer has (404) is
// taken off by the answer itself.
func TestChallengeThatCannotBeAnsweredCanBeDismissed(t *testing.T) {
	h := newHarness(t, Policy{Casual: true, Humans: true, Bots: true, MaxGames: 1})
	h.connect()
	id := h.fake.Challenge("Alice", false, false, 300, 0, "white", "standard")
	h.waitFor("challenge", func(s Status) bool { return len(s.Incoming) == 1 })
	// Lichess fails: the challenge stays, with the error said.
	h.fake.FailNextAnswers(2)
	if err := h.bot.Accept(id); err == nil {
		t.Fatal("accept went through")
	}
	if err := h.bot.Decline(id, "generic"); err == nil {
		t.Fatal("decline went through")
	}
	if s := h.bot.Status(); len(s.Incoming) != 1 {
		t.Fatalf("incoming %+v", s.Incoming)
	}
	calls := len(h.fake.Calls())
	h.bot.Dismiss(id)
	h.waitFor("dismissed", func(s Status) bool { return len(s.Incoming) == 0 })
	if len(h.fake.Calls()) != calls {
		t.Fatalf("dismissing asked Lichess: %v", h.fake.Calls()[calls:])
	}

	// Gone from Lichess without a word: answering it takes it off.
	for _, accept := range []bool{true, false} {
		id = h.fake.Challenge("Bob", false, false, 300, 0, "white", "standard")
		h.waitFor("challenge", func(s Status) bool { return len(s.Incoming) == 1 })
		h.fake.Forget(id)
		var err error
		if accept {
			err = h.bot.Accept(id)
		} else {
			err = h.bot.Decline(id, "generic")
		}
		if !errors.Is(err, errChallengeGone) {
			t.Fatalf("accept %v: %v", accept, err)
		}
		if s := h.bot.Status(); len(s.Incoming) != 0 {
			t.Fatalf("accept %v: still listed %+v", accept, s.Incoming)
		}
	}
}

// An aborted game is over: the next challenge goes out, by the random-bot
// search and by hand, however the game was aborted.
func TestAbortedGameLetsTheNextChallengeGo(t *testing.T) {
	for _, tc := range []struct {
		name, color, how string
		end              func(h *harness, id string)
	}{
		{"engine aborts before any move", "black", "", func(h *harness, id string) {
			if err := h.bot.Abort(id); err != nil {
				h.t.Fatal(err)
			}
		}},
		{"engine aborts after its first move", "white", "", func(h *harness, id string) {
			h.waitFor("first move", func(s Status) bool { g := gameView(s, id); return g != nil && g.Moves == 1 })
			if err := h.bot.Abort(id); err != nil {
				h.t.Fatal(err)
			}
		}},
		{"opponent aborts", "white", "", func(h *harness, id string) { h.fake.EndGame(id, "aborted", "") }},
		{"Lichess aborts a game nobody moved in", "black", "", func(h *harness, id string) { h.fake.EndGame(id, "noStart", "") }},
		{"game stream closes and the game is gone", "black", "gone", func(h *harness, id string) { h.fake.EndGame(id, "aborted", "gone") }},
		{"only the event stream says it ended", "black", "silent", func(h *harness, id string) { h.fake.EndGame(id, "aborted", "silent") }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			seekAnswerTimeout, seekPause, seekRetry, seekGap, seekPoll = 2*time.Second, 20*time.Millisecond, 100*time.Millisecond, 20*time.Millisecond, 20*time.Millisecond
			finishGrace = 200 * time.Millisecond
			h := newHarness(t, Policy{})
			h.fake.Still = true // the opponent never moves
			h.fake.Online = []fake.OnlineBot{{Name: "SlowBot", Rating: 1700}, {Name: "FastBot", Rating: 1710}}
			h.connect()
			if err := h.bot.StartSeek(SeekParams{ChallengeParams: ChallengeParams{Limit: 180, Increment: 2, Color: tc.color}, Games: 2}); err != nil {
				t.Fatal(err)
			}
			s := h.waitFor("first game", func(s Status) bool { return len(s.Games) == 1 })
			id := s.Games[0].ID
			tc.end(h, id)
			h.waitFor("game over", func(s Status) bool { g := gameView(s, id); return g != nil && g.Finished })
			h.waitFor("second game", func(s Status) bool { return len(s.Games) == 2 })
			if n := strings.Count(strings.Join(h.fake.Calls(), "\n"), "POST /api/challenge/"); n != 2 {
				t.Errorf("%d challenges sent, want 2", n)
			}
			// That game aborted too, a challenge by hand goes out.
			second := ""
			for _, g := range h.bot.Status().Games {
				if g.ID != id {
					second = g.ID
				}
			}
			h.fake.EndGame(second, "aborted", tc.how)
			h.waitFor("second game over", func(s Status) bool { g := gameView(s, second); return g != nil && g.Finished })
			h.waitFor("search done", func(s Status) bool { return s.Seek == nil })
			if err := h.bot.Challenge(ChallengeParams{Username: "SlowBot", Limit: 180, Increment: 2, Color: "random"}); err != nil {
				t.Fatalf("challenge by hand after an aborted game: %v", err)
			}
		})
	}
}

// A game taken over on connecting that is then aborted (its stream closing
// and the game gone) no longer holds back a challenge.
func TestTakenOverGameAbortedLetsChallengesGo(t *testing.T) {
	finishGrace = 200 * time.Millisecond
	h := newHarness(t, Policy{})
	h.fake.Still = true
	id := h.fake.StartGame("Alice", false, 300, 2)
	h.connect()
	h.waitFor("taken over", func(s Status) bool { g := gameView(s, id); return g != nil && g.Playing })
	if err := h.bot.Challenge(ChallengeParams{Username: "Bob", Limit: 180, Increment: 2, Color: "random"}); err == nil {
		t.Fatal("a challenge went out while the engine played")
	}
	h.fake.EndGame(id, "aborted", "gone")
	h.waitFor("game over", func(s Status) bool { g := gameView(s, id); return g.Finished })
	if err := h.bot.Challenge(ChallengeParams{Username: "Bob", Limit: 180, Increment: 2, Color: "random"}); err != nil {
		t.Fatalf("challenge after the aborted game: %v", err)
	}
}

// When a game the engine played ends, the app is told how (for the
// engine's last chat message): its result from the engine's side, the
// reason, the moves and what the engine thought at each of its moves.
func TestGameEndIsToldForTheEngineChat(t *testing.T) {
	h := newHarness(t, Policy{})
	h.fake.MaxPlies = 12 // a draw after 12 plies
	id := h.fake.StartGame("Alice", true, 300, 2)
	h.connect()
	h.waitFor("game over", func(s Status) bool { g := gameView(s, id); return g != nil && g.Finished })
	deadline := time.Now().Add(5 * time.Second)
	var ends []BotGameEnd
	for time.Now().Before(deadline) {
		h.mu.Lock()
		ends = append([]BotGameEnd(nil), h.gameEnds...)
		h.mu.Unlock()
		if len(ends) > 0 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if len(ends) != 1 {
		t.Fatalf("%d game ends told, want 1", len(ends))
	}
	e := ends[0]
	moves, _, _, _ := h.fake.Game(id)
	if e.GameID != id || e.Outcome != "drawn" || e.Result != "1/2-1/2" || e.Reason != "Draw" || e.Status != "draw" ||
		e.Side != "white" || e.Opponent != "Alice" || len(e.Moves) != len(moves) || e.FEN == "" {
		t.Fatalf("game end %+v; %d moves on Lichess", e, len(moves))
	}
	// The engine's evaluations, at its own moves (White's: even plies).
	if len(e.Evals) == 0 {
		t.Fatal("no evaluations")
	}
	for _, ev := range e.Evals {
		if ev.Ply%2 != 0 || ev.Move != e.Moves[ev.Ply] {
			t.Fatalf("evaluation %+v is not at one of the engine's moves %v", ev, e.Moves)
		}
	}

	// A game the engine loses (here it is told White resigned), and an
	// aborted game: lost, and nothing told.
	lost := h.fake.StartGame("Bob", true, 300, 2)
	h.waitFor("listed", func(s Status) bool { return gameView(s, lost) != nil })
	if err := h.bot.Play(lost); err != nil {
		t.Fatal(err)
	}
	h.fake.Resign(lost, "white")
	h.waitFor("lost", func(s Status) bool { g := gameView(s, lost); return g != nil && g.Finished })
	gone := h.fake.StartGame("Carol", false, 300, 2)
	h.waitFor("listed", func(s Status) bool { return gameView(s, gone) != nil })
	if err := h.bot.Play(gone); err != nil {
		t.Fatal(err)
	}
	h.fake.EndGame(gone, "aborted", "")
	h.waitFor("aborted", func(s Status) bool { g := gameView(s, gone); return g != nil && g.Finished })
	time.Sleep(200 * time.Millisecond)
	h.mu.Lock()
	ends = append([]BotGameEnd(nil), h.gameEnds...)
	h.mu.Unlock()
	if len(ends) != 2 || ends[1].GameID != lost || ends[1].Outcome != "lost" || ends[1].Result != "0-1" {
		t.Fatalf("game ends %+v", ends)
	}
}
