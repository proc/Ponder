package lichess

import (
	"encoding/json"
	"net/http"
	"regexp"
	"strings"
	"testing"
	"time"

	"board/backend/lichess/fake"
)

func TestSeekFits(t *testing.T) {
	var u User
	json.Unmarshal([]byte(`{"id":"somebot","username":"SomeBot","perfs":{"blitz":{"rating":1800,"games":12,"prov":true},"rapid":{"rating":1900,"games":400}}}`), &u)
	cases := []struct {
		name  string
		p     SeekParams
		speed string
		want  bool
	}{
		{"no settings", SeekParams{}, "blitz", true},
		{"in range", SeekParams{}, "rapid", true},
		{"excluded, any case", SeekParams{}, "rapid", false},
		{"provisional", SeekParams{NoProvisional: true}, "blitz", false},
		{"established", SeekParams{NoProvisional: true}, "rapid", true},
		{"too few games", SeekParams{MinGames: 50}, "blitz", false},
		{"enough games", SeekParams{MinGames: 50}, "rapid", true},
	}
	for _, c := range cases {
		ex := map[string]bool{}
		if strings.HasPrefix(c.name, "excluded") {
			ex["somebot"] = true
		}
		if got := c.p.fits(u, c.speed, 0, 0, ex); got != c.want {
			t.Errorf("%s: fits %v, want %v", c.name, got, c.want)
		}
	}
	if (SeekParams{}).fits(u, "rapid", 1950, 0, nil) {
		t.Error("a bot below the range fits")
	}
}

func TestSeekExcludesAndRangesAroundOwnRating(t *testing.T) {
	seekAnswerTimeout, seekPause, seekRetry, seekGap = 300*time.Millisecond, 20*time.Millisecond, 200*time.Millisecond, 20*time.Millisecond
	h := newHarness(t, Policy{})
	h.fake.Online = []fake.OnlineBot{{Name: "SlowBot", Rating: 1700}, {Name: "maia1", Rating: 1710}}
	h.connect()
	// Every rating is around ours with a range this wide: only the
	// exclusion keeps SlowBot out.
	err := h.bot.StartSeek(SeekParams{ChallengeParams: ChallengeParams{Limit: 180, Increment: 2, Color: "random"},
		Around: 3000, Exclude: []string{" SLOWBOT "}})
	if err != nil {
		t.Fatal(err)
	}
	s := h.waitFor("a game", func(s Status) bool { return s.Seek == nil && len(s.Games) == 1 })
	if !strings.EqualFold(s.Games[0].Opponent, "maia1") {
		t.Fatalf("played %q", s.Games[0].Opponent)
	}
	calls := strings.Join(h.fake.Calls(), "\n")
	if strings.Contains(strings.ToLower(calls), "challenge/slowbot") {
		t.Fatalf("challenged an excluded bot:\n%s", calls)
	}
	if err := h.bot.StartSeek(SeekParams{Around: -5}); err == nil {
		t.Fatal("a range below 0 was accepted")
	}
}

// Auto challenge runs on: a new rating range, around your bot's rating,
// is taken by the search that is running, without starting it again.
func TestSeekUpdateTakesNewRange(t *testing.T) {
	seekAnswerTimeout, seekPause, seekRetry, seekGap = 300*time.Millisecond, 20*time.Millisecond, 200*time.Millisecond, 20*time.Millisecond
	h := newHarness(t, Policy{})
	h.fake.Online = []fake.OnlineBot{{Name: "maia1", Rating: 1710}}
	h.connect()
	if ok, err := h.bot.UpdateSeek(SeekParams{Around: 100}); ok || err != nil {
		t.Fatalf("updated a search that is not running: %v %v", ok, err)
	}
	cp := ChallengeParams{Limit: 180, Increment: 2, Color: "random"}
	if err := h.bot.StartSeek(SeekParams{ChallengeParams: cp, MinRating: 2500, MaxRating: 3000, Games: -1}); err != nil {
		t.Fatal(err)
	}
	h.waitFor("no bot fits", func(s Status) bool { return s.Seek != nil && strings.Contains(s.Seek.Message, "No bot online fits") })
	if ok, err := h.bot.UpdateSeek(SeekParams{ChallengeParams: cp, Around: 3000}); !ok || err != nil {
		t.Fatalf("update: %v %v", ok, err)
	}
	s := h.waitFor("a game", func(s Status) bool { return len(s.Games) == 1 })
	if !strings.EqualFold(s.Games[0].Opponent, "maia1") {
		t.Fatalf("played %q", s.Games[0].Opponent)
	}
	if s.Seek == nil || s.Seek.Games != 0 {
		t.Fatalf("the search without end stopped or changed its games: %+v", s.Seek)
	}
	if _, err := h.bot.UpdateSeek(SeekParams{Around: -1}); err == nil {
		t.Fatal("a range below 0 was accepted")
	}
	h.bot.StopSeek()
}

