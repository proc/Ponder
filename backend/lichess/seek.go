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
}

type seeker struct {
	params  SeekParams // under b.mu: UpdateSeek changes them as it runs
	rev     int        // counts the changes, so the search sees one
	cancel  context.CancelFunc
	status  SeekStatus
	current string // challenge id waiting for an answer
}

// Seek timings; variables so tests can shorten them.
var (
	seekAnswerTimeout = 30 * time.Second // then the challenge is cancelled
	seekPause         = 3 * time.Second  // after a failed request
	seekGap           = time.Minute      // at least this long from one challenge to the next
	seekRetry         = 30 * time.Second // when no bot is left to try
	seekPoll          = time.Second      // how often a game in progress is looked at
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
	if p.Around <= 0 && p.MinRating > 0 && p.MaxRating > 0 && p.MinRating > p.MaxRating {
		return errors.New("the lowest rating is above the highest")
	}
	if p.Around < 0 || p.MinGames < 0 {
		return errors.New("the rating range and number of games cannot be below 0")
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
		Active: true, Speed: SpeedOf(p.Limit, p.Increment), MinRating: p.MinRating, MaxRating: p.MaxRating,
		Message: "Looking for bots online…", Games: limit,
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
	if p.Around <= 0 && p.MinRating > 0 && p.MaxRating > 0 && p.MinRating > p.MaxRating {
		return false, errors.New("the lowest rating is above the highest")
	}
	if p.Around < 0 || p.MinGames < 0 {
		return false, errors.New("the rating range and number of games cannot be below 0")
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
	sk.status.Speed = SpeedOf(p.Limit, p.Increment)
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
		speed   string
		tried   map[string]bool
		exclude map[string]bool
		lo, hi  int
		mineAt  time.Time // when your bot's rating was read, for Around
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
		seen, params, speed = sk.rev, sk.params, sk.status.Speed
		b.mu.Unlock()
		tried = map[string]bool{}
		exclude = map[string]bool{}
		for _, n := range params.Exclude {
			if n = strings.ToLower(strings.TrimSpace(n)); n != "" {
				exclude[n] = true
			}
		}
		lo, hi = params.MinRating, params.MaxRating
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
				if !b.seekUpdate(sk, func(st *SeekStatus) { st.Playing, st.Current, st.Rating, st.NextAt, st.Message = true, "", 0, 0, msg }) {
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
			if !b.seekUpdate(sk, func(st *SeekStatus) { st.Playing, st.Message = false, "A game is over: looking for the next bot…" }) {
				return
			}
		}
		client, err := b.connected()
		if err != nil {
			b.seekUpdate(sk, func(st *SeekStatus) { st.Message = "Not connected to Lichess" })
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
		settings()
		if params.Around > 0 && time.Since(mineAt) > 5*time.Minute {
			mctx, mcancel := context.WithTimeout(ctx, 20*time.Second)
			u, err := client.UserInfo(mctx, me)
			mcancel()
			if ctx.Err() != nil {
				return
			}
			r := u.RatingFor(speed)
			if err != nil || r == 0 {
				msg := fmt.Sprintf("Your bot has no %s rating yet, so there is nothing to take the range around. Set a range instead.", speed)
				if err != nil {
					msg = "Could not read your bot's rating: " + err.Error()
				}
				b.seekUpdate(sk, func(st *SeekStatus) { st.Message = msg })
				if !sleepCtx(ctx, seekRetry) {
					return
				}
				continue
			}
			mineAt = time.Now()
			lo, hi = max(r-params.Around, 1), r+params.Around
			if !b.seekUpdate(sk, func(st *SeekStatus) { st.MinRating, st.MaxRating = lo, hi }) {
				return
			}
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
			b.seekUpdate(sk, func(st *SeekStatus) { st.Message = "Could not list the bots online: " + err.Error() })
			if !sleepCtx(ctx, wait) {
				return
			}
			continue
		}
		var pool []User
		for _, u := range bots {
			id := strings.ToLower(u.ID)
			if id == "" || id == me || tried[id] || !params.fits(u, speed, lo, hi, exclude) {
				continue
			}
			pool = append(pool, u)
		}
		if len(pool) == 0 {
			msg := fmt.Sprintf("No bot online fits your settings at %s right now (%d online). Trying again shortly…", speed, len(bots))
			if len(tried) > 0 {
				msg = fmt.Sprintf("Every matching bot online has been asked (%d). Asking again shortly…", len(tried))
				tried = map[string]bool{}
			}
			if !b.seekUpdate(sk, func(st *SeekStatus) { st.Current, st.Rating, st.Message = "", 0, msg }) {
				return
			}
			if !sleepCtx(ctx, seekRetry) {
				return
			}
			continue
		}
		// One challenge a minute at most, however quickly the last was answered.
		if wait := time.Until(lastSent.Add(seekGap)); !lastSent.IsZero() && wait > 0 {
			next := time.Now().Add(wait)
			if !b.seekUpdate(sk, func(st *SeekStatus) { st.NextAt = next.UnixMilli() }) {
				return
			}
			if !sleepCtx(ctx, wait) {
				return
			}
			continue // the bots online may have changed meanwhile
		}
		u := pool[rand.Intn(len(pool))]
		tried[strings.ToLower(u.ID)] = true
		lastSent = time.Now()
		accepted, id, retryAfter := b.seekOne(ctx, sk, client, u, speed, params.ChallengeParams)
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
				st.Played, st.Current, st.Rating, st.Message = played, "", 0, msg
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
		if !sleepCtx(ctx, retryAfter) {
			return
		}
	}
}

// seekOne challenges one bot and waits for the answer.
func (b *Bot) seekOne(ctx context.Context, sk *seeker, client *Client, u User, speed string, p ChallengeParams) (accepted bool, id string, next time.Duration) {
	name := u.DisplayName()
	rating := u.RatingFor(speed)
	if !b.seekUpdate(sk, func(st *SeekStatus) {
		st.Tried++
		st.NextAt = 0
		st.Current, st.Rating = name, rating
		st.Message = fmt.Sprintf("Challenging %s (%d)…", name, rating)
	}) {
		return false, "", 0
	}
	p.Username = u.ID
	if u.Username != "" {
		p.Username = u.Username
	}
	ch, err := b.challenge(p)
	if err != nil {
		wait := seekPause
		if RateLimited(err) {
			wait = time.Minute
		}
		b.seekUpdate(sk, func(st *SeekStatus) { st.Message = fmt.Sprintf("Could not challenge %s: %v", name, err) })
		return false, "", wait
	}
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
		return false, "", 0
	}
	why := "did not answer"
	if got != "timeout" {
		why = "declined" + reasonText(got)
	}
	b.seekUpdate(sk, func(st *SeekStatus) {
		st.Message = fmt.Sprintf("%s %s.", name, why)
	})
	return false, "", seekPause
}
