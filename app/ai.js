'use strict';
// AI commentary: the game is sent to an AI model that is asked for
// commentary as JSON, which becomes annotations on the moves, and the AI
// panel's chat and the live commentary talk to the same model. The model is
// reached through one of the providers below: OpenAI, Claude (Anthropic),
// Google AI (Gemini), or any OpenAI-compatible server (oMLX, LM Studio,
// Ollama, llama.cpp, vLLM, or a hosted one). Nothing here touches Electron,
// so it can be run and tested with plain Node.

const DEFAULTS = { baseUrl: 'http://localhost:8000/v1', model: '', provider: 'local' };

// kind: the API it speaks. OpenAI and Google AI are spoken to in the
// OpenAI chat-completions form (Google offers it for Gemini); Claude through
// Anthropic's own SDK.
const PROVIDERS = {
  local: { name: 'Local or other server', kind: 'openai', needsKey: false },
  openai: { name: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1', needsKey: true, modelHint: 'e.g. a GPT model: press Check for the list' },
  anthropic: { name: 'Claude (Anthropic)', kind: 'anthropic', needsKey: true, defaultModel: 'claude-opus-5-5', modelHint: 'claude-opus-5-5' },
  google: { name: 'Google AI (Gemini)', kind: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', needsKey: true, modelHint: 'e.g. a Gemini model: press Check for the list' },
};
const providerOf = (settings) => PROVIDERS[settings?.provider] ? settings.provider : 'local';
const who = (settings) => (providerOf(settings) === 'local' ? 'The AI endpoint' : PROVIDERS[providerOf(settings)].name.replace(/ \(.*\)$/, ''));
// The base address requests go to: the provider's, or the one typed.
const baseOf = (settings) => PROVIDERS[providerOf(settings)].baseUrl ?? normalizeBase(settings.baseUrl);

// The address as typed, made into the API's base: "localhost:8000" becomes
// "http://localhost:8000/v1"; a path given is kept.
function normalizeBase(url) {
  let u = String(url ?? '').trim();
  if (!u) return DEFAULTS.baseUrl;
  if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
  u = u.replace(/\/+$/, '');
  let parsed;
  try { parsed = new URL(u); } catch { throw new Error('The AI endpoint is not a web address'); }
  if (parsed.pathname === '' || parsed.pathname === '/') u += '/v1';
  return u.replace(/\/(chat\/completions|models)$/, '');
}

const SYSTEM = `You are a strong chess coach annotating a game for a club player.
You are given the game as PGN and as a list of moves, each with its ply number.
Reply with ONLY a JSON object, no other text, of this shape:
{"summary": "two or three sentences on how the game went",
 "comments": [{"ply": 12, "mark": "?", "comment": "why, and what was better"}]}
Rules:
- "ply" is the ply number from the list of the move the comment is about.
- "mark" is one of "!!", "!", "!?", "?!", "?", "??", or "" for none.
- Comment on the 6 to 20 most instructive moves: turning points, mistakes, good ideas, the opening choice, the decisive moment. Not every move.
- Each comment is one or two sentences, under 45 words, plain text, concrete: plans, threats, better moves in standard notation.
- Only mention moves and squares that fit the position. Where the PGN has engine evaluations ([%eval]) or marks, agree with them.
- Each item of "comments" is an object in its own curly braces, as shown. Do not use curly braces or line breaks inside the comment text.`;

function buildMessages(game) {
  const list = (game.moves ?? []).map((m) => `ply ${m.ply}: ${m.number}${m.white ? '.' : '...'} ${m.san}`).join('\n');
  const user = [
    game.white || game.black ? `White: ${game.white || '?'}${game.whiteElo ? ` (rated ${game.whiteElo})` : ''}\nBlack: ${game.black || '?'}${game.blackElo ? ` (rated ${game.blackElo})` : ''}\nResult: ${game.result || '*'}` : '',
    `Moves:\n${list}`,
    `The game as PGN (its tags give the players' names and ratings, the event and the time control):\n${String(game.pgn ?? '').trim()}`,
  ].filter(Boolean).join('\n\n');
  return [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }];
}

const MARKS = new Set(['!!', '!', '!?', '?!', '?', '??']);

// A reply that is almost the JSON asked for, but not quite: a comment
// without its braces ("comments": ["ply": 9, "mark": "!", …]), a comma
// missing, or an answer cut off before its end. Its fields are read in
// order: each "ply" starts a comment, and the "mark" and "comment" after
// it, before the next "ply", are that comment's. A comment cut off is left
// out. Null when no summary or comment is found.
function salvage(t) {
  const str = String.raw`"((?:[^"\\]|\\.)*)"`; // a JSON string, its escapes kept
  const unquote = (s) => { try { return JSON.parse(`"${s}"`); } catch { return s; } };
  const field = (chunk, name) => {
    const m = new RegExp(`"${name}"\\s*:\\s*${str}`).exec(chunk);
    return m ? unquote(m[1]) : undefined;
  };
  const summary = field(t, 'summary');
  const comments = [];
  const plies = [...t.matchAll(/"ply"\s*:\s*"?(\d+)"?/g)];
  plies.forEach((m, i) => {
    const chunk = t.slice(m.index + m[0].length, i + 1 < plies.length ? plies[i + 1].index : t.length);
    comments.push({ ply: Number(m[1]), mark: field(chunk, 'mark') ?? field(chunk, 'nag') ?? '', comment: field(chunk, 'comment') ?? field(chunk, 'text') ?? '' });
  });
  if (summary === undefined && !comments.length) return null;
  return { summary: summary ?? '', comments };
}

// The model's reply as { summary, comments: [{ ply, mark, comment }] }.
// Models wrap JSON in prose, code fences or "thinking": the object is dug
// out. A reply with no JSON at all becomes the summary.
function parseReply(text, plies) {
  let t = String(text ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/```(?:json)?/gi, '').trim();
  const clean = (s) => String(s ?? '').replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  let data = null;
  if (start >= 0 && end > start) {
    try { data = JSON.parse(t.slice(start, end + 1)); } catch { /* not JSON after all */ }
  }
  if (!data || typeof data !== 'object') data = salvage(t);
  if (!data) {
    if (!t) throw new Error('The model gave an empty answer');
    return { summary: clean(t).slice(0, 1200), comments: [], loose: true };
  }
  const seen = new Set();
  const comments = [];
  for (const c of Array.isArray(data.comments) ? data.comments : []) {
    const ply = Math.round(Number(c?.ply));
    const comment = clean(c?.comment ?? c?.text);
    if (!Number.isFinite(ply) || ply < 1 || ply > plies || seen.has(ply)) continue;
    const mark = MARKS.has(String(c?.mark ?? c?.nag ?? '').trim()) ? String(c.mark ?? c.nag).trim() : '';
    if (!comment && !mark) continue;
    seen.add(ply);
    comments.push({ ply, mark, comment: comment.slice(0, 600) });
  }
  comments.sort((a, b) => a.ply - b.ply);
  return { summary: clean(data.summary).slice(0, 1200), comments };
}

// One request, with Node's own http: unlike fetch it has no built-in limit
// on how long the answer may take, so a slow local model is waited for
// until the signal says stop.
function send(url, { method, headers, body, signal, onData }) {
  const u = new URL(url);
  const lib = u.protocol === 'https:' ? require('https') : require('http');
  return new Promise((resolve, reject) => {
    const req = lib.request(u, { method, headers, signal }, (res) => {
      const chunks = [];
      res.on('data', (c) => { chunks.push(c); onData?.(c, res); });
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.setTimeout(0); // no idle limit either
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// The error message in a provider's answer: { error: { message } }, or
// Google's [ { error: { message } } ].
function errorDetail(text) {
  let detail = text.slice(0, 300);
  try {
    let j = JSON.parse(text);
    if (Array.isArray(j)) j = j[0];
    detail = j?.error?.message ?? j?.error ?? j?.message ?? detail;
  } catch { /* as it is */ }
  return typeof detail === 'string' ? detail : JSON.stringify(detail);
}

async function call(url, { method = 'GET', body, key, signal, sendImpl = send, name = 'The AI endpoint' }) {
  const headers = { Accept: 'application/json' };
  const payload = body ? JSON.stringify(body) : undefined;
  if (payload) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(payload);
  }
  if (key) headers.Authorization = `Bearer ${key}`;
  let res;
  try {
    res = await sendImpl(url, { method, headers, body: payload, signal });
  } catch (err) {
    if (signal?.aborted) throw new Error(signal.reason?.name === 'TimeoutError' ? `${name} took too long to answer` : 'Stopped');
    throw new Error(`Could not reach ${name === 'The AI endpoint' ? 'the AI endpoint' : name} at ${new URL(url).origin} (${err.code ?? err.message}).${name === 'The AI endpoint' ? ' Is the server running?' : ''}`);
  }
  const { status, text } = res;
  if (status < 200 || status >= 300) {
    const detail = errorDetail(text);
    throw new Error(`${name} answered ${status}${status === 401 || status === 403 ? ' (check the API key in Settings → AI)' : ''}${detail ? `: ${detail}` : ''}`);
  }
  try { return JSON.parse(text); } catch { throw new Error(`${name} did not answer in JSON; is it an OpenAI-compatible API?`); }
}

// The models the provider offers, by id. Google's ids come as
// "models/gemini-…": the name alone is what is asked for.
async function listModels(settings, opts = {}) {
  const p = providerOf(settings);
  if (PROVIDERS[p].needsKey && !settings.key) throw new Error(`${who(settings)} needs an API key: add yours in Settings → AI`);
  if (PROVIDERS[p].kind === 'anthropic') return anthropicModels(settings, opts);
  const data = await call(`${baseOf(settings)}/models`, { key: settings.key, name: who(settings), ...opts });
  // Not the models a server says are for something else (speech, hearing,
  // embeddings: oMLX, LocalAI and others say so).
  const notChat = (m) => /\b(tts|stt|speech|audio|asr|transcri\w*|embed\w*|rerank\w*|image|vision_only)\b/i.test([m.type, m.model_type, m.task].filter(Boolean).join(' '));
  let ids = (data.data ?? data.models ?? []).filter((m) => typeof m !== 'object' || !notChat(m)).map((m) => (typeof m === 'object' ? m.id ?? m.name : m)).filter(Boolean).map((id) => String(id).replace(/^models\//, ''));
  // Of OpenAI's many models (speech, images, embeddings…), the chat ones.
  if (p === 'openai') ids = ids.filter((id) => /^(gpt-|o\d|chatgpt-)/.test(id) && !/(audio|realtime|transcribe|tts|image|search|embedding)/.test(id));
  if (p === 'google') ids = ids.filter((id) => /gemini|gemma/.test(id) && !/(embedding|image|tts|audio)/.test(id));
  return ids.sort();
}

// The model to ask: the one set, or else the provider's own choice, or the
// first the endpoint lists.
async function pickModel(settings, opts) {
  const set = String(settings.model ?? '').trim();
  if (set) return set;
  const p = PROVIDERS[providerOf(settings)];
  if (p.defaultModel) return p.defaultModel;
  let models = [];
  try { models = await listModels(settings, opts); } catch (err) {
    if (/Stopped|too long|Could not reach|API key|answered 40[13]/.test(err.message)) throw err;
  }
  // Google: a Flash model, quick enough for commentary.
  const model = (providerOf(settings) === 'google' ? models.find((m) => /flash/.test(m) && !/lite|preview|exp/.test(m)) : null) ?? models[0] ?? '';
  if (!model) throw new Error(`${who(settings)} lists no model: set the model’s name in Settings → AI`);
  return model;
}

// The tokens a request took: { input, output }, from the OpenAI form
// (prompt_tokens, completion_tokens) or Claude's (input_tokens, with what was
// read from or written to the cache, and output_tokens).
function usageOf(u) {
  if (!u || typeof u !== 'object') return null;
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const input = u.prompt_tokens != null ? n(u.prompt_tokens) : n(u.input_tokens) + n(u.cache_creation_input_tokens) + n(u.cache_read_input_tokens);
  const output = u.completion_tokens != null ? n(u.completion_tokens) : n(u.output_tokens);
  return input || output ? { input, output } : null;
}
// Servers that refused stream_options: not sent to them again.
const noUsageOption = new Set();
// Models that write nothing within a small cap on their answer (they think
// first, and the thinking counts): asked without one. "provider|base|model"
const uncapped = new Set();

// Settings for the request: OpenAI's newer models take no temperature but
// their own; other servers are given one.
const temperatureFor = (settings, t) => (providerOf(settings) === 'openai' ? {} : { temperature: t });

// --- Claude (Anthropic) -------------------------------------------------------
// Through Anthropic's official SDK (@anthropic-ai/sdk), loaded when Claude is
// first asked so that the app runs without it for the other providers.
// Models that take the server-side fallback: a request Claude declines on
// safety grounds is answered by another model in the same call.
const ANTHROPIC_FALLBACK_MODELS = new Set(['claude-fable-5-2', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);
// Models with adaptive thinking, whose reasoning can be shown summarized.
const anthropicAdaptive = (model) => /^claude-(fable|mythos|opus-5|opus-4-[678]|sonnet-5|sonnet-4-6|haiku-5)/.test(model);

function anthropicClient(settings, AnthropicImpl) {
  let Anthropic = AnthropicImpl;
  if (!Anthropic) {
    let mod;
    try { mod = require('@anthropic-ai/sdk'); } catch {
      throw new Error('Claude needs the Anthropic SDK, which is not installed: run "npm install @anthropic-ai/sdk" in Ponder’s folder, then start Ponder again');
    }
    Anthropic = mod.default ?? mod.Anthropic ?? mod;
  }
  if (!settings.key) throw new Error('Claude needs an API key: add yours in Settings → AI');
  return { Anthropic, client: new Anthropic({ apiKey: settings.key }) };
}

// What a failed Claude request is called, most particular first.
function anthropicError(Anthropic, err, model) {
  const is = (name) => typeof Anthropic[name] === 'function' && err instanceof Anthropic[name];
  if (is('APIUserAbortError')) return new Error('Stopped');
  if (is('AuthenticationError')) return new Error('Claude did not accept the API key (401): check it in Settings → AI');
  if (is('PermissionDeniedError')) return new Error(`Claude: this API key may not use ${model} (403)`);
  if (is('NotFoundError')) return new Error(`Claude has no model "${model}" (404): choose another in Settings → AI (Check lists them)`);
  if (is('RateLimitError')) return new Error('Claude is getting too many requests from this key (429): try again in a moment');
  if (is('InternalServerError')) return new Error(`Claude had a server error (${err.status}): try again in a moment`);
  if (is('APIConnectionError')) return new Error(`Could not reach Claude (${err.message})`);
  if (is('APIError')) return new Error(`Claude answered ${err.status ?? 'with an error'}: ${err.message}`);
  return err instanceof Error ? err : new Error(String(err));
}

async function anthropicModels(settings, { signal, Anthropic: impl } = {}) {
  const { Anthropic, client } = anthropicClient(settings, impl);
  const ids = [];
  try {
    for await (const m of client.models.list({}, { signal })) ids.push(m.id);
  } catch (err) { throw anthropicError(Anthropic, err, ''); }
  return ids;
}

// The conversation in Claude's form: the system messages as the system
// prompt; the rest beginning with the user and ending with the user.
function anthropicMessages(messages) {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const rest = messages.filter((m) => m.role === 'user' || m.role === 'assistant').map((m) => ({ role: m.role, content: m.content }));
  if (!rest.length || rest[0].role !== 'user') rest.unshift({ role: 'user', content: '(The conversation so far follows.)' });
  if (rest.at(-1).role !== 'user') rest.push({ role: 'user', content: 'Go on.' });
  return { system, messages: rest };
}

async function anthropicChat(settings, messages, opts = {}) {
  const { signal, onDelta, onThinking } = opts;
  const { Anthropic, client } = anthropicClient(settings, opts.Anthropic);
  const model = String(settings.model ?? '').trim() || PROVIDERS.anthropic.defaultModel;
  const conv = anthropicMessages(messages);
  // A short answer asked for (maxTokens): a small cap, and no thinking asked
  // for. A model that thinks all the same may use the cap up before it
  // writes: it is then asked again without one (and not capped again).
  const capKey = `anthropic|${model}`;
  const cap = opts.maxTokens > 0 && !uncapped.has(capKey) ? Math.round(opts.maxTokens) : 0;
  const params = { model, max_tokens: cap || 64000, messages: conv.messages };
  if (conv.system) params.system = conv.system;
  if (anthropicAdaptive(model) && !cap) params.thinking = { type: 'adaptive', display: 'summarized' };
  let stopReason = '';
  let text = '';
  let thinking = '';
  let usage = null;
  try {
    const stream = ANTHROPIC_FALLBACK_MODELS.has(model)
      ? client.beta.messages.stream({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }, { signal })
      : client.messages.stream(params, { signal });
    for await (const event of stream) {
      if (event.type !== 'content_block_delta') continue;
      if (event.delta.type === 'text_delta') {
        const piece = text ? event.delta.text : event.delta.text.replace(/^\s+/, '');
        text += event.delta.text;
        if (piece) onDelta?.(piece);
      } else if (event.delta.type === 'thinking_delta') {
        thinking += event.delta.thinking;
        onThinking?.(event.delta.thinking);
      }
    }
    const final = await stream.finalMessage();
    usage = usageOf(final.usage);
    stopReason = final.stop_reason ?? '';
    if (final.stop_reason === 'refusal' && !text.trim()) throw new Error('Claude declined to answer this request');
  } catch (err) {
    if (signal?.aborted) {
      // Stopped part way: what came so far is the answer.
      if (text.trim()) return { text: text.trim(), thinking: thinking.trim(), model, stopped: true, usage };
      throw new Error('Stopped');
    }
    throw anthropicError(Anthropic, err, model);
  }
  if (!text.trim() && cap && stopReason === 'max_tokens') {
    uncapped.add(capKey);
    return anthropicChat(settings, messages, { ...opts, maxTokens: 0 });
  }
  if (!text.trim()) throw new Error('The model gave an empty answer');
  // truncated: the cap ended the answer before the model did.
  return { text: text.trim(), thinking: thinking.trim(), model, usage, truncated: stopReason === 'max_tokens' };
}

// Asks for commentary on the game: { summary, comments, model }.
async function annotate(settings, game, opts = {}) {
  if (PROVIDERS[providerOf(settings)].needsKey && !settings.key) throw new Error(`${who(settings)} needs an API key: add yours in Settings → AI`);
  if (PROVIDERS[providerOf(settings)].kind === 'anthropic') {
    const reply = await anthropicChat(settings, buildMessages(game), opts);
    return { ...parseReply(reply.text, (game.moves ?? []).length), model: reply.model, usage: reply.usage };
  }
  const model = await pickModel(settings, opts);
  const data = await call(`${baseOf(settings)}/chat/completions`, {
    method: 'POST', key: settings.key, name: who(settings), ...opts,
    body: { model, messages: buildMessages(game), ...temperatureFor(settings, 0.4), stream: false },
  });
  const msg = data.choices?.[0]?.message;
  const text = typeof msg?.content === 'string' ? msg.content : Array.isArray(msg?.content) ? msg.content.map((p) => p.text ?? '').join('') : '';
  if (!text.trim()) throw new Error('The model gave an empty answer');
  return { ...parseReply(text, (game.moves ?? []).length), model, usage: usageOf(data.usage) };
}

// A conversation: messages is the whole exchange so far (system, user,
// assistant…). The answer is streamed where the endpoint can (onDelta gets
// each piece of text as it comes) and returned whole: { text, model }.
// "Thinking" a model does aloud (<think>…</think>) is left out.
async function chat(settings, messages, opts = {}) {
  const { signal, onDelta, onThinking, sendImpl = send } = opts;
  if (PROVIDERS[providerOf(settings)].needsKey && !settings.key) throw new Error(`${who(settings)} needs an API key: add yours in Settings → AI`);
  if (PROVIDERS[providerOf(settings)].kind === 'anthropic') return anthropicChat(settings, messages, opts);
  const base = baseOf(settings);
  const name = who(settings);
  const model = await pickModel(settings, { signal, sendImpl });
  // The tokens the request took are asked for at the end of the stream
  // (stream_options); a server that does not know the option is asked again
  // without it, and remembered.
  const askUsage = !noUsageOption.has(base);
  // A short answer asked for (maxTokens): a cap on the tokens of the answer,
  // as OpenAI names it (max_completion_tokens) or as other servers do
  // (max_tokens). A server that refuses the option, or a model that thinks
  // the cap away before it writes anything, is asked again without it, and
  // remembered.
  const capKey = `${providerOf(settings)}|${base}|${model}`;
  let cap = opts.maxTokens > 0 && !uncapped.has(capKey) ? Math.round(opts.maxTokens) : 0;
  const capParam = providerOf(settings) === 'openai' ? 'max_completion_tokens' : 'max_tokens';
  let finish = '';
  const request = (withUsage) => {
    const payload = JSON.stringify({ model, messages, ...temperatureFor(settings, 0.5), ...(cap ? { [capParam]: cap } : {}), stream: true, ...(withUsage ? { stream_options: { include_usage: true } } : {}) });
    const headers = { Accept: 'text/event-stream, application/json', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) };
    if (settings.key) headers.Authorization = `Bearer ${settings.key}`;
    return sendImpl(`${base}/chat/completions`, { method: 'POST', headers, body: payload, signal, onData });
  };
  let usage = null;
  let raw = '';      // everything the model said, thinking included
  let shown = '';    // what has been passed on
  let pending = '';  // an unfinished line of the stream
  const visible = (t) => t.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*$/i, '').replace(/^\s+/, '');
  // The model's thinking aloud: a <think> block in the text, or the
  // reasoning some servers send beside it. Passed on apart from the answer.
  let reasoning = '';
  let thought = '';
  const thoughts = (t) => (reasoning + [...t.matchAll(/<think>([\s\S]*?)(?:<\/think>|$)/gi)].map((m) => m[1]).join('\n')).replace(/^\s+/, '');
  const feed = (text) => {
    raw += text;
    const th = thoughts(raw);
    if (th.length > thought.length && th.startsWith(thought)) onThinking?.(th.slice(thought.length));
    thought = th;
    const now = visible(raw);
    if (now.length > shown.length && now.startsWith(shown)) onDelta?.(now.slice(shown.length));
    shown = now;
  };
  // Whether the answer came as a stream (server-sent events): then it was
  // read as it came, even if all of it was thinking.
  let streamed = false;
  const readLines = (lines) => {
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const json = JSON.parse(data);
        if (json.usage) usage = usageOf(json.usage) ?? usage;
        if (json.choices?.[0]?.finish_reason) finish = json.choices[0].finish_reason;
        const delta = json.choices?.[0]?.delta;
        const think = delta?.reasoning_content ?? delta?.reasoning;
        if (typeof think === 'string' && think) { reasoning += think; feed(''); }
        if (typeof delta?.content === 'string' && delta.content) feed(delta.content);
      } catch { /* a line that is not JSON: skip it */ }
    }
  };
  const onData = (chunk, res) => {
    if (res.statusCode < 200 || res.statusCode >= 300) return;
    if (!/event-stream/i.test(res.headers['content-type'] ?? '')) return; // answered whole: read below
    streamed = true;
    pending += chunk.toString('utf8');
    const lines = pending.split(/\r?\n/);
    pending = lines.pop();
    readLines(lines);
  };
  let res;
  try {
    res = await request(askUsage);
    if (askUsage && (res.status === 400 || res.status === 422) && /stream_options|include_usage/i.test(res.text)) {
      noUsageOption.add(base);
      res = await request(false);
    }
    if (cap && (res.status === 400 || res.status === 422) && /max_(completion_)?tokens/i.test(res.text)) {
      uncapped.add(capKey);
      cap = 0;
      res = await request(askUsage && !noUsageOption.has(base));
    }
  } catch (err) {
    if (signal?.aborted) {
      // Stopped part way: what came so far is the answer.
      if (shown.trim()) return { text: shown.trim(), thinking: thought.trim(), model, stopped: true, usage };
      throw new Error('Stopped');
    }
    throw new Error(`Could not reach ${name === 'The AI endpoint' ? 'the AI endpoint' : name} at ${new URL(base).origin} (${err.code ?? err.message}).${name === 'The AI endpoint' ? ' Is the server running?' : ''}`);
  }
  if (res.status < 200 || res.status >= 300) {
    const detail = errorDetail(res.text);
    throw new Error(`${name} answered ${res.status}${res.status === 401 || res.status === 403 ? ' (check the API key in Settings → AI)' : ''}${detail ? `: ${detail}` : ''}`);
  }
  if (streamed && pending) readLines([pending]); // a last line without its line break
  if (!streamed && /^data:/m.test(res.text)) {
    // A stream all the same, sent without saying so (no text/event-stream).
    streamed = true;
    readLines(res.text.split(/\r?\n/));
  }
  if (!streamed) {
    // Not streamed: the whole answer is one JSON object.
    try {
      const whole = JSON.parse(res.text);
      const msg = whole.choices?.[0]?.message;
      finish = whole.choices?.[0]?.finish_reason ?? finish;
      const text = typeof msg?.content === 'string' ? msg.content : Array.isArray(msg?.content) ? msg.content.map((p) => p.text ?? '').join('') : '';
      const think = msg?.reasoning_content ?? msg?.reasoning;
      if (typeof think === 'string') reasoning += think;
      usage = usageOf(whole.usage) ?? usage;
      feed(text);
    } catch { throw new Error(`${name} did not answer in a form this app reads; is it an OpenAI-compatible API?`); }
  }
  // Nothing but thinking within the cap (a model that reasons first): asked
  // again without it. Some servers do not say why the answer ended.
  if (!shown.trim() && cap && (finish === 'length' || (!finish && thought.trim()))) {
    uncapped.add(capKey);
    return chat(settings, messages, { ...opts, maxTokens: 0 });
  }
  if (!shown.trim()) throw new Error(thought.trim() ? 'The model only thought aloud and gave no answer' : 'The model gave an empty answer');
  // truncated: the cap ended the answer before the model did.
  return { text: shown.trim(), thinking: thought.trim(), model, usage, truncated: finish === 'length' };
}

// --- The model's context window --------------------------------------------
// How many tokens the model can take in, where the provider says: Claude's
// Models API, Google's model information, and from a local server LM
// Studio's, llama.cpp's or Ollama's own report of the model as loaded.
// OpenAI does not say; null then (Settings → AI can give it).
async function contextWindow(settings, model, opts = {}) {
  const { sendImpl = send } = opts;
  const p = providerOf(settings);
  model = String(model ?? '').trim();
  if (!model) return null;
  const signal = opts.signal ?? AbortSignal.timeout(4000);
  const getJson = async (url, init = {}) => {
    try {
      const body = init.body ? JSON.stringify(init.body) : undefined;
      const headers = { Accept: 'application/json', ...(init.headers ?? {}) };
      if (body) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(body); }
      const res = await sendImpl(url, { method: init.method ?? 'GET', headers, body, signal });
      return res.status >= 200 && res.status < 300 ? JSON.parse(res.text) : null;
    } catch { return null; }
  };
  const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
  if (p === 'anthropic') {
    try {
      const { client } = anthropicClient(settings, opts.Anthropic);
      const m = await client.models.retrieve(model, {}, { signal });
      return num(m.max_input_tokens);
    } catch { return null; }
  }
  if (p === 'google') {
    if (!settings.key) return null;
    const m = await getJson(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}`, { headers: { 'x-goog-api-key': settings.key } });
    return num(m?.inputTokenLimit);
  }
  if (p === 'openai') return null;
  // A local or other server: what it says of the model it has loaded.
  const base = baseOf(settings);
  const origin = new URL(base).origin;
  const auth = settings.key ? { Authorization: `Bearer ${settings.key}` } : {};
  const lms = await getJson(`${origin}/api/v0/models/${encodeURIComponent(model)}`, { headers: auth });
  if (num(lms?.loaded_context_length ?? lms?.max_context_length)) return num(lms.loaded_context_length ?? lms.max_context_length);
  const props = await getJson(`${base.replace(/\/v1$/, '')}/props`, { headers: auth });
  if (num(props?.default_generation_settings?.n_ctx ?? props?.n_ctx)) return num(props.default_generation_settings?.n_ctx ?? props.n_ctx);
  const ps = await getJson(`${origin}/api/ps`, { headers: auth });
  const run = (ps?.models ?? []).find((m) => m.name === model || m.model === model || String(m.name).split(':')[0] === model);
  return num(run?.context_length);
}

