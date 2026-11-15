package lichess

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
)

// PlayerInfo is what Lichess says about one player, passed on as Lichess
// sends it: the profile (/api/user), the rating history of every speed, and
// the statistics at one speed (/api/user/{name}/perf/{perf}).
type PlayerInfo struct {
	Profile json.RawMessage `json:"profile,omitempty"`
	History json.RawMessage `json:"history,omitempty"`
	Perf    json.RawMessage `json:"perf,omitempty"`
	Error   string          `json:"error,omitempty"`
}

// PlayersInfo is two players' information and their games against each
// other.
type PlayersInfo struct {
	Players    map[string]PlayerInfo `json:"players"`
	Crosstable json.RawMessage       `json:"crosstable,omitempty"`
}

var perfKeys = map[string]bool{"ultraBullet": true, "bullet": true, "blitz": true, "rapid": true, "classical": true, "correspondence": true}

// Players reads everything about the given players at once. perf picks the
// speed for the detailed statistics; with two players the crosstable comes
// too. A failure for one part leaves the rest.
func (c *Client) Players(ctx context.Context, names []string, perf string) PlayersInfo {
	out := PlayersInfo{Players: map[string]PlayerInfo{}}
	var mu sync.Mutex
	var wg sync.WaitGroup
	get := func(path string, set func(json.RawMessage, error)) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			var raw json.RawMessage
			err := c.getJSON(ctx, path, &raw)
			mu.Lock()
			set(raw, err)
			mu.Unlock()
		}()
	}
	for _, name := range names {
		name := strings.TrimSpace(name)
		if name == "" {
			continue
		}
		u := url.PathEscape(name)
		out.Players[name] = PlayerInfo{}
		update := func(f func(*PlayerInfo)) func(json.RawMessage, error) {
			return func(raw json.RawMessage, err error) {
				p := out.Players[name]
				if err != nil {
					if p.Error == "" {
						p.Error = err.Error()
					}
				} else {
					f(&p)
				}
				out.Players[name] = p
			}
		}
		get("/api/user/"+u, func(raw json.RawMessage, err error) {
			update(func(p *PlayerInfo) { p.Profile = raw })(raw, err)
		})
		get("/api/user/"+u+"/rating-history", func(raw json.RawMessage, err error) {
			update(func(p *PlayerInfo) { p.History = raw })(raw, err)
		})
		if perfKeys[perf] {
			get("/api/user/"+u+"/perf/"+perf, func(raw json.RawMessage, err error) {
				if err != nil {
					return // no games at this speed: not worth an error
				}
				update(func(p *PlayerInfo) { p.Perf = raw })(raw, nil)
			})
		}
	}
	if len(names) == 2 && names[0] != "" && names[1] != "" {
		get("/api/crosstable/"+url.PathEscape(names[0])+"/"+url.PathEscape(names[1]), func(raw json.RawMessage, err error) {
			if err == nil {
				out.Crosstable = raw
			}
		})
	}
	wg.Wait()
	return out
}

// Flags are players' country flags as their Lichess profiles give them
// ("US", "GB-SCT", "_rainbow"…), by lower-case id; "" for a player with
// none. Up to 300 players a request (POST /api/users).
func (c *Client) Flags(ctx context.Context, ids []string) (map[string]string, error) {
	out := map[string]string{}
	var clean []string
	for _, id := range ids {
		if id = strings.ToLower(strings.TrimSpace(id)); id != "" && !strings.ContainsAny(id, ", ") {
			clean = append(clean, id)
		}
	}
	for start := 0; start < len(clean); start += 300 {
		batch := clean[start:min(start+300, len(clean))]
		req, err := c.request(ctx, "POST", "/api/users", nil)
		if err != nil {
			return out, err
		}
		req.Body = io.NopCloser(strings.NewReader(strings.Join(batch, ",")))
		req.ContentLength = int64(len(strings.Join(batch, ",")))
		req.Header.Set("Content-Type", "text/plain")
		req.Header.Set("Accept", "application/json")
		res, err := c.HTTP.Do(req)
		if err != nil {
			return out, err
		}
		var users []struct {
			ID      string `json:"id"`
			Profile struct {
				Flag string `json:"flag"`
			} `json:"profile"`
		}
		if res.StatusCode != http.StatusOK {
			err = apiError(res)
		} else {
			err = json.NewDecoder(res.Body).Decode(&users)
		}
		res.Body.Close()
		if err != nil {
			return out, err
		}
		for _, id := range batch {
			out[id] = ""
		}
		for _, u := range users {
			out[strings.ToLower(u.ID)] = u.Profile.Flag
		}
	}
	return out, nil
}
