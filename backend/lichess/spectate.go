package lichess

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"board/backend/chess"
	"board/backend/game"
	"board/backend/pgn"
)

// --- public game endpoints (no token needed) ---

// ExportPlayer is a player in an exported or streamed game.
type ExportPlayer struct {
	User *struct {
		ID    string `json:"id"`
		Name  string `json:"name"`
		Title string `json:"title"`
	} `json:"user"`
	Rating     int  `json:"rating"`
	RatingDiff *int `json:"ratingDiff"`
	AILevel    int  `json:"aiLevel"`
}

// RatingDiffs reads how a finished rated game changed the players' ratings.
// Lichess works it out a moment after the game ends, so this asks a few
// times, for up to about ten seconds.
func (c *Client) RatingDiffs(ctx context.Context, id string) (*game.RatingDiff, error) {
	wait := 500 * time.Millisecond
	var last error
	for try := 0; try < 6; try++ {
		if !sleepCtx(ctx, wait) {
			return nil, ctx.Err()
		}
		g, err := c.ExportGame(ctx, id)
		if err == nil && !g.Rated {
			return nil, nil
		}
		if err == nil && g.Players.White.RatingDiff != nil && g.Players.Black.RatingDiff != nil {
			return &game.RatingDiff{White: *g.Players.White.RatingDiff, Black: *g.Players.Black.RatingDiff}, nil
		}
		last = err
		wait = min(wait*2, 3*time.Second)
	}
	return nil, last
}

// exportUser is a player's username, "" for the computer.
func exportUser(p ExportPlayer) string {
	if p.User == nil {
		return ""
	}
	return p.User.Name
}

func (p ExportPlayer) Name() string {
	switch {
	case p.User != nil:
		return p.User.Name
	case p.AILevel > 0:
		return fmt.Sprintf("Stockfish level %d", p.AILevel)
	}
	return "Anonymous"
}

func (p ExportPlayer) ID() string {
	if p.User != nil {
		return strings.ToLower(p.User.ID)
	}
	return ""
}

func (p ExportPlayer) Title() string {
	if p.User != nil {
		return p.User.Title
	}
	return ""
}

// GameExport is a game as /api/user/{name}/current-game and /game/export
// give it in JSON. Fields that are a string in one API and an object in
// another are kept raw.
type GameExport struct {
	ID      string          `json:"id"`
	Rated   bool            `json:"rated"`
	Variant json.RawMessage `json:"variant"`
	Speed   string          `json:"speed"`
	Status  json.RawMessage `json:"status"`
	Players struct {
		White ExportPlayer `json:"white"`
		Black ExportPlayer `json:"black"`
	} `json:"players"`
	InitialFen string `json:"initialFen"`
	Winner     string `json:"winner"`
	Moves      string `json:"moves"` // SAN
	Clock      *struct {
		Initial   int64 `json:"initial"`   // seconds
		Increment int64 `json:"increment"` // seconds
	} `json:"clock"`
}

// MoveEvent is a line of /api/stream/game/{id}: a description of the game
// (ID set) or a position after a move.
type MoveEvent struct {
	GameExport
	Fen string `json:"fen"`
	LM  string `json:"lm"`
	WC  *int64 `json:"wc"` // seconds
	BC  *int64 `json:"bc"`
}

// keyName reads a field that is either "name" or {"key"/"name": "name"}.
func keyName(raw json.RawMessage, field string) string {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var obj map[string]any
	if json.Unmarshal(raw, &obj) == nil {
		if v, ok := obj[field].(string); ok {
			return v
		}
	}
	return ""
}

func (g GameExport) StatusName() string { return keyName(g.Status, "name") }
func (g GameExport) VariantKey() string { return keyName(g.Variant, "key") }

func (c *Client) getJSON(ctx context.Context, path string, out any) error {
	req, err := c.request(ctx, "GET", path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	res, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return apiError(res)
	}
	return json.NewDecoder(res.Body).Decode(out)
}

const exportQuery = "?moves=true&clocks=false&evals=false&opening=false&tags=false"

// CurrentGame is a player's ongoing game, or else their last game.
func (c *Client) CurrentGame(ctx context.Context, username string) (GameExport, error) {
	var g GameExport
	err := c.getJSON(ctx, "/api/user/"+url.PathEscape(username)+"/current-game"+exportQuery, &g)
	return g, err
}

// ExportGame is one game, ongoing or finished.
func (c *Client) ExportGame(ctx context.Context, id string) (GameExport, error) {
	var g GameExport
	err := c.getJSON(ctx, "/game/export/"+url.PathEscape(id)+exportQuery, &g)
	return g, err
}

