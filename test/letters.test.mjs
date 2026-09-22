import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  computeOpenAt,
  createLetterStore,
  fragmentsOf,
  sanitizeEnvelope,
} from '../src/letters.mjs';

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'dearlater-'));
  const filePath = join(dir, 'letters.json');
  let current = new Date(2026, 8, 22, 10, 30, 0);
  let unlockCalls = 0;
  const locker = {
    async lock(text, openAt) {
      return { round: Math.floor(openAt.getTime() / 1000), cipher: `locked:${text}` };
    },
    async unlock(cipher) {
      unlockCalls += 1;
      return cipher.replace(/^locked:/, '');
    },
  };
  const store = createLetterStore({
    filePath,
    now: () => new Date(current),
    locker,
    random: () => 0.25,
  });
  return {
    dir,
    filePath,
    store,
    setNow(value) { current = new Date(value); },
    get unlockCalls() { return unlockCalls; },
    cleanup() { rmSync(dir, { recursive: true, force: true }); },
  };
}

test('computeOpenAt uses local midnight and rejects impossible dates', () => {
  const now = new Date(2026, 8, 22, 10, 30, 0);
  const openAt = computeOpenAt({ days: 3 }, now);
  assert.deepEqual(
    [openAt.getFullYear(), openAt.getMonth() + 1, openAt.getDate(), openAt.getHours()],
    [2026, 9, 25, 0],
  );
  assert.throws(() => computeOpenAt({ date: '2026-02-30' }, now), /real date/i);
  assert.throws(() => computeOpenAt({ date: '2026-09-22' }, now), /tomorrow/i);
});

test('fragments are unique letters or numbers and never reconstruct the body', () => {
  const fragments = fragmentsOf('Dear, later! 112233 -- hello.', () => 0.4);
  assert.equal(new Set(fragments).size, fragments.length);
  assert.ok(fragments.every(char => /[\p{L}\p{N}]/u.test(char)));
  assert.ok(fragments.length <= 24);
  assert.notEqual(fragments.join(''), 'Dearlater112233hello');
});

test('fragments never reveal every distinct character of a short letter', () => {
  assert.deepEqual(fragmentsOf('hi', () => 0.4), []);
  assert.deepEqual(fragmentsOf('aaaa', () => 0.4), []);

  const fragments = fragmentsOf('cat', () => 0.4);
  assert.ok(fragments.length < new Set('cat').size);
});

test('sanitizeEnvelope accepts safe colors and removes active SVG content', () => {
  const envelope = sanitizeEnvelope({
    paper: '#f1e4cc',
    wax: '#7c2438',
    ink: 'red',
    art: '<svg onload="alert(1)"><script>alert(2)</script><path d="M0 0" onclick="x()"/></svg>',
  });
  assert.equal(envelope.paper, '#f1e4cc');
  assert.equal(envelope.wax, '#7c2438');
  assert.equal(envelope.ink, '#6b4a36');
  assert.match(envelope.art, /^<svg xmlns=/);
  assert.doesNotMatch(envelope.art, /script|onload|onclick/i);
});

test('seal stores ciphertext and redacts both ciphertext and plaintext publicly', async t => {
  const h = harness();
  t.after(() => h.cleanup());

  const created = await h.store.seal({
    text: 'hello later',
    days: 3,
    envelope: { paper: '#f1e4cc', wax: '#7c2438' },
  });

  assert.equal(created.text, undefined);
  assert.equal(created.cipher, undefined);
  assert.equal(created.locked, true);
  const disk = JSON.parse(readFileSync(h.filePath, 'utf8'))[0];
  assert.equal(disk.text, undefined);
  assert.equal(disk.cipher, 'locked:hello later');
  assert.equal(JSON.stringify(await h.store.listPublic()).includes('locked:hello later'), false);
});

test('unlockDue waits for the opening time, then replaces ciphertext with plaintext', async t => {
  const h = harness();
  t.after(() => h.cleanup());

  const created = await h.store.seal({ text: 'not yet', days: 3, envelope: {} });
  assert.deepEqual(await h.store.unlockDue(), []);
  assert.equal(h.unlockCalls, 0);

  h.setNow(new Date(created.openAt).getTime() + 1000);
  const opened = await h.store.unlockDue();
  assert.equal(opened.length, 1);
  assert.equal(opened[0].text, 'not yet');
  assert.equal(h.unlockCalls, 1);

  const disk = JSON.parse(readFileSync(h.filePath, 'utf8'))[0];
  assert.equal(disk.text, 'not yet');
  assert.equal(disk.cipher, undefined);
  assert.equal((await h.store.listPublic())[0].locked, false);
});

test('remove deletes exactly one matching letter', async t => {
  const h = harness();
  t.after(() => h.cleanup());
  const first = await h.store.seal({ text: 'first', days: 3, envelope: {} });
  await h.store.seal({ text: 'second', days: 4, envelope: {} });

  assert.equal(await h.store.remove(first.id), true);
  assert.equal(await h.store.remove('missing'), false);
  assert.deepEqual((await h.store.listPublic()).map(letter => letter.len), [6]);
});

test('seal rejects empty and oversized letters', async t => {
  const h = harness();
  t.after(() => h.cleanup());
  await assert.rejects(() => h.store.seal({ text: '   ', days: 3 }), /empty/i);
  await assert.rejects(() => h.store.seal({ text: 'x'.repeat(20_001), days: 3 }), /20,000/i);
  await assert.rejects(() => h.store.seal(null), /JSON object/i);
  await assert.rejects(() => h.store.seal([1, 2]), /JSON object/i);
});

