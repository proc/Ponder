package lichess

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"board/backend/chess"
	"board/backend/game"
)

// Player lets a person play their own games on Lichess through the Board
// API, with their own (non-bot) account: look for an opponent in the lobby,
// challenge someone, accept challenges, and play the moves on the board.
// No engine is involved: Lichess forbids outside help in these games.

// PlayGameView is one of the person's games, for the Lichess tab.
type PlayGameView struct {
	GameView
	// Offers on the table: "mine" (sent, waiting) or "theirs" (to answer).
	Draw     string `json:"draw,omitempty"`
	Takeback string `json:"takeback,omitempty"`
	OnBoard  bool   `json:"onBoard"`
}

// PlayStatus is sent to the UI as the "lichessAccount" event.
type PlayStatus struct {
	State    string          `json:"state"` // off, connecting, connected, reconnecting, bot, error
	Message  string          `json:"message"`
	Account  *Account        `json:"account"`
	BaseURL  string          `json:"baseUrl"`
	Incoming []ChallengeView `json:"incoming"`
	Outgoing []ChallengeView `json:"outgoing"`
	Games    []PlayGameView  `json:"games"`
	Current  string          `json:"current"` // the game on the board
	Seek     *PlaySeek       `json:"seek"`
}

// PlaySeek is the lobby seek in progress.
type PlaySeek struct {
	LobbySeek
	Since time.Time `json:"since"`
}

// PlayHooks connect the player to the rest of the app.
type PlayHooks struct {
	Emit func(event string, data any) // UI events
	// Show updates a game on the board. takeOver is set when the game should
	// replace whatever the board shows (a game that just started, or one
	// chosen in the list); otherwise only a board already showing it changes.
	Show func(v game.ExternalView, takeOver bool)
	// Save receives the PGN of each finished game.
	Save func(pgn string)
}

type Player struct {
	mu      sync.Mutex
	hooks   PlayHooks
	client  *Client
	baseURL string
	cancel  context.CancelFunc
	gen     int
	state   string
	message string
	account *Account

	incoming map[string]*Challenge
	outgoing map[string]*Challenge
	expires  map[string]time.Time // when challenges sent are withdrawn
	timeout  int                  // seconds a challenge sent waits (0: for ever)
	games    map[string]*pgame
	order    []string
	current  string

	seek       *PlaySeek
	sending    bool // a challenge request is on its way
	seekCancel context.CancelFunc

	runCtx  context.Context     // while signed in: games follow under it
	playing map[string]GameInfo // ongoing games last read for the home
}

func NewPlayer(h PlayHooks) *Player {
	return &Player{hooks: h, state: "off", incoming: map[string]*Challenge{}, outgoing: map[string]*Challenge{}, games: map[string]*pgame{}}
}

// pgame is one game. Its fields are guarded by Player.mu.
type pgame struct {
	p        *Player
	id       string
	info     *GameInfo
	color    chess.Color
	started  bool // the full game has arrived
	white    GamePlayer
	black    GamePlayer
	rated    bool
	speed    string
	tc       string
	initial  int64 // seconds
	inc      int64
	start    chess.Position
	startFEN string
	pos      chess.Position
	moves    []string
	state    GameState
	stateAt  time.Time
	// A move played on the board and sent, not yet confirmed by Lichess.
	pending    string
	pendingAt  time.Time
	shown      bool // put on the board once already
	ratingDiff *game.RatingDiff
	finished   bool
	result     string
	reason     string
	message    string
	cancel     context.CancelFunc
	chat       chatLog
}

func (p *Player) emit() {
	if p.hooks.Emit != nil {
		p.hooks.Emit("lichessAccount", p.Status())
	}
}

