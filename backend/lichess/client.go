// Package lichess plays games on lichess.org through its Bot API with a UCI
// engine: it receives, accepts and sends challenges, and plays the games.
// See https://lichess.org/api#tag/bot.
package lichess

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const DefaultBaseURL = "https://lichess.org"

// Account is the part of /api/account the bot needs.
type Account struct {
	ID       string `json:"id"`
	Username string `json:"username"`
	Title    string `json:"title"`
}

func (a Account) IsBot() bool { return a.Title == "BOT" }

type User struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Username string `json:"username"`
	Title    string `json:"title"`
	Rating   int    `json:"rating"`
	Online   bool   `json:"online"`
	// Ratings by speed (bullet, blitz, rapid, classical, …), from /api/bot/online.
	Perfs map[string]struct {
		Rating int  `json:"rating"`
		Games  int  `json:"games"`
		Prov   bool `json:"prov"`
		RD     int  `json:"rd,omitempty"`
		Prog   int  `json:"prog,omitempty"` // rating change over the last 12 games
	} `json:"perfs,omitempty"`
	// More about the account, from /api/bot/online.
	CreatedAt int64 `json:"createdAt,omitempty"` // ms
	SeenAt    int64 `json:"seenAt,omitempty"`    // ms
	PlayTime  *struct {
		Total int `json:"total"` // seconds
		TV    int `json:"tv"`
	} `json:"playTime,omitempty"`
	Profile *struct {
		Flag     string `json:"flag,omitempty"`
		Location string `json:"location,omitempty"`
		Bio      string `json:"bio,omitempty"`
		RealName string `json:"realName,omitempty"`
		Links    string `json:"links,omitempty"`
	} `json:"profile,omitempty"`
	Flair    string `json:"flair,omitempty"`
	Patron   bool   `json:"patron,omitempty"`
	Verified bool   `json:"verified,omitempty"`
}

// UserStatus is whether a player is online and playing now.
type UserStatus struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Title   string `json:"title,omitempty"`
	Online  bool   `json:"online"`
	Playing bool   `json:"playing"`
	// The game being played, if any.
	GameID  string `json:"gameId,omitempty"`
	Clock   string `json:"clock,omitempty"`
	Variant string `json:"variant,omitempty"`
}

// UsersStatus reads the online/playing status of players, 100 at a time.
func (c *Client) UsersStatus(ctx context.Context, ids []string) ([]UserStatus, error) {
	var out []UserStatus
	for start := 0; start < len(ids); start += 100 {
		batch := ids[start:min(start+100, len(ids))]
		var raw []struct {
			ID      string          `json:"id"`
			Name    string          `json:"name"`
			Title   string          `json:"title"`
			Online  bool            `json:"online"`
			Playing json.RawMessage `json:"playing"`
		}
		path := "/api/users/status?withGameMetas=true&ids=" + url.QueryEscape(strings.Join(batch, ","))
		if err := c.call(ctx, "GET", path, nil, &raw); err != nil {
			return out, err
		}
		for _, r := range raw {
			st := UserStatus{ID: r.ID, Name: r.Name, Title: r.Title, Online: r.Online}
			// "playing" is true/false, or with game metas, the game.
			var game struct {
				ID      string `json:"id"`
				Clock   string `json:"clock"`
				Variant string `json:"variant"`
			}
			var playing bool
			if json.Unmarshal(r.Playing, &playing) == nil {
				st.Playing = playing
			} else if json.Unmarshal(r.Playing, &game) == nil {
				st.Playing, st.GameID, st.Clock, st.Variant = true, game.ID, game.Clock, game.Variant
			}
			out = append(out, st)
		}
	}
	return out, nil
}

// SpeedOf is the Lichess speed of a clock: it goes by the estimated game
// length, initial time + 40 × increment.
func SpeedOf(limit, increment int) string {
	switch t := limit + 40*increment; {
	case t < 30:
		return "ultraBullet"
	case t < 180:
		return "bullet"
	case t < 480:
		return "blitz"
	case t < 1500:
		return "rapid"
	}
	return "classical"
}