// Random challenge types, as lichess-bot's matchmaking does them: every
// pairing of the times and increments, rated or casual at random.
func TestSeekRandomTypes(t *testing.T) {
	p := SeekParams{ChallengeParams: ChallengeParams{Limit: 180, Increment: 2}, Times: []int{60, 600, 60}, Increments: []int{0, 5}}
	got := map[string]bool{}
	for _, c := range p.clocks() {
		got[clockText(c.limit, c.inc)+" "+c.speed] = true
	}
	want := []string{"1+0 bullet", "1+5 blitz", "10+0 rapid", "10+5 rapid"}
	if len(got) != len(want) {
		t.Fatalf("clocks %v", got)
	}
	for _, w := range want {
		if !got[w] {
			t.Fatalf("clocks %v lack %s", got, w)
		}
	}
	if s := p.speeds(); s != "bullet/blitz/rapid" {
		t.Fatalf("speeds %q", s)
	}
	if c := (SeekParams{ChallengeParams: ChallengeParams{Limit: 180, Increment: 2}}).clocks(); len(c) != 1 || c[0].speed != "blitz" {
		t.Fatalf("one clock: %+v", c)
	}
	rated := map[bool]int{}
	for i := 0; i < 200; i++ {
		rated[SeekParams{RatedMode: "random"}.rated()]++
	}
	if rated[true] == 0 || rated[false] == 0 {
		t.Fatalf("random rated mode: %v", rated)
	}
	if (SeekParams{ChallengeParams: ChallengeParams{Rated: true}, RatedMode: "casual"}).rated() || !(SeekParams{ChallengeParams: ChallengeParams{Rated: true}}).rated() {
		t.Fatal("rated mode")
	}
	for _, bad := range []SeekParams{{Times: []int{0}}, {Increments: []int{-1}}, {RatedMode: "sometimes"}} {
		if bad.check() == nil {
			t.Errorf("accepted %+v", bad)
		}
	}
	if clockText(30, 0) != "½+0" || clockText(90, 1) != "1.5+1" {
		t.Fatal("clock text")
	}
}

// With a random clock, a challenge goes out at a time control some bot in
// range is rated at: here only the rapid ones.
func TestSeekRandomClockPicksOneThatFits(t *testing.T) {
	seekAnswerTimeout, seekPause, seekRetry, seekGap = 300*time.Millisecond, 20*time.Millisecond, 200*time.Millisecond, 20*time.Millisecond
	h := newHarness(t, Policy{})
	// The fake rates a bot 100 below at bullet, 100 above at rapid.
	h.fake.Online = []fake.OnlineBot{{Name: "sleepy", Rating: 1700}}
	h.connect()
	err := h.bot.StartSeek(SeekParams{ChallengeParams: ChallengeParams{Color: "random"},
		Times: []int{60, 600}, Increments: []int{0, 5}, RatedMode: "random", MinRating: 1760, MaxRating: 1850, Games: -1})
	if err != nil {
		t.Fatal(err)
	}
	s := h.waitFor("a challenge", func(s Status) bool { return s.Seek != nil && strings.Contains(s.Seek.Message, "Challenging") })
	if !strings.Contains(s.Seek.Message, "to 10+") || !strings.Contains(s.Seek.Message, "rapid") || s.Seek.Speed != "rapid" || s.Seek.Rating != 1800 {
		t.Fatalf("seek %+v", s.Seek)
	}
	h.bot.StopSeek()
}