// Connect signs in with a token that has the board:play permission.
func (p *Player) Connect(baseURL, token string) (PlayStatus, error) {
	p.Disconnect()
	client := NewClient(baseURL, token)
	client.Board = true
	if client.Token == "" {
		return p.Status(), errors.New("sign in with Lichess first")
	}
	p.mu.Lock()
	p.gen++
	gen := p.gen
	p.client, p.baseURL = client, client.BaseURL
	p.state, p.message, p.account = "connecting", "", nil
	p.mu.Unlock()
	p.emit()

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	acct, err := client.Account(ctx)
	cancel()
	p.mu.Lock()
	if gen != p.gen {
		p.mu.Unlock()
		return p.Status(), errors.New("superseded")
	}
	if err != nil {
		var api *APIError
		if errors.As(err, &api) && api.Status == 401 {
			err = errors.New("Lichess did not accept the sign-in; sign in again")
		}
		p.state, p.message = "error", err.Error()
		p.mu.Unlock()
		p.emit()
		return p.Status(), err
	}
	p.account = &acct
	if acct.IsBot() {
		p.state = "bot"
		p.message = acct.Username + " is a Bot account. Sign in with your own account to play; bot accounts play through Your engine below."
		p.mu.Unlock()
		p.emit()
		return p.Status(), nil
	}
	runCtx, runCancel := context.WithCancel(context.Background())
	p.cancel, p.runCtx = runCancel, runCtx
	p.state, p.message = "connected", ""
	p.mu.Unlock()
	go p.follow(runCtx, gen)
	p.emit()
	return p.Status(), nil
}

// Disconnect stops following Lichess. Games in progress go on there.
func (p *Player) Disconnect() {
	p.mu.Lock()
	if p.cancel != nil {
		p.cancel()
		p.cancel = nil
	}
	if p.seekCancel != nil {
		p.seekCancel()
		p.seekCancel = nil
	}
	for _, g := range p.games {
		if g.cancel != nil {
			g.cancel()
		}
	}
	was := p.state != "off"
	p.gen++
	p.state, p.message, p.account, p.client = "off", "", nil, nil
	p.runCtx, p.playing = nil, nil
	p.incoming, p.outgoing, p.games, p.order, p.current, p.seek = map[string]*Challenge{}, map[string]*Challenge{}, map[string]*pgame{}, nil, "", nil
	p.mu.Unlock()
	if was {
		p.emit()
	}
}

func (p *Player) follow(ctx context.Context, gen int) {
	backoff := time.Second
	for ctx.Err() == nil {
		p.mu.Lock()
		client := p.client
		p.mu.Unlock()
		if client == nil {
			return
		}
		started := time.Now()
		go p.loadOutgoing(ctx, gen, client)
		err := client.StreamEvents(ctx, func(e Event) { p.onEvent(ctx, gen, e) })
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
		p.mu.Lock()
		if gen == p.gen {
			p.state, p.message = "reconnecting", msg
		}
		p.mu.Unlock()
		p.emit()
		if !sleepCtx(ctx, wait) {
			return
		}
		if backoff < 30*time.Second {
			backoff *= 2
		}
		p.mu.Lock()
		if gen == p.gen && p.state == "reconnecting" {
			p.state, p.message = "connected", ""
		}
		p.mu.Unlock()
	}
}

func (p *Player) me() string {
	if p.account == nil {
		return ""
	}
	return p.account.ID
}

// loadOutgoing reads the challenges the account has out, made here or
// elsewhere (on the website, before Ponder connected).
func (p *Player) loadOutgoing(ctx context.Context, gen int, client *Client) {
	cctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	_, out, err := client.CurrentChallenges(cctx)
	if err != nil {
		return
	}
	p.mu.Lock()
	if gen != p.gen {
		p.mu.Unlock()
		return
	}
	added := false
	for i := range out {
		ch := out[i]
		if _, known := p.outgoing[ch.ID]; !known && (ch.Status == "" || ch.Status == "created") {
			p.outgoing[ch.ID] = &ch
			added = true
		}
	}
	p.mu.Unlock()
	if added {
		p.emit()
	}
}

