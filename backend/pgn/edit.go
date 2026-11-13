package pgn

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// Changing a PGN file: games are deleted or replaced by writing the file
// again beside itself and putting it in place of the old one, so a failure
// part-way leaves the file as it was. The Collection is out of date after;
// Open the file again.

// Changed reports whether the file is no longer the one that was indexed
// (games were added, or it was replaced or removed).
func (c *Collection) Changed() bool {
	info, err := os.Stat(c.Path)
	return err != nil || info.Size() != c.size || !info.ModTime().Equal(c.modTime)
}

// alone reports whether game i has its stretch of the file to itself. Games
// that run into each other with no tags between them share one, and cannot
// be changed one at a time.
func (c *Collection) alone(i int) bool {
	off := c.records[i].offset
	return (i == 0 || c.records[i-1].offset != off) && (i+1 == len(c.records) || c.records[i+1].offset != off)
}

func (c *Collection) open() (*os.File, error) {
	f, err := os.Open(c.Path)
	if err != nil {
		return nil, err
	}
	if info, err := f.Stat(); err != nil || info.Size() != c.size || !info.ModTime().Equal(c.modTime) {
		f.Close()
		return nil, errors.New("the file has changed since it was opened; open it again")
	}
	return f, nil
}

// Raw is the text of game i as it stands in the file.
func (c *Collection) Raw(i int) (string, error) {
	if i < 0 || i >= len(c.records) {
		return "", fmt.Errorf("no game %d in the file", i+1)
	}
	f, err := c.open()
	if err != nil {
		return "", err
	}
	defer f.Close()
	r := c.records[i]
	buf := make([]byte, r.length)
	if _, err := f.ReadAt(buf, r.offset); err != nil {
		return "", err
	}
	return string(buf), nil
}

// Export writes the games at indices (in file order) to w, a blank line
// between them, and returns how many were written.
func (c *Collection) Export(w io.Writer, indices []int) (int, error) {
	f, err := c.open()
	if err != nil {
		return 0, err
	}
	defer f.Close()
	n := 0
	last := int64(-1)
	for _, i := range indices {
		if i < 0 || i >= len(c.records) {
			continue
		}
		r := c.records[i]
		n++
		if r.offset == last {
			continue // written with the game it shares its text with
		}
		last = r.offset
		buf := make([]byte, r.length)
		if _, err := f.ReadAt(buf, r.offset); err != nil {
			return n, err
		}
		text := strings.TrimPrefix(string(buf), "\xef\xbb\xbf")
		if _, err := io.WriteString(w, strings.TrimRight(text, " \t\r\n")+"\n\n"); err != nil {
			return n, err
		}
	}
	return n, nil
}

// Rewrite writes the file again with the games in edits changed: a nil
// entry deletes the game, anything else is its new text.
func (c *Collection) Rewrite(edits map[int]*string) error {
	for i := range edits {
		if i < 0 || i >= len(c.records) {
			return fmt.Errorf("no game %d in the file", i+1)
		}
		if !c.alone(i) {
			return fmt.Errorf("game %d runs into the next one in the file (no tags between them), so it cannot be changed here", i+1)
		}
	}
	src, err := c.open()
	if err != nil {
		return err
	}
	defer src.Close()
	mode := os.FileMode(0o644)
	if info, err := src.Stat(); err == nil {
		mode = info.Mode().Perm()
	}
	tmp, err := os.CreateTemp(filepath.Dir(c.Path), "."+filepath.Base(c.Path)+".*.tmp")
	if err != nil {
		return err
	}
	done := false
	defer func() {
		if !done {
			tmp.Close()
			os.Remove(tmp.Name())
		}
	}()
	pos := int64(0)
	copyTo := func(end int64) error {
		if end > pos {
			if _, err := io.Copy(tmp, io.NewSectionReader(src, pos, end-pos)); err != nil {
				return err
			}
		}
		pos = end
		return nil
	}
	for i, r := range c.records {
		text, ok := edits[i]
		if !ok {
			continue
		}
		if err := copyTo(r.offset); err != nil {
			return err
		}
		pos = r.offset + int64(r.length) // the old text is left out
		if text != nil {
			if _, err := io.WriteString(tmp, *text); err != nil {
				return err
			}
		}
	}
	if err := copyTo(c.size); err != nil {
		return err
	}
	if err := tmp.Chmod(mode); err != nil {
		return err
	}
	if err := tmp.Sync(); err != nil {
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp.Name(), c.Path); err != nil {
		return err
	}
	done = true
	return nil
}

