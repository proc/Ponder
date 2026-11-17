package lichess

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"board/backend/chess"
	"board/backend/game"
	"board/backend/uci"
)

// EngineConfig is the engine that plays the bot's games.
type EngineConfig struct {
	Name    string            `json:"name"`
	Path    string            `json:"path"`
	Args    []string          `json:"args"`
	Options map[string]string `json:"options"`
}

// Policy decides which incoming challenges are accepted while automatic
// accepting is on (it is off after every connect). Challenges the engine
// cannot play (variants, correspondence, unlimited) are then declined.
type Policy struct {
	Rated      bool    `json:"rated"`  // accept rated games
	Casual     bool    `json:"casual"` // accept casual games
	Humans     bool    `json:"humans"` // accept challenges from people
	Bots       bool    `json:"bots"`   // accept challenges from bots
	MinMinutes float64 `json:"minMinutes"`
	MaxMinutes float64 `json:"maxMinutes"` // 0: no limit
	MaxGames   int     `json:"maxGames"`   // games at once
	// Speeds turned off (ultraBullet, bullet, blitz, rapid, classical: false);
	// a speed not named is accepted.
	Speeds map[string]bool `json:"speeds,omitempty"`
	// The increment, in seconds (max 0: no limit).
	MinIncrement int `json:"minIncrement,omitempty"`
	MaxIncrement int `json:"maxIncrement,omitempty"`
	// The challenger's rating (0: no limit).
	MinRating int `json:"minRating,omitempty"`
	MaxRating int `json:"maxRating,omitempty"`
	// Decline games that start from a set-up position.
	NoFromPosition bool `json:"noFromPosition,omitempty"`
}

// Speeds are Lichess's speeds with a clock, fastest first.
var Speeds = []string{"ultraBullet", "bullet", "blitz", "rapid", "classical"}

// speedReason is why a challenge at speed is declined, or "" when the speed
// is accepted: too fast or too slow when every accepted speed is on one
// side of it.
func (p Policy) speedReason(speed string) string {
	if on, named := p.Speeds[speed]; !named || on {
		return ""
	}
	at, first, last := -1, -1, -1
	for i, sp := range Speeds {
		if sp == speed {
			at = i
		}
		if on, named := p.Speeds[sp]; !named || on {
			if first < 0 {
				first = i
			}
			last = i
		}
	}
	switch {
	case first >= 0 && at < first:
		return "tooFast"
	case last >= 0 && at > last:
		return "tooSlow"
	}
	return "timeControl"
}

type Config struct {
	BaseURL string       `json:"baseUrl"`
	Token   string       `json:"token"`
	Engine  EngineConfig `json:"engine"`
	Policy  Policy       `json:"policy"`
	// What the engine says in the chat of the games it plays.
	Greeting Greeting `json:"greeting"`
	// Ponder lets the engine think on its opponent's time, when it can.
	Ponder bool `json:"ponder"`
	// When the engine offers or accepts a draw.
	Draw DrawOffer `json:"draw"`
	// The endgame tablebase asked about drawn positions ("": Lichess's).
	TablebaseURL string `json:"tablebaseUrl"`
	// A challenge sent to a player is withdrawn when it has had no answer
	// for this many seconds (0: it waits until answered or cancelled).
	ChallengeTimeout int `json:"challengeTimeout"`
}

// ChallengeView and GameView describe challenges and games to the UI.
type ChallengeView struct {
	ID        string `json:"id"`
	URL       string `json:"url"`
	User      string `json:"user"`
	Title     string `json:"title"`
	Rating    int    `json:"rating"`
	Rated     bool   `json:"rated"`
	Speed     string `json:"speed"`
	TC        string `json:"tc"`
	Color     string `json:"color"`
	Variant   string `json:"variant"`
	Supported bool   `json:"supported"`
	Note      string `json:"note,omitempty"` // why it would be declined automatically
	// When a challenge sent is withdrawn for want of an answer (Unix ms).
	ExpiresAt int64 `json:"expiresAt,omitempty"`
}

type GameView struct {
	ID             string `json:"id"`
	URL            string `json:"url"`
	Opponent       string `json:"opponent"`
	OpponentTitle  string `json:"opponentTitle"`
	OpponentRating int    `json:"opponentRating"`
	Color          string `json:"color"`
	Rated          bool   `json:"rated"`
	Speed          string `json:"speed"`
	TC             string `json:"tc"`
	Status         string `json:"status"`
	Result         string `json:"result"`
	Moves          int    `json:"moves"`
	MyTurn         bool   `json:"myTurn"`
	Playing        bool   `json:"playing"` // the engine plays this game
	// "theirs" while the opponent's draw offer waits for an answer: the
	// engine's next move declines it unless its draw rules accept.
	DrawOffer string `json:"drawOffer,omitempty"`
	Finished  bool   `json:"finished"`
	Message   string `json:"message,omitempty"`
	// The position now and the last move (UCI), for a small board of each
	// game when the engine plays several at once.
	Fen      string `json:"fen,omitempty"`
	LastMove string `json:"lastMove,omitempty"`
}

// Status is sent to the UI as the "lichess" event.
type Status struct {
	State string `json:"state"` // off, connecting, connected, reconnecting, notBot, error
	// Accepting challenges automatically: off until turned on after connecting.
	AutoAccept bool            `json:"autoAccept"`
	Message    string          `json:"message"`
	Account    *Account        `json:"account"`
	BaseURL    string          `json:"baseUrl"`
	Incoming   []ChallengeView `json:"incoming"`
	Outgoing   []ChallengeView `json:"outgoing"`
	Games      []GameView      `json:"games"`
	Watching   string          `json:"watching"`
	Seek       *SeekStatus     `json:"seek"`
}

// Hooks connect the bot to the rest of the app.
type Hooks struct {
	Emit      func(event string, data any) // UI events
	Show      func(game.ExternalView)      // show a game on the board
	AutoWatch func() bool                  // may a new game take over the board?
	// Save receives the PGN of each finished game the engine played.
	Save func(pgn string)
}

const finishedKept = 20

type Bot struct {
	mu      sync.Mutex
	hooks   Hooks
	cfg     Config
	client  *Client
	cancel  context.CancelFunc
	gen     int
	state   string
	message string
	account *Account

	incoming map[string]*Challenge
	outgoing map[string]*Challenge
	expires  map[string]time.Time // when challenges sent are withdrawn
	games    map[string]*runner
	order    []string // game ids, oldest first
	watching string
	// Connecting plays nothing by itself: the engine plays only games that
	// start from a challenge accepted or sent here (expect), or accepted
	// automatically once that is turned on, and games given to it with Play.
	autoAccept bool
	expect     map[string]bool
	// Answers to challenges sent here: "accepted", or the decline reason.
	answered map[string]string
	waiters  map[string]chan string
	seek     *seeker
	sending  bool // a challenge request is on its way
	// Challenges accepted whose games have not started yet, and when: they
	// already take a place under the limit of games at once.
	accepted map[string]time.Time
}

func NewBot(h Hooks) *Bot {
	return &Bot{hooks: h, state: "off", expect: map[string]bool{}, answered: map[string]string{}, waiters: map[string]chan string{}, incoming: map[string]*Challenge{}, outgoing: map[string]*Challenge{}, games: map[string]*runner{}, accepted: map[string]time.Time{}}
}

