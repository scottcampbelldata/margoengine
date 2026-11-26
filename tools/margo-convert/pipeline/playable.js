// @ts-check
// `margo-convert playable`: one self-contained HTML file from a built app folder (its index.html), an HTML file or an
// entry module, for playable-ad networks that take a single file and allow no network requests. JavaScript modules go
// in as text and load through an import map of blob URLs; every other file goes in as base64 and is reached through an
// in-page asset map (`new URL('x', import.meta.url)` is rewritten to it and `fetch` answers from it). The file is
// measured raw and gzipped against a named network budget. Clean room, from the networks' published specs (README).
import { readdir, readFile, stat } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { basename, dirname, extname, posix, relative, resolve } from 'node:path';
import { margoError } from './paths.js';

const HELP = 'see https://margoengine.com/errors#playable';
const VIRTUAL = 'margo-playable:/';
const RUNTIME_SPECIFIER = 'margo-convert/playable-runtime';
const RUNTIME_PATH = '~margo/playable-runtime.js';

/**
 * @typedef {object} PlayableBudget
 * @property {string} name
 * @property {number} bytes the largest allowed size
 * @property {'raw' | 'gzip'} measure what is compared: the file as uploaded, or gzipped (IAB file weight)
 * @property {string} source where the figure comes from
 */

/**
 * Named size budgets for one HTML file (bytes; "MB" read as 1,000,000 bytes, the stricter reading). Networks change
 * these: pass `{bytes, measure}` for any other figure.
 * @type {Readonly<Record<string, PlayableBudget>>}
 */
export const PLAYABLE_BUDGETS = Object.freeze({
  iab: {
    name: 'iab',
    bytes: 300_000,
    measure: 'gzip',
    source:
      'IAB Tech Lab New Ad Portfolio (2017): full page ad on a phone over 4.5 in, max initial load 300 kB gzipped; a single file is all initial load',
  },
  unity: {
    name: 'unity',
    bytes: 4_999_999,
    measure: 'raw',
    source: 'Unity Ads playable specifications: one index.html, less than 5 MB',
  },
  applovin: {
    name: 'applovin',
    bytes: 5_000_000,
    measure: 'raw',
    source: 'AppLovin creative guidelines: one HTML file, 5 MB or smaller',
  },
  meta: {
    name: 'meta',
    bytes: 2_000_000,
    measure: 'raw',
    source: 'Meta playable ads: single HTML file at most 2 MB',
  },
  chartboost: {
    name: 'chartboost',
    bytes: 3_000_000,
    measure: 'raw',
    source: 'Chartboost MRAID playable: one bundled standalone HTML file, at most 3 MB',
  },
  liftoff: {
    name: 'liftoff',
    bytes: 5_000_000,
    measure: 'raw',
    source: 'Liftoff (Vungle) interactive creatives: single HTML file, 5 MB',
  },
  moloco: {
    name: 'moloco',
    bytes: 5_000_000,
    measure: 'raw',
    source: 'Moloco playable and IEC creative guide: single HTML file under 5 MB',
  },
});

const MIME = /** @type {Record<string, string>} */ ({
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ktx2': 'image/ktx2',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.json': 'application/json',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.txt': 'text/plain',
});
const mimeOf = (/** @type {string} */ path) => MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';
/** Files a page hands to elements (img, audio, video, fonts, workers) get blob URLs; the rest are fetched. */
const isMedia = (/** @type {string} */ mime) =>
  /^(image|audio|video|font)\//.test(mime) || /^text\/(javascript|css)$/.test(mime);

/** The files left out by default: dotfiles, source maps and HTML pages. */
const defaultInclude = (/** @type {string} */ path) => !/(^|\/)\./.test(path) && !/\.(map|html?)$/i.test(path);

// ---------------------------------------------------------------------------------------------------------------
// A JavaScript scanner: just enough lexing (strings, templates, comments, regular expressions) to find import
// specifiers and `new URL(<string>, import.meta.url)` in code only, and to escape the text for an HTML script element.

const REGEX_AFTER = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
  'export',
  'default',
  'extends',
]);

/**
 * @typedef {{t: 'name' | 'punct' | 'str' | 'tmpl' | 're' | 'num', v: string, s: number, e: number}} Token
 * @typedef {{kind: 'spec' | 'meta' | 'newurl', s: number, e: number, spec?: string}} Edit
 */

/**
 * Lexes `src`. Returns the literal and comment ranges (the rest is code) and the edits a module needs.
 * @param {string} src
 */
