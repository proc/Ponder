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