// Lichess refuses a challenge for too many requests: the challenger sends
// none until the time it gave is up, even when stopped and started again
// (as Auto challenge does on reconnecting).
func TestSeekHoldsAfterRateLimit(t *testing.T) {
	seekAnswerTimeout, seekPause, seekRetry, seekGap = 300*time.Millisecond, 20*time.Millisecond, 200*time.Millisecond, 20*time.Millisecond
	h := newHarness(t, Policy{})
	h.fake.Online = []fake.OnlineBot{{Name: "maia1", Rating: 1500}}
	h.fake.RateLimited, h.fake.RateLimitSeconds = 1, 1.5
	h.connect()
	cp := ChallengeParams{Limit: 180, Increment: 2, Color: "random"}
	start := time.Now()
	if err := h.bot.StartSeek(SeekParams{ChallengeParams: cp}); err != nil {
		t.Fatal(err)
	}
	s := h.waitFor("held", func(s Status) bool {
		return s.Seek != nil && s.Seek.Phase == "limited" && strings.Contains(s.Seek.Message, "too many requests")
	})
	if s.Seek.NextAt == 0 || time.Until(time.UnixMilli(s.Seek.NextAt)) < time.Second {
		t.Fatalf("hold %+v", s.Seek)
	}
	// Stopped and started again: still held.
	h.bot.StopSeek()
	if err := h.bot.StartSeek(SeekParams{ChallengeParams: cp}); err != nil {
		t.Fatal(err)
	}
	h.waitFor("still held", func(s Status) bool { return s.Seek != nil && strings.Contains(s.Seek.Message, "too many requests") })
	h.waitFor("a game", func(s Status) bool { return len(s.Games) == 1 })
	if d := time.Since(start); d < 1400*time.Millisecond {
		t.Fatalf("challenged again after %v, before the 1.5 s Lichess gave", d)
	}
	if n := strings.Count(strings.Join(h.fake.Calls(), "\n"), "POST /api/challenge/maia1"); n != 2 {
		t.Fatalf("%d challenges sent, want the refused one and one after the wait", n)
	}
}

// A bare "too many requests" waits a minute, then two, ... up to ten, as
// lichess-bot does; a challenge that goes through starts it over.
func TestSeekBacksOffWithoutRetryTime(t *testing.T) {
	seekAnswerTimeout, seekPause, seekRetry, seekGap = 300*time.Millisecond, 20*time.Millisecond, 200*time.Millisecond, 20*time.Millisecond
	defer func(d time.Duration) { seekHoldFirst = d }(seekHoldFirst)
	seekHoldFirst = 150 * time.Millisecond
	h := newHarness(t, Policy{})
	h.fake.Online = []fake.OnlineBot{{Name: "maia1", Rating: 1500}}
	h.fake.RateLimited = 2
	h.connect()
	start := time.Now()
	if err := h.bot.StartSeek(SeekParams{ChallengeParams: ChallengeParams{Limit: 180, Increment: 2, Color: "random"}}); err != nil {
		t.Fatal(err)
	}
	h.waitFor("a game", func(s Status) bool { return len(s.Games) == 1 })
	if d := time.Since(start); d < 450*time.Millisecond {
		t.Fatalf("game after %v: the waits were not 150 then 300 ms", d)
	}
	h.bot.mu.Lock()
	backoff := h.bot.holdBackoff
	h.bot.mu.Unlock()
	if backoff != 0 {
		t.Fatalf("backoff %v after a challenge went through", backoff)
	}
	if w := waitText(3*time.Hour + 4*time.Minute); w != "3 h 4 min" {
		t.Fatalf("wait text %q", w)
	}
}

