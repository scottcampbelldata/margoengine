#!/usr/bin/env node
// Finds dead controls in the web demos: node scripts/web-demos/controls.mjs <demo> [demo...] | --all
//
// Serves demos/ locally and opens each page in installed Chrome (one page at a time), on WebGPU and again on the
// WebGL2 layer (`?backend=webgl2`), waits until the exhibit is marked ready (`data-ready` or `data-state="ready"`),
// then operates every visible control: sliders and number fields go to their max, min and middle, checkboxes and
// switches toggle on and off, radios, tabs, select options and rows of preset buttons are each chosen (the one
// already chosen only after another, since choosing it again changes nothing by design), buttons are clicked and the
// scene canvas is dragged when the page invites it. Around every input it takes the canvases and charts and the
// page's text readouts, measures how much they change with no input (the noise floor), and compares. A control is
// dead when neither a picture (beyond the noise floor) nor any readout outside the control's own label changes. It
// also flags console and page errors on interaction, controls whose own label changes while nothing else does,
// controls covered by other elements, controls off-screen or clipped at 1440 x 900 and at 390 x 844, pages that fail
// to start, stop drawing or hang. Dead and unsure controls are tried again on a fresh page with normal motion and a
// longer wait, then once more after the page's start button, before they are reported.
//
// Results go to demos/.reports/controls.json (merged per demo, so a partial run updates only its demos; WebGL2
// results are filed as <demo>@webgl2) and a short list to private/handoffs/dead-controls.md. Exit code 1 when a page
// checked fails to start, logs an error or has a dead or broken control. Options: --backends=webgpu,webgl2 (default
// both), --timeout=<ms> to load a page (default 60000), --budget=<ms> per page (default: 90 s plus 30 s per control,
// at most 15 min), --wait=<ms> after an input (default 600), --confirm-wait=<ms> (default 1500), --no-confirm,
// --save-frames (writes the before and after pictures of every input to demos/.reports/frames/; --save-frames=flagged
// only for inputs that changed nothing), --resume (skips demos already in the report), --md=<path>, --md-only, --report=<path> (default demos/.reports/controls.json).
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import sharp from 'sharp';
import {
  compareRegion,
  identicalStops,
  judgeControl,
  judgeStep,
  motionChanged,
  noiseFloor,
  noisyKeys,
  stalled,
  textChanges,
} from './controls-compare.mjs';
import { killTree } from '../run-with-timeout.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const demos = path.join(root, 'demos');
const reportDir = path.join(demos, '.reports');

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const flag = (name) => args.includes(`--${name}`);
const reportFile = path.resolve(option('report', path.join(reportDir, 'controls.json')));
const loadTimeout = Number(option('timeout', 60000));
const fixedBudget = option('budget', null);
const WAIT = Number(option('wait', 600));
const CONFIRM_WAIT = Number(option('confirm-wait', 1500));
// Each demo runs on WebGPU and again on the WebGL2 layer (`?backend=webgl2`); a WebGL2 result is filed as <demo>@webgl2.
const backends = option('backends', 'webgpu,webgl2').split(',').filter(Boolean);
const saveFrames = flag('save-frames') ? 'all' : option('save-frames', null); // 'all' or 'flagged'
const mdFile = path.resolve(option('md', path.join(root, 'private/handoffs/dead-controls.md')));
const DESKTOP = { width: 1440, height: 900 },
  MOBILE = { width: 390, height: 844 };
const WORK = 320; // working width of a compared picture, in pixels

const catalog = JSON.parse(fs.readFileSync(path.join(demos, 'demos.json'), 'utf8'));
let names = args.filter((a) => !a.startsWith('--'));
if (flag('all')) names = catalog.map((d) => d.slug).filter((n) => fs.existsSync(path.join(demos, n, 'index.html')));

const report = fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile, 'utf8')) : { demos: {} };
const mdOnly = flag('md-only');
// With nothing to do the run prints its usage and ends by its event loop (no server, no browser), exit code 2.
const usage = !names.length && !mdOnly;
if (usage) {
  console.error(
    'usage: node scripts/web-demos/controls.mjs <demo> [demo...] | --all [--resume] [--save-frames] [--no-confirm]',
  );
  process.exitCode = 2;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class Timeout extends Error {}
/** Rejects with a Timeout when `promise` takes longer than `ms`. */
function within(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => (timer = setTimeout(() => reject(new Timeout(`${what} took over ${ms} ms`)), ms))),
  ]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------------------------------------------
