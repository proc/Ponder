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
}

type Config struct {
	BaseURL string       `json:"baseUrl"`
	Token   string       `json:"token"`
	Engine  EngineConfig `json:"engine"`
	Policy  Policy       `json:"policy"`
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
	Finished       bool   `json:"finished"`
	Message        string `json:"message,omitempty"`
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
}

func NewBot(h Hooks) *Bot {
	return &Bot{hooks: h, state: "off", expect: map[string]bool{}, answered: map[string]string{}, waiters: map[string]chan string{}, incoming: map[string]*Challenge{}, outgoing: map[string]*Challenge{}, games: map[string]*runner{}}
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

// Configure changes the engine and challenge policy without reconnecting.
// A new engine is used from the next game.
func (b *Bot) Configure(engine EngineConfig, policy Policy) {
	b.mu.Lock()
	b.cfg.Engine, b.cfg.Policy = engine, policy
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
			b.mu.Unlock()
			if err := b.client.Accept(ctx, ch.ID); err != nil {
				b.note(fmt.Sprintf("Could not accept %s's challenge: %v", ch.Challenger.DisplayName(), err))
			}
			b.emit()
			return
		}
		b.incoming[ch.ID] = ch
	case "challengeCanceled", "challengeDeclined":
		if ch := e.Challenge; ch != nil {
			delete(b.incoming, ch.ID)
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
	active := 0
	for _, r := range b.games {
		if !r.finished {
			active++
		}
	}
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
	case minutes < p.MinMinutes:
		return "tooFast"
	case p.MaxMinutes > 0 && minutes > p.MaxMinutes:
		return "tooSlow"
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
	b.mu.Unlock()
	if err := client.Accept(ctx, id); err != nil {
		b.mu.Lock()
		delete(b.expect, id)
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

func (b *Bot) Challenge(p ChallengeParams) error {
	_, err := b.challenge(p)
	return err
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
	b.mu.Unlock()
	if ok && b.hooks.Show != nil {
		b.hooks.Show(v)
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
		s.Outgoing = append(s.Outgoing, challengeView(ch, u))
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
	b      *Bot
	id     string
	info   *GameInfo
	ctx    context.Context
	cancel context.CancelFunc

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
	thinking           int // ply the engine is searching for, or -1
	lastInfo           time.Time
}

func newRunner(b *Bot, id string, info *GameInfo) *runner {
	r := &runner{b: b, id: id, info: info, thinking: -1}
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
		OnBestMove: r.onBestMove,
		OnExit: func() {
			r.setMessage("The engine stopped unexpectedly")
		},
	})
	if err != nil {
		return err
	}
	for name, value := range cfg.Options {
		eng.SetOption(name, value)
	}
	if err := eng.NewGame(); err != nil {
		eng.Quit()
		return err
	}
	r.b.mu.Lock()
	r.eng = eng
	r.b.mu.Unlock()
	return nil
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
		if e.State != nil {
			r.onState(*e.State)
		}
	case "gameState":
		r.onState(e.GameState)
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
	var think bool
	var position, goCmd string
	eng := r.eng
	var save string
	if ended && !r.finished {
		r.finished = true
		r.result, r.reason = resultOf(st)
		if r.play && r.result != "*" && b.hooks.Save != nil {
			save, _ = r.pgnLocked()
		}
	} else if !ended && pos.Turn == r.color && r.thinking != len(moves) && eng != nil && len(pos.LegalMoves()) > 0 {
		r.thinking = len(moves)
		think = true
		position = "position fen " + r.startFEN
		if len(moves) > 0 {
			position += " moves " + strings.Join(moves, " ")
		}
		goCmd = fmt.Sprintf("go wtime %d btime %d winc %d binc %d", st.WTime, st.BTime, st.WInc, st.BInc)
	}
	finished := r.finished
	watched := b.watching == r.id
	view, ok := r.viewLocked()
	b.mu.Unlock()

	if think {
		eng.Go(position, goCmd)
	}
	if save != "" {
		go b.hooks.Save(save)
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
	b.emit()
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
	ply := r.thinking
	stale := r.finished || ply != len(r.moves) || r.pos.Turn != r.color
	ctx := r.ctx
	client := b.client
	b.mu.Unlock()
	if stale || move == "" || move == "(none)" || move == "0000" || ctx == nil {
		return
	}
	var err error
	for attempt := 0; attempt < 3; attempt++ {
		err = client.Move(ctx, r.id, move)
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

func (r *runner) onInfo(in uci.Info) {
	b := r.b
	b.mu.Lock()
	if b.watching != r.id || r.thinking != len(r.moves) || in.MultiPV > 1 || len(in.PV) == 0 || time.Since(r.lastInfo) < 100*time.Millisecond {
		b.mu.Unlock()
		return
	}
	r.lastInfo = time.Now()
	out := game.EngineInfo{
		Side:  map[chess.Color]string{chess.White: "white", chess.Black: "black"}[r.color],
		Depth: in.Depth, HasEval: in.HasScore, CP: in.ScoreCP, IsMate: in.IsMate, Mate: in.Mate,
		Nodes: in.Nodes, NPS: in.NPS, Ply: len(r.moves),
	}
	if r.color == chess.Black {
		out.CP, out.Mate = -out.CP, -out.Mate
	}
	p := r.pos
	for i, s := range in.PV {
		if i == 12 {
			break
		}
		mv, err := p.ParseUCIMove(s)
		if err != nil {
			break
		}
		out.PV = append(out.PV, p.SAN(mv))
		p = p.Make(mv)
	}
	b.mu.Unlock()
	if b.hooks.Emit != nil {
		b.hooks.Emit("engineInfo", out)
	}
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
	return GameView{
		ID: r.id, URL: r.url(), Opponent: name, OpponentTitle: title, OpponentRating: rating,
		Color: map[chess.Color]string{chess.White: "white", chess.Black: "black"}[r.color],
		Rated: r.rated, Speed: r.speed, TC: r.tc, Status: status, Result: r.result,
		Moves: len(r.moves), MyTurn: !r.finished && r.pos.Turn == r.color, Finished: r.finished, Message: r.message,
		Playing: r.play,
	}
}

// viewLocked describes the game for the board.
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
		Finished: r.finished, Result: r.result, Reason: r.reason,
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
		}
		b.mu.Unlock()
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		if reason != "" {
			b.decline(ctx, ch.ID, reason)
		} else if err := client.Accept(ctx, ch.ID); err != nil {
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