// Text to speech, for reading the live commentary and the announcer aloud.
// The sound comes from one of these services, each with its own address,
// models, voices and API key:
// - OpenAI: POST /v1/audio/speech.
// - Google AI: Gemini's speech models through the Gemini API
//   (POST /v1beta/interactions), with the same kind of key as the AI chat's
//   Google AI (sent in the x-goog-api-key header, never in the address).
// - Claude: Anthropic offers no text-to-speech, so it is listed as
//   unavailable and never asked.
// - A server of your own that copies OpenAI's API (Kokoro-FastAPI,
//   openedai-speech, LocalAI, oMLX, …).
// Each returns the sound as bytes and its type, and the speed the sound is
// to be played at (1 when the service has made it at the speed asked for).
const OPENAI_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'];
const GEMINI_VOICES = ['Achernar', 'Achird', 'Algenib', 'Algieba', 'Alnilam', 'Aoede', 'Autonoe', 'Callirrhoe', 'Charon', 'Despina', 'Enceladus', 'Erinome', 'Fenrir', 'Gacrux', 'Iapetus', 'Kore', 'Laomedeia', 'Leda', 'Orus', 'Puck', 'Pulcherrima', 'Rasalgethi', 'Sadachbia', 'Sadaltager', 'Schedar', 'Sulafat', 'Umbriel', 'Vindemiatrix', 'Zephyr', 'Zubenelgenubi'];
const TTS_PROVIDERS = {
  openai: {
    name: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1', aiProvider: 'openai',
    model: 'gpt-4o-mini-tts', models: ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'], voice: 'alloy', voices: OPENAI_VOICES,
  },
  google: {
    name: 'Google AI (Gemini)', kind: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', aiProvider: 'google',
    model: 'gemini-3.8-flash-lite-tts', models: ['gemini-3.8-flash-lite-tts', 'gemini-3.8-flash-tts'], voice: 'Kore', voices: GEMINI_VOICES,
  },
  anthropic: {
    name: 'Claude (Anthropic)', unavailable: true,
    note: 'Anthropic offers no text-to-speech, so Claude cannot read aloud. Claude can still write the commentary, and OpenAI, Google AI or the computer’s own voice can read it.',
  },
  custom: { name: 'Your own server (OpenAI-compatible)', kind: 'openai' },
};
const TTS_DEFAULTS = { provider: 'openai', baseUrl: TTS_PROVIDERS.openai.baseUrl, model: TTS_PROVIDERS.openai.model, voice: TTS_PROVIDERS.openai.voice };
// The service of the settings. Settings from before there was a choice
// had only an address: OpenAI's (or none) is OpenAI, any other a server
// of your own.
function ttsProviderOf(t) {
  if (TTS_PROVIDERS[t?.provider]) return t.provider;
  return !t?.baseUrl || /api\.openai\.com/i.test(t.baseUrl) ? 'openai' : 'custom';
}
function speechBase(url) {
  let u = String(url ?? '').trim() || TTS_DEFAULTS.baseUrl;
  if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
  u = u.replace(/\/+$/, '');
  let parsed;
  try { parsed = new URL(u); } catch { throw new Error('The speech endpoint is not a web address'); }
  if (parsed.pathname === '' || parsed.pathname === '/') u += '/v1';
  return u.replace(/\/audio\/speech$/, '');
}
// The address asked: the service's own, or (for tests, and for a server of
// your own) the one given.
const ttsBase = (p, baseUrl) => (p === 'custom' || baseUrl ? speechBase(baseUrl) : TTS_PROVIDERS[p].baseUrl);
const ttsName = (p) => (p === 'custom' ? 'The speech server' : TTS_PROVIDERS[p].name.replace(/ \(.*\)$/, ''));

