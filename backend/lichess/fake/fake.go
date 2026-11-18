// Package fake is a small stand-in for the Lichess Bot API, used by tests
// and by the end-to-end test of the app. It hosts one bot account and plays
// the opposing side of every game itself, choosing moves at random.
package fake

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"board/backend/chess"
)

// OnlineBot is a bot listed as online.
type OnlineBot struct {
	Name   string
	Rating int
}

type user struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Title    string `json:"title,omitempty"`
	Rating   int    `json:"rating,omitempty"`
	Online   bool   `json:"online,omitempty"`
	Username string `json:"username,omitempty"`
}

type challenge struct {
	ID          string         `json:"id"`
	URL         string         `json:"url"`
	Status      string         `json:"status"`
	Challenger  user           `json:"challenger"`
	DestUser    user           `json:"destUser"`
	Variant     map[string]any `json:"variant"`
	Rated       bool           `json:"rated"`
	Speed       string         `json:"speed"`
	TimeControl map[string]any `json:"timeControl"`
	Color       string         `json:"color"`
	Direction   string         `json:"direction,omitempty"`
	Decline     string         `json:"declineReason,omitempty"`

	limit, inc int // seconds
	variant    string
}

// Game is a game between the bot and a fake opponent.
type Game struct {
	ID        string
	BotWhite  bool
	Opponent  user
	Rated     bool
	start     chess.Position
	pos       chess.Position
	Moves     []string
	wtime     int64
	btime     int64
	inc       int64
	turnStart time.Time
	Status    string
	Winner    string
	subs      []chan string
	limit     int
	// A game between two other players, both moved by the server.
	auto         bool
	white, black user
	watchers     []chan string
	endedAt      time.Time
	// Offers in a Board API game: the account's ("my") and the opponent's.
	myDraw, oppDraw, myTakeback, oppTakeback bool
	// The players' room of the chat, as GET …/chat gives it.
	chat []map[string]string
}

// Server is the fake Lichess. Its fields may be set before use.
type Server struct {
	Token    string // required bearer token
	Username string
	Bot      bool          // the account is a Bot account
	Delay    time.Duration // opponent "thinking" time
	// Opponents that never accept outgoing challenges.
	Decliners map[string]string // username → decline reason
	MaxPlies  int               // games longer than this are drawn (default 300)
	Silent    map[string]bool   // opponents that never answer a challenge
	// The bots online, with their blitz ratings (other speeds: +/-100).
	Online []OnlineBot
	// Rate limits on challenges sent, as Lichess answers them: the next
	// RateLimited challenges get a 429 (with the daily bot-game limit and
	// RateLimitSeconds when above 0; a bare 429 otherwise), and challenges
	// to the bots in BotsDone get a 400 saying they have played their bot
	// games for the day (the value: seconds until they may play again).
	RateLimited      int
	RateLimitSeconds float64
	BotsDone         map[string]float64
	// The opponent accepts draw offers and takeback proposals (Board API).
	AcceptOffers bool
	// Like Lichess, the spectator stream (/api/stream/game) starts by
	// replaying every position of the game; StreamLag sends each position
	// that many moves late, and positions after plies in Drop are lost.
	StreamLag int
	Drop      map[int]bool
	// Reply, when set, chooses the opponent's move in a position reached
	// after ply moves (a UCI move; "" or an illegal one: a random move).
	Reply func(pos chess.Position, ply int) string
	// Tablebase is the category the endgame tablebase (/tablebase/standard)
	// gives every position ("": unknown); TablebaseAsked counts its calls.
	Tablebase      string
	TablebaseAsked int
	// DrawOffers counts the moves of the account's that came with a draw offer.
	DrawOffers int
	// OAuth: the code challenges of sign-ins in progress, by code.
	oauth map[string]string

	mu      sync.Mutex
	next    int
	events  []chan string
	pending map[string]*challenge
	games   map[string]*Game
	rng     *rand.Rand
	Log     []string // API calls made, for tests
}

func New(token, username string) *Server {
	return &Server{Token: token, Username: username, Bot: true, Delay: 100 * time.Millisecond,
		Decliners: map[string]string{"grumpy": "later", "picky": "tooFast"},
		Silent:    map[string]bool{"sleepy": true},
		Online: []OnlineBot{{"maia1", 1500}, {"SlowBot", 1900}, {"grumpy", 1700}, {"picky", 1750},
			{"sleepy", 1650}, {"strongbot", 2600}},
		AcceptOffers: true, oauth: map[string]string{},
		pending: map[string]*challenge{}, games: map[string]*Game{}, rng: rand.New(rand.NewSource(1))}
}

func (s *Server) me() user {
	u := user{ID: strings.ToLower(s.Username), Name: s.Username, Rating: 1500, Username: s.Username}
	if s.Bot {
		u.Title = "BOT"
	}
	return u
}

func (s *Server) id() string {
	s.next++
	return fmt.Sprintf("g%07d", s.next)
}

