// The playground's pure parts: projects (files), share links, the saved version history and the messages to and from
// the frame. No DOM here, so tests/playground.test.js runs it in Node. docs/playground.md explains each limit and its
// sources.

/** Largest `#code=` payload a link may carry, in characters (base64url of the deflated project). */
export const MAX_LINK_CHARS = 64 * 1024;
/** Largest project a link may expand to, in bytes of UTF-8 JSON: stops a small link that inflates to gigabytes. */
export const MAX_CODE_BYTES = 256 * 1024;
/** Snapshots kept in the version history; the oldest goes first. */
export const MAX_SNAPSHOTS = 30;
/** Files a project holds: `main.js` (run first) and the modules it imports as `./name.js`. */
export const MAX_FILES = 12;
/** A file name: letters, digits, `-` and `_`, then `.js`; 32 characters before the extension at most. */
export const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}\.js$/;
/**
 * The first byte of a version 2 link. Its low three bits, 111, are a final deflate block of the reserved type 11,
 * which no deflate stream starts with, so a version 1 link (plain deflate of main.js) is still told apart and opened.
 */
export const LINK_VERSION = 0x07;
/** localStorage key of the saved state. */
export const STORE_KEY = 'margo-playground:v1';
/** The `channel` every message between the page and the frame carries. */
export const CHANNEL = 'margo-playground';

const linkError = (message) => Object.assign(new Error(message), { name: 'MargoError', code: 'playground-link' });

const toBase64Url = (bytes) => {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
};

/** One file's code as a project: `[{name: 'main.js', code}]`. */
export const single = (code) => [{ name: 'main.js', code }];

/**
 * The project's files, checked: an array of `{name, code}`, `main.js` first, unique valid names, at most `MAX_FILES`.
 * Returns a copy; throws `fail(message)` (a TypeError by default) on anything else.
 */
export function checkFiles(files, fail = (message) => new TypeError(message)) {
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_FILES)
    throw fail(`A project holds 1 to ${MAX_FILES} files.`);
  const seen = new Set();
  const copy = files.map((file) => {
    if (!file || typeof file.name !== 'string' || typeof file.code !== 'string' || !FILE_NAME.test(file.name))
      throw fail('each file needs a name such as util.js (letters, digits, - and _) and its code as text.');
    if (seen.has(file.name)) throw fail(`two files are named ${file.name}.`);
    seen.add(file.name);
    return { name: file.name, code: file.code };
  });
  if (copy[0].name !== 'main.js') throw fail('the first file must be main.js.');
  return copy;
}

/**
 * A project to the text after `#code=`: the version byte, then deflate-raw (WHATWG Compression) of the UTF-8 JSON
 * `[[name, code], ...]`, all in base64url without padding (RFC 4648 §5).
 */
export async function encodeProject(files) {
  const raw = new TextEncoder().encode(JSON.stringify(checkFiles(files).map((f) => [f.name, f.code])));
  if (raw.length > MAX_CODE_BYTES)
    throw linkError(
      `The code is ${raw.length} bytes; a share link holds at most ${MAX_CODE_BYTES}. Download it instead.`,
    );
  const packed = new Uint8Array(
    await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer(),
  );
  const bytes = new Uint8Array(packed.length + 1);
  bytes[0] = LINK_VERSION;
  bytes.set(packed, 1);
  const text = toBase64Url(bytes);
  if (text.length > MAX_LINK_CHARS)
    throw linkError(
      `The share link would be ${text.length} characters; the limit is ${MAX_LINK_CHARS}. Download it instead.`,
    );
  return text;
}

/**
 * The text after `#code=` back to the project's files. The input is untrusted: anything that is not a well-formed,
 * capped link rejects with a MargoError of code `playground-link` and a message to show, never a partial result.
 * A version 1 link (deflate of main.js alone, from the first playground) opens as a one-file project.
 */
