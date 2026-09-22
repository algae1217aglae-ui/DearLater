import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const DAY_MS = 86_400_000;
const MAX_BODY_LENGTH = 20_000;
const MAX_ART_LENGTH = 80_000;
const DEFAULT_MAX_LETTERS = 5_000;
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 6 * 60 * 60_000;
const HEX = /^#[0-9a-f]{6}$/i;

function localMidnight(value) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function realLocalDate(year, month, day) {
  const value = new Date(year, month - 1, day);
  return value.getFullYear() === year
    && value.getMonth() === month - 1
    && value.getDate() === day;
}

export function computeOpenAt({ days, date } = {}, now = new Date()) {
  const current = new Date(now);
  if (Number.isNaN(current.getTime())) throw new Error('now must be a valid date');

  let openAt;
  if (date != null && date !== '') {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date));
    if (!match) throw new Error('date must use YYYY-MM-DD');
    const [, y, m, d] = match.map(Number);
    if (!realLocalDate(y, m, d)) throw new Error('date must be a real date');
    openAt = new Date(y, m - 1, d);
  } else {
    const count = Number(days);
    if (!Number.isInteger(count) || count < 1 || count > 1_095) {
      throw new Error('days must be an integer from 1 to 1095');
    }
    openAt = localMidnight(current);
    openAt.setDate(openAt.getDate() + count);
  }

  const tomorrow = localMidnight(current);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (openAt < tomorrow) throw new Error('opening date must be tomorrow or later');
  if (openAt.getTime() - current.getTime() > 1_096 * DAY_MS) {
    throw new Error('opening date must be within three years');
  }
  return openAt;
}

export function fragmentsOf(text, random = Math.random) {
  const chars = [...new Set([...String(text)].filter(char => /[\p{L}\p{N}]/u.test(char)))];
  if (chars.length < 3) return [];
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  const count = Math.min(24, chars.length - 1, Math.max(1, Math.ceil(chars.length * 0.22)));
  return chars.slice(0, count);
}