func line(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

func (s *Server) broadcastLocked(v any) {
	l := line(v)
	for _, ch := range s.events {
		select {
		case ch <- l:
		default:
		}
	}
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	if strings.HasPrefix(path, "/_fake/") {
		s.control(w, r)
		return
	}
	if s.public(w, r) {
		return
	}
	if r.Header.Get("Authorization") != "Bearer "+s.Token {
		w.WriteHeader(401)
		fmt.Fprint(w, `{"error":"No such token"}`)
		return
	}
	s.mu.Lock()
	s.Log = append(s.Log, r.Method+" "+path)
	s.mu.Unlock()
	parts := strings.Split(strings.Trim(path, "/"), "/")
	ok := func(v any) {
		w.Header().Set("Content-Type", "application/json")
		if v == nil {
			v = map[string]bool{"ok": true}
		}
		json.NewEncoder(w).Encode(v)
	}
	bad := func(msg string) {
		w.WriteHeader(400)
		fmt.Fprint(w, line(map[string]string{"error": msg}))
	}
	switch {
	case path == "/api/challenge" && r.Method == "GET":
		// The challenges waiting: those to the bot and those it sent.
		s.mu.Lock()
		in, out := []*challenge{}, []*challenge{}
		for _, c := range s.pending {
			if c.Direction == "out" {
				out = append(out, c)
			} else {
				in = append(in, c)
			}
		}
		s.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, line(map[string]any{"in": in, "out": out}))
	case path == "/api/account":
		s.mu.Lock()
		u := s.me()
		s.mu.Unlock()
		ok(u)
	case path == "/api/bot/account/upgrade":
		s.mu.Lock()
		s.Bot = true
		s.mu.Unlock()
		ok(nil)
	case path == "/api/stream/event":
		s.streamEvents(w, r)
	case len(parts) == 5 && (parts[1] == "bot" || parts[1] == "board") && parts[2] == "game" && parts[3] == "stream":
		s.streamGame(w, r, parts[4])
	case len(parts) == 6 && (parts[1] == "bot" || parts[1] == "board") && parts[2] == "game" && parts[4] == "move":
		if err := s.botMove(parts[3], parts[5], r.URL.Query().Get("offeringDraw") == "true"); err != nil {
			bad(err.Error())
			return
		}
		ok(nil)
	case len(parts) == 6 && (parts[1] == "board" || (parts[1] == "bot" && parts[4] == "draw")) && parts[2] == "game" && (parts[4] == "draw" || parts[4] == "takeback"):
		if err := s.boardOffer(parts[3], parts[4], parts[5] == "yes"); err != nil {
			bad(err.Error())
			return
		}
		ok(nil)
	case len(parts) == 5 && (parts[1] == "bot" || parts[1] == "board") && parts[2] == "game" && parts[4] == "chat":
		s.mu.Lock()
		g := s.games[parts[3]]
		if g == nil {
			s.mu.Unlock()
			w.WriteHeader(404)
			fmt.Fprint(w, `{"error":"Not found"}`)
			return
		}
		if r.Method == "GET" {
			history := append([]map[string]string{}, g.chat...)
			s.mu.Unlock()
			ok(history)
			return
		}
		r.ParseForm()
		room, text := r.Form.Get("room"), r.Form.Get("text")
		if (room != "player" && room != "spectator") || text == "" || len([]rune(text)) > 140 {
			s.mu.Unlock()
			bad("Invalid chat message")
			return
		}
		s.chatLocked(g, s.Username, room, text)
		// Someone answers, so there is a conversation to see.
		who := g.Opponent.Name
		if room == "spectator" {
			who = "Kibitzer"
		}
		time.AfterFunc(s.Delay, func() { s.Say(g.ID, who, room, "You said: "+text) })
		s.mu.Unlock()
		ok(nil)
	case path == "/api/board/seek" && r.Method == "POST":
		s.seek(w, r)
	case len(parts) == 5 && (parts[1] == "bot" || parts[1] == "board") && parts[2] == "game" && (parts[4] == "resign" || parts[4] == "abort"):
		if err := s.botEnd(parts[3], parts[4]); err != nil {
			bad(err.Error())
			return
		}
		ok(nil)
	case len(parts) == 4 && parts[1] == "challenge" && parts[3] == "accept":
		if err := s.accept(parts[2]); err != nil {
			bad(err.Error())
			return
		}
		ok(nil)
	case len(parts) == 4 && parts[1] == "challenge" && (parts[3] == "decline" || parts[3] == "cancel"):
		r.ParseForm()
		s.mu.Lock()
		ch := s.pending[parts[2]]
		if ch != nil {
			delete(s.pending, parts[2])
			ch.Decline = r.Form.Get("reason")
			typ, status := "challengeCanceled", "canceled"
			if parts[3] == "decline" {
				typ, status = "challengeDeclined", "declined"
			}
			ch.Status = status
			s.broadcastLocked(map[string]any{"type": typ, "challenge": ch})
			s.Log = append(s.Log, "decline-reason "+ch.Decline)
		}
		s.mu.Unlock()
		if ch == nil {
			w.WriteHeader(404)
			fmt.Fprint(w, `{"error":"Not found"}`)
			return
		}
		ok(nil)
	case len(parts) == 3 && parts[1] == "challenge" && r.Method == "POST":
		r.ParseForm()
		s.mu.Lock()
		limited, secs := s.RateLimited > 0, s.RateLimitSeconds
		if limited {
			s.RateLimited--
		}
		done, opponentDone := s.BotsDone[strings.ToLower(parts[2])]
		s.mu.Unlock()
		if limited {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusTooManyRequests)
			if secs > 0 {
				fmt.Fprintf(w, `{"error":"You have played too many games against bots today","ratelimit":{"key":"bot.vsBot.day","seconds":%g}}`, secs)
			} else {
				fmt.Fprint(w, `{"error":"Too many requests. Try again later."}`)
			}
			return
		}
		if opponentDone {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			fmt.Fprintf(w, `{"error":"%s has played too many games against bots today","ratelimit":{"key":"bot.vsBot.day","seconds":%g}}`, parts[2], done)
			return
		}
		ch, err := s.outgoing(parts[2], r)
		if err != nil {
			bad(err.Error())
			return
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, ch)
	default:
		w.WriteHeader(404)
		fmt.Fprint(w, `{"error":"Not found"}`)
	}
}

func flushLines(w http.ResponseWriter, r *http.Request, ch chan string, first []string) {
	w.Header().Set("Content-Type", "application/x-ndjson")
	fl, _ := w.(http.Flusher)
	for _, l := range first {
		fmt.Fprintln(w, l)
	}
	if fl != nil {
		fl.Flush()
	}
	tick := time.NewTicker(2 * time.Second)
	defer tick.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case l, open := <-ch:
			if !open {
				return
			}
			fmt.Fprintln(w, l)
		case <-tick.C:
			fmt.Fprintln(w) // keep-alive
		}
		if fl != nil {
			fl.Flush()
		}
	}
}

func (s *Server) streamEvents(w http.ResponseWriter, r *http.Request) {
	ch := make(chan string, 64)
	s.mu.Lock()
	s.events = append(s.events, ch)
	var first []string
	// Like Lichess, games in progress and open challenges are sent first.
	for _, g := range s.games {
		if g.Status == "started" {
			first = append(first, line(map[string]any{"type": "gameStart", "game": s.gameInfoLocked(g)}))
		}
	}
	for _, c := range s.pending {
		first = append(first, line(map[string]any{"type": "challenge", "challenge": c}))
	}
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		for i, c := range s.events {
			if c == ch {
				s.events = append(s.events[:i], s.events[i+1:]...)
				break
			}
		}
		s.mu.Unlock()
	}()
	flushLines(w, r, ch, first)
}

// SetOnline changes the bots listed as online.
func (s *Server) SetOnline(bots ...OnlineBot) {
	s.mu.Lock()
	s.Online = bots
	s.mu.Unlock()
}

// Listeners is the number of open event streams.
func (s *Server) Listeners() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.events)
}

// DropStreams closes all event streams, as a lost connection would.
func (s *Server) DropStreams() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, ch := range s.events {
		close(ch)
	}
	s.events = nil
}

func (s *Server) gameInfoLocked(g *Game) map[string]any {
	color := "black"
	if g.BotWhite {
		color = "white"
	}
	return map[string]any{
		"id": g.ID, "gameId": g.ID, "fullId": g.ID + "abcd", "color": color, "fen": g.pos.FEN(),
		"rated": g.Rated, "speed": "blitz", "variant": map[string]string{"key": "standard", "name": "Standard"},
		"isMyTurn": (g.pos.Turn == chess.White) == g.BotWhite,
		"opponent": map[string]any{"id": g.Opponent.ID, "username": g.Opponent.Name, "rating": g.Opponent.Rating},
	}
}

func (s *Server) clocksLocked(g *Game) (int64, int64) {
	w, b := g.wtime, g.btime
	if !g.turnStart.IsZero() && g.Status == "started" {
		el := time.Since(g.turnStart).Milliseconds()
		if g.pos.Turn == chess.White {
			w -= el
		} else {
			b -= el
		}
	}
	return max(w, 0), max(b, 0)
}

