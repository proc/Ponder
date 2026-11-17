package uci

import (
	"strings"
	"testing"
)

func TestParseInfoWDL(t *testing.T) {
	in, ok := parseInfo(strings.Fields("info depth 20 seldepth 28 multipv 1 score cp 31 wdl 92 870 38 nodes 1000 pv e2e4 e7e5"))
	if !ok || !in.HasWDL || in.WDL != [3]int{92, 870, 38} {
		t.Fatalf("got %+v", in)
	}
	if in.ScoreCP != 31 || len(in.PV) != 2 || in.Nodes != 1000 {
		t.Fatalf("other fields lost: %+v", in)
	}
	in, _ = parseInfo(strings.Fields("info depth 3 score cp 10 pv e2e4"))
	if in.HasWDL {
		t.Fatalf("no wdl sent, got %+v", in)
	}
	in, _ = parseInfo(strings.Fields("info depth 3 score cp 10 wdl x 1 2 pv e2e4"))
	if in.HasWDL || len(in.PV) != 1 {
		t.Fatalf("bad wdl should be ignored, got %+v", in)
	}
}

func TestWithWDL(t *testing.T) {
	listed := []Option{{Name: "Hash", Type: "spin"}, {Name: "UCI_ShowWDL", Type: "check", Default: "false"}}
	got := WithWDL(listed, map[string]string{"Hash": "64"})
	if got["UCI_ShowWDL"] != "true" || got["Hash"] != "64" {
		t.Fatalf("got %v", got)
	}
	user := map[string]string{"uci_showwdl": "false"}
	if got := WithWDL(listed, user); got["uci_showwdl"] != "false" || len(got) != 1 {
		t.Fatalf("the user's choice should stand, got %v", got)
	}
	if got := WithWDL([]Option{{Name: "Hash", Type: "spin"}}, nil); got != nil {
		t.Fatalf("engines without the option get nothing added, got %v", got)
	}
}