func (p *Player) onEvent(ctx context.Context, gen int, e Event) {
	p.mu.Lock()
	if gen != p.gen {
		p.mu.Unlock()
		return
	}
	switch e.Type {
	case "challenge":
		if ch := e.Challenge; ch != nil {
			if strings.EqualFold(ch.Challenger.ID, p.me()) {
				p.outgoing[ch.ID] = ch
			} else {
				p.incoming[ch.ID] = ch
			}
		}
	case "challengeCanceled", "challengeDeclined":
		if ch := e.Challenge; ch != nil {
			if _, ok := p.outgoing[ch.ID]; ok && e.Type == "challengeDeclined" {
				who := "The player"
				if ch.DestUser != nil {
					who = ch.DestUser.DisplayName()
				}
				p.message = who + " declined your challenge" + declineSuffix(ch.DeclineReason)
			}
			delete(p.incoming, ch.ID)
			delete(p.outgoing, ch.ID)
		}
	case "gameStart":
		info := e.Game
		if info == nil {
			break
		}
		id := info.Key()
		delete(p.incoming, id)
		delete(p.outgoing, id)
		if g, ok := p.games[id]; ok && !g.finished {
			break // the stream resends games on reconnect
		}
		if p.seek != nil {
			// The seek found this game (or a challenge started one): stop looking.
			if p.seekCancel != nil {
				p.seekCancel()
				p.seekCancel = nil
			}
			p.seek = nil
		}
		p.addGameLocked(ctx, info)
		p.mu.Unlock()
		p.emit()
		return
	case "gameFinish":
		// The game's own stream reports how it ended.
	}
	p.mu.Unlock()
	p.emit()
}

// addGameLocked starts following a game, which takes over the board.
func (p *Player) addGameLocked(ctx context.Context, info *GameInfo) {
	id := info.Key()
	g := &pgame{p: p, id: id, info: info, color: chess.White}
	if info.Color == "black" {
		g.color = chess.Black
	}
	p.games[id] = g
	p.order = append(p.order, id)
	p.trimLocked()
	p.current = id
	p.message = ""
	gctx, cancel := context.WithCancel(ctx)
	g.cancel = cancel
	go g.run(gctx)
}

func declineSuffix(reason string) string {
	if reason == "" {
		return "."
	}
	return ": " + strings.TrimSuffix(reason, ".") + "."
}

// trimLocked forgets old finished games.
func (p *Player) trimLocked() {
	finished := 0
	for _, id := range p.order {
		if g := p.games[id]; g != nil && g.finished {
			finished++
		}
	}
	for i := 0; i < len(p.order) && finished > finishedKept; {
		id := p.order[i]
		if g := p.games[id]; g != nil && g.finished && id != p.current {
			delete(p.games, id)
			p.order = append(p.order[:i], p.order[i+1:]...)
			finished--
			continue
		}
		i++
	}
}

func (p *Player) connected() (*Client, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.client == nil || p.state == "off" || p.state == "bot" || p.state == "error" {
		return nil, errors.New("sign in to Lichess first")
	}
	return p.client, nil
}

func (p *Player) call(f func(ctx context.Context, c *Client) error) error {
	c, err := p.connected()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	return f(ctx, c)
}

// Seek looks for an opponent in the lobby until one is found or StopSeek.
// The Board API allows rapid, classical and correspondence seeks only.
func (p *Player) Seek(s LobbySeek) error {
	if s.Days > 0 {
		return p.seekCorrespondence(s)
	}
	if s.Limit <= 0 {
		return errors.New("choose a time control")
	}
	if sp := SpeedOf(s.Limit, s.Increment); sp == "ultraBullet" || sp == "bullet" || sp == "blitz" {
		return errors.New("Lichess allows apps to look for rapid or slower games only (at least 8 minutes, counting 40 moves of increment). Challenge someone directly to play blitz")
	}
	c, err := p.connected()
	if err != nil {
		return err
	}
	p.mu.Lock()
	if p.seekCancel != nil {
		p.seekCancel()
	}
	ctx, cancel := context.WithCancel(context.Background())
	gen := p.gen
	p.seek = &PlaySeek{LobbySeek: s, Since: time.Now()}
	p.seekCancel = cancel
	p.message = ""
	seek := p.seek
	p.mu.Unlock()
	p.emit()
	go func() {
		err := c.Seek(ctx, s)
		p.mu.Lock()
		if gen != p.gen || p.seek != seek {
			p.mu.Unlock()
			return
		}
		p.seek, p.seekCancel = nil, nil
		switch {
		case ctx.Err() != nil:
		case err != nil:
			p.message = "Could not look for a game: " + err.Error()
		}
		p.mu.Unlock()
		cancel()
		p.emit()
	}()
	return nil
}