func (s *Server) stateLocked(g *Game) map[string]any {
	w, b := s.clocksLocked(g)
	st := map[string]any{"type": "gameState", "moves": strings.Join(g.Moves, " "),
		"wtime": w, "btime": b, "winc": g.inc, "binc": g.inc, "status": g.Status}
	white := map[bool]string{true: "w", false: "b"}
	for _, o := range []struct {
		on   bool
		mine bool
		kind string
	}{{g.myDraw, true, "draw"}, {g.oppDraw, false, "draw"}, {g.myTakeback, true, "takeback"}, {g.oppTakeback, false, "takeback"}} {
		if o.on {
			st[white[o.mine == g.BotWhite]+o.kind] = true
		}
	}
	if g.Winner != "" {
		st["winner"] = g.Winner
	}
	return st
}

func (s *Server) publishLocked(g *Game) {
	l := line(s.stateLocked(g))
	for _, ch := range g.subs {
		select {
		case ch <- l:
		default:
		}
	}
}

func (s *Server) chatLocked(g *Game, username, room, text string) {
	if room == "player" {
		g.chat = append(g.chat, map[string]string{"user": username, "text": text})
	}
	l := line(map[string]string{"type": "chatLine", "username": username, "text": text, "room": room})
	for _, ch := range g.subs {
		select {
		case ch <- l:
		default:
		}
	}
}

// Say posts a chat message in a game as username (room: player or
// spectator). It reports whether there is such a game.
func (s *Server) Say(id, username, room, text string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	g := s.games[id]
	if g == nil {
		return false
	}
	s.chatLocked(g, username, room, text)
	return true
}

func (s *Server) streamGame(w http.ResponseWriter, r *http.Request, id string) {
	s.mu.Lock()
	g := s.games[id]
	if g == nil {
		s.mu.Unlock()
		w.WriteHeader(404)
		fmt.Fprint(w, `{"error":"Not found"}`)
		return
	}
	ch := make(chan string, 64)
	g.subs = append(g.subs, ch)
	me := s.me()
	white, black := me, g.Opponent
	if !g.BotWhite {
		white, black = g.Opponent, me
	}
	full := map[string]any{
		"type": "gameFull", "id": g.ID, "rated": g.Rated, "speed": "blitz",
		"variant": map[string]string{"key": "standard", "name": "Standard"},
		"clock":   map[string]int64{"initial": int64(g.limit) * 1000, "increment": g.inc},
		"white":   white, "black": black, "initialFen": "startpos",
		"state": s.stateLocked(g),
	}
	first := []string{line(full)}
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		for i, c := range g.subs {
			if c == ch {
				g.subs = append(g.subs[:i], g.subs[i+1:]...)
				break
			}
		}
		s.mu.Unlock()
	}()
	flushLines(w, r, ch, first)
}

func (s *Server) startGameLocked(c *challenge, botWhite bool, opp user) *Game {
	g := &Game{ID: c.ID, BotWhite: botWhite, Opponent: opp, Rated: c.Rated, Status: "started",
		wtime: int64(c.limit) * 1000, btime: int64(c.limit) * 1000, inc: int64(c.inc) * 1000, limit: c.limit}
	g.start, _ = chess.ParseFEN(chess.StartFEN)
	g.pos = g.start
	s.games[g.ID] = g
	s.broadcastLocked(map[string]any{"type": "gameStart", "game": s.gameInfoLocked(g)})
	s.opponentTurnLocked(g)
	return g
}