// In-page probe, installed before the page's own scripts. It counts animation frames and presented frames, records
// side effects that leave no picture (a download, a sound, a copied link, a file picker) and lists, labels, lays out
// and reads the page's controls and readouts.
function probe() {
  if (window.__ctl) return;
  const state = { raf: 0, frames: 0, gl: 0, events: [], errors: [] };
  const note = (e) => state.events.push(e);
  const rawRaf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) =>
    rawRaf((t) => {
      state.raf++;
      const gl = state.gl;
      try {
        return cb(t);
      } finally {
        if (state.gl > gl) state.frames++;
      }
    });
  if (window.GPUCanvasContext) {
    const get = GPUCanvasContext.prototype.getCurrentTexture;
    GPUCanvasContext.prototype.getCurrentTexture = function (...a) {
      state.frames++;
      return get.apply(this, a);
    };
  }
  for (const C of [window.WebGL2RenderingContext, window.WebGLRenderingContext]) {
    if (!C) continue;
    for (const m of [
      'drawArrays',
      'drawElements',
      'drawArraysInstanced',
      'drawElementsInstanced',
      'drawRangeElements',
    ]) {
      const f = C.prototype[m];
      if (f)
        C.prototype[m] = function (...a) {
          state.gl++;
          return f.apply(this, a);
        };
    }
  }
  const stub = (obj, name, what, value) => {
    if (obj && name in obj)
      try {
        obj[name] = function () {
          note(what);
          return typeof value === 'function' ? value() : value;
        };
      } catch {}
  };
  const abort = () => Promise.reject(new DOMException('Cancelled by the controls check', 'AbortError'));
  stub(window, 'showSaveFilePicker', 'opened a save dialog', abort);
  stub(window, 'showOpenFilePicker', 'opened a file dialog', abort);
  stub(window, 'showDirectoryPicker', 'opened a folder dialog', abort);
  stub(window, 'open', 'opened a window', null);
  if (navigator.clipboard) {
    stub(navigator.clipboard, 'writeText', 'copied to the clipboard', () => Promise.resolve());
    stub(navigator.clipboard, 'write', 'copied to the clipboard', () => Promise.resolve());
  }
  stub(Element.prototype, 'requestFullscreen', 'asked for full screen', () => Promise.resolve());
  stub(Element.prototype, 'requestPointerLock', 'asked for pointer lock', undefined);
  if (window.AudioScheduledSourceNode) {
    const start = AudioScheduledSourceNode.prototype.start;
    AudioScheduledSourceNode.prototype.start = function (...a) {
      note('played a sound');
      return start.apply(this, a);
    };
  }
  if (window.AudioParam) {
    const d = Object.getOwnPropertyDescriptor(AudioParam.prototype, 'value');
    if (d?.set)
      Object.defineProperty(AudioParam.prototype, 'value', {
        ...d,
        set(v) {
          note('changed a sound setting');
          d.set.call(this, v);
        },
      });
    for (const m of [
      'setValueAtTime',
      'linearRampToValueAtTime',
      'exponentialRampToValueAtTime',
      'setTargetAtTime',
      'setValueCurveAtTime',
    ]) {
      const f = AudioParam.prototype[m];
      if (f)
        AudioParam.prototype[m] = function (...a) {
          note('changed a sound setting');
          return f.apply(this, a);
        };
    }
  }
  const volume = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'volume');
  if (volume?.set)
    Object.defineProperty(HTMLMediaElement.prototype, 'volume', {
      ...volume,
      set(v) {
        note('changed a sound setting');
        volume.set.call(this, v);
      },
    });
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...a) {
    note('played media');
    return play.apply(this, a);
  };
  const anchorClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function (...a) {
    if (this.hasAttribute('download')) {
      note('saved a file');
      return;
    }
    return anchorClick.apply(this, a);
  };
  addEventListener('unhandledrejection', (e) =>
    state.errors.push(`unhandled rejection: ${e.reason?.message ?? e.reason}`),
  );

  const SEL =
    'input,select,textarea,button,summary,[role=slider],[role=switch],[role=button],[role=tab],[role=checkbox],[role=radio],[role=spinbutton],[role=menuitemradio],[role=menuitemcheckbox]';
  const shown = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  };
  const pathOf = (el) => {
    const parts = [];
    for (let e = el; e && e !== document.body && e.parentElement; e = e.parentElement) {
      const i = Array.prototype.indexOf.call(e.parentElement.children, e) + 1;
      parts.unshift(`${e.tagName.toLowerCase()}:nth-child(${i})`);
    }
    return parts.length ? `body > ${parts.join(' > ')}` : 'body';
  };
  const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim();
  // A wrapping <label> whose first labelable child is an <output> labels the output, not the input, so the
  // wrapping label is added by hand.
  const labelsOf = (el) => {
    const out = [...(el.labels ?? [])],
      wrap = el.closest('label');
    if (wrap && !out.includes(wrap)) out.push(wrap);
    return out;
  };
  const target = (el) => {
    if (shown(el)) return el;
    return labelsOf(el).find(shown) ?? el;
  };
  // The chosen button of a row (pressed, current, selected or styled active) is already in its own state.
  const chosen = (b) =>
    b.getAttribute('aria-pressed') === 'true' ||
    ['true', 'page', 'step', 'location'].includes(b.getAttribute('aria-current') ?? '') ||
    b.getAttribute('aria-selected') === 'true' ||
    /(^|\s)(active|selected|current|is-active|is-selected)(\s|$)/.test(
      typeof b.className === 'string' ? b.className : '',
    );
  const base = (b) =>
    (typeof b.className === 'string' ? b.className : '')
      .replace(/(^|\s)(active|selected|current|is-active|is-selected)(?=\s|$)/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const kindOf = (el) => {
    const tag = el.tagName.toLowerCase(),
      role = el.getAttribute('role');
    if (tag === 'input') {
      const t = (el.type || 'text').toLowerCase();
      if (t === 'range') return 'range';
      if (t === 'number') return 'number';
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (['date', 'time', 'datetime-local', 'month', 'week', 'color'].includes(t)) return 'value';
      if (['button', 'submit', 'reset', 'image'].includes(t)) return 'button';
      if (t === 'hidden') return null;
      if (t === 'file') return 'file';
      return 'text';
    }
    if (tag === 'select') return 'select';
    if (tag === 'textarea') return 'text';
    if (role === 'slider' || role === 'spinbutton') return 'aria-slider';
    if (role === 'switch' || role === 'checkbox' || role === 'menuitemcheckbox') return 'checkbox';
    if (role === 'radio' || role === 'tab' || role === 'menuitemradio') return 'radio';
    // A row of buttons that mark the chosen one with aria-pressed (presets, modes) is a radio group: the chosen
    // button only shows an effect after another one was chosen.
    // A row of like buttons with exactly one chosen (presets, modes, views) is a radio group: the chosen one shows
    // an effect only after another was chosen. Like means all carry aria-pressed, or all share one class list
    // once the active classes are taken out; a toggle beside a plain action button is not a group.
    const row = [...(el.parentElement?.children ?? [])].filter((b) => b.matches('button,[role=button]'));
    if (row.length > 1 && row.filter(chosen).length === 1) {
      const pressed = row.every((b) => b.hasAttribute('aria-pressed')),
        alike = row.every((b) => base(b) === base(el));
      if (
        pressed ||
        (alike &&
          row.some(
            (b) => b.hasAttribute('aria-current') || b.hasAttribute('aria-selected') || base(b) !== b.className.trim(),
          ))
      )
        return 'radio';
    }
    return 'button';
  };
  const groupOf = (el, kind) => {
    if (kind !== 'radio') return null;
    if (el.tagName === 'INPUT') return `${el.form ? pathOf(el.form) : 'page'}|${el.name || pathOf(el.parentElement)}`;
    const g =
      (el.getAttribute('role') ? el.closest('[role=radiogroup],[role=tablist],[role=menu],[role=menubar]') : null) ??
      el.parentElement;
    return pathOf(g);
  };
  const nameOf = (el) => {
    const by = el.getAttribute('aria-labelledby');
    const text =
      el.getAttribute('aria-label') ||
      (by &&
        by
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent ?? '')
          .join(' ')) ||
      labelsOf(el)
        .map((l) => {
          const copy = l.cloneNode(true);
          for (const x of copy.querySelectorAll('select,option,datalist,textarea')) x.remove();
          return copy.textContent;
        })
        .join(' ') ||
      (el.tagName === 'SELECT' ? '' : el.textContent) ||
      el.getAttribute('title') ||
      el.getAttribute('placeholder') ||
      el.getAttribute('name') ||
      el.id ||
      el.tagName.toLowerCase();
    let label = clean(text);
    if (el.type === 'radio' || el.getAttribute('role') === 'radio') {
      const legend = clean(
        el.closest('fieldset')?.querySelector('legend')?.textContent ??
          el.closest('[role=radiogroup]')?.getAttribute('aria-label'),
      );
      if (legend && !label.startsWith(legend)) label = `${legend}: ${label}`;
    }
    return label.slice(0, 90);
  };
  const isDisabled = (el) =>
    el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true' || !!el.closest('[inert]');
  const list = () => {
    const out = [];
    for (const el of document.querySelectorAll(SEL)) {
      if (el.parentElement?.closest(SEL)?.matches('button,summary,[role=button],[role=tab],[role=switch]')) continue;
      const kind = kindOf(el);
      if (!kind) continue;
      if (!shown(target(el))) continue;
      out.push({
        path: pathOf(el),
        kind,
        group: groupOf(el, kind),
        label: nameOf(el),
        disabled: isDisabled(el),
        checked: !!el.checked || el.getAttribute('aria-checked') === 'true' || chosen(el),
        pressed: el.getAttribute('aria-pressed') ?? el.getAttribute('aria-expanded'),
        min: el.min,
        max: el.max,
        step: el.step,
        value: el.value,
        options:
          el.tagName === 'SELECT'
            ? [...el.options].map((o) => ({ label: clean(o.textContent), disabled: o.disabled }))
            : undefined,
        selectedIndex: el.selectedIndex,
      });
    }
    return out;
  };
  // Elements that belong to a control's own label: the control, its <label>s, outputs `for` it, its aria-labelledby
  // targets, and a small wrapper that holds this control and nothing else.
  const ownRoots = (el) => {
    const roots = [el, ...labelsOf(el)];
    if (el.id)
      for (const o of document.querySelectorAll('output'))
        if (o.htmlFor && [...o.htmlFor].includes(el.id)) roots.push(o);
    for (const id of (el.getAttribute('aria-labelledby') ?? '').split(/\s+/))
      if (id && document.getElementById(id)) roots.push(document.getElementById(id));
    let up = el.parentElement;
    for (let i = 0; i < 2 && up && up !== document.body; i++, up = up.parentElement) {
      if (up.querySelectorAll(SEL).length > 1 || clean(up.textContent).length > 120) break;
      // A button has no value label: a status line beside it ("Preparing the photon bake") is what it changes.
      if (!el.matches('input,select,textarea,[role=slider],[role=spinbutton]') && [...up.querySelectorAll('[role=status],[role=alert],[aria-live],output')].some((s) => !roots.includes(s) && !el.contains(s))) break;
      roots.push(up);
    }
    return roots;
  };
  const SKIP = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT']);
  const text = () => {
    const out = {};
    let n = 0;
    for (const el of document.body.querySelectorAll('*')) {
      if (SKIP.has(el.tagName)) continue;
      let own = '';
      for (const c of el.childNodes) if (c.nodeType === 3) own += c.nodeValue;
      own = clean(own);
      const valued = el.matches('input,select,textarea,meter,progress,output');
      if (!own && !valued) continue;
      if (!valued && !shown(el)) continue;
      const key = pathOf(el);
      if (own) out[key] = own;
      if (valued)
        out[`${key}#value`] =
          el.type === 'checkbox' || el.type === 'radio' ? String(el.checked) : String(el.value ?? '');
      if (++n > 4000) break;
    }
    return out;
  };
  const ownKeys = (p) => {
    const el = document.querySelector(p);
    if (!el) return [];
    const keys = new Set();
    for (const r of ownRoots(el))
      for (const e of [r, ...r.querySelectorAll('*')]) {
        const k = pathOf(e);
        keys.add(k);
        keys.add(`${k}#value`);
      }
    return [...keys];
  };
  const regions = () => {
    const out = [];
    // Pictures first, then still images: a path-traced page shows a traced still until its live view starts, and a
    // setting may swap one still for another.
    for (const el of [...document.querySelectorAll('canvas,svg,video,[role=img]'), ...document.querySelectorAll('img')]) {
      if (el.tagName.toLowerCase() === 'svg' && el.parentElement?.closest('svg')) continue;
      if (el.closest(SEL)) continue;
      if (el.getAttribute('role') === 'img' && el.querySelector('canvas,svg')) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 64 || r.height < 48 || !shown(el)) continue;
      const x = Math.max(0, r.left),
        y = Math.max(0, r.top),
        right = Math.min(innerWidth, r.right),
        bottom = Math.min(innerHeight, r.bottom);
      if (right - x < 32 || bottom - y < 32) continue;
      out.push({
        x: Math.round(x),
        y: Math.round(y),
        width: Math.floor(right - x),
        height: Math.floor(bottom - y),
        tag: el.tagName.toLowerCase(),
      });
    }
    return out.slice(0, 8);
  };
  const scene = () => {
    let best = null;
    for (const c of document.querySelectorAll('canvas')) {
      const r = c.getBoundingClientRect();
      if (shown(c) && r.width * r.height > (best ? best.r.width * best.r.height : 0)) best = { c, r };
    }
    return best?.c ?? null;
  };
  const describe = (el) =>
    el
      ? `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/).join('.')}` : ''}`
      : 'nothing';
  const hits = (el, t, x, y) => {
    const hit = document.elementFromPoint(x, y);
    if (!hit) return { ok: false, by: 'nothing' };
    if (t.contains(hit) || el.contains(hit) || hit === el) return { ok: true };
    const label = hit.closest('label');
    if (label && (label.control === el || labelsOf(el).includes(label))) return { ok: true };
    // A face of a CSS 3D widget (a view cube) that is turned away is hidden by design, not covered.
    for (let a = el.parentElement, i = 0; a && i < 4; a = a.parentElement, i++)
      if (getComputedStyle(a).transformStyle === 'preserve-3d' && a.contains(hit)) return { ok: true, face: true };
    return { ok: false, by: describe(hit) };
  };
  const layout = (paths) => {
    const sx = scrollX,
      sy = scrollY;
    const out = {};
    for (const p of paths) {
      const el = document.querySelector(p);
      if (!el) continue;
      const t = target(el);
      t.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const r = t.getBoundingClientRect();
      const off =
        r.width < 1 || r.height < 1 || r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight;
      const clipped = !off && (r.left < -1 || r.right > innerWidth + 1);
      let covered = null,
        face = false;
      if (!off) {
        const cy = Math.min(innerHeight - 1, Math.max(0, r.top + r.height / 2));
        const xs = el.type === 'range' ? [0.1, 0.5, 0.9] : [0.5];
        for (const f of xs) {
          const h = hits(el, t, Math.min(innerWidth - 1, Math.max(0, r.left + r.width * f)), cy);
          if (h.face) face = true;
          if (!h.ok) {
            covered = { by: h.by, where: f === 0.5 ? 'centre' : f < 0.5 ? 'left end' : 'right end' };
            break;
          }
        }
      }
      out[p] = { off, clipped, covered, ...(face ? { face } : {}) };
    }
    scrollTo({ left: sx, top: sy, behavior: 'instant' });
    return {
      controls: out,
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
      scrollWidth: document.documentElement.scrollWidth,
    };
  };
  const invites = () => {
    const c = scene();
    if (!c) return false;
    const cur = getComputedStyle(c).cursor;
    // Only an explicit invitation counts: a grab cursor, or text that tells the reader to drag the view.
    if (/grab|move|all-scroll/.test(cur)) return `cursor: ${cur}`;
    const hint = document.body.innerText.match(
      /[^.\n]*\b(drag|swipe)\s+(to|the|on|across|or|and|it|in|anywhere)\b[^.\n]*/i,
    );
    return hint ? hint[0].trim().slice(0, 120) : false;
  };
  window.__ctl = Object.freeze({
    counters: () => ({
      raf: state.raf,
      frames: state.frames,
      events: state.events.length,
      errors: state.errors.length,
    }),
    eventsSince: (i) => state.events.slice(i),
    errorsSince: (i) => state.errors.slice(i),
    list,
    text,
    ownKeys,
    regions,
    layout,
    invites,
    sceneBox: () => {
      const c = scene();
      if (!c) return null;
      const r = c.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, height: r.height };
    },
    revealScene: () => {
      const c = scene();
      if (c) c.scrollIntoView({ block: 'nearest', behavior: 'instant' });
      return scrollY;
    },
    state: (p) => {
      const el = document.querySelector(p);
      if (!el) return null;
      return {
        checked:
          !!el.checked || el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-selected') === 'true',
        pressed: el.getAttribute('aria-pressed') ?? el.getAttribute('aria-expanded'),
        text: clean(el.textContent),
        value: el.value,
      };
    },
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Serving and the browser.
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.glb': 'model/gltf-binary',
  '.ktx2': 'image/ktx2',
  '.hdr': 'image/vnd.radiance',
  '.bin': 'application/octet-stream',
};
const server = http.createServer((req, res) => {
  let file = path.join(demos, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(demos)) {
    res.writeHead(403);
    res.end();
    return;
  }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
if (!usage) server.listen(0);
const port = usage ? 0 : server.address().port;

// Installed Chrome has a working WebGPU adapter; the bundled Chromium fails to spawn here. Occlusion and background
// throttling are off so a covered window keeps drawing.
const launchArgs = [
  '--enable-unsafe-webgpu',
  '--window-size=1500,1000',
  '--disable-features=CalculateNativeWinOcclusion',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
];
let browserServer = null,
  browser = null;
async function openBrowser() {
  browserServer = await chromium.launchServer({ channel: 'chrome', headless: false, args: launchArgs });
  browser = await chromium.connect(browserServer.wsEndpoint());
}
async function restartBrowser() {
  try {
    killTree(browserServer.process());
  } catch {}
  await sleep(1000);
  await openBrowser();
}

// ---------------------------------------------------------------------------------------------------------------
// One page session: load, capture, operate.
class Session {
  constructor(slug, { reducedMotion, wait, backend = 'webgpu' }) {
    this.slug = slug;
    this.backend = backend;
    this.reducedMotion = reducedMotion;
    this.wait = wait;
    this.consoleErrors = [];
    this.nodeEvents = [];
    this.navigated = 0;
    this.noisy = new Set();
    this.frameSeq = 0;
  }
  async open() {
    this.context = await browser.newContext({
      viewport: DESKTOP,
      deviceScaleFactor: 1,
      reducedMotion: this.reducedMotion,
      acceptDownloads: true,
    });
    await this.context.addInitScript(probe);
    this.page = await this.context.newPage();
    const page = this.page;
    page.on('console', (m) => {
      if (m.type() === 'error') this.consoleErrors.push({ at: Date.now(), text: m.text().slice(0, 300) });
    });
    page.on('pageerror', (e) =>
      this.consoleErrors.push({ at: Date.now(), text: `page error: ${e.message}`.slice(0, 300) }),
    );
    page.on('dialog', (d) => {
      this.nodeEvents.push(`showed a ${d.type()} dialog`);
      d.dismiss().catch(() => {});
    });
    page.on('download', (d) => {
      this.nodeEvents.push('downloaded a file');
      d.cancel().catch(() => {});
    });
    page.on('filechooser', () => this.nodeEvents.push('opened a file chooser'));
    page.on('popup', (p) => {
      this.nodeEvents.push('opened a window');
      p.close().catch(() => {});
    });
    page.on('framenavigated', (f) => {
      if (f === page.mainFrame() && this.loaded) this.navigated++;
    });
    return this.load();
  }
  async load() {
    this.loaded = false;
    const page = this.page;
    await page.goto(`http://localhost:${port}/${this.slug}/${this.backend === 'webgl2' ? '?backend=webgl2' : ''}`, {
      waitUntil: 'load',
      timeout: loadTimeout,
    });
    this.loaded = true;
    const state = await page
      .waitForFunction(
        () => {
          // data-error="false" (glsl-welcome's status line) means no error.
          if (document.querySelector('[data-error]:not([data-error="false"]):not([data-error=""]), [data-state="error"]')) return 'error';
          return document.querySelector('[data-ready], [data-state="ready"]') ? 'ready' : false;
        },
        null,
        { timeout: loadTimeout },
      )
      .then((h) => h.jsonValue())
      .catch(() => 'not-ready');
    const error =
      state === 'error'
        ? await this.eval(
            () =>
              document.querySelector('[data-error]:not([data-error="false"]):not([data-error=""])')?.dataset.error ??
              document.querySelector('[role=alert]')?.textContent ??
              'error',
          )
        : null;
    await sleep(1500);
    this.scrollY = await this.eval(() => window.__ctl.revealScene());
    await sleep(300);
    return { state, error };
  }
  eval(fn, arg, ms = 15000) {
    return within(this.page.evaluate(fn, arg), ms, 'a page script');
  }
  async close() {
    await within(this.context.close(), 15000, 'closing the page').catch(() => {});
  }
  /** Pictures, readouts and counters now. `dims` fixes the working size of each picture to the earlier capture. */
  async capture(dims) {
    await this.eval((y) => scrollTo({ left: 0, top: y, behavior: 'instant' }), this.scrollY);
    const info = await this.eval(() => ({
      regions: window.__ctl.regions(),
      text: window.__ctl.text(),
      counters: window.__ctl.counters(),
    }));
    const frames = [];
    let shot = null;
    if (info.regions.length) {
      const x0 = Math.min(...info.regions.map((r) => r.x)),
        y0 = Math.min(...info.regions.map((r) => r.y)),
        x1 = Math.max(...info.regions.map((r) => r.x + r.width)),
        y1 = Math.max(...info.regions.map((r) => r.y + r.height));
      shot = await within(
        this.page.screenshot({
          clip: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 },
          type: 'png',
          caret: 'hide',
          timeout: 15000,
        }),
        20000,
        'a screenshot',
      );
      const meta = await sharp(shot).metadata();
      for (let i = 0; i < info.regions.length; i++) {
        const r = info.regions[i];
        const left = Math.min(meta.width - 1, r.x - x0),
          top = Math.min(meta.height - 1, r.y - y0);
        const width = Math.max(1, Math.min(r.width, meta.width - left)),
          height = Math.max(1, Math.min(r.height, meta.height - top));
        const w = dims?.[i]?.width ?? Math.min(WORK, width),
          h = dims?.[i]?.height ?? Math.max(1, Math.round((height * w) / width));
        const data = await sharp(shot)
          .extract({ left, top, width, height })
          .resize(w, h, { fit: 'fill' })
          .removeAlpha()
          .raw()
          .toBuffer();
        frames.push({ width: w, height: h, data, tag: r.tag, box: [r.x, r.y, r.width, r.height] });
      }
    }
    return { frames, text: info.text, counters: info.counters, shot, at: Date.now() };
  }
  async pre() {
    const a = await this.capture();
    await sleep(this.wait);
    const b = await this.capture(a.frames);
    for (const k of noisyKeys(a.text, b.text)) this.noisy.add(k);
    return { a, b };
  }
  /** Runs one input between the `pre` pair and a new pair, and judges it. */
  async step(control, pre, name, act) {
    const errorsAt = this.consoleErrors.length,
      eventsAt = this.nodeEvents.length,
      navAt = this.navigated;
    const own = new Set(await this.eval((p) => window.__ctl.ownKeys(p), control.path));
    const how = await act();
    await sleep(this.wait);
    const regionsMatch = (c) =>
      c.frames.length === pre.b.frames.length &&
      c.frames.every((f, i) => f.tag === pre.b.frames[i].tag && f.box.join() === pre.b.frames[i].box.join());
    const q0 = await this.capture(pre.b.frames);
    await sleep(this.wait);
    const q1 = await this.capture(pre.b.frames);
    const nav = this.navigated > navAt;
    const layoutChanged = !nav && (!regionsMatch(q0) || !regionsMatch(q1));
    const regions = [],
      noiseBefore = [],
      noiseAfter = [];
    if (!layoutChanged && !nav) {
      for (let i = 0; i < pre.b.frames.length; i++) {
        const noise = noiseFloor(pre.a.frames[i], pre.b.frames[i]);
        let r = compareRegion(pre.b.frames[i], q0.frames[i], noise);
        // A steady picture may answer late (a rebuild in a worker): the second frame counts there too.
        if (!r.changed && noise.count < 12) {
          const late = compareRegion(pre.b.frames[i], q1.frames[i], noise);
          if (late.changed) r = { ...late, late: true };
        }
        regions.push(r);
        noiseBefore.push(noise);
        noiseAfter.push(noiseFloor(q0.frames[i], q1.frames[i]));
      }
    }
    const motion = noiseBefore.some((n, i) => motionChanged(n, noiseAfter[i]));
    const t0 = textChanges(pre.b.text, q0.text, this.noisy, own),
      t1 = textChanges(pre.b.text, q1.text, this.noisy, own);
    const text = { changed: [...new Set([...t0.changed, ...t1.changed])], own: [...new Set([...t0.own, ...t1.own])] };
    const pageEvents = await this.eval((i) => window.__ctl.eventsSince(i), pre.b.counters.events);
    const pageErrors = await this.eval((i) => window.__ctl.errorsSince(i), pre.b.counters.errors);
    // Side effects the page also makes with no input (a sound loop ramping its gain) are noise, like the pictures.
    const idle = new Set(
      (await this.eval((i) => window.__ctl.eventsSince(i), pre.a.counters.events)).slice(
        0,
        pre.b.counters.events - pre.a.counters.events,
      ),
    );
    const events = [
      ...new Set([
        ...pageEvents.filter((e) => !idle.has(e)),
        ...this.nodeEvents.slice(eventsAt),
        ...(nav ? ['went to another page'] : []),
      ]),
    ];
    const verdict = judgeStep({ regions, motion, text, events, layoutChanged });
    // A dead input may still have changed a few pixels too faintly to see at the working size (a 1 px tracer):
    // measured at full size and reported, the verdict stays dead because a viewer sees nothing either.
    let faint = null;
    if (verdict.verdict === 'dead' && pre.a.shot && pre.b.shot && q0.shot)
      faint = await faintChange(pre.a.shot, pre.b.shot, q0.shot);
    const errors = [...this.consoleErrors.slice(errorsAt).map((e) => e.text), ...pageErrors];
    const sample = text.changed
      .slice(0, 3)
      .map((k) => `${(pre.b.text[k] ?? '').slice(0, 40)} -> ${(q0.text[k] ?? q1.text[k] ?? '').slice(0, 40)}`);
    if (saveFrames && pre.b.shot && q0.shot && (saveFrames === 'all' || verdict.verdict !== 'live')) {
      const dir = path.join(reportDir, 'frames', this.slug);
      fs.mkdirSync(dir, { recursive: true });
      const base = `${String(++this.frameSeq).padStart(3, '0')}-${control.label.replace(/[^a-z0-9]+/gi, '-').slice(0, 40)}-${name.replace(/[^a-z0-9]+/gi, '-')}`;
      fs.writeFileSync(path.join(dir, `${base}-a.png`), pre.b.shot);
      fs.writeFileSync(path.join(dir, `${base}-b.png`), q0.shot);
    }
    const result = {
      action: name,
      how,
      verdict: verdict.verdict,
      evidence: verdict.evidence,
      labelOnly: verdict.labelOnly,
      ...(faint ? { faint } : {}),
      pictures: regions.map((r) => ({
        count: r.count,
        outside: r.outside,
        mean: r.mean,
        noiseCount: r.noiseCount,
        noiseMean: r.noiseMean,
        conclusive: r.conclusive,
        late: !!r.late,
      })),
      readouts: sample,
      errors,
    };
    if (nav) {
      await this.load();
      return { result, post: await this.pre() };
    }
    return { result, post: { a: q0, b: q1 } };
  }
}

