import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDrandLocker } from './src/drand-lock.mjs';
import { createLetterStore } from './src/letters.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const MAX_BODY_BYTES = 64 * 1024;
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(response, status, value, extraHeaders = {}) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  });
  response.end(body);
}

function readJson(request) {
  const type = String(request.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') {
    request.resume();
    return Promise.reject(new HttpError(415, 'request body must be application/json'));
  }
  return new Promise((resolveBody, reject) => {
    let bytes = 0;
    let rejected = false;
    const chunks = [];
    request.on('data', chunk => {
      if (rejected) return;
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        rejected = true;
        chunks.length = 0;
        reject(new HttpError(413, 'request body is too large'));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (rejected) return;
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

function parseList(value) {
  return String(value || '').split(',').map(item => item.trim()).filter(Boolean);
}

function hostnameOf(value) {
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

// Binding to 127.0.0.1 keeps other machines out, but not other web pages running in
// the same browser. Two checks close that gap: the Host header must name this machine
// (DNS rebinding sends a foreign name), and a browser Origin must be local or on the
// operator's allowlist (cross-site pages cannot plant or read letters).
function createGuard({ allowedOrigins = [], allowedHosts = [] } = {}) {
  const origins = new Set(allowedOrigins);
  const hosts = new Set(allowedHosts.map(host => host.toLowerCase()));

  function checkHost(request) {
    const host = String(request.headers.host || '').toLowerCase();
    const hostname = host && hostnameOf(`http://${host}`);
    if (!hostname) throw new HttpError(400, 'request must carry a Host header');
    if (LOCAL_HOSTNAMES.has(hostname) || hosts.has(hostname) || hosts.has(host)) return;
    throw new HttpError(421, 'request was addressed to a host this server does not answer for');
  }

  function checkOrigin(request) {
    const origin = request.headers.origin;
    if (origin == null) return null;
    const hostname = hostnameOf(origin);
    if (hostname && (LOCAL_HOSTNAMES.has(hostname) || origins.has(origin))) return origin;
    throw new HttpError(403, 'requests from that origin are not allowed');
  }

  return { checkHost, checkOrigin };
}

export function createDearLaterServer({ store, allowedOrigins, allowedHosts } = {}) {
  if (!store) throw new Error('store is required');
  const guard = createGuard({ allowedOrigins, allowedHosts });

  return createServer(async (request, response) => {
    let cors = {};
    try {
      guard.checkHost(request);
      const origin = guard.checkOrigin(request);
      if (origin) {
        cors = { 'access-control-allow-origin': origin, vary: 'origin' };
        if (request.method === 'OPTIONS') {
          response.writeHead(204, {
            ...cors,
            'access-control-allow-methods': 'GET, POST, DELETE',
            'access-control-allow-headers': 'content-type',
            'access-control-max-age': '600',
          });
          response.end();
          return;
        }
      }

      const url = new URL(request.url || '/', 'http://localhost');

      if (request.method === 'GET' && url.pathname === '/api/health') {
        sendJson(response, 200, { ok: true }, cors);
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/letters') {
        await store.unlockDue();
        sendJson(response, 200, { letters: await store.listPublic(), now: new Date().toISOString() }, cors);
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/letters') {
        const input = await readJson(request);
        try {
          const letter = await store.seal(input);
          sendJson(response, 201, { letter }, cors);
        } catch (error) {
          if (error?.status) throw error;
          throw new HttpError(400, String(error?.message ?? error));
        }
        return;
      }

      const letterMatch = /^\/api\/letters\/([^/]+)$/.exec(url.pathname);
      if (request.method === 'DELETE' && letterMatch) {
        let id;
        try {
          id = decodeURIComponent(letterMatch[1]);
        } catch {
          throw new HttpError(400, 'letter id is not valid');
        }
        const removed = await store.remove(id);
        if (!removed) throw new HttpError(404, 'letter not found');
        sendJson(response, 200, { ok: true }, cors);
        return;
      }

      throw new HttpError(404, 'not found');
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const status = Number.isInteger(error?.status) ? error.status : 500;
      const message = status >= 500 && status !== 507
        ? 'Dear Later could not complete that request'
        : String(error?.message ?? error);
      if (status === 500) console.error('[dearlater]', error);
      sendJson(response, status, { error: message }, {
        ...cors,
        ...(status === 413 || status === 415 ? { connection: 'close' } : {}),
      });
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
  const server = createDearLaterServer({
    store,
    allowedOrigins: parseList(process.env.DEAR_LATER_ORIGINS),
    allowedHosts: parseList(process.env.DEAR_LATER_HOSTS),
  });
  const timer = setInterval(() => store.unlockDue().catch(error => {
    console.error('[dearlater] unlock failed:', error.message);
  }), 60_000);
  timer.unref();
  server.listen(port, '127.0.0.1', () => {
    console.log(`Dear Later is waiting at http://127.0.0.1:${port}`);
  });
}
