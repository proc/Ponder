package lichess

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// --- Lichess TV (public, no token needed) ---

// TVChannels are the TV channels Ponder can show (standard chess), in the
// order they are offered, with their names.
var TVChannels = []struct{ Key, Name string }{
	{"best", "Top rated"}, {"bullet", "Bullet"}, {"blitz", "Blitz"}, {"rapid", "Rapid"},
	{"classical", "Classical"}, {"ultraBullet", "UltraBullet"}, {"bot", "Bot"}, {"computer", "Computer"},
}

// TVChannelName is a channel's name, "" for one Ponder does not show.
func TVChannelName(key string) string {
	for _, c := range TVChannels {
		if c.Key == key {
			return c.Name
		}
	}
	return ""
}

// TVChannel is what a channel is showing now, from /api/tv/channels.
type TVChannel struct {
	Key    string `json:"key"`
	Name   string `json:"name"`
	GameID string `json:"gameId,omitempty"`
	Player string `json:"player,omitempty"` // the player the channel follows
	Title  string `json:"title,omitempty"`
	Rating int    `json:"rating,omitempty"`
}

// TVNow is what each channel Ponder can show is showing.
func (c *Client) TVNow(ctx context.Context) ([]TVChannel, error) {
	var raw map[string]struct {
		User *struct {
			Name  string `json:"name"`
			Title string `json:"title"`
		} `json:"user"`
		Rating int    `json:"rating"`
		GameID string `json:"gameId"`
	}
	if err := c.getJSON(ctx, "/api/tv/channels", &raw); err != nil {
		return nil, err
	}
	out := make([]TVChannel, 0, len(TVChannels))
	for _, ch := range TVChannels {
		tc := TVChannel{Key: ch.Key, Name: ch.Name}
		if r, ok := raw[ch.Key]; ok {
			tc.GameID, tc.Rating = r.GameID, r.Rating
			if r.User != nil {
				tc.Player, tc.Title = r.User.Name, r.User.Title
			}
		}
		out = append(out, tc)
	}
	return out, nil
}

// TVEvent is a line of a TV feed: "featured" when a game comes on (ID and
// Orientation set), "fen" after each of its moves.
type TVEvent struct {
	T string `json:"t"`
	D struct {
		ID          string `json:"id"`
		Orientation string `json:"orientation"`
		Fen         string `json:"fen"`
	} `json:"d"`
}

// TVFeed follows a TV channel ("best" is the main Lichess TV).
func (c *Client) TVFeed(ctx context.Context, channel string, fn func(TVEvent)) error {
	path := "/api/tv/feed"
	if channel != "best" {
		path = "/api/tv/" + url.PathEscape(channel) + "/feed"
	}
	return c.stream(ctx, c.Stream, path, func(line []byte) error {
		var e TVEvent
		if json.Unmarshal(line, &e) == nil {
			fn(e)
		}
		return nil
	})
}

// StartTV shows a Lichess TV channel on the board: each game the channel
// puts on, live, one after another. The moves come from the game's own
// stream, as for a player followed.
func (s *Spectator) StartTV(baseURL, channel string) error {
	name := TVChannelName(channel)
	if name == "" {
		return fmt.Errorf("Ponder cannot show the TV channel %q", channel)
	}
	s.Stop()
	ctx, cancel := context.WithCancel(context.Background())
	s.mu.Lock()
	s.gen++
	gen := s.gen
	s.client = NewClient(baseURL, "")
	s.cancel = cancel
	s.games, s.order, s.shown, s.skip = map[string]*watched{}, nil, "", map[string]bool{}
	who := "Lichess TV · " + name
	s.status = SpectateStatus{Active: true, User: who, TV: channel, State: "looking", Message: "Tuning in to " + who + "…"}
	s.mu.Unlock()
	s.publish()
	go s.followTV(ctx, gen, channel, who)
	return nil
}

// followTV reads the channel's feed, and puts each game it features on
// the board. A feed that drops is opened again.
func (s *Spectator) followTV(ctx context.Context, gen int, channel, who string) {
	backoff := time.Second
	for ctx.Err() == nil {
		err := s.client.TVFeed(ctx, channel, func(e TVEvent) {
			if e.T == "featured" && e.D.ID != "" {
				backoff = time.Second
				s.feature(ctx, gen, who, e.D.ID, e.D.Orientation)
			}
		})
		if ctx.Err() != nil {
			return
		}
		wait := backoff
		if err != nil && s.liveCount(gen) == 0 {
			msg := fmt.Sprintf("Could not reach Lichess TV (%v); trying again…", err)
			var api *APIError
			switch {
			case RateLimited(err):
				msg, wait = "Lichess asked to slow down; trying again in a minute…", time.Minute
			case errors.As(err, &api) && api.Status == http.StatusNotFound:
				msg = "Lichess has no such TV channel."
			}
			if !s.setStatus(gen, func(st *SpectateStatus) { st.State, st.Message = "waiting", msg }) {
				return
			}
		}
		if !sleepCtx(ctx, wait) {
			return
		}
		backoff = min(backoff*2, 30*time.Second)
	}
}

// feature puts the game the channel has just featured on the board. The
// game before it gets to finish there first (Lichess features the next
// game as soon as one ends), so that its result is seen.
func (s *Spectator) feature(ctx context.Context, gen int, who, id, side string) {
	s.mu.Lock()
	cur := s.games[s.shown]
	same := gen != s.gen || s.games[id] != nil
	s.mu.Unlock()
	if same {
		return
	}
	if cur != nil {
		deadline := time.Now().Add(s.TVWait)
		for {
			s.mu.Lock()
			done := gen != s.gen || cur.finished
			s.mu.Unlock()
			if done || time.Now().After(deadline) {
				break
			}
			if !sleepCtx(ctx, 50*time.Millisecond) {
				return
			}
		}
		if !sleepCtx(ctx, s.TVHold) {
			return
		}
	}
	g, err := s.client.ExportGame(ctx, id)
	if err != nil {
		if ctx.Err() == nil {
			s.setStatus(gen, func(st *SpectateStatus) {
				if len(s.games) == 0 {
					st.State, st.Message = "waiting", "Could not read the game on TV ("+strings.TrimSpace(err.Error())+"); waiting for the next one…"
				}
			})
		}
		return
	}
	if g.ID == "" {
		g.ID = id
	}
	s.add(ctx, gen, who, g, side)
}
