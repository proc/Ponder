// Package chess implements the rules of standard chess: move generation,
// FEN, SAN and draw detection. It has no dependencies.
package chess

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
)

type Color int8

const (
	White Color = 0
	Black Color = 1
)

func (c Color) Other() Color { return c ^ 1 }
func (c Color) String() string {
	if c == White {
		return "white"
	}
	return "black"
}

type Piece int8

const (
	Empty Piece = iota
	WP
	WN
	WB
	WR
	WQ
	WK
	BP
	BN
	BB
	BR
	BQ
	BK
)

// Piece types.
const (
	Pawn = iota + 1
	Knight
	Bishop
	Rook
	Queen
	King
)

func (p Piece) Color() Color {
	if p >= BP {
		return Black
	}
	return White
}

func (p Piece) Type() int {
	if p == Empty {
		return 0
	}
	return (int(p)-1)%6 + 1
}

func makePiece(c Color, t int) Piece { return Piece(int(c)*6 + t) }

const pieceChars = ".PNBRQKpnbrqk"

// Castling rights bits.
const (
	CastleWK = 1 << iota
	CastleWQ
	CastleBK
	CastleBQ
)

const StartFEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"

// Move is a move in coordinate form. Castling is the king's two-square move.
type Move struct {
	From, To int8
	Promo    int8 // piece type, 0 if none
}

func sqName(s int8) string {
	return string([]byte{'a' + byte(s%8), '1' + byte(s/8)})
}

func parseSq(s string) (int8, bool) {
	if len(s) != 2 || s[0] < 'a' || s[0] > 'h' || s[1] < '1' || s[1] > '8' {
		return 0, false
	}
	return int8(s[1]-'1')*8 + int8(s[0]-'a'), true
}

// UCI returns the move in UCI notation, e.g. "e2e4" or "e7e8q".
func (m Move) UCI() string {
	s := sqName(m.From) + sqName(m.To)
	if m.Promo != 0 {
		s += string("  nbrq"[m.Promo])
	}
	return s
}

// Position is a complete chess position. It is a value type; Make returns a copy.
type Position struct {
	Board    [64]Piece // a1 = 0, h1 = 7, a8 = 56
	Turn     Color
	Castle   uint8
	EP       int8 // en passant target square or -1
	Halfmove int
	Fullmove int
}

// ParseFEN parses and sanity-checks a FEN string.
func ParseFEN(fen string) (Position, error) {
	var p Position
	p.EP = -1
	f := strings.Fields(fen)
	if len(f) < 4 {
		return p, errors.New("FEN needs at least 4 fields")
	}
	rows := strings.Split(f[0], "/")
	if len(rows) != 8 {
		return p, errors.New("FEN board needs 8 ranks")
	}
	for i, row := range rows {
		rank := 7 - i
		file := 0
		for _, ch := range row {
			if ch >= '1' && ch <= '8' {
				file += int(ch - '0')
				continue
			}
			idx := strings.IndexRune(pieceChars[1:], ch)
			if idx < 0 || file > 7 {
				return p, fmt.Errorf("bad FEN rank %q", row)
			}
			p.Board[rank*8+file] = Piece(idx + 1)
			file++
		}
		if file != 8 {
			return p, fmt.Errorf("bad FEN rank %q", row)
		}
	}
	switch f[1] {
	case "w":
		p.Turn = White
	case "b":
		p.Turn = Black
	default:
		return p, errors.New("bad side to move in FEN")
	}
	if f[2] != "-" {
		for _, ch := range f[2] {
			switch ch {
			case 'K':
				p.Castle |= CastleWK
			case 'Q':
				p.Castle |= CastleWQ
			case 'k':
				p.Castle |= CastleBK
			case 'q':
				p.Castle |= CastleBQ
			default:
				return p, errors.New("bad castling field in FEN")
			}
		}
	}
	// Drop rights that the piece placement contradicts.
	if p.Board[4] != WK {
		p.Castle &^= CastleWK | CastleWQ
	}
	if p.Board[7] != WR {
		p.Castle &^= CastleWK
	}
	if p.Board[0] != WR {
		p.Castle &^= CastleWQ
	}
	if p.Board[60] != BK {
		p.Castle &^= CastleBK | CastleBQ
	}
	if p.Board[63] != BR {
		p.Castle &^= CastleBK
	}
	if p.Board[56] != BR {
		p.Castle &^= CastleBQ
	}
	if f[3] != "-" {
		s, ok := parseSq(f[3])
		if !ok || (s/8 != 2 && s/8 != 5) {
			return p, errors.New("bad en passant field in FEN")
		}
		p.EP = s
	}
	p.Fullmove = 1
	if len(f) > 4 {
		if n, err := strconv.Atoi(f[4]); err == nil && n >= 0 {
			p.Halfmove = n
		}
	}
	if len(f) > 5 {
		if n, err := strconv.Atoi(f[5]); err == nil && n >= 1 {
			p.Fullmove = n
		}
	}
	var kings [2]int
	for s, pc := range p.Board {
		if pc.Type() == King {
			kings[pc.Color()]++
		}
		if pc.Type() == Pawn && (s/8 == 0 || s/8 == 7) {
			return p, errors.New("pawn on first or last rank")
		}
	}
	if kings[0] != 1 || kings[1] != 1 {
		return p, errors.New("each side needs exactly one king")
	}
	if p.attacked(p.kingSq(p.Turn.Other()), p.Turn) {
		return p, errors.New("side not to move is in check")
	}
	return p, nil
}

