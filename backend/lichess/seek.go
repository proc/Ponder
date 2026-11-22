package lichess

import (
	"context"
	"errors"
	"fmt"
	"math/rand"
	"strings"
	"time"
)

// Challenging random bots: pick an online bot rated within a range, send a
// challenge, and try the next one until a challenge is accepted. With more
// than one game asked for it goes on challenging, until the number of games
// is reached. It only holds back while the engine is in as many games as
// its rules allow at once (Policy.MaxGames): the next challenge goes out
// when one of them ends.

// SeekParams is the challenge to send, without a username, and the rating
// range (0: no bound) at the time control's speed.
type SeekParams struct {
	ChallengeParams
	MinRating int `json:"minRating"`
	MaxRating int `json:"maxRating"`
	// Games to play, one after another: 0 or 1 is one game, below 0 means
	// keep going until stopped.
	Games int `json:"games"`
	// Around, when above 0, takes the range from your bot's own rating at
	// the speed: that many points either side (MinRating and MaxRating are
	// then not used).
	Around int `json:"around"`
	// Bots with a provisional rating at the speed are passed over, and so
	// are bots with fewer than MinGames games at it.
	NoProvisional bool `json:"noProvisional"`
	MinGames      int  `json:"minGames"`
	// Exclude are bots never to challenge (usernames, any case).
	Exclude []string `json:"exclude"`
	// Random challenge types, as lichess-bot's matchmaking does them: with
	// Times or Increments given, each challenge takes its initial time
	// (seconds) and increment at random from them, in place of Limit and
	// Increment. RatedMode "random" makes each challenge rated or casual at
	// random; "rated" and "casual" set it, and "" leaves it to Rated.
	Times      []int  `json:"times,omitempty"`
	Increments []int  `json:"increments,omitempty"`
	RatedMode  string `json:"ratedMode,omitempty"`
	// Filter is what a bot's decline does to later challenges, as
	// lichess-bot's challenge_filter: "none" (or ""), nothing; "coarse",
	// the bot is not challenged again for a day; "fine", the bot is passed
	// over for a day for what it declined (the speed, for too fast, too
	// slow or time control; rated or casual, for those; anything, for the
	// other reasons), unless no other bot fits.
	Filter string `json:"filter,omitempty"`
	// Preference weighs the pick among the bots that fit, as lichess-bot's
	// rating_preference: "none" (or ""), each as likely; "high", the higher
	// rated more likely; "low", the lower rated (the far end of the range
	// about twice as likely as the near end).
	Preference string `json:"preference,omitempty"`
}

// seekDeclineFor is how long a bot's decline counts for the filter.
var seekDeclineFor = 24 * time.Hour

// declineAspect is what a decline reason was about, for the fine filter:
// "speed", "mode", or "" for the bot itself.
func declineAspect(reason string) string {
	switch strings.ToLower(reason) {
	case "toofast", "tooslow", "timecontrol":
		return "speed"
	case "rated", "casual":
		return "mode"
	}
	return ""
}

// noteDecline records a bot's decline for the filter.
func (b *Bot) noteDecline(filter, bot, reason, speed string, rated bool) {
	key := strings.ToLower(bot) + "/"
	switch filter {
	case "coarse":
	case "fine":
		switch declineAspect(reason) {
		case "speed":
			key += "speed:" + speed
		case "mode":
			key += "mode:" + modeName(rated)
		}
	default:
		return
	}
	b.mu.Lock()
	if b.seekDeclined == nil {
		b.seekDeclined = map[string]time.Time{}
	}
	b.seekDeclined[key] = time.Now().Add(seekDeclineFor)
	b.mu.Unlock()
}

// declinedFor reports whether the filter passes the bot over for a
// challenge at speed, rated or casual.
func (b *Bot) declinedFor(filter, bot, speed string, rated bool) bool {
	if filter != "coarse" && filter != "fine" {
		return false
	}
	id := strings.ToLower(bot) + "/"
	keys := []string{id}
	if filter == "fine" {
		keys = append(keys, id+"speed:"+speed, id+"mode:"+modeName(rated))
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	now := time.Now()
	for _, k := range keys {
		if until, ok := b.seekDeclined[k]; ok {
			if now.Before(until) {
				return true
			}
			delete(b.seekDeclined, k)
		}
	}
	return false
}

// restBot passes a bot over for the challenger until wait is up: it has
// played its bot games for the day, or it declined or did not answer.
// It is kept on the bot, so a search started again leaves it be too.
func (b *Bot) restBot(id string, wait time.Duration) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.seekResting == nil {
		b.seekResting = map[string]time.Time{}
	}
	b.seekResting[strings.ToLower(id)] = time.Now().Add(wait)
}

