package pgn

import (
	"sort"
	"strconv"
	"strings"
)

// Query picks games out of a file. Every part that is set must hold.
type Query struct {
	// Words that must each be found in one of the headers the list shows.
	Words []string `json:"words"`
	// Text a header must contain, ignoring case.
	White  string `json:"white"`
	Black  string `json:"black"`
	Player string `json:"player"` // either colour
	Event  string `json:"event"`
	// Result is 1-0, 0-1, 1/2-1/2 or *; "decisive" is a win for either side.
	Result string `json:"result"`
	// Dates as YYYY, YYYY.MM or YYYY.MM.DD: the game's date must not be
	// before From nor after To. Games without a date never match a bound.
	DateFrom string `json:"dateFrom"`
	DateTo   string `json:"dateTo"`
	// Length in moves (0: no limit).
	MinMoves int `json:"minMoves"`
	MaxMoves int `json:"maxMoves"`
}

// Empty reports whether the query picks every game.
func (q Query) Empty() bool {
	return len(q.Words) == 0 && q.White == "" && q.Black == "" && q.Player == "" && q.Event == "" &&
		q.Result == "" && q.DateFrom == "" && q.DateTo == "" && q.MinMoves <= 0 && q.MaxMoves <= 0
}

// prepared is a query made ready to be tried on many games.
type prepared struct {
	Query
	words                       []string
	white, black, player, event string
	from, to                    string
}

func (q Query) prepare() prepared {
	low := func(s string) string { return strings.ToLower(strings.TrimSpace(s)) }
	date := func(s string) string { return strings.NewReplacer("-", ".", "/", ".").Replace(strings.TrimSpace(s)) }
	p := prepared{Query: q, white: low(q.White), black: low(q.Black), player: low(q.Player), event: low(q.Event),
		from: date(q.DateFrom), to: date(q.DateTo)}
	for _, w := range q.Words {
		if w = low(w); w != "" {
			p.words = append(p.words, w)
		}
	}
	return p
}

// moves is a game's length as the list shows it.
func moves(plies int32) int { return int(plies+1) / 2 }

func (p *prepared) match(r *record) bool {
	for _, w := range p.words {
		if !containsFold(r.white, w) && !containsFold(r.black, w) && !containsFold(r.event, w) &&
			!containsFold(r.date, w) && !containsFold(r.round, w) && !containsFold(r.result, w) {
			return false
		}
	}
	switch {
	case p.white != "" && !containsFold(r.white, p.white),
		p.black != "" && !containsFold(r.black, p.black),
		p.player != "" && !containsFold(r.white, p.player) && !containsFold(r.black, p.player),
		p.event != "" && !containsFold(r.event, p.event):
		return false
	}
	switch p.Result {
	case "":
	case "decisive":
		if r.result != "1-0" && r.result != "0-1" {
			return false
		}
	case "*":
		if r.result != "*" && r.result != "" {
			return false
		}
	default:
		if r.result != p.Result {
			return false
		}
	}
	if p.from != "" || p.to != "" {
		d := r.date
		if len(d) < 4 || strings.Contains(d[:4], "?") {
			return false
		}
		// Unknown parts of a date ("2024.??.??") are left out of the comparison.
		if i := strings.IndexByte(d, '?'); i >= 0 {
			d = strings.TrimRight(d[:i], ".")
		}
		if p.from != "" && prefixCompare(d, p.from) < 0 {
			return false
		}
		if p.to != "" && prefixCompare(d, p.to) > 0 {
			return false
		}
	}
	n := moves(r.plies)
	if p.MinMoves > 0 && n < p.MinMoves {
		return false
	}
	if p.MaxMoves > 0 && n > p.MaxMoves {
		return false
	}
	return true
}

// prefixCompare compares two dates as far as both go: 2024.05 is neither
// before nor after 2024.
func prefixCompare(a, b string) int {
	n := min(len(a), len(b))
	return strings.Compare(a[:n], b[:n])
}

// Select returns the indices of the games q picks, in file order.
func (c *Collection) Select(q Query) []int {
	p := q.prepare()
	var out []int
	for i := range c.records {
		if p.match(&c.records[i]) {
			out = append(out, i)
		}
	}
	return out
}

// Search returns the games q picks, sorted by a column (index, white,
// black, result, event, date, round or moves; anything else is file
// order), at most limit of them (all if limit <= 0), and how many it
// picks in total.
func (c *Collection) Search(q Query, by string, desc bool, limit int) (matched int, found []Entry) {
	idx := c.Select(q)
	matched = len(idx)
	if less := c.order(by); less != nil {
		sort.SliceStable(idx, func(a, b int) bool {
			if desc {
				return less(idx[b], idx[a])
			}
			return less(idx[a], idx[b])
		})
	} else if desc {
		for a, b := 0, len(idx)-1; a < b; a, b = a+1, b-1 {
			idx[a], idx[b] = idx[b], idx[a]
		}
	}
	if limit > 0 && len(idx) > limit {
		idx = idx[:limit]
	}
	found = make([]Entry, 0, len(idx))
	for _, i := range idx {
		found = append(found, c.Entry(i))
	}
	return matched, found
}

// order is how two games compare by a column, or nil for file order.
func (c *Collection) order(by string) func(a, b int) bool {
	text := func(get func(*record) string) func(a, b int) bool {
		return func(a, b int) bool {
			return strings.ToLower(get(&c.records[a])) < strings.ToLower(get(&c.records[b]))
		}
	}
	switch by {
	case "white":
		return text(func(r *record) string { return r.white })
	case "black":
		return text(func(r *record) string { return r.black })
	case "event":
		return text(func(r *record) string { return r.event })
	case "result":
		return text(func(r *record) string { return r.result })
	case "date":
		return text(func(r *record) string { return r.date })
	case "round":
		// Rounds are numbers ("3", "3.2") where they can be.
		return func(a, b int) bool {
			ra, rb := c.records[a].round, c.records[b].round
			na, ea := strconv.ParseFloat(ra, 64)
			nb, eb := strconv.ParseFloat(rb, 64)
			switch {
			case ea == nil && eb == nil:
				return na < nb
			case ea == nil || eb == nil:
				return ea == nil // numbers first
			}
			return ra < rb
		}
	case "moves":
		return func(a, b int) bool { return c.records[a].plies < c.records[b].plies }
	}
	return nil
}