// A bot that has played its bot games for the day is passed over, and
// another asked, without holding back the challenger.
func TestSeekPassesOverBotsAtTheirDailyLimit(t *testing.T) {
	seekAnswerTimeout, seekPause, seekRetry, seekGap = 300*time.Millisecond, 20*time.Millisecond, 200*time.Millisecond, 20*time.Millisecond
	h := newHarness(t, Policy{})
	h.fake.Online = []fake.OnlineBot{{Name: "maia1", Rating: 1500}, {Name: "maia2", Rating: 1500}}
	h.fake.BotsDone = map[string]float64{"maia1": 3600}
	h.connect()
	if err := h.bot.StartSeek(SeekParams{ChallengeParams: ChallengeParams{Limit: 180, Increment: 2, Color: "random"}, Games: 2}); err != nil {
		t.Fatal(err)
	}
	s := h.waitFor("a game", func(s Status) bool { return len(s.Games) >= 1 })
	if !strings.EqualFold(s.Games[0].Opponent, "maia2") {
		t.Fatalf("played %q", s.Games[0].Opponent)
	}
	if n := strings.Count(strings.Join(h.fake.Calls(), "\n"), "POST /api/challenge/maia1"); n > 1 {
		t.Fatalf("maia1 challenged %d times", n)
	}
	if !h.bot.heldUntil("boardbot").IsZero() {
		t.Fatal("the challenger was held for another bot's limit")
	}
	h.bot.StopSeek()
}

// A challenge Lichess will not send is reported, with its error, for the
// challenges window.
func TestSeekReportsAChallengeNotSent(t *testing.T) {
	seekAnswerTimeout, seekPause, seekRetry, seekGap = 300*time.Millisecond, 20*time.Millisecond, 200*time.Millisecond, 20*time.Millisecond
	h := newHarness(t, Policy{})
	h.fake.Online = []fake.OnlineBot{{Name: "maia1", Rating: 1500}}
	h.fake.BotsDone = map[string]float64{"maia1": 3600}
	h.connect()
	if err := h.bot.StartSeek(SeekParams{ChallengeParams: ChallengeParams{Limit: 180, Increment: 2, Color: "random"}}); err != nil {
		t.Fatal(err)
	}
	s := h.waitFor("the challenge not sent", func(s Status) bool { return s.Seek != nil && s.Seek.Failed != nil })
	f := s.Seek.Failed
	if !strings.EqualFold(f.User, "maia1") || f.Limit != 180 || f.Increment != 2 || f.Error == "" || f.At == 0 {
		t.Fatalf("failed: %+v", f)
	}
	h.bot.StopSeek()
}

// Challenges the bot already has out when it connects (sent on the
// website, say) are listed as waiting.
func TestBotListsTheChallengesAlreadyOut(t *testing.T) {
	h := newHarness(t, Policy{})
	resp, err := http.Get(h.srv.URL + "/_fake/sent?to=grumpy")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	h.connect()
	s := h.waitFor("the challenge out", func(s Status) bool { return len(s.Outgoing) == 1 })
	if !strings.EqualFold(s.Outgoing[0].User, "grumpy") {
		t.Fatalf("outgoing: %+v", s.Outgoing)
	}
}

// The run's latest challenge is in its status however it ended: one
// declined at once still shows, declined, with the reason.
func TestSeekReportsItsChallengeDeclinedAtOnce(t *testing.T) {
	seekAnswerTimeout, seekPause, seekRetry, seekGap = 2*time.Second, 300*time.Millisecond, 200*time.Millisecond, 20*time.Millisecond
	h := newHarness(t, Policy{})
	h.fake.Delay = time.Millisecond
	h.fake.Online = []fake.OnlineBot{{Name: "maia1", Rating: 1500}}
	h.fake.Decliners = map[string]string{"maia1": "tooFast"}
	h.connect()
	if err := h.bot.StartSeek(SeekParams{ChallengeParams: ChallengeParams{Limit: 180, Increment: 2, Color: "random"}}); err != nil {
		t.Fatal(err)
	}
	s := h.waitFor("the challenge declined", func(s Status) bool {
		return s.Seek != nil && s.Seek.Challenge != nil && s.Seek.Challenge.State == "declined"
	})
	c := s.Seek.Challenge
	if !strings.EqualFold(c.User, "maia1") || c.ID == "" || c.Reason != "too fast" || c.Limit != 180 || c.Increment != 2 {
		t.Fatalf("challenge: %+v", c)
	}
	// It stays in the status while the run waits to send the next.
	time.Sleep(100 * time.Millisecond)
	if st := h.bot.Status(); st.Seek == nil || st.Seek.Challenge == nil || st.Seek.Challenge.ID != c.ID {
		t.Fatalf("gone from the status: %+v", st.Seek)
	}
	h.bot.StopSeek()
}