// seekCorrespondence puts a correspondence seek in the lobby. Lichess
// keeps it there until someone accepts it (the game then starts as a
// gameStart event) or it expires; the Board API cannot withdraw it.
func (p *Player) seekCorrespondence(s LobbySeek) error {
	switch s.Days {
	case 1, 2, 3, 5, 7, 10, 14:
	default:
		return errors.New("choose 1, 2, 3, 5, 7, 10 or 14 days a move")
	}
	err := p.call(func(ctx context.Context, c *Client) error { return c.Seek(ctx, s) })
	if err != nil {
		return err
	}
	p.mu.Lock()
	days := "days"
	if s.Days == 1 {
		days = "day"
	}
	mode := "casual"
	if s.Rated {
		mode = "rated"
	}
	p.message = fmt.Sprintf("Your %s correspondence seek (%d %s a move) is in the Lichess lobby; the game starts when someone accepts it.", mode, s.Days, days)
	p.mu.Unlock()
	p.emit()
	return nil
}

// StopSeek withdraws the lobby seek.
func (p *Player) StopSeek() {
	p.mu.Lock()
	had := p.seek != nil
	if p.seekCancel != nil {
		p.seekCancel()
	}
	p.seek, p.seekCancel = nil, nil
	p.mu.Unlock()
	if had {
		p.emit()
	}
}

// Challenge challenges a player (any time control).
func (p *Player) Challenge(cp ChallengeParams) error {
	if strings.TrimSpace(cp.Username) == "" {
		return errors.New("enter a Lichess username")
	}
	// One challenge waiting for an answer at a time.
	p.mu.Lock()
	busy := ""
	if p.sending {
		busy = "A challenge is already being sent."
	}
	for _, ch := range p.outgoing {
		busy = fmt.Sprintf("Your challenge to %s is waiting for an answer. Cancel it to challenge someone else.", ch.DestName())
		break
	}
	if busy != "" {
		p.mu.Unlock()
		return errors.New(busy)
	}
	p.sending = true
	p.mu.Unlock()
	defer func() {
		p.mu.Lock()
		p.sending = false
		p.mu.Unlock()
	}()
	var ch Challenge
	err := p.call(func(ctx context.Context, c *Client) (err error) {
		ch, err = c.Challenge(ctx, cp)
		return err
	})
	if err != nil {
		return err
	}
	p.mu.Lock()
	if ch.ID != "" {
		p.outgoing[ch.ID] = &ch
	}
	p.message = ""
	secs := p.timeout
	if ch.ID != "" && secs > 0 {
		if p.expires == nil {
			p.expires = map[string]time.Time{}
		}
		d := time.Duration(secs) * time.Second
		p.expires[ch.ID] = time.Now().Add(d)
		id, name := ch.ID, ch.DestName()
		time.AfterFunc(d, func() {
			p.mu.Lock()
			_, waiting := p.outgoing[id]
			delete(p.expires, id)
			p.mu.Unlock()
			if !waiting || p.Cancel(id) != nil {
				return
			}
			p.mu.Lock()
			p.message = fmt.Sprintf("%s did not answer in %d s: the challenge was withdrawn.", name, secs)
			p.mu.Unlock()
			p.emit()
		})
	}
	p.mu.Unlock()
	p.emit()
	return nil
}

// SetChallengeTimeout changes how long a challenge sent waits for an
// answer (seconds; 0: for ever). Challenges already out keep their time.
func (p *Player) SetChallengeTimeout(secs int) {
	p.mu.Lock()
	p.timeout = secs
	p.mu.Unlock()
}

