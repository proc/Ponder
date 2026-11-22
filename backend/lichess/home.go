package lichess

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// The Lichess home of the person's own account (Board API): their profile
// and ratings, the games they have going (correspondence ones too), the
// players they follow and who of them is online, and the correspondence
// seeks waiting in the lobby. Each part is read on its own, so one failing
// (a token without follow:read, say) leaves the others.

// Perf is a rating at one speed or variant.
type Perf struct {
	Rating int  `json:"rating"`
	Games  int  `json:"games"`
	RD     int  `json:"rd,omitempty"`
	Prog   int  `json:"prog,omitempty"`
	Prov   bool `json:"prov,omitempty"`
}

// Profile is the person's account as /api/account gives it.
type Profile struct {
	ID        string          `json:"id"`
	Username  string          `json:"username"`
	Title     string          `json:"title,omitempty"`
	URL       string          `json:"url,omitempty"`
	Perfs     map[string]Perf `json:"perfs,omitempty"`
	CreatedAt int64           `json:"createdAt,omitempty"` // ms
	SeenAt    int64           `json:"seenAt,omitempty"`    // ms
	Patron    bool            `json:"patron,omitempty"`
	Count     *struct {
		All     int `json:"all"`
		Rated   int `json:"rated"`
		Win     int `json:"win"`
		Loss    int `json:"loss"`
		Draw    int `json:"draw"`
		Playing int `json:"playing"`
	} `json:"count,omitempty"`
	PlayTime *struct {
		Total int `json:"total"` // seconds
	} `json:"playTime,omitempty"`
	Profile *struct {
		Flag     string `json:"flag,omitempty"`
		Location string `json:"location,omitempty"`
		Bio      string `json:"bio,omitempty"`
	} `json:"profile,omitempty"`
}

// Profile reads the signed-in account with its ratings.
func (c *Client) Profile(ctx context.Context) (Profile, error) {
	var p Profile
	err := c.call(ctx, "GET", "/api/account", nil, &p)
	return p, err
}

// PlayingGame is one of the person's ongoing games, from /api/account/playing.
type PlayingGame struct {
	GameInfo
	LastMove    string `json:"lastMove,omitempty"`
	SecondsLeft int    `json:"secondsLeft,omitempty"` // on the person's clock, or for their move (correspondence)
	HasMoved    bool   `json:"hasMoved,omitempty"`
	Source      string `json:"source,omitempty"` // lobby, friend, pool, …
	Perf        string `json:"perf,omitempty"`
}

// Playing lists up to n ongoing games, the ones where it is the person's
// move first (as Lichess orders them).
func (c *Client) Playing(ctx context.Context, n int) ([]PlayingGame, error) {
	if n <= 0 {
		n = 50
	}
	var out struct {
		NowPlaying []PlayingGame `json:"nowPlaying"`
	}
	if err := c.call(ctx, "GET", "/api/account/playing?nb="+strconv.Itoa(n), nil, &out); err != nil {
		return nil, err
	}
	if out.NowPlaying == nil {
		out.NowPlaying = []PlayingGame{}
	}
	return out.NowPlaying, nil
}

// Friend is a player the person follows.
type Friend struct {
	ID      string          `json:"id"`
	Name    string          `json:"name"`
	Title   string          `json:"title,omitempty"`
	Flag    string          `json:"flag,omitempty"`
	Perfs   map[string]Perf `json:"perfs,omitempty"`
	Online  bool            `json:"online"`
	Playing bool            `json:"playing"`
	GameID  string          `json:"gameId,omitempty"`
	Clock   string          `json:"clock,omitempty"`
	SeenAt  int64           `json:"seenAt,omitempty"`
}

