// Package pgn reads games in Portable Game Notation.
package pgn

import (
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"board/backend/chess"
)

type Tag struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// Game is one game as written in the file: its tags, the main line's moves
// as written (variations, comments and annotation marks are dropped) and the
// result token that ended the movetext.
type Game struct {
	Tags   []Tag
	Moves  []string
	Result string
}

// Tag returns the value of the named tag, or "".
func (g *Game) Tag(name string) string {
	for _, t := range g.Tags {
		if t.Name == name {
			return t.Value
		}
	}
	return ""
}

// visitor receives what scan finds. end is called after each game.
type visitor struct {
	tag    func(Tag)
	move   func(string)
	result func(string)
	end    func()
}

// Characters that end a movetext token.
var tokenEnd = func() (t [256]bool) {
	for _, c := range []byte(" \t\r\n{}()[];") {
		t[c] = true
	}
	return
}()

// scan walks PGN text: tags, main-line moves and results, skipping comments,
// variations and annotation marks. A game ends at its result token or where
// a tag follows movetext. Layout is lenient: games need not be separated by
// blank lines, and move numbers may touch their moves.
func scan(text string, v visitor) error {
	text = strings.TrimPrefix(text, "\ufeff")
	started := false // the current game has tags, moves or a result
	inMoves := false // the current game has movetext
	end := func() {
		if started {
			v.end()
		}
		started, inMoves = false, false
	}

	i, n := 0, len(text)
	lineStart := true
	for i < n {
		c := text[i]
		switch {
		case c == '\n':
			lineStart = true
			i++
			continue
		case c == ' ' || c == '\t' || c == '\r':
			i++
			continue
		case c == '%' && lineStart: // escape line
			for i < n && text[i] != '\n' {
				i++
			}
			continue
		case c == ';': // comment to end of line
			for i < n && text[i] != '\n' {
				i++
			}
			continue
		case c == '{':
			e := strings.IndexByte(text[i:], '}')
			if e < 0 {
				end()
				return errors.New("unclosed { comment")
			}
			i += e + 1
		case c == '(':
			// Skip a variation, which may nest and contain comments.
			depth := 0
			for i < n {
				switch text[i] {
				case '(':
					depth++
				case ')':
					depth--
				case '{':
					if e := strings.IndexByte(text[i:], '}'); e >= 0 {
						i += e
					}
				case ';':
					for i < n && text[i] != '\n' {
						i++
					}
					continue
				}
				i++
				if depth == 0 {
					break
				}
			}
		case c == '[':
			if inMoves {
				end()
			}
			e := i + 1
			for e < n && text[e] != ']' {
				if text[e] == '"' {
					e++
					for e < n && text[e] != '"' {
						if text[e] == '\\' {
							e++
						}
						e++
					}
				}
				e++
			}
			if e >= n {
				end()
				return errors.New("unclosed [ tag")
			}
			if t, ok := parseTag(text[i+1 : e]); ok {
				started = true
				v.tag(t)
			}
			i = e + 1
		default:
			start := i
			for i < n && !tokenEnd[text[i]] {
				i++
			}
			tok := text[start:i]
			switch tok {
			case "1-0", "0-1", "1/2-1/2", "*":
				started = true
				v.result(tok)
				end()
			default:
				if mv := cleanToken(tok); mv != "" {
					started, inMoves = true, true
					v.move(mv)
				} else if tok != "" {
					inMoves = true
				}
			}
		}
		lineStart = false
	}
	end()
	return nil
}

// Parse splits text into games.
func Parse(text string) ([]Game, error) {
	var games []Game
	var cur Game
	err := scan(text, visitor{
		tag:    func(t Tag) { cur.Tags = append(cur.Tags, t) },
		move:   func(m string) { cur.Moves = append(cur.Moves, m) },
		result: func(r string) { cur.Result = r },
		end: func() {
			games = append(games, cur)
			cur = Game{}
		},
	})
	return games, err
}