// public serves the endpoints that need no token. It reports whether it
// handled the request.
func (s *Server) public(w http.ResponseWriter, r *http.Request) bool {
	path := r.URL.Path
	parts := strings.Split(strings.Trim(path, "/"), "/")
	notFound := func() {
		w.WriteHeader(404)
		fmt.Fprint(w, `{"error":"Not found"}`)
	}
	switch {
	case path == "/tablebase/standard":
		s.mu.Lock()
		s.TablebaseAsked++
		category := s.Tablebase
		s.mu.Unlock()
		if category == "" {
			category = "unknown"
		}
		fmt.Fprint(w, line(map[string]any{"category": category, "moves": []any{}}))
	case path == "/oauth":
		// Sign-in: approve at once and send the browser back with a code.
		q := r.URL.Query()
		code := fmt.Sprintf("code%d", time.Now().UnixNano())
		s.mu.Lock()
		s.oauth[code] = q.Get("code_challenge")
		s.mu.Unlock()
		http.Redirect(w, r, q.Get("redirect_uri")+"?code="+code+"&state="+q.Get("state"), http.StatusFound)
	case path == "/api/token" && r.Method == "POST":
		r.ParseForm()
		s.mu.Lock()
		want, found := s.oauth[r.Form.Get("code")]
		delete(s.oauth, r.Form.Get("code"))
		s.mu.Unlock()
		sum := sha256.Sum256([]byte(r.Form.Get("code_verifier")))
		if !found || base64.RawURLEncoding.EncodeToString(sum[:]) != want || r.Form.Get("grant_type") != "authorization_code" {
			w.WriteHeader(400)
			fmt.Fprint(w, `{"error":"invalid_grant"}`)
			return true
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, line(map[string]any{"token_type": "Bearer", "access_token": s.Token, "expires_in": 31536000}))
	case path == "/api/token" && r.Method == "DELETE":
		w.WriteHeader(204)
	case path == "/api/bot/online":
		w.Header().Set("Content-Type", "application/x-ndjson")
		s.mu.Lock()
		online := append([]OnlineBot(nil), s.Online...)
		s.mu.Unlock()
		if nb, err := strconv.Atoi(r.URL.Query().Get("nb")); err == nil && nb < len(online) {
			online = online[:nb]
		}
		flags := []string{"US", "DE", "FR", "IN", "BR", "NO"}
		for i, b := range online {
			perf := func(r, games int) map[string]any {
				p := map[string]any{"rating": r, "games": games, "rd": 50, "prog": (r % 23) - 11}
				if games < 20 {
					p["prov"] = true
				}
				return p
			}
			fmt.Fprintln(w, line(map[string]any{
				"id": strings.ToLower(b.Name), "username": b.Name, "title": "BOT", "online": true,
				"perfs": map[string]any{"bullet": perf(b.Rating-100, 40+i*30), "blitz": perf(b.Rating, 500+i*100),
					"rapid": perf(b.Rating+100, 200+i*10), "classical": perf(b.Rating+150, i*5)},
				"createdAt": time.Now().Add(-time.Duration(i+1) * 400 * 24 * time.Hour).UnixMilli(),
				"seenAt":    time.Now().Add(-time.Duration(i) * time.Minute).UnixMilli(),
				"playTime":  map[string]int{"total": 3600 * (100 + i*50), "tv": 60 * i},
				"profile":   map[string]string{"flag": flags[i%len(flags)], "bio": b.Name + " is a test bot that plays random moves."},
			}))
		}
	case path == "/api/users" && r.Method == "POST":
		// Several players' profiles at once: a list of ids in the body.
		body, _ := io.ReadAll(io.LimitReader(r.Body, 64*1024))
		var out []map[string]any
		for _, id := range strings.Split(string(body), ",") {
			if id = strings.TrimSpace(id); id != "" && !strings.HasPrefix(strings.ToLower(id), "ghost") {
				out = append(out, fakeProfile(id))
			}
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, line(out))
	case path == "/api/users/status":
		ids := strings.Split(r.URL.Query().Get("ids"), ",")
		s.mu.Lock()
		var out []map[string]any
		for _, id := range ids {
			id = strings.ToLower(strings.TrimSpace(id))
			if id == "" {
				continue
			}
			st := map[string]any{"id": id, "name": id, "online": true}
			for _, b := range s.Online {
				if strings.ToLower(b.Name) == id {
					st["name"], st["title"] = b.Name, "BOT"
				}
			}
			for _, g := range s.games {
				if g.Status != "started" {
					continue
				}
				in := g.Opponent.ID == id
				if g.auto {
					in = g.white.ID == id || g.black.ID == id
				}
				if in {
					st["playing"] = map[string]any{"id": g.ID, "clock": fmt.Sprintf("%d+%d", g.limit/60, g.inc/1000), "variant": "standard"}
				}
			}
			out = append(out, st)
		}
		s.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, line(out))
	case len(parts) == 3 && parts[0] == "api" && parts[1] == "user":
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, line(fakeProfile(parts[2])))
	case len(parts) == 4 && parts[0] == "api" && parts[1] == "user" && parts[3] == "rating-history":
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, line(fakeHistory(parts[2])))
	case len(parts) == 5 && parts[0] == "api" && parts[1] == "user" && parts[3] == "perf":
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, line(fakePerfStat(parts[2], parts[4])))
	case len(parts) == 4 && parts[0] == "api" && parts[1] == "crosstable":
		a, b := fakeSeed(parts[2]), fakeSeed(parts[3])
		n := (a+b)%17 + 3
		sa := float64((a*7+b)%(n*2+1)) / 2
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, line(map[string]any{"users": map[string]float64{strings.ToLower(parts[2]): sa, strings.ToLower(parts[3]): float64(n) - sa}, "nbGames": n}))
	case len(parts) == 4 && parts[0] == "api" && parts[1] == "user" && parts[3] == "current-game":
		s.mu.Lock()
		var found *Game
		for _, g := range s.games {
			if g.auto && (g.white.ID == strings.ToLower(parts[2]) || g.black.ID == strings.ToLower(parts[2])) {
				if found == nil || g.ID > found.ID {
					found = g
				}
			}
		}
		var out string
		if found != nil {
			out = line(s.exportLocked(found))
		}
		s.mu.Unlock()
		if found == nil {
			notFound()
			return true
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, out)
	case len(parts) == 4 && parts[0] == "api" && parts[1] == "games" && parts[2] == "user":
		// The player's games in progress, the latest first.
		s.mu.Lock()
		var ids []string
		for id, g := range s.games {
			if g.auto && g.Status == "started" && (g.white.ID == strings.ToLower(parts[3]) || g.black.ID == strings.ToLower(parts[3])) {
				ids = append(ids, id)
			}
		}
		sort.Sort(sort.Reverse(sort.StringSlice(ids)))
		var out strings.Builder
		for _, id := range ids {
			out.WriteString(line(s.exportLocked(s.games[id])) + "\n")
		}
		s.mu.Unlock()
		w.Header().Set("Content-Type", "application/x-ndjson")
		fmt.Fprint(w, out.String())
	case len(parts) == 3 && parts[0] == "game" && parts[1] == "export":
		s.mu.Lock()
		g := s.games[parts[2]]
		var out string
		if g != nil {
			out = line(s.exportLocked(g))
		}
		s.mu.Unlock()
		if g == nil {
			notFound()
			return true
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, out)
	case len(parts) == 4 && parts[0] == "api" && parts[1] == "stream" && parts[2] == "game":
		s.streamMoves(w, r, parts[3])
	case path == "/api/tv/channels":
		// Every channel shows the same game: the featured one.
		s.mu.Lock()
		out := map[string]any{}
		if g := s.featuredLocked(""); g != nil {
			white, _ := g.players()
			for _, ch := range []string{"best", "blitz", "bot"} {
				out[ch] = map[string]any{"user": map[string]string{"id": white.ID, "name": white.Name, "title": white.Title},
					"rating": white.Rating, "gameId": g.ID, "color": "white"}
			}
		}
		s.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, line(out))
	case path == "/api/tv/feed" || len(parts) == 4 && parts[0] == "api" && parts[1] == "tv" && parts[3] == "feed":
		s.mu.Lock()
		s.Log = append(s.Log, "GET "+path)
		s.mu.Unlock()
		s.tvFeed(w, r)
	case path == "/masters" || path == "/lichess":
		// The opening explorer: needs a token, like the real one.
		if r.Header.Get("Authorization") != "Bearer "+s.Token {
			w.WriteHeader(401)
			fmt.Fprint(w, `{"error":"No such token"}`)
			return true
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, line(explorerData(r.URL.Query().Get("fen"), path == "/masters")))
	case strings.HasPrefix(path, "/masters/pgn/"):
		w.Header().Set("Content-Type", "application/x-chess-pgn")
		fmt.Fprint(w, "[Event \"Fake Masters\"]\n[White \"Carlsen, M.\"]\n[Black \"Anand, V.\"]\n[Result \"1-0\"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 1-0\n")
	case path == "/api/puzzle/next" || path == "/api/puzzle/daily":
		w.Header().Set("Content-Type", "application/json")
		// Légal's mate: 5. Nxe5! Bxd1 6. Bxf7+ Ke7 7. Nd5#.
		fmt.Fprint(w, line(map[string]any{
			"game": map[string]any{"id": "fakeGame", "clock": "5+0", "rated": true, "pgn": "e4 e5 Nf3 d6 Bc4 Bg4 Nc3 g6",
				"perf":    map[string]string{"key": "blitz", "name": "Blitz"},
				"players": []map[string]any{{"color": "white", "id": "a", "name": "A", "rating": 1500}, {"color": "black", "id": "b", "name": "B", "rating": 1500}}},
			"puzzle": map[string]any{"id": "fakePz", "rating": 1450, "plays": 10, "initialPly": 7,
				"solution": []string{"f3e5", "g4d1", "c4f7", "e8e7", "c3d5"}, "themes": []string{"mateIn3", "sacrifice"}},
		}))
	default:
		return false
	}
	return true
}

func (g *Game) players() (user, user) {
	if g.auto || g.white.ID != "" {
		return g.white, g.black
	}
	return user{}, user{}
}

