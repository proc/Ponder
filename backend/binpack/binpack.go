// Package binpack writes and reads Stockfish's .binpack training data, the
// format nnue-pytorch trains NNUE networks from.
//
// A file is a run of chunks: "BINP", the chunk's size (4 bytes, little
// endian) and the chunk. A chunk is a run of chains. A chain is one full
// entry (32 bytes: position, move, score, ply and result, fifty-move
// counter), a count of the entries that follow (2 bytes, big endian) and
// those entries packed as bits: each one is the position after the
// previous entry's move, so only its move (as an index among the moving
// side's pieces and that piece's moves) and its score (as a difference)
// are stored. The layout follows nnue_data_binpack_format.h.
package binpack

import (
	"bufio"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"math/bits"

	"board/backend/chess"
)

// Entry is one training position: the position, the move played in it,
// its score and the game's result, both from the side to move.
type Entry struct {
	Pos    chess.Position
	Move   chess.Move
	Score  int16 // Stockfish's internal units (a pawn is about 208)
	Result int8  // 1 won, 0 drawn, -1 lost, for the side to move
}

// Ply is the game ply the entry stores: from the position's move number.
func (e *Entry) Ply() int {
	ply := (e.Pos.Fullmove-1)*2 + int(e.Pos.Turn)
	if ply < 0 {
		ply = 0
	}
	if ply > 0x3FFF {
		ply = 0x3FFF
	}
	return ply
}

const (
	chunkSize            = 1 << 20 // a chunk is written once it reaches this
	maxChunkSize         = 100 << 20
	scoreBlockSize       = 4
	valueNone      int16 = 32002
)

// ValueNone is the score Stockfish's tools write for a position without
// one; nnue-pytorch skips such positions.
const ValueNone = valueNone

// Writer writes entries to a binpack. Entries that continue the previous
// one (the next position of the same game) are packed into its chain.
type Writer struct {
	w       io.Writer
	buf     []byte // the chunk being built
	chain   bitWriter
	plies   int // entries in the current chain after its first
	last    Entry
	hasLast bool
	err     error
	n       int64 // entries written
}

func NewWriter(w io.Writer) *Writer {
	return &Writer{w: w, buf: make([]byte, 0, chunkSize+64*1024)}
}

// Entries is how many entries have been added.
func (w *Writer) Entries() int64 { return w.n }

// Add writes one entry. The move must be legal in the position.
func (w *Writer) Add(e Entry) error {
	if w.err != nil {
		return w.err
	}
	if w.hasLast && w.plies < 0xFFFF && continues(&w.last, &e) {
		w.chain.addMove(&e.Pos, e.Move, e.Score)
		w.plies++
	} else {
		if w.hasLast {
			w.endChain()
		}
		if len(w.buf) >= chunkSize {
			w.flush()
		}
		w.buf = append(w.buf, packEntry(&e)...)
		w.chain.reset(e.Score)
		w.plies = 0
	}
	w.last, w.hasLast = e, true
	w.n++
	return w.err
}

// Close finishes the last chain and writes what is left. It does not close
// the underlying writer.
func (w *Writer) Close() error {
	if w.hasLast {
		w.endChain()
		w.hasLast = false
	}
	if len(w.buf) > 0 {
		w.flush()
	}
	return w.err
}

func (w *Writer) endChain() {
	w.buf = append(w.buf, byte(w.plies>>8), byte(w.plies))
	if w.plies > 0 {
		w.buf = append(w.buf, w.chain.bytes...)
	}
}

func (w *Writer) flush() {
	if w.err != nil || len(w.buf) == 0 {
		return
	}
	var head [8]byte
	copy(head[:], "BINP")
	binary.LittleEndian.PutUint32(head[4:], uint32(len(w.buf)))
	if _, err := w.w.Write(head[:]); err != nil {
		w.err = err
		return
	}
	if _, err := w.w.Write(w.buf); err != nil {
		w.err = err
	}
	w.buf = w.buf[:0]
}