// UserInfo is a user's public profile, with their ratings by speed.
func (c *Client) UserInfo(ctx context.Context, username string) (User, error) {
	var u User
	err := c.getJSON(ctx, "/api/user/"+url.PathEscape(username), &u)
	return u, err
}

// RatingFor is the user's rating at a speed, or 0 if they have none.
func (u User) RatingFor(speed string) int {
	if p, ok := u.Perfs[speed]; ok && p.Games > 0 {
		return p.Rating
	}
	return 0
}

// DisplayName is the user's name as shown on Lichess.
func (u User) DisplayName() string {
	if u.Name != "" {
		return u.Name
	}
	if u.Username != "" {
		return u.Username
	}
	return u.ID
}

type Variant struct {
	Key  string `json:"key"`
	Name string `json:"name"`
}

type TimeControl struct {
	Type      string `json:"type"` // clock, correspondence, unlimited
	Limit     int    `json:"limit"`
	Increment int    `json:"increment"`
	Show      string `json:"show"`
}

type Challenge struct {
	ID            string      `json:"id"`
	URL           string      `json:"url"`
	Status        string      `json:"status"`
	Challenger    User        `json:"challenger"`
	DestUser      *User       `json:"destUser"`
	Variant       Variant     `json:"variant"`
	Rated         bool        `json:"rated"`
	Speed         string      `json:"speed"`
	TimeControl   TimeControl `json:"timeControl"`
	Color         string      `json:"color"`
	Direction     string      `json:"direction"`
	InitialFen    string      `json:"initialFen"`
	DeclineReason string      `json:"declineReason"`
	// DeclineReasonKey is the reason as a key (Lichess writes them in lower
	// case: generic, later, toofast, tooslow, timecontrol, rated, casual,
	// standard, variant, nobot, onlybot); DeclineReason is its text.
	DeclineReasonKey string `json:"declineReasonKey"`
}

// DestName is the challenged player's name, or "the player" when unknown.
func (c Challenge) DestName() string {
	if c.DestUser != nil && c.DestUser.DisplayName() != "" {
		return c.DestUser.DisplayName()
	}
	return "the player"
}

// GameInfo is the game in gameStart / gameFinish events.
type GameInfo struct {
	ID       string  `json:"id"`
	GameID   string  `json:"gameId"`
	FullID   string  `json:"fullId"`
	Color    string  `json:"color"`
	Fen      string  `json:"fen"`
	Rated    bool    `json:"rated"`
	Speed    string  `json:"speed"`
	Variant  Variant `json:"variant"`
	IsMyTurn bool    `json:"isMyTurn"`
	Opponent struct {
		ID       string `json:"id"`
		Username string `json:"username"`
		Rating   int    `json:"rating"`
		AI       int    `json:"ai"`
	} `json:"opponent"`
	Winner string     `json:"winner"`
	Status GameStatus `json:"status"` // in gameFinish: how it ended
}

// GameStatus is a game's status name ("aborted", "mate", …): Lichess sends
// {"id":25,"name":"aborted"}, or at times the bare name.
type GameStatus string

func (s *GameStatus) UnmarshalJSON(data []byte) error {
	var name string
	if json.Unmarshal(data, &name) == nil {
		*s = GameStatus(name)
		return nil
	}
	var obj struct {
		Name string `json:"name"`
	}
	if err := json.Unmarshal(data, &obj); err != nil {
		return nil // not something to fail the whole event over
	}
	*s = GameStatus(obj.Name)
	return nil
}

func (g GameInfo) Key() string {
	if g.GameID != "" {
		return g.GameID
	}
	return g.ID
}

// Event is a line of /api/stream/event.
type Event struct {
	Type      string     `json:"type"` // gameStart, gameFinish, challenge, challengeCanceled, challengeDeclined
	Challenge *Challenge `json:"challenge"`
	Game      *GameInfo  `json:"game"`
}