export function scanScript(src) {
  /** @type {{kind: 'lit' | 'comment', s: number, e: number}[]} */ const segs = [];
  /** @type {Token[]} */ const toks = [];
  /** @type {Edit[]} */ let edits = [];
  /** @type {number[]} */ const templates = [];
  const n = src.length;
  let depth = 0,
    i = 0;
  const back = (/** @type {number} */ k) => toks[toks.length - k];
  const regexAllowed = () => {
    const p = back(1);
    if (!p) return true;
    if (p.t === 'name') return REGEX_AFTER.has(p.v) && back(2)?.v !== '.';
    if (p.t === 'punct') return p.v !== ')' && p.v !== ']';
    return false;
  };
  /** Scans a template piece from `j` (after "`" or "}"); `start` is where the piece's text starts. */
  const template = (/** @type {number} */ j, /** @type {number} */ start) => {
    while (j < n) {
      const ch = src[j];
      if (ch === '\\') j += 2;
      else if (ch === '`') {
        segs.push({ kind: 'lit', s: start, e: j + 1 });
        toks.push({ t: 'tmpl', v: '', s: start, e: j + 1 });
        return j + 1;
      } else if (ch === '$' && src[j + 1] === '{') {
        segs.push({ kind: 'lit', s: start, e: j + 2 });
        toks.push({ t: 'punct', v: '{', s: j + 1, e: j + 2 });
        templates.push(depth);
        return j + 2;
      } else j++;
    }
    segs.push({ kind: 'lit', s: start, e: n });
    return n;
  };
  while (i < n) {
    const c = src[i];
    if (
      c === ' ' ||
      c === '\t' ||
      c === '\n' ||
      c === '\r' ||
      c === '\f' ||
      c === '\v' ||
      c === '\u00a0' ||
      c === '\ufeff'
    ) {
      i++;
    } else if (c === '/' && src[i + 1] === '/') {
      let j = src.indexOf('\n', i);
      if (j < 0) j = n;
      segs.push({ kind: 'comment', s: i, e: j });
      i = j;
    } else if (c === '/' && src[i + 1] === '*') {
      let j = src.indexOf('*/', i + 2);
      j = j < 0 ? n : j + 2;
      segs.push({ kind: 'comment', s: i, e: j });
      i = j;
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      j = Math.min(j + 1, n);
      segs.push({ kind: 'lit', s: i, e: j });
      const p1 = back(1),
        p2 = back(2),
        p3 = back(3);
      const value = src.slice(i + 1, j - 1);
      const staticImport = p1?.t === 'name' && (p1.v === 'from' || (p1.v === 'import' && p2?.v !== '.'));
      const dynamicImport = p1?.v === '(' && p2?.t === 'name' && p2.v === 'import' && p3?.v !== '.';
      if (staticImport || dynamicImport) edits.push({ kind: 'spec', s: i, e: j, spec: value });
      toks.push({ t: 'str', v: value, s: i, e: j });
      i = j;
    } else if (c === '`') {
      i = template(i + 1, i);
    } else if (c === '}' && templates.length && templates[templates.length - 1] === depth) {
      templates.pop();
      i = template(i + 1, i);
    } else if (c === '/' && regexAllowed()) {
      let j = i + 1,
        inClass = false;
      while (j < n && src[j] !== '\n') {
        const ch = src[j];
        if (ch === '\\') {
          j += 2;
          continue;
        }
        if (inClass) inClass = ch !== ']';
        else if (ch === '[') inClass = true;
        else if (ch === '/') break;
        j++;
      }
      j++;
      while (j < n && /[\w$]/.test(src[j])) j++;
      segs.push({ kind: 'lit', s: i, e: j });
      toks.push({ t: 're', v: '', s: i, e: j });
      i = j;
    } else if (/[A-Za-z_$\u0080-\uffff]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w$\u0080-\uffff]/.test(src[j])) j++;
      const tok = /** @type {Token} */ ({ t: 'name', v: src.slice(i, j), s: i, e: j });
      toks.push(tok);
      if (
        tok.v === 'url' &&
        back(2)?.v === '.' &&
        back(3)?.v === 'meta' &&
        back(4)?.v === '.' &&
        back(5)?.v === 'import' &&
        back(6)?.v !== '.'
      )
        edits.push({ kind: 'meta', s: back(5).s, e: j });
      i = j;
    } else if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i + 1;
      while (j < n && /[\w.]/.test(src[j])) j++;
      toks.push({ t: 'num', v: src.slice(i, j), s: i, e: j });
      i = j;
    } else {
      if (c === '{') depth++;
      else if (c === '}') depth--;
      toks.push({ t: 'punct', v: c, s: i, e: i + 1 });
      i++;
      // new URL(<string>, import.meta.url)
      const at = (/** @type {number} */ k, /** @type {string} */ v) => back(k)?.v === v;
      if (
        c === ')' &&
        at(11, 'new') &&
        at(10, 'URL') &&
        at(9, '(') &&
        back(8)?.t === 'str' &&
        at(7, ',') &&
        at(6, 'import') &&
        at(2, 'url')
      ) {
        const meta = back(6).s;
        edits = edits.filter((edit) => !(edit.kind === 'meta' && edit.s === meta));
        edits.push({ kind: 'newurl', s: back(11).s, e: i, spec: back(8).v });
      }
    }
  }
  edits.sort((a, b) => a.s - b.s);
  return { segs, edits };
}