// continues reports whether b is the position after a's move in the same
// game, so that it can be packed into a's chain.
func continues(a, b *Entry) bool {
	if a.Result != -b.Result || a.Ply()+1 != b.Ply() {
		return false
	}
	next := a.Pos.Make(a.Move)
	return next.Board == b.Pos.Board && next.Turn == b.Pos.Turn &&
		castling(&next) == castling(&b.Pos) && epSquare(&next) == epSquare(&b.Pos) &&
		next.Halfmove == b.Pos.Halfmove
}

// --- Positions and moves as the format sees them ---

// castling is the castling rights the format can store: those whose rook
// is still in its corner.
func castling(p *chess.Position) uint8 {
	c := p.Castle
	if p.Board[7] != chess.WR {
		c &^= chess.CastleWK
	}
	if p.Board[0] != chess.WR {
		c &^= chess.CastleWQ
	}
	if p.Board[63] != chess.BR {
		c &^= chess.CastleBK
	}
	if p.Board[56] != chess.BR {
		c &^= chess.CastleBQ
	}
	return c
}

// epSquare is the en passant square when a pawn can really take en
// passant, else -1: the format (like Stockfish) keeps it only then.
func epSquare(p *chess.Position) int8 {
	ep := p.EP
	if ep < 0 || p.Board[ep] != chess.Empty {
		return -1
	}
	pawn, them, behind, ahead := chess.WP, chess.BP, ep-8, ep+8
	if p.Turn == chess.Black {
		pawn, them, behind, ahead = chess.BP, chess.WP, ep+8, ep-8
	}
	if behind < 0 || behind > 63 || ahead < 0 || ahead > 63 || p.Board[behind] != them || p.Board[ahead] != chess.Empty {
		return -1
	}
	for _, m := range p.LegalMoves() {
		if m.To == ep && p.Board[m.From] == pawn {
			return ep
		}
	}
	return -1
}

func bb(s int8) uint64 { return 1 << uint(s) }

// sideBB is the squares of c's pieces.
func sideBB(p *chess.Position, c chess.Color) (b uint64) {
	for s, pc := range p.Board {
		if pc != chess.Empty && pc.Color() == c {
			b |= 1 << uint(s)
		}
	}
	return
}

// below is the squares before s (a1 first).
func below(s int8) uint64 { return bb(s) - 1 }

var (
	knightSteps = [8][2]int{{1, 2}, {2, 1}, {2, -1}, {1, -2}, {-1, -2}, {-2, -1}, {-2, 1}, {-1, 2}}
	kingSteps   = [8][2]int{{1, 0}, {1, 1}, {0, 1}, {-1, 1}, {-1, 0}, {-1, -1}, {0, -1}, {1, -1}}
	rookDirs    = [4][2]int{{1, 0}, {-1, 0}, {0, 1}, {0, -1}}
	bishopDirs  = [4][2]int{{1, 1}, {1, -1}, {-1, 1}, {-1, -1}}
)

func steps(s int8, d [8][2]int) (b uint64) {
	f, r := int(s%8), int(s/8)
	for _, x := range d {
		if nf, nr := f+x[0], r+x[1]; nf >= 0 && nf < 8 && nr >= 0 && nr < 8 {
			b |= 1 << uint(nr*8+nf)
		}
	}
	return
}

func slides(s int8, dirs [4][2]int, occ uint64) (b uint64) {
	f, r := int(s%8), int(s/8)
	for _, d := range dirs {
		nf, nr := f+d[0], r+d[1]
		for nf >= 0 && nf < 8 && nr >= 0 && nr < 8 {
			sq := uint(nr*8 + nf)
			b |= 1 << sq
			if occ&(1<<sq) != 0 {
				break
			}
			nf, nr = nf+d[0], nr+d[1]
		}
	}
	return
}

// attacks is where a piece of type t on s attacks (not pawns).
func attacks(t int, s int8, occ uint64) uint64 {
	switch t {
	case chess.Knight:
		return steps(s, knightSteps)
	case chess.Bishop:
		return slides(s, bishopDirs, occ)
	case chess.Rook:
		return slides(s, rookDirs, occ)
	case chess.Queen:
		return slides(s, bishopDirs, occ) | slides(s, rookDirs, occ)
	case chess.King:
		return steps(s, kingSteps)
	}
	return 0
}

