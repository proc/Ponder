'use strict';
// AI commentary: the game is sent to an OpenAI-compatible chat endpoint
// (oMLX, LM Studio, Ollama, llama.cpp, vLLM, or a hosted one) that is asked
// for commentary as JSON, which becomes annotations on the moves. Nothing
// here touches Electron, so it can be run and tested with plain Node.

const DEFAULTS = { baseUrl: 'http://localhost:8000/v1', model: '' };

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
    game.white || game.black ? `White: ${game.white || '?'}\nBlack: ${game.black || '?'}\nResult: ${game.result || '*'}` : '',
    `Moves:\n${list}`,
    `PGN:\n${String(game.pgn ?? '').trim()}`,
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

async function call(url, { method = 'GET', body, key, signal, sendImpl = send }) {
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
    if (signal?.aborted) throw new Error(signal.reason?.name === 'TimeoutError' ? 'The AI endpoint took too long to answer' : 'Stopped');
    throw new Error(`Could not reach the AI endpoint at ${new URL(url).origin} (${err.code ?? err.message}). Is the server running?`);
  }
  const { status, text } = res;
  if (status < 200 || status >= 300) {
    let detail = text.slice(0, 300);
    try { const j = JSON.parse(text); detail = j.error?.message ?? j.error ?? j.message ?? detail; } catch { /* as it is */ }
    throw new Error(`The AI endpoint answered ${status}${detail ? `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  }
  try { return JSON.parse(text); } catch { throw new Error('The AI endpoint did not answer in JSON; is it an OpenAI-compatible API?'); }
}

// The models the endpoint offers, by id.
async function listModels(settings, opts = {}) {
  const base = normalizeBase(settings.baseUrl);
  const data = await call(`${base}/models`, { key: settings.key, ...opts });
  return (data.data ?? data.models ?? []).map((m) => m.id ?? m.name).filter(Boolean);
}

// Asks for commentary on the game: { summary, comments, model }.
async function annotate(settings, game, opts = {}) {
  const base = normalizeBase(settings.baseUrl);
  let model = String(settings.model ?? '').trim();
  if (!model) {
    let models = [];
    try { models = await listModels(settings, opts); } catch (err) {
      if (/Stopped|too long|Could not reach/.test(err.message)) throw err;
    }
    model = models[0] ?? '';
    if (!model) throw new Error('The AI endpoint lists no model: set the model’s name in Settings → AI');
  }
  const data = await call(`${base}/chat/completions`, {
    method: 'POST', key: settings.key, ...opts,
    body: { model, messages: buildMessages(game), temperature: 0.4, stream: false },
  });
  const msg = data.choices?.[0]?.message;
  const text = typeof msg?.content === 'string' ? msg.content : Array.isArray(msg?.content) ? msg.content.map((p) => p.text ?? '').join('') : '';
  if (!text.trim()) throw new Error('The model gave an empty answer');
  return { ...parseReply(text, (game.moves ?? []).length), model };
}

// A conversation: messages is the whole exchange so far (system, user,
// assistant…). The answer is streamed where the endpoint can (onDelta gets
// each piece of text as it comes) and returned whole: { text, model }.
// "Thinking" a model does aloud (<think>…</think>) is left out.
async function chat(settings, messages, opts = {}) {
  const { signal, onDelta, onThinking, sendImpl = send } = opts;
  const base = normalizeBase(settings.baseUrl);
  let model = String(settings.model ?? '').trim();
  if (!model) {
    let models = [];
    try { models = await listModels(settings, { signal, sendImpl }); } catch (err) {
      if (/Stopped|too long|Could not reach/.test(err.message)) throw err;
    }
    model = models[0] ?? '';
    if (!model) throw new Error('The AI endpoint lists no model: set the model’s name in Settings → AI');
  }
  const payload = JSON.stringify({ model, messages, temperature: 0.5, stream: true });
  const headers = { Accept: 'text/event-stream, application/json', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) };
  if (settings.key) headers.Authorization = `Bearer ${settings.key}`;
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
        const delta = JSON.parse(data).choices?.[0]?.delta;
        const think = delta?.reasoning_content ?? delta?.reasoning;
        if (typeof think === 'string' && think) { reasoning += think; feed(''); }
        if (typeof delta?.content === 'string' && delta.content) feed(delta.content);
      } catch { /* a line that is not JSON: skip it */ }
    }
  };
  let res;
  try {
    res = await sendImpl(`${base}/chat/completions`, { method: 'POST', headers, body: payload, signal, onData });
  } catch (err) {
    if (signal?.aborted) {
      // Stopped part way: what came so far is the answer.
      if (shown.trim()) return { text: shown.trim(), thinking: thought.trim(), model, stopped: true };
      throw new Error('Stopped');
    }
    throw new Error(`Could not reach the AI endpoint at ${new URL(base).origin} (${err.code ?? err.message}). Is the server running?`);
  }
  if (res.status < 200 || res.status >= 300) {
    let detail = res.text.slice(0, 300);
    try { const j = JSON.parse(res.text); detail = j.error?.message ?? j.error ?? j.message ?? detail; } catch { /* as it is */ }
    throw new Error(`The AI endpoint answered ${res.status}${detail ? `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  }
  if (!raw) {
    // Not streamed: the whole answer is one JSON object.
    try {
      const msg = JSON.parse(res.text).choices?.[0]?.message;
      const text = typeof msg?.content === 'string' ? msg.content : Array.isArray(msg?.content) ? msg.content.map((p) => p.text ?? '').join('') : '';
      const think = msg?.reasoning_content ?? msg?.reasoning;
      if (typeof think === 'string') reasoning += think;
      feed(text);
    } catch { throw new Error('The AI endpoint did not answer in a form this app reads; is it an OpenAI-compatible API?'); }
  }
  if (!shown.trim()) throw new Error('The model gave an empty answer');
  return { text: shown.trim(), thinking: thought.trim(), model };
}

module.exports = { chat, DEFAULTS, normalizeBase, buildMessages, parseReply, listModels, annotate };
