# Appearance

Everything about the look lives in **Settings → Appearance**. See also
[Playing games](playing.md) and [Engines and analysis](engines-and-analysis.md).

## Themes

Pick a theme in **Settings → Appearance**; your choice is remembered. Each
theme changes the pieces, the board and the window:

- **Minimalist** (default): white and charcoal pieces on a light grey board,
  light window, blue accent.
- **Obsidian**: pale and amber pieces on a charcoal board, dark window, amber
  accent.
- **Cyberpunk**: neon-outlined pieces on a navy board, dark UI.
- **Dusk**: teal and coral pieces on a slate-violet board, dark blue-grey UI,
  lavender accent.

Every theme follows the look of Apple's apps. On macOS there is no title
bar; the strip at the top holds the window buttons and drags the window.

## Glass

The side panel's tabs, the column beside the board, the floating windows, the
Settings window and the AI panel are frosted glass: translucent cards that
blur what is behind them, with a bright edge.

Set how see-through it is with **Transparency** under **Settings → Appearance
→ Glass**, from Solid to Clear. Double-click the slider to reset it. Past the
middle the frosting also thins, so at 100% only the edges and a light blur
remain. Dark themes are slightly clearer at the same setting.

## 3D board

Turn on **3D board** under **Settings → Appearance → Board** (off by
default). The board and pieces are drawn in 3D, seen from your side at an
angle, with light, reflections and soft shadows, in the theme's colours.
Cyberpunk pieces glow cyan and magenta, with a neon line round the board.
Files and ranks are on the frame.

Everything the flat board shows is there too.

- **Move**: click a piece then its square, or drag it.
- **Turn and tilt**: drag anywhere that is not a piece, or drag with the
  middle button.
- **Zoom**: scroll or pinch.
- **Reset the view**: the round arrow at the board's top right (beside
  **Auto**), or double-click an empty spot. Your view is kept for next time.
- **Flip**: flipping the board turns it round.

**Auto camera** (the **Auto** button at the board's top right, or the switch
under 3D board) follows the game: on each move the camera glides in toward
the move, closer for a capture or check, then glides back. Turning or zooming
yourself takes over until the next move.

**Capture effects** (switch under Auto camera, on by default) set off a burst
where a piece is taken, picked at random and never the same twice running:
fire and smoke, magic plasma, shadow clones, sparks, frost, or ice (the taken
piece freezes and shatters). The capturing piece leaves a matching trail and
moves a little slower so you can see it. Each effect has its own sound, which
follows the Sounds setting and volume.

In zen mode the 3D board fills the window, with the players' rows along its
top and bottom and the score bar down the left.

## Glassify board

**Glassify board** (**Settings → Appearance → Board**, off by default) turns
the board and pieces to glass. Squares become see-through tiles with a lit
edge; pieces become clear (White) or smoked (Black) glass. It follows the
theme and the Transparency setting. On the 3D board, the pieces become
glass in the theme's colours.

## Other settings

**Settings → Appearance** also holds:

- **Board**: piece animation, attack marks, the result card, the versus and
  result screens.
- **Moves list**: piece icons and scores.
- **AI chat**: font and text size.

**General** holds the sounds and when the board switches to your engine's
new Lichess game.

## Adding a theme

1. Add a folder in `svg/` with all twelve `<color>-<name>.svg` pieces (for
   example `svg/minimalist/white-king.svg`). Pieces are scaled so the tallest
   fills 84% of a square.
2. Add a colour block under `[data-theme="<name>"]` in
   `app/renderer/style.css`. For the 3D board, set `--piece3d-white`,
   `--piece3d-black` and `--piece3d-finish` (matte, satin or gloss), and
   optionally `--piece3d-white-rim`, `--piece3d-black-rim` and
   `--board3d-edge`.