type GamePlayer struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Title   string `json:"title"`
	Rating  int    `json:"rating"`
	AILevel int    `json:"aiLevel"`
}

func (p GamePlayer) DisplayName() string {
	switch {
	case p.Name != "":
		return p.Name
	case p.AILevel > 0:
		return fmt.Sprintf("Stockfish level %d", p.AILevel)
	case p.ID != "":
		return p.ID
	}
	return "?"
}

// GameState is the state part of the game stream. Times are milliseconds.
type GameState struct {
	Type   string `json:"type"`
	Moves  string `json:"moves"`
	WTime  int64  `json:"wtime"`
	BTime  int64  `json:"btime"`
	WInc   int64  `json:"winc"`
	BInc   int64  `json:"binc"`
	Status string `json:"status"`
	Winner string `json:"winner"`
	WDraw  bool   `json:"wdraw"`
	BDraw  bool   `json:"bdraw"`
	// Takeback proposals (Board API).
	WTakeback bool `json:"wtakeback"`
	BTakeback bool `json:"btakeback"`
}

// GameEvent is a line of /api/bot/game/stream/{id}: gameFull, gameState,
// chatLine or opponentGone.
type GameEvent struct {
	Type       string     `json:"type"`
	ID         string     `json:"id"`
	Rated      bool       `json:"rated"`
	Variant    Variant    `json:"variant"`
	Speed      string     `json:"speed"`
	White      GamePlayer `json:"white"`
	Black      GamePlayer `json:"black"`
	InitialFen string     `json:"initialFen"`
	Clock      *struct {
		Initial   int64 `json:"initial"`
		Increment int64 `json:"increment"`
	} `json:"clock"`
	State *GameState `json:"state"`
	GameState
	// chatLine
	Username string `json:"username"`
	Text     string `json:"text"`
	Room     string `json:"room"`
	// opponentGone
	Gone              bool `json:"gone"`
	ClaimWinInSeconds int  `json:"claimWinInSeconds"`
}

// ChallengeParams describes a challenge to send.
type ChallengeParams struct {
	Username  string `json:"username"`
	Rated     bool   `json:"rated"`
	Limit     int    `json:"limit"`     // initial time, seconds
	Increment int    `json:"increment"` // seconds
	Color     string `json:"color"`     // random, white, black
}

// APIError is an error answer from Lichess.
type APIError struct {
	Status  int
	Message string
	// RateKey is the limit Lichess named in a rate-limit answer
	// ("bot.vsBot.day": games between bots in a day), and RetryAfter how
	// long it said to wait (its ratelimit.seconds, or the Retry-After
	// header); 0 when it did not say.
	RateKey    string
	RetryAfter time.Duration
}

// ChallengeLimit tells a challenge refused for a rate limit apart, as
// lichess-bot does: self when your bot may not challenge for now (a 429,
// with the daily bot-game limit or not), opponent when the bot challenged
// has played its bot games for the day (a 400 naming that limit). wait is
// how long Lichess said it lasts (0: it did not say).
func ChallengeLimit(err error) (self, opponent bool, wait time.Duration) {
	var e *APIError
	if !errors.As(err, &e) {
		return false, false, 0
	}
	switch {
	case e.Status == http.StatusTooManyRequests:
		return true, false, e.RetryAfter
	case e.Status == http.StatusBadRequest && e.RateKey == "bot.vsBot.day":
		return false, true, e.RetryAfter
	}
	return false, false, 0
}

// ChallengeGone tells apart Lichess's answer that a challenge is not
// there (404): it was cancelled, declined, accepted or expired meanwhile.
func ChallengeGone(err error) bool {
	var e *APIError
	return errors.As(err, &e) && e.Status == http.StatusNotFound
}