// The envelope art filter is an allowlist, not a blocklist. Only plain drawing
// elements with plain geometric or paint attributes survive, and the SVG is rebuilt
// from scratch so nothing from the input is copied verbatim. Text nodes, comments,
// processing instructions, unknown tags, and unknown attributes are all dropped.
const SVG_ELEMENTS = new Set(['svg', 'g', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon']);
const SVG_ATTRIBUTES = new Set([
  'viewBox', 'width', 'height', 'preserveAspectRatio',
  'd', 'points', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry',
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-linecap',
  'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-miterlimit',
  'stroke-opacity', 'opacity', 'transform', 'vector-effect', 'paint-order',
]);
// Numbers, lengths, colors, path data, and transform lists only. Quotes, entities,
// URLs, colons, semicolons, and angle brackets can never appear in a kept value.
const SVG_VALUE = /^[\w\s.,#%()+-]*$/;
// Attribute names and unquoted values stop at "<" so a broken tag can never make the
// scanner re-read the rest of the document from every "<" it meets.
const SVG_TOKEN = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<[!?][^>]*>|<(\/?)([A-Za-z][\w:-]*)((?:\s+[^\s=<>\/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s<>]+))?)*)\s*(\/?)>|[^<]+|</g;
const SVG_ATTRIBUTE = /([^\s=<>\/"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s<>]+)))?/g;

function rebuildSvg(source) {
  const out = [];
  const open = [];
  for (const match of source.matchAll(SVG_TOKEN)) {
    const [, closing, rawName, rawAttributes, selfClosing] = match;
    if (!rawName) continue;
    const name = rawName.toLowerCase();
    if (!SVG_ELEMENTS.has(name)) continue;
    if (closing) {
      const depth = open.lastIndexOf(name);
      if (depth < 0) continue;
      while (open.length > depth) out.push(`</${open.pop()}>`);
      continue;
    }
    const attributes = [];
    if (name === 'svg') attributes.push('xmlns="http://www.w3.org/2000/svg"');
    for (const attribute of rawAttributes.matchAll(SVG_ATTRIBUTE)) {
      const key = attribute[1];
      const value = attribute[2] ?? attribute[3] ?? attribute[4] ?? '';
      if (!SVG_ATTRIBUTES.has(key) || !SVG_VALUE.test(value)) continue;
      attributes.push(`${key}="${value}"`);
    }
    const head = `<${name}${attributes.length ? ' ' + attributes.join(' ') : ''}`;
    if (selfClosing) {
      out.push(`${head}/>`);
    } else {
      out.push(`${head}>`);
      open.push(name);
    }
  }
  while (open.length) out.push(`</${open.pop()}>`);
  return out.join('');
}

export function sanitizeSvg(svg) {
  const value = String(svg ?? '').trim();
  if (!value) return '';
  if (value.length > MAX_ART_LENGTH) throw new Error('envelope art must be 80KB or smaller');
  if (!/^<svg[\s>]/i.test(value) || !/<\/svg\s*>$/i.test(value)) {
    throw new Error('envelope art must be an SVG document');
  }
  const rebuilt = rebuildSvg(value);
  if (!rebuilt.startsWith('<svg')) throw new Error('envelope art must be an SVG document');
  return rebuilt;
}

export function sanitizeEnvelope(value = {}) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    paper: HEX.test(input.paper) ? input.paper : '#f3e6d0',
    wax: HEX.test(input.wax) ? input.wax : '#8f3545',
    ink: HEX.test(input.ink) ? input.ink : '#6b4a36',
    art: sanitizeSvg(input.art),
  };
}

function publicLetter(letter) {
  const { cipher, round, unlockError, unlockAttempts, retryAt, ...safe } = letter;
  if (letter.text == null) delete safe.text;
  return { ...safe, locked: letter.text == null };
}

function fullError(maxLetters) {
  const error = new Error(`the letter box holds at most ${maxLetters} letters`);
  error.status = 507;
  return error;
}

export function createLetterStore({
  filePath,
  now = () => new Date(),
  locker,
  random = Math.random,
  maxLetters = DEFAULT_MAX_LETTERS,
} = {}) {
  if (!filePath) throw new Error('filePath is required');
  if (!locker || typeof locker.lock !== 'function' || typeof locker.unlock !== 'function') {
    throw new Error('locker with lock and unlock functions is required');
  }

  function load() {
    if (!existsSync(filePath)) return [];
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error('letter data must be an array');
    return parsed;
  }

  function save(letters) {
    mkdirSync(dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(letters, null, 2)}\n`, 'utf8');
    renameSync(temporary, filePath);
  }

  let unlocking = null;

  async function seal(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('request body must be a JSON object');
    }
    const { text, days, date, envelope } = input;
    const body = String(text ?? '').replace(/\r\n/g, '\n').trim();
    if (!body) throw new Error('letter cannot be empty');
    if ([...body].length > MAX_BODY_LENGTH) throw new Error('letter must be 20,000 characters or fewer');

    const createdAt = new Date(now());
    const openAt = computeOpenAt({ days, date }, createdAt);
    const safeEnvelope = sanitizeEnvelope(envelope);
    if (load().length >= maxLetters) throw fullError(maxLetters);

    const { round, cipher } = await locker.lock(body, openAt);
    const letter = {
      id: randomUUID(),
      createdAt: createdAt.toISOString(),
      openAt: openAt.toISOString(),
      round,
      cipher,
      fragments: fragmentsOf(body, random),
      len: [...body].length,
      envelope: safeEnvelope,
    };
    const letters = load();
    if (letters.length >= maxLetters) throw fullError(maxLetters);
    letters.push(letter);
    save(letters);
    return publicLetter(letter);
  }

  async function unlockDue() {
    if (unlocking) return unlocking;
    unlocking = (async () => {
      const current = new Date(now()).getTime();
      const due = load().filter(letter => letter.text == null
        && letter.cipher
        && new Date(letter.openAt).getTime() <= current
        && (letter.retryAt == null || new Date(letter.retryAt).getTime() <= current));
      if (!due.length) return [];

      const opened = [];
      for (const letter of due) {
        try {
          const text = await locker.unlock(letter.cipher);
          opened.push({ id: letter.id, text, unlockedAt: new Date(now()).toISOString() });
        } catch (error) {
          const latest = load();
          const target = latest.find(item => item.id === letter.id);
          if (target) {
            const attempts = (target.unlockAttempts || 0) + 1;
            const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempts - 1));
            target.unlockError = String(error?.message ?? error).slice(0, 160);
            target.unlockAttempts = attempts;
            target.retryAt = new Date(new Date(now()).getTime() + delay).toISOString();
            save(latest);
          }
        }
      }

      if (opened.length) {
        const latest = load();
        for (const result of opened) {
          const target = latest.find(letter => letter.id === result.id);
          if (!target) continue;
          target.text = result.text;
          target.unlockedAt = result.unlockedAt;
          delete target.cipher;
          delete target.round;
          delete target.unlockError;
          delete target.unlockAttempts;
          delete target.retryAt;
        }
        save(latest);
      }
      return opened.map(result => publicLetter({ ...result, locked: false }));
    })().finally(() => { unlocking = null; });
    return unlocking;
  }

  async function listPublic() {
    return load().map(publicLetter).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  async function remove(id) {
    const letters = load();
    const index = letters.findIndex(letter => letter.id === id);
    if (index < 0) return false;
    letters.splice(index, 1);
    save(letters);
    return true;
  }

  return { listPublic, seal, unlockDue, remove };
}
