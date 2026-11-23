'use strict';
// A cap on the answer's tokens in app/ai.js chat() (opts.maxTokens), as the
// engine's chat asks for short messages: named as each kind of server takes
// it, dropped for a server that refuses it, and for a model that thinks the
// whole cap away before it writes. No real service is asked: the requests
// go to a stand-in (sendImpl), with a made-up key.
//   node --test test/
const test = require('node:test');
const assert = require('node:assert/strict');
const ai = require('../app/ai.js');

const FAKE_KEY = 'test-key-not-real';
// A stand-in server: answers whole (not streamed), from a list in turn.
function server(...answers) {
  const seen = [];
  const sendImpl = async (url, { body }) => {
    seen.push({ url, body: JSON.parse(body) });
    const a = answers.length > 1 ? answers.shift() : answers[0]; // the last one again and again
    return { status: a.status ?? 200, text: typeof a.json === 'string' ? a.json : JSON.stringify(a.json), headers: {} };
  };
  return { seen, sendImpl };
}
const said = (content, finish = 'stop') => ({ json: { choices: [{ message: { role: 'assistant', content }, finish_reason: finish }] } });

test('OpenAI: the cap as max_completion_tokens', async () => {
  const s = server(said('Bold knight!'));
  const out = await ai.chat({ provider: 'openai', key: FAKE_KEY, model: 'model-a' }, [{ role: 'user', content: 'hi' }], { maxTokens: 100, sendImpl: s.sendImpl });
  assert.equal(s.seen[0].body.max_completion_tokens, 100);
  assert.equal(s.seen[0].body.max_tokens, undefined);
  assert.equal(out.text, 'Bold knight!');
  assert.equal(out.truncated, false);
});

test('another server: the cap as max_tokens; none when not asked for', async () => {
  const s = server(said('Bold knight!'));
  await ai.chat({ provider: 'local', baseUrl: 'http://127.0.0.1:9/v1', model: 'model-b' }, [{ role: 'user', content: 'hi' }], { maxTokens: 100, sendImpl: s.sendImpl });
  assert.equal(s.seen[0].body.max_tokens, 100);
  await ai.chat({ provider: 'local', baseUrl: 'http://127.0.0.1:9/v1', model: 'model-b' }, [{ role: 'user', content: 'hi' }], { sendImpl: s.sendImpl });
  assert.equal(s.seen[1].body.max_tokens, undefined);
});

test('an answer the cap ended is marked truncated', async () => {
  const s = server(said('Ahoy, that knight leaps like', 'length'));
  const out = await ai.chat({ provider: 'local', baseUrl: 'http://127.0.0.1:9/v1', model: 'model-c' }, [{ role: 'user', content: 'hi' }], { maxTokens: 100, sendImpl: s.sendImpl });
  assert.equal(out.truncated, true);
});

test('a model that thinks the cap away: asked again without it, and not capped again', async () => {
  const s = server(said('', 'length'), said('Bold knight!'), said('Again.'));
  const settings = { provider: 'openai', key: FAKE_KEY, model: 'thinker-1' };
  const out = await ai.chat(settings, [{ role: 'user', content: 'hi' }], { maxTokens: 100, sendImpl: s.sendImpl });
  assert.equal(out.text, 'Bold knight!');
  assert.equal(s.seen.length, 2);
  assert.equal(s.seen[0].body.max_completion_tokens, 100);
  assert.equal(s.seen[1].body.max_completion_tokens, undefined);
  await ai.chat(settings, [{ role: 'user', content: 'hi' }], { maxTokens: 100, sendImpl: s.sendImpl });
  assert.equal(s.seen[2].body.max_completion_tokens, undefined);
});

test('a server that refuses the option: asked again without it', async () => {
  const s = server({ status: 400, json: { error: { message: "Unsupported parameter: 'max_tokens'" } } }, said('Bold knight!'));
  const out = await ai.chat({ provider: 'local', baseUrl: 'http://127.0.0.1:9/v1', model: 'model-d' }, [{ role: 'user', content: 'hi' }], { maxTokens: 100, sendImpl: s.sendImpl });
  assert.equal(out.text, 'Bold knight!');
  assert.equal(s.seen[1].body.max_tokens, undefined);
});

