# Playing games

## Starting a game

**New game** lets you choose Human vs Human, Human vs Computer or Computer vs
Computer, pick engines and set the time control.

Before the first move, the Moves tab shows a start screen: New game, Lichess,
Puzzles, Openings, Open PGN and Analyse; the five latest games in the open file
(usually your game database); and a box to paste a PGN or FEN. It gives way to
the moves once a piece moves.

### Time controls

Each side can have its own control, or both can share one:

- **Clock** – one or more stages of *N moves in M minutes + S seconds per
  move* (leave the move count empty for the rest of the game). Presets run
  from bullet to classical, plus multi-stage controls such as 40/90 then 30
  with a 30 s increment.
- **Fixed time per move**.
- **Fixed search depth** – engines only.
- **No clock** – humans only.

Running out of time loses, unless the opponent cannot mate (a draw). Engines on
fixed time per move are not flagged.

## The window

The window opens maximised (F11, or ⌃⌘F on macOS, for full screen). The board
takes the full height; beside it the moves list keeps to the width it needs,
with the engine windows, computer analysis and Game card in a column next to
it. Tabs that don't fit go into a **More ▾** menu. On a narrow panel the
windows go below the tabs. Text grows with the screen.

## On the board

- **Moving** – click or drag. Pieces slide to their new square and captured
  pieces fade out, also when stepping through a game; set the speed (or turn
  it off) under **Settings → Appearance → Board**.
- **Moves list** – one row per move number (number, White, Black), with the
  result at the end; click a move to go to it. Each move shows an icon of the
  piece that moved and the score after it, from White's side: the computer
  analysis, or else the playing engine's evaluation in italics (hover for
  depth). Turn these off in **Settings → Appearance → Moves list**.
- **Opening name** – from a built-in book of about 3,800 ECO lines, matched by
  position so transpositions count. Saved games get `ECO` and `Opening` tags.
  If the book has no name, one given in an engine `info string` is used.
  The newest `info string` shows under each engine's analysis; click it to
  show all.
- **Captured pieces** – each player's bar shows the pieces they have taken and
  their material lead (pawn 1, knight and bishop 3, rook 5, queen 9) for the
  position shown. A captured piece flies into that bar, following the move
  animation setting.
- **Pieces under attack** – a piece with more attackers than defenders wears a
  red target showing the difference (+1, …). A pinned piece still counts.
  Turn it off under **Settings → Appearance**; zen mode hides it.
- **Drawing** – right-drag for an arrow, right-click for a circle: green, red
  with Shift, blue with Alt, yellow with both. Left-click clears.
- **Premoves** – against an engine, move during its turn; it is played on your
  turn if still legal. Right-click cancels.
- **Takeback** – against an engine, takes back your move and its reply;
  between people, the last move.
- **Resign, draw, abort** – during a game each person has **⚑ Resign** on
  their bar; the bar nearest you has **½ Draw** (between two people) and
  **✕ Abort**. They ask before acting.
- **Swap or reload an engine** – **⇄ Engine** on an engine's bar opens a menu.
  **↻ Reload** restarts it with the options now saved under **Settings →
  Engines**, fixing a changed option or stuck engine without a new game. Or
  pick another engine to take over on the same side and clock; if it can't
  start, the previous one returns. In your engine's [Lichess](lichess.md) game
  only **↻ Reload** is offered.

## Voice commands

Click the microphone at the board's bottom right, or press **T**, and say your
moves. The microphone turns red and pulses while Ponder listens; click it
again, press **T**, or say "stop listening" to stop. Voice commands are off
each time Ponder starts.

Speech is recognised on your computer, so no sound leaves it. The first time
you turn voice commands on, Ponder asks to download its speech model (Vosk's
small English model, about 40 MB, from alphacephei.com) and keeps it in its
data folder. Your system may also ask to let Ponder use the microphone. On
macOS, if you said no, allow it under **System Settings → Privacy & Security →
Microphone**.

You can say:

- **A move**, as it is written: "e4", "knight f3", "knight takes e5", "queen
  takes d7 check", "e takes d5".
- **From one square to another**: "e2 e4", "g1 to f3".
- **Where the piece comes from**, when two pieces can go to the same square:
  "rook a d1", "knight b1 d2".
- **Castling**: "castle kingside" or "short castle", "castle queenside" or
  "long castle".
- **A promotion**: "e8 queen", "e8 promote to knight", "takes d8 queen".
- **Undo** or **take back**, **flip board**, **new game**, **resign**, **offer
  draw** and **stop listening**. Resigning and draws still ask before they
  act.

Each time, a note in the top right corner and the status line show what was
heard and what was done. If the words fit no legal move, or more than one,
nothing is played and the note says why, for example *More than one piece fits
"rook d1": from a1 or f1*. Saying "check" is fine but not needed, and a
promotion needs the piece. Voice works for the moves in a game, a puzzle or
while exploring a position, but only on your turn: it does not premove. While
the announcer or commentary is speaking, Ponder doesn't act on what it hears.