// Following lists up to max players the person follows (needs follow:read),
// with who is online and playing now; online players come first.
func (c *Client) Following(ctx context.Context, max int) ([]Friend, error) {
	if max <= 0 {
		max = 300
	}
	var friends []Friend
	err := c.stream(ctx, c.HTTP, "/api/rel/following", func(line []byte) error {
		if len(friends) >= max {
			return errStop
		}
		var u User
		if json.Unmarshal(line, &u) != nil || u.ID == "" {
			return nil
		}
		f := Friend{ID: u.ID, Name: u.DisplayName(), Title: u.Title, SeenAt: u.SeenAt, Perfs: map[string]Perf{}}
		if u.Profile != nil {
			f.Flag = u.Profile.Flag
		}
		for k, p := range u.Perfs {
			f.Perfs[k] = Perf{Rating: p.Rating, Games: p.Games, Prov: p.Prov, RD: p.RD, Prog: p.Prog}
		}
		friends = append(friends, f)
		return nil
	})
	if err != nil && !errors.Is(err, errStop) {
		return friends, err
	}
	if len(friends) == 0 {
		return []Friend{}, nil
	}
	ids := make([]string, len(friends))
	for i, f := range friends {
		ids[i] = f.ID
	}
	// Who is online is a nicety: without it, the list still shows.
	if st, err := c.UsersStatus(ctx, ids); err == nil {
		by := map[string]UserStatus{}
		for _, s := range st {
			by[strings.ToLower(s.ID)] = s
		}
		for i := range friends {
			if s, ok := by[strings.ToLower(friends[i].ID)]; ok {
				friends[i].Online, friends[i].Playing, friends[i].GameID, friends[i].Clock = s.Online, s.Playing, s.GameID, s.Clock
			}
		}
	}
	SortFriends(friends)
	return friends, nil
}

// SortFriends puts players in a game first, then the others online, then
// the rest by when they were last seen; ties by name.
func SortFriends(fs []Friend) {
	rank := func(f Friend) int {
		switch {
		case f.Playing:
			return 0
		case f.Online:
			return 1
		}
		return 2
	}
	sort.SliceStable(fs, func(i, j int) bool {
		a, b := fs[i], fs[j]
		if ra, rb := rank(a), rank(b); ra != rb {
			return ra < rb
		}
		if a.SeenAt != b.SeenAt && rank(a) == 2 {
			return a.SeenAt > b.SeenAt
		}
		return strings.ToLower(a.Name) < strings.ToLower(b.Name)
	})
}

var errStop = errors.New("stop")

// LobbyEntry is a correspondence seek waiting in the Lichess lobby.
type LobbyEntry struct {
	ID          string `json:"id"`
	Username    string `json:"username"`
	Rating      int    `json:"rating"`
	Provisional bool   `json:"provisional,omitempty"`
	Variant     string `json:"variant"`
	Perf        string `json:"perf"`
	Rated       bool   `json:"rated"`
	Days        int    `json:"days,omitempty"`
	Color       string `json:"color,omitempty"` // the seeker's: white, black or "" (random)
}

// LobbySeeks reads the correspondence seeks in the lobby. Lichess has no
// documented API for this; it is the list its own lobby page loads (real-
// time seeks only travel over its websocket, so they cannot be listed).
func (c *Client) LobbySeeks(ctx context.Context) ([]LobbyEntry, error) {
	req, err := c.request(ctx, "GET", "/lobby/seeks", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.lichess.v5+json")
	res, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return nil, apiError(res)
	}
	var raw []struct {
		ID          string          `json:"id"`
		Username    string          `json:"username"`
		Rating      int             `json:"rating"`
		Provisional bool            `json:"provisional"`
		Variant     json.RawMessage `json:"variant"`
		Perf        json.RawMessage `json:"perf"`
		Mode        int             `json:"mode"` // 1 rated, 0 casual
		Rated       *bool           `json:"rated"`
		Days        int             `json:"days"`
		Color       string          `json:"color"`
	}
	if err := json.NewDecoder(res.Body).Decode(&raw); err != nil {
		return nil, errors.New("Lichess's lobby list was not understood")
	}
	out := make([]LobbyEntry, 0, len(raw))
	for _, r := range raw {
		e := LobbyEntry{ID: r.ID, Username: r.Username, Rating: r.Rating, Provisional: r.Provisional,
			Variant: keyName(r.Variant, "key"), Perf: keyName(r.Perf, "key"), Rated: r.Mode == 1, Days: r.Days, Color: r.Color}
		if r.Rated != nil {
			e.Rated = *r.Rated
		}
		if e.Variant == "" {
			e.Variant = "standard"
		}
		out = append(out, e)
	}
	return out, nil
}