func (p *Player) Accept(id string) error {
	err := p.call(func(ctx context.Context, c *Client) error { return c.Accept(ctx, id) })
	if ChallengeGone(err) {
		p.Dismiss(id)
		return errChallengeGone
	}
	return err
}

// Dismiss takes a challenge off the lists here without asking Lichess
// anything, as Bot.Dismiss does.
func (p *Player) Dismiss(id string) {
	p.mu.Lock()
	_, in := p.incoming[id]
	_, out := p.outgoing[id]
	delete(p.incoming, id)
	delete(p.outgoing, id)
	p.mu.Unlock()
	if in || out {
		p.emit()
	}
}

// Decline turns a challenge down; reason is one of Lichess's decline
// reasons ("" for the plain one), which the challenger is shown.
func (p *Player) Decline(id, reason string) error {
	err := p.call(func(ctx context.Context, c *Client) error { return c.Decline(ctx, id, reason) })
	if ChallengeGone(err) {
		p.Dismiss(id)
		return errChallengeGone
	}
	if err == nil {
		p.mu.Lock()
		delete(p.incoming, id)
		p.mu.Unlock()
		p.emit()
	}
	return err
}

func (p *Player) Cancel(id string) error {
	err := p.call(func(ctx context.Context, c *Client) error { return c.Cancel(ctx, id) })
	if ChallengeGone(err) {
		p.Dismiss(id)
		return errChallengeGone
	}
	if err == nil {
		p.mu.Lock()
		delete(p.outgoing, id)
		p.mu.Unlock()
		p.emit()
	}
	return err
}

// Has reports whether id is one of the person's games.
func (p *Player) Has(id string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	_, ok := p.games[id]
	return ok
}

// Current is the game shown on the board ("" for none).
func (p *Player) Current() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.current
}

// Show puts one of the games on the board.
func (p *Player) Show(id string) error {
	p.mu.Lock()
	g := p.games[id]
	if g == nil {
		p.mu.Unlock()
		return errors.New("no such game")
	}
	p.current = id
	v, ok := g.viewLocked()
	g.shown = g.shown || ok
	p.mu.Unlock()
	if ok && p.hooks.Show != nil {
		p.hooks.Show(v, true)
	}
	p.emit()
	return nil
}

