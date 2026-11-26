// The playground page (docs/playground.md). User code runs only in ./frame/, loaded as <iframe sandbox="allow-scripts">
// without allow-same-origin, so it gets an opaque origin: no access to this page, its storage or its cookies. The frame
// has its own loose policy (site/_headers); this page keeps a strict one, so it loads nothing from another host.
// A project is files: main.js runs first and imports the others as './name.js'; each file is a tab of the editor.
import {
  FILE_NAME,
  MAX_FILES,
  addSnapshot,
  checkFiles,
  codeFromHash,
  decodeProject,
  downloadDocument,
  encodeProject,
  parseFrameMessage,
  readStore,
  runMessage,
  writeStore,
} from './share.js';
import { templates } from './templates.js';

/** Console lines kept; older ones are dropped. */
const MAX_LINES = 500;

const $ = (id) => document.getElementById(id);
const editor = $('editor'),
  gutter = $('gutter'),
  status = $('status'),
  output = $('console'),
  versions = $('versions'),
  tabs = $('tabs');

let packages = null,
  frame = null,
  frameFiles = null,
  files = templates[0].files,
  active = 0,
  // While a shared link's files are in the editor and the user has not edited, run or saved them: their own files.
  ownFiles = null,
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

/** The editor's files, with the open tab's text taken from the editor. */
function project() {
  files[active] = { name: files[active].name, code: editor.value };
  return checkFiles(files);
}

// ---- Editor: tabs, line numbers, Tab indent, shortcuts -------------------------------------------------------------

function renumber() {
  const lines = editor.value.split('\n').length;
  if (gutter.dataset.lines === String(lines)) return;
  gutter.dataset.lines = String(lines);
  gutter.textContent = Array.from({ length: lines }, (_, i) => i + 1).join('\n');
}
editor.addEventListener('scroll', () => (gutter.scrollTop = editor.scrollTop));

function renderTabs() {
  tabs.replaceChildren(
    ...files.map((file, i) => {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.role = 'tab';
      tab.id = `tab-${i}`;
      tab.textContent = file.name;
      tab.setAttribute('aria-selected', String(i === active));
      tab.setAttribute('aria-controls', 'editor');
      tab.tabIndex = i === active ? 0 : -1;
      tab.addEventListener('click', () => openTab(i));
      if (i === 0) return tab;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'remove';
      remove.textContent = '×';
      remove.setAttribute('aria-label', `Remove ${file.name}`);
      remove.addEventListener('click', () => removeTab(i));
      const group = document.createElement('span');
      group.className = 'tab';
      group.append(tab, remove);
      return group;
    }),
  );
  editor.setAttribute('aria-labelledby', `editor-label tab-${active}`);
}

function openTab(i) {
  project();
  active = Math.max(0, Math.min(i, files.length - 1));
  editor.value = files[active].code;
  editor.scrollTop = 0;
  renumber();
  renderTabs();
}

/** Shows `next` in the editor, opening main.js, without saving anything. */
function show(next) {
  files = checkFiles(next);
  active = 0;
  editor.value = files[0].code;
  renumber();
  renderTabs();
}

tabs.addEventListener('keydown', (event) => {
  const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
  if (!step) return;
  event.preventDefault();
  openTab((active + step + files.length) % files.length);
  $(`tab-${active}`).focus();
});

function changed() {
  adopt();
  store.current = project();
  persist();
}

$('add-file').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = $('new-file');
  const name = input.value.trim().endsWith('.js') ? input.value.trim() : `${input.value.trim()}.js`;
  if (!FILE_NAME.test(name)) return say('A file name has letters, digits, - and _, such as util.js.', true);
  if (files.some((f) => f.name === name)) return say(`There is already a file named ${name}.`, true);
  if (files.length >= MAX_FILES) return say(`A project holds at most ${MAX_FILES} files.`, true);
  project();
  files.push({ name, code: `// ${name}: import it in main.js with import {...} from './${name}';\nexport {};\n` });
  input.value = '';
  openTab(files.length - 1);
  changed();
  say(`Added ${name}.`);
});

function removeTab(i) {
  project();
  const [gone] = files.splice(i, 1);
  // The removed file stays in the version history.
  store.history = addSnapshot(store.history, [...files.slice(0, i), gone, ...files.slice(i)]);
  active = Math.min(active >= i ? active - 1 : active, files.length - 1);
  active = Math.max(active, 0);
  editor.value = files[active].code;
  renumber();
  renderTabs();
  changed();
  listVersions();
  say(`Removed ${gone.name}; the version before is in Versions.`);
}

let tabReleased = false,
  saveTimer = 0;
editor.addEventListener('input', () => {
  renumber();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(changed, 400);
});

function indent(outdent) {
  const { value, selectionStart: start, selectionEnd: end } = editor;
  const from = value.lastIndexOf('\n', start - 1) + 1;
  if (!outdent && start === end) {
    editor.setRangeText('  ', start, end, 'end');
  } else {
    const block = value.slice(from, end);
    const result = outdent ? block.replace(/^ {1,2}/gm, '') : block.replace(/^/gm, '  ');
    editor.setRangeText(result, from, end, 'select');
  }
  editor.dispatchEvent(new Event('input'));
}