// While it runs, the random-bot run always says what it is doing: a
// phase and a message in each status, with when the wait ends whenever it
// waits (so the challenges window is never blank).
func TestSeekAlwaysSaysWhatItIsDoing(t *testing.T) {
	seekAnswerTimeout, seekPause, seekRetry, seekGap, seekPoll = 300*time.Millisecond, 20*time.Millisecond, 200*time.Millisecond, 400*time.Millisecond, 20*time.Millisecond
	defer func() { seekGap, seekPoll = time.Minute, time.Second }()
	h := newHarness(t, Policy{})
	// No bot in range at first.
	h.fake.Online = []fake.OnlineBot{{Name: "strongbot", Rating: 2600}}
	h.connect()
	if err := h.bot.StartSeek(SeekParams{ChallengeParams: ChallengeParams{Limit: 180, Increment: 2, Color: "random"},
		MinRating: 1600, MaxRating: 1800, Games: -1}); err != nil {
		t.Fatal(err)
	}
	h.waitFor("no bots", func(s Status) bool { return s.Seek != nil && s.Seek.Phase == "nobots" })
	// grumpy declines, sleepy does not answer; then SlowBot accepts.
	h.fake.SetOnline(fake.OnlineBot{Name: "grumpy", Rating: 1700})
	h.waitFor("grumpy declined", func(s Status) bool { return s.Seek != nil && s.Seek.Tried == 1 && s.Seek.Phase == "pause" })
	h.fake.SetOnline(fake.OnlineBot{Name: "sleepy", Rating: 1650})
	h.waitFor("sleepy asked", func(s Status) bool { return s.Seek != nil && s.Seek.Tried == 2 && s.Seek.Phase == "pause" })
	h.fake.SetOnline(fake.OnlineBot{Name: "SlowBot", Rating: 1700})
	h.waitFor("playing", func(s Status) bool { return s.Seek != nil && s.Seek.Phase == "playing" })
	h.bot.StopSeek()

	h.mu.Lock()
	seeks := append([]SeekStatus(nil), h.seeks...)
	h.mu.Unlock()
	seen := map[string]bool{}
	for _, st := range seeks {
		if !st.Active {
			continue
		}
		seen[st.Phase] = true
		if st.Phase == "" || st.Message == "" {
			t.Fatalf("a status that says nothing: %+v", st)
		}
		switch st.Phase {
		case "nobots", "limited", "offline", "error":
			if st.NextAt == 0 {
				t.Fatalf("%s without when it tries again: %+v", st.Phase, st)
			}
		case "waiting":
			if st.Challenge == nil || st.Challenge.State != "waiting" || st.Challenge.AnswerBy <= st.Challenge.At || st.Current == "" {
				t.Fatalf("waiting without its challenge: %+v %+v", st, st.Challenge)
			}
		case "sending":
			if st.Current == "" {
				t.Fatalf("sending to no one: %+v", st)
			}
		}
	}
	for _, p := range []string{"looking", "nobots", "sending", "waiting", "pause", "playing"} {
		if !seen[p] {
			t.Fatalf("never %s; phases %v", p, seen)
		}
	}
	// After a decline, it says who declined and why while it waits for the next.
	said := func(sub string) bool {
		for _, st := range seeks {
			if st.Phase == "pause" && st.NextAt > 0 && strings.Contains(st.Message, sub) {
				return true
			}
		}
		return false
	}
	if !said("grumpy declined") || !said("sleepy did not answer") {
		t.Fatalf("the pause did not say what became of the challenge")
	}
}

