package tournament

import "math"

// Stats are the results from the first engine's point of view.
type Stats struct {
	Wins, Losses, Draws int
	// Penta counts game pairs (same opening, colours reversed) by the
	// first engine's points in the pair: 0, ½, 1, 1½, 2.
	Penta [5]int
}

func (s Stats) Games() int { return s.Wins + s.Losses + s.Draws }
func (s Stats) Pairs() int { return s.Penta[0] + s.Penta[1] + s.Penta[2] + s.Penta[3] + s.Penta[4] }

// Score is the first engine's average points per game.
func (s Stats) Score() float64 {
	n := s.Games()
	if n == 0 {
		return 0.5
	}
	return (float64(s.Wins) + 0.5*float64(s.Draws)) / float64(n)
}

// eloOf is the logistic Elo difference for an expected score.
func eloOf(score float64) float64 {
	score = math.Min(math.Max(score, 1e-6), 1-1e-6)
	return -400 * math.Log10(1/score-1)
}

// scoreOf is the expected score for a logistic Elo difference.
func scoreOf(elo float64) float64 { return 1 / (1 + math.Pow(10, -elo/400)) }

// pairMoments are the mean and variance of the pair score (0…1 in steps of
// ¼), with prior added to every bucket. Empty buckets get at least a tiny
// count so the variance is never zero.
func (s Stats) pairMoments(prior float64) (mean, variance float64, n float64) {
	var counts [5]float64
	for i, c := range s.Penta {
		counts[i] = float64(c) + prior
		if counts[i] == 0 {
			counts[i] = 1e-3
		}
		n += counts[i]
	}
	for i, c := range counts {
		mean += c / n * float64(i) / 4
	}
	for i, c := range counts {
		d := float64(i)/4 - mean
		variance += c / n * d * d
	}
	return mean, variance, n
}

// Elo is the Elo difference with the half-width of its 95% confidence
// interval, and the likelihood that the first engine is stronger. With
// pairs, it uses their variance (it is lower than that of single games
// when openings are unbalanced); before the first pair, the games'.
func (s Stats) Elo() (elo, margin, los float64) {
	if s.Games() == 0 {
		return 0, 0, 0.5
	}
	var mean, sd float64
	if s.Pairs() > 0 {
		m, v, n := s.pairMoments(0)
		mean, sd = m, math.Sqrt(v/n)
	} else {
		n := float64(s.Games())
		mean = s.Score()
		w, d, l := float64(s.Wins)/n, float64(s.Draws)/n, float64(s.Losses)/n
		v := w*(1-mean)*(1-mean) + d*(0.5-mean)*(0.5-mean) + l*mean*mean
		sd = math.Sqrt(v / n)
	}
	elo = eloOf(mean)
	lo, hi := eloOf(mean-1.959964*sd), eloOf(mean+1.959964*sd)
	margin = (hi - lo) / 2
	if sd > 0 {
		los = 0.5 * (1 + math.Erf((mean-0.5)/sd/math.Sqrt2))
	} else {
		los = 0.5
	}
	return elo, margin, los
}

// LLR is the log-likelihood ratio of H1 (Elo = elo1) against H0 (Elo =
// elo0) for logistic Elo, from the pair results: the generalized SPRT
// approximation N·(s1−s0)·(2μ−s0−s1)/(2σ²), as used by fishtest. Half a
// pair is added to each outcome: without it, a handful of pairs that all
// went the same way have almost no variance, and the test would stop on
// them. Over the thousands of pairs of a real test it makes no difference.
func (s Stats) LLR(elo0, elo1 float64) float64 {
	if s.Pairs() == 0 {
		return 0
	}
	mean, variance, n := s.pairMoments(0.5)
	s0, s1 := scoreOf(elo0), scoreOf(elo1)
	return n * (s1 - s0) * (2*mean - s0 - s1) / (2 * variance)
}

// Bounds are the LLR at which H0 (lower) or H1 (upper) is accepted.
func Bounds(alpha, beta float64) (lower, upper float64) {
	return math.Log(beta / (1 - alpha)), math.Log((1 - beta) / alpha)
}
