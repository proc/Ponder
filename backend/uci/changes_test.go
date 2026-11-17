package uci

import (
	"reflect"
	"testing"
)

func TestOptionChanges(t *testing.T) {
	lo, hi := 1, 1024
	e := &Engine{Options: []Option{
		{Name: "Hash", Type: "spin", Default: "16", Min: &lo, Max: &hi},
		{Name: "Threads", Type: "spin", Default: "1", Min: &lo, Max: &hi},
		{Name: "Ponder", Type: "check", Default: "false"},
		{Name: "Clear Hash", Type: "button"},
	}}
	e.Applied = PlanOptions(e.Options, map[string]string{"Hash": "64", "Threads": "4"})
	// Threads unchanged; Hash changed; Ponder skipped.
	got := e.OptionChanges(map[string]string{"Hash": "128", "Threads": "4", "Ponder": "true"}, "Ponder")
	if want := []OptionSetting{{"Hash", "128"}}; !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	// Threads reset: back to its default.
	got = e.OptionChanges(map[string]string{"Hash": "128"})
	if want := []OptionSetting{{"Threads", "1"}}; !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	// Nothing new: nothing to send.
	if got = e.OptionChanges(map[string]string{"Hash": "128"}); len(got) != 0 {
		t.Fatalf("got %v", got)
	}
	if cmds := OptionCommands([]OptionSetting{{"Hash", "32"}}); !reflect.DeepEqual(cmds, []string{"setoption name Hash value 32"}) {
		t.Fatalf("got %v", cmds)
	}
}