func (s *Server) exportLocked(g *Game) map[string]any {
	white, black := g.players()
	pl := func(u user) map[string]any {
		return map[string]any{"user": map[string]string{"id": u.ID, "name": u.Name, "title": u.Title}, "rating": u.Rating}
	}
	pos := g.start
	var sans []string
	for _, m := range g.Moves {
		mv, _ := pos.ParseUCIMove(m)
		sans = append(sans, pos.SAN(mv))
		pos = pos.Make(mv)
	}
	out := map[string]any{
		"id": g.ID, "rated": g.Rated, "variant": "standard", "speed": "blitz", "status": g.Status,
		"players": map[string]any{"white": pl(white), "black": pl(black)},
		"moves":   strings.Join(sans, " "),
		"clock":   map[string]int64{"initial": int64(g.limit), "increment": g.inc / 1000},
	}
	if g.Winner != "" {
		out["winner"] = g.Winner
	}
	// Rated games: the rating changes, a moment after the end (like Lichess).
	if g.Status != "started" && g.Status != "created" && g.endedAt.IsZero() {
		g.endedAt = time.Now()
	}
	if g.Rated && g.Status != "started" && g.Status != "created" && time.Since(g.endedAt) >= s.Delay {
		diff := map[string]int{"white": 0, "black": 0}
		switch g.Winner {
		case "white":
			diff["white"], diff["black"] = 8, -8
		case "black":
			diff["white"], diff["black"] = -9, 9
		}
		for side, d := range diff {
			out["players"].(map[string]any)[side].(map[string]any)["ratingDiff"] = d
		}
	}
	return out
}

func (s *Server) describeLocked(g *Game) map[string]any {
	d := s.exportLocked(g)
	delete(d, "moves")
	d["variant"] = map[string]string{"key": "standard", "name": "Standard"}
	d["status"] = map[string]any{"id": 20, "name": g.Status}
	d["fen"] = g.pos.FEN()
	d["turns"] = len(g.Moves)
	return d
}

func (s *Server) entryLocked(g *Game) map[string]any {
	return s.entryAtLocked(g, len(g.Moves))
}

// entryAtLocked is the stream line for the position after ply moves.
func (s *Server) entryAtLocked(g *Game, ply int) map[string]any {
	w, b := s.clocksLocked(g)
	pos := g.start
	for _, m := range g.Moves[:ply] {
		mv, _ := pos.ParseUCIMove(m)
		pos = pos.Make(mv)
	}
	e := map[string]any{"fen": pos.FEN(), "wc": w / 1000, "bc": b / 1000}
	if ply > 0 {
		e["lm"] = g.Moves[ply-1]
	}
	return e
}

// publishMovesLocked sends the move to spectators; when the game is over,
// the final description, and the streams close.
func (s *Server) publishMovesLocked(g *Game) {
	over := g.Status != "started"
	var lines []string
	ply := len(g.Moves) - s.StreamLag
	if ply >= 1 && !s.Drop[ply] {
		lines = append(lines, line(s.entryAtLocked(g, ply)))
	}
	if over {
		for p := max(ply+1, 1); p <= len(g.Moves); p++ { // the late ones
			lines = append(lines, line(s.entryAtLocked(g, p)))
		}
	}
	final := line(s.describeLocked(g))
	for _, ch := range g.watchers {
		for _, l := range lines {
			select {
			case ch <- l:
			default:
			}
		}
		if over {
			select {
			case ch <- final:
			default:
			}
			close(ch)
		}
	}
	if over {
		g.watchers = nil
	}
}

func (s *Server) streamMoves(w http.ResponseWriter, r *http.Request, id string) {
	s.mu.Lock()
	g := s.games[id]
	if g == nil {
		s.mu.Unlock()
		w.WriteHeader(404)
		fmt.Fprint(w, `{"error":"Not found"}`)
		return
	}
	// The game so far, position by position, as Lichess replays it.
	first := []string{line(s.describeLocked(g))}
	for p := 0; p <= len(g.Moves)-s.StreamLag || (p <= len(g.Moves) && g.Status != "started"); p++ {
		first = append(first, line(s.entryAtLocked(g, p)))
	}
	ch := make(chan string, 512)
	if g.Status == "started" {
		g.watchers = append(g.watchers, ch)
	} else {
		close(ch)
	}
	s.mu.Unlock()
	flushLines(w, r, ch, first)
}

// featuredLocked is the game on TV: the one shown before (cur), while it
// goes on; else the latest auto game being played.
func (s *Server) featuredLocked(cur string) *Game {
	if g := s.games[cur]; g != nil && g.Status == "started" {
		return g
	}
	var found *Game
	for _, g := range s.games {
		if g.auto && g.Status == "started" && (found == nil || g.ID > found.ID) {
			found = g
		}
	}
	return found
}

// tvFeed is /api/tv/feed: a "featured" line for each game put on TV, then
// a "fen" line for each of its moves. Like Lichess, the next game comes on
// once the one shown is over.
func (s *Server) tvFeed(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/x-ndjson")
	fl, _ := w.(http.Flusher)
	cur, sent := "", 0
	tick := time.NewTicker(10 * time.Millisecond)
	defer tick.Stop()
	for {
		var out []string
		s.mu.Lock()
		if g := s.featuredLocked(cur); g != nil {
			if g.ID != cur {
				cur, sent = g.ID, len(g.Moves)
				white, black := g.players()
				wms, bms := s.clocksLocked(g)
				pl := func(color string, u user, ms int64) map[string]any {
					return map[string]any{"color": color, "user": map[string]string{"id": u.ID, "name": u.Name, "title": u.Title},
						"rating": u.Rating, "seconds": ms / 1000}
				}
				out = append(out, line(map[string]any{"t": "featured", "d": map[string]any{"id": g.ID, "orientation": "white",
					"players": []any{pl("white", white, wms), pl("black", black, bms)}, "fen": g.pos.FEN()}}))
			}
			for ; sent < len(g.Moves); sent++ {
				out = append(out, line(map[string]any{"t": "fen", "d": s.entryAtLocked(g, sent+1)}))
			}
		}
		s.mu.Unlock()
		for _, l := range out {
			fmt.Fprintln(w, l)
		}
		if fl != nil && len(out) > 0 {
			fl.Flush()
		}
		select {
		case <-r.Context().Done():
			return
		case <-tick.C:
		}
	}
}

// AutoGame starts a game between two players that the server plays
// itself, for spectating. It returns the game id.
func (s *Server) AutoGame(white, black string, limit, inc int) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	mk := func(n string) user { return user{ID: strings.ToLower(n), Name: n, Title: "BOT", Rating: 2000} }
	g := &Game{ID: s.id(), auto: true, white: mk(white), black: mk(black), Status: "started",
		wtime: int64(limit) * 1000, btime: int64(limit) * 1000, inc: int64(inc) * 1000, limit: limit}
	g.start, _ = chess.ParseFEN(chess.StartFEN)
	g.pos = g.start
	s.games[g.ID] = g
	s.opponentTurnLocked(g)
	return g.ID
}

// opponentTurnLocked plays the opponent's move after a delay.
func (s *Server) opponentTurnLocked(g *Game) {
	if g.Status != "started" || (!g.auto && (g.pos.Turn == chess.White) == g.BotWhite) {
		return
	}
	ply := len(g.Moves)
	time.AfterFunc(s.Delay, func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		if g.Status != "started" || len(g.Moves) != ply {
			return
		}
		moves := g.pos.LegalMoves()
		if len(moves) == 0 {
			return
		}
		mv := moves[s.rng.Intn(len(moves))]
		if s.Reply != nil {
			if m, err := g.pos.ParseUCIMove(s.Reply(g.pos, ply)); err == nil {
				mv = m
			}
		}
		s.playLocked(g, mv)
	})
}