func (p *Player) game(id string) (*pgame, *Client, error) {
	c, err := p.connected()
	if err != nil {
		return nil, nil, err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if id == "" {
		id = p.current
	}
	g := p.games[id]
	if g == nil {
		return nil, nil, errors.New("no such game")
	}
	if g.finished {
		return nil, nil, errors.New("the game is over")
	}
	return g, c, nil
}

// Move plays a move in game id. It shows at once and is sent to Lichess in
// the background; if Lichess refuses it, it is taken off again.
func (p *Player) Move(id, uciMove string) error {
	g, c, err := p.game(id)
	if err != nil {
		return err
	}
	p.mu.Lock()
	if !g.started {
		p.mu.Unlock()
		return errors.New("the game has not started yet")
	}
	if g.pending != "" {
		p.mu.Unlock()
		return errors.New("your last move is still on its way to Lichess")
	}
	if g.pos.Turn != g.color {
		p.mu.Unlock()
		return errors.New("it is your opponent's turn")
	}
	mv, err := g.pos.ParseUCIMove(uciMove)
	if err != nil {
		p.mu.Unlock()
		return fmt.Errorf("illegal move %q", uciMove)
	}
	g.pending, g.pendingAt, g.message = mv.UCI(), time.Now(), ""
	id = g.id
	v, ok := g.viewLocked()
	p.mu.Unlock()
	if ok && p.hooks.Show != nil {
		p.hooks.Show(v, false)
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		err := c.Move(ctx, id, mv.UCI(), false)
		cancel()
		if err == nil {
			return
		}
		p.mu.Lock()
		if g.pending != mv.UCI() {
			p.mu.Unlock()
			return
		}
		g.pending = ""
		g.message = "Lichess refused the move: " + err.Error()
		v, ok := g.viewLocked()
		p.mu.Unlock()
		if ok && p.hooks.Show != nil {
			p.hooks.Show(v, false)
		}
		p.emit()
	}()
	return nil
}

// Resign resigns a game ("" for the one on the board).
func (p *Player) Resign(id string) error {
	g, c, err := p.game(id)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	return c.Resign(ctx, g.id)
}

// Abort aborts a game before both sides have moved.
func (p *Player) Abort(id string) error {
	g, c, err := p.game(id)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	return c.Abort(ctx, g.id)
}

// Draw offers or accepts a draw (yes), or declines the opponent's offer.
func (p *Player) Draw(id string, yes bool) error {
	return p.offer(id, yes, (*Client).Draw)
}

// Takeback proposes or accepts a takeback (yes), or declines one.
func (p *Player) Takeback(id string, yes bool) error {
	return p.offer(id, yes, (*Client).Takeback)
}

func (p *Player) offer(id string, yes bool, f func(*Client, context.Context, string, bool) error) error {
	g, c, err := p.game(id)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	return f(c, ctx, g.id, yes)
}

// Status is the state for the Lichess tab.
func (p *Player) Status() PlayStatus {
	p.mu.Lock()
	defer p.mu.Unlock()
	st := PlayStatus{State: p.state, Message: p.message, Account: p.account, BaseURL: p.baseURL,
		Incoming: []ChallengeView{}, Outgoing: []ChallengeView{}, Games: []PlayGameView{}, Current: p.current}
	if p.seek != nil {
		s := *p.seek
		st.Seek = &s
	}
	for _, ch := range p.incoming {
		v := challengeView(ch, ch.Challenger)
		v.Supported = ch.Variant.Key == "" || ch.Variant.Key == "standard" || ch.Variant.Key == "fromPosition"
		st.Incoming = append(st.Incoming, v)
	}
	for _, ch := range p.outgoing {
		u := User{}
		if ch.DestUser != nil {
			u = *ch.DestUser
		}
		v := challengeView(ch, u)
		if at, ok := p.expires[ch.ID]; ok {
			v.ExpiresAt = at.UnixMilli()
		}
		st.Outgoing = append(st.Outgoing, v)
	}
	for i := len(p.order) - 1; i >= 0; i-- {
		if g := p.games[p.order[i]]; g != nil {
			st.Games = append(st.Games, g.playViewLocked())
		}
	}
	return st
}

// --- one game ---

func (g *pgame) url() string {
	base := DefaultBaseURL
	if g.p.baseURL != "" {
		base = g.p.baseURL
	}
	side := "white"
	if g.color == chess.Black {
		side = "black"
	}
	return base + "/" + g.id + "/" + side
}

func (g *pgame) run(ctx context.Context) {
	backoff := time.Second
	for ctx.Err() == nil {
		g.p.mu.Lock()
		client := g.p.client
		g.p.mu.Unlock()
		if client == nil {
			return
		}
		err := client.StreamGame(ctx, g.id, g.onGameEvent)
		g.p.mu.Lock()
		done := g.finished
		if err != nil && !done && ctx.Err() == nil {
			var api *APIError
			if errors.As(err, &api) && api.Status >= 400 && api.Status < 500 && api.Status != 429 {
				// Lichess will not let this game be played here (e.g. a blitz
				// game started on the website).
				g.message = err.Error()
				g.finished, g.result, g.reason = true, "*", "Cannot be played here: "+strings.TrimPrefix(err.Error(), "Lichess: ")
				done = true
			}
		}
		g.p.mu.Unlock()
		if done || ctx.Err() != nil {
			g.p.emit()
			return
		}
		if !sleepCtx(ctx, backoff) {
			return
		}
		if backoff < 15*time.Second {
			backoff *= 2
		}
	}
}

func (g *pgame) onGameEvent(e GameEvent) {
	p := g.p
	switch e.Type {
	case "gameFull":
		p.mu.Lock()
		g.started = true
		g.white, g.black = e.White, e.Black
		g.rated, g.speed = e.Rated, e.Speed
		if me := p.me(); me != "" {
			if strings.EqualFold(e.Black.ID, me) {
				g.color = chess.Black
			} else if strings.EqualFold(e.White.ID, me) {
				g.color = chess.White
			}
		}
		if e.Clock != nil {
			g.initial, g.inc = e.Clock.Initial/1000, e.Clock.Increment/1000
			g.tc = fmt.Sprintf("%g+%d", float64(e.Clock.Initial)/60000, e.Clock.Increment/1000)
		}
		fen := e.InitialFen
		if fen == "" || fen == "startpos" {
			fen = chess.StartFEN
		}
		if pos, err := chess.ParseFEN(fen); err == nil {
			g.start, g.startFEN = pos, pos.FEN()
		} else {
			g.start, _ = chess.ParseFEN(chess.StartFEN)
			g.startFEN = g.start.FEN()
		}
		p.mu.Unlock()
		g.seedChat()
		if e.State != nil {
			g.onState(*e.State)
		}
	case "gameState":
		g.onState(e.GameState)
	case "chatLine":
		g.onChatLine(e)
	case "opponentGone":
		p.mu.Lock()
		if e.Gone {
			g.message = "Your opponent left the game"
			if e.ClaimWinInSeconds > 0 {
				g.message += fmt.Sprintf("; you can claim the win on Lichess in %d s", e.ClaimWinInSeconds)
			}
		} else {
			g.message = ""
		}
		p.mu.Unlock()
		p.emit()
	}
}

func (g *pgame) onState(st GameState) {
	p := g.p
	p.mu.Lock()
	pos := g.start
	var moves []string
	for _, s := range strings.Fields(st.Moves) {
		m, err := parseMove(&pos, s)
		if err != nil {
			g.message = fmt.Sprintf("Could not follow the game: move %q is not legal here", s)
			break
		}
		moves = append(moves, m.UCI())
		pos = pos.Make(m)
	}
	// The move sent is confirmed (or overtaken) once Lichess has more moves.
	if g.pending != "" && len(moves) > len(g.moves) {
		g.pending = ""
	}
	g.pos, g.moves, g.state, g.stateAt = pos, moves, st, time.Now()
	ended := st.Status != "" && st.Status != "started" && st.Status != "created"
	var save string
	if ended && !g.finished {
		g.finished, g.pending = true, ""
		g.result, g.reason = resultOf(st)
		if g.result != "*" && p.hooks.Save != nil {
			save, _ = g.pgnLocked()
		}
		if g.rated && g.result != "*" && p.client != nil {
			go g.ratingDiffs(p.client)
		}
	}
	finished := g.finished
	v, ok := g.viewLocked()
	// A game that just started takes over the board the first time.
	takeOver := ok && !g.shown && p.current == g.id
	g.shown = g.shown || takeOver
	p.mu.Unlock()
	if ok && p.hooks.Show != nil {
		p.hooks.Show(v, takeOver)
	}
	if save != "" {
		go p.hooks.Save(save)
	}
	if finished && g.cancel != nil {
		g.cancel()
	}
	p.emit()
}

// ratingDiffs shows how the finished rated game changed the ratings.
func (g *pgame) ratingDiffs(c *Client) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	d, err := c.RatingDiffs(ctx, g.id)
	if err != nil || d == nil {
		return
	}
	p := g.p
	p.mu.Lock()
	g.ratingDiff = d
	v, ok := g.viewLocked()
	p.mu.Unlock()
	if ok && p.hooks.Show != nil {
		p.hooks.Show(v, false)
	}
	p.emit()
}

