// Command pgn2binpack converts a PGN file into a Stockfish .binpack of
// training positions, as Ponder's Games list does (Binpack…).
//
//	pgn2binpack [flags] games.pgn out.binpack
//	pgn2binpack -dump out.binpack     # print the entries
package main

import (
	"bufio"
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
	"time"

	"board/backend/binpack"
)

func main() {
	var (
		req     binpack.Request
		engine  = flag.String("engine", "", "score with this UCI engine instead of the PGN's evaluations")
		options = flag.String("options", "", "engine options, as Name=value;Name=value")
		dump    = flag.Bool("dump", false, "print the entries of a binpack: FEN | move score ply result")
	)
	flag.StringVar(&req.Missing, "missing", "skip", "positions without an evaluation in the PGN: skip or zero")
	flag.IntVar(&req.PawnValue, "pawn", 208, "score of a pawn in the file (208: Stockfish's unit; 100: centipawns)")
	flag.IntVar(&req.SkipPlies, "skip-plies", 0, "leave out the first plies of every game")
	flag.BoolVar(&req.SkipNoisy, "skip-noisy", false, "leave out positions in check and before a capture")
	flag.IntVar(&req.Depth, "depth", 0, "engine: depth per position (default 8 without -nodes)")
	flag.Int64Var(&req.Nodes, "nodes", 0, "engine: nodes per position")
	flag.IntVar(&req.Concurrency, "threads", 1, "engine: positions searched at once, one engine each")
	flag.Usage = func() {
		fmt.Fprintln(os.Stderr, "usage: pgn2binpack [flags] games.pgn out.binpack\n       pgn2binpack -dump file.binpack")
		flag.PrintDefaults()
	}
	flag.Parse()
	if *dump {
		if flag.NArg() != 1 {
			flag.Usage()
			os.Exit(2)
		}
		if err := dumpFile(flag.Arg(0)); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	if flag.NArg() != 2 {
		flag.Usage()
		os.Exit(2)
	}
	req.From, req.To = flag.Arg(0), flag.Arg(1)
	req.Scores = "pgn"
	if *engine != "" {
		req.Scores = "engine"
		req.Engine = binpack.Engine{Path: *engine, Args: []string{}, Options: map[string]string{}}
		for _, kv := range strings.Split(*options, ";") {
			if k, v, ok := strings.Cut(kv, "="); ok {
				req.Engine.Options[strings.TrimSpace(k)] = strings.TrimSpace(v)
			}
		}
		if req.Depth <= 0 && req.Nodes <= 0 {
			req.Depth = 8
		}
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	var last binpack.Stats
	var shown time.Time
	err := binpack.Convert(ctx, req, func(read, size int64, st binpack.Stats) {
		last = st
		if size > 0 && time.Since(shown) > 250*time.Millisecond {
			shown = time.Now()
			fmt.Fprintf(os.Stderr, "\r%3d%%  %d games, %d positions", read*100/size, st.Games, st.Positions)
		}
	})
	fmt.Fprintln(os.Stderr)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	info, _ := os.Stat(req.To)
	var size int64
	if info != nil {
		size = info.Size()
	}
	fmt.Fprintf(os.Stderr, "%d positions from %d games (%d unfinished left out, %d with an illegal move, %d positions without a score); %d bytes\n",
		last.Positions, last.Games, last.Unfinished, last.Broken, last.Unscored, size)
}

func dumpFile(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	out := bufio.NewWriter(os.Stdout)
	defer out.Flush()
	r := binpack.NewReader(f)
	for {
		e, err := r.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		fmt.Fprintf(out, "%s | %s %d %d %d\n", binpack.FEN(&e), e.Move.UCI(), e.Score, e.Ply(), e.Result)
	}
}
