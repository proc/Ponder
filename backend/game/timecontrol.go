package game

import (
	"errors"
	"fmt"
	"strings"
)

// Stage is one period of a clock time control: Moves moves in BaseMs
// (Moves == 0 means "the rest of the game"), plus IncMs added after each move.
type Stage struct {
	Moves  int   `json:"moves"`
	BaseMs int64 `json:"baseMs"`
	IncMs  int64 `json:"incMs"`
}

// TimeControl describes how one side's thinking time is limited.
//
//	clock    - one or more stages, e.g. 40 moves in 90 min, then 30 min, +30 s/move
//	movetime - a fixed amount of time for every move
//	depth    - engine searches to a fixed depth (engines only)
//	none     - untimed (humans only)
type TimeControl struct {
	Kind       string  `json:"kind"`
	Stages     []Stage `json:"stages,omitempty"`
	MoveTimeMs int64   `json:"moveTimeMs,omitempty"`
	Depth      int     `json:"depth,omitempty"`
}

func (tc TimeControl) Validate(engine bool) error {
	switch tc.Kind {
	case "clock":
		if len(tc.Stages) == 0 {
			return errors.New("a clock time control needs at least one stage")
		}
		for i, s := range tc.Stages {
			if s.BaseMs < 0 || s.IncMs < 0 || s.Moves < 0 {
				return errors.New("time control values cannot be negative")
			}
			if s.BaseMs == 0 && s.IncMs == 0 {
				return errors.New("a time control stage needs base time or an increment")
			}
			if s.Moves == 0 && i != len(tc.Stages)-1 {
				return errors.New("only the last stage can cover the rest of the game")
			}
		}
	case "movetime":
		if tc.MoveTimeMs <= 0 {
			return errors.New("time per move must be positive")
		}
	case "depth":
		if !engine {
			return errors.New("a fixed-depth limit only applies to engines")
		}
		if tc.Depth <= 0 {
			return errors.New("search depth must be positive")
		}
	case "none":
		if engine {
			return errors.New("an engine needs a time control")
		}
	default:
		return fmt.Errorf("unknown time control kind %q", tc.Kind)
	}
	return nil
}

// PGN renders the control in PGN TimeControl tag syntax.
func (tc TimeControl) PGN() string {
	switch tc.Kind {
	case "clock":
		parts := make([]string, len(tc.Stages))
		for i, s := range tc.Stages {
			p := fmt.Sprint(s.BaseMs / 1000)
			if s.Moves > 0 {
				p = fmt.Sprintf("%d/%s", s.Moves, p)
			}
			if s.IncMs > 0 {
				p += fmt.Sprintf("+%g", float64(s.IncMs)/1000)
			}
			parts[i] = p
		}
		return strings.Join(parts, ":")
	case "movetime":
		return fmt.Sprintf("*%g", float64(tc.MoveTimeMs)/1000)
	case "none":
		return "-"
	}
	return "?"
}

// Clock tracks one side's remaining time through the stages of its control.
type Clock struct {
	tc           TimeControl
	RemainingMs  int64
	stage        int
	movesInStage int
}

func NewClock(tc TimeControl) *Clock {
	c := &Clock{tc: tc}
	switch tc.Kind {
	case "clock":
		c.RemainingMs = tc.Stages[0].BaseMs
		if c.RemainingMs == 0 { // increment-only control: start with one increment
			c.RemainingMs = tc.Stages[0].IncMs
		}
	case "movetime":
		c.RemainingMs = tc.MoveTimeMs
	}
	return c
}

// Timed reports whether the clock counts down at all.
func (c *Clock) Timed() bool {
	return c.tc.Kind == "clock" || c.tc.Kind == "movetime" || c.tc.Kind == "external"
}

func (c *Clock) cur() Stage { return c.tc.Stages[c.stage] }

// IncMs is the increment currently in force.
func (c *Clock) IncMs() int64 {
	if c.tc.Kind != "clock" {
		return 0
	}
	return c.cur().IncMs
}

// MovesToGo is the number of moves left to the next time control, or 0.
func (c *Clock) MovesToGo() int {
	if c.tc.Kind != "clock" || c.cur().Moves == 0 {
		return 0
	}
	return c.cur().Moves - c.movesInStage
}

// MoveDone charges elapsedMs for a completed move, then applies the
// increment and any stage change. The caller checks for a flag fall first.
func (c *Clock) MoveDone(elapsedMs int64) {
	switch c.tc.Kind {
	case "movetime":
		c.RemainingMs = c.tc.MoveTimeMs
	case "clock":
		c.RemainingMs -= elapsedMs
		if c.RemainingMs < 0 {
			c.RemainingMs = 0
		}
		s := c.cur()
		c.RemainingMs += s.IncMs
		c.movesInStage++
		if s.Moves > 0 && c.movesInStage >= s.Moves {
			// Next stage; a final stage with a move count repeats.
			if c.stage < len(c.tc.Stages)-1 {
				c.stage++
			}
			c.movesInStage = 0
			c.RemainingMs += c.cur().BaseMs
		}
	}
}
