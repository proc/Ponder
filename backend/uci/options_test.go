package uci

import (
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"
)

func TestPlanOptions(t *testing.T) {
	lo, hi := 1, 1024
	listed := []Option{
		{Name: "Threads", Type: "spin", Default: "1", Min: &lo, Max: &hi},
		{Name: "Hash", Type: "spin", Default: "16", Min: &lo, Max: &hi},
		{Name: "Clear Hash", Type: "button"},
		{Name: "Ponder", Type: "check", Default: "false"},
		{Name: "MultiPV", Type: "spin", Default: "1"},
		{Name: "UCI_LimitStrength", Type: "check", Default: "false"},
		{Name: "UCI_Elo", Type: "spin", Default: "1320"},
		{Name: "Style", Type: "combo", Default: "Normal", Vars: []string{"Solid", "Normal", "Risky"}},
		{Name: "SyzygyPath", Type: "string", Default: "<empty>"},
	}
	got := PlanOptions(listed, map[string]string{
		"hash": "4096", "UCI_Elo": "1800", "threads": " 8 ", "uci_limitstrength": "True", "Style": "risky",
		"SyzygyPath": "/tb", "MultiPV": "3", "Clear Hash": "", "Zeta": "1", "Alpha": "x", "Ponder": "true",
	}, "multipv", "Ponder")
	want := []OptionSetting{
		{"Threads", "8"}, {"Hash", "1024"}, {"UCI_LimitStrength", "true"}, {"UCI_Elo", "1800"}, {"Style", "Risky"},
		{"SyzygyPath", "/tb"}, {"Alpha", "x"}, {"Zeta", "1"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got  %v\nwant %v", got, want)
	}
	// Values that cannot be right are left to the engine's own.
	got = PlanOptions(listed, map[string]string{"Hash": "lots", "Style": "Wild", "Threads": "0"})
	if want := []OptionSetting{{"Threads", "1"}}; !reflect.DeepEqual(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}
}

// The options reach the engine as it is loaded: after uciok, in the
// engine's order, and before anything else is asked of it.
func TestApplyOptionsAtLoad(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("needs a shell")
	}
	dir := t.TempDir()
	log := filepath.Join(dir, "log")
	script := filepath.Join(dir, "engine.sh")
	body := `#!/bin/sh
while read -r line; do
  echo "$line" >> "` + log + `"
  case "$line" in
    uci) echo "id name Scripted"; echo "option name Threads type spin default 1 min 1 max 64"; echo "option name Hash type spin default 16 min 1 max 4096"; echo "uciok";;
    isready) echo "readyok";;
    quit) exit 0;;
  esac
done
`
	if err := os.WriteFile(script, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	e, err := Start(script, nil, Handlers{})
	if err != nil {
		t.Fatal(err)
	}
	if err := e.ApplyOptions(map[string]string{"hash": "256", "Threads": "4"}); err != nil {
		t.Fatal(err)
	}
	if err := e.NewGame(); err != nil {
		t.Fatal(err)
	}
	e.Quit()
	<-e.Done()
	got, _ := os.ReadFile(log)
	want := "uci\nsetoption name Threads value 4\nsetoption name Hash value 256\nisready\nucinewgame\nisready\nstop\nquit\n"
	if string(got) != want {
		t.Errorf("the engine was sent:\n%s\nwant:\n%s", got, want)
	}
}
