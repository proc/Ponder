package lichess

import (
	"context"
	"encoding/json"
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