// errChallengeGone is said instead, once the challenge is taken off the list.
var errChallengeGone = errors.New("this challenge is no longer on Lichess: it was cancelled or it expired, so it was taken off the list")

func (e *APIError) Error() string {
	if e.Message != "" {
		return fmt.Sprintf("Lichess: %s", e.Message)
	}
	return fmt.Sprintf("Lichess answered %d %s", e.Status, http.StatusText(e.Status))
}

// RateLimited reports whether Lichess asked us to slow down (HTTP 429), in
// which case the API asks clients to wait a full minute.
func RateLimited(err error) bool {
	var e *APIError
	return errors.As(err, &e) && e.Status == http.StatusTooManyRequests
}

type Client struct {
	BaseURL string
	Token   string
	// Board makes the game calls go to the Board API (a person playing with
	// their own account) instead of the Bot API.
	Board  bool
	HTTP   *http.Client // for ordinary requests
	Stream *http.Client // for long-lived streams (no overall timeout)
}

func NewClient(baseURL, token string) *Client {
	if baseURL == "" {
		baseURL = DefaultBaseURL
	}
	return &Client{
		BaseURL: strings.TrimRight(baseURL, "/"),
		Token:   strings.TrimSpace(token),
		HTTP:    &http.Client{Timeout: 20 * time.Second},
		Stream:  &http.Client{},
	}
}

func (c *Client) request(ctx context.Context, method, path string, form url.Values) (*http.Request, error) {
	var body io.Reader
	if form != nil {
		body = strings.NewReader(form.Encode())
	}
	req, err := http.NewRequestWithContext(ctx, method, c.BaseURL+path, body)
	if err != nil {
		return nil, err
	}
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	req.Header.Set("User-Agent", "Ponder (UCI chess GUI)")
	if form != nil {
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	}
	return req, nil
}

func apiError(res *http.Response) error {
	var body struct {
		Error     string `json:"error"`
		RateLimit struct {
			Key     string  `json:"key"`
			Seconds float64 `json:"seconds"`
		} `json:"ratelimit"`
	}
	data, _ := io.ReadAll(io.LimitReader(res.Body, 64*1024))
	json.Unmarshal(data, &body)
	msg := body.Error
	if msg == "" && res.StatusCode == http.StatusUnauthorized {
		msg = "the API token was not accepted (check it, and that it has the \"Play bot moves\" permission)"
	}
	if msg == "" && res.StatusCode == http.StatusTooManyRequests {
		msg = "too many requests"
	}
	e := &APIError{Status: res.StatusCode, Message: msg, RateKey: body.RateLimit.Key}
	if body.RateLimit.Seconds > 0 {
		e.RetryAfter = time.Duration(body.RateLimit.Seconds * float64(time.Second))
	} else if s, err := strconv.ParseFloat(strings.TrimSpace(res.Header.Get("Retry-After")), 64); err == nil && s > 0 {
		e.RetryAfter = time.Duration(s * float64(time.Second))
	}
	return e
}

// call sends a request and decodes a JSON answer into out (if not nil).
func (c *Client) call(ctx context.Context, method, path string, form url.Values, out any) error {
	req, err := c.request(ctx, method, path, form)
	if err != nil {
		return err
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return apiError(res)
	}
	if out == nil {
		io.Copy(io.Discard, res.Body)
		return nil
	}
	return json.NewDecoder(res.Body).Decode(out)
}

func (c *Client) Account(ctx context.Context) (Account, error) {
	var a Account
	err := c.call(ctx, "GET", "/api/account", nil, &a)
	return a, err
}

// UpgradeToBot turns the account into a Bot account. This cannot be undone,
// and only works for accounts that have never played a game.
func (c *Client) UpgradeToBot(ctx context.Context) error {
	return c.call(ctx, "POST", "/api/bot/account/upgrade", url.Values{}, nil)
}

func (c *Client) Accept(ctx context.Context, id string) error {
	return c.call(ctx, "POST", "/api/challenge/"+url.PathEscape(id)+"/accept", url.Values{}, nil)
}

