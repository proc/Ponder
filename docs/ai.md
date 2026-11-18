# AI features

## Setting up the AI model

AI is off until you turn on **Use an AI model** at the top of **Settings →
AI**. While it is off, the AI button, AI annotate and live commentary are
hidden and nothing is sent anywhere. Settings from before this switch
existed count as on if a model or key was already chosen.

- **Provider**: **Local or other server** (the default, any OpenAI-compatible
  API), **OpenAI**, **Claude (Anthropic)** or **Google AI (Gemini)**. Each
  keeps its own model and key.
- **Endpoint** (local or other server): `http://localhost:8000/v1` by
  default, for oMLX, LM Studio, Ollama, llama.cpp, vLLM or any
  OpenAI-compatible address. `localhost:8000` is enough to type.
- **Model**: chosen from the provider's list; **Refresh** fetches it again.
  With the first choice Ponder picks the server's first model,
  `claude-opus-5-5`, or a Gemini Flash model. For OpenAI, pick one.
- **Context window**: the model's size in tokens, for the context meter.
  Leave empty to use what the provider reports.
- **API key**: needed for OpenAI, Claude and Google AI; local servers usually
  need none. Keys are encrypted with the system keychain where there is one,
  and never shown again.

Without a key, Ponder contacts no hosted provider or any server outside your
computer and local network (localhost, a private address or a `.local`
name); features say the key is missing instead.

Claude needs Anthropic's SDK, installed once with
`npm install @anthropic-ai/sdk` in Ponder's folder. Its answers stream in
and its summarized reasoning shows like a local model's thinking. On models
that offer it, a request Claude declines on safety grounds is answered by
another Claude model in the same call.

**What is sent.** AI annotate, the chat and live commentary send the game's
full PGN: tags (players' names and ratings, event, date, time control,
opening), moves, annotations and engine evaluations. With a hosted
provider or endpoint, this leaves your computer. AI annotate sends only
when you press its button.

**Speech server.** Comments can be read by the computer's own voices or by a
speech server. **Use a speech server** is off by default, and the server
follows the same no-key rule. While it is off, commentary and the announcer
use the computer's voices. Set it up under **Settings → AI → Commentary
voice**:

- Any OpenAI-compatible text-to-speech endpoint, OpenAI's or your own
  (Kokoro-FastAPI, openedai-speech, LocalAI). `localhost:8880` is enough for
  a local one.
- Pick the model and voice from lists (**Refresh** fetches again), plus an
  optional speaking style for models that take one.
- Its API key is encrypted like the AI keys; with none, OpenAI's endpoint
  uses the OpenAI key. **Test** plays a sentence.

## AI annotate

**AI annotate** in the Annotate panel sends the game to the model and turns
its reply into annotations: a summary before the first move, and a comment
and mark (`!`, `?`, …) on the moves it picks out.

- You can edit them; **Save** writes them into the PGN with an
  `Annotator "AI (model)"` tag.
- It only fills moves with no annotation, never replacing yours or any
  other, and says how many it left alone.
- **Remove the AI's annotations** takes them off.
- There is no time limit; it waits until the model answers or you press
  **Stop**.

## AI chat

A panel over the right of the window, opened with the spark button in the
toolbar or the **AI** handle on the right edge. Close it with ⇥, **Esc**, the
toolbar button or a click outside; the **pin** keeps it open. Drag its left
edge to resize (double-click resets). While collapsed, the handle shows a dot
when an answer arrives.

Ask about the game on the board. Each message is sent with the game as PGN,
the position shown and, when Analysis is running, the engine's top lines, so
"this move" means what you are looking at. A language model can be wrong
about tactics; it is told to trust the engine's evaluations.

- *Thinking…* shows the model's thinking when shared; *Thought for N s*
  opens it afterwards.
- **Enter** sends, **Shift+Enter** adds a line, **Stop** ends an answer.
- **+ New chat** opens a conversation in a new tab, kept until you close it
  with ✕ or quit.
- Hover a message: on yours, **copy** and **go back** (edit and resend); on
  an answer, **copy** and **ask again**.

