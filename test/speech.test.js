'use strict';
// Tests for text to speech (app/ai.js: speech, speechModels, speechVoices):
// the requests made to OpenAI, Google AI and a server of your own, and what
// is made of their answers. Every request goes to a fake server on this
// computer, with a made-up key: no real service is asked.
//   node --test test/
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const ai = require('../app/ai.js');

const FAKE_KEY = 'test-key-not-real';
const WAV_HEADER = 'RIFF';

// A fake server: each request is recorded, and answered by `reply`.
async function fakeServer(reply) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const r = { method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null };
      seen.push(r);
      reply(r, res);
    });
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, seen, close: () => new Promise((ok) => server.close(ok)) };
}
const json = (res, status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

test('OpenAI: POST /audio/speech with the model, voice, style and speed, the key as a bearer token', async () => {
  const srv = await fakeServer((_r, res) => { res.writeHead(200, { 'Content-Type': 'audio/mpeg' }); res.end(Buffer.from('ID3fake-mp3')); });
  try {
    const out = await ai.speech({ provider: 'openai', baseUrl: `${srv.base}/v1`, model: 'gpt-4o-mini-tts', voice: 'verse', instructions: 'lively', key: FAKE_KEY }, 'Nf3!', { speed: 1.5 });
    const r = srv.seen[0];
    assert.equal(r.method, 'POST');
    assert.equal(r.url, '/v1/audio/speech');
    assert.equal(r.headers.authorization, `Bearer ${FAKE_KEY}`);
    assert.deepEqual(r.body, { model: 'gpt-4o-mini-tts', input: 'Nf3!', response_format: 'mp3', voice: 'verse', speed: 1.5, instructions: 'lively' });
    assert.equal(out.type, 'audio/mpeg');
    assert.equal(Buffer.from(out.data).toString(), 'ID3fake-mp3');
    assert.equal(out.playbackRate, 1);
  } finally { await srv.close(); }
});

test('OpenAI: the defaults when nothing is chosen, and no style for tts-1', async () => {
  const srv = await fakeServer((_r, res) => { res.writeHead(200, { 'Content-Type': 'audio/mpeg' }); res.end('x'); });
  try {
    await ai.speech({ provider: 'openai', baseUrl: `${srv.base}/v1`, key: FAKE_KEY }, 'hello');
    assert.equal(srv.seen[0].body.model, 'gpt-4o-mini-tts');
    assert.equal(srv.seen[0].body.voice, 'alloy');
    await ai.speech({ provider: 'openai', baseUrl: `${srv.base}/v1`, model: 'tts-1', instructions: 'calm', key: FAKE_KEY }, 'hello');
    assert.equal(srv.seen[1].body.instructions, undefined);
  } finally { await srv.close(); }
});

test('Google AI: POST /interactions with the key in x-goog-api-key, never in the address', async () => {
  const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(40)]);
  const srv = await fakeServer((_r, res) => json(res, 200, {
    steps: [{ type: 'model_output', content: [{ type: 'audio', mime_type: 'audio/wav', data: wav.toString('base64') }] }],
  }));
  try {
    const out = await ai.speech({ provider: 'google', baseUrl: `${srv.base}/v1beta`, model: 'gemini-3.8-flash-tts', voice: 'Puck', instructions: 'excited', key: FAKE_KEY }, 'Mate in two.', { speed: 1.25 });
    const r = srv.seen[0];
    assert.equal(r.url, '/v1beta/interactions');
    assert.equal(r.headers['x-goog-api-key'], FAKE_KEY);
    assert.equal(r.headers.authorization, undefined);
    assert.ok(!r.url.includes(FAKE_KEY));
    assert.equal(r.body.model, 'gemini-3.8-flash-tts');
    assert.deepEqual(r.body.input, [{ type: 'user_input', content: [{ type: 'text', text: 'Mate in two.', annotations: [{ type: 'speech_metadata', style: 'excited' }] }] }]);
    assert.deepEqual(r.body.generation_config, { speech_config: [{ voice: 'Puck' }] });
    assert.deepEqual(r.body.response_format, { type: 'audio', mime_type: 'audio/wav' });
    assert.equal(out.type, 'audio/wav');
    assert.equal(Buffer.from(out.data).subarray(0, 4).toString(), WAV_HEADER);
    // Gemini has no speed setting: the sound is played faster instead.
    assert.equal(out.playbackRate, 1.25);
  } finally { await srv.close(); }
});

test('Google AI: the default model and voice; raw PCM is given a WAV header', async () => {
  const pcm = Buffer.alloc(480);
  const srv = await fakeServer((_r, res) => json(res, 200, { output_audio: { mime_type: 'audio/L16;codec=pcm;rate=24000', data: pcm.toString('base64') } }));
  try {
    const out = await ai.speech({ provider: 'google', baseUrl: `${srv.base}/v1beta`, key: FAKE_KEY }, 'e4');
    assert.equal(srv.seen[0].body.model, 'gemini-3.8-flash-lite-tts');
    assert.deepEqual(srv.seen[0].body.generation_config.speech_config, [{ voice: 'Kore' }]);
    assert.equal(srv.seen[0].body.input[0].content[0].annotations, undefined);
    assert.equal(out.type, 'audio/wav');
    assert.equal(out.data.length, 44 + pcm.length);
    const v = new DataView(out.data.buffer);
    assert.equal(v.getUint32(24, true), 24000);
  } finally { await srv.close(); }
});

test('Google AI: no key is refused before anything is sent', async () => {
  await assert.rejects(ai.speech({ provider: 'google', baseUrl: 'http://127.0.0.1:9/v1beta' }, 'x'), /needs an API key/);
});

