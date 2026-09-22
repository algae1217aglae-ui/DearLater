# Dear Later

Dear Later is a small, headless service for writing a letter that cannot be opened until a chosen day.

It uses a [drand](https://drand.love/) future round through `tlock-js`. When a letter is sealed, the service stores ciphertext rather than plaintext. Before the opening date, API clients receive only safe metadata, envelope decoration, and a small shuffled set of characters. Once the round is available, the service decrypts the letter and replaces the ciphertext on disk with plaintext.

There is deliberately no frontend. Bring your own letterbox, time capsule, journal, game prop, or strange little object.

## What the core keeps

- A real opening date backed by a future drand round
- Paper, wax, and ink colors
- Sanitized inline SVG artwork for drawings or marks on the envelope
- Shuffled character fragments for an unreadable pre-opening hint
- Atomic JSON persistence
- Public responses that never include ciphertext
- A small JSON API with no accounts, framework, database, or build step

## Quick start

Dear Later requires Node.js 18 or newer.

```sh
npm install
npm start
```

The service listens on `http://127.0.0.1:4173` by default.

```sh
PORT=8080 npm start
```

On Windows PowerShell:

```powershell
$env:PORT = 8080
npm.cmd start
```

Set `DEAR_LATER_DATA` to move the JSON file. The default is `data/letters.json` inside the project.

## API

All API responses use JSON and `Cache-Control: no-store`.

### Health

```http
GET /api/health
```

```json
{ "ok": true }
```

### List letters

```http
GET /api/letters
```

This also attempts to unlock any due letters. Locked entries include `locked: true` and never include `text`, `cipher`, the drand round, or internal unlock errors. Opened entries include `text` and `locked: false`.

### Seal a letter

```http
POST /api/letters
Content-Type: application/json
```

```json
{
  "text": "Read this when the leaves return.",
  "date": "2027-03-20",
  "envelope": {
    "paper": "#d9e8c7",
    "wax": "#426b54",
    "ink": "#3f4a38",
    "art": "<svg viewBox=\"0 0 20 20\"><path d=\"M2 10 Q10 2 18 10\"/></svg>"
  }
}
```

Use either `date` in local `YYYY-MM-DD` form or an integer `days` from 1 to 1095. The date must be tomorrow or later and within three years. Letter text is limited to 20,000 Unicode characters. Request bodies are limited to 64 KiB.

Colors must be six-digit hex values. Invalid colors fall back to neutral defaults. SVG artwork is limited to 80 KB and is stripped of scripts, event handlers, external references, embedded images, links, styles, and foreign objects. Treat the sanitizer as a narrow decoration filter, not as a general-purpose HTML sanitizer.

### Delete a letter

```http
DELETE /api/letters/:id
```

Deletion removes the matching JSON entry. It is not a secure-erasure guarantee for disks, backups, or snapshots.

The root path intentionally returns a JSON 404. This project does not publish or serve a user interface.

## Connecting your own interface

The envelope fields are presentation hints, not a prescribed design system. A client can expose a drawing canvas, color swatches, stamps, or nothing at all. Before opening, use `fragments` only as deliberately incomplete visual noise. Do not try to reconstruct the letter from them.

```js
const response = await fetch('/api/letters', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    text: editor.value,
    date: openingDate.value,
    envelope: {
      paper: '#f3e6d0',
      wax: '#8f3545',
      ink: '#6b4a36',
      art: drawingAsSvg,
    },
  }),
});

if (!response.ok) {
  throw new Error((await response.json()).error);
}
```

## How the time lock works

`src/drand-lock.mjs` asks the drand mainnet client for chain information, converts the opening time to a future round, and encrypts the UTF-8 letter for that round. The secret needed to decrypt becomes publicly derivable only after the drand network publishes that round.

The server checks for due letters once a minute and whenever `GET /api/letters` is called. Successful decryption replaces `cipher` and `round` in the data file with `text` and `unlockedAt`.

## Security boundary

Dear Later is a single-user, self-hosted service. It is not multi-user end-to-end messaging.

- The server receives plaintext while handling `POST /api/letters` and holds it in memory during encryption.
- After sealing succeeds, the persisted letter contains ciphertext, not plaintext.
- Envelope metadata, dates, length, and shuffled fragments are stored in cleartext.
- After the opening time, plaintext is persisted so clients can read it.
- The API never returns ciphertext, but whoever controls the server or data file can modify the software or copy stored data.
- The API has no authentication. It binds to localhost by default; if you expose it, put authentication and TLS in front of it.
- Pre-opening confidentiality depends on the drand network, `tlock-js`, the selected cryptography, and the host not retaining plaintext elsewhere.
- Availability depends on network access to drand. A temporary drand or network failure delays opening; it does not erase the ciphertext.

Do not use Dear Later as the only copy of irreplaceable information.

## Data layout

Letters live in one JSON array. Writes go to a temporary file and are renamed into place. Local data files under `data/` are ignored by git.

The storage module can also be embedded directly:

```js
import { createLetterStore } from './src/letters.mjs';
import { createDrandLocker } from './src/drand-lock.mjs';
import { fileURLToPath } from 'node:url';

const store = createLetterStore({
  filePath: fileURLToPath(new URL('./data/letters.json', import.meta.url)),
  locker: createDrandLocker(),
});
```

## Tests

```sh
npm test
```

Tests use a deterministic fake locker and temporary directories. They do not write sample letters into the project data folder.

## License

MIT
