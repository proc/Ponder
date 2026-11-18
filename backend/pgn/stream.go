package pgn

import (
	"errors"
	"os"
	"strings"
)

// Commented is a game with the comments of its main line: Comments[i] is
// what follows move i ("" for none; several comments are joined by a space).
type Commented struct {
	Game
	Comments []string
}

// ParseCommented splits text into games, keeping main-line comments.
func ParseCommented(text string) ([]Commented, error) {
	var games []Commented
	var cur Commented
	err := scan(text, visitor{
		tag: func(t Tag) { cur.Tags = append(cur.Tags, t) },
		move: func(m string) {
			cur.Moves = append(cur.Moves, m)
			cur.Comments = append(cur.Comments, "")
		},
		result: func(r string) { cur.Result = r },
		comment: func(c string) {
			n := len(cur.Comments)
			if n == 0 {
				return // before the first move
			}
			c = strings.TrimSpace(c)
			if cur.Comments[n-1] != "" && c != "" {
				c = cur.Comments[n-1] + " " + c
			} else if c == "" {
				return
			}
			cur.Comments[n-1] = c
		},
		end: func() {
			games = append(games, cur)
			cur = Commented{}
		},
	})
	return games, err
}

// ErrStop, returned by Each's callback, ends the reading without an error.
var ErrStop = errors.New("stop")

// Each reads the PGN file at path a game at a time, in file order, with
// main-line comments, calling fn for each. progress, if not nil, gets the
// bytes read so far and the file size now and then. A game that cannot be
// read (an unclosed comment, say) is passed with what was read of it.
func Each(path string, progress func(done, total int64), fn func(Commented) error) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return err
	}
	size := info.Size()
	out := make(chan chunk, 16)
	splitErr := make(chan error, 1)
	go func() {
		splitErr <- split(f, func(int64) {}, out)
		close(out)
	}()
	stop := func() {
		f.Close() // the splitter fails its next read and ends
		for range out {
		}
	}
	var last int64 = -1
	for ch := range out {
		if progress != nil && ch.offset != last {
			last = ch.offset
			progress(ch.offset+int64(len(ch.text)), size)
		}
		games, _ := ParseCommented(string(ch.text))
		for _, g := range games {
			if err := fn(g); err != nil {
				stop()
				if err == ErrStop {
					return nil
				}
				return err
			}
		}
	}
	if err := <-splitErr; err != nil {
		return err
	}
	if progress != nil {
		progress(size, size)
	}
	return nil
}