func (s *Server) playLocked(g *Game, mv chess.Move) {
	if !g.turnStart.IsZero() {
		w, b := s.clocksLocked(g)
		g.wtime, g.btime = w, b
		if g.pos.Turn == chess.White {
			g.wtime += g.inc
		} else {
			g.btime += g.inc
		}
	}
	// A move declines the other side's draw offer; one's own offer stands
	// until the other side moves.
	if (g.pos.Turn == chess.White) == g.BotWhite {
		g.oppDraw = false
	} else {
		g.myDraw = false
	}
	g.Moves = append(g.Moves, mv.UCI())
	g.pos = g.pos.Make(mv)
	g.myTakeback, g.oppTakeback = false, false
	if len(g.Moves) >= 2 {
		g.turnStart = time.Now()
	}
	if len(g.pos.LegalMoves()) == 0 {
		if g.pos.InCheck() {
			g.Status = "mate"
			g.Winner = map[chess.Color]string{chess.White: "black", chess.Black: "white"}[g.pos.Turn]
		} else {
			g.Status = "stalemate"
		}
	} else if max := s.MaxPlies; len(g.Moves) >= max && max > 0 || len(g.Moves) >= 300 {
		g.Status = "draw"
	}
	s.publishLocked(g)
	s.publishMovesLocked(g)
	if g.Status != "started" {
		if !g.auto {
			s.finishLocked(g)
		}
		return
	}
	s.opponentTurnLocked(g)
}

// Resign ends a game now, the side given resigning (for tests).
func (s *Server) Resign(id, side string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	g := s.games[id]
	if g == nil || g.Status != "started" {
		return
	}
	g.Status, g.Winner = "resign", map[string]string{"white": "black", "black": "white"}[side]
	s.publishLocked(g)
	s.publishMovesLocked(g)
	if !g.auto {
		s.finishLocked(g)
	}
}

// SetRated makes a game rated (AutoGame games are casual).
func (s *Server) SetRated(id string, rated bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if g := s.games[id]; g != nil {
		g.Rated = rated
	}
}

func (s *Server) finishLocked(g *Game) {
	if g.endedAt.IsZero() {
		g.endedAt = time.Now()
	}
	s.broadcastLocked(map[string]any{"type": "gameFinish", "game": s.gameInfoLocked(g)})
}

func (s *Server) botMove(id, uciMove string, draw bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	g := s.games[id]
	if g == nil || g.Status != "started" {
		return fmt.Errorf("game is not being played")
	}
	if (g.pos.Turn == chess.White) != g.BotWhite {
		return fmt.Errorf("not your turn")
	}
	mv, err := g.pos.ParseUCIMove(uciMove)
	if err != nil {
		return fmt.Errorf("illegal move %s", uciMove)
	}
	if draw {
		s.DrawOffers++
		if g.oppDraw {
			// The move accepts the opponent's offer: it is not played.
			g.oppDraw = false
			s.agreeLocked(g, "draw", false)
			return nil
		}
	}
	s.playLocked(g, mv)
	if draw && g.Status == "started" {
		g.myDraw = true
		s.publishLocked(g)
	}
	return nil
}

func (s *Server) botEnd(id, how string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	g := s.games[id]
	if g == nil || g.Status != "started" {
		return fmt.Errorf("game is not being played")
	}
	if how == "abort" {
		if len(g.Moves) >= 2 {
			return fmt.Errorf("too late to abort")
		}
		g.Status = "aborted"
	} else {
		g.Status = "resign"
		g.Winner = "white"
		if g.BotWhite {
			g.Winner = "black"
		}
	}
	s.publishLocked(g)
	s.finishLocked(g)
	return nil
}

// boardOffer answers or makes a draw offer or takeback proposal.
func (s *Server) boardOffer(id, kind string, yes bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	g := s.games[id]
	if g == nil || g.Status != "started" {
		return fmt.Errorf("game is not being played")
	}
	theirs, mine := &g.oppDraw, &g.myDraw
	if kind == "takeback" {
		theirs, mine = &g.oppTakeback, &g.myTakeback
	}
	switch {
	case !yes:
		*theirs = false
	case *theirs:
		*theirs = false
		s.agreeLocked(g, kind, false)
		return nil
	default:
		if kind == "takeback" && len(g.Moves) == 0 {
			return fmt.Errorf("no move to take back")
		}
		*mine = true
		if s.AcceptOffers {
			ply := len(g.Moves)
			time.AfterFunc(s.Delay, func() {
				s.mu.Lock()
				defer s.mu.Unlock()
				if g.Status == "started" && *mine && len(g.Moves) == ply {
					*mine = false
					s.agreeLocked(g, kind, true)
				}
			})
		}
	}
	s.publishLocked(g)
	return nil
}

// agreeLocked carries out an accepted offer. byMe: the account proposed it.
func (s *Server) agreeLocked(g *Game, kind string, byMe bool) {
	if kind == "draw" {
		g.Status = "draw"
		s.publishLocked(g)
		s.finishLocked(g)
		return
	}
	// Back to the proposer's turn: one move, or two if the other side has
	// moved since.
	proposer := g.BotWhite == byMe // the proposer plays White
	n := 1
	if (g.pos.Turn == chess.White) == proposer {
		n = 2
	}
	n = min(n, len(g.Moves))
	g.Moves = g.Moves[:len(g.Moves)-n]
	g.pos = g.start
	for _, m := range g.Moves {
		mv, _ := g.pos.ParseUCIMove(m)
		g.pos = g.pos.Make(mv)
	}
	if !g.turnStart.IsZero() {
		g.turnStart = time.Now()
	}
	s.publishLocked(g)
	s.opponentTurnLocked(g)
}

// seek pairs the account with a fake player after a moment. Like Lichess,
// the request stays open until then; closing it cancels the seek.
func (s *Server) seek(w http.ResponseWriter, r *http.Request) {
	r.ParseForm()
	minutes, err := strconv.ParseFloat(r.Form.Get("time"), 64)
	inc, err2 := strconv.Atoi(r.Form.Get("increment"))
	if err != nil || err2 != nil {
		w.WriteHeader(400)
		fmt.Fprint(w, `{"error":"time and increment are required"}`)
		return
	}
	limit := int(minutes * 60)
	if limit+40*inc < 480 {
		w.WriteHeader(400)
		fmt.Fprint(w, `{"error":"Invalid speed for the Board API: rapid or slower only"}`)
		return
	}
	w.Header().Set("Content-Type", "application/x-ndjson")
	fl, _ := w.(http.Flusher)
	fmt.Fprintln(w)
	if fl != nil {
		fl.Flush()
	}
	select {
	case <-r.Context().Done():
		s.mu.Lock()
		s.Log = append(s.Log, "seek-cancelled")
		s.mu.Unlock()
		return
	case <-time.After(4 * s.Delay):
	}
	s.mu.Lock()
	color := r.Form.Get("color")
	opp := user{ID: "rival", Name: "Rival", Rating: 1520}
	c := newChallenge(s.id(), s.me(), opp, r.Form.Get("rated") == "true", limit, inc, color, "standard")
	c.Speed = "rapid"
	botWhite := color == "white" || (color != "black" && s.rng.Intn(2) == 0)
	s.startGameLocked(c, botWhite, opp)
	s.mu.Unlock()
}