func pawnAttacks(s int8, c chess.Color) (b uint64) {
	f, r := s%8, s/8
	dr := int8(1)
	if c == chess.Black {
		dr = -1
	}
	if nr := r + dr; nr >= 0 && nr < 8 {
		if f > 0 {
			b |= bb(nr*8 + f - 1)
		}
		if f < 7 {
			b |= bb(nr*8 + f + 1)
		}
	}
	return
}

// isCastle reports whether m is castling (the king's two-square move).
func isCastle(p *chess.Position, m chess.Move) bool {
	d := m.To - m.From
	return p.Board[m.From].Type() == chess.King && (d == 2 || d == -2)
}

// nibble codes of the packed position.
func pieceCode(pc chess.Piece) byte {
	// Ponder: WP..WK = 1..6, BP..BK = 7..12. Format: type*2 + color.
	t := byte(pc.Type() - 1)
	return t*2 + byte(pc.Color())
}

func packEntry(e *Entry) []byte {
	p := &e.Pos
	out := make([]byte, 32)
	var occ uint64
	for s, pc := range p.Board {
		if pc != chess.Empty {
			occ |= 1 << uint(s)
		}
	}
	binary.BigEndian.PutUint64(out, occ)
	ep := epSquare(p)
	cr := castling(p)
	i := 0
	for s := int8(0); s < 64; s++ {
		pc := p.Board[s]
		if pc == chess.Empty {
			continue
		}
		code := pieceCode(pc)
		switch {
		case pc.Type() == chess.Pawn && ep >= 0 && s%8 == ep%8 &&
			((p.Turn == chess.White && s/8 == 4) || (p.Turn == chess.Black && s/8 == 3)):
			code = 12
		case pc == chess.WR && ((s == 0 && cr&chess.CastleWQ != 0) || (s == 7 && cr&chess.CastleWK != 0)):
			code = 13
		case pc == chess.BR && ((s == 56 && cr&chess.CastleBQ != 0) || (s == 63 && cr&chess.CastleBK != 0)):
			code = 14
		case pc == chess.BK && p.Turn == chess.Black:
			code = 15
		}
		if i%2 == 0 {
			out[8+i/2] = code
		} else {
			out[8+i/2] |= code << 4
		}
		i++
	}
	binary.BigEndian.PutUint16(out[24:], packMove(p, e.Move))
	binary.BigEndian.PutUint16(out[26:], signedToUnsigned(e.Score))
	pr := uint16(e.Ply()) | signedToUnsigned(int16(e.Result))<<14
	binary.BigEndian.PutUint16(out[28:], pr)
	rule50 := p.Halfmove
	if rule50 < 0 {
		rule50 = 0
	}
	if rule50 > 0xFFFF {
		rule50 = 0xFFFF
	}
	binary.BigEndian.PutUint16(out[30:], uint16(rule50))
	return out
}

// packMove: move type (2 bits), from (6), to (6), promotion (2). Castling
// is the king taking its own rook.
func packMove(p *chess.Position, m chess.Move) uint16 {
	typ, to, promo := uint16(0), uint16(m.To), uint16(0)
	switch {
	case m.Promo != 0:
		typ, promo = 1, uint16(m.Promo-chess.Knight)
	case isCastle(p, m):
		typ = 2
		if m.To > m.From {
			to = uint16(m.From + 3)
		} else {
			to = uint16(m.From - 4)
		}
	case p.Board[m.From].Type() == chess.Pawn && m.To == p.EP && m.From%8 != m.To%8 && p.Board[m.To] == chess.Empty:
		typ = 3
	}
	return typ<<14 | uint16(m.From)<<8 | to<<2 | promo
}

func signedToUnsigned(a int16) uint16 {
	r := uint16(a)
	if r&0x8000 != 0 {
		r ^= 0x7FFF
	}
	return r<<1 | r>>15
}

func unsignedToSigned(r uint16) int16 {
	r = r<<15 | r>>1
	if r&0x8000 != 0 {
		r ^= 0x7FFF
	}
	return int16(r)
}

func usedBits(n int) uint {
	if n == 0 {
		return 0
	}
	return uint(bits.Len(uint(n - 1)))
}

