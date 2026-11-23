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

**Thinking on local servers.** Requests to a local or other server carry
`chat_template_kwargs: {"enable_thinking": false, "reasoning_effort": "none"}`,
so servers that render the model's chat template (vLLM, llama.cpp, SGLang)
turn the model's thinking off and it answers straight away. The one
exception is the AI chat with a thinking effort chosen (below). Servers that don't know the field
ignore it. OpenAI and Google aren't sent it.

**What is sent.** AI annotate, the chat and live commentary send the game's
full PGN: tags (players' names and ratings, event, date, time control,
opening), moves, annotations and engine evaluations. With a hosted
provider or endpoint, this leaves your computer. AI annotate sends only
when you press its button.

**Speech service.** Comments can be read by the computer's own voices or by a
speech service. **Use a speech service** is off by default. While it is off,
commentary and the announcer use the computer's voices. Set it up under
**Settings → AI → Commentary voice**, choosing the **Service**:

- **OpenAI**: models `gpt-4o-mini-tts` (the default), `tts-1` and `tts-1-hd`;
  voices such as alloy, coral, nova and verse.
- **Google AI (Gemini)**: Gemini's speech models through the Gemini API,
  `gemini-3.8-flash-lite-tts` by default (**Refresh** adds any other speech
  models your key can use); voices such as Kore, Puck and Zephyr. It uses
  the same kind of API key as Google AI for the chat, from Google AI Studio.
- **Claude** is listed but can't be chosen: Anthropic offers no
  text-to-speech. Claude can still write the commentary, for another
  service or the computer's voice to read.
- **Your own server**: any OpenAI-compatible text-to-speech server
  (Kokoro-FastAPI, openedai-speech, LocalAI). Type its **Address**;
  `localhost:8880` is enough for a local one. A server on your computer or
  network needs no key.