// What a service's refusal means, in words: the key, the quota, or the
// service itself.
function speechStatusError(name, status, detail) {
  const why = status === 401 || status === 403 ? `${name} refused the API key (${status}). Check the key in Settings → AI.`
    : status === 429 ? `${name} says there have been too many requests, or the account's quota is used up (429). Wait a little, or check the plan and billing of the account.`
      : status === 404 ? `${name} does not know this model or address (404). Choose another model in Settings → AI.`
        : status >= 500 ? `${name} had a problem of its own (${status}). Try again in a moment.`
          : `${name} answered ${status}.`;
  return new Error(detail ? `${why} It said: ${detail}` : why);
}
async function speechFetch(name, url, init, signal, fetchImpl) {
  try {
    return await fetchImpl(url, { ...init, signal });
  } catch (err) {
    if (signal?.aborted) throw new Error(signal.reason?.name === 'TimeoutError' ? `${name} took too long to answer.` : 'Stopped');
    throw new Error(`Could not reach ${name === 'The speech server' ? 'the speech server' : name} at ${new URL(url).origin} (${err.cause?.code ?? err.message}). Check the internet connection${name === 'The speech server' ? ', or whether the server is running' : ''}.`);
  }
}

async function speech(opts, text, { speed = 1, signal, fetchImpl = fetch } = {}) {
  const p = ttsProviderOf(opts);
  if (TTS_PROVIDERS[p].unavailable) throw new Error(TTS_PROVIDERS[p].note);
  if (TTS_PROVIDERS[p].kind === 'gemini') return geminiSpeech(opts, text, { speed, signal, fetchImpl });
  return openaiSpeech({ ...opts, provider: p }, text, { speed, signal, fetchImpl });
}