func (g *pgame) opponent() GamePlayer {
	if g.color == chess.White {
		return g.black
	}
	return g.white
}

func (g *pgame) playViewLocked() PlayGameView {
	opp := g.opponent()
	name, rating, title := opp.DisplayName(), opp.Rating, opp.Title
	if !g.started && g.info != nil {
		name, rating = g.info.Opponent.Username, g.info.Opponent.Rating
	}
	status := g.state.Status
	if status == "" {
		status = "started"
	}
	moves := len(g.moves)
	turn := g.pos.Turn
	if g.pending != "" {
		moves++
		turn = turn.Other()
	}
	v := PlayGameView{GameView: GameView{
		ID: g.id, URL: g.url(), Opponent: name, OpponentTitle: title, OpponentRating: rating,
		Color: colorName(g.color), Rated: g.rated, Speed: g.speed, TC: g.tc, Status: status, Result: g.result,
		Moves: moves, MyTurn: g.started && !g.finished && turn == g.color, Finished: g.finished, Message: g.message,
	}, OnBoard: g.p.current == g.id}
	if !g.finished {
		mine, theirs := g.state.WDraw, g.state.BDraw
		tmine, ttheirs := g.state.WTakeback, g.state.BTakeback
		if g.color == chess.Black {
			mine, theirs, tmine, ttheirs = theirs, mine, ttheirs, tmine
		}
		v.Draw = offerState(mine, theirs)
		v.Takeback = offerState(tmine, ttheirs)
	}
	return v
}