func (s *Server) accept(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	c := s.pending[id]
	if c == nil {
		return fmt.Errorf("no such challenge")
	}
	delete(s.pending, id)
	botWhite := c.Color == "black" // the challenger asked for black
	if c.Color == "random" {
		botWhite = s.rng.Intn(2) == 0
	}
	s.startGameLocked(c, botWhite, c.Challenger)
	return nil
}

func newChallenge(id string, from, to user, rated bool, limit, inc int, color, variant string) *challenge {
	if variant == "" {
		variant = "standard"
	}
	tc := map[string]any{"type": "clock", "limit": limit, "increment": inc, "show": fmt.Sprintf("%d+%d", limit/60, inc)}
	if limit < 0 {
		tc = map[string]any{"type": "correspondence", "daysPerTurn": 2}
	}
	return &challenge{ID: id, URL: "https://lichess.org/" + id, Status: "created", Challenger: from, DestUser: to,
		Variant: map[string]any{"key": variant, "name": strings.ToUpper(variant[:1]) + variant[1:]},
		Rated:   rated, Speed: "blitz", TimeControl: tc, Color: color, limit: limit, inc: inc, variant: variant}
}

// Challenge sends the bot a challenge from a fake player and returns its id.
// A negative limit makes a correspondence challenge.
func (s *Server) Challenge(from string, bot, rated bool, limit, inc int, color, variant string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	u := user{ID: strings.ToLower(from), Name: from, Rating: 1700}
	if bot {
		u.Title = "BOT"
	}
	c := newChallenge(s.id(), u, s.me(), rated, limit, inc, color, variant)
	c.Direction = "in"
	s.pending[c.ID] = c
	s.broadcastLocked(map[string]any{"type": "challenge", "challenge": c})
	return c.ID
}

func (s *Server) outgoing(username string, r *http.Request) (string, error) {
	limit, err1 := strconv.Atoi(r.Form.Get("clock.limit"))
	inc, err2 := strconv.Atoi(r.Form.Get("clock.increment"))
	if err1 != nil || err2 != nil {
		return "", fmt.Errorf("clock.limit and clock.increment are required")
	}
	color := r.Form.Get("color")
	if color == "" {
		color = "random"
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	opp := user{ID: strings.ToLower(username), Name: username, Title: "BOT", Rating: 1800}
	c := newChallenge(s.id(), s.me(), opp, r.Form.Get("rated") == "true", limit, inc, color, r.Form.Get("variant"))
	c.Direction = "out"
	s.pending[c.ID] = c
	s.broadcastLocked(map[string]any{"type": "challenge", "challenge": c})
	out := line(c)
	reason, declines := s.Decliners[strings.ToLower(username)]
	if s.Silent[strings.ToLower(username)] {
		return out, nil
	}
	time.AfterFunc(s.Delay*3, func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.pending[c.ID] != c {
			return // cancelled
		}
		delete(s.pending, c.ID)
		if declines {
			c.Status, c.Decline = "declined", reason
			s.broadcastLocked(map[string]any{"type": "challengeDeclined", "challenge": c})
			return
		}
		botWhite := c.Color == "white"
		if c.Color == "random" {
			botWhite = s.rng.Intn(2) == 0
		}
		s.startGameLocked(c, botWhite, opp)
	})
	return out, nil
}

// Game returns a copy of a game's moves and status.
func (s *Server) Game(id string) (moves []string, status, winner string, ok bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	g := s.games[id]
	if g == nil {
		return nil, "", "", false
	}
	return append([]string(nil), g.Moves...), g.Status, g.Winner, true
}

// Calls returns the API calls made so far.
func (s *Server) Calls() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.Log...)
}

// control serves /_fake/ endpoints used by the end-to-end test.
func (s *Server) control(w http.ResponseWriter, r *http.Request) {
	r.ParseForm()
	q := r.Form
	switch r.URL.Path {
	case "/_fake/challenge":
		limit, _ := strconv.Atoi(q.Get("limit"))
		inc, _ := strconv.Atoi(q.Get("inc"))
		if q.Get("limit") == "" {
			limit = 180
		}
		from := q.Get("from")
		if from == "" {
			from = "Alice"
		}
		color := q.Get("color")
		if color == "" {
			color = "random"
		}
		id := s.Challenge(from, q.Get("bot") == "1", q.Get("rated") == "1", limit, inc, color, q.Get("variant"))
		fmt.Fprint(w, line(map[string]string{"id": id}))
	case "/_fake/autogame":
		limit, _ := strconv.Atoi(q.Get("limit"))
		if limit == 0 {
			limit = 120
		}
		inc, _ := strconv.Atoi(q.Get("inc"))
		white, black := q.Get("white"), q.Get("black")
		if white == "" {
			white = "maia1"
		}
		if black == "" {
			black = "SlowBot"
		}
		id := s.AutoGame(white, black, limit, inc)
		if q.Get("rated") == "true" {
			s.SetRated(id, true)
		}
		fmt.Fprint(w, line(map[string]string{"id": id}))
	case "/_fake/resign":
		// side: white, black, or opponent (the side your bot does not play).
		side := q.Get("side")
		if side == "opponent" {
			s.mu.Lock()
			if g := s.games[q.Get("id")]; g != nil {
				side = map[bool]string{true: "black", false: "white"}[g.BotWhite]
			}
			s.mu.Unlock()
		}
		s.Resign(q.Get("id"), side)
		fmt.Fprint(w, line(map[string]string{"ok": "1"}))
	case "/_fake/sent":
		// A challenge the bot sent elsewhere (on the website, before Ponder
		// connected): waiting, and never answered; no event tells of it.
		to := q.Get("to")
		if to == "" {
			to = "SlowBot"
		}
		s.mu.Lock()
		opp := user{ID: strings.ToLower(to), Name: to, Title: "BOT", Rating: 1800}
		c := newChallenge(s.id(), s.me(), opp, false, 300, 0, "random", "")
		c.Direction = "out"
		s.pending[c.ID] = c
		s.mu.Unlock()
		fmt.Fprint(w, line(map[string]string{"id": c.ID}))
	case "/_fake/botsdone":
		// That bot has played its bot games for the day (for seconds).
		secs, _ := strconv.ParseFloat(q.Get("secs"), 64)
		if secs == 0 {
			secs = 3600
		}
		s.mu.Lock()
		if s.BotsDone == nil {
			s.BotsDone = map[string]float64{}
		}
		s.BotsDone[strings.ToLower(q.Get("bot"))] = secs
		s.mu.Unlock()
		fmt.Fprint(w, line(map[string]bool{"ok": true}))
	case "/_fake/games":
		s.mu.Lock()
		out := map[string]any{}
		for id, g := range s.games {
			out[id] = map[string]any{"moves": len(g.Moves), "status": g.Status, "winner": g.Winner}
		}
		s.mu.Unlock()
		fmt.Fprint(w, line(out))
	case "/_fake/offer":
		// The opponent offers a draw or proposes a takeback.
		s.mu.Lock()
		g := s.games[q.Get("game")]
		if g != nil {
			if q.Get("kind") == "takeback" {
				g.oppTakeback = true
			} else {
				g.oppDraw = true
			}
			s.publishLocked(g)
		}
		s.mu.Unlock()
		fmt.Fprint(w, `{"ok":true}`)
	case "/_fake/chat":
		// Someone says something in a game's chat.
		room, from := q.Get("room"), q.Get("from")
		if room == "" {
			room = "spectator"
		}
		if from == "" {
			from = "Kibitzer"
		}
		if !s.Say(q.Get("game"), from, room, q.Get("text")) {
			w.WriteHeader(404)
			return
		}
		fmt.Fprint(w, `{"ok":true}`)
	case "/_fake/calls":
		fmt.Fprint(w, line(s.Calls()))
	case "/_fake/bot":
		s.mu.Lock()
		s.Bot = q.Get("on") == "1"
		s.mu.Unlock()
		fmt.Fprint(w, `{"ok":true}`)
	default:
		w.WriteHeader(404)
	}
}