// OpenAI, and servers that copy its API: POST /audio/speech, answered with
// the sound itself.
async function openaiSpeech({ provider, baseUrl, model, voice, key, instructions }, text, { speed, signal, fetchImpl }) {
  const base = ttsBase(provider, baseUrl);
  const url = `${base}/audio/speech`;
  const name = ttsName(provider);
  const openai = provider === 'openai' || /api\.openai\.com/i.test(base);
  // None chosen: OpenAI's defaults at OpenAI; elsewhere the server's first
  // speech model, and its own default voice.
  if (!model && !openai) {
    model = (await speechModels({ provider, baseUrl: base, key }, { signal }).catch(() => ({ models: [] }))).models[0];
    if (!model) throw new Error('No speech model is chosen, and the speech server lists none: choose one in Settings → AI.');
  }
  model ||= TTS_PROVIDERS.openai.model;
  const body = { model, input: String(text).slice(0, 4096), response_format: 'mp3' };
  if (voice || openai) body.voice = voice || TTS_PROVIDERS.openai.voice;
  if (Number.isFinite(speed) && speed !== 1) body.speed = Math.min(4, Math.max(0.25, speed));
  // OpenAI's older models (tts-1, tts-1-hd) take no speaking style.
  if (instructions && !(openai && /^tts-1/.test(model))) body.instructions = String(instructions);
  const headers = { 'Content-Type': 'application/json', Accept: 'audio/*' };
  if (key) headers.Authorization = `Bearer ${key}`;
  const ask = () => speechFetch(name, url, { method: 'POST', headers, body: JSON.stringify(body) }, signal, fetchImpl);
  let res = await ask();
  // A server that cannot make MP3 is asked for WAV, which every one makes.
  if (res.status === 400 || res.status === 422 || res.status === 500) {
    const detail = await res.clone().text().catch(() => '');
    if (/mp3|format|codec|ffmpeg|encod/i.test(detail)) { body.response_format = 'wav'; res = await ask(); }
  }
  if (!res.ok) throw speechStatusError(name, res.status, errorDetail(await res.text().catch(() => '')));
  const type = (res.headers.get('content-type') || 'audio/mpeg').split(';')[0].trim();
  if (!/^audio\/|^application\/octet-stream$/.test(type)) {
    throw new Error(`${name} answered with ${type}, not sound. Is it an OpenAI-compatible speech API (…/v1/audio/speech)?`);
  }
  const data = new Uint8Array(await res.arrayBuffer());
  if (!data.length) throw new Error(`${name} answered with no sound.`);
  return { type: type === 'application/octet-stream' ? 'audio/mpeg' : type, data, playbackRate: 1 };
}

