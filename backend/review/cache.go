package review

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// Cache remembers the positions analysed, so that no position is searched
// twice: not when a stopped analysis is started again, not when moves are
// added at the end, nor when a move is changed (the positions before it,
// and any the new line shares, are the same).
//
// A position is the same when its board, side to move, castling and en
// passant are (the move counters are left out), and when the engine is: the
// same program file (path, size and time it was changed), arguments and
// options. An earlier result counts only if it had at least as much time a
// move as is asked for now; a longer search replaces a shorter one.
//
// It is kept in a file, so it outlasts the app, and holds at most
// cacheMax positions, the ones used least lately going first.
type Cache struct {
	save  sync.Mutex // one write of the file at a time
	mu    sync.Mutex
	m     map[string]cacheEntry // engine key + "\n" + position key
	names map[string]string     // engine key → the engine's name
	file  string
	dirty bool
}

// cacheFile is the file's form.
type cacheFile struct {
	Names     map[string]string     `json:"names"`
	Positions map[string]cacheEntry `json:"positions"`
}

type cacheEntry struct {
	Pos        Position `json:"p"`
	MoveTimeMs int      `json:"ms"`
	Used       int64    `json:"u"` // unix seconds
}

const cacheMax = 50000

func newCache() *Cache { return &Cache{m: map[string]cacheEntry{}, names: map[string]string{}} }

// Load reads the cache file, if there is one; one that cannot be read is
// started afresh.
func (c *Cache) Load(file string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.file = file
	if file == "" {
		return
	}
	b, err := os.ReadFile(file)
	if err != nil {
		return
	}
	var f cacheFile
	if json.Unmarshal(b, &f) != nil {
		return
	}
	for k, e := range f.Positions {
		if _, ok := c.m[k]; !ok {
			c.m[k] = e
		}
	}
	for k, n := range f.Names {
		if _, ok := c.names[k]; !ok {
			c.names[k] = n
		}
	}
}

// Save writes the cache file, if anything changed.
func (c *Cache) Save() error {
	c.save.Lock()
	defer c.save.Unlock()
	c.mu.Lock()
	if c.file == "" || !c.dirty {
		c.mu.Unlock()
		return nil
	}
	c.trim()
	b, err := json.Marshal(cacheFile{Names: c.names, Positions: c.m})
	c.dirty = false
	file := c.file
	c.mu.Unlock()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		return err
	}
	tmp := file + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, file)
}

// trim drops the positions used least lately beyond cacheMax. c.mu is held.
func (c *Cache) trim() {
	if len(c.m) <= cacheMax {
		return
	}
	keys := make([]string, 0, len(c.m))
	for k := range c.m {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool { return c.m[keys[i]].Used < c.m[keys[j]].Used })
	for _, k := range keys[:len(keys)-cacheMax] {
		delete(c.m, k)
	}
}

// Get is the position analysed before with this engine, if it had at least
// moveTimeMs.
func (c *Cache) Get(engine, fen string, moveTimeMs int) (Position, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	k := engine + "\n" + positionKey(fen)
	e, ok := c.m[k]
	if !ok || e.MoveTimeMs < moveTimeMs {
		return Position{}, false
	}
	e.Used = time.Now().Unix()
	c.m[k] = e
	return e.Pos, true
}

// Put keeps a position analysed, unless one searched longer is there. name
// is the engine's, as the person knows it.
func (c *Cache) Put(engine, name, fen string, moveTimeMs int, p Position) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if name != "" && c.names[engine] != name {
		c.names[engine] = name
		c.dirty = true
	}
	k := engine + "\n" + positionKey(fen)
	if e, ok := c.m[k]; ok && e.MoveTimeMs > moveTimeMs {
		return
	}
	c.m[k] = cacheEntry{Pos: p, MoveTimeMs: moveTimeMs, Used: time.Now().Unix()}
	c.dirty = true
}

// positionKey is a FEN without its move counters.
func positionKey(fen string) string {
	f := strings.Fields(fen)
	if len(f) > 4 {
		f = f[:4]
	}
	return strings.Join(f, " ")
}

// engineKey tells engines apart: the program (and the build of it, by size
// and time changed), its arguments and its options.
func engineKey(e Engine) string {
	stamp := ""
	if st, err := os.Stat(e.Path); err == nil {
		stamp = fmt.Sprintf("%d@%d", st.Size(), st.ModTime().UnixNano())
	}
	args, _ := json.Marshal(e.Args)
	opts, _ := json.Marshal(e.Options) // keys in order
	return e.Path + "|" + stamp + "|" + string(args) + "|" + string(opts)
}

// Covered is the name of an engine that has analysed every one of the
// positions (with any time a move), or "" if none has. Positions are FENs.
func (c *Cache) Covered(fens []string) string {
	if len(fens) == 0 {
		return ""
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	keys := make([]string, len(fens))
	for i, f := range fens {
		keys[i] = positionKey(f)
	}
	var best string
	for engine, name := range c.names {
		all := true
		for _, k := range keys {
			if _, ok := c.m[engine+"\n"+k]; !ok {
				all = false
				break
			}
		}
		// Of several, the same one each time.
		if all && (best == "" || name < best) {
			best = name
		}
	}
	return best
}
