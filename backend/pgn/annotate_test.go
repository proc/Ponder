package pgn

import (
	"reflect"
	"testing"
)

func TestAnnotations(t *testing.T) {
	text := `[Event "Test"]
[Result "1-0"]

{ A start. } 1. e4! { [%eval 0.3] Best by test. } e5 $14 (1... c5 { The Sicilian. } 2. Nf3 (2. c3 $5 d5) 2... d6?!)
(1... e6 2. d4) 2. Nf3 ; knight out
Nc6 ( { Or } 2... Nf6 3. Zz9 d6 ) (2... d6) 3. Bb5 $1 $16 1-0
`
	a, err := Annotations(text)
	if err != nil {
		t.Fatal(err)
	}
	if a.Before != "A start." {
		t.Errorf("before = %q", a.Before)
	}
	want := map[int]Note{
		1: {NAGs: []int{1}, Comment: "[%eval 0.3] Best by test."},
		2: {NAGs: []int{14}},
		3: {Comment: "knight out"},
		5: {NAGs: []int{1, 16}},
	}
	if !reflect.DeepEqual(a.Moves, want) {
		t.Errorf("moves = %+v", a.Moves)
	}
	v1 := a.Variations[1]
	if len(v1) != 2 || v1[0].SAN != "c5" || v1[0].Comment != "The Sicilian." || v1[1].SAN != "e6" {
		t.Fatalf("variations after move 1 = %+v", v1)
	}
	nf3 := v1[0].Children
	if len(nf3) != 2 || nf3[0].SAN != "Nf3" || nf3[1].SAN != "c3" || !reflect.DeepEqual(nf3[1].NAGs, []int{5}) {
		t.Fatalf("sub-lines = %+v", nf3)
	}
	if d6 := nf3[0].Children[0]; d6.SAN != "d6" || !reflect.DeepEqual(d6.NAGs, []int{6}) || d6.UCI != "d7d6" {
		t.Errorf("2...d6 = %+v", d6)
	}
	v3 := a.Variations[3]
	// The line with a move that cannot be played keeps what came before it.
	if len(v3) != 2 || v3[0].SAN != "Nf6" || v3[0].Comment != "Or" || len(v3[0].Children) != 0 || v3[1].SAN != "d6" {
		t.Fatalf("variations after move 3 = %+v", v3)
	}
}