// The rating preference weighs the pick as lichess-bot's does: the far end
// of the range about twice as likely as the near end.
func TestSeekRatingPreference(t *testing.T) {
	user := func(id string, r int) User {
		u := User{ID: id}
		u.Perfs = map[string]struct {
			Rating int  `json:"rating"`
			Games  int  `json:"games"`
			Prov   bool `json:"prov"`
			RD     int  `json:"rd,omitempty"`
			Prog   int  `json:"prog,omitempty"`
		}{"blitz": {Rating: r, Games: 10}}
		return u
	}
	pool := []User{user("low", 1500), user("high", 1900)}
	share := func(pref string) float64 {
		n := 0
		for i := 0; i < 6000; i++ {
			if (SeekParams{Preference: pref}).pick(pool, "blitz", 1500, 1900).ID == "high" {
				n++
			}
		}
		return float64(n) / 6000
	}
	if s := share("high"); s < 0.62 || s > 0.71 {
		t.Fatalf("high: the higher rated picked %.2f of the time, want about 2/3", s)
	}
	if s := share("low"); s < 0.29 || s > 0.38 {
		t.Fatalf("low: the higher rated picked %.2f of the time, want about 1/3", s)
	}
	if s := share(""); s < 0.45 || s > 0.55 {
		t.Fatalf("none: %.2f, want about 1/2", s)
	}
	if err := (SeekParams{Preference: "sideways"}).check(); err == nil {
		t.Fatal("unknown preference allowed")
	}
}

// The fine filter remembers what a bot declined: its speed for too fast,
// rated or casual for those, the bot itself otherwise.
func TestSeekDeclineAspects(t *testing.T) {
	b := NewBot(Hooks{})
	b.noteDecline("fine", "picky", "toofast", "blitz", false)
	b.noteDecline("fine", "Moody", "rated", "blitz", true)
	b.noteDecline("fine", "grumpy", "later", "blitz", false)
	b.noteDecline("none", "nobody", "later", "blitz", false)
	for _, c := range []struct {
		bot, speed  string
		rated, want bool
	}{
		{"picky", "blitz", false, true}, {"picky", "rapid", false, false},
		{"moody", "blitz", true, true}, {"moody", "blitz", false, false},
		{"grumpy", "rapid", true, true}, {"nobody", "blitz", false, false},
	} {
		if got := b.declinedFor("fine", c.bot, c.speed, c.rated); got != c.want {
			t.Errorf("%s at %s rated=%v: passed over %v, want %v", c.bot, c.speed, c.rated, got, c.want)
		}
	}
	// Coarse passes over every bot that declined, for anything.
	b.noteDecline("coarse", "picky", "toofast", "blitz", false)
	if !b.declinedFor("coarse", "picky", "rapid", true) {
		t.Error("coarse: picky challenged again")
	}
	// A day later it counts no more.
	defer func(d time.Duration) { seekDeclineFor = d }(seekDeclineFor)
	seekDeclineFor = -time.Second
	b.noteDecline("coarse", "brief", "later", "blitz", false)
	if b.declinedFor("coarse", "brief", "blitz", false) {
		t.Error("an expired decline still counts")
	}
}

// With the fine filter, a bot that declined is not asked again while
// another fits; with coarse, not at all; with none, it is asked again.
func TestSeekDeclineFilter(t *testing.T) {
	seekAnswerTimeout, seekPause, seekRetry, seekGap = 150*time.Millisecond, 20*time.Millisecond, 100*time.Millisecond, 20*time.Millisecond
	defer func(d time.Duration) { seekRest = d }(seekRest)
	seekRest = 0 // the filter alone; TestSeekLeavesADecliningBotBe has the rest
	asks := func(filter string, online ...fake.OnlineBot) (picky, total int, s Status) {
		h := newHarness(t, Policy{})
		h.fake.Online = online
		h.connect()
		if err := h.bot.StartSeek(SeekParams{ChallengeParams: ChallengeParams{Limit: 180, Increment: 2, Color: "random"}, Games: -1, Filter: filter}); err != nil {
			t.Fatal(err)
		}
		time.Sleep(1500 * time.Millisecond)
		s = h.bot.Status()
		h.bot.StopSeek()
		calls := strings.Join(h.fake.Calls(), "\n")
		return strings.Count(calls, "POST /api/challenge/picky"), strings.Count(calls, "POST /api/challenge/"), s
	}
	two := []fake.OnlineBot{{Name: "picky", Rating: 1750}, {Name: "sleepy", Rating: 1650}}
	if p, n, _ := asks("fine", two...); p != 1 || n < 3 {
		t.Fatalf("fine: picky asked %d times of %d", p, n)
	}
	if p, _, _ := asks("none", two...); p < 2 {
		t.Fatalf("none: picky asked %d times", p)
	}
	// Fine with no other bot: picky is asked again; coarse: never.
	if p, _, _ := asks("fine", fake.OnlineBot{Name: "picky", Rating: 1750}); p < 2 {
		t.Fatalf("fine, picky alone: asked %d times", p)
	}
	p, _, s := asks("coarse", fake.OnlineBot{Name: "picky", Rating: 1750})
	if p != 1 || s.Seek == nil || !strings.Contains(s.Seek.Message, "declined a challenge today") {
		t.Fatalf("coarse: picky asked %d times; seek %+v", p, s.Seek)
	}
}