export async function decodeProject(text) {
  if (typeof text !== 'string' || text === '') throw linkError('The share link holds no code.');
  if (text.length > MAX_LINK_CHARS)
    throw linkError(`The share link is ${text.length} characters; the limit is ${MAX_LINK_CHARS}.`);
  if (!/^[A-Za-z0-9_-]+$/.test(text) || text.length % 4 === 1)
    throw linkError('The share link is damaged: it is not base64url. Copy the whole link again.');
  let binary;
  try {
    binary = atob(text.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (text.length % 4)) % 4));
  } catch {
    throw linkError('The share link is damaged: it is not base64url. Copy the whole link again.');
  }
  let packed = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  const version = packed[0] === LINK_VERSION ? 2 : 1;
  if (version === 1 && (packed[0] & 0b110) === 0b110)
    throw linkError('The share link was made by a newer playground than this page. Reload the page and try again.');
  if (version === 2) packed = packed.subarray(1);
  const reader = new Blob([packed]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const parts = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_CODE_BYTES) {
        await reader.cancel();
        throw linkError(`The share link expands past ${MAX_CODE_BYTES} bytes, so it was not opened.`);
      }
      parts.push(value);
    }
  } catch (error) {
    if (error?.code === 'playground-link') throw error;
    throw linkError('The share link is damaged: its code does not decompress. Copy the whole link again.');
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const part of parts) bytes.set(part, (at += part.length) - part.length);
  let text8;
  try {
    text8 = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw linkError('The share link is damaged: its code is not UTF-8 text.');
  }
  if (version === 1) return single(text8);
  let pairs;
  try {
    pairs = JSON.parse(text8);
  } catch {
    pairs = null;
  }
  if (!Array.isArray(pairs) || !pairs.every((p) => Array.isArray(p) && p.length === 2))
    throw linkError('The share link is damaged: its files are not readable.');
  return checkFiles(
    pairs.map(([name, code]) => ({ name, code })),
    (message) => linkError(`The share link is damaged: ${message}`),
  );
}

