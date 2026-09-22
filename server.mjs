import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDrandLocker } from './src/drand-lock.mjs';
import { createLetterStore } from './src/letters.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const MAX_BODY_BYTES = 64 * 1024;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

function readJson(request) {
  return new Promise((resolveBody, reject) => {
    let bytes = 0;
    const chunks = [];
    request.on('data', chunk => {
      bytes += chunk.length;
      if (bytes <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    request.on('end', () => {
      if (bytes > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'request body is too large'));
        return;
      }
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolveBody(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new HttpError(400, 'request body must be valid JSON'));
      }
    });
    request.on('error', reject);
  });
}

export function createDearLaterServer({ store } = {}) {
  if (!store) throw new Error('store is required');

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', 'http://localhost');

      if (request.method === 'GET' && url.pathname === '/api/health') {
        sendJson(response, 200, { ok: true });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/letters') {
        await store.unlockDue();
        sendJson(response, 200, { letters: await store.listPublic(), now: new Date().toISOString() });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/letters') {
        const input = await readJson(request);
        try {
          const letter = await store.seal(input);
          sendJson(response, 201, { letter });
        } catch (error) {
          if (error?.status) throw error;
          throw new HttpError(400, String(error?.message ?? error));
        }
        return;
      }

      const letterMatch = /^\/api\/letters\/([^/]+)$/.exec(url.pathname);
      if (request.method === 'DELETE' && letterMatch) {
        const removed = await store.remove(decodeURIComponent(letterMatch[1]));
        if (!removed) throw new HttpError(404, 'letter not found');
        sendJson(response, 200, { ok: true });
        return;
      }

      throw new HttpError(404, 'not found');
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const status = Number.isInteger(error?.status) ? error.status : 500;
      const message = status >= 500 ? 'Dear Later could not complete that request' : String(error?.message ?? error);
      sendJson(response, status, { error: message });
    }
  });
}

function isMainModule() {
  if (!process.argv[1]) return false;
  return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  const port = Number.parseInt(process.env.PORT || '4173', 10);
  const filePath = resolve(process.env.DEAR_LATER_DATA || join(ROOT, 'data', 'letters.json'));
  const store = createLetterStore({ filePath, locker: createDrandLocker() });
  const server = createDearLaterServer({ store });
  const timer = setInterval(() => store.unlockDue().catch(error => {
    console.error('[dearlater] unlock failed:', error.message);
  }), 60_000);
  timer.unref();
  server.listen(port, '127.0.0.1', () => {
    console.log(`Dear Later is waiting at http://127.0.0.1:${port}`);
  });
}
