package pgn

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"runtime"
	"runtime/debug"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
	"unsafe"
)

// Entry describes one game in a PGN file, for the game list.
type Entry struct {
	Index  int    `json:"index"`
	White  string `json:"white"`
	Black  string `json:"black"`
	Result string `json:"result"`
	Date   string `json:"date"`
	Event  string `json:"event"`
	Round  string `json:"round"`
	Plies  int    `json:"plies"`
	Err    string `json:"error,omitempty"` // the game's text could not be read
}

// record is what the index keeps per game: the headers the list shows and
// where the game is in the file, but not its moves, which Read fetches when
// needed. Header values are interned, since files repeat names and events.
type record struct {
	white, black, event, date, round, result string
	offset                                   int64 // start of the chunk holding the game
	length                                   int32 // length of that chunk
	plies                                    int32
	sub                                      int32 // which game within the chunk
}

// Collection is an indexed PGN file of any size.
type Collection struct {
	Path    string
	records []record
	errs    map[int]string // games whose text could not be read
	size    int64
	modTime time.Time
}

// Len is the number of games in the file.
func (c *Collection) Len() int { return len(c.records) }

// Entry returns the list entry for game i.
func (c *Collection) Entry(i int) Entry {
	r := &c.records[i]
	return Entry{Index: i, White: r.white, Black: r.black, Result: r.result, Date: r.date,
		Event: r.event, Round: r.round, Plies: int(r.plies), Err: c.errs[i]}
}

// Find returns the games whose headers contain every word (case-insensitive),
// at most limit of them (all if limit <= 0), and how many match in total.
func (c *Collection) Find(words []string, limit int) (matched int, found []Entry) {
	lower := make([]string, len(words))
	for i, w := range words {
		lower[i] = strings.ToLower(w)
	}
	found = []Entry{}
	for i := range c.records {
		r := &c.records[i]
		ok := true
		for _, w := range lower {
			if !containsFold(r.white, w) && !containsFold(r.black, w) && !containsFold(r.event, w) &&
				!containsFold(r.date, w) && !containsFold(r.round, w) && !containsFold(r.result, w) {
				ok = false
				break
			}
		}
		if !ok {
			continue
		}
		matched++
		if limit <= 0 || len(found) < limit {
			found = append(found, c.Entry(i))
		}
	}
	return matched, found
}

// containsFold reports whether s contains the lower-case word w, ignoring
// case, without allocating for ASCII text.
func containsFold(s, w string) bool {
	if len(w) > len(s) {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] >= utf8.RuneSelf {
			return strings.Contains(strings.ToLower(s), w)
		}
	}
	for i := 0; i+len(w) <= len(s); i++ {
		j := 0
		for j < len(w) {
			c := s[i+j]
			if 'A' <= c && c <= 'Z' {
				c += 'a' - 'A'
			}
			if c != w[j] {
				break
			}
			j++
		}
		if j == len(w) {
			return true
		}
	}
	return false
}

// Open indexes the PGN file at path. progress, if not nil, is called now and
// then with the bytes read so far and the file size.
func Open(path string, progress func(done, total int64)) (*Collection, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	report := func(int64) {}
	if progress != nil {
		var last time.Time
		report = func(done int64) {
			if now := time.Now(); now.Sub(last) >= 150*time.Millisecond {
				last = now
				progress(done, info.Size())
			}
		}
	}
	c := &Collection{Path: path, errs: map[int]string{}, size: info.Size(), modTime: info.ModTime()}
	// Collect garbage less often while indexing: it is mostly short-lived.
	defer debug.SetGCPercent(debug.SetGCPercent(400))
	if err := c.index(f, report); err != nil {
		return nil, err
	}
	// Indexing makes a lot of short-lived garbage; give the memory back.
	debug.FreeOSMemory()
	return c, nil
}

// Read returns game i, re-read from the file.
func (c *Collection) Read(i int) (Game, error) {
	if i < 0 || i >= len(c.records) {
		return Game{}, fmt.Errorf("no game %d in the file", i+1)
	}
	if msg := c.errs[i]; msg != "" {
		return Game{}, errors.New(msg)
	}
	r := c.records[i]
	f, err := os.Open(c.Path)
	if err != nil {
		return Game{}, err
	}
	defer f.Close()
	if info, err := f.Stat(); err != nil || info.Size() != c.size || !info.ModTime().Equal(c.modTime) {
		return Game{}, errors.New("the file has changed since it was opened; open it again")
	}
	buf := make([]byte, r.length)
	if _, err := f.ReadAt(buf, r.offset); err != nil {
		return Game{}, err
	}
	games, _ := Parse(string(buf))
	if int(r.sub) >= len(games) {
		return Game{}, errors.New("the game could not be read from the file")
	}
	return games[r.sub], nil
}

// A chunk of the file: usually one game, split at lines that start a tag
// section after movetext.
type chunk struct {
	seq    int
	offset int64
	text   []byte
}

type chunkResult struct {
	records []record
	err     string // applies to the chunk's last record
}

