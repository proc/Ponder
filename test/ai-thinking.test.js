'use strict';
// The AI chat's thinking level (app/ai.js): which levels each model takes,
// and what each provider is sent for each level. No real service is asked:
// OpenAI-compatible requests go to a stand-in (sendImpl), Claude's to a
// stand-in for the Anthropic SDK, with a made-up key.
//   node --test test/
const test = require('node:test');
const assert = require('node:assert/strict');
const ai = require('../app/ai.js');

const FAKE_KEY = 'test-key-not-real';

// --- the levels a model takes -------------------------------------------------
test('levels: each model only those it takes, default first', () => {
  const L = (p, m) => ai.thinkingLevels(p, m).join(',');
  // Claude Opus 5.5 always thinks: no "off".
  assert.equal(L('anthropic', 'claude-opus-5-5'), 'default,low,medium,high,xhigh,max');
  assert.equal(L('anthropic', 'claude-fable-5-2'), 'default,low,medium,high,xhigh,max');
  assert.equal(L('anthropic', 'claude-sonnet-5-5'), 'default,off,low,medium,high,xhigh,max');
  assert.equal(L('anthropic', 'claude-opus-5'), 'default,off,low,medium,high,xhigh,max');
  assert.equal(L('anthropic', 'claude-haiku-5-5'), 'default,off,low,medium,high,xhigh,max');
  // 4.6: no "xhigh".
  assert.equal(L('anthropic', 'claude-sonnet-4-6'), 'default,off,low,medium,high,max');
  // Haiku 4.5 takes no effort: nothing to choose.
  assert.equal(L('anthropic', 'claude-haiku-4-5'), 'default');
  assert.equal(L('openai', 'gpt-5.1'), 'default,off,low,medium,high');
  assert.equal(L('openai', 'o3'), 'default,low,medium,high');
  assert.equal(L('openai', 'gpt-4o'), 'default');
  assert.equal(L('google', 'gemini-2.5-flash'), 'default,off,low,medium,high');
  assert.equal(L('google', 'gemini-3-pro'), 'default,low,medium,high');
  assert.equal(L('google', 'gemma-3-27b-it'), 'default');
  assert.equal(L('local', 'qwen3-8b'), 'off,minimal,low,medium,high,xhigh,max');
  // A level a model does not take is its default.
  assert.equal(ai.thinkingLevelFor('anthropic', 'claude-opus-5-5', 'off'), 'default');
  assert.equal(ai.thinkingLevelFor('openai', 'gpt-4o', 'high'), 'default');
});

// --- OpenAI-compatible servers ---------------------------------------------------
function server(...answers) {
  const seen = [];
  const sendImpl = async (url, { body }) => {
    seen.push({ url, body: JSON.parse(body) });
    const a = answers.length > 1 ? answers.shift() : answers[0];
    return { status: a.status ?? 200, text: JSON.stringify(a.json), headers: {} };
  };
  return { seen, sendImpl };
}
const said = (content) => ({ json: { choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] } });
const ask = async (settings, thinking, ...answers) => {
  const s = server(...(answers.length ? answers : [said('e4!')]));
  const out = await ai.chat(settings, [{ role: 'user', content: 'Best move?' }], { thinking, sendImpl: s.sendImpl });
  return { body: s.seen.at(-1).body, seen: s.seen, out };
};

test('OpenAI: reasoning_effort on reasoning models; "off" as each takes it', async () => {
  const gpt51 = { provider: 'openai', key: FAKE_KEY, model: 'gpt-5.1' };
  assert.equal((await ask(gpt51, 'high')).body.reasoning_effort, 'high');
  assert.equal((await ask(gpt51, 'low')).body.reasoning_effort, 'low');
  assert.equal((await ask(gpt51, 'off')).body.reasoning_effort, 'none');
  assert.equal((await ask({ ...gpt51, model: 'gpt-5' }, 'off')).body.reasoning_effort, 'minimal');
  assert.equal((await ask({ ...gpt51, model: 'o3' }, 'medium')).body.reasoning_effort, 'medium');
  // Default, and a model that does not reason: nothing sent.
  assert.equal((await ask(gpt51, 'default')).body.reasoning_effort, undefined);
  assert.equal((await ask({ ...gpt51, model: 'gpt-4o' }, 'high')).body.reasoning_effort, undefined);
  // No chat_template_kwargs to OpenAI.
  assert.equal((await ask(gpt51, 'high')).body.chat_template_kwargs, undefined);
});

test('Google: reasoning_effort through its OpenAI-compatible API', async () => {
  const flash = { provider: 'google', key: FAKE_KEY, model: 'gemini-2.5-flash' };
  const r = await ask(flash, 'medium');
  assert.match(r.seen[0].url, /generativelanguage\.googleapis\.com\/v1beta\/openai\/chat\/completions$/);
  assert.equal(r.body.reasoning_effort, 'medium');
  assert.equal((await ask(flash, 'off')).body.reasoning_effort, 'none');
  // A Pro model cannot stop thinking: "off" is its default, nothing sent.
  assert.equal((await ask({ ...flash, model: 'gemini-3-pro' }, 'off')).body.reasoning_effort, undefined);
});