editor.addEventListener('keydown', (event) => {
  const mod = event.ctrlKey || event.metaKey;
  if (event.key === ' ' && event.ctrlKey) {
    event.preventDefault();
    complete();
  } else if (event.key === 'Escape') tabReleased = true;
  else if (event.key === 'Tab' && !tabReleased && !mod && !event.altKey) {
    event.preventDefault();
    indent(event.shiftKey);
  } else if (event.key !== 'Tab' && event.key !== 'Shift') tabReleased = false;
});
editor.addEventListener('blur', () => (tabReleased = false));

/** Opens `file`'s tab and selects its 1-based `line`. */
function goToLine(file, line) {
  const i = files.findIndex((f) => f.name === file);
  if (i < 0) return;
  if (i !== active) openTab(i);
  const lines = editor.value.split('\n');
  const at = lines.slice(0, Math.min(line, lines.length) - 1).reduce((n, l) => n + l.length + 1, 0);
  editor.focus();
  editor.setSelectionRange(at, at + (lines[line - 1]?.length ?? 0));
  editor.scrollTop = Math.max(0, (line - 3) * (editor.scrollHeight / lines.length));
}

/** The editor's files become the user's own: a shared link's files are kept from here on. */
function adopt() {
  // Their own files are kept as a version, so taking up shared code never loses them.
  if (ownFiles?.some((f) => f.code.trim())) store.history = addSnapshot(store.history, ownFiles);
  ownFiles = null;
  $('shared').hidden = true;
}

/** Puts `next` in the editor and saves it as the current files. */
function setFiles(next) {
  adopt();
  show(next);
  store.current = project();
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
  const place =
    message.line === null ? '' : `${message.file === 'main.js' ? '' : `${message.file} `}line ${message.line}`;
  if (place) {
    const go = document.createElement('button');
    go.type = 'button';
    go.textContent = place;
    go.addEventListener('click', () => goToLine(message.file, message.line));
    parts.push(' (', go, ')');
  }
  if (message.code !== null) {
    const help = document.createElement('a');
    help.href = new URL(`../errors.html#${message.code}`, import.meta.url).href;
    help.target = '_blank';
    help.rel = 'noopener';
    help.textContent = `error help: ${message.code}`;
    parts.push(' ', help);
  }
  line('error', parts);
  say(`Error${place ? ` on ${place}` : ''}: ${message.text}`, true);
}

addEventListener('message', (event) => {
  // Only the current frame's window; then the shape, never trusting the content.
  if (!frame || event.source !== frame.contentWindow) return;
  const message = parseFrameMessage(event.data);
  if (message?.kind === 'ready') frame.contentWindow.postMessage(runMessage(frameFiles, packages), '*');
  else if (message?.kind === 'api') showApi(message.entries);
  else if (message) showMessage(message);
});

// ---- API panel and completion -------------------------------------------------------------------------------------
// The frame reads the .d.ts of the entries the code imports and sends their top-level exports (docs/playground.md).

let api = [];
const apiFilter = $('api-filter'),
  apiList = $('api-list');

/** Puts `text` in place of the selection (or the `before` characters before the caret) and keeps editing. */
function insert(text, before = 0) {
  const at = editor.selectionStart - before;
  editor.setRangeText(text, at, editor.selectionEnd, 'end');
  editor.focus();
  editor.dispatchEvent(new Event('input'));
}

function renderApi() {
  const term = apiFilter.value.trim().toLowerCase();
  const sections = api
    .map(({ specifier, exports }) => {
      const shown = exports.filter((x) => !term || x.name.toLowerCase().includes(term));
      if (!shown.length) return null;
      const heading = Object.assign(document.createElement('h3'), { textContent: specifier });
      const list = document.createElement('ul');
      for (const item of shown) {
        const row = document.createElement('li');
        const name = Object.assign(document.createElement('button'), { type: 'button', textContent: item.name });
        name.setAttribute('aria-label', `Insert ${item.name}`);
        name.addEventListener('click', () => insert(item.name));
        row.append(
          name,
          ' ',
          item.kind,
          Object.assign(document.createElement('code'), { textContent: item.signature }),
        );
        if (item.doc) row.append(Object.assign(document.createElement('p'), { textContent: item.doc }));
        row.title = item.doc;
        list.append(row);
      }
      const section = document.createElement('section');
      section.append(heading, list);
      return section;
    })
    .filter(Boolean);
  apiList.replaceChildren(...sections);
  $('api-empty').hidden = sections.length > 0;
  if (!sections.length && api.length)
    $('api-empty').textContent = api.some((e) => e.exports.length)
      ? 'No name matches the filter.'
      : 'The imported entries list no exports: their .d.ts files could not be read.';
}