// Google AI: a Gemini speech model through the Interactions API. It
// answers in JSON with the sound in base64, WAV by default. It has no
// speed setting: the sound is played faster or slower instead. The
// speaking style goes in the style annotation.
async function geminiSpeech({ baseUrl, model, voice, key, instructions }, text, { speed, signal, fetchImpl }) {
  const g = TTS_PROVIDERS.google;
  const name = ttsName('google');
  if (!key) throw new Error('Google AI needs an API key: add one in Settings → AI.');
  const url = `${ttsBase('google', baseUrl)}/interactions`;
  const content = { type: 'text', text: String(text).slice(0, 4096) };
  if (instructions) content.annotations = [{ type: 'speech_metadata', style: String(instructions) }];
  const body = {
    model: model || g.model,
    input: [{ type: 'user_input', content: [content] }],
    response_format: { type: 'audio', mime_type: 'audio/wav' },
    generation_config: { speech_config: [{ voice: voice || g.voice }] },
  };
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json', 'x-goog-api-key': key };
  const res = await speechFetch(name, url, { method: 'POST', headers, body: JSON.stringify(body) }, signal, fetchImpl);
  const raw = await res.text().catch(() => '');
  if (!res.ok) throw speechStatusError(name, res.status, errorDetail(raw));
  let j;
  try { j = JSON.parse(raw); } catch { throw new Error(`${name} did not answer in JSON.`); }
  const audio = geminiAudioOf(j);
  if (!audio?.data) throw new Error(`${name} answered with no sound. Is the model a speech (TTS) model?`);
  let data = new Uint8Array(Buffer.from(audio.data, 'base64'));
  let type = String(audio.mime_type ?? audio.mimeType ?? 'audio/wav').toLowerCase();
  // Raw PCM (the older preview models' default) is given a WAV header.
  if (/^audio\/(l16|pcm)/.test(type)) {
    const rate = Number(/rate=(\d+)/.exec(type)?.[1]) || 24000;
    data = wavOf(data, rate);
    type = 'audio/wav';
  }
  if (!data.length) throw new Error(`${name} answered with no sound.`);
  return { type: type.split(';')[0], data, playbackRate: Number.isFinite(speed) && speed > 0 ? Math.min(4, Math.max(0.25, speed)) : 1 };
}
// The last sound in an interaction: in its model output steps, or as
// output_audio.
function geminiAudioOf(j) {
  if (j?.output_audio?.data) return j.output_audio;
  const parts = [];
  for (const s of j?.steps ?? j?.outputs ?? []) {
    if (s?.type === 'audio') parts.push(s);
    for (const c of s?.content ?? []) if (c?.type === 'audio') parts.push(c);
  }
  return parts.at(-1);
}
// 16-bit mono PCM, little-endian, as a WAV file.
function wavOf(pcm, rate) {
  const out = new Uint8Array(44 + pcm.length);
  const v = new DataView(out.buffer);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i); };
  str(0, 'RIFF'); v.setUint32(4, 36 + pcm.length, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}

