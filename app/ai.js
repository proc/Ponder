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
- Do not use curly braces or line breaks inside comments.`;

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
  if (!data || typeof data !== 'object') {
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
  let ids = (data.data ?? data.models ?? []).map((m) => m.id ?? m.name).filter(Boolean).map((id) => String(id).replace(/^models\//, ''));
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
  const params = { model, max_tokens: 64000, messages: conv.messages };
  if (conv.system) params.system = conv.system;
  if (anthropicAdaptive(model)) params.thinking = { type: 'adaptive', display: 'summarized' };
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
    if (final.stop_reason === 'refusal' && !text.trim()) throw new Error('Claude declined to answer this request');
  } catch (err) {
    if (signal?.aborted) {
      // Stopped part way: what came so far is the answer.
      if (text.trim()) return { text: text.trim(), thinking: thinking.trim(), model, stopped: true, usage };
      throw new Error('Stopped');
    }
    throw anthropicError(Anthropic, err, model);
  }
  if (!text.trim()) throw new Error('The model gave an empty answer');
  return { text: text.trim(), thinking: thinking.trim(), model, usage };
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
  const request = (withUsage) => {
    const payload = JSON.stringify({ model, messages, ...temperatureFor(settings, 0.5), stream: true, ...(withUsage ? { stream_options: { include_usage: true } } : {}) });
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
  const onData = (chunk, res) => {
    if (res.statusCode < 200 || res.statusCode >= 300) return;
    if (!/event-stream/i.test(res.headers['content-type'] ?? '')) return; // answered whole: read below
    pending += chunk.toString('utf8');
    const lines = pending.split(/\r?\n/);
    pending = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const json = JSON.parse(data);
        if (json.usage) usage = usageOf(json.usage) ?? usage;
        const delta = json.choices?.[0]?.delta;
        const think = delta?.reasoning_content ?? delta?.reasoning;
        if (typeof think === 'string' && think) { reasoning += think; feed(''); }
        if (typeof delta?.content === 'string' && delta.content) feed(delta.content);
      } catch { /* a line that is not JSON: skip it */ }
    }
  };
  let res;
  try {
    res = await request(askUsage);
    if (askUsage && (res.status === 400 || res.status === 422) && /stream_options|include_usage/i.test(res.text)) {
      noUsageOption.add(base);
      res = await request(false);
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
  if (!raw) {
    // Not streamed: the whole answer is one JSON object.
    try {
      const whole = JSON.parse(res.text);
      const msg = whole.choices?.[0]?.message;
      const text = typeof msg?.content === 'string' ? msg.content : Array.isArray(msg?.content) ? msg.content.map((p) => p.text ?? '').join('') : '';
      const think = msg?.reasoning_content ?? msg?.reasoning;
      if (typeof think === 'string') reasoning += think;
      usage = usageOf(whole.usage) ?? usage;
      feed(text);
    } catch { throw new Error(`${name} did not answer in a form this app reads; is it an OpenAI-compatible API?`); }
  }
  if (!shown.trim()) throw new Error('The model gave an empty answer');
  return { text: shown.trim(), thinking: thought.trim(), model, usage };
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

module.exports = { chat, DEFAULTS, PROVIDERS, normalizeBase, buildMessages, parseReply, listModels, annotate, anthropicMessages, contextWindow, usageOf };