// restingUntil is when a bot may be challenged again; zero when it may now.
func (b *Bot) restingUntil(id string) time.Time {
	b.mu.Lock()
	defer b.mu.Unlock()
	until, ok := b.seekResting[id]
	if !ok {
		return time.Time{}
	}
	if !time.Now().Before(until) {
		delete(b.seekResting, id)
		return time.Time{}
	}
	return until
}

func modeName(rated bool) string {
	if rated {
		return "rated"
	}
	return "casual"
}

// pick chooses a bot from the pool, weighted by the rating preference
// as lichess-bot does: with the range lo–hi (the pool's own when open),
// a bot at the far end is about twice as likely as one at the near end.
func (p SeekParams) pick(pool []User, speed string, lo, hi int) User {
	if len(pool) == 1 || (p.Preference != "high" && p.Preference != "low") {
		return pool[rand.Intn(len(pool))]
	}
	if lo <= 0 || hi <= 0 {
		lo, hi = poolRange(pool, speed)
	}
	weights := make([]float64, len(pool))
	total := 0.0
	for i, u := range pool {
		r := float64(u.RatingFor(speed))
		w := 1.0
		if p.Preference == "high" {
			reduce := min(float64(lo-(hi-lo)), float64(lo-1))
			w = r - reduce
		} else {
			reduce := max(float64(hi+(hi-lo)), float64(hi+1))
			w = reduce - r
		}
		weights[i] = max(w, 1)
		total += weights[i]
	}
	x := rand.Float64() * total
	for i, w := range weights {
		if x < w {
			return pool[i]
		}
		x -= w
	}
	return pool[len(pool)-1]
}

// poolRange is the lowest and highest rating at speed among the pool.
func poolRange(pool []User, speed string) (lo, hi int) {
	for i, u := range pool {
		r := u.RatingFor(speed)
		if i == 0 || r < lo {
			lo = r
		}
		if i == 0 || r > hi {
			hi = r
		}
	}
	return lo, hi
}

// check reports settings the search cannot use.
func (p SeekParams) check() error {
	if p.Around <= 0 && p.MinRating > 0 && p.MaxRating > 0 && p.MinRating > p.MaxRating {
		return errors.New("the lowest rating is above the highest")
	}
	if p.Around < 0 || p.MinGames < 0 {
		return errors.New("the rating range and number of games cannot be below 0")
	}
	for _, t := range p.Times {
		if t <= 0 || t > 10800 {
			return fmt.Errorf("an initial time of %d s is not one Lichess allows", t)
		}
	}
	for _, i := range p.Increments {
		if i < 0 || i > 180 {
			return fmt.Errorf("an increment of %d s is not one Lichess allows", i)
		}
	}
	switch p.RatedMode {
	case "", "rated", "casual", "random":
	default:
		return fmt.Errorf("unknown rated mode %q", p.RatedMode)
	}
	switch p.Filter {
	case "", "none", "coarse", "fine":
	default:
		return fmt.Errorf("unknown decline filter %q", p.Filter)
	}
	switch p.Preference {
	case "", "none", "high", "low":
	default:
		return fmt.Errorf("unknown rating preference %q", p.Preference)
	}
	return nil
}

// seekClock is one time control the search may challenge with.
type seekClock struct {
	limit, inc int
	speed      string
}

// clocks are the time controls to choose from, in random order: one, or
// every pairing of Times and Increments.
func (p SeekParams) clocks() []seekClock {
	times, incs := p.Times, p.Increments
	if len(times) == 0 {
		times = []int{p.Limit}
	}
	if len(incs) == 0 {
		incs = []int{p.Increment}
	}
	var out []seekClock
	seen := map[[2]int]bool{}
	for _, t := range times {
		for _, i := range incs {
			if seen[[2]int{t, i}] {
				continue
			}
			seen[[2]int{t, i}] = true
			out = append(out, seekClock{t, i, SpeedOf(t, i)})
		}
	}
	rand.Shuffle(len(out), func(a, b int) { out[a], out[b] = out[b], out[a] })
	return out
}

// speeds names the speeds the search plays at, for the status: "blitz",
// or "bullet/blitz" with a random clock.
func (p SeekParams) speeds() string {
	order := []string{"ultraBullet", "bullet", "blitz", "rapid", "classical"}
	has := map[string]bool{}
	for _, c := range p.clocks() {
		has[c.speed] = true
	}
	var out []string
	for _, s := range order {
		if has[s] {
			out = append(out, s)
		}
	}
	return strings.Join(out, "/")
}

// rated says whether the next challenge is rated.
func (p SeekParams) rated() bool {
	switch p.RatedMode {
	case "rated":
		return true
	case "casual":
		return false
	case "random":
		return rand.Intn(2) == 0
	}
	return p.Rated
}