// FEN returns the position as a FEN string.
func (p *Position) FEN() string {
	var b strings.Builder
	for rank := 7; rank >= 0; rank-- {
		empty := 0
		for file := 0; file < 8; file++ {
			pc := p.Board[rank*8+file]
			if pc == Empty {
				empty++
				continue
			}
			if empty > 0 {
				b.WriteByte('0' + byte(empty))
				empty = 0
			}
			b.WriteByte(pieceChars[pc])
		}
		if empty > 0 {
			b.WriteByte('0' + byte(empty))
		}
		if rank > 0 {
			b.WriteByte('/')
		}
	}
	if p.Turn == White {
		b.WriteString(" w ")
	} else {
		b.WriteString(" b ")
	}
	if p.Castle == 0 {
		b.WriteByte('-')
	} else {
		for i, ch := range "KQkq" {
			if p.Castle&(1<<i) != 0 {
				b.WriteRune(ch)
			}
		}
	}
	b.WriteByte(' ')
	if p.EP < 0 {
		b.WriteByte('-')
	} else {
		b.WriteString(sqName(p.EP))
	}
	fmt.Fprintf(&b, " %d %d", p.Halfmove, p.Fullmove)
	return b.String()
}

func (p *Position) kingSq(c Color) int8 {
	k := makePiece(c, King)
	for s, pc := range p.Board {
		if pc == k {
			return int8(s)
		}
	}
	return -1
}

var knightD = [8][2]int{{1, 2}, {2, 1}, {2, -1}, {1, -2}, {-1, -2}, {-2, -1}, {-2, 1}, {-1, 2}}
var kingD = [8][2]int{{1, 0}, {1, 1}, {0, 1}, {-1, 1}, {-1, 0}, {-1, -1}, {0, -1}, {1, -1}}
var bishopD = [4][2]int{{1, 1}, {1, -1}, {-1, 1}, {-1, -1}}
var rookD = [4][2]int{{1, 0}, {-1, 0}, {0, 1}, {0, -1}}

func on(f, r int) bool { return f >= 0 && f < 8 && r >= 0 && r < 8 }

// attacked reports whether square s is attacked by side by.
func (p *Position) attacked(s int8, by Color) bool {
	f, r := int(s%8), int(s/8)
	// Pawns: a white pawn attacks upward, so look one rank below s.
	pr := r - 1
	if by == Black {
		pr = r + 1
	}
	pawn := makePiece(by, Pawn)
	for _, df := range [2]int{-1, 1} {
		if on(f+df, pr) && p.Board[pr*8+f+df] == pawn {
			return true
		}
	}
	knight := makePiece(by, Knight)
	for _, d := range knightD {
		if on(f+d[0], r+d[1]) && p.Board[(r+d[1])*8+f+d[0]] == knight {
			return true
		}
	}
	king := makePiece(by, King)
	for _, d := range kingD {
		if on(f+d[0], r+d[1]) && p.Board[(r+d[1])*8+f+d[0]] == king {
			return true
		}
	}
	slide := func(dirs [4][2]int, a, b Piece) bool {
		for _, d := range dirs {
			x, y := f+d[0], r+d[1]
			for on(x, y) {
				pc := p.Board[y*8+x]
				if pc != Empty {
					if pc == a || pc == b {
						return true
					}
					break
				}
				x, y = x+d[0], y+d[1]
			}
		}
		return false
	}
	q := makePiece(by, Queen)
	return slide(bishopD, makePiece(by, Bishop), q) || slide(rookD, makePiece(by, Rook), q)
}

// InCheck reports whether the side to move is in check.
func (p *Position) InCheck() bool {
	return p.attacked(p.kingSq(p.Turn), p.Turn.Other())
}