// Connect checks the token and account, then follows the event stream.
// An account that is not a Bot account is reported as state "notBot".
func (b *Bot) Connect(cfg Config) (Status, error) {
	b.Disconnect(false)
	client := NewClient(cfg.BaseURL, cfg.Token)
	if client.Token == "" {
		return b.Status(), errors.New("enter a Lichess API token first")
	}
	b.mu.Lock()
	b.gen++
	gen := b.gen
	b.cfg, b.client = cfg, client
	b.state, b.message, b.account = "connecting", "", nil
	b.autoAccept = false
	b.mu.Unlock()
	b.emit()

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	acct, err := client.Account(ctx)
	cancel()
	b.mu.Lock()
	if gen != b.gen {
		b.mu.Unlock()
		return b.Status(), errors.New("superseded")
	}
	if err != nil {
		b.state, b.message = "error", err.Error()
		b.mu.Unlock()
		b.emit()
		return b.Status(), err
	}
	b.account = &acct
	if !acct.IsBot() {
		b.state = "notBot"
		b.message = acct.Username + " is not a Bot account. Only Bot accounts can play through the Bot API."
		b.mu.Unlock()
		b.emit()
		return b.Status(), nil
	}
	runCtx, runCancel := context.WithCancel(context.Background())
	b.cancel = runCancel
	b.state, b.message = "connected", ""
	b.mu.Unlock()
	go b.follow(runCtx, gen)
	b.emit()
	return b.Status(), nil
}