function showApi(entries) {
  api = entries;
  $('api-empty').textContent = 'Run the code to list what its imports export.';
  renderApi();
}
apiFilter.addEventListener('input', renderApi);

/** Ctrl+Space: completes the word before the caret from the API; several matches open the panel filtered to them. */
function complete() {
  const word = /[A-Za-z_$][\w$]*$/.exec(editor.value.slice(0, editor.selectionStart))?.[0] ?? '';
  const names = [...new Set(api.flatMap((e) => e.exports.map((x) => x.name)))].filter((n) => n.startsWith(word));
  if (names.length === 1) return insert(names[0], word.length);
  $('api').open = true;
  apiFilter.value = word;
  renderApi();
  say(
    names.length
      ? `${names.length} names start with "${word}": pick one in the API panel.`
      : 'No API name starts with that; run the code to list its imports.',
  );
}

// ---- Run -----------------------------------------------------------------------------------------------------------

/** Runs the files in a new frame. `auto` (a page load or a link) saves nothing while shared code is shown. */
function run({ keepStatus = false, auto = false } = {}) {
  const current = project();
  if (!auto || ownFiles === null) {
    adopt();
    store.current = current;
    store.history = addSnapshot(store.history, current);
    persist();
    listVersions();
  }
  output.replaceChildren();
  frame?.remove();
  frameFiles = current;
  frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.title = 'Result of the code';
  frame.src = new URL('./frame/', import.meta.url).href;
  $('stage').append(frame);
  if (!keepStatus) say('Running.');
}

// ---- Versions ------------------------------------------------------------------------------------------------------

const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
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
  adopt();
  store.current = project();
  store.history = addSnapshot(store.history, store.current);
  persist();
  listVersions();
  say('Version saved in this browser.');
}

$('restore').addEventListener('click', () => {
  const snapshot = store.history[Number(versions.value)];
  if (!snapshot) return;
  // Keep what is in the editor as a version first, so a restore never loses work.
  store.history = addSnapshot(store.history, project());
  setFiles(snapshot.files);
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
  const before = project();
  if (before.some((f) => f.code.trim())) store.history = addSnapshot(store.history, before);
  setFiles(template.files);
  listVersions();
  run();
});

$('share').addEventListener('click', async () => {
  try {
    const text = await encodeProject(project());
    const url = new URL(location.href);
    url.hash = `code=${text}`;
    history.replaceState(null, '', url);
    try {
      await navigator.clipboard.writeText(url.href);
      say('Share link copied. Anyone who opens it gets these files.');
    } catch {
      say('Share link is in the address bar: copy it from there.');
    }
  } catch (error) {
    say(error.message, true);
  }
});

$('download').addEventListener('click', async () => {
  let html;
  try {
    const response = await fetch(new URL('./frame/', import.meta.url));
    if (!response.ok) throw new Error(`the frame page answered ${response.status}`);
    html = downloadDocument(await response.text(), project(), packages);
  } catch (error) {
    say(`Could not build the download (${error.message}).`, true);
    return;
  }
  const link = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(new Blob([html], { type: 'text/html' })),
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

/** `?packages=/node_modules/` runs against the packages this origin serves (a local dev server); the default is jsDelivr. */
function packagesBase() {
  const base = new URLSearchParams(location.search).get('packages');
  if (base === null) return null;
  if (!/^\/(?!\/)[\w\-./@]*\/$/.test(base)) throw new Error('?packages= must be a path on this site ending in /');
  return new URL(base, location.origin).href;
}

/**
 * Opens a `#code=` link. The shared files go in the editor but not in storage: the user's own files stay saved, and
 * "Back to my code" returns to them, until they edit, run or save the shared ones. A bad link says why, changes nothing.
 */
async function openLink() {
  const value = codeFromHash(location.hash);
  if (value === null) return false;
  try {
    const shared = await decodeProject(value);
    if (ownFiles === null) ownFiles = project();
    show(shared);
    $('shared').hidden = false;
    return true;
  } catch (error) {
    say(error.message, true);
    return false;
  }
}

$('back').addEventListener('click', () => {
  setFiles(ownFiles ?? store.current ?? templates[0].files);
  history.replaceState(null, '', location.pathname + location.search);
  run({ auto: true });
  say('Back to your own code.');
});

store = storage ? readStore(storage) : store;
show(store.current ?? templates[0].files);
listVersions();
addEventListener('hashchange', async () => {
  if (await openLink()) run({ auto: true });
});
try {
  packages = packagesBase();
  const linked = await openLink();
  $('run').disabled = $('download').disabled = false;
  // A bad link leaves its message up and runs nothing: the output of other code would hide why the link failed.
  if (status.classList.contains('alert'))
    say(`${status.textContent} Your own code is in the editor; Run starts it.`, true);
  else {
    say(linked ? 'Shared code loaded.' : 'Ready.');
    run({ keepStatus: true, auto: true });
  }
} catch (error) {
  say(error.message, true);
}