// Decline declines a challenge. reason is one of Lichess's decline reasons
// (generic, later, tooFast, tooSlow, timeControl, rated, casual, standard,
// variant, noBot, onlyBot).
func (c *Client) Decline(ctx context.Context, id, reason string) error {
	form := url.Values{}
	if reason != "" {
		form.Set("reason", reason)
	}
	return c.call(ctx, "POST", "/api/challenge/"+url.PathEscape(id)+"/decline", form, nil)
}

// CurrentChallenges are the challenges waiting for an answer: those sent to
// the account (in) and those it sent (out), wherever they were made.
func (c *Client) CurrentChallenges(ctx context.Context) (in, out []Challenge, err error) {
	var got struct {
		In  []Challenge `json:"in"`
		Out []Challenge `json:"out"`
	}
	err = c.getJSON(ctx, "/api/challenge", &got)
	return got.In, got.Out, err
}

func (c *Client) Cancel(ctx context.Context, id string) error {
	return c.call(ctx, "POST", "/api/challenge/"+url.PathEscape(id)+"/cancel", url.Values{}, nil)
}

// Challenge challenges a user to a standard game with a clock.
func (c *Client) Challenge(ctx context.Context, p ChallengeParams) (Challenge, error) {
	form := url.Values{}
	form.Set("rated", strconv.FormatBool(p.Rated))
	form.Set("clock.limit", strconv.Itoa(p.Limit))
	form.Set("clock.increment", strconv.Itoa(p.Increment))
	if p.Color != "" {
		form.Set("color", p.Color)
	}
	form.Set("variant", "standard")
	var out struct {
		Challenge
		Inner *Challenge `json:"challenge"` // some responses wrap the challenge
	}
	if err := c.call(ctx, "POST", "/api/challenge/"+url.PathEscape(strings.TrimSpace(p.Username)), form, &out); err != nil {
		return Challenge{}, err
	}
	if out.Inner != nil {
		return *out.Inner, nil
	}
	return out.Challenge, nil
}

// gamePath is where a game's calls go: /api/bot/game/{id} or /api/board/game/{id}.
func (c *Client) gamePath(gameID string) string {
	api := "bot"
	if c.Board {
		api = "board"
	}
	return "/api/" + api + "/game/" + url.PathEscape(gameID)
}

// Move plays a move. With draw, it also offers a draw, or accepts the
// opponent's offer.
func (c *Client) Move(ctx context.Context, gameID, uci string, draw bool) error {
	path := c.gamePath(gameID) + "/move/" + url.PathEscape(uci)
	if draw {
		path += "?offeringDraw=true"
	}
	return c.call(ctx, "POST", path, url.Values{}, nil)
}

func (c *Client) Resign(ctx context.Context, gameID string) error {
	return c.call(ctx, "POST", c.gamePath(gameID)+"/resign", url.Values{}, nil)
}

func (c *Client) Abort(ctx context.Context, gameID string) error {
	return c.call(ctx, "POST", c.gamePath(gameID)+"/abort", url.Values{}, nil)
}

func yesNo(yes bool) string {
	if yes {
		return "yes"
	}
	return "no"
}

// Draw offers or accepts a draw (yes), or declines the opponent's offer (no).
func (c *Client) Draw(ctx context.Context, gameID string, yes bool) error {
	return c.call(ctx, "POST", c.gamePath(gameID)+"/draw/"+yesNo(yes), url.Values{}, nil)
}

// Takeback proposes or accepts a takeback (yes), or declines one (no).
// Board API only.
func (c *Client) Takeback(ctx context.Context, gameID string, yes bool) error {
	return c.call(ctx, "POST", c.gamePath(gameID)+"/takeback/"+yesNo(yes), url.Values{}, nil)
}

