package lichess

import (
	"encoding/json"
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