var (
	tagName     = regexp.MustCompile(`^[A-Za-z0-9_]+$`)
	resultToken = regexp.MustCompile(`(^|[\s}])(1-0|0-1|1/2-1/2|\*)(\s*)$`)
	escapeTag   = strings.NewReplacer(`\`, `\\`, `"`, `\"`)
	// The tags every game has, and what stands for "not known".
	rosterBlank = map[string]string{"Event": "?", "Site": "?", "Date": "????.??.??", "Round": "?", "White": "?", "Black": "?", "Result": "*"}
)

// ValidResult reports whether s is one of PGN's four results.
func ValidResult(s string) bool {
	return s == "1-0" || s == "0-1" || s == "1/2-1/2" || s == "*"
}

func tagLine(name, value string) string {
	return "[" + name + ` "` + escapeTag.Replace(value) + `"]`
}

// SetTags changes tags in a game's text, leaving the rest as it is: a tag
// the game has gets the new value, one it lacks is added after the others,
// and an empty value takes the tag out (or, for the seven every game has,
// sets it to unknown). A new Result also replaces the result at the end of
// the moves.
func SetTags(text string, tags []Tag) (string, error) {
	want := map[string]string{}
	var order []string
	for _, t := range tags {
		name := strings.TrimSpace(t.Name)
		if !tagName.MatchString(name) {
			return "", fmt.Errorf("%q is not a tag name", t.Name)
		}
		value := strings.Join(strings.Fields(t.Value), " ")
		if name == "Result" && value != "" && !ValidResult(value) {
			return "", fmt.Errorf("the result must be 1-0, 0-1, 1/2-1/2 or *")
		}
		if value == "" {
			value = rosterBlank[name] // "" for a tag that can go
		}
		if _, dup := want[name]; !dup {
			order = append(order, name)
		}
		want[name] = value
	}

	lines := strings.SplitAfter(text, "\n")
	eol := "\n"
	if len(lines) > 0 && strings.HasSuffix(lines[0], "\r\n") {
		eol = "\r\n"
	}
	var out []string
	seen := map[string]bool{}
	end := 0 // where the tags end in out
	i := 0
	for ; i < len(lines); i++ {
		line := lines[i]
		body := strings.TrimSpace(strings.TrimPrefix(line, "\xef\xbb\xbf"))
		if body == "" || body[0] == '%' {
			out = append(out, line)
			continue
		}
		if body[0] != '[' || !strings.HasSuffix(body, "]") {
			break // the moves
		}
		tag, ok := parseTag(body[1 : len(body)-1])
		value, edit := want[tag.Name]
		switch {
		case !ok || !edit:
			out = append(out, line)
		case seen[tag.Name] || value == "":
			continue // dropped
		default:
			bom := ""
			if strings.HasPrefix(line, "\xef\xbb\xbf") {
				bom = "\xef\xbb\xbf"
			}
			out = append(out, bom+tagLine(tag.Name, value)+eol)
		}
		if ok {
			seen[tag.Name] = true
		}
		end = len(out)
	}
	var added []string
	for _, name := range order {
		if !seen[name] && want[name] != "" {
			added = append(added, tagLine(name, want[name])+eol)
		}
	}
	if len(added) > 0 {
		out = append(out[:end:end], append(added, out[end:]...)...)
		if end == 0 && i < len(lines) {
			// No tags before: a blank line parts them from the moves.
			out = append(out[:len(added):len(added)], append([]string{eol}, out[len(added):]...)...)
		}
	}
	moves := strings.Join(lines[i:], "")
	if result, ok := want["Result"]; ok && result != "" {
		if strings.TrimSpace(moves) == "" {
			moves = result + eol + eol
		} else if resultToken.MatchString(moves) {
			moves = resultToken.ReplaceAllString(moves, "${1}"+result+"${3}")
		} else {
			moves = strings.TrimRight(moves, " \t\r\n") + " " + result + eol + eol
		}
	}
	return strings.Join(out, "") + moves, nil
}
