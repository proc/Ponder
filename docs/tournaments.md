# Tournaments

The **Tournament** tab plays many games between engines, like cutechess-cli or fastchess.

## Formats

- **Match** – two engines, with Elo and an SPRT.
- **Round robin** – every engine plays every other.
- **Gauntlet** – the first engine plays each of the others.
- **Knockout** – engines are seeded best first, in list order; losers are out. A level match plays on in pairs of games; after three pairs the higher seed goes through.
- **Swiss** – a set number of rounds (0: enough to sort the field), pairing engines on equal points that have not met. With an odd number, one sits out each round for half the points.

For formats other than a match, list up to 32 engines (repeats allowed) and set **Games per match** (even, so each opening is played with both colours).

## Settings

- **Engines** (a match) – engine 1 is tested, engine 2 is the base. Each opening is played twice with colours reversed (a pair).
- **Time control** – a clock (e.g. 10+0.1), fixed time or fixed nodes per move. An engine over its time by more than 100 ms loses.
- **Games** and **Games at once** – total games (0: until the SPRT decides) and how many run side by side.
- **Openings** – the built-in book (about 1,900 lines), an EPD or PGN file, or the start position.
- **SPRT** – tests H0: Elo = Elo0 against H1: Elo = Elo1 with error rates α and β, stopping when the LLR crosses a bound.
- **Adjudication** – a draw when both engines see ±10 cp for 8 moves each from move 40; a win when both agree on ±1000 cp for 3 moves each; optionally a draw at a move limit.
- **Save games** to a PGN file (by default in `Documents/Ponder/Tournaments`).

## While it runs

A match shows W–L–D, score, Elo with its 95% margin, LOS, draws, LLR, pair results, speed, time left and the games (click one to view it). **Show on board** follows one game live. Analysis pauses during a tournament.

Other formats show **Standings** (points, score, Sonneborn–Berger, Elo difference), **Points as the games went by**, **Matches** (with the knockout bracket or Swiss rounds) and **Head to head**.

**Pause** finishes the pairs in progress, then waits for **Resume**. **Stop** ends the tournament; games in progress are not counted.

**Engine options** lists the UCI options each engine runs with; games save them in `WhiteOptions` and `BlackOptions` tags.

**Search statistics** give each engine's average depth, selective depth, nodes, speed and time per move, plus game length and thinking time. A dash means the engine did not report it.

## Report

For a match, **Report** (or **Report so far**) writes a single offline web page next to the games file and opens it, with five views: **Summary**, **Progress**, **Engines**, **Openings** and **Games** (click a game to replay it with both engines' evaluations).

Every chart has a **Show data** table, and the report has light and dark themes. **Save…** (Ctrl/⌘+S) saves it as a web page and **Save as PDF…** as a PDF; **Save as…** in the Tournament tab does the same for the last report. Moves are kept for the last 2,000 games of a match.