// StreamMoves follows a game's moves until it ends.
func (c *Client) StreamMoves(ctx context.Context, id string, fn func(MoveEvent)) error {
	return c.stream(ctx, c.Stream, "/api/stream/game/"+url.PathEscape(id), func(line []byte) error {
		var e MoveEvent
		if err := json.Unmarshal(line, &e); err != nil {
			return nil
		}
		fn(e)
		return nil
	})
}

// --- the spectator ---

// SpectateStatus is sent to the UI as the "lichessWatch" event.
type SpectateStatus struct {
	Active  bool   `json:"active"`
	User    string `json:"user"`
	State   string `json:"state"` // idle, looking, live, waiting
	GameID  string `json:"gameId"`
	URL     string `json:"url"`
	Message string `json:"message"`
}

// Spectator follows the games of one Lichess player, live, on the board.
// No engine plays: it only watches, game after game.
type Spectator struct {
	mu     sync.Mutex
	emit   func(string, any)
	show   func(game.ExternalView)
	client *Client
	cancel context.CancelFunc
	gen    int
	status SpectateStatus
	g      *watched
	// Poll is how often to look for the player's next game.
	Poll time.Duration
	// Save, when set, receives the PGN of each watched game that finishes
	// while it is followed.
	Save func(pgn string)
}

// watched is the game being shown.
type watched struct {
	id, label    string
	white, black ExportPlayer
	side         string // the followed player's colour
	startFEN     string
	start, pos   chess.Position
	moves        []string
	wms, bms     int64
	at           time.Time
	clocked      bool
	finished     bool
	result       string
	reason       string
	// How the game ended, as the stream reported it, until the moves are
	// known to be complete.
	endStatus, endWinner string
	rated                bool
	speed                string
	initial, increment   int64 // seconds
	// Whether the game was seen being played (finished games only
	// shown are not saved).
	seenLive bool
	// The moves are being read again from the exported game.
	resyncing bool
	// How the ratings changed, once the rated game is over.
	ratingDiff *game.RatingDiff
}

func NewSpectator(emit func(string, any), show func(game.ExternalView)) *Spectator {
	return &Spectator{emit: emit, show: show, Poll: 5 * time.Second, status: SpectateStatus{State: "idle"}}
}

// Active reports whether a player is being followed.
func (s *Spectator) Active() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.status.Active
}

func (s *Spectator) Status() SpectateStatus {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.status
}

func (s *Spectator) publish() {
	if s.emit != nil {
		s.emit("lichessWatch", s.Status())
	}
}

// Start follows username's games on the server at baseURL.
func (s *Spectator) Start(baseURL, username string) error {
	username = strings.TrimSpace(username)
	if username == "" {
		return errors.New("enter the username to watch")
	}
	s.Stop()
	ctx, cancel := context.WithCancel(context.Background())
	s.mu.Lock()
	s.gen++
	gen := s.gen
	s.client = NewClient(baseURL, "")
	s.cancel = cancel
	s.g = nil
	s.status = SpectateStatus{Active: true, User: username, State: "looking", Message: "Looking for " + username + "'s game…"}
	s.mu.Unlock()
	s.publish()
	go s.follow(ctx, gen, username)
	return nil
}

// Stop stops following. The board keeps the last position.
func (s *Spectator) Stop() {
	s.mu.Lock()
	cancel := s.cancel
	was := s.status.Active
	s.cancel = nil
	s.gen++
	s.status = SpectateStatus{State: "idle"}
	s.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	if was {
		s.publish()
	}
}

func (s *Spectator) setStatus(gen int, f func(*SpectateStatus)) bool {
	s.mu.Lock()
	if gen != s.gen {
		s.mu.Unlock()
		return false
	}
	f(&s.status)
	s.mu.Unlock()
	s.publish()
	return true
}

func sleepCtx(ctx context.Context, d time.Duration) bool {
	select {
	case <-ctx.Done():
		return false
	case <-time.After(d):
		return true
	}
}

