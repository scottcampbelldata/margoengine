// The playground page (docs/playground.md). User code runs only in a sandboxed srcdoc frame without
// allow-same-origin, so it gets an opaque origin: no access to this page, its storage or its cookies.
import {
  addSnapshot,
  codeFromHash,
  decodeCode,
  encodeCode,
  frameDocument,
  parseFrameMessage,
  readStore,
  writeStore,
} from './share.js';
import { templates } from './templates.js';

/** margoengine's import map on jsDelivr, for the published 1.0.0 packages. */
const CDN_MAP = 'https://cdn.jsdelivr.net/npm/margoengine@1.0.0/dist/importmap.json';
/** Console lines kept; older ones are dropped. */
const MAX_LINES = 500;

const $ = (id) => document.getElementById(id);
const editor = $('editor'),
  gutter = $('gutter'),
  status = $('status'),
  output = $('console'),
  versions = $('versions');

let importMap = null,
  frame = null,
  store = { current: null, history: [] };

const storage = (() => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
})();

function say(text, alert = false) {
  status.textContent = text;
  status.classList.toggle('alert', alert);
  status.setAttribute('role', alert ? 'alert' : 'status');
}

function persist() {
  if (!storage) return;
  const kept = writeStore(storage, store);
  if (kept === null)
    say('This browser does not let the page save, so versions last only until you close the tab.', true);
  else store.history = kept;
}

// ---- Editor: line numbers, Tab indent, shortcuts -------------------------------------------------------------------

function renumber() {
  const lines = editor.value.split('\n').length;
  if (gutter.dataset.lines === String(lines)) return;
  gutter.dataset.lines = String(lines);
  gutter.textContent = Array.from({ length: lines }, (_, i) => i + 1).join('\n');
}
editor.addEventListener('scroll', () => (gutter.scrollTop = editor.scrollTop));

let tabReleased = false,
  saveTimer = 0;
editor.addEventListener('input', () => {
  renumber();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    store.current = editor.value;
    persist();
  }, 400);
});

function indent(outdent) {
  const { value, selectionStart: start, selectionEnd: end } = editor;
  const from = value.lastIndexOf('\n', start - 1) + 1;
  if (!outdent && start === end) {
    editor.setRangeText('  ', start, end, 'end');
  } else {
    const block = value.slice(from, end);
    const changed = outdent ? block.replace(/^ {1,2}/gm, '') : block.replace(/^/gm, '  ');
    editor.setRangeText(changed, from, end, 'select');
  }
  editor.dispatchEvent(new Event('input'));
}

editor.addEventListener('keydown', (event) => {
  const mod = event.ctrlKey || event.metaKey;
  if (event.key === 'Escape') tabReleased = true;
  else if (event.key === 'Tab' && !tabReleased && !mod && !event.altKey) {
    event.preventDefault();
    indent(event.shiftKey);
  } else if (event.key !== 'Tab' && event.key !== 'Shift') tabReleased = false;
});
editor.addEventListener('blur', () => (tabReleased = false));

/** Puts the caret at the start of a 1-based line and scrolls it into view. */
function goToLine(line) {
  const lines = editor.value.split('\n');
  const at = lines.slice(0, Math.min(line, lines.length) - 1).reduce((n, l) => n + l.length + 1, 0);
  editor.focus();
  editor.setSelectionRange(at, at + (lines[line - 1]?.length ?? 0));
  const height = editor.scrollHeight / lines.length;
  editor.scrollTop = Math.max(0, (line - 3) * height);
}

function setCode(code) {
  editor.value = code;
  renumber();
  store.current = code;
  persist();
}

// ---- Console -------------------------------------------------------------------------------------------------------

function line(kind, nodes) {
  const item = document.createElement('li');
  item.className = kind;
  item.append(...nodes);
  output.append(item);
  while (output.children.length > MAX_LINES) output.firstElementChild.remove();
  output.scrollTop = output.scrollHeight;
}

function showMessage(message) {
  if (message.kind === 'log') return line(message.level, [message.text]);
  if (message.kind === 'done') return;
  const parts = [message.text];
  if (message.line !== null) {
    const go = document.createElement('button');
    go.type = 'button';
    go.textContent = `line ${message.line}`;
    go.addEventListener('click', () => goToLine(message.line));
    parts.push(' (', go, ')');
  }
  if (message.code !== null) {
    const help = document.createElement('a');
    help.href = new URL(`../errors.html#${message.code}`, location.href).href;
    help.target = '_blank';
    help.rel = 'noopener';
    help.textContent = `error help: ${message.code}`;
    parts.push(' ', help);
  }
  line('error', parts);
  say(`Error${message.line !== null ? ` on line ${message.line}` : ''}: ${message.text}`, true);
}

addEventListener('message', (event) => {
  // Only the current frame's window; then the shape, never trusting the content.
  if (!frame || event.source !== frame.contentWindow) return;
  const message = parseFrameMessage(event.data);
  if (message) showMessage(message);
});