// clockText is a time control as Lichess writes it: 3+2, ½+0.
func clockText(limit, inc int) string {
	m := ""
	switch limit {
	case 15:
		m = "¼"
	case 30:
		m = "½"
	case 45:
		m = "¾"
	case 90:
		m = "1.5"
	default:
		m = fmt.Sprint(limit / 60)
		if limit%60 != 0 {
			m = fmt.Sprintf("%.1f", float64(limit)/60)
		}
	}
	return fmt.Sprintf("%s+%d", m, inc)
}

// fits reports whether a bot online matches the search's settings at the
// speed, with lo–hi the rating range.
func (p SeekParams) fits(u User, speed string, lo, hi int, exclude map[string]bool) bool {
	if exclude[strings.ToLower(u.ID)] || exclude[strings.ToLower(u.Username)] || exclude[strings.ToLower(u.Name)] {
		return false
	}
	if !inRange(u.RatingFor(speed), lo, hi) {
		return false
	}
	perf := u.Perfs[speed]
	if p.NoProvisional && perf.Prov {
		return false
	}
	return p.MinGames <= 0 || perf.Games >= p.MinGames
}

// SeekStatus describes the search to the UI.
type SeekStatus struct {
	Active    bool   `json:"active"`
	Speed     string `json:"speed"`
	MinRating int    `json:"minRating"`
	MaxRating int    `json:"maxRating"`
	Tried     int    `json:"tried"`
	Current   string `json:"current"` // bot being challenged
	Rating    int    `json:"rating"`
	Message   string `json:"message"`
	GameID    string `json:"gameId"`           // the accepted challenge's game
	NextAt    int64  `json:"nextAt,omitempty"` // when the next challenge goes out (Unix ms), while waiting
	// Games started so far, of Games (0: no limit); Playing while the engine
	// is in as many games as it may play at once and the next challenge
	// waits for one to end.
	Played  int  `json:"played"`
	Games   int  `json:"games"`
	Playing bool `json:"playing"`
	// Failed is the last challenge that could not be sent, and why: for the
	// challenges window.
	Failed *SeekFailure `json:"failed,omitempty"`
	// Challenge is the challenge the run sent last, and how it stands now:
	// waiting, accepted, declined (and why), expired (no answer), failed
	// (not sent) or gone (withdrawn when the run stopped). It stays until
	// the next one goes out, so the challenges window can always show it.
	Challenge *SeekChallenge `json:"challenge,omitempty"`
	// Phase is what the run is doing right now, so the challenges window is
	// never blank while it runs; Message says it in words, and NextAt when a
	// wait ends:
	//   looking  reading the bots online, to pick one
	//   sending  sending a challenge to Current
	//   waiting  Challenge is out, waiting for an answer
	//   pause    between challenges (after an answer, or one a minute at most)
	//   playing  in as many games as it may play at once
	//   nobots   no bot online fits the settings; it looks again at NextAt
	//   limited  Lichess refused a challenge for too many requests; none until NextAt
	//   offline  not connected to Lichess; it tries again at NextAt
	//   error    Lichess could not be read; it tries again at NextAt
	Phase string `json:"phase"`
}

// set says what the run is doing now; wait > 0 is how long until it acts again.
func (st *SeekStatus) set(phase, msg string, wait time.Duration) {
	st.Phase, st.Message, st.NextAt = phase, msg, 0
	if wait > 0 {
		st.NextAt = time.Now().Add(wait).UnixMilli()
	}
}

// SeekChallenge is the random-bot run's latest challenge.
type SeekChallenge struct {
	ID        string `json:"id,omitempty"` // "" when it was not sent
	At        int64  `json:"at"`           // when it went out (Unix ms)
	User      string `json:"user"`
	Title     string `json:"title,omitempty"`
	Rating    int    `json:"rating,omitempty"`
	Limit     int    `json:"limit"`
	Increment int    `json:"increment"`
	Rated     bool   `json:"rated"`
	Speed     string `json:"speed,omitempty"`
	State     string `json:"state"`
	Reason    string `json:"reason,omitempty"`   // why it was declined, or the error
	AnswerBy  int64  `json:"answerBy,omitempty"` // while waiting: when it is withdrawn if not answered (Unix ms)
	// Random: its clock, or rated or casual, was picked at random from the
	// choices in the settings (as lichess-bot's matchmaking picks them).
	Random bool `json:"random,omitempty"`
}

// SeekFailure is a challenge Lichess refused to send.
type SeekFailure struct {
	At        int64  `json:"at"` // Unix ms
	User      string `json:"user"`
	Title     string `json:"title,omitempty"`
	Rating    int    `json:"rating,omitempty"`
	Limit     int    `json:"limit"`
	Increment int    `json:"increment"`
	Rated     bool   `json:"rated"`
	Speed     string `json:"speed,omitempty"`
	Error     string `json:"error"`
}