// Home is everything the home shows, each part with its own error.
type Home struct {
	Profile      *Profile      `json:"profile"`
	ProfileError string        `json:"profileError,omitempty"`
	Playing      []PlayingGame `json:"playing"`
	PlayingError string        `json:"playingError,omitempty"`
	Following    []Friend      `json:"following"`
	// FollowingError says why the players followed are missing; with
	// NeedsScope set, the sign-in lacks follow:read and has to be renewed.
	FollowingError string       `json:"followingError,omitempty"`
	NeedsScope     bool         `json:"needsScope,omitempty"`
	Lobby          []LobbyEntry `json:"lobby"`
	LobbyError     string       `json:"lobbyError,omitempty"`
	At             int64        `json:"at"` // ms
}

func errText(err error) string {
	return strings.TrimPrefix(err.Error(), "Lichess: ")
}

// missingScope tells a token without the permission from other failures.
func missingScope(err error) bool {
	var api *APIError
	return errors.As(err, &api) && (api.Status == 401 || api.Status == 403)
}

// ReadHome reads the four parts at once.
func (c *Client) ReadHome(ctx context.Context) Home {
	h := Home{Playing: []PlayingGame{}, Following: []Friend{}, Lobby: []LobbyEntry{}}
	var wg sync.WaitGroup
	var mu sync.Mutex
	run := func(f func()) {
		wg.Add(1)
		go func() { defer wg.Done(); f() }()
	}
	run(func() {
		p, err := c.Profile(ctx)
		mu.Lock()
		defer mu.Unlock()
		if err != nil {
			h.ProfileError = errText(err)
			return
		}
		h.Profile = &p
	})
	run(func() {
		g, err := c.Playing(ctx, 50)
		mu.Lock()
		defer mu.Unlock()
		if err != nil {
			h.PlayingError = errText(err)
			return
		}
		h.Playing = g
	})
	run(func() {
		f, err := c.Following(ctx, 300)
		mu.Lock()
		defer mu.Unlock()
		if err != nil {
			if missingScope(err) {
				h.NeedsScope = true
				h.FollowingError = "Sign in again to let Ponder see the players you follow (it needs Lichess's “Read followed players” permission)."
			} else {
				h.FollowingError = errText(err)
			}
			return
		}
		h.Following = f
	})
	run(func() {
		// The lobby is public: no token, so a refusal is not the sign-in's.
		l, err := NewClient(c.BaseURL, "").LobbySeeks(ctx)
		mu.Lock()
		defer mu.Unlock()
		if err != nil {
			h.LobbyError = "The lobby could not be read: " + errText(err)
			return
		}
		h.Lobby = l
	})
	wg.Wait()
	h.At = time.Now().UnixMilli()
	return h
}

// Home reads the home of the account signed in.
func (p *Player) Home() (Home, error) {
	c, err := p.connected()
	if err != nil {
		return Home{}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	h := c.ReadHome(ctx)
	p.mu.Lock()
	p.playing = map[string]GameInfo{}
	for _, g := range h.Playing {
		p.playing[g.Key()] = g.GameInfo
	}
	p.mu.Unlock()
	return h, nil
}

// Resume puts an ongoing game on the board: one Ponder follows already, or
// one from /api/account/playing it does not (a correspondence game Lichess
// did not announce, say), which it then starts following.
func (p *Player) Resume(id string) error {
	p.mu.Lock()
	_, known := p.games[id]
	p.mu.Unlock()
	if known {
		return p.Show(id)
	}
	c, err := p.connected()
	if err != nil {
		return err
	}
	p.mu.Lock()
	info, ok := p.playing[id]
	p.mu.Unlock()
	if !ok {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		games, err := c.Playing(ctx, 50)
		cancel()
		if err != nil {
			return err
		}
		for _, g := range games {
			if g.Key() == id {
				info, ok = g.GameInfo, true
			}
		}
		if !ok {
			return errors.New("that game is not going on any more")
		}
	}
	p.mu.Lock()
	if _, known := p.games[id]; known { // the event stream was quicker
		p.mu.Unlock()
		return p.Show(id)
	}
	if p.runCtx == nil {
		p.mu.Unlock()
		return errors.New("sign in to Lichess first")
	}
	p.addGameLocked(p.runCtx, &info)
	p.mu.Unlock()
	p.emit()
	return nil
}