// A bot that declines is not challenged again at once, at any clock and
// whatever the decline filter, nor when the search is started again: it
// rests for seekRest, and the search says so and waits.
func TestSeekLeavesADecliningBotBe(t *testing.T) {
	seekAnswerTimeout, seekPause, seekRetry, seekGap = 150*time.Millisecond, 20*time.Millisecond, 100*time.Millisecond, 20*time.Millisecond
	h := newHarness(t, Policy{})
	h.fake.Online = []fake.OnlineBot{{Name: "picky", Rating: 1750}}
	h.connect()
	start := func() {
		err := h.bot.StartSeek(SeekParams{ChallengeParams: ChallengeParams{Color: "random"}, Times: []int{60, 180, 600}, Increments: []int{0, 2}, Games: -1, Filter: "none"})
		if err != nil {
			t.Fatal(err)
		}
	}
	start()
	s := h.waitFor("waits for picky", func(s Status) bool {
		return s.Seek != nil && strings.Contains(s.Seek.Message, "None is challenged twice")
	})
	if !strings.Contains(s.Seek.Message, "(1)") || !regexp.MustCompile(`again in (1 h|60 min)`).MatchString(s.Seek.Message) {
		t.Errorf("message %q", s.Seek.Message)
	}
	time.Sleep(500 * time.Millisecond)
	h.bot.StopSeek()
	start()
	time.Sleep(500 * time.Millisecond)
	h.bot.StopSeek()
	if n := strings.Count(strings.Join(h.fake.Calls(), "\n"), "POST /api/challenge/picky"); n != 1 {
		t.Fatalf("picky challenged %d times, want 1", n)
	}
}

// Each bot is challenged once: one that declines, or does not answer, is
// not asked again at another clock, nor once all have been asked, nor
// with the fine filter when no other bot fits.
func TestSeekNeverChallengesTheSameBotTwice(t *testing.T) {
	seekAnswerTimeout, seekPause, seekRetry, seekGap = 150*time.Millisecond, 20*time.Millisecond, 100*time.Millisecond, 20*time.Millisecond
	h := newHarness(t, Policy{})
	// grumpy declines, sleepy never answers, picky declines; then none is left.
	h.fake.Online = []fake.OnlineBot{{Name: "grumpy", Rating: 1700}, {Name: "picky", Rating: 1750}, {Name: "sleepy", Rating: 1650}}
	h.connect()
	if err := h.bot.StartSeek(SeekParams{ChallengeParams: ChallengeParams{Color: "random"}, Times: []int{60, 180, 600}, Increments: []int{0, 2}, Games: -1, Filter: "fine"}); err != nil {
		t.Fatal(err)
	}
	h.waitFor("all asked once", func(s Status) bool {
		return s.Seek != nil && strings.Contains(s.Seek.Message, "None is challenged twice")
	})
	time.Sleep(400 * time.Millisecond)
	h.bot.StopSeek()
	calls := strings.Join(h.fake.Calls(), "\n")
	for _, bot := range []string{"grumpy", "picky", "sleepy"} {
		if n := strings.Count(calls, "POST /api/challenge/"+bot); n != 1 {
			t.Errorf("%s challenged %d times, want 1", bot, n)
		}
	}
}
