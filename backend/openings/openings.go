// Package openings names chess openings from an embedded book of about
// 3,800 ECO-coded lines (see NOTICE.md), so the current opening can be shown
// without an engine.
package openings

import (
	_ "embed"
	"sort"
	"strings"
	"sync"

	"board/backend/chess"
	"board/backend/pgn"
)

//go:embed openings.tsv
var data string

// Opening is a named line, e.g. {"B90", "Sicilian Defense: Najdorf Variation"}.
type Opening struct {
	ECO  string
	Name string
}

// String is the ECO code and name, e.g. "B90 Sicilian Defense: Najdorf Variation".
func (o Opening) String() string {
	if o.Name == "" {
		return ""
	}
	return o.ECO + " " + o.Name
}

var (
	once  sync.Once
	book  map[chess.Key]Opening
	lines []Line
)

// Line is a book line from the start position, as UCI moves.
type Line struct {
	Opening
	Moves []string
}

// Load builds the book. It is called on first use; calling it early (in the
// background) saves the first lookup the work, which takes a few tens of ms.
func Load() {
	once.Do(func() {
		book = make(map[chess.Key]Opening, 4096)
		start, _ := chess.ParseFEN(chess.StartFEN)
		rows := strings.Split(data, "\n")
		for _, line := range rows[1:] { // skip the header
			f := strings.Split(strings.TrimRight(line, "\r"), "\t")
			if len(f) != 3 {
				continue
			}
			games, err := pgn.Parse(f[2])
			if err != nil || len(games) != 1 {
				continue
			}
			pos := start
			ok := true
			var ucis []string
			for _, tok := range games[0].Moves {
				m, err := pgn.ParseMove(&pos, tok)
				if err != nil {
					ok = false
					break
				}
				ucis = append(ucis, m.UCI())
				pos = pos.Make(m)
			}
			if ok {
				lines = append(lines, Line{Opening: Opening{ECO: f[0], Name: f[1]}, Moves: ucis})
			}
			if !ok {
				continue
			}
			// Positions are the key, so transpositions find their name. The
			// first (shortest, most common) line to name a position wins.
			if _, seen := book[pos.Key()]; !seen {
				book[pos.Key()] = Opening{ECO: f[0], Name: f[1]}
			}
		}
	})
}

// Size is the number of named positions in the book.
func Size() int {
	Load()
	return len(book)
}

// Lookup returns the opening whose line reaches exactly this position.
func Lookup(pos *chess.Position) (Opening, bool) {
	Load()
	o, ok := book[pos.Key()]
	return o, ok
}

// Lines is every line of the book, in book order. Callers must not change it.
func Lines() []Line {
	Load()
	return lines
}

// BookMove is a move from a position that the book continues with.
type BookMove struct {
	UCI   string `json:"uci"`
	SAN   string `json:"san"`
	Name  string `json:"name,omitempty"`  // the opening this move reaches, if it has a name
	Lines int    `json:"lines"`           // book lines through this move
	Leads string `json:"leads,omitempty"` // an opening further down
}

var (
	nextOnce sync.Once
	next     map[chess.Key][]BookMove
)

// Next lists the book's moves from a position, the most common first.
func Next(pos *chess.Position) []BookMove {
	nextOnce.Do(func() {
		next = map[chess.Key][]BookMove{}
		index := map[chess.Key]map[string]int{}
		start, _ := chess.ParseFEN(chess.StartFEN)
		for _, l := range Lines() {
			p := start
			for _, u := range l.Moves {
				mv, err := p.ParseUCIMove(u)
				if err != nil {
					break
				}
				k := p.Key()
				if index[k] == nil {
					index[k] = map[string]int{}
				}
				q := p.Make(mv)
				i, ok := index[k][u]
				if !ok {
					bm := BookMove{UCI: u, SAN: p.SAN(mv)}
					if o, ok := Lookup(&q); ok {
						bm.Name = o.String()
					}
					next[k] = append(next[k], bm)
					i = len(next[k]) - 1
					index[k][u] = i
				}
				next[k][i].Lines++
				if next[k][i].Leads == "" && l.Opening.String() != next[k][i].Name {
					next[k][i].Leads = l.Opening.String()
				}
				p = q
			}
		}
		for _, list := range next {
			sort.SliceStable(list, func(a, b int) bool { return list[a].Lines > list[b].Lines })
		}
	})
	return next[pos.Key()]
}