func (s *Spectator) follow(ctx context.Context, gen int, username string) {
	last := ""
	for ctx.Err() == nil {
		g, err := s.client.CurrentGame(ctx, username)
		if ctx.Err() != nil {
			return
		}
		wait := s.Poll
		if err != nil {
			var api *APIError
			msg := fmt.Sprintf("Could not reach Lichess (%v); trying again…", err)
			switch {
			case RateLimited(err):
				msg, wait = "Lichess asked to slow down; trying again in a minute…", time.Minute
			case errors.As(err, &api) && api.Status == http.StatusNotFound:
				msg, wait = username+" has no games yet (or there is no such player). Waiting for a game…", 2*s.Poll
			}
			if !s.setStatus(gen, func(st *SpectateStatus) { st.State, st.Message = "waiting", msg }) {
				return
			}
			if !sleepCtx(ctx, wait) {
				return
			}
			continue
		}
		live := g.StatusName() == "started" || g.StatusName() == "created"
		if live || g.ID != last {
			if err := s.load(gen, username, g); err != nil {
				s.setStatus(gen, func(st *SpectateStatus) { st.Message = err.Error() })
			} else if live {
				s.setStatus(gen, func(st *SpectateStatus) {
					st.State, st.GameID, st.URL, st.Message = "live", g.ID, s.gameURL(g.ID), ""
				})
				s.stream(ctx, gen, g.ID)
				if ctx.Err() != nil {
					return
				}
				// After the game, look for the next one shortly.
				wait = 2 * time.Second
			} else {
				s.setStatus(gen, func(st *SpectateStatus) {
					st.State, st.GameID, st.URL = "waiting", g.ID, s.gameURL(g.ID)
					st.Message = "Showing " + username + "'s last game. The next one appears when it starts."
				})
			}
			last = g.ID
		}
		s.mu.Lock()
		if gen == s.gen && s.g != nil && s.g.finished && s.status.State == "live" {
			s.status.State = "waiting"
			s.status.Message = "Game over. Waiting for " + username + "'s next game…"
			s.mu.Unlock()
			s.publish()
		} else {
			s.mu.Unlock()
		}
		if !sleepCtx(ctx, wait) {
			return
		}
	}
}

func (s *Spectator) gameURL(id string) string {
	return s.client.BaseURL + "/" + id
}

// load shows an exported game.
func (s *Spectator) load(gen int, username string, g GameExport) error {
	if v := g.VariantKey(); v != "" && v != "standard" && v != "fromPosition" {
		return fmt.Errorf("%s is playing %s, which Ponder cannot show", username, v)
	}
	w := &watched{id: g.ID, white: g.Players.White, black: g.Players.Black, side: "white"}
	if strings.EqualFold(g.Players.Black.ID(), username) {
		w.side = "black"
	}
	fen := g.InitialFen
	if fen == "" || fen == "startpos" {
		fen = chess.StartFEN
	}
	start, err := chess.ParseFEN(fen)
	if err != nil {
		return err
	}
	w.start, w.pos, w.startFEN = start, start, start.FEN()
	for _, san := range strings.Fields(g.Moves) {
		m, err := pgn.ParseMove(&w.pos, san)
		if err != nil {
			break
		}
		w.moves = append(w.moves, m.UCI())
		w.pos = w.pos.Make(m)
	}
	label := "Casual"
	if g.Rated {
		label = "Rated"
	}
	if g.Speed != "" {
		label += " " + g.Speed
	}
	w.rated, w.speed = g.Rated, g.Speed
	if g.Clock != nil {
		w.initial, w.increment = g.Clock.Initial, g.Clock.Increment
		label += fmt.Sprintf(" %g+%d", float64(g.Clock.Initial)/60, g.Clock.Increment)
		w.wms, w.bms, w.clocked = g.Clock.Initial*1000, g.Clock.Initial*1000, true
	}
	w.label = "Watching " + username + " · " + label
	if st := g.StatusName(); st != "started" && st != "created" && st != "" {
		w.finished = true
		w.result, w.reason = resultOf(GameState{Status: st, Winner: g.Winner})
		w.clocked = false // the final clocks are not in the export
	} else {
		w.seenLive = true
	}
	w.at = time.Now()
	s.mu.Lock()
	if gen != s.gen {
		s.mu.Unlock()
		return nil
	}
	s.g = w
	v := s.viewLocked()
	s.mu.Unlock()
	s.show(v)
	return nil
}

func (s *Spectator) stream(ctx context.Context, gen int, id string) {
	backoff := time.Second
	for ctx.Err() == nil {
		err := s.client.StreamMoves(ctx, id, func(e MoveEvent) { s.onMove(ctx, gen, e) })
		s.mu.Lock()
		done := gen != s.gen || s.g == nil || s.g.id != id || s.g.finished
		var endStatus, endWinner string
		if !done {
			endStatus, endWinner = s.g.endStatus, s.g.endWinner
		}
		s.mu.Unlock()
		if done || ctx.Err() != nil {
			return
		}
		// The stream ended: the game is over, or the connection dropped.
		// The exported game has every move, in case the stream missed some.
		if err == nil || endStatus != "" {
			g, e := s.client.ExportGame(ctx, id)
			if e == nil {
				if st := g.StatusName(); st != "started" && st != "created" {
					s.syncMoves(gen, g)
					s.finish(gen, id, st, g.Winner)
					return
				}
			} else if endStatus != "" {
				s.finish(gen, id, endStatus, endWinner)
				return
			}
		}
		if !sleepCtx(ctx, backoff) {
			return
		}
		if backoff < 15*time.Second {
			backoff *= 2
		}
	}
}