// LobbySeek describes a game to look for in the Lichess lobby.
type LobbySeek struct {
	Rated       bool   `json:"rated"`
	Limit       int    `json:"limit"`     // initial time, seconds
	Increment   int    `json:"increment"` // seconds
	Color       string `json:"color"`     // random, white, black
	RatingRange string `json:"ratingRange,omitempty"`
	// Days a move, for a correspondence seek (Limit and Increment unused).
	Days int `json:"days,omitempty"`
}

// Seek looks for an opponent in the lobby (Board API). Lichess keeps the
// seek while the request is open: Seek returns once a game was found (it
// then starts as a gameStart event), or with ctx's error when cancelled.
func (c *Client) Seek(ctx context.Context, p LobbySeek) error {
	form := url.Values{}
	form.Set("rated", strconv.FormatBool(p.Rated))
	if p.Days > 0 {
		// A correspondence seek is answered at once and stays in the lobby.
		form.Set("days", strconv.Itoa(p.Days))
		form.Set("variant", "standard")
		if p.Color != "" {
			form.Set("color", p.Color)
		}
		if p.RatingRange != "" {
			form.Set("ratingRange", p.RatingRange)
		}
		return c.call(ctx, "POST", "/api/board/seek", form, nil)
	}
	form.Set("time", strconv.FormatFloat(float64(p.Limit)/60, 'f', -1, 64))
	form.Set("increment", strconv.Itoa(p.Increment))
	form.Set("variant", "standard")
	if p.Color != "" {
		form.Set("color", p.Color)
	}
	if p.RatingRange != "" {
		form.Set("ratingRange", p.RatingRange)
	}
	return c.streamReq(ctx, c.Stream, "POST", "/api/board/seek", form, func([]byte) error { return nil })
}

// OnlineBots lists up to n bots that are online now.
func (c *Client) OnlineBots(ctx context.Context, n int) ([]User, error) {
	var users []User
	err := c.stream(ctx, c.HTTP, fmt.Sprintf("/api/bot/online?nb=%d", n), func(line []byte) error {
		var u User
		if err := json.Unmarshal(line, &u); err == nil {
			users = append(users, u)
		}
		return nil
	})
	return users, err
}

// StreamEvents follows /api/stream/event until ctx ends or the connection
// drops, calling fn for each event.
func (c *Client) StreamEvents(ctx context.Context, fn func(Event)) error {
	return c.stream(ctx, c.Stream, "/api/stream/event", func(line []byte) error {
		var e Event
		if err := json.Unmarshal(line, &e); err == nil {
			fn(e)
		}
		return nil
	})
}

// StreamGame follows a bot game until it ends, ctx ends or the connection
// drops, calling fn for each line.
func (c *Client) StreamGame(ctx context.Context, gameID string, fn func(GameEvent)) error {
	api := "bot"
	if c.Board {
		api = "board"
	}
	return c.stream(ctx, c.Stream, "/api/"+api+"/game/stream/"+url.PathEscape(gameID), func(line []byte) error {
		var e GameEvent
		if err := json.Unmarshal(line, &e); err == nil {
			fn(e)
		}
		return nil
	})
}

// stream reads newline-delimited JSON. Empty lines are keep-alives.
func (c *Client) stream(ctx context.Context, hc *http.Client, path string, fn func([]byte) error) error {
	return c.streamReq(ctx, hc, "GET", path, nil, fn)
}

func (c *Client) streamReq(ctx context.Context, hc *http.Client, method, path string, form url.Values, fn func([]byte) error) error {
	req, err := c.request(ctx, method, path, form)
	if err != nil {
		return err
	}
	res, err := hc.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return apiError(res)
	}
	r := bufio.NewReaderSize(res.Body, 64*1024)
	for {
		line, err := r.ReadBytes('\n')
		if len(strings.TrimSpace(string(line))) > 0 {
			if ferr := fn(line); ferr != nil {
				return ferr
			}
		}
		if err == io.EOF {
			return nil
		}
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return err
		}
	}
}