test('Claude: unavailable, and never asked', async () => {
  let asked = false;
  await assert.rejects(ai.speech({ provider: 'anthropic', key: FAKE_KEY }, 'x', { fetchImpl: () => { asked = true; } }), /Anthropic offers no text-to-speech/);
  await assert.rejects(ai.speechModels({ provider: 'anthropic', key: FAKE_KEY }), /Anthropic offers no text-to-speech/);
  assert.equal(asked, false);
  assert.equal(ai.TTS_PROVIDERS.anthropic.unavailable, true);
});

test('errors in words: a refused key, the quota, the service, the network', async () => {
  for (const [status, re] of [[401, /refused the API key \(401\)/], [403, /refused the API key \(403\)/], [429, /quota is used up \(429\)/], [503, /problem of its own \(503\)/]]) {
    const srv = await fakeServer((_r, res) => json(res, status, { error: { message: 'fake detail' } }));
    try {
      await assert.rejects(ai.speech({ provider: 'openai', baseUrl: `${srv.base}/v1`, key: FAKE_KEY }, 'x'), (err) => re.test(err.message) && /fake detail/.test(err.message));
      await assert.rejects(ai.speech({ provider: 'google', baseUrl: `${srv.base}/v1beta`, key: FAKE_KEY }, 'x'), (err) => re.test(err.message) && /^Google AI/.test(err.message));
    } finally { await srv.close(); }
  }
  // Nothing listens on port 9 (discard): the connection is refused.
  await assert.rejects(ai.speech({ provider: 'openai', baseUrl: 'http://127.0.0.1:9/v1', key: FAKE_KEY }, 'x'), /Could not reach OpenAI/);
  // The key never appears in an error.
  const srv = await fakeServer((_r, res) => json(res, 401, { error: { message: 'bad' } }));
  try {
    await assert.rejects(ai.speech({ provider: 'google', baseUrl: `${srv.base}/v1beta`, key: FAKE_KEY }, 'x'), (err) => !err.message.includes(FAKE_KEY));
  } finally { await srv.close(); }
});

test('Google AI: an answer with no sound is an error', async () => {
  const srv = await fakeServer((_r, res) => json(res, 200, { steps: [{ type: 'model_output', content: [{ type: 'text', text: 'hi' }] }] }));
  try {
    await assert.rejects(ai.speech({ provider: 'google', baseUrl: `${srv.base}/v1beta`, key: FAKE_KEY }, 'x'), /no sound/);
  } finally { await srv.close(); }
});

test('models and voices: OpenAI known, Google asked for its speech models, a server of your own asked', async () => {
  const openai = await ai.speechModels({ provider: 'openai', key: FAKE_KEY });
  assert.deepEqual(openai.models, ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd']);
  assert.ok(openai.voices.includes('verse'));

  const g = await fakeServer((r, res) => json(res, 200, { models: [{ name: 'models/gemini-3.8-flash' }, { name: 'models/gemini-3.8-flash-tts' }, { name: 'models/gemini-9-pro-tts' }] }));
  try {
    const out = await ai.speechModels({ provider: 'google', baseUrl: `${g.base}/v1beta`, key: FAKE_KEY });
    assert.equal(g.seen[0].headers['x-goog-api-key'], FAKE_KEY);
    assert.ok(!g.seen[0].url.includes(FAKE_KEY));
    assert.deepEqual(out.models, ['gemini-3.8-flash-lite-tts', 'gemini-3.8-flash-tts', 'gemini-9-pro-tts']);
    assert.ok(out.voices.includes('Kore'));
  } finally { await g.close(); }

  const c = await fakeServer((r, res) => {
    if (r.url === '/v1/models') json(res, 200, { data: [{ id: 'kokoro' }, { id: 'whisper-1' }] });
    else if (r.url.startsWith('/v1/audio/voices')) json(res, 200, { voices: ['af_bella', 'am_adam'] });
    else json(res, 404, {});
  });
  try {
    const out = await ai.speechModels({ provider: 'custom', baseUrl: c.base });
    assert.deepEqual(out, { models: ['kokoro'], voices: ['af_bella', 'am_adam'] });
  } finally { await c.close(); }
});

test('a server of your own: its first speech model when none is chosen, no key needed', async () => {
  const srv = await fakeServer((r, res) => {
    if (r.url === '/v1/models') json(res, 200, { data: [{ id: 'kokoro' }] });
    else if (r.url === '/v1/audio/speech') { res.writeHead(200, { 'Content-Type': 'audio/wav' }); res.end('RIFFxxxx'); } else json(res, 404, {});
  });
  try {
    const out = await ai.speech({ provider: 'custom', baseUrl: srv.base }, 'hello');
    const r = srv.seen.find((x) => x.url === '/v1/audio/speech');
    assert.equal(r.body.model, 'kokoro');
    assert.equal(r.body.voice, undefined);
    assert.equal(r.headers.authorization, undefined);
    assert.equal(out.type, 'audio/wav');
  } finally { await srv.close(); }
});

test('settings from before the choice: OpenAI\'s address (or none) is OpenAI, any other a server of your own', () => {
  assert.equal(ai.ttsProviderOf({}), 'openai');
  assert.equal(ai.ttsProviderOf({ baseUrl: 'https://api.openai.com/v1' }), 'openai');
  assert.equal(ai.ttsProviderOf({ baseUrl: 'http://localhost:8880/v1' }), 'custom');
  assert.equal(ai.ttsProviderOf({ provider: 'google', baseUrl: 'http://localhost:8880/v1' }), 'google');
});