test('a server of your own: enable_thinking and reasoning_effort as chosen, off by default', async () => {
  const local = { provider: 'local', baseUrl: 'http://127.0.0.1:9/v1', model: 'qwen3-8b' };
  for (const e of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']) assert.deepEqual((await ask(local, e)).body.chat_template_kwargs, { enable_thinking: true, reasoning_effort: e });
  // 'on', as saved before efforts: medium.
  assert.deepEqual((await ask(local, 'on')).body.chat_template_kwargs, { enable_thinking: true, reasoning_effort: 'medium' });
  assert.equal(ai.thinkingLevelFor('local', 'qwen3-8b', 'on'), 'medium');
  assert.equal(ai.thinkingLevelFor('local', 'qwen3-8b', 'default'), 'off');
  assert.deepEqual((await ask(local, 'off')).body.chat_template_kwargs, { enable_thinking: false, reasoning_effort: 'none' });
  assert.deepEqual((await ask(local, 'default')).body.chat_template_kwargs, { enable_thinking: false, reasoning_effort: 'none' });
  // The short requests (commentary, the engine's chat) choose nothing: off.
  assert.deepEqual((await ask(local, undefined)).body.chat_template_kwargs, { enable_thinking: false, reasoning_effort: 'none' });
  assert.equal((await ask(local, 'on')).body.reasoning_effort, undefined);
});

test('a server that refuses the level: asked again without it, and the answer says so', async () => {
  const gpt = { provider: 'openai', key: FAKE_KEY, model: 'gpt-5.1' };
  const r = await ask(gpt, 'high', { status: 400, json: { error: { message: "Unsupported value: 'reasoning_effort'" } } }, said('Nf3.'));
  assert.equal(r.seen.length, 2);
  assert.equal(r.seen[0].body.reasoning_effort, 'high');
  assert.equal(r.seen[1].body.reasoning_effort, undefined);
  assert.equal(r.out.text, 'Nf3.');
  assert.equal(r.out.levelIgnored, true);
  // Answered as asked: not marked.
  assert.equal((await ask(gpt, 'high')).out.levelIgnored, undefined);
});

// --- Claude, through a stand-in for the Anthropic SDK ---------------------------
function fakeAnthropic() {
  const sent = [];
  class Anthropic {
    constructor(opts) { this.opts = opts; }
    get messages() {
      return {
        stream: (params) => {
          sent.push(params);
          const events = [{ type: 'content_block_delta', delta: { type: 'text_delta', text: 'e4!' } }];
          return {
            async* [Symbol.asyncIterator]() { yield* events; },
            finalMessage: async () => ({ stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 2 } }),
          };
        },
      };
    }
    get beta() { return { messages: this.messages }; }
  }
  return { Anthropic, sent };
}
const claude = async (model, thinking) => {
  const f = fakeAnthropic();
  await ai.chat({ provider: 'anthropic', key: FAKE_KEY, model }, [{ role: 'user', content: 'Best move?' }], { thinking, Anthropic: f.Anthropic });
  return f.sent[0];
};

test('Claude: adaptive thinking with output_config.effort for each level', async () => {
  for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
    const p = await claude('claude-opus-5-5', level);
    assert.deepEqual(p.thinking, { type: 'adaptive', display: 'summarized' }, level);
    assert.deepEqual(p.output_config, { effort: level }, level);
    assert.equal(p.thinking.budget_tokens, undefined); // never the old budget
  }
  // 4.6 has no xhigh: asked at its default.
  const p46 = await claude('claude-opus-4-6', 'xhigh');
  assert.equal(p46.output_config, undefined);
});

test('Claude: "off" as each model takes it, never with an effort', async () => {
  // Opus 5 and Haiku 5.5, Opus 4.8/4.7 and Sonnet 5: disabled.
  for (const m of ['claude-opus-5', 'claude-haiku-5-5', 'claude-opus-4-8', 'claude-sonnet-5']) {
    const p = await claude(m, 'off');
    assert.deepEqual(p.thinking, { type: 'disabled' }, m);
    assert.equal(p.output_config, undefined, m);
  }
  // Sonnet 5.5: between_tools, with no other field.
  const s55 = await claude('claude-sonnet-5-5', 'off');
  assert.deepEqual(s55.thinking, { type: 'between_tools' });
  assert.equal(s55.output_config, undefined);
  // Opus 4.6: thinking left out.
  assert.equal((await claude('claude-opus-4-6', 'off')).thinking, undefined);
  // Opus 5.5 cannot stop thinking: its default (adaptive), not "disabled".
  const o55 = await claude('claude-opus-5-5', 'off');
  assert.deepEqual(o55.thinking, { type: 'adaptive', display: 'summarized' });
  assert.equal(o55.output_config, undefined);
});

test('Claude: default as before; Haiku 4.5 sent no thinking settings', async () => {
  assert.deepEqual((await claude('claude-opus-5-5', 'default')).thinking, { type: 'adaptive', display: 'summarized' });
  const h45 = await claude('claude-haiku-4-5', 'high');
  assert.equal(h45.thinking, undefined);
  assert.equal(h45.output_config, undefined);
});