// board is what move indexing needs of a position.
type board struct {
	ours, theirs, occ uint64
	ep                int8
	castle            uint8 // the side to move's castling rights
}

func newBoard(p *chess.Position) board {
	b := board{ours: sideBB(p, p.Turn), theirs: sideBB(p, p.Turn.Other()), ep: epSquare(p)}
	b.occ = b.ours | b.theirs
	mask := uint8(chess.CastleWK | chess.CastleWQ)
	if p.Turn == chess.Black {
		mask = chess.CastleBK | chess.CastleBQ
	}
	b.castle = castling(p) & mask
	return b
}

// dests is where the piece on from can go as the format counts it:
// pseudo-legal destinations, castling aside.
func (b *board) dests(p *chess.Position, from int8) uint64 {
	us := p.Turn
	switch t := p.Board[from].Type(); t {
	case chess.Pawn:
		fwd, start := int8(8), int8(1)
		if us == chess.Black {
			fwd, start = -8, 6
		}
		targets := b.theirs
		if b.ep >= 0 {
			targets |= bb(b.ep)
		}
		dest := pawnAttacks(from, us) & targets
		if one := from + fwd; one >= 0 && one < 64 && b.occ&bb(one) == 0 {
			dest |= bb(one)
			if from/8 == start && b.occ&bb(one+fwd) == 0 {
				dest |= bb(one + fwd)
			}
		}
		return dest
	default:
		return attacks(t, from, b.occ) &^ b.ours
	}
}

// promotes reports whether the pawn moves of the piece on from promote.
func promotes(p *chess.Position, from int8) bool {
	if p.Board[from].Type() != chess.Pawn {
		return false
	}
	if p.Turn == chess.White {
		return from/8 == 6
	}
	return from/8 == 1
}

// moveIndex is how a continuation's move is stored: the moving piece's
// index among its side's pieces (pieceID of numPieces) and the move's
// index among that piece's moves (moveID of numMoves). Moves are counted
// as the format does: pseudo-legal, and a king's castling rights whether
// or not castling is possible.
func moveIndex(p *chess.Position, m chess.Move) (pieceID, numPieces, moveID, numMoves int) {
	b := newBoard(p)
	pieceID = bits.OnesCount64(b.ours & below(m.From))
	numPieces = bits.OnesCount64(b.ours)
	dest := b.dests(p, m.From)
	moveID = bits.OnesCount64(dest & below(m.To))
	numMoves = bits.OnesCount64(dest)
	switch {
	case promotes(p, m.From):
		moveID = moveID*4 + int(m.Promo-chess.Knight)
		numMoves *= 4
	case p.Board[m.From].Type() == chess.King:
		n := numMoves
		numMoves += bits.OnesCount8(b.castle)
		if isCastle(p, m) {
			moveID = n - 1
			if b.castle&(chess.CastleWQ|chess.CastleBQ) != 0 {
				moveID++
			}
			if m.To > m.From {
				moveID++
			}
		}
	}
	return
}

// bitWriter builds a chain's packed moves and scores.
type bitWriter struct {
	bytes     []byte
	left      uint // bits left in the last byte
	lastScore int16
}

func (b *bitWriter) reset(score int16) {
	b.bytes = b.bytes[:0]
	b.left = 0
	b.lastScore = -score
}

func (b *bitWriter) add(v uint8, count uint) {
	if count == 0 {
		return
	}
	switch {
	case b.left == 0:
		b.bytes = append(b.bytes, v<<(8-count))
		b.left = 8
	case count <= b.left:
		b.bytes[len(b.bytes)-1] |= v << (b.left - count)
	default:
		spill := count - b.left
		b.bytes[len(b.bytes)-1] |= v >> spill
		b.bytes = append(b.bytes, v<<(8-spill))
		b.left += 8
	}
	b.left -= count
}

func (b *bitWriter) addVLE(v uint16, block uint) {
	mask := uint16(1)<<block - 1
	for {
		out := uint8(v & mask)
		if v > mask {
			out |= 1 << block
		}
		b.add(out, block+1)
		v >>= block
		if v == 0 {
			break
		}
	}
}