Each service keeps its own model, voice, style and key, so switching back
and forth keeps them. Pick the model and voice from the lists (**Refresh**
asks the service again), plus an optional speaking **Style** for the models
that take one (`gpt-4o-mini-tts` and Gemini's). Keys are encrypted like the
AI keys. With no key of their own, OpenAI and Google AI use the key you set
for them as the AI provider. **Test voice** plays a sentence; if the key is
refused, the quota is used up or the service can't be reached, the reason
shows under the settings.

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

**Model and thinking.** Under the message box, the chat shows the model and
how hard it thinks, such as `claude-opus-5-5 · high`. Click either to change
it. The change applies from your next message, and the conversation stays.
You can also type the commands below in the box; they set the choice and
send nothing.

- `/model` lists the provider's models; `/model gpt-5.1` switches to one.
- `/think` shows the levels the model takes; `/think high` picks one.

The model is the one in **Settings → AI**, so commentary and the other AI
features use it too. **List the models…** asks the provider for its models,
and **Settings → AI…** opens the settings.

The thinking level is for the chat only, and it is kept for each provider.
Commentary, AI annotate and engine chat ask without thinking where the
provider allows it, as before, so their short answers come quickly. A model
shows only the levels it takes:

| Provider | Levels | What is sent |
|---|---|---|
| Claude | default, off, low, medium, high, extra high, max | `thinking: {type: "adaptive"}` with `output_config.effort`. "Off" is sent as each model takes it: `disabled` (Opus 5, Haiku 5.5, Opus 4.8/4.7, Sonnet 5), `between_tools` (Sonnet 5.5), or no thinking settings (Opus 4.6, Sonnet 4.6). Fable and Opus 5.5 always think, so they have no "off". Opus 4.6 and Sonnet 4.6 have no "extra high". Haiku 4.5 and older models have only their default. |
| OpenAI | default, off, low, medium, high | `reasoning_effort`, on reasoning models (GPT-5 and later, the o-series). "Off" is `none`, or `minimal` on GPT-5. The o-series cannot turn thinking off. Other models have only their default. |
| Google AI | default, off, low, medium, high | `reasoning_effort` through Google's OpenAI-compatible API, on Gemini 2.5 and later. "Off" is `none`. Pro models cannot turn thinking off. |
| Your own server | off, minimal, low, medium, high, xhigh, max | `chat_template_kwargs`: off sends `enable_thinking: false` and `reasoning_effort: "none"`; an effort sends `enable_thinking: true` and that `reasoning_effort`, which a template that uses it writes into the system prompt. The default is off, as for the short requests. |

"Default" asks as the app did before there was a choice. Claude thinks
adaptively at its own default effort, a server of your own is told not to
think, and OpenAI and Google models think as they do when not told. If a
server refuses the level chosen, the chat asks again without it, and the
note under the box says so.

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
- Each comment is also saved with the game (see below).

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

**Saved with the game.** As soon as a comment is complete it becomes the
comment on the move it is about, in the moves list and in the game's PGN,
marked `[%ai]`. The summary becomes the comment before the first move.

- A comment already on the move (yours, the file's or the computer
  analysis's) is never replaced. Its `[%eval]` and `[%clk]` stay too.
- A game opened from a PGN file is saved into that file at once.
- A game being played or watched is in no file yet, so its comments wait on
  its moves. When it ends and is added to the game database (**Settings →
  Database**), they are written into its entry there. This works even if
  another file is open in the Games tab. **Copy** and **Save as…** include
  them as well.
- A move taken back takes its comment with it. A comment that arrives after
  its move was taken back is not used.
- **Remove the AI's annotations** (under **Annotate**) takes them off.

**Read aloud** (Commentary view, or the card's speaker) speaks each comment.
Choose the **voice** and **speed**; **Test** plays a sample. Moves are said
as words. A comment is never cut off; the next one waits and covers all moves since.
▶ on a comment reads it again. With a computer
voice nothing is sent anywhere. With the speech service as the voice
(named after it, such as **OpenAI voice**), each comment's text is sent to
the service set up in [Setting up the AI model](#setting-up-the-ai-model).
If the service fails, the reason shows, the computer's own voice reads the
comment instead, and the service is left alone for a minute before it is
tried again.

## Engine chat

With **Engine chat** on (Commentary view, off at first), your engine playing
on Lichess answers its opponent's moves in the game chat, in character. It is
only for games your engine plays: a game you play yourself against an engine
on this computer has no engine chat. The AI
model set in Settings → AI writes each message. It is told what the engine
itself thinks: the opponent's last move, the position (FEN), the engine's
evaluation and search depth, the move it is playing, and the line it expects.
It is asked not to give that line away, and not to give advice.

- **Answer every** sets how often it speaks: every move, or every 2, 3, 5 or
  8 of its opponent's moves, as for live commentary.
- **Name** is the name the engine goes by in the chat. Left empty, it uses
  its own name.
- **Personality** is how it talks: Friendly (at first), Cocky, Gentleman,
  Grumpy, Coach, Pirate, Robot, Zen, Bard, Sportscaster, Detective, Wizard,
  Cowboy, Knight, Mad scientist, Villain, Butler, Surfer, Philosopher, Cat,
  Haiku poet, Streamer or Shy. **Random** picks one of these again for
  each message, so the engine's mood changes as the game goes. **Your own…** opens a box to
  describe it yourself, up to 400 characters ("a sleepy cat who naps between
  moves and hates trading queens"). Whatever the personality, the engine is
  told to stay kind to its opponent: no insults, and no remarks about them as
  a person. The personality is used for every message: after moves, in
  answers and in the last message of the game. An older **Character**
  setting carries over: a name stays the name, and a longer description
  becomes your own personality.
- **Your engine on Lichess:** the message is posted in both rooms of the
  game's chat: the players' room, for its opponent, and the spectators'
  room, for the people watching. If Lichess refuses it in one room, it is
  still posted in the other, and the setting says which room missed it.
  This works for every game the engine plays, whether it is on the board or
  not.
- **It remembers its opponents.** When a game starts, the app reads your
  bot's record against that opponent from Lichess: the same head-to-head
  score the player card shows under "Against this opponent" (games played,
  and points for each side), and the current run of games between them when
  there is one. Only its first message of the game (or its second, if the
  record wasn't read in time for the first) gives the AI that record, so the
  engine brings up a rematch or a score to settle once, at the start, and
  not again. Against someone it has never played, the AI is told it is
  their first game. If Lichess doesn't answer, nothing is said about it.
- **When its opponent writes to it on Lichess**, in the players' room or the
  spectators' room, the engine answers in that same room, in character. The
  AI is given what the opponent wrote, the last few lines of the chat, the
  moves so far and the engine's last evaluation, and is told to ignore any
  instructions in the message. Only the opponent is answered, not people
  watching. An engine answers at most eight times in a game, so two bots
  that both answer can't talk forever. Answers keep to the same limits as
  the messages after moves. If one would come too soon, it waits, and goes
  out answering the latest thing said.

The engine never waits for a message: one is asked for only after its move
has been played. Messages are limited to one every 10 seconds in a game,
and six a minute over all games. On Lichess each message is two posts, one
in each room, so that is at most twelve posts a minute. A message that is
due sooner, or while the last one is still being written, is not dropped:
it waits, and goes out about the engine's latest move. So with **Answer
every** set to every move, a fast game gets a message about every 10
seconds rather than one at each move. Its first move answers nothing, so it
says nothing then.

**When the game is over**, the engine sends one last message, in
character. It says the game is over and how it ended: the result and the
way it ended (checkmate, resignation, time, stalemate, a draw, …). It speaks
as the winner or the loser: if it lost, it congratulates its opponent; if it
won, it thanks them; if it was a draw, it says so. Then it gives a quick
recap of the game: how it began, where it turned and how it finished. The AI
is given the result and how it ended, all the moves, and the engine's evaluation at each of its moves,
with the moves where it swung most. This message goes to both rooms of the
game's chat. An aborted game
gets none. It waits for the limits below if it must, rather than being left
out, and it is sent once a game.

**Length.** A message may be up to 400 characters: a line or two, or a
few sentences when there is more to say. Lichess takes chat messages of up
to 140 characters, so a longer message is posted in parts, at most three,
one after another a moment apart. It is split between sentences where they
fit, else between words. Each part after the first counts as one more
message under the limit of six a minute. The model's answer is capped at a
small number of tokens.

- If a message comes back too long, the model is shown its own message and
  asked once more for a version of 400 characters or fewer.
- If that is too long as well, the message is cut to fit as a last resort,
  at the end of a sentence where one fits, else at a word, with an ellipsis.
  It is never cut in the middle of a word.
- Some models think before they answer, and their thinking counts against
  the cap. If such a model uses the whole cap and writes nothing, it is asked
  again without the cap, and not capped again while the app is open.

If the AI fails, the reason shows under the setting, and the engine stays
quiet for the rest of that game.

Each message sends the model the moves of the game, the players' names and
ratings, and the engine's evaluation and line. With a hosted provider, that
leaves your computer.

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
