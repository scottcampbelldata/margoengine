// The playground's pure parts: share links, the saved version history and the document the sandboxed frame runs.
// No DOM here, so tests/playground.test.js runs it in Node. docs/playground.md explains each limit and its sources.

/** Largest `#code=` payload a link may carry, in characters (base64url of the deflated code). */
export const MAX_LINK_CHARS = 64 * 1024;
/** Largest code a link may expand to, in bytes of UTF-8: stops a small link that inflates to gigabytes. */
export const MAX_CODE_BYTES = 256 * 1024;
/** Snapshots kept in the version history; the oldest goes first. */
export const MAX_SNAPSHOTS = 30;
/** localStorage key of the saved state. */
export const STORE_KEY = 'margo-playground:v1';
/** The `channel` every message from the frame carries. */
export const CHANNEL = 'margo-playground';

const linkError = (message) =>
  Object.assign(new Error(message), {
    name: 'MargoError',
    code: 'playground-link',
  });

const toBase64Url = (bytes) => {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
};

/** Code to the text after `#code=`: UTF-8, deflate-raw (WHATWG Compression), base64url without padding (RFC 4648 §5). */
export async function encodeCode(code) {
  if (typeof code !== 'string') throw new TypeError('encodeCode needs the code as a string');
  const raw = new TextEncoder().encode(code);
  if (raw.length > MAX_CODE_BYTES)
    throw linkError(
      `The code is ${raw.length} bytes; a share link holds at most ${MAX_CODE_BYTES}. Download it instead.`,
    );
  const packed = new Uint8Array(
    await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer(),
  );
  const text = toBase64Url(packed);
  if (text.length > MAX_LINK_CHARS)
    throw linkError(
      `The share link would be ${text.length} characters; the limit is ${MAX_LINK_CHARS}. Download it instead.`,
    );
  return text;
}

/**
 * The text after `#code=` back to code. The input is untrusted: anything that is not a well-formed, capped link
 * rejects with a MargoError of code `playground-link` and a message to show, never a partial result.
 */
export async function decodeCode(text) {
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
  const packed = Uint8Array.from(binary, (c) => c.charCodeAt(0));
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
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw linkError('The share link is damaged: its code is not UTF-8 text.');
  }
}