// UpgradeToBot upgrades the connected account to a Bot account (cannot be
// undone), then connects again.
func (b *Bot) UpgradeToBot() (Status, error) {
	b.mu.Lock()
	client, cfg := b.client, b.cfg
	b.mu.Unlock()
	if client == nil {
		return b.Status(), errors.New("not connected to Lichess")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := client.UpgradeToBot(ctx); err != nil {
		return b.Status(), err
	}
	return b.Connect(cfg)
}

// Configure changes the engine, challenge policy and chat messages without
// reconnecting.
// A new engine is used from the next game.
func (b *Bot) Configure(engine EngineConfig, policy Policy, greeting Greeting, ponder bool, draw DrawOffer) {
	b.mu.Lock()
	b.cfg.Engine, b.cfg.Policy, b.cfg.Greeting, b.cfg.Ponder, b.cfg.Draw = engine, policy, greeting, ponder, draw
	b.mu.Unlock()
	b.emit()
}

// Disconnect stops following Lichess. With resign, games in progress are
// resigned first; otherwise their engines simply stop (and the games will be
// lost on time).
func (b *Bot) Disconnect(resign bool) {
	b.mu.Lock()
	cancel, client := b.cancel, b.client
	var running []*runner
	for _, r := range b.games {
		if !r.finished {
			running = append(running, r)
		}
	}
	b.gen++
	b.cancel = nil
	b.state, b.message, b.account = "off", "", nil
	b.incoming, b.outgoing = map[string]*Challenge{}, map[string]*Challenge{}
	b.expect = map[string]bool{}
	b.accepted = map[string]time.Time{}
	b.autoAccept = false
	seek := b.seek
	b.seek = nil
	b.mu.Unlock()
	if seek != nil {
		seek.cancel()
	}
	if resign && client != nil {
		for _, r := range running {
			if !r.play {
				continue // only the games the engine is playing
			}
			ctx, c := context.WithTimeout(context.Background(), 10*time.Second)
			client.Resign(ctx, r.id)
			c()
		}
	}
	for _, r := range running {
		r.stop()
	}
	if cancel != nil {
		cancel()
	}
	b.mu.Lock()
	b.games, b.order, b.watching = map[string]*runner{}, nil, ""
	b.mu.Unlock()
	b.emit()
}

// follow keeps the event stream open, reconnecting with back-off.
func (b *Bot) follow(ctx context.Context, gen int) {
	backoff := time.Second
	for ctx.Err() == nil {
		b.mu.Lock()
		client := b.client
		b.mu.Unlock()
		started := time.Now()
		err := client.StreamEvents(ctx, func(e Event) { b.onEvent(ctx, gen, e) })
		if ctx.Err() != nil {
			return
		}
		if time.Since(started) > time.Minute {
			backoff = time.Second
		}
		wait := backoff
		msg := "Connection to Lichess lost; reconnecting…"
		if RateLimited(err) {
			wait, msg = time.Minute, "Lichess asked to slow down; reconnecting in a minute…"
		} else if err != nil {
			msg = fmt.Sprintf("Connection to Lichess lost (%v); reconnecting…", err)
		}
		b.mu.Lock()
		if gen == b.gen {
			b.state, b.message = "reconnecting", msg
		}
		b.mu.Unlock()
		b.emit()
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
		if backoff < 30*time.Second {
			backoff *= 2
		}
		b.mu.Lock()
		if gen == b.gen && b.state == "reconnecting" {
			b.state, b.message = "connected", ""
		}
		b.mu.Unlock()
	}
}

func (b *Bot) onEvent(ctx context.Context, gen int, e Event) {
	b.mu.Lock()
	if gen != b.gen {
		b.mu.Unlock()
		return
	}
	if b.state == "reconnecting" {
		b.state, b.message = "connected", ""
	}
	me := b.account.ID
	switch e.Type {
	case "challenge":
		ch := e.Challenge
		if ch == nil {
			break
		}
		if strings.EqualFold(ch.Challenger.ID, me) {
			b.outgoing[ch.ID] = ch
			break
		}
		reason := b.declineReason(ch, true)
		auto := b.autoAccept
		if auto && reason != "" {
			b.mu.Unlock()
			b.decline(ctx, ch.ID, reason)
			b.emit()
			return
		}
		if auto {
			b.expect[ch.ID] = true
			b.accepted[ch.ID] = time.Now() // it has its place before the next challenge is looked at
			b.mu.Unlock()
			if err := b.client.Accept(ctx, ch.ID); err != nil {
				b.mu.Lock()
				delete(b.accepted, ch.ID)
				b.mu.Unlock()
				b.note(fmt.Sprintf("Could not accept %s's challenge: %v", ch.Challenger.DisplayName(), err))
			}
			b.emit()
			return
		}
		b.incoming[ch.ID] = ch
	case "challengeCanceled", "challengeDeclined":
		if ch := e.Challenge; ch != nil {
			delete(b.incoming, ch.ID)
			delete(b.accepted, ch.ID)
			reason := ch.DeclineReason
			if reason == "" {
				reason = map[string]string{"challengeCanceled": "canceled", "challengeDeclined": "generic"}[e.Type]
			}
			seeking := b.seek != nil && b.seek.current == ch.ID
			b.answerLocked(ch.ID, reason)
			if _, ours := b.outgoing[ch.ID]; ours && e.Type == "challengeDeclined" && !seeking {
				who := "The challenge"
				if ch.DestUser != nil {
					who = ch.DestUser.DisplayName()
				}
				b.message = fmt.Sprintf("%s declined the challenge%s.", who, reasonText(ch.DeclineReason))
			}
			delete(b.outgoing, ch.ID)
		}
	case "gameStart":
		if g := e.Game; g != nil {
			id := g.Key()
			b.answerLocked(id, "accepted")
			delete(b.incoming, id)
			delete(b.outgoing, id)
			delete(b.accepted, id)
			if r, ok := b.games[id]; ok && !r.finished {
				break // already playing (the stream resends games on reconnect)
			}
			r := newRunner(b, id, g)
			// Games already going when connecting, or started elsewhere,
			// are listed but not played until Play is pressed.
			r.play = b.expect[id]
			delete(b.expect, id)
			b.games[id] = r
			b.order = append(b.order, id)
			b.trimFinished()
			watch := r.play && (b.watching == "" || b.games[b.watching] == nil || b.games[b.watching].finished)
			b.mu.Unlock()
			if watch && b.hooks.AutoWatch != nil && b.hooks.AutoWatch() {
				b.Watch(id)
			}
			go r.run(ctx)
			b.emit()
			return
		}
	case "gameFinish":
		// The game's own stream reports how it ended.
	}
	b.mu.Unlock()
	b.emit()
}

// acceptedWait is how long an accepted challenge holds a place while its
// game has not started (Lichess starts it at once; this is for one that
// never does).
const acceptedWait = 30 * time.Second

// committedLocked counts the games the engine is in or about to be in,
// leaving out challenge id: games being played, challenges accepted whose
// games are about to start, and the challenge the engine sent that waits
// for an answer (accepted, it is a game too).
func (b *Bot) committedLocked(except string) int {
	n := 0
	for _, r := range b.games {
		if !r.finished {
			n++
		}
	}
	for id, at := range b.accepted {
		switch {
		case time.Since(at) > acceptedWait:
			delete(b.accepted, id)
		case id != except && b.games[id] == nil:
			n++
		}
	}
	for id := range b.outgoing {
		if id != except && b.games[id] == nil {
			n++
		}
	}
	if b.sending {
		n++
	}
	return n
}

// declineReason says why a challenge would be declined, or "" to accept it.
// Without policy, only what the engine cannot play counts.
func (b *Bot) declineReason(ch *Challenge, policy bool) string {
	switch {
	case ch.Variant.Key != "standard" && ch.Variant.Key != "fromPosition" && ch.Variant.Key != "":
		return "standard"
	case ch.TimeControl.Type != "clock":
		return "timeControl"
	}
	if !policy {
		return ""
	}
	p := b.cfg.Policy
	minutes := float64(ch.TimeControl.Limit) / 60
	isBot := ch.Challenger.Title == "BOT"
	speedReason := p.speedReason(SpeedOf(ch.TimeControl.Limit, ch.TimeControl.Increment))
	rating := ch.Challenger.Rating
	active := b.committedLocked(ch.ID)
	maxGames := p.MaxGames
	if maxGames < 1 {
		maxGames = 1
	}
	switch {
	case isBot && !p.Bots:
		return "noBot"
	case !isBot && !p.Humans:
		return "onlyBot"
	case ch.Rated && !p.Rated:
		return "casual"
	case !ch.Rated && !p.Casual:
		return "rated"
	case p.NoFromPosition && ch.Variant.Key == "fromPosition":
		return "standard"
	case minutes < p.MinMinutes:
		return "tooFast"
	case p.MaxMinutes > 0 && minutes > p.MaxMinutes:
		return "tooSlow"
	case ch.TimeControl.Increment < p.MinIncrement:
		return "timeControl"
	case p.MaxIncrement > 0 && ch.TimeControl.Increment > p.MaxIncrement:
		return "timeControl"
	case speedReason != "":
		return speedReason
	case rating > 0 && (rating < p.MinRating || p.MaxRating > 0 && rating > p.MaxRating):
		return "generic"
	case active >= maxGames:
		return "later"
	}
	return ""
}

func reasonText(r string) string {
	switch r {
	case "", "generic":
		return ""
	case "tooFast":
		return ": too fast"
	case "tooSlow":
		return ": too slow"
	case "timeControl":
		return ": time control"
	case "rated":
		return ": wants a rated game"
	case "casual":
		return ": wants a casual game"
	case "noBot":
		return ": does not play bots"
	case "later":
		return ": later"
	}
	return ": " + r
}

func (b *Bot) decline(ctx context.Context, id, reason string) {
	if reason == "" {
		reason = "generic"
	}
	if err := b.client.Decline(ctx, id, reason); err != nil {
		b.note("Could not decline a challenge: " + err.Error())
	}
}

// note shows a message in the Lichess panel.
func (b *Bot) note(msg string) {
	b.mu.Lock()
	b.message = msg
	b.mu.Unlock()
	b.emit()
}

// trimFinished keeps the most recent finished games only.
func (b *Bot) trimFinished() {
	finished := 0
	for i := len(b.order) - 1; i >= 0; i-- {
		id := b.order[i]
		if r := b.games[id]; r != nil && r.finished {
			finished++
			if finished > finishedKept && id != b.watching {
				delete(b.games, id)
				b.order = append(b.order[:i], b.order[i+1:]...)
			}
		}
	}
}

// --- actions from the UI ---

func (b *Bot) connected() (*Client, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.client == nil || (b.state != "connected" && b.state != "reconnecting") {
		return nil, errors.New("not connected to Lichess")
	}
	return b.client, nil
}

func (b *Bot) Accept(id string) error {
	client, err := b.connected()
	if err != nil {
		return err
	}
	b.mu.Lock()
	ch := b.incoming[id]
	b.mu.Unlock()
	if ch != nil {
		if r := b.declineReason(ch, false); r != "" {
			return errors.New("the engine cannot play this kind of game")
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	b.mu.Lock()
	b.expect[id] = true
	b.accepted[id] = time.Now()
	b.mu.Unlock()
	if err := client.Accept(ctx, id); err != nil {
		b.mu.Lock()
		delete(b.expect, id)
		delete(b.accepted, id)
		b.mu.Unlock()
		return err
	}
	b.mu.Lock()
	delete(b.incoming, id)
	b.mu.Unlock()
	b.emit()
	return nil
}

func (b *Bot) Decline(id, reason string) error {
	client, err := b.connected()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if reason == "" {
		reason = "generic"
	}
	if err := client.Decline(ctx, id, reason); err != nil {
		return err
	}
	b.mu.Lock()
	delete(b.incoming, id)
	b.mu.Unlock()
	b.emit()
	return nil
}

// answerLocked records how a challenge sent here was answered, for a
// random-bot search waiting on it.
func (b *Bot) answerLocked(id, answer string) {
	if len(b.answered) > 500 {
		b.answered = map[string]string{}
	}
	b.answered[id] = answer
	if ch := b.waiters[id]; ch != nil {
		delete(b.waiters, id)
		ch <- answer
	}
}

// Challenge sends one challenge. Only one may wait for an answer at a time,
// and none while the engine is playing or looking for a random bot.
func (b *Bot) Challenge(p ChallengeParams) error {
	b.mu.Lock()
	busy := b.busyLocked()
	if busy == "" && b.seek != nil {
		busy = "Stop the random-bot search before challenging someone yourself."
	}
	if busy != "" {
		b.mu.Unlock()
		return errors.New(busy)
	}
	b.sending = true
	b.mu.Unlock()
	defer func() {
		b.mu.Lock()
		b.sending = false
		b.mu.Unlock()
	}()
	ch, err := b.challenge(p)
	if err == nil && ch.ID != "" {
		b.expireLater(ch.ID)
	}
	return err
}

// SetChallengeTimeout changes how long a challenge sent waits for an
// answer (seconds; 0: for ever). Challenges already out keep their time.
func (b *Bot) SetChallengeTimeout(secs int) {
	b.mu.Lock()
	b.cfg.ChallengeTimeout = secs
	b.mu.Unlock()
}

// expireLater withdraws the challenge if it is still waiting for an answer
// once the time allowed has passed.
func (b *Bot) expireLater(id string) {
	b.mu.Lock()
	secs := b.cfg.ChallengeTimeout
	_, waiting := b.outgoing[id]
	if secs <= 0 || !waiting {
		b.mu.Unlock()
		return
	}
	d := time.Duration(secs) * time.Second
	if b.expires == nil {
		b.expires = map[string]time.Time{}
	}
	b.expires[id] = time.Now().Add(d)
	b.mu.Unlock()
	b.emit()
	time.AfterFunc(d, func() {
		b.mu.Lock()
		ch, waiting := b.outgoing[id]
		delete(b.expires, id)
		name := ""
		if waiting {
			name = ch.DestName()
		}
		b.mu.Unlock()
		if !waiting || b.Cancel(id) != nil {
			return
		}
		b.note(fmt.Sprintf("%s did not answer in %d s: the challenge was withdrawn.", name, secs))
	})
}

// busyLocked says why the engine cannot send a new challenge now, or "".
func (b *Bot) busyLocked() string {
	if b.sending {
		return "A challenge is already being sent."
	}
	for _, ch := range b.outgoing {
		return fmt.Sprintf("Your challenge to %s is waiting for an answer. Cancel it to challenge someone else.", ch.DestName())
	}
	for _, r := range b.games {
		if !r.finished {
			return "Your engine is playing a game. Challenge again when it is over."
		}
	}
	for id, at := range b.accepted {
		if b.games[id] == nil && time.Since(at) <= acceptedWait {
			return "Your engine accepted a challenge and its game is about to start."
		}
	}
	return ""
}

func (b *Bot) challenge(p ChallengeParams) (Challenge, error) {
	client, err := b.connected()
	if err != nil {
		return Challenge{}, err
	}
	if strings.TrimSpace(p.Username) == "" {
		return Challenge{}, errors.New("enter the username to challenge")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	ch, err := client.Challenge(ctx, p)
	if err != nil {
		return Challenge{}, err
	}
	b.mu.Lock()
	if _, done := b.answered[ch.ID]; done && b.games[ch.ID] == nil {
		// Declined before the answer to the request arrived.
	} else if ch.ID != "" {
		if r, started := b.games[ch.ID]; !started {
			b.outgoing[ch.ID] = &ch
			b.expect[ch.ID] = true
		} else if !r.play {
			// The game began before this answer arrived.
			b.mu.Unlock()
			b.Play(ch.ID)
			b.mu.Lock()
		}
	}
	b.message = ""
	b.mu.Unlock()
	b.emit()
	return ch, nil
}

func (b *Bot) Cancel(id string) error {
	client, err := b.connected()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := client.Cancel(ctx, id); err != nil {
		return err
	}
	b.mu.Lock()
	delete(b.outgoing, id)
	b.mu.Unlock()
	b.emit()
	return nil
}

func (b *Bot) Resign(id string) error {
	client, err := b.connected()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	return client.Resign(ctx, id)
}

// Draw answers the opponent's draw offer in a game: yes accepts it (the
// game is drawn), no declines it.
func (b *Bot) Draw(id string, yes bool) error {
	client, err := b.connected()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	return client.Draw(ctx, id, yes)
}

func (b *Bot) Abort(id string) error {
	client, err := b.connected()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	return client.Abort(ctx, id)
}

func (b *Bot) OnlineBots() ([]User, error) {
	client, err := b.connected()
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	return client.OnlineBots(ctx, 100)
}

// Watch shows a bot game on the board; Unwatch stops updating the board.
func (b *Bot) Watch(id string) error {
	b.mu.Lock()
	r := b.games[id]
	if r == nil {
		b.mu.Unlock()
		return errors.New("no such game")
	}
	b.watching = id
	v, ok := r.viewLocked()
	// What the engine thought of the moves it has played, so that the
	// scores of the whole game show, not only of the moves watched live.
	var infos []game.EngineInfo
	for ply := 0; ply <= len(r.moves); ply++ {
		if in, ok := r.chosen[ply]; ok {
			infos = append(infos, in)
		}
	}
	if !r.finished && r.thinking == len(r.moves) && r.lastLinePly == len(r.moves) && len(r.lastLine.PV) > 0 {
		infos = append(infos, r.infoLocked(r.lastLine)) // and of the move it is thinking about
	}
	b.mu.Unlock()
	if ok && b.hooks.Show != nil {
		b.hooks.Show(v)
		if b.hooks.Emit != nil {
			for _, in := range infos {
				b.hooks.Emit("engineInfo", in)
			}
		}
	}
	b.emit()
	return nil
}

func (b *Bot) Unwatch() {
	b.mu.Lock()
	changed := b.watching != ""
	b.watching = ""
	b.mu.Unlock()
	if changed {
		b.emit()
	}
}

// Status describes the bot for the UI.
func (b *Bot) Status() Status {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.statusLocked()
}

func (b *Bot) statusLocked() Status {
	s := Status{State: b.state, AutoAccept: b.autoAccept, Message: b.message, Seek: b.seekStatusLocked(), Account: b.account, BaseURL: b.cfg.BaseURL,
		Incoming: []ChallengeView{}, Outgoing: []ChallengeView{}, Games: []GameView{}, Watching: b.watching}
	if s.BaseURL == "" {
		s.BaseURL = DefaultBaseURL
	}
	for _, ch := range b.incoming {
		v := challengeView(ch, ch.Challenger)
		v.Supported = b.declineReason(ch, false) == ""
		if r := b.declineReason(ch, true); r != "" {
			v.Note = strings.TrimPrefix(reasonText(r), ": ")
		}
		s.Incoming = append(s.Incoming, v)
	}
	for _, ch := range b.outgoing {
		u := User{}
		if ch.DestUser != nil {
			u = *ch.DestUser
		}
		v := challengeView(ch, u)
		if at, ok := b.expires[ch.ID]; ok {
			v.ExpiresAt = at.UnixMilli()
		}
		s.Outgoing = append(s.Outgoing, v)
	}
	sort.Slice(s.Incoming, func(i, j int) bool { return s.Incoming[i].ID < s.Incoming[j].ID })
	sort.Slice(s.Outgoing, func(i, j int) bool { return s.Outgoing[i].ID < s.Outgoing[j].ID })
	for i := len(b.order) - 1; i >= 0; i-- { // newest first
		if r := b.games[b.order[i]]; r != nil {
			s.Games = append(s.Games, r.gameViewLocked())
		}
	}
	return s
}

func challengeView(ch *Challenge, u User) ChallengeView {
	tc := ch.TimeControl.Show
	if tc == "" && ch.TimeControl.Type == "clock" {
		tc = fmt.Sprintf("%g+%d", float64(ch.TimeControl.Limit)/60, ch.TimeControl.Increment)
	} else if tc == "" {
		tc = ch.TimeControl.Type
	}
	return ChallengeView{
		ID: ch.ID, URL: ch.URL, User: u.DisplayName(), Title: u.Title, Rating: u.Rating,
		Rated: ch.Rated, Speed: ch.Speed, TC: tc, Color: ch.Color, Variant: ch.Variant.Name,
	}
}

// emit sends the status to the UI.
func (b *Bot) emit() {
	if b.hooks.Emit != nil {
		b.hooks.Emit("lichess", b.Status())
	}
}

// --- games ---

// runner plays one game: it follows the game stream and asks the engine
// for a move whenever it is the bot's turn. Its fields are guarded by Bot.mu.
type runner struct {
	ratingDiff *game.RatingDiff // once a rated game is over
	b          *Bot
	id         string
	info       *GameInfo
	ctx        context.Context
	cancel     context.CancelFunc

	color        chess.Color
	white, black GamePlayer
	rated        bool
	speed        string
	tc           string
	startFEN     string
	start        chess.Position
	pos          chess.Position
	moves        []string
	state        GameState
	stateAt      time.Time
	finished     bool
	result       string
	reason       string
	message      string
	started      bool // gameFull received

	play bool // the engine plays this game
	// The clock, in seconds, for the PGN.
	initial, increment int64
	eng                *uci.Engine
	engPath            string   // what the engine was started from,
	engArgs            []string // to find it when its options change
	pendingOpts        []string // option changes for before its next search
	greeted            bool     // hello was said (or it was too late to)
	thinking           int      // ply the engine is searching for, or -1
	lastInfo           time.Time
	lastStats          time.Time // when the depth and counts were last sent on their own
	// The engine's newest search line, and the ply it is for: what the
	// arrows show once it has chosen its move.
	lastLine    uci.Info
	lastLinePly int
	ponder      string // the reply it named with its move
	// What the engine made of each position it moved in (its score, depth
	// and line), by the number of moves played before: shown again when the
	// game is put on the board later.
	chosen map[int]game.EngineInfo

	// Pondering: thinking on the opponent's time about the reply the engine
	// expects. canPonder: it is turned on and the engine offers it.
	canPonder bool
	// The reply to ponder on once the engine's move is on the board: after
	// nextAfter was played as move number nextPly.
	nextPonder, nextAfter string
	nextPly               int
	// The reply being pondered on ("" when not), and how many moves had
	// been played when it began.
	pondering  string
	ponderBase int
	ponderLine uci.Info // its newest line while pondering
	// The move number (moves played before it) of the search that began as
	// a ponder hit, or -1.
	hitPly int
	// Answers to ignore: each "stop" of a ponder search that missed is
	// answered with a bestmove nobody asked for.
	discard int
	chat    chatLog
	// The engine's score (its own side's, centipawns) for each move it
	// chose, and what the tablebase was asked and said, by move number.
	scores  []int
	tbAsked map[int]bool
	tbDraw  map[int]bool
	// Moves sent with a draw offer.
	drawOffers int
}

func newRunner(b *Bot, id string, info *GameInfo) *runner {
	r := &runner{b: b, id: id, info: info, thinking: -1, hitPly: -1}
	if info.Color == "black" {
		r.color = chess.Black
	}
	r.rated, r.speed = info.Rated, info.Speed
	r.start, _ = chess.ParseFEN(chess.StartFEN)
	r.pos, r.startFEN = r.start, chess.StartFEN
	return r
}

func (r *runner) url() string {
	base := r.b.cfg.BaseURL
	if base == "" {
		base = DefaultBaseURL
	}
	return strings.TrimRight(base, "/") + "/" + r.id
}

func (r *runner) stop() {
	r.b.mu.Lock()
	cancel, eng := r.cancel, r.eng
	r.eng = nil
	r.b.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	if eng != nil {
		eng.Quit()
	}
}

func (r *runner) run(parent context.Context) {
	ctx, cancel := context.WithCancel(parent)
	b := r.b
	b.mu.Lock()
	r.ctx, r.cancel = ctx, cancel
	cfg := b.cfg.Engine
	client := b.client
	b.mu.Unlock()
	defer cancel()

	b.mu.Lock()
	play := r.play
	b.mu.Unlock()
	if play {
		if err := r.startEngine(cfg); err != nil {
			b.mu.Lock()
			r.play = false
			b.mu.Unlock()
			r.setMessage("Could not start the engine: " + err.Error() + ". Resign or abort the game, or press Play to try again.")
		}
	}
	backoff := time.Second
	for ctx.Err() == nil {
		err := client.StreamGame(ctx, r.id, r.onGameEvent)
		b.mu.Lock()
		done := r.finished
		b.mu.Unlock()
		if done || ctx.Err() != nil {
			break
		}
		wait := backoff
		if RateLimited(err) {
			wait = time.Minute
		}
		select {
		case <-ctx.Done():
		case <-time.After(wait):
		}
		if backoff < 15*time.Second {
			backoff *= 2
		}
	}
	r.stopEngine()
}

func (r *runner) startEngine(cfg EngineConfig) error {
	if cfg.Path == "" {
		return errors.New("no engine chosen for Lichess games")
	}
	eng, err := uci.Start(cfg.Path, cfg.Args, uci.Handlers{
		OnInfo:     r.onInfo,
		OnPonder:   r.onPonder,
		OnBestMove: r.onBestMove,
		OnExit: func() {
			r.setMessage("The engine stopped unexpectedly")
		},
	})
	if err != nil {
		return err
	}
	// Its options first, as it is loaded; Ponder is set below. Engines that
	// can give their win/draw/loss chances are asked to, for its window.
	if err := eng.ApplyOptions(uci.WithWDL(eng.Options, cfg.Options), "Ponder"); err != nil {
		eng.Quit()
		return err
	}
	// An engine that can ponder says so with a Ponder option; setting it
	// tells the engine it will be asked to (it manages its time for it).
	r.b.mu.Lock()
	ponder := r.b.cfg.Ponder
	r.b.mu.Unlock()
	canPonder := false
	if ponder {
		for _, o := range eng.Options {
			if strings.EqualFold(o.Name, "Ponder") {
				eng.SetOption(o.Name, "true")
				canPonder = true
			}
		}
	}
	if err := eng.NewGame(); err != nil {
		eng.Quit()
		return err
	}
	r.b.mu.Lock()
	r.eng = eng
	r.engPath, r.engArgs, r.pendingOpts = cfg.Path, cfg.Args, nil
	r.canPonder = canPonder
	r.pondering, r.nextPonder, r.discard = "", "", 0
	r.b.mu.Unlock()
	return nil
}

// UpdateEngineOptions gives the engine of every game in progress that was
// started from path with args its newly saved options: at once when it is
// not searching, otherwise before its next search. Ponder stays as the bot
// set it. It returns how many games' engines it reached.
func (b *Bot) UpdateEngineOptions(path string, args []string, opts map[string]string) int {
	b.mu.Lock()
	if game.SameEngine(path, args, b.cfg.Engine.Path, b.cfg.Engine.Args) {
		b.cfg.Engine.Options = opts
	}
	type send struct {
		eng  *uci.Engine
		cmds []string
	}
	var now []send
	n := 0
	for _, r := range b.games {
		if r.eng == nil || r.finished || !game.SameEngine(path, args, r.engPath, r.engArgs) {
			continue
		}
		n++
		cmds := uci.OptionCommands(r.eng.OptionChanges(uci.WithWDL(r.eng.Options, opts), "Ponder"))
		if len(cmds) == 0 {
			continue
		}
		// Searching: its own move, or pondering, or a stopped search still
		// to answer.
		busy := r.pondering != "" || r.discard > 0 || (r.pos.Turn == r.color && r.thinking == len(r.moves))
		if busy {
			r.pendingOpts = append(r.pendingOpts, cmds...)
		} else {
			now = append(now, send{r.eng, cmds})
		}
	}
	b.mu.Unlock()
	for _, s := range now {
		for _, c := range s.cmds {
			s.eng.Send(c)
		}
	}
	return n
}

func (r *runner) stopEngine() {
	r.b.mu.Lock()
	eng := r.eng
	r.eng = nil
	r.b.mu.Unlock()
	if eng != nil {
		eng.Quit()
	}
}

func (r *runner) setMessage(msg string) {
	r.b.mu.Lock()
	r.message = msg
	r.b.mu.Unlock()
	r.b.emit()
}

func (r *runner) onGameEvent(e GameEvent) {
	b := r.b
	switch e.Type {
	case "gameFull":
		b.mu.Lock()
		r.started = true
		r.white, r.black, r.rated, r.speed = e.White, e.Black, e.Rated, e.Speed
		me := ""
		if b.account != nil {
			me = b.account.ID
		}
		if strings.EqualFold(e.Black.ID, me) {
			r.color = chess.Black
		} else if strings.EqualFold(e.White.ID, me) {
			r.color = chess.White
		}
		if e.Clock != nil {
			r.initial, r.increment = e.Clock.Initial/1000, e.Clock.Increment/1000
			r.tc = fmt.Sprintf("%g+%d", float64(e.Clock.Initial)/60000, e.Clock.Increment/1000)
		}
		fen := e.InitialFen
		if fen == "" || fen == "startpos" {
			fen = chess.StartFEN
		}
		if p, err := chess.ParseFEN(fen); err == nil {
			r.start, r.startFEN = p, p.FEN()
		}
		b.mu.Unlock()
		r.seedChat()
		if e.State != nil {
			r.onState(*e.State)
		}
		r.sayHello()
	case "gameState":
		r.onState(e.GameState)
	case "chatLine":
		r.onChatLine(e)
	case "opponentGone":
		if e.Gone {
			r.setMessage("The opponent left the game")
		} else {
			r.setMessage("")
		}
	}
}

// parseMove reads a move from the game stream; castling may be given king
// to rook (e1h1), as in Chess960 notation.
func parseMove(pos *chess.Position, s string) (chess.Move, error) {
	m, err := pos.ParseUCIMove(s)
	if err == nil || len(s) != 4 {
		return m, err
	}
	from, to := s[:2], s[2:]
	kingSq := map[string]bool{"e1": true, "e8": true}
	if !kingSq[from] {
		return m, err
	}
	switch to[0] {
	case 'h':
		return pos.ParseUCIMove(from + "g" + to[1:])
	case 'a':
		return pos.ParseUCIMove(from + "c" + to[1:])
	}
	return m, err
}

func (r *runner) onState(st GameState) {
	b := r.b
	b.mu.Lock()
	pos := r.start
	var moves []string
	for _, s := range strings.Fields(st.Moves) {
		m, err := parseMove(&pos, s)
		if err != nil {
			r.message = fmt.Sprintf("Could not follow the game: move %q is not legal here", s)
			break
		}
		moves = append(moves, m.UCI())
		pos = pos.Make(m)
	}
	r.pos, r.moves, r.state, r.stateAt = pos, moves, st, time.Now()
	ended := st.Status != "" && st.Status != "started" && st.Status != "created"
	var cmds []string // for the engine, in order
	eng := r.eng
	var save string
	var bye []chatSend
	if ended && !r.finished {
		r.finished = true
		r.result, r.reason = resultOf(st)
		if r.play && r.result != "*" && b.hooks.Save != nil {
			save, _ = r.pgnLocked()
		}
		if r.rated && r.result != "*" && b.client != nil {
			go r.ratingDiffs(b.client)
		}
		if r.play && r.result != "*" {
			bye = b.cfg.Greeting.lines(false, b.meLocked(), r.opponent().DisplayName())
		}
	} else if !ended && eng != nil {
		cmds = r.engineCommandsLocked(st)
		r.lookupTablebaseLocked()
	}
	// The opponent played the move the engine was pondering on.
	hitPly, hitSide := -1, r.side()
	for _, c := range cmds {
		if c == "ponderhit" {
			hitPly = len(r.moves)
		}
	}
	finished := r.finished
	watched := b.watching == r.id
	view, ok := r.viewLocked()
	b.mu.Unlock()

	for _, c := range cmds {
		eng.Send(c)
	}
	if save != "" {
		go b.hooks.Save(save)
	}
	if len(bye) > 0 {
		go r.send(bye)
	}
	if finished {
		r.stopEngine()
		if r.cancel != nil {
			r.cancel()
		}
	}
	if watched && ok && b.hooks.Show != nil {
		b.hooks.Show(view)
	}
	// Said at once, with the move on the board: the engine's next line can
	// be a while in coming.
	if watched && hitPly >= 0 && b.hooks.Emit != nil {
		b.hooks.Emit("ponderHit", PonderHit{Side: hitSide, Ply: hitPly})
	}
	b.emit()
}

// PonderHit is sent to the UI as the "ponderHit" event when the opponent
// plays the reply the engine was pondering on: Ply moves have been played.
type PonderHit struct {
	Side string `json:"side"`
	Ply  int    `json:"ply"`
}

// engineCommandsLocked is what to tell the engine now that the game stands
// as r.moves: search on its turn, and on its opponent's, ponder.
//
// Pondering follows the UCI protocol. After "bestmove e2e4 ponder e7e5" and
// once e2e4 is on the board, the engine is given the position with the
// expected reply played and "go ponder" with the clocks. If the opponent
// plays that reply, "ponderhit" turns the search into the real one, which
// ends with the engine's move. If not, "stop" ends it (its bestmove is
// ignored) and a new search starts from the position that came about.
func (r *runner) engineCommandsLocked(st GameState) []string {
	n := len(r.moves)
	ourTurn := r.pos.Turn == r.color
	canMove := len(r.pos.LegalMoves()) > 0
	position := func(extra ...string) string {
		all := append(append([]string(nil), r.moves...), extra...)
		p := "position fen " + r.startFEN
		if len(all) > 0 {
			p += " moves " + strings.Join(all, " ")
		}
		return p
	}
	clock := fmt.Sprintf("wtime %d btime %d winc %d binc %d", st.WTime, st.BTime, st.WInc, st.BInc)
	var cmds []string
	if r.pondering != "" && (ourTurn || r.ponderBase != n) {
		// The opponent moved (or the game went another way).
		if ourTurn && canMove && r.ponderBase == n-1 && r.moves[n-1] == r.pondering {
			cmds = append(cmds, "ponderhit")
			r.thinking = n // its answer is the move for this position
			r.hitPly = n
			// What it found while pondering is its line for this position.
			if len(r.ponderLine.PV) > 0 {
				r.lastLine, r.lastLinePly = r.ponderLine, n
			}
		} else {
			cmds = append(cmds, "stop")
			r.discard++
		}
		r.pondering = ""
	}
	// Options saved while it was searching: now, before a new search.
	flush := func() {
		cmds = append(cmds, r.pendingOpts...)
		r.pendingOpts = nil
	}
	switch {
	case ourTurn && canMove && r.thinking != n:
		r.thinking = n
		flush()
		cmds = append(cmds, position(), "go "+clock)
	case !ourTurn && canMove && r.canPonder && r.pondering == "" && r.nextPonder != "" &&
		r.nextPly == n && n > 0 && r.moves[n-1] == r.nextAfter:
		// The reply must be legal, and leave the engine something to think about.
		reply, err := parseMove(&r.pos, r.nextPonder)
		if err == nil {
			if after := r.pos.Make(reply); len(after.LegalMoves()) > 0 {
				r.pondering, r.ponderBase = reply.UCI(), n
				r.ponderLine = uci.Info{}
				flush()
				cmds = append(cmds, position(reply.UCI()), "go ponder "+clock)
			}
		}
		r.nextPonder = ""
	}
	return cmds
}

func resultOf(st GameState) (result, reason string) {
	switch st.Winner {
	case "white":
		result = "1-0"
	case "black":
		result = "0-1"
	default:
		result = "1/2-1/2"
	}
	side := map[string]string{"white": "White", "black": "Black"}[st.Winner]
	switch st.Status {
	case "mate":
		reason = side + " wins by checkmate"
	case "resign":
		reason = side + " wins by resignation"
	case "outoftime", "timeout":
		if st.Winner == "" {
			reason = "Draw on time"
		} else {
			reason = side + " wins on time"
		}
	case "stalemate":
		reason = "Draw by stalemate"
	case "draw":
		reason = "Draw"
	case "aborted":
		result, reason = "*", "Game aborted"
	case "noStart":
		result, reason = "*", "The game did not start"
	default:
		if st.Winner != "" {
			reason = side + " wins (" + st.Status + ")"
		} else {
			reason = "Game over (" + st.Status + ")"
		}
	}
	return result, reason
}

func (r *runner) onBestMove(move string) {
	b := r.b
	b.mu.Lock()
	switch {
	case r.discard > 0:
		// The answer to the "stop" of a ponder search that missed.
		r.discard--
		r.ponder = ""
		b.mu.Unlock()
		return
	case r.pondering != "":
		// An answer while pondering, before ponderhit or stop: the engine
		// gave up the search (it should wait). It is not a move to play;
		// the next search starts from the opponent's move.
		r.pondering, r.ponder = "", ""
		b.mu.Unlock()
		return
	}
	ply := r.thinking
	stale := r.finished || ply != len(r.moves) || r.pos.Turn != r.color
	ctx := r.ctx
	client := b.client
	var chosen game.EngineInfo
	show := false
	playable := !stale && move != "" && move != "(none)" && move != "0000"
	draw := false
	if playable {
		if draw = r.offerDrawLocked(); draw {
			r.drawOffers++
		}
		if chosen, show = r.chosenLocked(move); show {
			if r.chosen == nil {
				r.chosen = map[int]game.EngineInfo{}
			}
			r.chosen[chosen.Ply] = chosen
			show = b.watching == r.id
		}
	}
	// The reply the engine named is what it ponders on once its move is
	// on the board.
	r.nextPonder = ""
	if playable && r.canPonder && r.ponder != "" {
		if best, err := parseMove(&r.pos, move); err == nil {
			r.nextPonder, r.nextAfter, r.nextPly = r.ponder, best.UCI(), len(r.moves)+1
		}
	}
	r.ponder = ""
	b.mu.Unlock()
	if stale || move == "" || move == "(none)" || move == "0000" || ctx == nil {
		return
	}
	if show && b.hooks.Emit != nil {
		b.hooks.Emit("engineInfo", chosen)
	}
	var err error
	for attempt := 0; attempt < 3; attempt++ {
		err = client.Move(ctx, r.id, move, draw)
		if err == nil || ctx.Err() != nil {
			break
		}
		var api *APIError
		if errors.As(err, &api) && api.Status == 400 {
			break // not legal, or not our turn: retrying will not help
		}
		time.Sleep(time.Duration(attempt+1) * 500 * time.Millisecond)
	}
	if err != nil && ctx.Err() == nil {
		r.setMessage(fmt.Sprintf("Could not play %s: %v", move, err))
	}
}

// infoEvery is how often the UI hears of a search at most: often enough
// for the depth to be seen climbing.
const infoEvery = 40 * time.Millisecond

// onInfo passes the engine's search on to the UI while its game is on the
// board: its lines, and between them the depth and node counts, both on
// its own turn and while it ponders on its opponent's.
func (r *runner) onInfo(in uci.Info) {
	b := r.b
	b.mu.Lock()
	n := len(r.moves)
	pondering := r.pondering != "" && r.ponderBase == n && r.pos.Turn != r.color
	if (!pondering && r.thinking != n) || in.MultiPV > 1 {
		b.mu.Unlock()
		return
	}
	line := len(in.PV) > 0
	switch {
	case line && pondering:
		r.ponderLine = in // the search's line, should the reply be played
	case line:
		r.lastLine, r.lastLinePly = in, n
	}
	now := time.Now()
	var out game.EngineInfo
	switch {
	case b.watching != r.id:
		b.mu.Unlock()
		return
	case line:
		if now.Sub(r.lastInfo) < infoEvery {
			b.mu.Unlock()
			return
		}
		r.lastInfo, r.lastStats = now, now
		if pondering {
			out = r.ponderInfoLocked(in)
		} else {
			out = r.infoLocked(in)
		}
	default:
		// No moves: the depth it has reached, and how fast it goes.
		if now.Sub(r.lastStats) < infoEvery || (in.Depth == 0 && in.Nodes == 0) {
			b.mu.Unlock()
			return
		}
		r.lastStats = now
		out = game.EngineInfo{Side: r.side(), Depth: in.Depth, Nodes: in.Nodes, NPS: in.NPS, Ply: n, Stats: true, Pondering: pondering}
	}
	b.mu.Unlock()
	if b.hooks.Emit != nil {
		b.hooks.Emit("engineInfo", out)
	}
}

func (r *runner) side() string {
	if r.color == chess.Black {
		return "black"
	}
	return "white"
}

// infoLocked is a search line for the UI: the score from White's side, the
// line in SAN, and its first two moves (the move the engine means to play
// and the reply it expects) for the arrows on the board.
func (r *runner) infoLocked(in uci.Info) game.EngineInfo {
	out := r.lineLocked(in, r.pos)
	out.PonderHit = r.hitPly == len(r.moves)
	if len(out.PV) > 0 {
		if mv, err := parseMove(&r.pos, in.PV[0]); err == nil {
			out.Best = mv.UCI()
			if len(in.PV) > 1 && len(out.PV) > 1 {
				next := r.pos.Make(mv)
				if reply, err := parseMove(&next, in.PV[1]); err == nil {
					out.Ponder = reply.UCI()
				}
			}
		}
	}
	return out
}

// ponderInfoLocked is a line of the search on the opponent's time: it
// starts with the reply the engine expects, then goes on as the engine sees it.
func (r *runner) ponderInfoLocked(in uci.Info) game.EngineInfo {
	reply, err := parseMove(&r.pos, r.pondering)
	if err != nil {
		return game.EngineInfo{Side: r.side(), Ply: len(r.moves), Stats: true, Pondering: true}
	}
	out := r.lineLocked(in, r.pos.Make(reply))
	out.PV = append([]string{r.pos.SAN(reply)}, out.PV...)
	out.Ponder, out.Pondering = reply.UCI(), true
	return out
}

// lineLocked reads a line the engine searched from pos.
func (r *runner) lineLocked(in uci.Info, pos chess.Position) game.EngineInfo {
	out := game.EngineInfo{
		Side:  r.side(),
		Depth: in.Depth, HasEval: in.HasScore, CP: in.ScoreCP, IsMate: in.IsMate, Mate: in.Mate,
		Nodes: in.Nodes, NPS: in.NPS, Ply: len(r.moves),
	}
	if r.color == chess.Black {
		out.CP, out.Mate = -out.CP, -out.Mate
	}
	// The chances are the engine's own (it is to move in every line it
	// searches, pondering too): White's first, as everywhere.
	if in.HasWDL {
		w := in.WDL
		if r.color == chess.Black {
			w[0], w[2] = w[2], w[0]
		}
		out.WDL = &w
	}
	for i, s := range in.PV {
		if i == 12 {
			break
		}
		mv, err := parseMove(&pos, s)
		if err != nil {
			break
		}
		out.PV = append(out.PV, pos.SAN(mv))
		pos = pos.Make(mv)
	}
	return out
}

func (r *runner) onPonder(move string) {
	r.b.mu.Lock()
	r.ponder = move
	r.b.mu.Unlock()
}

// chosenLocked tells the UI the move the engine chose and the reply it
// expects: the one it named with the move, or else the next move of its
// last line when that line starts with the move.
func (r *runner) chosenLocked(move string) (game.EngineInfo, bool) {
	best, err := parseMove(&r.pos, move)
	if err != nil {
		return game.EngineInfo{}, false
	}
	var line uci.Info
	if r.lastLinePly == len(r.moves) {
		line = r.lastLine
	}
	out := r.infoLocked(line)
	if out.Best != best.UCI() {
		// The line is not for this move: keep its numbers, not its moves.
		out.PV, out.Ponder = []string{r.pos.SAN(best)}, ""
	}
	out.Best, out.Played = best.UCI(), true
	if r.ponder != "" {
		next := r.pos.Make(best)
		if reply, err := parseMove(&next, r.ponder); err == nil {
			out.Ponder = reply.UCI()
			if len(out.PV) < 2 {
				out.PV = append(out.PV[:1:1], next.SAN(reply))
			}
		}
	}
	return out, true
}

func (r *runner) opponent() GamePlayer {
	if r.color == chess.White {
		return r.black
	}
	return r.white
}

func (r *runner) gameViewLocked() GameView {
	opp := r.opponent()
	name, rating, title := opp.DisplayName(), opp.Rating, opp.Title
	if !r.started && r.info != nil {
		name, rating = r.info.Opponent.Username, r.info.Opponent.Rating
	}
	status := r.state.Status
	if status == "" {
		status = "started"
	}
	offer := ""
	if theirs := (r.color == chess.White && r.state.BDraw) || (r.color == chess.Black && r.state.WDraw); theirs && !r.finished && r.play {
		offer = "theirs"
	}
	v := GameView{
		ID: r.id, URL: r.url(), Opponent: name, OpponentTitle: title, OpponentRating: rating,
		Color: map[chess.Color]string{chess.White: "white", chess.Black: "black"}[r.color],
		Rated: r.rated, Speed: r.speed, TC: r.tc, Status: status, Result: r.result,
		Moves: len(r.moves), MyTurn: !r.finished && r.pos.Turn == r.color, Finished: r.finished, Message: r.message,
		Playing: r.play, DrawOffer: offer,
	}
	if r.started {
		v.Fen = r.pos.FEN()
		if n := len(r.moves); n > 0 {
			v.LastMove = r.moves[n-1]
		}
	}
	return v
}

// viewLocked describes the game for the board.
// gameUser is a player's username, "" for the computer.
func gameUser(p GamePlayer) string {
	if p.AILevel > 0 {
		return ""
	}
	if p.Name != "" {
		return p.Name
	}
	return p.ID
}

// ratingDiffs shows how the finished rated game changed the ratings.
func (r *runner) ratingDiffs(c *Client) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	d, err := c.RatingDiffs(ctx, r.id)
	if err != nil || d == nil {
		return
	}
	b := r.b
	b.mu.Lock()
	r.ratingDiff = d
	watched := b.watching == r.id
	v, ok := r.viewLocked()
	b.mu.Unlock()
	if watched && ok && b.hooks.Show != nil {
		b.hooks.Show(v)
	}
	b.emit()
}

func (r *runner) viewLocked() (game.ExternalView, bool) {
	if !r.started {
		return game.ExternalView{}, false
	}
	b := r.b
	me := "Bot"
	if b.account != nil {
		me = b.account.Username
	}
	player := func(p GamePlayer, ours bool) game.PlayerConfig {
		pc := game.PlayerConfig{Type: "lichess", Name: p.DisplayName()}
		if p.Rating > 0 {
			pc.Rating = fmt.Sprint(p.Rating)
		}
		if p.Title != "" && p.Title != "BOT" {
			pc.Name = p.Title + " " + pc.Name
		}
		if ours {
			pc.Name = me
			if r.play {
				pc.Type = "engine"
			}
		}
		return pc
	}
	label := "Casual"
	if r.rated {
		label = "Rated"
	}
	if r.speed != "" {
		label += " " + r.speed
	}
	if r.tc != "" {
		label += " " + r.tc
	}
	v := game.ExternalView{
		ID: r.id, URL: r.url(), Label: "Lichess · " + label,
		Side: map[chess.Color]string{chess.White: "white", chess.Black: "black"}[r.color], Kind: "bot",
		White: player(r.white, r.color == chess.White), Black: player(r.black, r.color == chess.Black),
		StartFEN: r.startFEN, Moves: append([]string(nil), r.moves...),
		WhiteMs: r.state.WTime, BlackMs: r.state.BTime, At: r.stateAt,
		Finished: r.finished, Result: r.result, Reason: r.reason, RatingDiff: r.ratingDiff,
		Speed: r.speed, Users: &game.Users{White: gameUser(r.white), Black: gameUser(r.black)},
	}
	if !r.finished {
		v.Running = len(r.moves) >= 2 // Lichess starts the clocks after each side's first move
	}
	return v, true
}

// Watching is the id of the game shown on the board, or "".
func (b *Bot) Watching() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.watching
}

// Play hands a game to the engine: one that was already going when
// connecting, or that started elsewhere.
func (b *Bot) Play(id string) error {
	b.mu.Lock()
	r := b.games[id]
	if r == nil || r.finished {
		b.mu.Unlock()
		return errors.New("that game is not in progress")
	}
	if r.play && r.eng != nil {
		b.mu.Unlock()
		return nil
	}
	r.play = true
	r.thinking = -1
	r.message = ""
	cfg := b.cfg.Engine
	st := r.state
	started := r.started
	b.mu.Unlock()
	if err := r.startEngine(cfg); err != nil {
		b.mu.Lock()
		r.play = false
		b.mu.Unlock()
		r.setMessage("Could not start the engine: " + err.Error())
		return err
	}
	if started {
		r.onState(st) // move now if it is the engine's turn
	} else {
		b.emit()
	}
	return nil
}

// SetAutoAccept turns automatic accepting of challenges on or off. It is
// off after every connect.
func (b *Bot) SetAutoAccept(on bool) error {
	client, err := b.connected()
	if err != nil {
		if on {
			return err
		}
		return nil
	}
	b.mu.Lock()
	b.autoAccept = on
	var waiting []*Challenge
	if on {
		for _, ch := range b.incoming {
			waiting = append(waiting, ch)
		}
	}
	b.mu.Unlock()
	b.emit()
	// Challenges already waiting are answered by the same rules.
	for _, ch := range waiting {
		b.mu.Lock()
		reason := b.declineReason(ch, true)
		delete(b.incoming, ch.ID)
		if reason == "" {
			b.expect[ch.ID] = true
			b.accepted[ch.ID] = time.Now()
		}
		b.mu.Unlock()
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		if reason != "" {
			b.decline(ctx, ch.ID, reason)
		} else if err := client.Accept(ctx, ch.ID); err != nil {
			b.mu.Lock()
			delete(b.accepted, ch.ID)
			b.mu.Unlock()
			b.note(fmt.Sprintf("Could not accept %s's challenge: %v", ch.Challenger.DisplayName(), err))
		}
		cancel()
	}
	if len(waiting) > 0 {
		b.emit()
	}
	return nil
}

func (r *runner) pgnLocked() (string, error) {
	pl := func(p GamePlayer) pgnPlayer {
		return pgnPlayer{Name: p.DisplayName(), Title: p.Title, Rating: p.Rating}
	}
	return gamePGN(r.rated, r.speed, r.url(), pl(r.white), pl(r.black), r.initial, r.increment,
		r.startFEN, r.moves, r.result, r.reason, time.Now())
}