// syncMoves takes the moves of an exported game when it has more than are
// shown (or, with force, whatever it has: the export is the record).
func (s *Spectator) syncMoves(gen int, g GameExport, force ...bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	w := s.g
	if gen != s.gen || w == nil || w.id != g.ID {
		return
	}
	fen := g.InitialFen
	if fen == "" || fen == "startpos" {
		fen = chess.StartFEN
	}
	start, err := chess.ParseFEN(fen)
	if err != nil {
		return
	}
	pos := start
	var moves []string
	for _, san := range strings.Fields(g.Moves) {
		m, err := pgn.ParseMove(&pos, san)
		if err != nil {
			return
		}
		moves = append(moves, m.UCI())
		pos = pos.Make(m)
	}
	if len(moves) >= len(w.moves) || len(force) > 0 && force[0] {
		w.start, w.pos, w.startFEN, w.moves = start, pos, start.FEN(), moves
	}
}

func (s *Spectator) finish(gen int, id, status, winner string) {
	s.mu.Lock()
	w := s.g
	if gen != s.gen || w == nil || w.id != id || w.finished {
		s.mu.Unlock()
		return
	}
	w.finished = true
	w.result, w.reason = resultOf(GameState{Status: status, Winner: winner})
	if w.rated && w.result != "*" {
		go s.ratingDiffs(gen, id)
	}
	v := s.viewLocked()
	var save string
	if s.Save != nil && w.seenLive && w.result != "*" {
		pl := func(p ExportPlayer) pgnPlayer { return pgnPlayer{Name: p.Name(), Title: p.Title(), Rating: p.Rating} }
		save, _ = gamePGN(w.rated, w.speed, s.gameURL(w.id), pl(w.white), pl(w.black), w.initial, w.increment,
			w.startFEN, w.moves, w.result, w.reason, time.Now())
	}
	s.mu.Unlock()
	s.show(v)
	if save != "" {
		go s.Save(save)
	}
}

// fenKey is the placement and side to move of a FEN.
func fenKey(fen string) string {
	f := strings.Fields(fen)
	if len(f) < 2 {
		return fen
	}
	return f[0] + " " + f[1]
}

// bridge finds up to depth moves from pos that end with last and reach
// target: positions the stream reports after a gap (it is delayed, and a
// reconnect can skip moves).
func bridge(pos chess.Position, target, last string, depth int) ([]chess.Move, bool) {
	if m, err := parseMove(&pos, last); err == nil {
		next := pos.Make(m)
		if fenKey(next.FEN()) == target {
			return []chess.Move{m}, true
		}
	}
	if depth <= 1 {
		return nil, false
	}
	for _, m := range pos.LegalMoves() {
		if rest, ok := bridge(pos.Make(m), target, last, depth-1); ok {
			return append([]chess.Move{m}, rest...), true
		}
	}
	return nil, false
}

func (s *Spectator) onMove(ctx context.Context, gen int, e MoveEvent) {
	s.mu.Lock()
	w := s.g
	if gen != s.gen || w == nil || w.finished {
		s.mu.Unlock()
		return
	}
	if e.ID != "" { // a description: at the start, and when the game ends
		if st := e.StatusName(); st != "" && st != "started" && st != "created" {
			// Finished once the stream closes and the moves are checked.
			w.endStatus, w.endWinner = st, e.Winner
		}
		s.mu.Unlock()
		return
	}
	if e.Fen == "" {
		s.mu.Unlock()
		return
	}
	if e.WC != nil && e.BC != nil {
		w.wms, w.bms, w.clocked = *e.WC*1000, *e.BC*1000, true
	}
	w.at = time.Now()
	target := fenKey(e.Fen)
	// The ply the position is at, from the FEN's move number: Lichess
	// replays the game from the start when the stream opens, and sends
	// positions a few moves late.
	if ply, known := plyOf(e.Fen); known {
		if base, ok := plyOf(w.startFEN); ok {
			n := ply - base
			switch {
			case n < 0:
				s.mu.Unlock()
				return // before the start shown: nothing to add
			case n <= len(w.moves):
				// A position already shown (or the current one).
				s.mu.Unlock()
				return
			case n == len(w.moves)+1 && e.LM != "":
				m, err := parseMove(&w.pos, e.LM)
				next := w.pos.Make(m)
				if err == nil && fenKey(next.FEN()) == target {
					w.moves = append(w.moves, m.UCI())
					w.pos = next
					v := s.viewLocked()
					s.mu.Unlock()
					s.show(v)
					return
				}
			}
			// Moves were missed (or did not fit): read the game again.
			if !w.resyncing {
				w.resyncing = true
				go s.resync(ctx, gen, w.id, e.Fen)
			}
			s.mu.Unlock()
			return
		}
	}
	if fenKey(w.pos.FEN()) != target {
		ok := false
		if e.LM != "" {
			var ms []chess.Move
			if ms, ok = bridge(w.pos, target, e.LM, 4); ok {
				for _, m := range ms {
					w.moves = append(w.moves, m.UCI())
					w.pos = w.pos.Make(m)
				}
			}
		}
		if !ok && w.seen(target) {
			// A position already shown: Lichess replays the game from the
			// start when the stream opens, and sends it a few moves late.
			s.mu.Unlock()
			return
		}
		if !ok && !w.resyncing {
			// Moves were missed: read the whole game again rather than lose
			// the moves before this position.
			w.resyncing = true
			go s.resync(ctx, gen, w.id, e.Fen)
		}
	}
	v := s.viewLocked()
	s.mu.Unlock()
	s.show(v)
}

