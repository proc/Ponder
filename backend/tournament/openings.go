package tournament

import (
	"bufio"
	"errors"
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"strings"

	"board/backend/chess"
	"board/backend/openings"
	"board/backend/pgn"
)

// Opening is where a pair of games starts: a position and the moves
// played from it before the engines take over.
type Opening struct {
	FEN   string   // start position
	Moves []string // UCI, played from FEN
	Name  string
}

// OpeningConfig chooses the openings.
type OpeningConfig struct {
	Source string `json:"source"` // book (the built-in book), file, start
	Path   string `json:"path"`   // .epd or .pgn, for source "file"
	Order  string `json:"order"`  // random or sequential
	Plies  int    `json:"plies"`  // most moves (plies) taken from a PGN game or book line; 0: all
	Seed   int64  `json:"seed"`
}

func loadOpenings(c OpeningConfig) ([]Opening, error) {
	var ops []Opening
	var err error
	switch c.Source {
	case "", "book":
		ops = bookOpenings(c.Plies)
	case "start":
		ops = []Opening{{FEN: chess.StartFEN, Name: "Start position"}}
	case "file":
		ops, err = fileOpenings(c.Path, c.Plies)
	default:
		err = fmt.Errorf("unknown opening source %q", c.Source)
	}
	if err != nil {
		return nil, err
	}
	if len(ops) == 0 {
		return nil, errors.New("no usable openings found")
	}
	if c.Order != "sequential" {
		rng := rand.New(rand.NewSource(c.Seed))
		rng.Shuffle(len(ops), func(i, j int) { ops[i], ops[j] = ops[j], ops[i] })
	}
	return ops, nil
}

// bookOpenings are the built-in book's lines of at least 4 plies (shorter
// ones are too close to the start position), cut to plies, without
// duplicates.
func bookOpenings(plies int) []Opening {
	seen := map[string]bool{}
	var ops []Opening
	for _, l := range openings.Lines() {
		moves := l.Moves
		if plies > 0 && len(moves) > plies {
			moves = moves[:plies]
		}
		if len(moves) < 4 {
			continue
		}
		key := strings.Join(moves, " ")
		if seen[key] {
			continue
		}
		seen[key] = true
		ops = append(ops, Opening{FEN: chess.StartFEN, Moves: moves, Name: l.Opening.String()})
	}
	return ops
}

func fileOpenings(path string, plies int) ([]Opening, error) {
	if path == "" {
		return nil, errors.New("choose an openings file (.epd or .pgn)")
	}
	switch strings.ToLower(filepath.Ext(path)) {
	case ".pgn":
		return pgnOpenings(path, plies)
	default:
		return epdOpenings(path)
	}
}

// epdOpenings reads one position per line: the first four FEN fields, then
// operations (ignored), or a full FEN.
func epdOpenings(path string) ([]Opening, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var ops []Opening
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 4 {
			continue
		}
		fen := strings.Join(fields[:4], " ")
		if len(fields) >= 6 && isNumber(fields[4]) && isNumber(fields[5]) {
			fen += " " + fields[4] + " " + fields[5]
		} else {
			fen += " 0 1"
		}
		pos, err := chess.ParseFEN(fen)
		if err != nil || len(pos.LegalMoves()) == 0 {
			continue
		}
		name := ""
		if i := strings.Index(line, "id \""); i >= 0 {
			name = strings.SplitN(line[i+4:], "\"", 2)[0]
		}
		ops = append(ops, Opening{FEN: pos.FEN(), Name: name})
	}
	return ops, sc.Err()
}

func isNumber(s string) bool {
	if s == "" {
		return false
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

// pgnOpenings takes the first plies moves of each game in a PGN file.
func pgnOpenings(path string, plies int) ([]Opening, error) {
	c, err := pgn.Open(path, nil)
	if err != nil {
		return nil, err
	}
	var ops []Opening
	for i := 0; i < c.Len(); i++ {
		g, err := c.Read(i)
		if err != nil {
			continue
		}
		fen := g.Tag("FEN")
		if fen == "" {
			fen = chess.StartFEN
		}
		pos, err := chess.ParseFEN(fen)
		if err != nil {
			continue
		}
		start := pos.FEN()
		var moves []string
		for _, tok := range g.Moves {
			if plies > 0 && len(moves) >= plies {
				break
			}
			m, err := pgn.ParseMove(&pos, tok)
			if err != nil {
				break
			}
			moves = append(moves, m.UCI())
			pos = pos.Make(m)
		}
		if len(pos.LegalMoves()) == 0 {
			continue
		}
		name := g.Tag("Opening")
		if name == "" {
			name = g.Tag("Event")
		}
		ops = append(ops, Opening{FEN: start, Moves: moves, Name: name})
	}
	return ops, nil
}
