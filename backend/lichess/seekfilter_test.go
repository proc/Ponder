package lichess

import (
	"encoding/json"
	"net/http"
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
	s := h.waitFor("held", func(s Status) bool { return s.Seek != nil && strings.Contains(s.Seek.Message, "too many requests") })
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
