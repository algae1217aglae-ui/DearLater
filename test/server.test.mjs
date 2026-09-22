import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLetterStore } from '../src/letters.mjs';
import { createDearLaterServer } from '../server.mjs';

async function harness({ withPublicDir = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dearlater-server-'));
  const publicDir = join(dir, 'public');
  if (withPublicDir) {
    mkdirSync(publicDir, { recursive: true });
    writeFileSync(join(publicDir, 'index.html'), '<!doctype html><title>private skin</title>', 'utf8');
  }
  const locker = {
    async lock(text, openAt) {
      return { round: Math.floor(openAt.getTime() / 1000), cipher: `secret:${text}` };
    },
    async unlock(cipher) { return cipher.replace(/^secret:/, ''); },
  };
  const store = createLetterStore({ filePath: join(dir, 'letters.json'), locker });
  const server = createDearLaterServer({ store, ...(withPublicDir ? { publicDir } : {}) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;

  async function json(path, options = {}) {
    const response = await fetch(base + path, {
      ...options,
      headers: { 'content-type': 'application/json', ...(options.headers || {}) },
      body: options.body == null || typeof options.body === 'string'
        ? options.body
        : JSON.stringify(options.body),
    });
    const payload = await response.json();
    return { response, payload };
  }

  return {
    base,
    json,
    async close() {
      await new Promise(resolve => server.close(resolve));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('creates, lists, and deletes a sealed letter without exposing ciphertext', async t => {
  const h = await harness();
  t.after(() => h.close());

  const created = await h.json('/api/letters', {
    method: 'POST',
    body: { text: 'future hello', days: 3, envelope: { paper: '#f3e6d0' } },
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.payload.letter.locked, true);
  assert.equal(JSON.stringify(created.payload).includes('secret:'), false);

  const listed = await h.json('/api/letters');
  assert.equal(listed.response.status, 200);
  assert.equal(listed.payload.letters.length, 1);
  assert.equal(JSON.stringify(listed.payload).includes('cipher'), false);

  const removed = await h.json(`/api/letters/${created.payload.letter.id}`, { method: 'DELETE' });
  assert.equal(removed.response.status, 200);
  assert.equal((await h.json('/api/letters')).payload.letters.length, 0);
});

test('returns useful client errors for invalid input and missing letters', async t => {
  const h = await harness();
  t.after(() => h.close());

  const invalid = await h.json('/api/letters', {
    method: 'POST',
    body: { text: '', days: 3 },
  });
  assert.equal(invalid.response.status, 400);
  assert.match(invalid.payload.error, /empty/i);

  const missing = await h.json('/api/letters/not-here', { method: 'DELETE' });
  assert.equal(missing.response.status, 404);
  assert.match(missing.payload.error, /not found/i);
});

test('stays headless and serves only the API', async t => {
  const h = await harness({ withPublicDir: true });
  t.after(() => h.close());

  const page = await fetch(h.base + '/');
  assert.equal(page.status, 404);
  assert.match((await page.json()).error, /not found/i);

  const health = await fetch(h.base + '/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await health.json(), { ok: true });

  const traversal = await fetch(h.base + '/..%2Fletters.json');
  assert.equal(traversal.status, 404);
});

test('keeps safe envelope colors and drawing data available without exposing the body', async t => {
  const h = await harness();
  t.after(() => h.close());

  const created = await h.json('/api/letters', {
    method: 'POST',
    body: {
      text: 'draw around this',
      days: 3,
      envelope: {
        paper: '#d9e8c7',
        wax: '#426b54',
        ink: '#3f4a38',
        art: '<svg viewBox="0 0 20 20"><path d="M2 10 Q10 2 18 10"/></svg>',
      },
    },
  });

  assert.equal(created.response.status, 201);
  assert.equal(created.payload.letter.envelope.paper, '#d9e8c7');
  assert.match(created.payload.letter.envelope.art, /^<svg xmlns=/);
  assert.equal(created.payload.letter.text, undefined);
  assert.equal(created.payload.letter.cipher, undefined);
});

test('rejects request bodies larger than the configured limit', async t => {
  const h = await harness();
  t.after(() => h.close());
  const response = await fetch(h.base + '/api/letters', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'x'.repeat(70_000), days: 3 }),
  });
  assert.equal(response.status, 413);
});