// ---- Run -----------------------------------------------------------------------------------------------------------

function run(keepStatus = false) {
  if (!importMap) return;
  const code = editor.value;
  store.current = code;
  store.history = addSnapshot(store.history, code);
  persist();
  listVersions();
  output.replaceChildren();
  frame?.remove();
  frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.title = 'Result of the code';
  frame.srcdoc = frameDocument(code, importMap);
  $('stage').append(frame);
  if (!keepStatus) say('Running.');
}

// ---- Versions ------------------------------------------------------------------------------------------------------

const timeFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});
function listVersions() {
  versions.replaceChildren(
    ...(store.history.length
      ? store.history.map(
          (snapshot, i) => new Option(`${timeFormat.format(snapshot.time)} - ${snapshot.title}`, String(i)),
        )
      : [new Option('No saved versions', '')]),
  );
  $('restore').disabled = !store.history.length;
}

function saveVersion() {
  store.history = addSnapshot(store.history, editor.value);
  store.current = editor.value;
  persist();
  listVersions();
  say('Version saved in this browser.');
}

$('restore').addEventListener('click', () => {
  const snapshot = store.history[Number(versions.value)];
  if (!snapshot) return;
  // Keep what is in the editor as a version first, so a restore never loses work.
  store.history = addSnapshot(store.history, editor.value);
  setCode(snapshot.code);
  listVersions();
  say(`Restored the version from ${timeFormat.format(snapshot.time)}.`);
});

// ---- Templates, share, download ------------------------------------------------------------------------------------

const templateSelect = $('template');
templateSelect.append(new Option('Choose...', ''), ...templates.map((t) => new Option(t.title, t.id)));
templateSelect.addEventListener('change', () => {
  const template = templates.find((t) => t.id === templateSelect.value);
  templateSelect.value = '';
  if (!template) return;
  if (editor.value.trim()) store.history = addSnapshot(store.history, editor.value);
  setCode(template.code);
  listVersions();
  run();
});

$('share').addEventListener('click', async () => {
  try {
    const text = await encodeCode(editor.value);
    const url = new URL(location.href);
    url.hash = `code=${text}`;
    history.replaceState(null, '', url);
    try {
      await navigator.clipboard.writeText(url.href);
      say('Share link copied. Anyone who opens it gets this code.');
    } catch {
      say('Share link is in the address bar: copy it from there.');
    }
  } catch (error) {
    say(error.message, true);
  }
});

$('download').addEventListener('click', () => {
  const blob = new Blob([frameDocument(editor.value, importMap)], {
    type: 'text/html',
  });
  const link = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(blob),
    download: 'margo-playground.html',
  });
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 0);
  say('Downloaded margo-playground.html: open it from a local server or HTTPS.');
});

$('run').addEventListener('click', () => run());
$('save').addEventListener('click', saveVersion);
$('clear').addEventListener('click', () => output.replaceChildren());
addEventListener('keydown', (event) => {
  if (!(event.ctrlKey || event.metaKey)) return;
  if (event.key === 'Enter') {
    event.preventDefault();
    run();
  } else if (event.key === 's' || event.key === 'S') {
    event.preventDefault();
    saveVersion();
  }
});

// ---- Start ---------------------------------------------------------------------------------------------------------

/** `?packages=/node_modules/` serves the packages from this origin (a local dev server); the default is jsDelivr. */
async function fetchJSON(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.json();
}

async function loadImportMap() {
  const base = new URLSearchParams(location.search).get('packages');
  if (base === null) return fetchJSON(CDN_MAP);
  if (!/^\/(?!\/)[\w\-./@]*\/$/.test(base)) throw new Error('?packages= must be a path on this site ending in /');
  const root = new URL(base, location.origin).href;
  const [{ rebaseImportMap }, map] = await Promise.all([
    import(`${root}margoengine/dist/importmap.js`),
    fetchJSON(`${root}margoengine/dist/importmap.json`),
  ]);
  return rebaseImportMap(map, root);
}

/** Opens a `#code=` link: on a bad link, says why and keeps the saved code. */
async function openLink() {
  const value = codeFromHash(location.hash);
  if (value === null) return false;
  try {
    const code = await decodeCode(value);
    if (editor.value.trim() && editor.value !== code) store.history = addSnapshot(store.history, editor.value);
    setCode(code);
    listVersions();
    return true;
  } catch (error) {
    say(error.message, true);
    return false;
  }
}

store = storage ? readStore(storage) : store;
editor.value = store.current ?? templates[0].code;
renumber();
listVersions();
const linked = await openLink();
addEventListener('hashchange', async () => {
  if (await openLink()) run();
});
try {
  importMap = await loadImportMap();
  $('run').disabled = $('download').disabled = false;
  const bad = status.classList.contains('alert');
  if (!bad) say(linked ? 'Opened the shared code.' : 'Ready.');
  run(true);
} catch (error) {
  say(`Could not load the engine's import map (${error.message}). Check the connection and reload.`, true);
}