func (b *bitWriter) addMove(p *chess.Position, m chess.Move, score int16) {
	pieceID, numPieces, moveID, numMoves := moveIndex(p, m)
	b.add(uint8(pieceID), usedBits(numPieces))
	b.add(uint8(moveID), usedBits(numMoves))
	b.addVLE(signedToUnsigned(score-b.lastScore), scoreBlockSize)
	b.lastScore = -score
}

// --- Reading ---

// Reader reads the entries of a binpack.
type Reader struct {
	r       *bufio.Reader
	chunk   []byte
	off     int
	pending []Entry
}

func NewReader(r io.Reader) *Reader { return &Reader{r: bufio.NewReader(r)} }

// ErrFormat is returned for data that is not a binpack.
var ErrFormat = errors.New("not a binpack file")

// Next returns the next entry, or io.EOF at the end.
func (r *Reader) Next() (Entry, error) {
	if len(r.pending) > 0 {
		e := r.pending[0]
		r.pending = r.pending[1:]
		return e, nil
	}
	if r.off >= len(r.chunk) {
		var head [8]byte
		if _, err := io.ReadFull(r.r, head[:]); err != nil {
			if err == io.ErrUnexpectedEOF {
				return Entry{}, ErrFormat
			}
			return Entry{}, err
		}
		if string(head[:4]) != "BINP" {
			return Entry{}, ErrFormat
		}
		n := binary.LittleEndian.Uint32(head[4:])
		if n > maxChunkSize {
			return Entry{}, ErrFormat
		}
		r.chunk = make([]byte, n)
		if _, err := io.ReadFull(r.r, r.chunk); err != nil {
			return Entry{}, ErrFormat
		}
		r.off = 0
	}
	if err := r.readChain(); err != nil {
		return Entry{}, err
	}
	return r.Next()
}

func (r *Reader) readChain() error {
	if len(r.chunk)-r.off < 34 {
		return ErrFormat
	}
	e, err := unpackEntry(r.chunk[r.off : r.off+32])
	if err != nil {
		return err
	}
	r.off += 32
	plies := int(binary.BigEndian.Uint16(r.chunk[r.off:]))
	r.off += 2
	r.pending = append(r.pending[:0], e)
	br := bitReader{data: r.chunk[r.off:]}
	last := -e.Score
	prev := e
	for i := 0; i < plies; i++ {
		next := Entry{Pos: prev.Pos.Make(prev.Move), Result: -prev.Result}
		m, err := br.move(&next.Pos)
		if err != nil {
			return err
		}
		next.Move = m
		d, err := br.vle(scoreBlockSize)
		if err != nil {
			return err
		}
		next.Score = last + unsignedToSigned(d)
		last = -next.Score
		r.pending = append(r.pending, next)
		prev = next
	}
	r.off += br.used()
	return nil
}

func unpackEntry(b []byte) (Entry, error) {
	var e Entry
	p := &e.Pos
	p.EP = -1
	occ := binary.BigEndian.Uint64(b)
	if bits.OnesCount64(occ) > 32 {
		return e, ErrFormat
	}
	i := 0
	for s := int8(0); s < 64; s++ {
		if occ&bb(s) == 0 {
			continue
		}
		code := b[8+i/2]
		if i%2 == 1 {
			code >>= 4
		}
		code &= 15
		i++
		switch {
		case code < 12:
			p.Board[s] = chess.Piece(int(code&1)*6 + int(code>>1) + 1)
		case code == 12:
			if s/8 == 3 {
				p.Board[s], p.EP = chess.WP, s-8
			} else {
				p.Board[s], p.EP = chess.BP, s+8
			}
		case code == 13:
			p.Board[s] = chess.WR
			if s == 0 {
				p.Castle |= chess.CastleWQ
			} else {
				p.Castle |= chess.CastleWK
			}
		case code == 14:
			p.Board[s] = chess.BR
			if s == 56 {
				p.Castle |= chess.CastleBQ
			} else {
				p.Castle |= chess.CastleBK
			}
		case code == 15:
			p.Board[s] = chess.BK
			p.Turn = chess.Black
		}
	}
	mv := binary.BigEndian.Uint16(b[24:])
	from, to := int8(mv>>8&63), int8(mv>>2&63)
	switch mv >> 14 {
	case 1:
		e.Move = chess.Move{From: from, To: to, Promo: int8(mv&3) + chess.Knight}
	case 2:
		if to > from {
			to = from + 2
		} else {
			to = from - 2
		}
		e.Move = chess.Move{From: from, To: to}
	default:
		e.Move = chess.Move{From: from, To: to}
	}
	e.Score = unsignedToSigned(binary.BigEndian.Uint16(b[26:]))
	pr := binary.BigEndian.Uint16(b[28:])
	ply := int(pr & 0x3FFF)
	e.Result = int8(unsignedToSigned(pr >> 14))
	p.Fullmove = ply/2 + 1
	p.Halfmove = int(binary.BigEndian.Uint16(b[30:]))
	return e, nil
}