## Game card

Beside the moves, the Game card shows the event, result, players, time control,
opening and other details. For a finished or loaded game (eight plies or more)
it shows the middle-game position; **Middle / End** switches to the final
position, and clicking the board goes to that move.

## Versus and result screens

**Versus screen** – when a game you watch starts (a Lichess player's or your
engine's), the players' cards slide in to face each other across a **VS**, with
name, title, flag, rating, record, recent form and head-to-head score, to an
arcade fanfare. A click or Esc dismisses it. A watched player's next game gets
it too, marked *Another game* if it is not on the board. Games joined part way,
tournament games and your own games don't show it. Turn it off under
**Settings → General**.

**Result screen** – when a game ends (not tournament games), a word slams in:
**CHECKMATE**, **TIME OVER**, **K.O.** (resignation or other decisive result)
or **DRAW GAME**, then who won or why it was drawn, then both players' cards
with rating changes. It goes after about five seconds, or on a click or Esc.
**Analyze with AI** opens the AI's analysis of the game. Turn it off under
**Settings → Appearance**.

**End-of-game card** – then a card says who won and how: *You won!*, *You lost*,
*Draw*, *Your engine won/lost*, or *White wins* / *Black wins*. Draws give a
reason, read off the final position for Lichess games. It has **Computer
analysis**, **Analyze with AI** (see [AI features](ai.md)), **New game** and
**Close** (or Esc). Player bars show the score, a sound plays, and a desktop
notification appears if Ponder isn't in front. Rated Lichess games also show
rating changes (e.g. *−8 rating · 1500 → 1492*). Turn the card off in
**Settings → Appearance → Board**.

## Open, Save and Copy

**Open…**, **Save…** and **Copy** sit under the moves list.

- **Copy** puts the game on the clipboard as PGN; **Save…** (Ctrl/⌘+S) writes
  a `.pgn` file. Both work during or after a game.
- **Open…** (Ctrl/⌘+O) loads every game in a `.pgn` file, of any size, into
  the **Games** tab; click one to show it. Comments and variations are
  skipped, games with an illegal move are marked, and loaded games can't be
  played on.

See also [Game database](database.md).

## Keyboard and menu

← → move by move, ↑ ↓ / Home End go to the start and end, **F** flips, **Z**
zen mode (board and players only), **L** analysis, **P** pauses it, **B**
takeback, **U** classical music, **T** voice commands, **?** lists shortcuts. Flip and zen mode are
also icons at the board's bottom right.

The application menu has:

- **File** – New Game ⌘N, Open PGN ⌘O, Open Game Database ⇧⌘O, Test
  Positions, Save Game ⌘S, Copy Game as PGN ⇧⌘C, Copy Position as FEN ⌥⌘C,
  Paste Game or Position ⇧⌘V.
- **Game** – takeback, voice commands, move by move, flip, annotate.
- **Analysis** – analyse, pause, explorer, AI chat ⌘J, engine and analysis
  settings.
- **Lichess** – play, TV, your bot, puzzles.
- **View** – tabs ⌘1–⌘6, zen mode, appearance, sounds, music, zoom, full screen.
- **Help** – keyboard shortcuts, links.

On Windows and Linux, press Alt to show the menu bar; Ctrl replaces ⌘.

## Sound, music and screen

**Sounds** – moves, captures, castling, check, promotion, game start and end,
your clock dropping under 10 seconds, and illegal moves each have a sound. The
minimalist, cyberpunk and dusk themes have their own sets (wooden, synth and
16-bit arcade; see [Appearance](appearance.md)). **Settings** turns them off or
sets the volume.

**Classical music** – the note button beside the board (or **U**) plays
Radio Swiss Classic, Venice Classic Radio, BR-Klassik, Klassik Radio, Radio
Classique, NPO Radio 4, WQXR or Classical KUSC, a station you add, or a shuffled
folder of your own music. **Add a station…** takes a stream address (MP3, AAC
or Ogg) or a .pls or .m3u link; it stays until you press **Remove**. HLS
(.m3u8) streams can't be played. Choose the source and volume in **Settings →
General → Music**; music resumes on restart if it was playing.

**Keeping the screen awake** – **Settings → General → Screen → Keep the screen
awake**: **never**, **while a game is played** (default) or **always**. It also
keeps the computer from sleeping.

## Easter eggs

Type `nyan` anywhere outside a text box: a pixel cat flies across the
window on a rainbow, to a little chiptune (heard when sounds are on).

Type `veridis` for another: Ponder plays Veridis Quo by Daft Punk from a MIDI
file, on a little synth of its own, and the board's squares light up with
the melody. It plays only when sounds are on and stops when they go off;
type `veridis` again, press Escape, or press the music button (or U) to stop it.