// plyOf is the number of moves played before a FEN's position, from its
// move number and side to move.
func plyOf(fen string) (int, bool) {
	f := strings.Fields(fen)
	if len(f) < 6 {
		return 0, false
	}
	n, err := strconv.Atoi(f[5])
	if err != nil || n < 1 {
		return 0, false
	}
	ply := (n - 1) * 2
	if f[1] == "b" {
		ply++
	}
	return ply, true
}

// seen reports whether the position (placement and side to move) occurred
// in the game so far.
func (w *watched) seen(key string) bool {
	pos := w.start
	if fenKey(pos.FEN()) == key {
		return true
	}
	for _, u := range w.moves {
		m, err := pos.ParseUCIMove(u)
		if err != nil {
			return false
		}
		pos = pos.Make(m)
		if fenKey(pos.FEN()) == key {
			return true
		}
	}
	return false
}

// resync reads a game's moves from its export after the stream skipped
// some. Only if that fails does the list start again from the position
// the stream sent (fen).
func (s *Spectator) resync(ctx context.Context, gen int, id, fen string) {
	g, err := s.client.ExportGame(ctx, id)
	if err == nil {
		s.syncMoves(gen, g, true)
	}
	s.mu.Lock()
	w := s.g
	if gen != s.gen || w == nil || w.id != id {
		s.mu.Unlock()
		return
	}
	w.resyncing = false
	if err != nil && !w.seen(fenKey(fen)) {
		if p, perr := chess.ParseFEN(fen); perr == nil {
			w.start, w.pos, w.startFEN, w.moves = p, p, p.FEN(), nil
		}
	}
	v := s.viewLocked()
	s.mu.Unlock()
	s.show(v)
}

// ratingDiffs shows how the finished game changed the ratings.
func (s *Spectator) ratingDiffs(gen int, id string) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	d, err := s.client.RatingDiffs(ctx, id)
	if err != nil || d == nil {
		return
	}
	s.mu.Lock()
	w := s.g
	if gen != s.gen || w == nil || w.id != id {
		s.mu.Unlock()
		return
	}
	w.ratingDiff = d
	v := s.viewLocked()
	s.mu.Unlock()
	s.show(v)
}

func (s *Spectator) viewLocked() game.ExternalView {
	w := s.g
	player := func(p ExportPlayer) game.PlayerConfig {
		pc := game.PlayerConfig{Type: "lichess", Name: p.Name()}
		if t := p.Title(); t != "" && t != "BOT" {
			pc.Name = t + " " + pc.Name
		}
		if p.Rating > 0 {
			pc.Rating = fmt.Sprint(p.Rating)
		}
		return pc
	}
	v := game.ExternalView{
		ID: w.id, URL: s.gameURL(w.id), Label: w.label, Side: w.side, Kind: "spectate",
		White: player(w.white), Black: player(w.black),
		StartFEN: w.startFEN, Moves: append([]string(nil), w.moves...),
		At: w.at, Finished: w.finished, Result: w.result, Reason: w.reason,
		RatingDiff: w.ratingDiff, Speed: w.speed,
		Users: &game.Users{White: exportUser(w.white), Black: exportUser(w.black)},
	}
	if w.clocked {
		v.WhiteMs, v.BlackMs = w.wms, w.bms
		v.Running = !w.finished && len(w.moves) >= 2
	}
	return v
}