/**
 * The text of `src` with `edits` replaced by `replace(edit)`, made safe inside an HTML `<script>` element: in
 * literals `<` before `/script`, `script` or `!--` becomes `\x3C` (the same character), in code and comments a space
 * follows the `<`. String.raw templates holding those sequences would see the escape.
 * @param {string} src
 * @param {ReturnType<typeof scanScript>} scan
 * @param {(edit: Edit) => string} [replace]
 */
export function scriptText(src, scan, replace) {
  const danger = /<(?=\/?script|!--)/gi;
  const lit = (/** @type {string} */ s) => s.replace(danger, '\\x3C');
  const other = (/** @type {string} */ s) => s.replace(danger, '< ');
  /** Escapes src[a, b). */
  const escapeRange = (/** @type {number} */ a, /** @type {number} */ b) => {
    let out = '',
      pos = a;
    for (const seg of scan.segs) {
      if (seg.e <= pos || seg.s >= b) continue;
      const s = Math.max(seg.s, pos),
        e = Math.min(seg.e, b);
      out += other(src.slice(pos, s)) + (seg.kind === 'lit' ? lit : other)(src.slice(s, e));
      pos = e;
    }
    return out + other(src.slice(pos, b));
  };
  let out = '',
    pos = 0;
  for (const edit of replace ? scan.edits : []) {
    const text = /** @type {(edit: Edit) => string} */ (replace)(edit);
    out += escapeRange(pos, edit.s) + text;
    pos = edit.e;
  }
  return out + escapeRange(pos, src.length);
}