/** The `#code=` value of a URL hash such as `#code=abc&tab=1`, or null when it has none. */
export function codeFromHash(hash) {
  return new URLSearchParams(String(hash).replace(/^#/, '')).get('code');
}

/** A title for a snapshot: main.js's first comment, else its first non-empty line, and the file count past one. */
export function titleOf(files) {
  const line = files[0].code.split('\n').find((l) => l.trim()) ?? '';
  const title =
    line
      .replace(/^\s*\/\/\s?/, '')
      .trim()
      .slice(0, 80) || 'Untitled';
  return files.length > 1 ? `${title} (${files.length} files)` : title;
}

/** The history with `files` added as its newest snapshot (unless it equals the newest), at most `max` long. */
export function addSnapshot(history, files, time = Date.now(), max = MAX_SNAPSHOTS) {
  files = checkFiles(files);
  if (history[0] && JSON.stringify(history[0].files) === JSON.stringify(files)) return history;
  return [{ time, title: titleOf(files), files }, ...history].slice(0, max);
}

/** Saved files in either format: a files array, or the code string the first playground saved. Null when invalid. */
const savedFiles = (value) => {
  try {
    return typeof value === 'string' ? single(value) : checkFiles(value);
  } catch {
    return null;
  }
};

/** The saved state from `storage` (localStorage), or an empty one when it is missing, blocked or malformed. */
export function readStore(storage) {
  try {
    const value = JSON.parse(storage.getItem(STORE_KEY) ?? 'null');
    if (!value || typeof value !== 'object') return { current: null, history: [] };
    const history = (Array.isArray(value.history) ? value.history : [])
      .map((s) => {
        if (!s || typeof s !== 'object' || !Number.isFinite(s.time) || typeof s.title !== 'string') return null;
        const files = savedFiles(s.files ?? s.code);
        return files && { time: s.time, title: s.title, files };
      })
      .filter(Boolean)
      .slice(0, MAX_SNAPSHOTS);
    return { current: value.current == null ? null : savedFiles(value.current), history };
  } catch {
    return { current: null, history: [] };
  }
}

/**
 * Saves the state (`current` is the files in the editor). When storage is full, the oldest snapshots are dropped until
 * it fits; returns the history that was stored, or null when storage refuses even the current files alone (private
 * mode, blocked site data).
 */
export function writeStore(storage, { current, history }) {
  for (let keep = history.length; keep >= 0; keep--) {
    try {
      const kept = history.slice(0, keep);
      storage.setItem(STORE_KEY, JSON.stringify({ current, history: kept }));
      return kept;
    } catch {
      // Quota: try again with one snapshot fewer.
    }
  }
  return null;
}

/** Text for a `<script>` element: nothing in it can end the element or start a comment that hides the rest. */
export const scriptText = (text) => text.replace(/<(\/script|!--)/gi, '<\\$1');

/**
 * The message the page posts to the frame (site/playground/frame/) to run the project's `files`: `packages` is null for
 * jsDelivr, or the absolute URL (ending in `/`) the packages are served from. The frame checks the same shape.
 */
export function runMessage(files, packages = null) {
  files = checkFiles(files);
  if (packages !== null && !/^https?:\/\/[^\s]+\/$/.test(packages))
    throw new TypeError('packages must be null or an http(s) URL ending in /');
  return { channel: CHANNEL, kind: 'run', files, packages };
}

/**
 * The file Download saves: the frame document with the run message built in, so it runs on its own (from a local
 * server or HTTPS) with no page around it, and without the frame's meta policy. `frameHtml` is the text of
 * site/playground/frame/index.html.
 */
export function downloadDocument(frameHtml, files, packages = null) {
  const marker = '<!-- run -->';
  if (!frameHtml.includes(marker)) throw new Error('The frame document has no <!-- run --> marker');
  const config = `<script>window.MARGO_PLAYGROUND = ${scriptText(JSON.stringify(runMessage(files, packages)))};</script>`;
  // The frame's meta policy backs up the site's headers; a saved file is the visitor's own page and loads its packages
  // from wherever the playground did (a local server included), so it goes.
  return frameHtml.replace(/\s*<meta http-equiv="Content-Security-Policy"[^>]*>/, '').replace(marker, () => config);
}

const LEVELS = new Set(['log', 'info', 'warn', 'error', 'debug']);
const API_KINDS = new Set(['function', 'class', 'interface', 'type', 'const', 'let', 'enum', 'namespace']);
const short = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');

/** The `entries` of an `api` message, checked: at most 20 entries of at most 400 exports; anything else is dropped. */
function apiEntries(entries) {
  if (!Array.isArray(entries)) return null;
  return entries
    .slice(0, 20)
    .filter(
      (e) =>
        e && typeof e.specifier === 'string' && /^[@\w][\w@./-]{0,199}$/.test(e.specifier) && Array.isArray(e.exports),
    )
    .map((e) => ({
      specifier: e.specifier,
      exports: e.exports
        .slice(0, 400)
        .filter(
          (x) => x && typeof x.name === 'string' && /^[A-Za-z_$][\w$]{0,99}$/.test(x.name) && API_KINDS.has(x.kind),
        )
        .map((x) => ({ name: x.name, kind: x.kind, signature: short(x.signature, 300), doc: short(x.doc, 300) })),
    }));
}

/**
 * A message from the frame, checked against the schema, or null to ignore it. The caller checks `event.source` first;
 * this checks the shape: `{channel, kind: 'log', level, text}`, `{channel, kind: 'error', text, file, line, code}`,
 * `{channel, kind: 'api', entries: [{specifier, exports: [{name, kind, signature, doc}]}]}`
 * or `{channel, kind: 'ready' | 'done'}`. Text is capped at 4,000 characters.
 */
export function parseFrameMessage(data) {
  if (!data || typeof data !== 'object' || data.channel !== CHANNEL) return null;
  const text = typeof data.text === 'string' ? data.text.slice(0, 4000) : null;
  if (data.kind === 'done' || data.kind === 'ready') return { kind: data.kind };
  if (data.kind === 'api') {
    const entries = apiEntries(data.entries);
    return entries && { kind: 'api', entries };
  }
  if (data.kind === 'log' && LEVELS.has(data.level) && text !== null) return { kind: 'log', level: data.level, text };
  if (data.kind === 'error' && text !== null) {
    const file = typeof data.file === 'string' && FILE_NAME.test(data.file) ? data.file : null;
    const line = file !== null && Number.isInteger(data.line) && data.line > 0 ? data.line : null;
    const code = typeof data.code === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(data.code) ? data.code : null;
    return { kind: 'error', text, file, line, code };
  }
  return null;
}
