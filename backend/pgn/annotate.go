package pgn

import (
	"strconv"
	"strings"

	"board/backend/chess"
)

// Note is what is written about one move: annotation glyphs (NAGs) and a
// comment.
type Note struct {
	NAGs    []int  `json:"nags,omitempty"`
	Comment string `json:"comment,omitempty"`
}

// VarNode is a move in a side variation. Children[0] continues the line;
// the others are alternatives to it.
type VarNode struct {
	UCI      string     `json:"uci"`
	SAN      string     `json:"san"`
	FEN      string     `json:"fen"`
	NAGs     []int      `json:"nags,omitempty"`
	Comment  string     `json:"comment,omitempty"`
	Children []*VarNode `json:"children"`
}

// Annotated is everything a game's movetext says beside its moves.
type Annotated struct {
	Before string       `json:"before,omitempty"` // the comment before the first move
	Moves  map[int]Note `json:"moves"`            // by ply, 1 for the first move
	// Variations by the ply they branch from: lines replacing move ply+1.
	Variations map[int][]*VarNode `json:"variations"`
}

// suffixNAG is the NAG of a mark written on the move itself.
var suffixNAG = map[string]int{"!": 1, "?": 2, "!!": 3, "??": 4, "!?": 5, "?!": 6}

type annNode struct {
	VarNode
	pos    chess.Position
	parent *annNode
	kids   []*annNode
}

// Annotations reads the comments, glyphs and variations of the first game
// in text. Moves that cannot be played end the line they are in; the rest
// is kept.
func Annotations(text string) (Annotated, error) {
	out := Annotated{Moves: map[int]Note{}, Variations: map[int][]*VarNode{}}
	games, err := Parse(text)
	if err != nil || len(games) == 0 {
		return out, err
	}
	start, _, err := games[0].Replay()
	if err != nil {
		return out, err
	}
	root := &annNode{pos: start}
	cur := root
	var stack []*annNode
	skip := 0      // depth of a variation being skipped
	pre := ""      // a comment before a variation's first move
	fresh := false // just after "("
	comment := func(c string) {
		c = strings.Join(strings.Fields(c), " ")
		if c == "" || skip > 0 {
			return
		}
		if fresh {
			pre = strings.TrimSpace(pre + " " + c)
			return
		}
		cur.Comment = strings.TrimSpace(cur.Comment + " " + c)
	}
	i, n := 0, len(text)
	// The tags come first.
	for i < n {
		for i < n && (text[i] == ' ' || text[i] == '\t' || text[i] == '\r' || text[i] == '\n') {
			i++
		}
		if i >= n || text[i] != '[' {
			break
		}
		for i < n && text[i] != '\n' {
			i++
		}
	}
loop:
	for i < n {
		c := text[i]
		switch {
		case c == ' ' || c == '\t' || c == '\r' || c == '\n':
			i++
		case c == ';':
			j := i
			for j < n && text[j] != '\n' {
				j++
			}
			comment(text[i+1 : j])
			i = j
		case c == '{':
			j := strings.IndexByte(text[i:], '}')
			if j < 0 {
				comment(text[i+1:])
				break loop
			}
			comment(text[i+1 : i+j])
			i += j + 1
		case c == '(':
			i++
			if skip > 0 || cur.parent == nil {
				skip++
				continue
			}
			stack = append(stack, cur)
			cur = cur.parent
			fresh, pre = true, ""
		case c == ')':
			i++
			if skip > 0 {
				skip--
				if skip > 0 {
					continue
				}
			}
			if len(stack) == 0 {
				continue
			}
			cur = stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			fresh, pre = false, ""
		case c == '[' || c == ']' || c == '}':
			i++
		default:
			j := i
			for j < n && !tokenEnd[text[j]] {
				j++
			}
			tok := text[i:j]
			i = j
			if skip > 0 {
				continue
			}
			if tok[0] == '$' {
				if v, err := strconv.Atoi(tok[1:]); err == nil && v > 0 && cur.parent != nil && !fresh {
					cur.NAGs = append(cur.NAGs, v)
				}
				continue
			}
			if tok == "1-0" || tok == "0-1" || tok == "1/2-1/2" || tok == "*" {
				if len(stack) == 0 {
					break loop
				}
				continue
			}
			san := cleanToken(tok)
			if san == "" {
				continue
			}
			mv, err := ParseMove(&cur.pos, san)
			if err != nil {
				if len(stack) == 0 {
					break loop // the game's own moves end here
				}
				// Leave the rest of this variation out.
				skip = 1
				continue
			}
			node := &annNode{parent: cur}
			node.UCI, node.SAN = mv.UCI(), cur.pos.SAN(mv)
			node.pos = cur.pos.Make(mv)
			node.FEN = node.pos.FEN()
			node.Comment, pre, fresh = pre, "", false
			marks := strings.TrimLeft(tok[strings.LastIndexAny(tok, "abcdefgh12345678O=QRBNqrbn+#")+1:], "+#")
			if v, ok := suffixNAG[marks]; ok {
				node.NAGs = append(node.NAGs, v)
			}
			cur.kids = append(cur.kids, node)
			cur = node
		}
	}
	// A variation left open by a skipped move still closes properly above;
	// what remains is to split the tree into the game's line and the rest.
	out.Before = root.Comment
	ply := 0
	for at := root; len(at.kids) > 0; at = at.kids[0] {
		for _, alt := range at.kids[1:] {
			out.Variations[ply] = append(out.Variations[ply], export(alt))
		}
		ply++
		m := at.kids[0]
		if len(m.NAGs) > 0 || m.Comment != "" {
			out.Moves[ply] = Note{NAGs: m.NAGs, Comment: m.Comment}
		}
	}
	return out, nil
}

func export(n *annNode) *VarNode {
	v := n.VarNode
	v.Children = []*VarNode{}
	for _, k := range n.kids {
		v.Children = append(v.Children, export(k))
	}
	return &v
}
