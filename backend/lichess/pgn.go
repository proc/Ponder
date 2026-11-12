package lichess

import (
	"fmt"
	"time"

	"board/backend/game"
	"board/backend/pgn"
)

// pgnPlayer is a player as PGN tags record them.
type pgnPlayer struct {
	Name, Title string
	Rating      int
}

// gamePGN writes a finished Lichess game as PGN, with tags like Lichess's
// own export.
func gamePGN(rated bool, speed, site string, white, black pgnPlayer, initial, increment int64,
	startFEN string, moves []string, result, reason string, date time.Time) (string, error) {
	event := "Casual"
	if rated {
		event = "Rated"
	}
	if speed != "" {
		event += " " + speed
	}
	event += " game"
	tags := []pgn.Tag{
		{Name: "Event", Value: event}, {Name: "Site", Value: site},
		{Name: "Date", Value: date.Format("2006.01.02")}, {Name: "Round", Value: "-"},
		{Name: "White", Value: white.Name}, {Name: "Black", Value: black.Name},
		{Name: "Result", Value: result},
	}
	for _, p := range []struct {
		side string
		p    pgnPlayer
	}{{"White", white}, {"Black", black}} {
		if p.p.Title != "" {
			tags = append(tags, pgn.Tag{Name: p.side + "Title", Value: p.p.Title})
		}
		if p.p.Rating > 0 {
			tags = append(tags, pgn.Tag{Name: p.side + "Elo", Value: fmt.Sprint(p.p.Rating)})
		}
	}
	if initial > 0 || increment > 0 {
		tags = append(tags, pgn.Tag{Name: "TimeControl", Value: fmt.Sprintf("%d+%d", initial, increment)})
	}
	if reason != "" {
		tags = append(tags, pgn.Tag{Name: "Termination", Value: reason})
	}
	return game.FormatPGN(tags, startFEN, moves, result)
}
