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
// challenge, and try the next one until a challenge is accepted.

// SeekParams is the challenge to send, without a username, and the rating
// range (0: no bound) at the time control's speed.
type SeekParams struct {
	ChallengeParams
	MinRating int `json:"minRating"`
	MaxRating int `json:"maxRating"`
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
	GameID    string `json:"gameId"` // the accepted challenge's game
}

type seeker struct {
	params  SeekParams
	cancel  context.CancelFunc
	status  SeekStatus
	current string // challenge id waiting for an answer
}

// Seek timings; variables so tests can shorten them.
var (
	seekAnswerTimeout = 30 * time.Second // then the challenge is cancelled
	seekPause         = 3 * time.Second  // between challenges
	seekRetry         = 30 * time.Second // when no bot is left to try
)

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
	if p.MinRating > 0 && p.MaxRating > 0 && p.MinRating > p.MaxRating {
		return errors.New("the lowest rating is above the highest")
	}
	b.StopSeek()
	ctx, cancel := context.WithCancel(context.Background())
	sk := &seeker{params: p, cancel: cancel, status: SeekStatus{
		Active: true, Speed: SpeedOf(p.Limit, p.Increment), MinRating: p.MinRating, MaxRating: p.MaxRating,
		Message: "Looking for bots online…",
	}}
	b.mu.Lock()
	b.seek = sk
	b.mu.Unlock()
	b.emit()
	go b.runSeek(ctx, sk)
	return nil
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
	speed := sk.status.Speed
	tried := map[string]bool{}
	for ctx.Err() == nil {
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
			if id == "" || id == me || tried[id] || !inRange(u.RatingFor(speed), sk.params.MinRating, sk.params.MaxRating) {
				continue
			}
			pool = append(pool, u)
		}
		if len(pool) == 0 {
			msg := fmt.Sprintf("No %s-rated bot online fits the range right now (%d online). Trying again shortly…", speed, len(bots))
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
		u := pool[rand.Intn(len(pool))]
		tried[strings.ToLower(u.ID)] = true
		accepted, retryAfter := b.seekOne(ctx, sk, client, u, speed)
		if accepted || ctx.Err() != nil {
			return
		}
		if !sleepCtx(ctx, retryAfter) {
			return
		}
	}
}

// seekOne challenges one bot and waits for the answer.
func (b *Bot) seekOne(ctx context.Context, sk *seeker, client *Client, u User, speed string) (accepted bool, next time.Duration) {
	name := u.DisplayName()
	rating := u.RatingFor(speed)
	if !b.seekUpdate(sk, func(st *SeekStatus) {
		st.Tried++
		st.Current, st.Rating = name, rating
		st.Message = fmt.Sprintf("Challenging %s (%d)…", name, rating)
	}) {
		return false, 0
	}
	p := sk.params.ChallengeParams
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
		return false, wait
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
		b.mu.Lock()
		if b.seek == sk {
			b.seek = nil
		}
		b.message = fmt.Sprintf("%s accepted the challenge.", name)
		b.mu.Unlock()
		sk.cancel()
		b.emit() // the game itself starts from the event stream
		return true, 0
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
		return false, 0
	}
	why := "did not answer"
	if got != "timeout" {
		why = "declined" + reasonText(got)
	}
	b.seekUpdate(sk, func(st *SeekStatus) {
		st.Message = fmt.Sprintf("%s %s. Trying another bot…", name, why)
	})
	return false, seekPause
}