/** A JSON string safe in HTML script text and attributes. */
const jsonString = (/** @type {string} */ s) => JSON.stringify(s).replace(/</g, '\\u003c');
const attr = (/** @type {string} */ s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

// ---------------------------------------------------------------------------------------------------------------

/**
 * @typedef {object} PlayableOptions
 * @property {string} input a built app folder (its `index.html`), an HTML file, or an entry module (.js, .mjs)
 * @property {string} [root] the folder whose files may be bundled; default the input folder, or the input file's folder
 * @property {string | {bytes: number, measure?: 'raw' | 'gzip', name?: string} | false} [budget] a name from
 *   {@link PLAYABLE_BUDGETS}, an object, or false for none. Default `'unity'`.
 * @property {boolean} [allowOverBudget] write the file even when it is over the budget (`report.overBudget`). Default false.
 * @property {boolean} [waitForViewable] start the entry only once MRAID is ready and the ad is viewable. Default true.
 * @property {boolean} [mraidScript] add `<script src="mraid.js">` for containers that ask for the tag. Default false.
 * @property {string} [title] the page title when the input is a module. Default the module's name.
 * @property {(path: string) => boolean} [include] which files (paths relative to root, with /) may go in. Default:
 *   all but dotfiles, `.map` and `.html` files.
 * @property {number} [largest] how many of the biggest files the report lists. Default 10.
 * @property {AbortSignal} [signal]
 */

/**
 * @typedef {object} PlayableReport
 * @property {number} bytes the HTML file in UTF-8
 * @property {number} gzipBytes the same, gzipped (level 9)
 * @property {PlayableBudget | null} budget
 * @property {boolean} overBudget
 * @property {{path: string, bytes: number}[]} modules
 * @property {{path: string, bytes: number, mime: string}[]} assets files in the asset map
 * @property {{path: string, bytes: number}[]} inlined files written into the HTML or CSS as data URLs
 * @property {{path: string, bytes: number, kind: 'module' | 'asset' | 'inlined'}[]} largest
 */

/** @param {PlayableOptions['budget']} budget @returns {PlayableBudget | null} */
function budgetOf(budget) {
  if (budget === false) return null;
  if (budget === undefined || typeof budget === 'string') {
    const name = budget ?? 'unity';
    const known = PLAYABLE_BUDGETS[name];
    if (!known)
      throw new RangeError(
        `Playable budget '${name}' is unknown; use one of ${Object.keys(PLAYABLE_BUDGETS).join(', ')} or {bytes, measure}`,
      );
    return known;
  }
  if (typeof budget !== 'object' || budget === null)
    throw new TypeError('Playable budget must be a name, {bytes, measure} or false');
  if (!Number.isSafeInteger(budget.bytes) || budget.bytes <= 0)
    throw new RangeError(`Playable budget bytes must be a whole number above 0, got ${budget.bytes}`);
  const measure = budget.measure ?? 'raw';
  if (measure !== 'raw' && measure !== 'gzip')
    throw new RangeError(`Playable budget measure must be 'raw' or 'gzip', got ${measure}`);
  return { name: budget.name ?? 'custom', bytes: budget.bytes, measure, source: 'given by the caller' };
}

/** Bytes as "1,234,567". */
const n = (/** @type {number} */ v) => v.toLocaleString('en-US');

/** True for a URL that leaves the page: http(s), protocol relative, or any other scheme but data, blob and the like. */
const external = (/** @type {string} */ u) =>
  /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(u) && !/^(data|blob|about|javascript|mailto|tel):/i.test(u);
/** A reference that needs no file: empty, a fragment, data, blob and the like. */
const noFile = (/** @type {string} */ u) =>
  !u || u.startsWith('#') || /^(data|blob|about|javascript|mailto|tel):/i.test(u);

/**
 * Builds one self-contained playable-ad HTML file. Throws a MargoError (`failed`) when the file is over budget unless
 * `allowOverBudget` is set; the error carries `report`.
 * @param {PlayableOptions} options
 * @returns {Promise<{html: string, report: PlayableReport}>}
 */
export async function buildPlayable(options) {
  if (!options || typeof options.input !== 'string' || !options.input)
    throw new TypeError('buildPlayable needs {input}: a built app folder, an HTML file or an entry module');
  const { signal } = options;
  signal?.throwIfAborted();
  const budget = budgetOf(options.budget),
    include = options.include ?? defaultInclude,
    largestCount = options.largest ?? 10,
    waitForViewable = options.waitForViewable !== false;
  if (typeof include !== 'function') throw new TypeError('Playable include must be a function (path) => boolean');
  if (!Number.isInteger(largestCount) || largestCount < 0)
    throw new RangeError('Playable largest must be a whole number of 0 or more');

  const input = resolve(options.input);
  const inputStat = await stat(input).catch(() => null);
  if (!inputStat)
    throw margoError(
      'failed',
      `Playable input ${options.input} does not exist; pass a folder, an HTML file or a module; ${HELP}`,
    );
  const root = resolve(options.root ?? (inputStat.isDirectory() ? input : dirname(input)));
  const htmlFile = inputStat.isDirectory() ? resolve(input, 'index.html') : input;
  const rel = (/** @type {string} */ abs) => relative(root, abs).split(/[\\/]/).join('/');
  const isModuleInput = /\.(m?js)$/i.test(htmlFile);

  /** @type {Map<string, Uint8Array>} */ const cache = new Map();
  const files = new Set(
    (await readdir(root, { recursive: true, withFileTypes: true }))
      .filter((d) => d.isFile())
      .map((d) => rel(resolve(d.parentPath ?? /** @type {any} */ (d).path, d.name))),
  );
  signal?.throwIfAborted();
  const read = async (/** @type {string} */ path) => {
    let data = cache.get(path);
    if (!data) {
      if (!files.has(path))
        throw margoError('failed', `Playable file ${path} is not in ${root}; add it or fix the reference; ${HELP}`);
      data = new Uint8Array(await readFile(resolve(root, path), { signal }));
      cache.set(path, data);
    }
    return data;
  };
  const readText = async (/** @type {string} */ path) => new TextDecoder().decode(await read(path));
  /** A path relative to root from a reference in `from`, or throws when it leaves root. */
  const resolveRef = (/** @type {string} */ from, /** @type {string} */ ref) => {
    const clean = ref.replace(/[?#].*$/, '');
    const path = clean.startsWith('/')
      ? posix.normalize(clean.slice(1))
      : posix.normalize(posix.join(posix.dirname(from), clean));
    if (path.startsWith('../') || path === '..')
      throw margoError(
        'failed',
        `Playable reference ${ref} in ${from} leaves ${root}; pass a root that holds it; ${HELP}`,
      );
    return decodeURIComponent(path);
  };

  // HTML: the input page, or one made for the module.
  let html;
  const htmlPath = isModuleInput ? '~margo-index.html' : rel(htmlFile);
  if (isModuleInput) {
    const title = options.title ?? basename(htmlFile, extname(htmlFile));
    html =
      `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n` +
      `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n<title>${attr(title)}</title>\n` +
      `<style>html,body{margin:0;height:100%;overflow:hidden;background:#000}canvas{display:block;width:100%;height:100%;touch-action:none}</style>\n` +
      `</head>\n<body>\n<script type="module" src="${attr(rel(htmlFile))}"></script>\n</body>\n</html>\n`;
  } else {
    if (!files.has(htmlPath))
      throw margoError(
        'failed',
        `Playable input has no ${htmlPath}; build the app first or pass its entry module; ${HELP}`,
      );
    html = await readText(htmlPath);
  }

  /** @type {Map<string, string>} */ const moduleText = new Map();
  /** @type {Set<string>} */ const urlTargets = new Set();
  /** @type {Set<string>} */ const inlined = new Set();
  /** @type {string[]} */ const entries = [];

  /** Rewrites one module's source and queues its dependencies. */
  const addModule = async (/** @type {string} */ path, /** @type {string | undefined} */ source) => {
    if (moduleText.has(path)) return;
    moduleText.set(path, '');
    signal?.throwIfAborted();
    const src = source ?? (await readText(path));
    const scan = scanScript(src);
    /** @type {string[]} */ const deps = [];
    const text = scriptText(src, scan, (edit) => {
      const spec = /** @type {string} */ (edit.spec);
      if (edit.kind === 'meta') return jsonString(VIRTUAL + path);
      if (spec.includes('\\'))
        throw margoError(
          'unsupported',
          `Playable module ${path} has an escaped specifier ${spec}; write it plainly; ${HELP}`,
        );
      if (edit.kind === 'newurl') {
        if (noFile(spec) || external(spec)) {
          if (external(spec))
            throw margoError(
              'failed',
              `Playable module ${path} loads ${spec} from the network; bundle the file instead; ${HELP}`,
            );
          return `new URL(${jsonString(spec)})`;
        }
        const target = resolveRef(path, spec);
        if (!files.has(target))
          throw margoError(
            'failed',
            `Playable module ${path} needs ${spec} (${target}), which is not in ${root}; ${HELP}`,
          );
        urlTargets.add(target);
        return `new URL(globalThis.__margoPlayable.url(${jsonString(target)}))`;
      }
      if (spec === RUNTIME_SPECIFIER || spec.startsWith('data:')) return src.slice(edit.s, edit.e);
      if (external(spec))
        throw margoError(
          'failed',
          `Playable module ${path} imports ${spec} from the network; bundle it instead; ${HELP}`,
        );
      if (!/^(\.{1,2})?\//.test(spec))
        throw margoError(
          'unsupported',
          `Playable module ${path} imports the package ${spec}; build the app with a bundler (vite build) and pass its output folder; ${HELP}`,
        );
      const target = resolveRef(path, spec);
      if (!files.has(target))
        throw margoError(
          'failed',
          `Playable module ${path} imports ${spec} (${target}), which is not in ${root}; ${HELP}`,
        );
      deps.push(target);
      return jsonString(VIRTUAL + target);
    });
    moduleText.set(path, text);
    for (const dep of deps) await addModule(dep, undefined);
  };

  /** A data URL of one file, which then stays out of the asset map. */
  const dataURL = async (/** @type {string} */ path) => {
    inlined.add(path);
    return `data:${mimeOf(path)};base64,${Buffer.from(await read(path)).toString('base64')}`;
  };
  const rewriteCSS = async (/** @type {string} */ css, /** @type {string} */ from) => {
    if (/@import\b/i.test(css))
      throw margoError(
        'unsupported',
        `Playable stylesheet ${from} uses @import; bundle the CSS into one file; ${HELP}`,
      );
    let out = '',
      pos = 0;
    for (const m of css.matchAll(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi)) {
      const ref = m[2].trim();
      out += css.slice(pos, m.index);
      if (external(ref))
        throw margoError(
          'failed',
          `Playable stylesheet ${from} loads ${ref} from the network; bundle it instead; ${HELP}`,
        );
      out += noFile(ref) ? m[0] : `url("${await dataURL(resolveRef(from, ref))}")`;
      pos = /** @type {number} */ (m.index) + m[0].length;
    }
    return (out + css.slice(pos)).replace(/<\/(style)/gi, '<\\/$1');
  };
  const attrsOf = (/** @type {string} */ text) => {
    /** @type {Record<string, string>} */ const out = {};
    for (const m of text.matchAll(/([^\s=/]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g))
      out[m[1].toLowerCase()] = (m[2] ?? '').replace(/^["']|["']$/g, '').replace(/&amp;/g, '&');
    return out;
  };
  /** Replaces matches of `re` in html with the awaited result of `fn`. */
  const replaceAsync = async (
    /** @type {string} */ text,
    /** @type {RegExp} */ re,
    /** @type {(m: RegExpMatchArray) => Promise<string>} */ fn,
  ) => {
    let out = '',
      pos = 0;
    for (const m of text.matchAll(re)) {
      out += text.slice(pos, m.index) + (await fn(m));
      pos = /** @type {number} */ (m.index) + m[0].length;
    }
    return out + text.slice(pos);
  };

  let inlineCount = 0;
  html = await replaceAsync(html, /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi, async (m) => {
    const a = attrsOf(m[1]),
      type = (a.type ?? '').toLowerCase();
    if (type === 'importmap')
      throw margoError(
        'unsupported',
        `Playable page ${htmlPath} has its own import map; bundle the app first; ${HELP}`,
      );
    if (type === 'module') {
      if (a.src !== undefined) {
        if (external(a.src))
          throw margoError('failed', `Playable page loads ${a.src} from the network; bundle it instead; ${HELP}`);
        const path = resolveRef(htmlPath, a.src);
        await addModule(path, undefined);
        entries.push(path);
      } else {
        // An inline module resolves its imports against the page, so it is named beside it.
        const path = posix.join(posix.dirname(htmlPath), `~margo-inline-${inlineCount++}.js`);
        await addModule(path, m[2]);
        entries.push(path);
      }
      return '';
    }
    if (type && !/^(text|application)\/(javascript|ecmascript)$/.test(type)) return m[0];
    let src = m[2];
    if (a.src !== undefined) {
      if (a.src === 'mraid.js') return m[0];
      if (external(a.src))
        throw margoError('failed', `Playable page loads ${a.src} from the network; bundle it instead; ${HELP}`);
      const path = resolveRef(htmlPath, a.src);
      inlined.add(path);
      src = await readText(path);
    }
    return `<script>${scriptText(src, scanScript(src))}</script>`;
  });
  html = await replaceAsync(html, /<link\b([^>]*)>/gi, async (m) => {
    const a = attrsOf(m[1]),
      rel = (a.rel ?? '').toLowerCase().split(/\s+/);
    if (
      rel.some(
        (r) =>
          r === 'modulepreload' || r === 'preload' || r === 'prefetch' || r === 'preconnect' || r === 'dns-prefetch',
      )
    )
      return '';
    const href = a.href ?? '';
    if (noFile(href)) return m[0];
    if (external(href))
      throw margoError('failed', `Playable page links ${href} from the network; bundle it instead; ${HELP}`);
    const path = resolveRef(htmlPath, href);
    if (rel.includes('stylesheet')) {
      inlined.add(path);
      return `<style>${await rewriteCSS(await readText(path), path)}</style>`;
    }
    return m[0].replace(/\bhref\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i, `href="${await dataURL(path)}"`);
  });
  html = await replaceAsync(
    html,
    /<style\b([^>]*)>([\s\S]*?)<\/style\s*>/gi,
    async (m) => `<style${m[1]}>${await rewriteCSS(m[2], htmlPath)}</style>`,
  );
  html = await replaceAsync(html, /<(img|source|video|audio|image|input|track|embed|iframe)\b[^>]*>/gi, (m) =>
    replaceAsync(m[0], /\b(src|poster|href|xlink:href)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, async (a) => {
      const ref = a[2].replace(/^["']|["']$/g, '').replace(/&amp;/g, '&');
      if (noFile(ref)) return a[0];
      if (external(ref))
        throw margoError('failed', `Playable page loads ${ref} from the network; bundle it instead; ${HELP}`);
      return `${a[1]}="${await dataURL(resolveRef(htmlPath, ref))}"`;
    }),
  );
  if (!entries.length)
    throw margoError(
      'failed',
      `Playable page ${htmlPath} has no <script type="module">; give it the app's entry; ${HELP}`,
    );

  // The runtime module, under its own specifier.
  const runtimeSrc = await readFile(new URL('./playable-runtime.js', import.meta.url), { encoding: 'utf8', signal });
  moduleText.set(RUNTIME_PATH, scriptText(runtimeSrc, scanScript(runtimeSrc)));

  // The asset map.
  /** @type {Record<string, [string, string, number]>} */ const assetMap = {};
  /** @type {PlayableReport['assets']} */ const assets = [];
  for (const path of [...files].sort()) {
    if (path === htmlPath || !include(path)) continue;
    if ((moduleText.has(path) || inlined.has(path)) && !urlTargets.has(path)) continue;
    signal?.throwIfAborted();
    const data = await read(path),
      mime = mimeOf(path);
    assetMap[path] = [mime, Buffer.from(data).toString('base64'), isMedia(mime) ? 1 : 0];
    assets.push({ path, bytes: data.length, mime });
  }

  const bootstrap = `(()=>{const V=${jsonString(VIRTUAL)},A=JSON.parse(document.getElementById("margo-playable-assets").textContent),B={},U={};
const bytes=p=>B[p]??=Uint8Array.from(atob(A[p][1]),c=>c.charCodeAt(0));
const url=p=>{p=String(p).replace(/^\\/+/,"");const a=A[p];return a&&a[2]?U[p]??=URL.createObjectURL(new Blob([bytes(p)],{type:a[0]})):V+p};
const dir=document.baseURI.replace(/[?#].*$/,"").replace(/[^/]*$/,"");
const key=h=>{let k=h.startsWith(V)?h.slice(V.length):h.startsWith(dir)?h.slice(dir.length):null;if(k===null)return null;try{k=decodeURIComponent(k.replace(/[?#].*$/,""))}catch{return null}return Object.hasOwn(A,k)?k:null};
const f=globalThis.fetch;
globalThis.fetch=function(i,o){let h;try{h=new URL(i instanceof Request?i.url:String(i),document.baseURI).href}catch{return f.call(this,i,o)}const k=key(h);if(k===null)return f.call(this,i,o);const s=o?.signal??(i instanceof Request?i.signal:null);if(s?.aborted)return Promise.reject(s.reason);return Promise.resolve(new Response(bytes(k).slice(),{status:200,headers:{"content-type":A[k][0]}}))};
globalThis.__margoPlayable={url,bytes:p=>bytes(p).slice(),has:p=>Object.hasOwn(A,p)};
const I={};for(const s of document.querySelectorAll('script[type="text/margo-module"]'))I[V+s.dataset.path]=URL.createObjectURL(new Blob([s.textContent],{type:"text/javascript"}));
I[${jsonString(RUNTIME_SPECIFIER)}]=I[V+${jsonString(RUNTIME_PATH)}];
const m=document.createElement("script");m.type="importmap";m.textContent=JSON.stringify({imports:I});document.head.append(m)})();`;
  const loader =
    `const r=await import(${jsonString(RUNTIME_SPECIFIER)});await r.${waitForViewable ? 'whenViewable' : 'ready'}();` +
    entries.map((e) => `await import(${jsonString(VIRTUAL + e)});`).join('');
  const modulesHtml = [...moduleText]
    .map(([path, text]) => `<script type="text/margo-module" data-path="${attr(path)}">${text}</script>`)
    .join('\n');
  const tail =
    `<script type="application/json" id="margo-playable-assets">${JSON.stringify(assetMap).replace(/</g, '\\u003c')}</script>\n` +
    `${modulesHtml}\n<script>${bootstrap}</script>\n<script type="module">${loader}</script>\n`;
  html = /<\/body\s*>/i.test(html) ? html.replace(/<\/body\s*>(?![\s\S]*<\/body)/i, `${tail}</body>`) : html + tail;
  if (options.mraidScript && !/<script\s+src=["']?mraid\.js/i.test(html)) {
    const tag = '<script src="mraid.js"></script>';
    html = /<head\b[^>]*>/i.test(html) ? html.replace(/<head\b[^>]*>/i, (h) => `${h}\n${tag}`) : tag + html;
  }

  const raw = Buffer.byteLength(html, 'utf8'),
    gz = gzipSync(html, { level: 9 }).length;
  const modules = [...moduleText]
    .filter(([p]) => p !== RUNTIME_PATH)
    .map(([path]) => ({ path, bytes: cache.get(path)?.length ?? 0 }));
  const inlinedList = [...inlined].map((path) => ({ path, bytes: cache.get(path)?.length ?? 0 }));
  /** @type {PlayableReport['largest']} */
  const largest = [
    ...modules.map((m) => ({ ...m, kind: /** @type {const} */ ('module') })),
    ...assets.map((a) => ({ path: a.path, bytes: a.bytes, kind: /** @type {const} */ ('asset') })),
    ...inlinedList.map((m) => ({ ...m, kind: /** @type {const} */ ('inlined') })),
  ]
    .sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path))
    .slice(0, largestCount);
  const measured = budget?.measure === 'gzip' ? gz : raw;
  const overBudget = budget ? measured > budget.bytes : false;
  /** @type {PlayableReport} */
  const report = { bytes: raw, gzipBytes: gz, budget, overBudget, modules, assets, inlined: inlinedList, largest };
  if (overBudget && !options.allowOverBudget) {
    const b = /** @type {PlayableBudget} */ (budget);
    const top = largest
      .slice(0, 3)
      .map((l) => `${l.path} (${n(l.bytes)} bytes)`)
      .join(', ');
    throw Object.assign(
      margoError(
        'failed',
        `Playable is ${n(measured)} bytes ${b.measure === 'gzip' ? 'gzipped' : 'raw'}, over the ${b.name} budget of ${n(b.bytes)}; largest: ${top}. Shrink them (margo-convert build) or pass allowOverBudget; ${HELP}`,
      ),
      { report },
    );
  }
  return { html, report };
}

/** The report as text lines. @param {PlayableReport} report */
export function playableReportText(report) {
  const lines = [`playable: ${n(report.bytes)} bytes, ${n(report.gzipBytes)} gzipped`];
  if (report.budget)
    lines.push(
      `budget ${report.budget.name}: ${n(report.budget.bytes)} bytes ${report.budget.measure} - ${report.overBudget ? 'OVER' : 'within'} (${report.budget.source})`,
    );
  lines.push(
    `${report.modules.length} modules, ${report.assets.length} assets, ${report.inlined.length} inlined files; largest:`,
  );
  for (const l of report.largest) lines.push(`  ${n(l.bytes).padStart(12)}  ${l.kind.padEnd(7)}  ${l.path}`);
  return lines.join('\n');
}

export const PLAYABLE_USAGE = `Usage: margo-convert playable <folder|page.html|entry.js> [--out playable.html] [options]

Writes one self-contained HTML file for playable-ad networks: modules, Wasm, images, models, audio and fonts inlined,
nothing loaded from the network, MRAID 3.0 hooks from margo-convert/playable-runtime. Fails (exit 1) over the budget.

Options:
  --out <file>            output file (default playable.html)
  --budget <name|bytes>   ${Object.keys(PLAYABLE_BUDGETS).join(' | ')} | a byte count | none (default unity)
  --measure <raw|gzip>    what a byte-count budget measures (default raw)
  --allow-over-budget     write the file even over the budget
  --root <folder>         the folder files may come from (default the input's folder)
  --title <text>          page title when the input is a module
  --no-wait-viewable      start the entry at MRAID ready, without waiting for viewable
  --mraid-script          add <script src="mraid.js"> for containers that ask for it
  --json                  print the report as JSON
  --quiet                 print nothing on success
  --help                  this text`;

/**
 * Runs `margo-convert playable`.
 * @param {string[]} argv arguments after the mode
 * @returns {Promise<number>} the exit code
 */
export async function runPlayable(argv) {
  const { parseArgs } = await import('node:util');
  const { writeFile } = await import('node:fs/promises');
  const fail = (/** @type {string} */ message) => {
    console.error(`margo-convert playable: ${message}`);
    return 1;
  };
  /** @type {Record<string, any>} */ let values;
  /** @type {string[]} */ let positionals;
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      allowNegative: true,
      options: {
        out: { type: 'string' },
        budget: { type: 'string' },
        measure: { type: 'string' },
        'allow-over-budget': { type: 'boolean' },
        root: { type: 'string' },
        title: { type: 'string' },
        'wait-viewable': { type: 'boolean' },
        'mraid-script': { type: 'boolean' },
        json: { type: 'boolean' },
        quiet: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (error) {
    return fail(`${error instanceof Error ? error.message : error}\n\n${PLAYABLE_USAGE}`);
  }
  if (values.help) {
    console.log(PLAYABLE_USAGE);
    return 0;
  }
  if (positionals.length !== 1) return fail(`expected one folder, page or module\n\n${PLAYABLE_USAGE}`);
  /** @type {PlayableOptions['budget']} */ let budget = values.budget;
  if (budget === 'none') budget = false;
  else if (typeof budget === 'string' && /^\d+$/.test(budget))
    budget = { bytes: Number(budget), measure: values.measure ?? 'raw' };
  try {
    const { html, report } = await buildPlayable({
      input: positionals[0],
      root: values.root,
      budget,
      allowOverBudget: values['allow-over-budget'] === true,
      waitForViewable: values['wait-viewable'] !== false,
      mraidScript: values['mraid-script'] === true,
      title: values.title,
    });
    await writeFile(values.out ?? 'playable.html', html);
    if (values.json) console.log(JSON.stringify(report, null, 2));
    else if (!values.quiet) console.log(playableReportText(report));
    return 0;
  } catch (error) {
    const report = /** @type {any} */ (error)?.report;
    if (report && !values.quiet) console.error(playableReportText(report));
    return fail(error instanceof Error ? error.message : String(error));
  }
}
