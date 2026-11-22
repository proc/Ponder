package pgn

import (
	"strconv"
	"strings"
)

// speed is how fast a game was played, as Lichess names its speeds.
type speed uint8

const (
	none speed = iota
	ultraBullet
	bullet
	blitz
	rapid
	classical
	correspondence
)

var speedNames = []string{"", "ultrabullet", "bullet", "blitz", "rapid", "classical", "correspondence"}

func speedNamed(s string) speed {
	if s == "daily" {
		return correspondence
	}
	for i, n := range speedNames {
		if i > 0 && n == s {
			return speed(i)
		}
	}
	return none
}

// speedOf works out a game's speed from its TimeControl header ("180+2",
// "40/7200:3600", "-"), as Lichess does: the time for 40 moves, base plus
// 40 increments. Without a time control that says, the event may name the
// speed ("Rated Blitz game").
func speedOf(event, tc string) speed {
	if s := speedOfClock(strings.TrimSpace(tc)); s != none {
		return s
	}
	e := strings.ToLower(event)
	switch {
	case strings.Contains(e, "ultrabullet"):
		return ultraBullet
	case strings.Contains(e, "bullet"):
		return bullet
	case strings.Contains(e, "blitz"):
		return blitz
	case strings.Contains(e, "rapid"):
		return rapid
	case strings.Contains(e, "classical"):
		return classical
	case strings.Contains(e, "correspondence"), strings.Contains(e, "daily"):
		return correspondence
	}
	return none
}

func speedOfClock(tc string) speed {
	if tc == "-" {
		return correspondence
	}
	stage, _, _ := strings.Cut(tc, ":")
	if _, t, ok := strings.Cut(stage, "/"); ok {
		stage = t // moves/seconds: the seconds
	}
	baseText, incText, _ := strings.Cut(stage, "+")
	base, err := strconv.ParseFloat(baseText, 64)
	if err != nil || base < 0 {
		return none
	}
	inc := 0.0
	if incText != "" {
		if inc, err = strconv.ParseFloat(incText, 64); err != nil || inc < 0 {
			return none
		}
	}
	switch t := base + 40*inc; {
	case t == 0:
		return none
	case t < 30:
		return ultraBullet
	case t < 180:
		return bullet
	case t < 480:
		return blitz
	case t < 1500:
		return rapid
	}
	return classical
}

// rating is whether a game was rated, as far as its event says.
type rating uint8

const (
	unrated rating = iota // not said
	rated
	casual
)

func ratedOf(event string) rating {
	e := strings.ToLower(strings.TrimSpace(event))
	switch {
	case strings.HasPrefix(e, "rated"), strings.Contains(e, " rated "):
		return rated
	case strings.HasPrefix(e, "casual"), strings.Contains(e, " casual "):
		return casual
	}
	return unrated
}

// ecoCode is an ECO header ("b90") as the three bytes "B90", or zeros if
// it is not one.
func ecoCode(s string) [3]byte {
	s = strings.ToUpper(strings.TrimSpace(s))
	if len(s) != 3 || s[0] < 'A' || s[0] > 'E' || s[1] < '0' || s[1] > '9' || s[2] < '0' || s[2] > '9' {
		return [3]byte{}
	}
	return [3]byte{s[0], s[1], s[2]}
}

// openingTerm is one opening asked for: ECO codes from lo to hi (as far as
// each is written: "B9" is B90 to B99), or text in the Opening header.
type openingTerm struct {
	lo, hi string
	name   string
}

func isEcoPrefix(s string) bool {
	if len(s) < 1 || len(s) > 3 || s[0] < 'A' || s[0] > 'E' {
		return false
	}
	for i := 1; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

func parseOpening(s string) (openingTerm, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return openingTerm{}, false
	}
	up := strings.ToUpper(strings.ReplaceAll(s, " ", ""))
	up = strings.NewReplacer("–", "-", "—", "-").Replace(up)
	if lo, hi, ok := strings.Cut(up, "-"); ok && isEcoPrefix(lo) && isEcoPrefix(hi) {
		if hi < lo {
			lo, hi = hi, lo
		}
		return openingTerm{lo: lo, hi: hi}, true
	}
	if isEcoPrefix(up) {
		return openingTerm{lo: up, hi: up}, true
	}
	return openingTerm{name: strings.ToLower(s)}, true
}

func (t openingTerm) match(r *record) bool {
	if t.name != "" {
		return containsFold(r.opening, t.name)
	}
	if r.eco[0] == 0 {
		return false
	}
	code := string(r.eco[:])
	return prefixCompare(code, t.lo) >= 0 && prefixCompare(code, t.hi) <= 0
}