**Context meter.** The top bar shows how much context the last request used,
such as `13k / 200k`: what was sent plus the answer. It turns amber at 75% and red at 95%. If the provider
does not report the window size (OpenAI), set **Context window** to see how
full it is.

Change the font under **Settings → Appearance → AI chat**: **Font** (System,
Serif, Rounded, Monospace or **Other…**) and **Text size** (80–150%). See
[Appearance](appearance.md).

## Live commentary

With **Live commentary** on (the AI panel's **Commentary** view), the model
comments on a game as it is played: yours, an engine's, a Lichess game or a
tournament game. Every few moves (**every** move, 2, 3, 5 or 8; 2 at first)
it is sent the game so far, the position and the engine's evaluation, and
replies with one sentence. At the end it gives a short summary.

- The latest comment shows in a **Commentary** card beside the board. **All…**
  opens the whole commentary; **Off** turns it off.
- In the Commentary view, each comment has the moves since the previous one
  above it; click a move to show it on the board.
- If the endpoint does not answer, commentary turns off with a notification;
  **Retry** asks again, covering any moves played since, and turns it back
  on.
- Comments are not saved with the game unless you annotate with them.

**The commentator.** By default a small pixel-art chess piece says the
comments in a speech bubble instead of the card. Choose it under **Settings
→ AI → Commentator**: **Esper** (a white pawn in a headset, the default),
**Onyx** (a black pawn), **Bastion** (a rook), **Mitzi** (a bishop),
**Rex** (a king) or **Regina** (a queen).

Each comment stays until read. The summary is its **Final word**. Click the
character to show or hide the bubble, and drag it anywhere. The bubble's
buttons read aloud, open **All** and retry. With reduced motion it stays
still. To use the card instead, turn off **Show a commentator character that
says the live commentary** (Settings → AI) or **A commentator character says
the commentary in a speech bubble** (Commentary view).

**Annotate the game with the commentary** (Commentary view) adds each comment
as an annotation on its move, and the summary before the first move, so
**Save** or **Copy** includes them. Existing annotations are left alone, and
**Remove the AI's annotations** (under **Annotate**) takes them off. Finished
games added to the game database keep them.

**Read aloud** (Commentary view, or the card's speaker) speaks each comment.
Choose the **voice** and **speed**; **Test** plays a sample. Moves are said
as words. A comment is never cut off; the next one waits and covers all moves since.
▶ on a comment reads it again. With a computer
voice nothing is sent anywhere. With **Speech server**, each comment's text
is sent to the server set up in
[Setting up the AI model](#setting-up-the-ai-model); if it can't be
reached, the reason shows and the comment is skipped.

## Announcer

The **announcer** (**Settings → General → Announcer**, off at first) speaks
what happens in the game, with no AI. Turn each part on or off:

- **Moves**: all, only captures, checks, castling and promotions, or none,
  optionally with who moved.
- **Score swings**: when the score moves by the chosen amount (0.7 to 3
  pawns, or never) and the leader changes. A swing of two pawns against the
  mover is called a blunder. The score is the playing engines' or, when on,
  the analysis's (from depth 12).
- **A mate found**, **The opening**, and **Low on time** (under 10 seconds).
- **The players at the start** and **how the game ended**.
- **The players' names** in place of White and Black.
- **Captions** on the board, for when the sound is off.

It uses the commentary's voice or its own; **Test** plays a sample. It
follows games on the board, not tournament games. With live commentary it
takes turns, speaking first; only the latest two lines wait, and one that
has waited six seconds is dropped.

**Personality** sets its style:

| Personality | Sounds like |
| --- | --- |
| Classic | "Magnus has a clear advantage." |
| Hype | "Oh no! A blunder! Hikaru is cruising to victory!" |
| Zen | "A misstep. It happens to us all." |
| Butler | "Oh dear. I do believe Hikaru is winning." |
| Robot | "Evaluation: Magnus plus 2.1. Significant." |
| Pirate | "Shiver me timbers! Treasure in sight for Hikaru!" |
| Snarky | "Wow. Bold choice. It's Hikaru's game. Wake me at the end." |
| Surprise me | a different one for each game |

Some personalities now and then add a flourish to a capture, check,
castling or promotion. Each also shades the speed and, with a computer
voice, the pitch.