type seeker struct {
	params  SeekParams // under b.mu: UpdateSeek changes them as it runs
	rev     int        // counts the changes, so the search sees one
	cancel  context.CancelFunc
	status  SeekStatus
	current string // challenge id waiting for an answer
}

// holdChallenges keeps the challenger from sending another challenge for
// wait (when Lichess did not say how long: 1 minute, then 2, 4, 8, 10 for
// each refusal in a row, as lichess-bot does), and says until when.
func (b *Bot) holdChallenges(wait time.Duration) time.Time {
	b.mu.Lock()
	defer b.mu.Unlock()
	if wait <= 0 {
		if b.holdBackoff == 0 {
			b.holdBackoff = seekHoldFirst
		}
		wait = b.holdBackoff
		b.holdBackoff = min(2*b.holdBackoff, 10*seekHoldFirst)
	}
	b.holdUntil = time.Now().Add(wait)
	b.holdFor = ""
	if b.account != nil {
		b.holdFor = strings.ToLower(b.account.ID)
	}
	return b.holdUntil
}

// heldUntil is when the challenger may challenge again, for the account
// me (zero: now).
func (b *Bot) heldUntil(me string) time.Time {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.holdFor != me || !time.Now().Before(b.holdUntil) {
		return time.Time{}
	}
	return b.holdUntil
}

// waitText is a wait as people say it: 40 s, 12 min, 3 h 5 min.
func waitText(d time.Duration) string {
	switch s := int(d.Round(time.Second) / time.Second); {
	case s < 90:
		return fmt.Sprintf("%d s", max(s, 1))
	case s < 3600:
		return fmt.Sprintf("%d min", (s+30)/60)
	default:
		h, m := s/3600, (s%3600+30)/60
		if m == 60 {
			h, m = h+1, 0
		}
		if m == 0 {
			return fmt.Sprintf("%d h", h)
		}
		return fmt.Sprintf("%d h %d min", h, m)
	}
}

// Seek timings; variables so tests can shorten them.
var (
	seekAnswerTimeout = 30 * time.Second // then the challenge is cancelled
	seekPause         = 3 * time.Second  // after a failed request
	seekGap           = time.Minute      // at least this long from one challenge to the next
	seekRetry         = 30 * time.Second // when no bot is left to try
	// A bot challenged once and not playing (it declined, did not answer,
	// or the challenge failed) is not challenged again for this long, at
	// any clock: the challenger moves on to someone else. Asking again
	// would only earn another decline, and Lichess limits how many
	// challenges a bot may send.
	seekRest      = time.Hour
	seekPoll      = time.Second // how often a game in progress is looked at
	seekHoldFirst = time.Minute // first wait after a bare "too many requests"
)

// fullLocked reports whether the engine is in as many games as it may play
// at once (in progress, or about to start), and how many that is: no
// challenge is sent meanwhile.
func (b *Bot) fullLocked() (bool, int) {
	n := 0
	for _, r := range b.games {
		if !r.finished {
			n++
		}
	}
	for id, at := range b.accepted {
		if b.games[id] == nil && time.Since(at) <= acceptedWait {
			n++
		}
	}
	limit := max(1, b.cfg.Policy.MaxGames)
	return n >= limit, limit
}

func (b *Bot) seekStatusLocked() *SeekStatus {
	if b.seek == nil {
		return nil
	}
	st := b.seek.status
	return &st
}

// StartSeek challenges random online bots until one accepts.
func (b *Bot) StartSeek(p SeekParams) error {
	if _, err := b.connected(); err != nil {
		return err
	}
	if err := p.check(); err != nil {
		return err
	}
	// Games in progress do not stand in the way: it challenges while there
	// is room for another, and waits when there is none.
	b.mu.Lock()
	busy := ""
	if b.sending {
		busy = "A challenge is already being sent."
	}
	for _, ch := range b.outgoing {
		busy = fmt.Sprintf("Your challenge to %s is waiting for an answer. Cancel it to challenge someone else.", ch.DestName())
	}
	b.mu.Unlock()
	if busy != "" {
		return errors.New(busy)
	}
	b.StopSeek()
	limit := p.Games // 0 in the status: no limit
	if limit == 0 {
		limit = 1
	} else if limit < 0 {
		limit = 0
	}
	ctx, cancel := context.WithCancel(context.Background())
	sk := &seeker{params: p, cancel: cancel, status: SeekStatus{
		Active: true, Speed: p.speeds(), MinRating: p.MinRating, MaxRating: p.MaxRating,
		Phase: "looking", Message: "Looking for an opponent…", Games: limit,
	}}
	b.mu.Lock()
	b.seek = sk
	b.mu.Unlock()
	b.emit()
	go b.runSeek(ctx, sk)
	return nil
}