// index reads the file once. One goroutine splits it into chunks; workers
// scan the chunks in parallel; results are put back in file order.
func (c *Collection) index(r io.Reader, progress func(int64)) error {
	workers := runtime.NumCPU()
	chunks := make(chan chunk, workers*16)
	var (
		mu      sync.Mutex
		results []chunkResult // by chunk sequence number
		wg      sync.WaitGroup
	)
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			in := newInterner()
			for ch := range chunks {
				res := scanChunk(ch, in)
				mu.Lock()
				for len(results) <= ch.seq {
					results = append(results, chunkResult{})
				}
				results[ch.seq] = res
				mu.Unlock()
			}
		}()
	}
	err := split(r, progress, chunks)
	close(chunks)
	wg.Wait()
	if err != nil {
		return err
	}

	// Concatenate in order, interning once more across workers so that each
	// distinct value is stored once.
	in := newInterner()
	n := 0
	for _, res := range results {
		n += len(res.records)
	}
	c.records = make([]record, 0, n)
	for _, res := range results {
		for _, rec := range res.records {
			rec.white, rec.black, rec.event = in.get(rec.white), in.get(rec.black), in.get(rec.event)
			rec.date, rec.round, rec.result = in.get(rec.date), in.get(rec.round), in.get(rec.result)
			c.records = append(c.records, rec)
		}
		if res.err != "" {
			c.errs[len(c.records)-1] = res.err
		}
	}
	return nil
}

// split reads lines and sends chunks to the workers.
func split(r io.Reader, progress func(int64), out chan<- chunk) error {
	br := bufio.NewReaderSize(r, 1<<20)
	var (
		buf       []byte
		start     int64
		pos       int64
		seq       int
		inComment bool // inside a { } comment, which may span lines
		sawMoves  bool // the chunk has movetext
	)
	send := func() {
		if len(bytes.TrimSpace(buf)) > 0 {
			out <- chunk{seq: seq, offset: start, text: buf}
			seq++
			buf = nil
		} else {
			buf = buf[:0]
		}
		sawMoves = false
	}
	for {
		line, err := br.ReadSlice('\n')
		if err == bufio.ErrBufferFull {
			// A very long line: gather the rest of it.
			long := append([]byte(nil), line...)
			for err == bufio.ErrBufferFull {
				line, err = br.ReadSlice('\n')
				long = append(long, line...)
			}
			line = long
		}
		if len(line) > 0 {
			body := bytes.TrimLeft(line, " \t\r")
			if pos == 0 {
				body = bytes.TrimPrefix(body, []byte("\xef\xbb\xbf"))
			}
			if !inComment && sawMoves && len(body) > 0 && body[0] == '[' {
				send()
			}
			if len(buf) == 0 {
				start = pos
			}
			buf = append(buf, line...)
			pos += int64(len(line))
			if !inComment && len(bytes.TrimSpace(body)) > 0 && body[0] != '[' && body[0] != '%' {
				sawMoves = true
			}
			for _, ch := range body {
				if inComment {
					inComment = ch != '}'
				} else if ch == '{' {
					inComment = true
				} else if ch == ';' {
					break
				}
			}
			progress(pos)
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
	}
	send()
	return nil
}

// scanChunk indexes the games in one chunk without keeping their moves.
func scanChunk(ch chunk, in *interner) chunkResult {
	var res chunkResult
	cur := record{offset: ch.offset, length: int32(len(ch.text))}
	resultToken := ""
	// The chunk is never changed after it is sent, so it can be read as a
	// string without a copy. Nothing kept refers to it: values are interned.
	err := scan(unsafe.String(unsafe.SliceData(ch.text), len(ch.text)), visitor{
		tag: func(t Tag) {
			switch t.Name {
			case "White":
				cur.white = in.get(t.Value)
			case "Black":
				cur.black = in.get(t.Value)
			case "Event":
				cur.event = in.get(t.Value)
			case "Date":
				cur.date = in.get(t.Value)
			case "Round":
				cur.round = in.get(t.Value)
			case "Result":
				cur.result = in.get(t.Value)
			}
		},
		move:   func(string) { cur.plies++ },
		result: func(r string) { resultToken = r },
		end: func() {
			if cur.result == "" {
				cur.result = in.get(resultToken)
			}
			res.records = append(res.records, cur)
			cur = record{offset: ch.offset, length: int32(len(ch.text)), sub: cur.sub + 1}
			resultToken = ""
		},
	})
	if err != nil {
		if len(res.records) == 0 {
			res.records = append(res.records, cur)
		}
		res.err = "unreadable game: " + err.Error()
	}
	return res
}

// interner stores each distinct string once. Values are copied, so they do
// not keep the chunk they came from in memory.
type interner struct{ m map[string]string }

func newInterner() *interner { return &interner{m: map[string]string{}} }

func (in *interner) get(s string) string {
	if s == "" {
		return ""
	}
	if v, ok := in.m[s]; ok {
		return v
	}
	v := strings.Clone(s)
	in.m[v] = v
	return v
}