/** Full-size count of pixels that moved by 4 or more levels, against the same count with no input. */
async function faintChange(a, b, c) {
  const raw = (png) => sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const [A, B, C] = await Promise.all([raw(a), raw(b), raw(c)]);
  if (
    A.info.width !== C.info.width ||
    A.info.height !== C.info.height ||
    B.info.width !== C.info.width ||
    B.info.height !== C.info.height
  )
    return null;
  const count = (x, y) => {
    let n = 0,
      max = 0;
    for (let i = 0; i < y.length; i += 3) {
      const d = Math.max(Math.abs(x[i] - y[i]), Math.abs(x[i + 1] - y[i + 1]), Math.abs(x[i + 2] - y[i + 2]));
      if (d >= 4) n++;
      if (d > max) max = d;
    }
    return { n, max };
  };
  const noise = count(A.data, B.data),
    change = count(B.data, C.data);
  return change.n >= 50 && change.n >= 4 * noise.n ? { pixels: change.n, max: change.max, noise: noise.n } : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Inputs per kind of control.
async function setValue(s, p, v) {
  const entered = await s.eval(
    ([p, v]) => {
      const el = document.querySelector(p);
      el.focus({ preventScroll: true });
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      // A typed field in a form with a submit button ("Lower limit" then "Apply range") acts when Enter submits the
      // form, as a visitor would press it. The page handles the submit; the window listener, last in line, only
      // stops a form without a handler from leaving the page.
      if (!el.form || !/^(number|text|search)$/.test(el.type) || !el.form.querySelector('[type=submit],button:not([type])')) return false;
      const stay = (e) => e.preventDefault();
      window.addEventListener('submit', stay);
      try {
        el.form.requestSubmit();
      } finally {
        window.removeEventListener('submit', stay);
      }
      return true;
    },
    [p, String(v)],
  );
  return entered ? 'set, Enter' : 'set';
}
async function setIndex(s, p, i) {
  await s.eval(
    ([p, i]) => {
      const el = document.querySelector(p);
      el.selectedIndex = i;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    },
    [p, i],
  );
  return 'set';
}
/** A real mouse click; when Playwright cannot click it (covered, moving, off-screen) the events are sent directly. */
async function click(s, p) {
  const visible = await s.eval((p) => {
    const el = document.querySelector(p);
    const r = el?.getBoundingClientRect();
    return !!r && r.width > 0 && r.height > 0 && el.checkVisibility({ checkOpacity: true });
  }, p);
  const loc = visible
    ? s.page.locator(p).first()
    : s.page.locator(`label[for="${await s.eval((p) => document.querySelector(p)?.id ?? '', p)}"]`).first();
  try {
    await loc.click({ timeout: 2500 });
    return 'click';
  } catch {
    await s.eval((p) => {
      const el = document.querySelector(p);
      for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup'])
        el.dispatchEvent(
          new (t.startsWith('pointer') ? PointerEvent : MouseEvent)(t, {
            bubbles: true,
            cancelable: true,
            composed: true,
          }),
        );
      el.click();
    }, p);
    return 'events sent (a real click could not reach it)';
  }
}
async function dragScene(s) {
  const box = await s.eval(() => window.__ctl.sceneBox());
  if (!box) return 'no scene';
  await s.eval((y) => scrollTo({ left: 0, top: y, behavior: 'instant' }), s.scrollY);
  const m = s.page.mouse;
  await m.move(box.x, box.y);
  await m.down();
  for (let i = 1; i <= 10; i++) await m.move(box.x + i * 14, box.y + i * 4);
  await m.up();
  return 'drag';
}
async function keys(s, p, key) {
  await s.page.locator(p).first().focus({ timeout: 2500 });
  await s.page.keyboard.press(key);
  return `key ${key}`;
}

const isReset = (c) => /\b(reset|restore|recent(er|re)|home|default)/i.test(c.label);
function sliderValues(c) {
  const min = Number(c.min === '' ? 0 : c.min),
    max = Number(c.max === '' ? 100 : c.max),
    step = c.step === 'any' || c.step === '' ? 0 : Number(c.step);
  if (!(max > min)) return [];
  let mid = (min + max) / 2;
  if (step > 0) mid = min + Math.round((mid - min) / step) * step;
  const cur = Number(c.value);
  const out = [];
  for (const [name, v] of [
    ['max', max],
    ['min', min],
    ['middle', mid],
  ])
    if (v !== (out.length ? out.at(-1)[1] : cur)) out.push([name, v]);
  return out;
}
function numberValues(c) {
  if (c.min !== '' && c.max !== '') return sliderValues(c);
  const cur = Number(c.value) || 0,
    step = Number(c.step) > 0 ? Number(c.step) : 1;
  return [
    ['up', cur + step * 5],
    ['down', cur - step * 5],
  ];
}
function shiftedValue(c) {
  const t = c.value;
  if (/^#[0-9a-f]{6}$/i.test(t)) return t.toLowerCase() === '#ff0000' ? '#0000ff' : '#ff0000';
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) {
    const d = new Date(`${t}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + 3);
    return d.toISOString().slice(0, 10);
  }
  if (/^\d{2}:\d{2}/.test(t)) return t.startsWith('06') ? '18:00' : '06:00';
  return null;
}

/** Tests one control (or one radio group) and returns its records. */
async function testControl(s, c, group, plan = {}) {
  const records = [];
  const rec = (control) => {
    let r = records.find((x) => x.path === control.path);
    if (!r) records.push((r = { path: control.path, kind: control.kind, label: control.label, steps: [] }));
    return r;
  };
  let pre;
  // The settled picture at each stop of a slider or select, to find stops that draw the same picture.
  const stops = [];
  const stopOf = (name, value, pair) => ({
    name,
    value: String(value),
    frames: pair.b.frames,
    noise: pair.b.frames.map((f, i) => noiseFloor(pair.a.frames[i], f)),
  });
  const run = async (control, name, act, value) => {
    if (value !== undefined && !stops.length)
      stops.push(stopOf('start', control.kind === 'select' ? control.selectedIndex : (control.value ?? 'start'), pre));
    const { result, post } = await s.step(control, pre, name, act);
    if (result.verdict === 'dead' && /could not reach/.test(result.how)) result.verdict = 'unreachable';
    rec(control).steps.push(result);
    if (value !== undefined && post.a.frames.length === post.b.frames.length) stops.push(stopOf(name, value, post));
    pre = post;
  };
  // A sound control (volume, mute) only has something to act on while sound plays: start playback first.
  let stopSound = null;
  if (SOUND.test(c.label) && c.kind !== 'button') {
    const player = await s.eval(() =>
      window.__ctl
        .list()
        .find(
          (x) =>
            x.kind === 'button' &&
            !x.disabled &&
            /\b(play|listen|hear|start|sound on)\b/i.test(x.label) &&
            !/\b(stop|pause)\b/i.test(x.label),
        ),
    );
    if (player) {
      await click(s, player.path);
      await sleep(s.wait);
      stopSound = async () => {
        const stop = await s.eval(() =>
          window.__ctl.list().find((x) => x.kind === 'button' && !x.disabled && /\b(stop|pause)\b/i.test(x.label)),
        );
        if (stop) await click(s, stop.path);
      };
    }
  }
  try {
    const out = await operate(
      s,
      c,
      group,
      plan,
      records,
      rec,
      run,
      () => pre,
      (v) => (pre = v),
    );
    const same = stops.length > 2 ? identicalStops(stops, { period: periodOf(c) }) : [];
    const r = records.find((x) => x.path === c.path);
    if (same.length && r) r.sameStops = same;
    return out;
  } finally {
    if (stopSound) await stopSound().catch(() => {});
  }
}
/**
 * Controls that act on something the page was not doing when they were tried are unsure, not dead: a sound control
 * changes what is heard, and a speed or playback control acts only while something plays. A speed control counts as
 * dead only when the picture was moving during one of its tries and still did not change.
 */
function refine(c, d) {
  const period = c.sameStops?.length ? periodOf(c) : 0;
  if (period) {
    // Records made before whole turns were recognised: drop pairs such as -180 and 180 degrees.
    const valueOf = (name) => Number(/\(([-+\d.e]+)\)\s*$/.exec(name)?.[1]);
    const turns = (a, b) => Math.abs(valueOf(a) - valueOf(b)) / period;
    c.sameStops = c.sameStops.filter(([a, b]) => {
      const t = turns(a, b);
      return !(t > 0.5 && Math.abs(t - Math.round(t)) < 1e-6);
    });
    if (!c.sameStops.length) delete c.sameStops;
  }
  if (c.verdict !== 'dead') return c;
  const hint =
    d?.dragHint ??
    pageText(d?.slug ?? d?.demo)
      .match(/[^.]*\b(drag|swipe)\b[^.]*/i)?.[0]
      ?.trim() ??
    '';
  if (
    c.kind === 'canvas-drag' &&
    /\b(draw|paint|sketch|brush|lasso|box|select|place|cut|carve|sculpt|stroke)/i.test(hint)
  )
    return Object.assign(c, {
      verdict: 'unsure',
      note: `the page asks for a particular gesture: "${hint.slice(0, 100)}"`,
    });
  if (TOOL.test(c.label))
    return Object.assign(c, {
      verdict: 'unsure',
      note: 'a tool or mode for the next click or drag on the scene; nothing to see until then',
    });
  if (c.kind !== 'canvas-drag' && HANDLE.test(c.label))
    return Object.assign(c, {
      verdict: 'unsure',
      note: 'a drag handle: it acts when dragged, and a click does nothing by design',
    });
  const held = alreadyHeld(c, d);
  if (held)
    return Object.assign(c, {
      verdict: 'unsure',
      note: `already holds ${held}, what a click puts there; its neighbours holding other values changed the picture`,
    });
  // On a page you draw on (a brush, a sculpting tool, planting points), the tools and brushes act on the next stroke.
  const gesture = pageText(d?.slug ?? d?.demo).match(GESTURE);
  if (gesture && c.kind !== 'canvas-drag')
    return Object.assign(c, {
      verdict: 'unsure',
      note: `a tool or brush for the next stroke on a page that says "${gesture[0].trim().slice(0, 80)}"`,
    });
  const steps = [...(c.steps ?? []), ...(c.confirm?.steps ?? [])];
  if (SOUND.test(c.label))
    Object.assign(c, { verdict: 'unsure', note: 'a sound control: nothing to see, and no sound setting changed' });
  else if (PLAYBACK.test(c.label) && steps.every((st) => (st.pictures ?? []).every((p) => p.noiseCount === 0)))
    Object.assign(c, { verdict: 'unsure', note: 'a speed or playback control and nothing was playing' });
  return c;
}
const START =
  /\b(play|run|start|spin|release|drop|launch|fire|go|animate|tip|swing|pump|drive|wind|roll|pour|flow|trigger|strike|flash|cast|turn on|switch on)\b/i;
const GESTURE =
  /[^.]*\b(drag|tap|click)\b[^.]{0,60}\b(strokes?|draw(?!\s+order)|paint|recolou?r|brush|plant|place|erase|sculpt|carve|tap the map)\b[^.]*|[^.]*\bchoose a \w+, then (tap|click|drag)[^.]*/i;
const pageTexts = new Map();
/** The static text of a demo page, for instructions such as "Drag over the clay to make a stroke". */
function pageText(slug) {
  if (!slug) return '';
  if (!pageTexts.has(slug)) {
    const file = path.join(demos, slug, 'index.html');
    pageTexts.set(
      slug,
      fs.existsSync(file)
        ? fs
            .readFileSync(file, 'utf8')
            .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ')
            .replace(/<[^>]*>/g, ' ')
            .replace(/\s+/g, ' ')
        : '',
    );
  }
  return pageTexts.get(slug);
}
const HANDLE = /^(drag|grab|move|reorder|resize)\b/i;
/** A slider that turns something through whole turns: -180 and 180 degrees draw the same picture by design. */
function periodOf(c) {
  // A live control carries min and max; a saved record keeps them only in its step names ("to max (360)").
  const end = (which) => c[which] ?? /\(([-+\d.e]+)\)/.exec((c.steps ?? []).find((s) => s.action?.startsWith(`to ${which} `))?.action ?? '')?.[1];
  const span = Number(end('max')) - Number(end('min'));
  if (Math.abs(span - 2 * Math.PI) < 1e-3) return 2 * Math.PI;
  return span >= 360 &&
    /°|\b(deg|degrees|turn|rotat\w*|angle|heading|yaw|bearing|azimuth|spin|hue|longitude)\b/i.test(c.label ?? '')
    ? 360
    : 0;
}
/**
 * A grid of cells named "Row 2, column 4, Saffron": a click paints the cell with the current colour, so a cell that
 * already holds it changes nothing. When every dead cell holds one value and live cells of the same grid hold others,
 * the dead ones are already in the state a click gives. Returns that value, or ''.
 */
function alreadyHeld(c, d) {
  const split = (label) => /^(.*\S),\s*([^,]+)$/.exec(label ?? '');
  const own = split(c.label);
  if (!own || !d?.controls) return '';
  const shape = (s) => s.replace(/\d+/g, '#');
  const same = d.controls.filter(
    (o) => o.kind === c.kind && split(o.label) && shape(split(o.label)[1]) === shape(own[1]),
  );
  const dead = same.filter(
    (o) => o.verdict === 'dead' || (o.verdict === 'unsure' && o.note?.startsWith('already holds')),
  );
  const live = same.filter((o) => o.verdict === 'live');
  if (
    live.length < 3 ||
    dead.some((o) => split(o.label)[2] !== own[2]) ||
    live.some((o) => split(o.label)[2] === own[2])
  )
    return '';
  return own[2];
}
// "Draw" alone is a tool; "Reverse draw order" is a setting that should change the picture.
const TOOL = /\b(brush|eraser?|pen|pencil|paint|pick|tool|stamp|marker|lasso)\b|^draw$/i;
const PLAYBACK = /\b(speed|rate|tempo|time ?scale|playback|slow(er)?|fast(er)?)\b/i;
/** A sound control that changed nothing to see may still change what is heard: unsure, never dead. */
const soundAware = (verdict, label) => (verdict === 'dead' && SOUND.test(label) ? 'unsure' : verdict);
const SOUND = /\b(volume|gain|loudness|mute|sounds?|audio|audible)\b/i;

async function operate(s, c, group, plan, records, rec, run, getPre, setPre) {
  if (c.kind === 'range' || c.kind === 'number') {
    const values = c.kind === 'range' ? sliderValues(c) : numberValues(c);
    if (!values.length) return [{ ...rec(c), skipped: 'no range to move through' }];
    setPre(await s.pre());
    for (const [name, v] of values) await run(c, `to ${name} (${v})`, () => setValue(s, c.path, v), v);
    await setValue(s, c.path, c.value);
  } else if (c.kind === 'value') {
    const v = shiftedValue(c);
    if (v == null) return [{ ...rec(c), skipped: `cannot pick another value for "${c.value}"` }];
    setPre(await s.pre());
    await run(c, `to ${v}`, () => setValue(s, c.path, v));
    await setValue(s, c.path, c.value);
  } else if (c.kind === 'aria-slider') {
    setPre(await s.pre());
    for (const k of ['End', 'Home', 'PageUp']) await run(c, `key ${k}`, () => keys(s, c.path, k), k);
  } else if (c.kind === 'select') {
    const opts = c.options.map((o, i) => ({ ...o, i })).filter((o) => o.i !== c.selectedIndex && !o.disabled);
    const pick =
      opts.length > 8 ? Array.from({ length: 8 }, (_, k) => opts[Math.round((k * (opts.length - 1)) / 7)]) : opts;
    if (!pick.length) return [{ ...rec(c), skipped: 'only one option' }];
    setPre(await s.pre());
    for (const o of pick) await run(c, `option "${o.label}"`, () => setIndex(s, c.path, o.i), o.i);
    await setIndex(s, c.path, c.selectedIndex);
  } else if (c.kind === 'checkbox') {
    setPre(await s.pre());
    await run(c, 'toggle', () => click(s, c.path));
    await run(c, 'toggle back', () => click(s, c.path));
  } else if (c.kind === 'radio') {
    const members = group ?? [c];
    const home = members.find((m) => m.checked) ?? members[0];
    if (plan.only) {
      // Confirming one member: move off it first, unmeasured, then choose it.
      const other = members.find((m) => m.path !== c.path && !m.disabled);
      if (other && c.checked !== false) {
        await click(s, other.path);
        await sleep(s.wait);
      }
      setPre(await s.pre());
      await run(c, 'choose', () => click(s, c.path));
    } else {
      setPre(await s.pre());
      for (const m of members) {
        if (m.path === home.path || m.disabled) continue;
        await run(m, 'choose', () => click(s, m.path));
        if (members.length <= 6 || m === members.filter((x) => x.path !== home.path).at(-1))
          await run(home, `choose again after "${m.label}"`, () => click(s, home.path));
        else await click(s, home.path);
      }
      if (!records.find((r) => r.path === home.path)) rec(home);
    }
  } else if (c.kind === 'canvas-drag') {
    setPre(await s.pre());
    await run(c, 'drag the scene', () => dragScene(s));
  } else if (c.kind === 'button') {
    if (isReset(c) || plan.only) {
      // A reset only shows when there is something to reset: turn the view and move the first slider first. On the
      // second try every button gets this, and a neighbouring button is pressed first, so a view or preset button
      // that was already in its own state gets a chance to show it.
      if (plan.only) {
        const sibling = await s.eval((p) => {
          const el = document.querySelector(p);
          const near = [...(el?.parentElement?.children ?? [])].find(
            (b) => b !== el && b.matches('button:not(:disabled)') && b.checkVisibility(),
          );
          if (!near) return null;
          const parts = [];
          for (let e = near; e && e !== document.body && e.parentElement; e = e.parentElement)
            parts.unshift(
              `${e.tagName.toLowerCase()}:nth-child(${Array.prototype.indexOf.call(e.parentElement.children, e) + 1})`,
            );
          return `body > ${parts.join(' > ')}`;
        }, c.path);
        if (sibling) await click(s, sibling);
      }
      await dragScene(s);
      await s.eval(() => {
        const r = document.querySelector('input[type=range]:not(:disabled)');
        if (r) {
          r.value = r.value === r.max ? r.min : r.max;
          r.dispatchEvent(new Event('input', { bubbles: true }));
          r.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });
      await sleep(s.wait);
    }
    setPre(await s.pre());
    const before = await s.eval((p) => window.__ctl.state(p), c.path);
    await run(c, 'click', () => click(s, c.path));
    const after = await s.eval((p) => window.__ctl.state(p), c.path);
    if (
      before &&
      after &&
      (before.pressed !== after.pressed || before.text !== after.text) &&
      rec(c).steps.at(-1).verdict !== 'live'
    )
      await run(c, 'click again', () => click(s, c.path));
    else if (before && after && before.pressed !== after.pressed) await click(s, c.path);
  } else {
    return [{ ...rec(c), skipped: `${c.kind} input is not operated (free text or file)` }];
  }
  return records;
}

// ---------------------------------------------------------------------------------------------------------------
// One demo.
async function runDemo(slug, backend) {
  const started = Date.now();
  const s = new Session(slug, { reducedMotion: 'reduce', wait: WAIT, backend });
  const out = {
    demo: backend === 'webgpu' ? slug : `${slug}@${backend}`,
    slug,
    backend,
    checked: new Date().toISOString(),
    status: 'ok',
    controls: [],
  };
  let budget = 90000;
  const deadline = () => started + budget;
  try {
    const { state, error } = await s.open();
    out.status = state === 'ready' ? 'ok' : state;
    if (error) out.error = error.slice(0, 300);
    out.loadErrors = s.consoleErrors.map((e) => e.text);
    out.renderer = await s.eval(() => document.body.dataset.renderer ?? null);
    if (state === 'error') return out;
    // Readouts that tick on their own (clocks, frame counters) are noise: watch them for two seconds first.
    let t = await s.eval(() => window.__ctl.text());
    for (let i = 0; i < 4; i++) {
      await sleep(500);
      const u = await s.eval(() => window.__ctl.text());
      for (const k of noisyKeys(t, u)) s.noisy.add(k);
      t = u;
    }
    const c0 = await s.eval(() => window.__ctl.counters());
    await sleep(1000);
    const c1 = await s.eval(() => window.__ctl.counters());
    out.framesPerSecond = c1.frames - c0.frames;
    let list = await s.eval(() => window.__ctl.list());
    budget = fixedBudget ? Number(fixedBudget) : Math.min(15 * 60000, 90000 + 30000 * list.length);
    const paths = list.map((c) => c.path);
    const desk = await s.eval((p) => window.__ctl.layout(p), paths);
    await s.page.setViewportSize(MOBILE);
    await sleep(1200);
    const mobilePaths = (await s.eval(() => window.__ctl.list())).map((c) => c.path);
    const mob = await s.eval((p) => window.__ctl.layout(p), [...new Set([...paths, ...mobilePaths])]);
    await s.page.setViewportSize(DESKTOP);
    await sleep(1500);
    s.scrollY = await s.eval(() => window.__ctl.revealScene());
    out.horizontalScroll = { desktop: desk.overflow, mobile: mob.overflow, mobileWidth: mob.scrollWidth };
    const hint = await s.eval(() => window.__ctl.invites());
    if (hint) {
      out.dragHint = hint;
      list.push({ path: 'canvas', kind: 'canvas-drag', label: 'Drag on the scene', hint });
    }
    const order = (c) => (c.kind === 'button' ? (isReset(c) ? 3 : 2) : c.kind === 'canvas-drag' ? 1 : 0);
    const done = new Set();
    for (let round = 0; round < 3; round++) {
      const todo = list.filter((c) => !done.has(`${c.path}|${c.label}`)).sort((a, b) => order(a) - order(b));
      if (!todo.length) break;
      const seenGroups = new Set();
      for (const c of todo) {
        const key = `${c.path}|${c.label}`;
        if (done.has(key)) continue;
        done.add(key);
        const base = { path: c.path, kind: c.kind, label: c.label, round };
        const lay = { desktop: desk.controls[c.path] ?? null, mobile: mob.controls[c.path] ?? null };
        if (c.disabled) {
          out.controls.push({ ...base, verdict: 'disabled', layout: lay });
          continue;
        }
        if (Date.now() > deadline()) {
          out.controls.push({ ...base, verdict: 'not tested', note: 'the page budget ran out', layout: lay });
          continue;
        }
        let group = null;
        if (c.kind === 'radio') {
          if (seenGroups.has(c.group)) continue;
          seenGroups.add(c.group);
          group = list.filter((m) => m.kind === 'radio' && m.group === c.group);
          for (const m of group) done.add(`${m.path}|${m.label}`);
        }
        const remaining = Math.max(10000, deadline() - Date.now());
        let records;
        try {
          records = await within(testControl(s, c, group), Math.min(remaining, 120000), `testing "${c.label}"`);
        } catch (error) {
          if (error instanceof Timeout) throw error;
          records = [{ ...base, steps: [], failed: error.message.split('\n')[0].slice(0, 200) }];
        }
        for (const r of records) {
          const j = judgeControl(r.steps ?? []);
          const errors = [...new Set((r.steps ?? []).flatMap((st) => st.errors))];
          out.controls.push({
            ...r,
            round,
            verdict: r.skipped ? 'skipped' : r.failed ? 'failed' : soundAware(j.verdict, r.label),
            labelOnly: j.labelOnly,
            textOnly:
              j.verdict === 'live' &&
              (r.steps ?? []).every((st) => st.verdict !== 'live' || st.evidence.every((e) => /readout/.test(e))),
            errors,
            layout: { desktop: desk.controls[r.path] ?? null, mobile: mob.controls[r.path] ?? null },
          });
        }
      }
      // Controls that appear only after another control (a tab, a mode) are tested in the next round.
      list = await s.eval(() => window.__ctl.list());
    }
    const e0 = await s.eval(() => window.__ctl.counters());
    await sleep(1500);
    const e1 = await s.eval(() => window.__ctl.counters());
    out.framesAtEnd = e1.frames - e0.frames;
    out.stalled = stalled({ frames: out.framesPerSecond }, { frames: out.framesAtEnd });
    // A page with a canvas that never drew a frame and never changed its picture while being operated is stuck.
    out.framesTotal = e1.frames;
    const pictureChanged = out.controls.some((c) =>
      (c.steps ?? []).some((st) => st.pictures?.some((p) => p.count > 0)),
    );
    out.noFrames =
      e1.frames === 0 && !pictureChanged && (await s.eval(() => document.querySelectorAll('canvas').length)) > 0;
    out.errorsAfterLoad = s.consoleErrors
      .slice(out.loadErrors.length)
      .map((e) => e.text)
      .slice(0, 20);
  } catch (error) {
    out.status = error instanceof Timeout ? 'hung' : 'failed';
    out.error = error.message.split('\n')[0].slice(0, 300);
  } finally {
    const closed = await within(s.close(), 20000, 'closing').then(
      () => true,
      () => false,
    );
    if (!closed || out.status === 'hung') await restartBrowser();
  }
  out.seconds = Math.round((Date.now() - started) / 1000);
  return out;
}

/** Tests a dead or unsure control again on a fresh page with normal motion and a longer wait. */
async function confirm(slug, backend, c, { running = false } = {}) {
  const s = new Session(slug, { reducedMotion: 'no-preference', wait: CONFIRM_WAIT, backend });
  try {
    const { state } = await within(s.open(), loadTimeout * 2 + 10000, 'loading');
    if (state === 'error') return { verdict: 'page error' };
    await sleep(1500);
    const list = await s.eval(() => window.__ctl.list());
    if (c.kind === 'canvas-drag') list.push({ path: 'canvas', kind: 'canvas-drag', label: 'Drag on the scene' });
    // A button whose label follows the page's mode (Fly to / Replay) is found by its place on a fresh page.
    const found =
      list.find((x) => x.path === c.path && x.label === c.label) ??
      list.find((x) => x.path === c.path && x.kind === c.kind) ??
      list.find((x) => x.label === c.label && x.kind === c.kind);
    if (!found) return { verdict: 'not found again' };
    if (found.disabled) return { verdict: 'disabled' };
    const group = found.kind === 'radio' ? list.filter((m) => m.kind === 'radio' && m.group === found.group) : null;
    // The third try: many controls (a coil current, a drag factor) act only while something runs. Start it first.
    let starter = null;
    if (running) {
      starter = list.find(
        (x) =>
          x.kind === 'button' &&
          !x.disabled &&
          x.path !== found.path &&
          START.test(x.label) &&
          !/\b(stop|pause|reset)\b/i.test(x.label),
      );
      if (!starter) return { verdict: 'nothing to start' };
      await click(s, starter.path);
      await sleep(1000);
    }
    const records = await within(testControl(s, found, group, { only: true }), 120000, 'confirming');
    const r = records.find((x) => x.path === found.path) ?? records[0];
    const j = judgeControl(r.steps ?? []);
    return {
      verdict: soundAware(j.verdict, r.label),
      labelOnly: j.labelOnly,
      steps: r.steps,
      errors: [...new Set((r.steps ?? []).flatMap((st) => st.errors))],
      ...(starter ? { started: starter.label } : {}),
    };
  } catch (error) {
    return { verdict: error instanceof Timeout ? 'hung' : 'failed', note: error.message.split('\n')[0].slice(0, 200) };
  } finally {
    const closed = await within(s.close(), 20000, 'closing').then(
      () => true,
      () => false,
    );
    if (!closed) await restartBrowser();
  }
}

function save() {
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  report.generated = new Date().toISOString();
  report.options = { wait: WAIT, confirmWait: CONFIRM_WAIT, viewport: DESKTOP, mobile: MOBILE };
  fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 1)}\n`);
}

// ---------------------------------------------------------------------------------------------------------------
// The human list.
const expected = {
  range: 'moving the slider changes the scene or a readout',
  number: 'changing the number changes the scene or a readout',
  value: 'changing the value changes the scene or a readout',
  'aria-slider': 'moving the slider changes the scene or a readout',
  select: 'each option changes the scene or a readout',
  checkbox: 'turning it on and off changes the scene or a readout',
  radio: 'choosing it changes the scene or a readout',
  button: 'clicking it changes the scene or a readout',
  'canvas-drag': 'dragging the scene turns or moves the view',
};
function problemsOf(d) {
  const rows = [];
  if (d.status !== 'ok')
    rows.push({
      label: '(page)',
      expected: 'the page loads and is marked ready',
      happened: `${d.status}${d.error ? `: ${d.error}` : ''}`,
    });
  if (d.noFrames)
    rows.push({
      label: '(page)',
      expected: 'the scene draws',
      happened: 'no frame was drawn and no picture changed while its controls were operated',
    });
  if (d.stalled)
    rows.push({
      label: '(page)',
      expected: 'the scene keeps drawing',
      happened: `drew ${d.framesPerSecond} frames a second at the start and none at the end`,
    });
  if (d.horizontalScroll?.mobile)
    rows.push({
      label: '(page)',
      expected: 'no sideways scroll at 390 px',
      happened: `the page is ${d.horizontalScroll.mobileWidth} px wide`,
    });
  for (const c of d.controls ?? []) {
    const what = [];
    if (c.verdict === 'dead') {
      what.push(
        c.labelOnly
          ? 'only its own label changed; the picture and readouts did not'
          : `nothing changed (${(c.steps ?? []).map((s) => s.action).join(', ')})`,
      );
      const f = [...(c.steps ?? []), ...(c.confirm?.steps ?? [])].find((s) => s.faint)?.faint;
      if (f) what.push(`${f.pixels} pixels changed by at most ${f.max}/255, too faint to see`);
    }
    if (c.verdict === 'failed') what.push(`could not be operated: ${c.failed}`);
    if (
      c.verdict === 'live' &&
      c.sameStops?.length &&
      (c.steps ?? []).some((st) => st.evidence.some((e) => e.startsWith('picture')))
    )
      what.push(`partly dead: ${c.sameStops.map(([a, b]) => `${a} and ${b}`).join(', ')} give the same picture`);
    if (c.verdict === 'unreachable' && !c.layout?.desktop?.face)
      what.push('a real click cannot reach it, and sending its events directly did nothing');
    if (c.errors?.length) what.push(`errors: ${c.errors.slice(0, 2).join(' | ')}`);
    const L = c.layout ?? {};
    for (const [name, l] of [
      ['1440x900', L.desktop],
      ['390x844', L.mobile],
    ]) {
      if (!l) continue;
      if (l.off) what.push(`off-screen at ${name}`);
      else if (l.clipped) what.push(`cut off at the side at ${name}`);
      if (l.covered) what.push(`covered at ${name} (${l.covered.where}) by ${l.covered.by}`);
    }
    if (what.length)
      rows.push({
        label: c.label,
        kind: c.kind,
        expected: expected[c.kind] ?? 'it does something',
        happened: what.join('; '),
        dead: c.verdict === 'dead',
      });
  }
  return rows;
}
/** How bad a demo's problems are, for the worst-first list: page faults weigh most, then dead controls. */
function severity(d, rows) {
  return rows.reduce(
    (sum, r) =>
      sum +
      (r.label === '(page)'
        ? /sideways/.test(r.expected)
          ? 1
          : 5
        : r.dead || /errors:|cannot reach/.test(r.happened)
          ? 3
          : 1),
    0,
  );
}
function writeMarkdown() {
  const ds = Object.values(report.demos).sort((a, b) => a.demo.localeCompare(b.demo));
  const all = (d) => d.controls ?? [];
  const slugOf = (d) => d.slug ?? d.demo;
  const backendOf = (d) => d.backend ?? 'webgpu';
  let controls = 0,
    dead = 0,
    unsure = 0;
  const whileRunning = [],
    unclear = [];
  // One row per demo and control; a row the same on both backends is written once with "both".
  const bySlug = new Map();
  for (const d of ds) {
    controls += all(d).filter((c) => !['disabled', 'skipped', 'not tested'].includes(c.verdict)).length;
    dead += all(d).filter((c) => c.verdict === 'dead').length;
    unsure += all(d).filter((c) => c.verdict === 'unsure').length;
    for (const c of all(d)) {
      if (c.verdict === 'live' && /acts only while/.test(c.note ?? ''))
        whileRunning.push(`- ${slugOf(d)} (${backendOf(d)}): ${c.label} (${c.note})`);
      if (c.verdict === 'unsure')
        unclear.push({
          where: `${slugOf(d)} (${backendOf(d)})`,
          label: c.label,
          note: c.note ?? 'the picture moves too much on its own to tell',
        });
    }
    const rows = problemsOf(d);
    if (!rows.length) continue;
    const entry = bySlug.get(slugOf(d)) ?? { slug: slugOf(d), rows: new Map(), score: 0 };
    entry.score = Math.max(entry.score, severity(d, rows));
    for (const r of rows) {
      const key = `${r.label}|${r.happened}`;
      const had = entry.rows.get(key);
      if (had) had.backends.add(backendOf(d));
      else entry.rows.set(key, { ...r, backends: new Set([backendOf(d)]) });
    }
    bySlug.set(slugOf(d), entry);
  }
  const ranked = [...bySlug.values()].sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug));
  const cell = (t) => String(t).replace(/\|/g, '/');
  const table = ['| Demo | Backend | Control | Expected | What happened |', '| --- | --- | --- | --- | --- |'];
  for (const e of [...ranked].sort((a, b) => a.slug.localeCompare(b.slug)))
    for (const r of e.rows.values())
      table.push(
        `| ${e.slug} | ${r.backends.size > 1 ? 'both' : [...r.backends][0]} | ${cell(r.label)} | ${r.expected} | ${cell(r.happened)} |`,
      );
  const lines = [
    '# Dead and broken demo controls',
    '',
    `Made by \`node scripts/web-demos/controls.mjs --all\` (WebGPU and \`?backend=webgl2\`) on ${report.generated?.slice(0, 10) ?? 'unknown'}; the full record is \`demos/.reports/controls.json\`. ${ds.length} demo runs, ${controls} controls operated, ${dead} dead, ${unsure} unsure, ${ranked.length} demos with at least one problem.`,
    '',
    "A control is dead when neither the canvas (beyond its own motion) nor any readout outside its own label changed: on the first pass with reduced motion, again on a fresh page with normal motion and a longer wait, and a third time after pressing the page's start button when it has one. Partly dead: two stops of the same slider or select draw the same picture.",
    '',
    '## Worst first',
    '',
    ...ranked.slice(0, 30).map(
      (e) =>
        `- ${e.slug}: ${[...e.rows.values()]
          .map((r) => `${r.label} (${r.happened.split(';')[0]})`)
          .join('; ')
          .slice(0, 300)}`,
    ),
    '',
    '## Every problem',
    '',
    ...table,
    '',
  ];
  if (whileRunning.length)
    lines.push(
      '## Controls that act only while something runs',
      '',
      'At rest, moving these changes only their own label. Worth a hint or a visible effect at rest.',
      '',
      ...whileRunning,
      '',
    );
  if (unclear.length) {
    // A grid of 144 cells with the same reason reads as one line.
    const groups = new Map();
    for (const u of unclear) {
      const key = `${u.where}|${u.note}`;
      if (!groups.has(key)) groups.set(key, { ...u, labels: [] });
      groups.get(key).labels.push(u.label);
    }
    const said = [...groups.values()].flatMap((g) =>
      g.labels.length > 3
        ? [`- ${g.where}: ${g.labels.length} controls such as ${g.labels.slice(0, 2).join('; ')} (${g.note})`]
        : g.labels.map((l) => `- ${g.where}: ${l} (${g.note})`),
    );
    lines.push('## Could not tell', '', ...said, '');
  }
  fs.mkdirSync(path.dirname(mdFile), { recursive: true });
  fs.writeFileSync(mdFile, `${lines.join('\n')}\n`);
  console.log(`wrote ${mdFile}`);
  return ranked.map((e) => ({ d: { slug: e.slug } }));
}