// UpdateSeek gives the search that is running new settings (the clock,
// colour, rating range or "around yours", and the rest), from its next
// look at the bots online; the challenge waiting for an answer, and the
// number of games, stay as they are. It reports false when no search is
// running.
func (b *Bot) UpdateSeek(p SeekParams) (bool, error) {
	if err := p.check(); err != nil {
		return false, err
	}
	b.mu.Lock()
	sk := b.seek
	if sk == nil {
		b.mu.Unlock()
		return false, nil
	}
	p.Games = sk.params.Games
	sk.params = p
	sk.rev++
	sk.status.Speed = p.speeds()
	sk.status.MinRating, sk.status.MaxRating = p.MinRating, p.MaxRating
	if sk.current == "" && !sk.status.Playing {
		sk.status.Message = "Settings changed: looking for bots online…"
	}
	b.mu.Unlock()
	b.emit()
	return true, nil
}

// StopSeek stops the search, cancelling the challenge waiting for an answer.
func (b *Bot) StopSeek() {
	b.mu.Lock()
	sk := b.seek
	b.seek = nil
	b.mu.Unlock()
	if sk == nil {
		return
	}
	sk.cancel()
	b.emit()
}

// seekUpdate changes the status of sk if it is still the current search.
func (b *Bot) seekUpdate(sk *seeker, f func(*SeekStatus)) bool {
	b.mu.Lock()
	if b.seek != sk {
		b.mu.Unlock()
		return false
	}
	f(&sk.status)
	b.mu.Unlock()
	b.emit()
	return true
}

func inRange(r, lo, hi int) bool {
	if r == 0 {
		return lo == 0 && hi == 0
	}
	return (lo == 0 || r >= lo) && (hi == 0 || r <= hi)
}