func offerState(mine, theirs bool) string {
	switch {
	case theirs:
		return "theirs"
	case mine:
		return "mine"
	}
	return ""
}

func colorName(c chess.Color) string {
	if c == chess.Black {
		return "black"
	}
	return "white"
}

// viewLocked describes the game for the board.
func (g *pgame) viewLocked() (game.ExternalView, bool) {
	if !g.started {
		return game.ExternalView{}, false
	}
	p := g.p
	me := "You"
	if p.account != nil {
		me = p.account.Username
	}
	player := func(gp GamePlayer, ours bool) game.PlayerConfig {
		pc := game.PlayerConfig{Type: "lichess", Name: gp.DisplayName()}
		if gp.Rating > 0 {
			pc.Rating = fmt.Sprint(gp.Rating)
		}
		if gp.Title != "" && gp.Title != "BOT" {
			pc.Name = gp.Title + " " + pc.Name
		}
		if ours {
			pc.Type, pc.Name = "human", me
		}
		return pc
	}
	label := "Casual"
	if g.rated {
		label = "Rated"
	}
	if g.speed != "" {
		label += " " + g.speed
	}
	if g.tc != "" {
		label += " " + g.tc
	}
	moves := append([]string(nil), g.moves...)
	wms, bms, at := g.state.WTime, g.state.BTime, g.stateAt
	if g.pending != "" {
		// The move shows at once; the clock you used stops with it.
		moves = append(moves, g.pending)
		used := g.pendingAt.Sub(g.stateAt).Milliseconds()
		if len(g.moves) >= 2 && used > 0 {
			if g.color == chess.White {
				wms = max(0, wms-used)
			} else {
				bms = max(0, bms-used)
			}
		}
		at = g.pendingAt
	}
	v := game.ExternalView{
		ID: g.id, URL: g.url(), Label: "Lichess · " + label,
		Side: colorName(g.color), Kind: "play", Playable: true,
		White: player(g.white, g.color == chess.White), Black: player(g.black, g.color == chess.Black),
		StartFEN: g.startFEN, Moves: moves,
		WhiteMs: wms, BlackMs: bms, At: at,
		Finished: g.finished, Result: g.result, Reason: g.reason, RatingDiff: g.ratingDiff,
		Speed: g.speed, Users: &game.Users{White: gameUser(g.white), Black: gameUser(g.black)},
	}
	if !g.finished {
		v.Running = len(moves) >= 2 // Lichess starts the clocks after each side's first move
	}
	return v, true
}

func (g *pgame) pgnLocked() (string, error) {
	pl := func(gp GamePlayer) pgnPlayer {
		return pgnPlayer{Name: gp.DisplayName(), Title: gp.Title, Rating: gp.Rating}
	}
	return gamePGN(g.rated, g.speed, g.url(), pl(g.white), pl(g.black), g.initial, g.inc,
		g.startFEN, g.moves, g.result, g.reason, time.Now())
}
