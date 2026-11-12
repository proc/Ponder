// Package puzzles reads the Lichess puzzle database (lichess_db_puzzle.csv,
// from database.lichess.org) so puzzles work offline. The file is millions
// of lines: only the offset and rating of each line are kept, and lines are
// read when a puzzle is picked.
package puzzles

import (
	"bufio"
	"bytes"
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
)

// Puzzle is one puzzle as the CSV gives it. FEN is the position before the
// opponent's move; Moves[0] is that move, the rest the solution.
type Puzzle struct {
	ID       string   `json:"id"`
	FEN      string   `json:"fen"`
	Moves    []string `json:"moves"`
	Rating   int      `json:"rating"`
	Themes   []string `json:"themes"`
	GameURL  string   `json:"gameUrl"`
	Openings []string `json:"openings,omitempty"`
}

// DB is an opened puzzle file.
type DB struct {
	mu      sync.Mutex
	path    string
	f       *os.File
	offsets []int64
	ratings []uint16
	rng     *rand.Rand
}

// Open indexes a puzzle file; progress gets the bytes read so far.
func Open(path string, progress func(done, total int64)) (*DB, error) {
	if strings.HasSuffix(strings.ToLower(path), ".zst") {
		return nil, errors.New("this file is compressed: decompress it first (for example with “zstd -d " + filepath.Base(path) + "”), then open the .csv")
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	info, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, err
	}
	db := &DB{path: path, f: f, rng: rand.New(rand.NewSource(rand.Int63()))}
	r := bufio.NewReaderSize(f, 1<<20)
	var off int64
	first := true
	lastReport := int64(0)
	for {
		line, err := r.ReadSlice('\n')
		if err == bufio.ErrBufferFull {
			// An overlong line: skip it.
			n := int64(len(line))
			for err == bufio.ErrBufferFull {
				line, err = r.ReadSlice('\n')
				n += int64(len(line))
			}
			off += n
			continue
		}
		n := int64(len(line))
		if len(line) > 0 {
			if first && bytes.HasPrefix(line, []byte("PuzzleId")) {
				// The header.
			} else if rating, ok := ratingOf(line); ok {
				db.offsets = append(db.offsets, off)
				db.ratings = append(db.ratings, uint16(rating))
			}
			first = false
		}
		off += n
		if progress != nil && off-lastReport > 32<<20 {
			progress(off, info.Size())
			lastReport = off
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			f.Close()
			return nil, err
		}
	}
	if len(db.offsets) == 0 {
		f.Close()
		return nil, errors.New("no puzzles found: choose lichess_db_puzzle.csv from database.lichess.org")
	}
	return db, nil
}

// ratingOf reads the fourth field without parsing the whole line.
func ratingOf(line []byte) (int, bool) {
	field := 0
	start := 0
	for i, c := range line {
		if c == ',' {
			if field == 3 {
				v, err := strconv.Atoi(string(line[start:i]))
				return v, err == nil && v > 0 && v < 65536
			}
			field++
			start = i + 1
		}
	}
	return 0, false
}

func (db *DB) Close() error { return db.f.Close() }
func (db *DB) Len() int     { return len(db.offsets) }
func (db *DB) Path() string { return db.path }

func (db *DB) read(i int) (Puzzle, error) {
	buf := make([]byte, 4096)
	n, err := db.f.ReadAt(buf, db.offsets[i])
	if err != nil && err != io.EOF {
		return Puzzle{}, err
	}
	line := buf[:n]
	if j := bytes.IndexByte(line, '\n'); j >= 0 {
		line = line[:j]
	}
	rec, err := csv.NewReader(bytes.NewReader(line)).Read()
	if err != nil || len(rec) < 8 {
		return Puzzle{}, fmt.Errorf("bad puzzle line %d", i+1)
	}
	rating, _ := strconv.Atoi(rec[3])
	p := Puzzle{ID: rec[0], FEN: rec[1], Moves: strings.Fields(rec[2]), Rating: rating, Themes: strings.Fields(rec[7])}
	if len(rec) > 8 {
		p.GameURL = rec[8]
	}
	if len(rec) > 9 {
		p.Openings = strings.Fields(rec[9])
	}
	return p, nil
}

// Random picks a puzzle rated between min and max (0: no bound) with the
// theme, if one is given.
func (db *DB) Random(min, max int, theme string) (Puzzle, error) {
	db.mu.Lock()
	defer db.mu.Unlock()
	// Candidates by rating, then try them in random order for the theme.
	var idx []int
	for i, r := range db.ratings {
		if (min == 0 || int(r) >= min) && (max == 0 || int(r) <= max) {
			idx = append(idx, i)
		}
	}
	if len(idx) == 0 {
		return Puzzle{}, errors.New("no puzzle in that rating range")
	}
	db.rng.Shuffle(len(idx), func(a, b int) { idx[a], idx[b] = idx[b], idx[a] })
	tries := len(idx)
	if theme == "" {
		tries = 1
	} else if tries > 20000 {
		tries = 20000
	}
	for t := 0; t < tries; t++ {
		p, err := db.read(idx[t])
		if err != nil {
			continue
		}
		if theme == "" || hasTheme(p, theme) {
			return p, nil
		}
	}
	return Puzzle{}, fmt.Errorf("no %s puzzle found in that rating range", theme)
}

func hasTheme(p Puzzle, theme string) bool {
	for _, t := range p.Themes {
		if strings.EqualFold(t, theme) {
			return true
		}
	}
	return false
}