// A stand-in server that streams (server-sent events): each answer is a list
// of events; type is the content type it says, if any.
function streamer(...answers) {
  const seen = [];
  const sendImpl = async (url, { body, onData }) => {
    seen.push({ url, body: JSON.parse(body) });
    const a = answers.length > 1 ? answers.shift() : answers[0];
    const text = a.events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
    const res = { statusCode: 200, headers: a.type === undefined ? { 'content-type': 'text/event-stream' } : a.type ? { 'content-type': a.type } : {} };
    // In two pieces, cut mid-line, as a network would.
    const cut = Math.floor(text.length / 2);
    onData?.(Buffer.from(text.slice(0, cut)), res);
    onData?.(Buffer.from(text.slice(cut)), res);
    return { status: 200, text, headers: res.headers };
  };
  return { seen, sendImpl };
}
const think = (t) => ({ choices: [{ delta: { reasoning_content: t } }] });
const word = (t) => ({ choices: [{ delta: { content: t } }] });
const end = (why) => ({ choices: [{ delta: {}, finish_reason: why }] });

test('a thinking model that streams only its thinking within the cap: asked again without it', async () => {
  const s = streamer(
    { events: [think('The user wants a short hello. '), think('Let me think about the knight…'), end('length')] },
    { events: [think('Short and friendly.'), word('Good luck, '), word('have fun!'), end('stop')] },
  );
  const out = await ai.chat({ provider: 'local', baseUrl: 'http://127.0.0.1:9/v1', model: 'qwen-thinker' }, [{ role: 'user', content: 'hi' }], { maxTokens: 100, sendImpl: s.sendImpl });
  assert.equal(out.text, 'Good luck, have fun!');
  assert.equal(out.thinking, 'Short and friendly.');
  assert.equal(s.seen.length, 2);
  assert.equal(s.seen[0].body.max_tokens, 100);
  assert.equal(s.seen[1].body.max_tokens, undefined);
});

test('thinking only, and the server does not say why it stopped: asked again without the cap', async () => {
  const s = streamer({ events: [think('Hmm…')] }, { events: [word('Hello!')] });
  const out = await ai.chat({ provider: 'local', baseUrl: 'http://127.0.0.1:9/v1', model: 'quiet-thinker' }, [{ role: 'user', content: 'hi' }], { maxTokens: 100, sendImpl: s.sendImpl });
  assert.equal(out.text, 'Hello!');
  assert.equal(s.seen.length, 2);
});

test('a stream sent without saying so (no text/event-stream) is read all the same', async () => {
  for (const type of [null, 'text/plain; charset=utf-8', 'application/json']) {
    const s = streamer({ type, events: [word('Bold '), word('knight!'), end('stop')] });
    const out = await ai.chat({ provider: 'local', baseUrl: 'http://127.0.0.1:9/v1', model: `loose-${type}` }, [{ role: 'user', content: 'hi' }], { maxTokens: 100, sendImpl: s.sendImpl });
    assert.equal(out.text, 'Bold knight!', String(type));
  }
});

test('a model that never gets past its thinking, even uncapped: said plainly', async () => {
  const s = streamer({ events: [think('Still thinking…'), end('stop')] });
  await assert.rejects(
    ai.chat({ provider: 'local', baseUrl: 'http://127.0.0.1:9/v1', model: 'stuck-thinker' }, [{ role: 'user', content: 'hi' }], { sendImpl: s.sendImpl }),
    /only thought aloud and gave no answer/);
});

test('a local server is asked to render the chat template without thinking; OpenAI is not', async () => {
  const s = server(said('Bold knight!'));
  await ai.chat({ provider: 'local', baseUrl: 'http://127.0.0.1:9/v1', model: 'model-t' }, [{ role: 'user', content: 'hi' }], { sendImpl: s.sendImpl });
  assert.deepEqual(s.seen[0].body.chat_template_kwargs, { enable_thinking: false, reasoning_effort: 'none' });
  await ai.chat({ provider: 'openai', key: FAKE_KEY, model: 'model-t' }, [{ role: 'user', content: 'hi' }], { sendImpl: s.sendImpl });
  assert.equal(s.seen[1].body.chat_template_kwargs, undefined);
});
