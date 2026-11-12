package game

import (
	"fmt"
	"strings"

	"board/backend/chess"
	"board/backend/pgn"
)

// FormatPGN writes a game played elsewhere (a Lichess game) as PGN: the
// tags given, the start position when it is not the standard one, the book
// opening, and the moves (UCI) as SAN.
func FormatPGN(tags []pgn.Tag, startFEN string, moves []string, result string) (string, error) {
	start, err := chess.ParseFEN(startFEN)
	if err != nil {
		return "", err
	}
	g := &current{start: start, pos: start, result: result}
	for _, u := range moves {
		mv, err := g.pos.ParseUCIMove(u)
		if err != nil {
			return "", fmt.Errorf("move %s: %w", u, err)
		}
		san := g.pos.SAN(mv)
		g.pos = g.pos.Make(mv)
		g.moves = append(g.moves, MoveRecord{UCI: mv.UCI(), SAN: san, Opening: bookOpening(&g.pos, g.bookSoFar())})
	}
	var b strings.Builder
	esc := strings.NewReplacer(`\`, `\\`, `"`, `\"`)
	has := map[string]bool{}
	for _, t := range tags {
		has[t.Name] = true
		fmt.Fprintf(&b, "[%s \"%s\"]\n", t.Name, esc.Replace(t.Value))
	}
	if !has["Result"] {
		fmt.Fprintf(&b, "[Result \"%s\"]\n", result)
	}
	if start.FEN() != chess.StartFEN && !has["FEN"] {
		fmt.Fprintf(&b, "[SetUp \"1\"]\n[FEN \"%s\"]\n", start.FEN())
	}
	if book := g.bookSoFar(); book != "" && !has["Opening"] {
		eco, name, _ := strings.Cut(book, " ")
		fmt.Fprintf(&b, "[ECO \"%s\"]\n[Opening \"%s\"]\n", eco, esc.Replace(name))
	}
	writeMovetext(&b, g)
	return b.String(), nil
}