var unescapeTag = strings.NewReplacer(`\"`, `"`, `\\`, `\`)

func parseTag(s string) (Tag, bool) {
	s = strings.TrimSpace(s)
	sp := strings.IndexAny(s, " \t")
	if sp < 0 {
		return Tag{}, false
	}
	name := s[:sp]
	val := strings.TrimSpace(s[sp:])
	if len(val) < 2 || val[0] != '"' || val[len(val)-1] != '"' {
		return Tag{}, false
	}
	val = val[1 : len(val)-1]
	if strings.IndexByte(val, '\\') >= 0 {
		val = unescapeTag.Replace(val)
	}
	return Tag{Name: name, Value: val}, true
}

// cleanToken strips move numbers and annotation marks; it returns "" for
// tokens that are not moves (numbers alone, NAGs, "e.p.").
func cleanToken(tok string) string {
	if tok == "" || tok[0] == '$' || tok == "e.p." {
		return ""
	}
	// A move number: digits followed by dots ("12.", "12...", "12.e4").
	d := 0
	for d < len(tok) && tok[d] >= '0' && tok[d] <= '9' {
		d++
	}
	if d == len(tok) {
		return "" // a bare number
	}
	if d > 0 && tok[d] == '.' {
		for d < len(tok) && tok[d] == '.' {
			d++
		}
		tok = tok[d:]
	}
	tok = strings.TrimSuffix(tok, "e.p.")
	for len(tok) > 0 {
		switch tok[len(tok)-1] {
		case '+', '#', '!', '?':
			tok = tok[:len(tok)-1]
			continue
		}
		break
	}
	return tok
}

var sanMove = regexp.MustCompile(`^([NBRQK])?([a-h])?([1-8])?[x:-]?([a-h][1-8])(?:=?\(?([NBRQnbrq])\)?)?$`)

// ParseMove finds the legal move in pos that a move token describes. It
// accepts standard SAN and the usual deviations: over-disambiguation
// ("Ngf3", "Qd1e2"), castling with zeros, promotions without "=", and
// coordinate notation ("e2e4").
func ParseMove(pos *chess.Position, tok string) (chess.Move, error) {
	legal := pos.LegalMoves()
	switch strings.ReplaceAll(tok, "0", "O") {
	case "O-O", "O-O-O":
		long := strings.Count(tok, "-") == 2
		for _, m := range legal {
			if pos.Board[m.From].Type() == chess.King {
				if d := int(m.To) - int(m.From); (d == 2 && !long) || (d == -2 && long) {
					return m, nil
				}
			}
		}
		return chess.Move{}, errors.New("castling is not legal in this position")
	}
	sm := sanMove.FindStringSubmatch(tok)
	if sm == nil {
		return chess.Move{}, errors.New("not a recognisable move")
	}
	pieceType := chess.Pawn
	if sm[1] != "" {
		pieceType = strings.IndexByte(" PNBRQK", sm[1][0])
	}
	to := int8(sm[4][1]-'1')*8 + int8(sm[4][0]-'a')
	promo := int8(0)
	if sm[5] != "" {
		promo = int8(strings.IndexByte(" PNBRQK", strings.ToUpper(sm[5])[0]))
	}
	var found []chess.Move
	for _, m := range legal {
		// Coordinate notation ("g1f3") names the square, not the piece.
		coordinate := sm[1] == "" && sm[2] != "" && sm[3] != ""
		if m.To != to || (!coordinate && pos.Board[m.From].Type() != pieceType) {
			continue
		}
		if sm[2] != "" && int8(sm[2][0]-'a') != m.From%8 {
			continue
		}
		if sm[3] != "" && int8(sm[3][0]-'1') != m.From/8 {
			continue
		}
		if m.Promo != promo && !(promo == 0 && m.Promo == chess.Queen) {
			continue
		}
		found = append(found, m)
	}
	switch len(found) {
	case 1:
		return found[0], nil
	case 0:
		return chess.Move{}, errors.New("not a legal move in this position")
	}
	return chess.Move{}, errors.New("ambiguous in this position")
}

// Replay plays the game's moves from its starting position. It returns the
// start position and the moves; the error names the first move that fails.
func (g *Game) Replay() (chess.Position, []chess.Move, error) {
	fen := chess.StartFEN
	if f := strings.TrimSpace(g.Tag("FEN")); f != "" {
		fen = f
	}
	start, err := chess.ParseFEN(fen)
	if err != nil {
		return start, nil, fmt.Errorf("bad FEN tag: %w", err)
	}
	pos := start
	moves := make([]chess.Move, 0, len(g.Moves))
	for _, tok := range g.Moves {
		m, err := ParseMove(&pos, tok)
		if err != nil {
			num := strconv.Itoa(pos.Fullmove) + "."
			if pos.Turn == chess.Black {
				num += ".."
			}
			return start, moves, fmt.Errorf("move %s%s: %w", num, tok, err)
		}
		moves = append(moves, m)
		pos = pos.Make(m)
	}
	return start, moves, nil
}