type bitReader struct {
	data []byte
	pos  uint // bits read
}

func (b *bitReader) used() int { return int((b.pos + 7) / 8) }

func (b *bitReader) read(count uint) (int, error) {
	v := 0
	for i := uint(0); i < count; i++ {
		byteI := b.pos / 8
		if int(byteI) >= len(b.data) {
			return 0, ErrFormat
		}
		bit := (b.data[byteI] >> (7 - b.pos%8)) & 1
		v = v<<1 | int(bit)
		b.pos++
	}
	return v, nil
}

func (b *bitReader) vle(block uint) (uint16, error) {
	var v uint16
	var shift uint
	for {
		x, err := b.read(block + 1)
		if err != nil {
			return 0, err
		}
		v |= uint16(x&(1<<block-1)) << shift
		shift += block
		if x>>block == 0 {
			return v, nil
		}
		if shift > 16 {
			return 0, ErrFormat
		}
	}
}

// move reads a continuation's move in p, the inverse of moveIndex.
func (r *bitReader) move(p *chess.Position) (chess.Move, error) {
	b := newBoard(p)
	pieceID, err := r.read(usedBits(bits.OnesCount64(b.ours)))
	if err != nil {
		return chess.Move{}, err
	}
	from := nthBit(b.ours, pieceID)
	if from < 0 {
		return chess.Move{}, ErrFormat
	}
	dest := b.dests(p, from)
	n := bits.OnesCount64(dest)
	isKing := p.Board[from].Type() == chess.King
	numMoves := n
	if promotes(p, from) {
		numMoves *= 4
	} else if isKing {
		numMoves += bits.OnesCount8(b.castle)
	}
	id, err := r.read(usedBits(numMoves))
	if err != nil {
		return chess.Move{}, err
	}
	switch {
	case promotes(p, from):
		to := nthBit(dest, id/4)
		if to < 0 {
			return chess.Move{}, ErrFormat
		}
		return chess.Move{From: from, To: to, Promo: int8(id%4) + chess.Knight}, nil
	case isKing && id >= n:
		// Castling: long is n (or n-1 + 1), short the last.
		long := b.castle&(chess.CastleWQ|chess.CastleBQ) != 0
		if long && id == n {
			return chess.Move{From: from, To: from - 2}, nil
		}
		return chess.Move{From: from, To: from + 2}, nil
	}
	to := nthBit(dest, id)
	if to < 0 {
		return chess.Move{}, fmt.Errorf("%w: move %d of the piece on %d not found", ErrFormat, id, from)
	}
	return chess.Move{From: from, To: to}, nil
}

// nthBit is the square of the n-th set bit of b (from a1), or -1.
func nthBit(b uint64, n int) int8 {
	for ; b != 0; b &= b - 1 {
		if n == 0 {
			return int8(bits.TrailingZeros64(b))
		}
		n--
	}
	return -1
}

// FEN is the entry's position as the format keeps it: en passant only when
// it can be taken, castling only with the rook in its corner, and the move
// number from the ply.
func FEN(e *Entry) string {
	p := e.Pos
	p.EP = epSquare(&p)
	p.Castle = castling(&p)
	p.Fullmove = e.Ply()/2 + 1
	return p.FEN()
}