test('envelope art is rebuilt from an allowlist: only drawing elements and plain attributes survive', () => {
  const drawing = '<svg viewBox="0 0 20 20" width="40"><g transform="rotate(10 10 10)"><path d="M2 10 Q10 2 18 10" stroke="#3f4a38" stroke-width="1.5" fill="none"/><circle cx="10" cy="10" r="3" fill="currentColor"/></g></svg>';
  assert.equal(
    sanitizeEnvelope({ art: drawing }).art,
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width="40"><g transform="rotate(10 10 10)"><path d="M2 10 Q10 2 18 10" stroke="#3f4a38" stroke-width="1.5" fill="none"/><circle cx="10" cy="10" r="3" fill="currentColor"/></g></svg>',
  );

  // Unknown elements, unknown attributes, text nodes, comments, CDATA and
  // processing instructions never reach the output, whatever they contain.
  const noisy = [
    '<svg>',
    '<?xml version="1.0"?>',
    '<!-- note -->',
    '<![CDATA[ note ]]>',
    '<mystery custom="1"><rect width="4" height="4"/></mystery>',
    '<rect width="4" height="4" custom="1" data-x="2"/>',
    'loose words',
    '<path d="M0 0" fill="named-thing"/>',
    '</svg>',
  ].join('');
  assert.equal(
    sanitizeEnvelope({ art: noisy }).art,
    '<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4"/><rect width="4" height="4"/><path d="M0 0" fill="named-thing"/></svg>',
  );

  // Attribute values are limited to numbers, colors, path data and transform lists.
  for (const value of ['a:b', 'a;b', 'a/b', 'a&b', 'a"b', "a'b", 'a<b', 'a>b', 'a=b', 'a!b']) {
    const out = sanitizeEnvelope({ art: `<svg><rect width="4" fill="${value.replace(/"/g, "'")}"/></svg>` }).art;
    assert.equal(out, '<svg xmlns="http://www.w3.org/2000/svg"><rect width="4"/></svg>', value);
  }

  // Element and attribute names are matched whole, not by prefix, and closing
  // tags are balanced from the rebuilt structure rather than copied.
  assert.equal(
    sanitizeEnvelope({ art: '<svg><g><g><rect width="1"/></g></svg>' }).art,
    '<svg xmlns="http://www.w3.org/2000/svg"><g><g><rect width="1"/></g></g></svg>',
  );
  assert.equal(
    sanitizeEnvelope({ art: '<svg><pathway d="M0 0"/><path dd="M0 0" d="M1 1"/></svg>' }).art,
    '<svg xmlns="http://www.w3.org/2000/svg"><path d="M1 1"/></svg>',
  );

  assert.throws(() => sanitizeEnvelope({ art: '<div>hi</div>' }), /SVG document/i);
  assert.throws(() => sanitizeEnvelope({ art: `<svg>${'<path d="M0 0"/>'.repeat(6_000)}</svg>` }), /80KB/i);
  assert.equal(sanitizeEnvelope(null).paper, '#f3e6d0');
  assert.equal(sanitizeEnvelope('nope').art, '');
});

test('envelope art filter stays fast on hostile input', () => {
  const hostile = [
    `<svg>${'<g>'.repeat(12_000)}</svg>`,
    `<svg>${'<g a="<g a="'.repeat(6_000)}</svg>`,
    `<svg>${'<path d="M0 0" custom=x '.repeat(3_000)}</svg>`,
    `<svg><path d="${'M0 0 '.repeat(13_000)}"/></svg>`,
    `<svg>${'<'.repeat(40_000)}</svg>`,
  ];
  for (const art of hostile) {
    const started = performance.now();
    sanitizeEnvelope({ art });
    assert.ok(performance.now() - started < 500, `took too long on ${art.slice(0, 30)}...`);
  }
});

test('unlock failures back off instead of retrying on every call', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dearlater-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let current = new Date(2026, 8, 22, 10, 30, 0);
  let unlockCalls = 0;
  const store = createLetterStore({
    filePath: join(dir, 'letters.json'),
    now: () => new Date(current),
    locker: {
      async lock(text) { return { round: 1, cipher: `locked:${text}` }; },
      async unlock() { unlockCalls += 1; throw new Error('drand is away'); },
    },
  });
  const created = await store.seal({ text: 'stuck', days: 1 });
  current = new Date(new Date(created.openAt).getTime() + 1000);

  assert.deepEqual(await store.unlockDue(), []);
  assert.equal(unlockCalls, 1);
  await store.unlockDue();
  assert.equal(unlockCalls, 1, 'a second call inside the backoff window must not hit the locker');

  current = new Date(current.getTime() + 61_000);
  await store.unlockDue();
  assert.equal(unlockCalls, 2);
  current = new Date(current.getTime() + 61_000);
  await store.unlockDue();
  assert.equal(unlockCalls, 2, 'the second retry waits two minutes');

  const publicView = (await store.listPublic())[0];
  assert.equal(publicView.locked, true);
  assert.equal(publicView.retryAt, undefined);
  assert.equal(publicView.unlockAttempts, undefined);
  assert.equal(publicView.unlockError, undefined);
});

test('the letter box refuses to grow past maxLetters', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dearlater-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = createLetterStore({
    filePath: join(dir, 'letters.json'),
    maxLetters: 2,
    locker: {
      async lock(text) { return { round: 1, cipher: `locked:${text}` }; },
      async unlock(cipher) { return cipher.slice(7); },
    },
  });
  await store.seal({ text: 'one', days: 1 });
  await store.seal({ text: 'two', days: 1 });
  await assert.rejects(() => store.seal({ text: 'three', days: 1 }), error => error.status === 507);
});