func (b *Bot) runSeek(ctx context.Context, sk *seeker) {
	var (
		params  SeekParams
		tried   map[string]bool // bot and speed: one that declined 1+0 may take 10+5
		exclude map[string]bool
		mine    User      // your bot's ratings, for Around
		mineAt  time.Time // when they were read
	)
	seen := -1
	// The settings, taken again when UpdateSeek has changed them. With
	// Around, the range follows your bot's own rating, read again now and
	// then (it changes as the engine plays).
	settings := func() {
		b.mu.Lock()
		if sk.rev == seen {
			b.mu.Unlock()
			return
		}
		seen, params = sk.rev, sk.params
		b.mu.Unlock()
		tried = map[string]bool{}
		exclude = map[string]bool{}
		for _, n := range params.Exclude {
			if n = strings.ToLower(strings.TrimSpace(n)); n != "" {
				exclude[n] = true
			}
		}
		mineAt = time.Time{}
	}
	settings()
	var lastSent time.Time
	limit := sk.status.Games
	played := 0
	waiting := false // said that it waits for a game to end
	for ctx.Err() == nil {
		// Not while the engine is in as many games as it may play at once:
		// the next challenge goes out when one of them is over.
		b.mu.Lock()
		playing, most := b.fullLocked()
		b.mu.Unlock()
		if playing {
			if !waiting {
				waiting = true
				msg := "Your engine is playing: the next challenge goes out when the game ends."
				if most > 1 {
					msg = fmt.Sprintf("Your engine is playing %d games, as many as it may at once: the next challenge goes out when one ends.", most)
				}
				if !b.seekUpdate(sk, func(st *SeekStatus) { st.Playing, st.Current, st.Rating = true, "", 0; st.set("playing", msg, 0) }) {
					return
				}
			}
			if !sleepCtx(ctx, seekPoll) {
				return
			}
			continue
		}
		if waiting {
			waiting = false
			if !b.seekUpdate(sk, func(st *SeekStatus) {
				st.Playing = false
				st.set("looking", "A game is over: looking for the next opponent…", 0)
			}) {
				return
			}
		}
		client, err := b.connected()
		if err != nil {
			b.seekUpdate(sk, func(st *SeekStatus) {
				st.Current, st.Rating = "", 0
				st.set("offline", "Not connected to Lichess.", seekRetry)
			})
			if !sleepCtx(ctx, seekRetry) {
				return
			}
			continue
		}
		b.mu.Lock()
		me := ""
		if b.account != nil {
			me = strings.ToLower(b.account.ID)
		}
		b.mu.Unlock()
		// Lichess said too many challenges: none until it allows them again.
		if until := b.heldUntil(me); !until.IsZero() {
			msg := fmt.Sprintf("Lichess refused a challenge for too many requests: none until %s.", until.Format("15:04"))
			if !b.seekUpdate(sk, func(st *SeekStatus) { st.Current, st.Rating = "", 0; st.set("limited", msg, time.Until(until)) }) {
				return
			}
			if !sleepCtx(ctx, time.Until(until)) {
				return
			}
			b.seekUpdate(sk, func(st *SeekStatus) { st.set("looking", "Looking for an opponent…", 0) })
			continue
		}
		settings()
		if params.Around > 0 && time.Since(mineAt) > 5*time.Minute {
			mctx, mcancel := context.WithTimeout(ctx, 20*time.Second)
			u, err := client.UserInfo(mctx, me)
			mcancel()
			if ctx.Err() != nil {
				return
			}
			if err != nil {
				b.seekUpdate(sk, func(st *SeekStatus) { st.set("error", "Could not read your bot's rating: "+err.Error(), seekRetry) })
				if !sleepCtx(ctx, seekRetry) {
					return
				}
				continue
			}
			mine, mineAt = u, time.Now()
		}
		// The rating range at a speed: fixed, or around your bot's rating
		// there (none when it has no rating at that speed yet).
		rangeAt := func(speed string) (lo, hi int, ok bool) {
			if params.Around <= 0 {
				return params.MinRating, params.MaxRating, true
			}
			r := mine.RatingFor(speed)
			if r == 0 {
				return 0, 0, false
			}
			return max(r-params.Around, 1), r + params.Around, true
		}
		// Looking for an opponent; after an answer, what became of the last
		// challenge stays said meanwhile (the look takes a moment).
		if !b.seekUpdate(sk, func(st *SeekStatus) {
			if st.Phase == "pause" {
				st.NextAt = 0
			} else {
				st.Current, st.Rating = "", 0
				st.set("looking", "Looking for an opponent…", 0)
			}
		}) {
			return
		}
		lctx, lcancel := context.WithTimeout(ctx, 20*time.Second)
		bots, err := client.OnlineBots(lctx, 300)
		lcancel()
		if ctx.Err() != nil {
			return
		}
		if err != nil {
			wait := seekRetry
			if RateLimited(err) {
				wait = time.Minute
			}
			b.seekUpdate(sk, func(st *SeekStatus) { st.set("error", "Could not list the bots online: "+err.Error(), wait) })
			if !sleepCtx(ctx, wait) {
				return
			}
			continue
		}
		// A time control at random (lichess-bot's random challenge types),
		// and bots that fit it; another time control when none does.
		var (
			pool    []User
			clock   seekClock
			lo, hi  int
			unrated []string // speeds your bot has no rating at, for Around
			asked   bool     // some bot was passed over for being asked already
			// Rated or casual is picked first, so the decline filter can
			// pass over the bots that declined that.
			rated    = params.rated()
			filtered int                 // bots passed over for the decline filter
			rested   = map[string]bool{} // bots passed over for a while: challenged already, or played enough today
			soonest  time.Time           // when the first of them may be asked again
		)
		for _, c := range params.clocks() {
			l, h, ok := rangeAt(c.speed)
			if !ok {
				unrated = append(unrated, c.speed)
				continue
			}
			var fit, declined []User
			for _, u := range bots {
				id := strings.ToLower(u.ID)
				if id == "" || id == me || !params.fits(u, c.speed, l, h, exclude) {
					continue
				}
				if until := b.restingUntil(id); !until.IsZero() {
					if until.Before(soonest) || soonest.IsZero() {
						soonest = until
					}
					rested[id] = true
					continue
				}
				// The decline filter: coarse passes these bots over; fine
				// only while another bot fits (lichess-bot's "ready_bots or
				// online_bots"), asked already or not.
				if b.declinedFor(params.Filter, u.ID, c.speed, rated) {
					declined = append(declined, u)
					continue
				}
				if tried[id+"/"+c.speed] {
					asked = true
					continue
				}
				fit = append(fit, u)
			}
			filtered += len(declined)
			if len(fit) == 0 && !asked && params.Filter == "fine" {
				fit = declined
			}
			if len(fit) > 0 {
				pool, clock, lo, hi = fit, c, l, h
				break
			}
		}
		if len(pool) == 0 {
			speeds := params.speeds()
			msg := fmt.Sprintf("No bot online fits your settings at %s right now (%d online).", speeds, len(bots))
			wait := seekRetry
			switch {
			case len(rested) > 0 && filtered == 0 && !asked:
				// Every bot that fits was challenged already or has played enough
				// today. The bots online are still looked at every so often,
				// for a new one, until the first of these may be asked again.
				left := time.Until(soonest)
				if left < wait {
					wait = left
				}
				msg = fmt.Sprintf("Every bot online that fits your settings has been challenged already and did not play, or has played enough today (%d). None is challenged twice: the first can be challenged again in %s, and until then a bot that comes online is challenged.", len(rested), waitText(left))
			case filtered > 0 && !asked:
				msg = fmt.Sprintf("Every bot online that fits your settings declined a challenge today (%d), so they are passed over (Skip bots that declined).", filtered)
			case asked:
				msg = fmt.Sprintf("Every matching bot online has been asked (%d); they will be asked again.", len(tried))
				tried = map[string]bool{}
			case len(unrated) > 0 && !strings.Contains(speeds, "/"):
				msg = fmt.Sprintf("Your bot has no %s rating yet, so there is nothing to take the range around. Set a range instead.", speeds)
			case len(unrated) > 0:
				msg = fmt.Sprintf("No bot online fits your settings right now (%d online); your bot has no rating yet at %s, so those clocks are skipped.", len(bots), strings.Join(unrated, ", "))
			}
			if !b.seekUpdate(sk, func(st *SeekStatus) { st.Current, st.Rating = "", 0; st.set("nobots", msg, wait) }) {
				return
			}
			if !sleepCtx(ctx, wait) {
				return
			}
			continue
		}
		// One challenge a minute at most, however quickly the last was answered.
		if wait := time.Until(lastSent.Add(seekGap)); !lastSent.IsZero() && wait > 0 {
			if !b.seekUpdate(sk, func(st *SeekStatus) {
				// What became of the last challenge stays said, with the wait.
				msg := st.Message
				if st.Phase != "pause" || msg == "" {
					msg = "One challenge a minute at most: waiting to send the next."
				}
				st.set("pause", msg, wait)
			}) {
				return
			}
			if !sleepCtx(ctx, wait) {
				return
			}
			continue // the bots online may have changed meanwhile
		}
		u := params.pick(pool, clock.speed, lo, hi)
		tried[strings.ToLower(u.ID)+"/"+clock.speed] = true
		lastSent = time.Now()
		cp := params.ChallengeParams
		cp.Limit, cp.Increment, cp.Rated = clock.limit, clock.inc, rated
		random := len(params.Times) > 1 || len(params.Increments) > 1 || params.RatedMode == "random"
		if !b.seekUpdate(sk, func(st *SeekStatus) {
			st.MinRating, st.MaxRating = lo, hi
			if random {
				st.Speed = clock.speed
			}
		}) {
			return
		}
		accepted, id, retryAfter := b.seekOne(ctx, sk, client, u, clock.speed, cp, random)
		if ctx.Err() != nil {
			return
		}
		if accepted {
			played++
			name := u.DisplayName()
			if limit > 0 && played >= limit {
				// The last game asked for: the search is done.
				b.mu.Lock()
				if b.seek == sk {
					b.seek = nil
				}
				b.message = fmt.Sprintf("%s accepted the challenge.", name)
				b.mu.Unlock()
				sk.cancel()
				b.emit() // the game itself starts from the event stream
				return
			}
			of := ""
			if limit > 0 {
				of = fmt.Sprintf(" of %d", limit)
			}
			msg := fmt.Sprintf("%s accepted: game %d%s.", name, played, of)
			if !b.seekUpdate(sk, func(st *SeekStatus) {
				st.Played, st.Current, st.Rating = played, "", 0
				st.set("pause", msg, 0)
			}) {
				return
			}
			// The game starts from the event stream: give it a moment to
			// show up, so that it is counted as in progress.
			for end := time.Now().Add(acceptedWait); time.Now().Before(end); {
				b.mu.Lock()
				_, started := b.games[id]
				b.mu.Unlock()
				if started || !sleepCtx(ctx, 50*time.Millisecond) {
					break
				}
			}
			continue
		}
		if !b.seekUpdate(sk, func(st *SeekStatus) {
			st.Current, st.Rating, st.Phase = "", 0, "pause"
			st.NextAt = 0
			if retryAfter > 0 {
				st.NextAt = time.Now().Add(retryAfter).UnixMilli()
			}
		}) {
			return
		}
		if !sleepCtx(ctx, retryAfter) {
			return
		}
	}
}