// The service's speech models and the chosen model's voices. OpenAI's are
// known. Google AI is asked which of its models are speech models (the
// known ones when it lists none). A server of your own is asked
// (GET /models), its speech ones first when it says which, and its
// voices where it lists them (GET /audio/voices).
async function speechModels({ provider, baseUrl, key, model }, { signal, sendImpl, fetchImpl = fetch } = {}) {
  const p = ttsProviderOf({ provider, baseUrl });
  const known = TTS_PROVIDERS[p];
  if (known.unavailable) throw new Error(known.note);
  if (p === 'openai' && !baseUrl) return { models: known.models, voices: known.voices };
  if (p === 'google') {
    if (!key) throw new Error('Google AI needs an API key: add one in Settings → AI.');
    const res = await speechFetch('Google AI', `${ttsBase('google', baseUrl)}/models?pageSize=1000`, { headers: { Accept: 'application/json', 'x-goog-api-key': key } }, signal, fetchImpl);
    const raw = await res.text().catch(() => '');
    if (!res.ok) throw speechStatusError('Google AI', res.status, errorDetail(raw));
    let listed = [];
    try { listed = (JSON.parse(raw).models ?? []).map((m) => String(m.name ?? '').replace(/^models\//, '')).filter((id) => /tts/i.test(id)); } catch { /* none */ }
    return { models: [...new Set([...known.models, ...listed])], voices: known.voices };
  }
  const base = ttsBase(p, baseUrl);
  const opts = { key, signal, name: 'The speech server', ...(sendImpl ? { sendImpl } : {}) };
  const data = await call(`${base}/models`, opts);
  const entries = (Array.isArray(data) ? data : data.data ?? data.models ?? []).map((m) => (typeof m === 'string' ? { id: m } : m)).filter((m) => m.id ?? m.name);
  const idOf = (m) => String(m.id ?? m.name);
  // What the server says a model is for, when it says (oMLX, LocalAI…).
  const kindOf = (m) => [m.type, m.model_type, m.task, m.kind, m.engine_type, ...(Array.isArray(m.capabilities) ? m.capabilities : [])].filter(Boolean).join(' ').toLowerCase();
  const told = entries.filter((m) => kindOf(m));
  let speechy = told.length ? entries.filter((m) => /tts|speech|audio_out|text-to-speech|text_to_speech/.test(kindOf(m)) && !/stt|transcri/.test(kindOf(m))) : [];
  if (!speechy.length) speechy = entries.filter((m) => /tts|speech|kokoro|voice|piper|xtts|orpheus|bark|f5|melo|parler|chatterbox|dia\b|csm|sesame|marvis|spark|outetts|vibevoice|zonos|fish/i.test(idOf(m)) && !/transcri|whisper|stt\b|parakeet/i.test(idOf(m)));
  const models = [...new Set((speechy.length ? speechy : entries).map(idOf))].sort();
  return { models, voices: await speechVoices({ provider: p, baseUrl: base, key, model: model || models[0] }, { signal, sendImpl }) };
}
// The voices of a speech model: the known ones of OpenAI and Google AI, or
// those a server of your own lists (some, like oMLX, by model: ?model=…).
async function speechVoices({ provider, baseUrl, key, model }, { signal, sendImpl } = {}) {
  const p = ttsProviderOf({ provider, baseUrl });
  if (p === 'google' || (p === 'openai' && !baseUrl)) return TTS_PROVIDERS[p].voices;
  const base = ttsBase(p, baseUrl);
  if (/api\.openai\.com/i.test(base)) return OPENAI_VOICES;
  const opts = { key, signal, name: 'The speech server', ...(sendImpl ? { sendImpl } : {}) };
  for (const url of [model ? `${base}/audio/voices?model=${encodeURIComponent(model)}` : null, `${base}/audio/voices`].filter(Boolean)) {
    try {
      const v = await call(url, opts);
      const list = (Array.isArray(v) ? v : v.voices ?? v.data ?? []).map((x) => (typeof x === 'string' ? x : x.id ?? x.name ?? x.voice_id)).filter(Boolean).map(String);
      if (list.length) return [...new Set(list)].sort();
    } catch { /* not listed this way */ }
  }
  return [];
}

module.exports = { speechVoices, speechModels, speech, speechBase, TTS_DEFAULTS, TTS_PROVIDERS, ttsProviderOf, wavOf, chat, DEFAULTS, PROVIDERS, normalizeBase, buildMessages, parseReply, salvage, listModels, annotate, anthropicMessages, contextWindow, usageOf };