// explorerData makes up explorer statistics for a position: its legal
// moves with counts that depend only on the move.
func explorerData(fen string, masters bool) map[string]any {
	pos, err := chess.ParseFEN(fen)
	if err != nil {
		return map[string]any{"white": 0, "draws": 0, "black": 0, "moves": []any{}, "topGames": []any{}, "opening": nil}
	}
	var moves []map[string]any
	tw, td, tb := 0, 0, 0
	for i, m := range pos.LegalMoves() {
		if i == 6 {
			break
		}
		h := 0
		for _, c := range m.UCI() {
			h = h*31 + int(c)
		}
		n := 50 + h%950
		wn, dn := n*(30+h%20)/100, n*(30+h%15)/100
		bn := n - wn - dn
		tw, td, tb = tw+wn, td+dn, tb+bn
		moves = append(moves, map[string]any{"uci": m.UCI(), "san": pos.SAN(m), "averageRating": 2400 + h%300,
			"white": wn, "draws": dn, "black": bn})
	}
	top := []any{}
	if masters {
		top = append(top, map[string]any{"uci": "e2e4", "id": "m1", "winner": "white", "year": 2014,
			"white": map[string]any{"name": "Carlsen, M.", "rating": 2881}, "black": map[string]any{"name": "Anand, V.", "rating": 2785}})
	}
	return map[string]any{"white": tw, "draws": td, "black": tb, "moves": moves, "topGames": top,
		"opening": map[string]string{"eco": "C20", "name": "King's Pawn Game"}}
}

// Made-up but steady player data, from the name.
func fakeSeed(name string) int {
	h := 7
	for _, c := range strings.ToLower(name) {
		h = h*31 + int(c)
	}
	if h < 0 {
		h = -h
	}
	return h
}

func fakeRating(name, perf string) int {
	return 1400 + fakeSeed(name+perf)%1200
}

func fakeProfile(name string) map[string]any {
	seed := fakeSeed(name)
	perfs := map[string]any{}
	for i, p := range []string{"bullet", "blitz", "rapid", "classical"} {
		perfs[p] = map[string]any{"rating": fakeRating(name, p), "games": 50 + (seed>>uint(i))%3000, "rd": 45, "prog": seed%31 - 15}
	}
	win, loss, draw := 400+seed%900, 300+seed%700, 50+seed%200
	return map[string]any{
		"id": strings.ToLower(name), "username": name, "title": map[bool]string{true: "BOT", false: ""}[strings.Contains(strings.ToLower(name), "bot") || strings.HasPrefix(strings.ToLower(name), "maia")],
		"perfs": perfs, "createdAt": time.Now().AddDate(-1-seed%6, 0, 0).UnixMilli(), "seenAt": time.Now().Add(-time.Minute).UnixMilli(),
		"playTime": map[string]int{"total": 3600 * (50 + seed%2000), "tv": 600},
		"count":    map[string]int{"all": win + loss + draw + 10, "rated": win + loss + draw, "win": win, "loss": loss, "draw": draw},
		"profile":  map[string]string{"flag": []string{"US", "DE", "FR", "NO", "IN"}[seed%5], "bio": name + " plays on the fake Lichess.", "location": "Testville"},
		"url":      "https://lichess.org/@/" + name,
	}
}

func fakeHistory(name string) []map[string]any {
	var out []map[string]any
	for _, p := range []string{"Bullet", "Blitz", "Rapid", "Classical"} {
		r := fakeRating(name, strings.ToLower(p)) - 150
		seed := fakeSeed(name + p)
		var points [][4]int
		day := time.Now().AddDate(-1, 0, 0)
		for i := 0; i < 60; i++ {
			day = day.AddDate(0, 0, 6)
			r += (seed>>uint(i%20))%41 - 17
			points = append(points, [4]int{day.Year(), int(day.Month()) - 1, day.Day(), r})
		}
		out = append(out, map[string]any{"name": p, "points": points})
	}
	return out
}

func fakePerfStat(name, perf string) map[string]any {
	seed := fakeSeed(name + perf)
	r := fakeRating(name, perf)
	win, loss, draw := 200+seed%500, 150+seed%400, 20+seed%90
	at := time.Now().AddDate(0, -seed%10-1, 0).Format(time.RFC3339)
	return map[string]any{
		"user": map[string]string{"name": name},
		"perf": map[string]any{"glicko": map[string]any{"rating": r, "deviation": 45, "provisional": false}, "nb": win + loss + draw, "progress": seed%31 - 15},
		"rank": nil, "percentile": float64(seed%1000) / 10,
		"stat": map[string]any{
			"highest": map[string]any{"int": r + 40 + seed%120, "at": at, "gameId": "abcdefgh"},
			"lowest":  map[string]any{"int": r - 300 - seed%200, "at": at, "gameId": "hgfedcba"},
			"count":   map[string]any{"all": win + loss + draw, "rated": win + loss + draw, "win": win, "loss": loss, "draw": draw, "tour": 3, "berserk": 1, "opAvg": float64(r - 20), "seconds": 3600 * 40, "disconnects": 0},
			"resultStreak": map[string]any{
				"win":  map[string]any{"cur": map[string]int{"v": seed % 4}, "max": map[string]int{"v": 5 + seed%9}},
				"loss": map[string]any{"cur": map[string]int{"v": 0}, "max": map[string]int{"v": 3 + seed%6}},
			},
		},
	}
}

// Draws reports how many of the account's moves came with a draw offer, and
// how often the tablebase was asked.
func (s *Server) Draws() (offers, asked int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.DrawOffers, s.TablebaseAsked
}

// OfferDraw has the opponent offer a draw in a game.
func (s *Server) OfferDraw(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if g := s.games[id]; g != nil && g.Status == "started" {
		g.oppDraw = true
		s.publishLocked(g)
	}
}
