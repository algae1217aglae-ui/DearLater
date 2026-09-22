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
});