// ---------------------------------------------------------------------------------------------------------------
if (usage) {
  // Nothing to run: the usage line above is the whole output.
} else if (mdOnly) {
  // Judge again with the current rules: a dead control that an older rule called unsure goes back to dead first.
  const REFINED = /^(a tool or|the page asks for|a sound control|a speed or playback|a drag handle|already holds)/;
  for (const d of Object.values(report.demos))
    for (const c of d.controls ?? [])
      if (c.verdict === 'unsure' && REFINED.test(c.note ?? '')) Object.assign(c, { verdict: 'dead', note: undefined });
  for (const d of Object.values(report.demos)) for (const c of d.controls ?? []) refine(c, d);
  save();
  writeMarkdown();
  server.close();
} else {
  await openBrowser();
  let n = 0;
  for (const slug of names)
    for (const backend of backends) {
      n++;
      if (flag('resume') && report.demos[backend === 'webgpu' ? slug : `${slug}@${backend}`]) continue;
      const d = await runDemo(slug, backend);
      if (!flag('no-confirm')) {
        const flagged = d.controls.filter((c) => c.verdict === 'dead' || c.verdict === 'unsure');
        for (const c of flagged.slice(0, 12)) {
          const again = await confirm(slug, backend, c);
          c.confirm = again;
          if (again.verdict === 'live') c.verdict = 'live';
          else if (again.verdict === 'dead' && c.verdict === 'unsure') c.verdict = 'dead';
          if (again.errors?.length) c.errors = [...new Set([...(c.errors ?? []), ...again.errors])];
          if (c.verdict === 'dead' || c.verdict === 'unsure') {
            const third = await confirm(slug, backend, c, { running: true });
            c.whileRunning = third;
            if (third.verdict === 'live')
              Object.assign(c, {
                verdict: 'live',
                note: `acts only while "${third.started}" runs; at rest only its label changes`,
              });
            if (third.errors?.length) c.errors = [...new Set([...(c.errors ?? []), ...third.errors])];
          }
          refine(c, d);
        }
        for (const c of flagged.slice(12))
          c.confirm = { verdict: 'not confirmed', note: 'more than 12 flagged controls on the page' };
        for (const c of d.controls) refine(c, d);
      }
      report.demos[d.demo] = d;
      save();
      const counts = {};
      for (const c of d.controls) counts[c.verdict] = (counts[c.verdict] ?? 0) + 1;
      console.log(
        `[${n}/${names.length * backends.length}] ${d.demo}: ${d.status}${d.renderer ? ` (${d.renderer})` : ''} in ${d.seconds} s ${JSON.stringify(counts)}`,
      );
    }
  await browser.close().catch(() => {});
  try {
    killTree(browserServer.process());
  } catch {}
  server.close();
  const ranked = writeMarkdown();
  // Exit 1 when any page this run checked failed to start, logged an error or has a dead or broken control.
  process.exitCode = ranked.some(({ d }) => names.includes(d.slug ?? d.demo)) ? 1 : 0;
}