// seekOne challenges one bot and waits for the answer.
func (b *Bot) seekOne(ctx context.Context, sk *seeker, client *Client, u User, speed string, p ChallengeParams, random bool) (accepted bool, id string, next time.Duration) {
	name := u.DisplayName()
	rating := u.RatingFor(speed)
	if !b.seekUpdate(sk, func(st *SeekStatus) {
		st.Tried++
		st.Current, st.Rating = name, rating
		st.set("sending", fmt.Sprintf("Challenging %s (%d)…", name, rating), 0)
		if random {
			// Which of the random challenge types this one is.
			mode := "casual"
			if p.Rated {
				mode = "rated"
			}
			st.Message = fmt.Sprintf("Challenging %s (%d) to %s %s %s…", name, rating, clockText(p.Limit, p.Increment), speed, mode)
		}
	}) {
		return false, "", 0
	}
	p.Username = u.ID
	if u.Username != "" {
		p.Username = u.Username
	}
	ch, err := b.challenge(p)
	sent := time.Now().UnixMilli()
	// Asked once: whatever comes of it, this bot is not asked again (see
	// seekRest), unless it accepts. Even a request that failed may have
	// reached Lichess (one that timed out). Only Lichess refusing your bot
	// for too many requests leaves it be: that challenge never reached it.
	b.restBot(u.ID, seekRest)
	current := func(st *SeekStatus, id, state, reason string) {
		st.Challenge = &SeekChallenge{ID: id, At: sent, User: name, Title: u.Title, Rating: rating,
			Limit: p.Limit, Increment: p.Increment, Rated: p.Rated, Speed: speed, State: state, Reason: reason, Random: random}
	}
	failed := func(st *SeekStatus, why string) {
		st.Failed = &SeekFailure{At: sent, User: name, Title: u.Title, Rating: rating,
			Limit: p.Limit, Increment: p.Increment, Rated: p.Rated, Speed: speed, Error: why}
		current(st, "", "failed", why)
	}
	if self, opponent, wait := ChallengeLimit(err); self {
		// Your bot is rate limited: the loop holds every challenge until
		// the time is up (the hold outlives this search, so a new one
		// started meanwhile waits too).
		b.holdChallenges(wait)
		b.restBot(u.ID, 0) // it was never challenged
		b.seekUpdate(sk, func(st *SeekStatus) {
			st.set("pause", fmt.Sprintf("Lichess refused the challenge to %s: too many requests.", name), 0)
			failed(st, "Lichess refused it: too many requests")
		})
		return false, "", 0
	} else if opponent {
		// The bot challenged has played its bot games for the day: leave it
		// be until Lichess says it may play again, and ask another.
		if wait <= 0 {
			wait = time.Hour
		}
		if wait > seekRest {
			b.restBot(u.ID, wait)
		}
		b.seekUpdate(sk, func(st *SeekStatus) {
			st.set("pause", fmt.Sprintf("%s has played as many bot games as Lichess allows today: passed over for %s.", name, waitText(wait)), seekPause)
			failed(st, fmt.Sprintf("It has played as many bot games as Lichess allows today; passed over for %s", waitText(wait)))
		})
		return false, "", seekPause
	}
	if err != nil {
		b.seekUpdate(sk, func(st *SeekStatus) {
			st.set("pause", fmt.Sprintf("Could not challenge %s: %v", name, err), seekPause)
			failed(st, err.Error())
		})
		return false, "", seekPause
	}
	b.mu.Lock()
	b.holdBackoff = 0 // a challenge went through: the next refusal starts at a minute again
	b.mu.Unlock()
	b.seekUpdate(sk, func(st *SeekStatus) {
		current(st, ch.ID, "waiting", "")
		st.Challenge.AnswerBy = time.UnixMilli(sent).Add(seekAnswerTimeout).UnixMilli()
		st.Phase, st.NextAt = "waiting", 0 // the message still says what was sent
	})
	answer := make(chan string, 1)
	b.mu.Lock()
	if a, ok := b.answered[ch.ID]; ok {
		answer <- a
	} else {
		b.waiters[ch.ID] = answer
	}
	sk.current = ch.ID
	b.mu.Unlock()
	defer func() {
		b.mu.Lock()
		delete(b.waiters, ch.ID)
		sk.current = ""
		b.mu.Unlock()
	}()

	var got string
	select {
	case got = <-answer:
	case <-time.After(seekAnswerTimeout):
		got = "timeout"
	case <-ctx.Done():
		got = "stopped"
	}
	if got == "accepted" {
		b.restBot(u.ID, 0) // it plays: it may be asked again for another game
		b.seekUpdate(sk, func(st *SeekStatus) {
			current(st, ch.ID, "accepted", "")
			st.set("pause", fmt.Sprintf("%s accepted.", name), 0)
		})
		return true, ch.ID, 0
	}
	if got == "timeout" || got == "stopped" {
		cctx, c := context.WithTimeout(context.Background(), 10*time.Second)
		client.Cancel(cctx, ch.ID)
		c()
		b.mu.Lock()
		delete(b.outgoing, ch.ID)
		b.mu.Unlock()
		b.emit()
	}
	if got == "stopped" {
		b.seekUpdate(sk, func(st *SeekStatus) { current(st, ch.ID, "gone", "") })
		return false, "", 0
	}
	why := "did not answer"
	state, reason := "expired", ""
	if got != "timeout" {
		why = "declined" + reasonText(got)
		state, reason = "declined", strings.TrimPrefix(reasonText(got), ": ")
		b.mu.Lock()
		filter := sk.params.Filter
		b.mu.Unlock()
		b.noteDecline(filter, u.ID, got, speed, p.Rated)
	}
	// Not asked again for a while, whatever the decline filter: at once
	// it would only decline again, and be one more challenge towards
	// Lichess's limit.
	b.seekUpdate(sk, func(st *SeekStatus) {
		st.set("pause", fmt.Sprintf("%s %s; it is not challenged again for %s.", name, why, waitText(seekRest)), seekPause)
		current(st, ch.ID, state, reason)
	})
	return false, "", seekPause
}