/** The `#code=` value of a URL hash such as `#code=abc&tab=1`, or null when it has none. */
export function codeFromHash(hash) {
  const value = new URLSearchParams(String(hash).replace(/^#/, '')).get('code');
  return value === null ? null : value;
}

/** A first-line title for a snapshot: its first comment, else its first non-empty line. */
export function titleOf(code) {
  const line = code.split('\n').find((l) => l.trim()) ?? '';
  return (
    line
      .replace(/^\s*\/\/\s?/, '')
      .trim()
      .slice(0, 80) || 'Untitled'
  );
}

/** The history with `code` added as its newest snapshot (unless it equals the newest), at most `max` long. */
export function addSnapshot(history, code, time = Date.now(), max = MAX_SNAPSHOTS) {
  if (history[0]?.code === code) return history;
  return [{ time, title: titleOf(code), code }, ...history].slice(0, max);
}

const validSnapshot = (s) =>
  s && typeof s === 'object' && typeof s.code === 'string' && Number.isFinite(s.time) && typeof s.title === 'string';

/** The saved state from `storage` (localStorage), or an empty one when it is missing, blocked or malformed. */
export function readStore(storage) {
  try {
    const value = JSON.parse(storage.getItem(STORE_KEY) ?? 'null');
    if (!value || typeof value !== 'object') return { current: null, history: [] };
    const history = Array.isArray(value.history) ? value.history.filter(validSnapshot).slice(0, MAX_SNAPSHOTS) : [];
    return {
      current: typeof value.current === 'string' ? value.current : null,
      history,
    };
  } catch {
    return { current: null, history: [] };
  }
}

/**
 * Saves the state. When storage is full, the oldest snapshots are dropped until it fits; returns the history that was
 * stored, or null when storage refuses even the current code alone (private mode, blocked site data).
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

// Runs first in the frame: forwards console output and errors to the playground. Each error carries its line in the
// user's code (the frame's document line minus the lines before the code) and a MargoError code when it has one.
const BRIDGE = String.raw`(() => {
  const CHANNEL = %CHANNEL%, OFFSET = %OFFSET%, top = parent !== window ? parent : null;
  const text = (v) => { if (v instanceof Error) return (v.name ? v.name + ': ' : '') + v.message; if (typeof v === 'string') return v;
    try { return JSON.stringify(v) ?? String(v); } catch { return String(v); } };
  const lineOf = (error, line) => { const m = /about:srcdoc:(\d+):\d+/.exec(error && error.stack || '');
    const n = m ? Number(m[1]) : line; return Number.isInteger(n) && n > OFFSET ? n - OFFSET : null; };
  const send = (message) => { if (top) top.postMessage({ channel: CHANNEL, ...message }, '*'); };
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const original = console[level].bind(console);
    console[level] = (...args) => { original(...args); send({ kind: 'log', level, text: args.map(text).join(' ') }); };
  }
  const report = (error, line) => send({ kind: 'error', text: text(error), line: lineOf(error, line),
    code: error && typeof error.code === 'string' ? error.code : null });
  addEventListener('error', (e) => report(e.error ?? e.message, e.lineno));
  addEventListener('unhandledrejection', (e) => report(e.reason, null));
  window.__margoDone = () => send({ kind: 'done' });
})();`;

/**
 * The HTML document the frame runs (and the file Download saves): the import map, a full-size `#scene` container, the
 * console bridge and the code as one module script. `importMap` is `{imports: {...}}`.
 */
export function frameDocument(code, importMap, { title = 'Margo Engine playground' } = {}) {
  const head = [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${title.replace(/[<&]/g, (c) => (c === '<' ? '&lt;' : '&amp;'))}</title>`,
    '<style>html,body{margin:0;height:100%;background:#111;color:#eee;font:16px system-ui,sans-serif}#scene{position:fixed;inset:0}</style>',
    `<script type="importmap">${scriptText(JSON.stringify(importMap))}</script>`,
  ];
  const bridgeLines = BRIDGE.split('\n').length;
  // Lines before the user's code: the head, the bridge script, then </head>, <body>, the scene div and the module tag.
  const offset = head.length + bridgeLines + 4;
  const bridge = BRIDGE.replace('%CHANNEL%', JSON.stringify(CHANNEL)).replace('%OFFSET%', String(offset));
  return [
    ...head,
    `<script>${bridge}</script>`,
    '</head>',
    '<body>',
    '<div id="scene"></div>',
    '<script type="module">',
    scriptText(code),
    ';window.__margoDone?.();',
    '</script>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

const LEVELS = new Set(['log', 'info', 'warn', 'error', 'debug']);

/**
 * A message from the frame, checked against the schema, or null to ignore it. The caller checks `event.source` first;
 * this checks the shape: `{channel, kind: 'log', level, text}`, `{channel, kind: 'error', text, line, code}` or
 * `{channel, kind: 'done'}`. Text is capped at 4,000 characters.
 */
export function parseFrameMessage(data) {
  if (!data || typeof data !== 'object' || data.channel !== CHANNEL) return null;
  const text = typeof data.text === 'string' ? data.text.slice(0, 4000) : null;
  if (data.kind === 'done') return { kind: 'done' };
  if (data.kind === 'log' && LEVELS.has(data.level) && text !== null) return { kind: 'log', level: data.level, text };
  if (data.kind === 'error' && text !== null) {
    const line = Number.isInteger(data.line) && data.line > 0 ? data.line : null;
    const code = typeof data.code === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(data.code) ? data.code : null;
    return { kind: 'error', text, line, code };
  }
  return null;
}