func (p *Position) pseudoMoves() []Move {
	moves := make([]Move, 0, 48)
	us := p.Turn
	add := func(from, to int) {
		moves = append(moves, Move{From: int8(from), To: int8(to)})
	}
	for s := 0; s < 64; s++ {
		pc := p.Board[s]
		if pc == Empty || pc.Color() != us {
			continue
		}
		f, r := s%8, s/8
		switch pc.Type() {
		case Pawn:
			dir, startRank, promoRank := 1, 1, 7
			if us == Black {
				dir, startRank, promoRank = -1, 6, 0
			}
			addPawn := func(to int) {
				if to/8 == promoRank {
					for _, pt := range [4]int8{Queen, Rook, Bishop, Knight} {
						moves = append(moves, Move{From: int8(s), To: int8(to), Promo: pt})
					}
				} else {
					add(s, to)
				}
			}
			one := s + 8*dir
			if p.Board[one] == Empty {
				addPawn(one)
				if r == startRank && p.Board[one+8*dir] == Empty {
					add(s, one+8*dir)
				}
			}
			for _, df := range [2]int{-1, 1} {
				if !on(f+df, r+dir) {
					continue
				}
				to := (r+dir)*8 + f + df
				t := p.Board[to]
				if (t != Empty && t.Color() != us) || (t == Empty && int8(to) == p.EP) {
					addPawn(to)
				}
			}
		case Knight, King:
			dirs := knightD
			if pc.Type() == King {
				dirs = kingD
			}
			for _, d := range dirs {
				if !on(f+d[0], r+d[1]) {
					continue
				}
				to := (r+d[1])*8 + f + d[0]
				if t := p.Board[to]; t == Empty || t.Color() != us {
					add(s, to)
				}
			}
		default:
			var dirs [][2]int
			if pc.Type() != Rook {
				dirs = append(dirs, bishopD[:]...)
			}
			if pc.Type() != Bishop {
				dirs = append(dirs, rookD[:]...)
			}
			for _, d := range dirs {
				x, y := f+d[0], r+d[1]
				for on(x, y) {
					to := y*8 + x
					t := p.Board[to]
					if t == Empty {
						add(s, to)
					} else {
						if t.Color() != us {
							add(s, to)
						}
						break
					}
					x, y = x+d[0], y+d[1]
				}
			}
		}
	}
	// Castling.
	them := us.Other()
	home := 0
	ks, qs := uint8(CastleWK), uint8(CastleWQ)
	if us == Black {
		home = 56
		ks, qs = CastleBK, CastleBQ
	}
	e := int8(home + 4)
	if p.Castle&(ks|qs) != 0 && !p.attacked(e, them) {
		if p.Castle&ks != 0 && p.Board[home+5] == Empty && p.Board[home+6] == Empty &&
			!p.attacked(e+1, them) && !p.attacked(e+2, them) {
			add(home+4, home+6)
		}
		if p.Castle&qs != 0 && p.Board[home+3] == Empty && p.Board[home+2] == Empty && p.Board[home+1] == Empty &&
			!p.attacked(e-1, them) && !p.attacked(e-2, them) {
			add(home+4, home+2)
		}
	}
	return moves
}

// LegalMoves returns all legal moves for the side to move.
func (p *Position) LegalMoves() []Move {
	pseudo := p.pseudoMoves()
	legal := pseudo[:0]
	us := p.Turn
	for _, m := range pseudo {
		n := p.Make(m)
		if !n.attacked(n.kingSq(us), n.Turn) {
			legal = append(legal, m)
		}
	}
	return legal
}

func castleKeep(s int8) uint8 {
	switch s {
	case 0:
		return ^uint8(CastleWQ)
	case 4:
		return ^uint8(CastleWK | CastleWQ)
	case 7:
		return ^uint8(CastleWK)
	case 56:
		return ^uint8(CastleBQ)
	case 60:
		return ^uint8(CastleBK | CastleBQ)
	case 63:
		return ^uint8(CastleBK)
	}
	return 0xff
}

// Make plays m (assumed pseudo-legal) and returns the resulting position.
func (p Position) Make(m Move) Position {
	pc := p.Board[m.From]
	us := p.Turn
	t := pc.Type()
	captured := p.Board[m.To]
	newEP := int8(-1)
	p.Halfmove++
	p.Board[m.From] = Empty
	if t == Pawn {
		p.Halfmove = 0
		if m.To == p.EP && m.From%8 != m.To%8 && captured == Empty {
			if us == White {
				p.Board[m.To-8] = Empty
			} else {
				p.Board[m.To+8] = Empty
			}
		}
		if d := m.To - m.From; d == 16 || d == -16 {
			newEP = (m.From + m.To) / 2
		}
		if m.Promo != 0 {
			pc = makePiece(us, int(m.Promo))
		}
	}
	if captured != Empty {
		p.Halfmove = 0
	}
	p.Board[m.To] = pc
	if t == King {
		if m.To-m.From == 2 {
			p.Board[m.To-1] = p.Board[m.To+1]
			p.Board[m.To+1] = Empty
		} else if m.From-m.To == 2 {
			p.Board[m.To+1] = p.Board[m.To-2]
			p.Board[m.To-2] = Empty
		}
	}
	p.Castle &= castleKeep(m.From) & castleKeep(m.To)
	p.EP = newEP
	if us == Black {
		p.Fullmove++
	}
	p.Turn = us.Other()
	return p
}

