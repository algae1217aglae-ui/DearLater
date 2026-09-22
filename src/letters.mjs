import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const DAY_MS = 86_400_000;
const MAX_BODY_LENGTH = 20_000;
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

function sanitizeSvg(svg) {
  let value = String(svg ?? '').trim();
  if (!value) return '';
  if (value.length > 80_000) throw new Error('envelope art must be 80KB or smaller');
  if (!/^<svg[\s>]/i.test(value) || !/<\/svg\s*>$/i.test(value)) {
    throw new Error('envelope art must be an SVG document');
  }
  value = value
    .replace(/<\?xml[\s\S]*?\?>/gi, '')
    .replace(/<(script|style|foreignObject|iframe|object|embed)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<\/?(script|style|foreignObject|iframe|object|embed|image|use|a)\b[^>]*>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s(?:href|xlink:href)\s*=\s*("[^"]*"|'[^']*')/gi, '')
    .replace(/url\(\s*['"]?(?!#)[^)]*\)/gi, 'none');
  if (!/\sxmlns=/.test(value)) {
    value = value.replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  }
  return value;
}

export function sanitizeEnvelope(value = {}) {
  return {
    paper: HEX.test(value.paper) ? value.paper : '#f3e6d0',
    wax: HEX.test(value.wax) ? value.wax : '#8f3545',
    ink: HEX.test(value.ink) ? value.ink : '#6b4a36',
    art: sanitizeSvg(value.art),
  };
}

function publicLetter(letter) {
  const { cipher, round, unlockError, ...safe } = letter;
  if (letter.text == null) delete safe.text;
  return { ...safe, locked: letter.text == null };
}

export function createLetterStore({ filePath, now = () => new Date(), locker, random = Math.random } = {}) {
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

  async function seal({ text, days, date, envelope } = {}) {
    const body = String(text ?? '').replace(/\r\n/g, '\n').trim();
    if (!body) throw new Error('letter cannot be empty');
    if ([...body].length > MAX_BODY_LENGTH) throw new Error('letter must be 20,000 characters or fewer');

    const createdAt = new Date(now());
    const openAt = computeOpenAt({ days, date }, createdAt);
    const { round, cipher } = await locker.lock(body, openAt);
    const letter = {
      id: randomUUID(),
      createdAt: createdAt.toISOString(),
      openAt: openAt.toISOString(),
      round,
      cipher,
      fragments: fragmentsOf(body, random),
      len: [...body].length,
      envelope: sanitizeEnvelope(envelope),
    };
    const letters = load();
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
        && new Date(letter.openAt).getTime() <= current);
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
            target.unlockError = String(error?.message ?? error).slice(0, 160);
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
        }
        save(latest);
      }
      return opened.map(result => publicLetter({ ...result, locked: false }));
    })().finally(() => { unlocking = null; });
    return unlocking;
  }

  async function listPublic() {
    return load().map(publicLetter).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
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
