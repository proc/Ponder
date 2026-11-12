package main

import "strings"

// A small table of named openings, keyed by the moves from the start
// position. The engine reports the longest match as an "info string", the
// way engines with opening books do, so the GUI's opening display can be
// tried without installing another engine.
var openings = map[string]string{
	"e2e4":                          "B00 King's Pawn Opening",
	"e2e4 e7e5":                     "C20 King's Pawn Game",
	"e2e4 e7e5 g1f3":                "C40 King's Knight Opening",
	"e2e4 e7e5 g1f3 b8c6":           "C44 King's Knight Opening: Normal Variation",
	"e2e4 e7e5 g1f3 b8c6 f1b5":      "C60 Ruy Lopez",
	"e2e4 e7e5 g1f3 b8c6 f1b5 a7a6": "C68 Ruy Lopez: Morphy Defense",
	"e2e4 e7e5 g1f3 b8c6 f1c4":      "C50 Italian Game",
	"e2e4 e7e5 g1f3 b8c6 f1c4 f8c5": "C50 Italian Game: Giuoco Piano",
	"e2e4 e7e5 g1f3 b8c6 f1c4 g8f6": "C55 Italian Game: Two Knights Defense",
	"e2e4 e7e5 g1f3 b8c6 d2d4":      "C44 Scotch Game",
	"e2e4 e7e5 g1f3 g8f6":           "C42 Petrov's Defense",
	"e2e4 e7e5 f2f4":                "C30 King's Gambit",
	"e2e4 e7e5 b1c3":                "C25 Vienna Game",
	"e2e4 c7c5":                     "B20 Sicilian Defense",
	"e2e4 c7c5 g1f3":                "B27 Sicilian Defense",
	"e2e4 c7c5 g1f3 d7d6":           "B50 Sicilian Defense",
	"e2e4 c7c5 g1f3 b8c6":           "B30 Sicilian Defense: Old Sicilian",
	"e2e4 c7c5 g1f3 e7e6":           "B40 Sicilian Defense: French Variation",
	"e2e4 c7c5 b1c3":                "B23 Sicilian Defense: Closed",
	"e2e4 c7c5 c2c3":                "B22 Sicilian Defense: Alapin Variation",
	"e2e4 e7e6":                     "C00 French Defense",
	"e2e4 e7e6 d2d4 d7d5":           "C00 French Defense: Normal Variation",
	"e2e4 c7c6":                     "B10 Caro-Kann Defense",
	"e2e4 c7c6 d2d4 d7d5":           "B12 Caro-Kann Defense",
	"e2e4 d7d5":                     "B01 Scandinavian Defense",
	"e2e4 d7d6":                     "B07 Pirc Defense",
	"e2e4 g8f6":                     "B02 Alekhine Defense",
	"e2e4 g7g6":                     "B06 Modern Defense",
	"d2d4":                          "A40 Queen's Pawn Game",
	"d2d4 d7d5":                     "D00 Queen's Pawn Game",
	"d2d4 d7d5 c2c4":                "D06 Queen's Gambit",
	"d2d4 d7d5 c2c4 e7e6":           "D30 Queen's Gambit Declined",
	"d2d4 d7d5 c2c4 d5c4":           "D20 Queen's Gambit Accepted",
	"d2d4 d7d5 c2c4 c7c6":           "D10 Slav Defense",
	"d2d4 d7d5 c1f4":                "D00 London System",
	"d2d4 g8f6":                     "A45 Indian Defense",
	"d2d4 g8f6 c2c4":                "A50 Indian Defense: Normal Variation",
	"d2d4 g8f6 c2c4 g7g6":           "E60 King's Indian Defense",
	"d2d4 g8f6 c2c4 e7e6":           "E00 Indian Defense: East Indian Defense",
	"d2d4 g8f6 c2c4 e7e6 b1c3 f8b4": "E20 Nimzo-Indian Defense",
	"d2d4 g8f6 c1f4":                "A45 London System",
	"d2d4 f7f5":                     "A80 Dutch Defense",
	"c2c4":                          "A10 English Opening",
	"c2c4 e7e5":                     "A20 English Opening: King's English Variation",
	"c2c4 c7c5":                     "A30 English Opening: Symmetrical Variation",
	"g1f3":                          "A04 Zukertort Opening",
	"g1f3 d7d5":                     "A06 Zukertort Opening",
	"f2f4":                          "A02 Bird Opening",
	"b2b3":                          "A01 Nimzo-Larsen Attack",
	"g2g3":                          "A00 Hungarian Opening",
	"b1c3":                          "A00 Van Geet Opening",
	"a2a3":                          "A00 Anderssen's Opening",
	"h2h4":                          "A00 Kádas Opening",
	"g2g4":                          "A00 Grob Opening",
	"b2b4":                          "A00 Polish Opening",
	"f2f3":                          "A00 Barnes Opening",
	"d2d3":                          "A00 Mieses Opening",
	"e2e3":                          "A00 Van 't Kruijs Opening",
	"c2c3":                          "A00 Saragossa Opening",
	"a2a4":                          "A00 Ware Opening",
	"h2h3":                          "A00 Clemenz Opening",
	"b1a3":                          "A00 Durkin Opening",
	"g1h3":                          "A00 Amar Opening",
}

// openingFor returns the name of the longest known line that the game
// (played from the start position) begins with.
func openingFor(moves []string) string {
	for n := len(moves); n > 0; n-- {
		if name, ok := openings[strings.Join(moves[:n], " ")]; ok {
			return name
		}
	}
	return ""
}