// ParseUCIMove finds the legal move matching a UCI string such as "e2e4".
func (p *Position) ParseUCIMove(s string) (Move, error) {
	s = strings.ToLower(strings.TrimSpace(s))
	for _, m := range p.LegalMoves() {
		if m.UCI() == s {
			return m, nil
		}
	}
	return Move{}, fmt.Errorf("illegal move %q", s)
}

// SAN returns the standard algebraic notation of legal move m.
func (p *Position) SAN(m Move) string {
	pc := p.Board[m.From]
	t := pc.Type()
	var b strings.Builder
	switch {
	case t == King && m.To-m.From == 2:
		b.WriteString("O-O")
	case t == King && m.From-m.To == 2:
		b.WriteString("O-O-O")
	default:
		capture := p.Board[m.To] != Empty || (t == Pawn && m.From%8 != m.To%8)
		if t == Pawn {
			if capture {
				b.WriteByte('a' + byte(m.From%8))
			}
		} else {
			b.WriteByte(" PNBRQK"[t])
			sameFile, sameRank, other := false, false, false
			for _, o := range p.LegalMoves() {
				if o.To == m.To && o.From != m.From && p.Board[o.From] == pc {
					other = true
					if o.From%8 == m.From%8 {
						sameFile = true
					}
					if o.From/8 == m.From/8 {
						sameRank = true
					}
				}
			}
			if other {
				if !sameFile {
					b.WriteByte('a' + byte(m.From%8))
				} else if !sameRank {
					b.WriteByte('1' + byte(m.From/8))
				} else {
					b.WriteString(sqName(m.From))
				}
			}
		}
		if capture {
			b.WriteByte('x')
		}
		b.WriteString(sqName(m.To))
		if m.Promo != 0 {
			b.WriteByte('=')
			b.WriteByte(" PNBRQK"[m.Promo])
		}
	}
	n := p.Make(m)
	if n.InCheck() {
		if len(n.LegalMoves()) == 0 {
			b.WriteByte('#')
		} else {
			b.WriteByte('+')
		}
	}
	return b.String()
}

// Key identifies a position for repetition purposes.
type Key struct {
	Board  [64]Piece
	Turn   Color
	Castle uint8
	EP     int8
}

// Key returns the repetition key. The en passant square only counts when
// a capture onto it is actually legal.
func (p *Position) Key() Key {
	k := Key{Board: p.Board, Turn: p.Turn, Castle: p.Castle, EP: -1}
	if p.EP >= 0 {
		for _, m := range p.LegalMoves() {
			if m.To == p.EP && p.Board[m.From].Type() == Pawn {
				k.EP = p.EP
				break
			}
		}
	}
	return k
}

// InsufficientMaterial reports whether neither side can possibly mate.
func (p *Position) InsufficientMaterial() bool {
	return !p.CanMate(White) && !p.CanMate(Black) || p.deadBishops()
}

// CanMate reports whether side c has enough material that a mate is
// conceivable (used for timeouts: flagging against a bare king is a draw).
func (p *Position) CanMate(c Color) bool {
	minors := 0
	for _, pc := range p.Board {
		if pc == Empty || pc.Color() != c {
			continue
		}
		switch pc.Type() {
		case Pawn, Rook, Queen:
			return true
		case Knight, Bishop:
			minors++
		}
	}
	if minors >= 2 {
		return true
	}
	if minors == 0 {
		return false
	}
	// A single minor can only mate if the opponent has something besides a king
	// to block its own escape squares.
	for _, pc := range p.Board {
		if pc != Empty && pc.Color() != c && pc.Type() != King && pc.Type() != Queen {
			return true
		}
	}
	return false
}

// deadBishops: only kings and bishops, all bishops on one square colour.
func (p *Position) deadBishops() bool {
	colour := -1
	for s, pc := range p.Board {
		switch pc.Type() {
		case 0, King:
		case Bishop:
			c := (s%8 + s/8) % 2
			if colour >= 0 && colour != c {
				return false
			}
			colour = c
		default:
			return false
		}
	}
	return true
}
