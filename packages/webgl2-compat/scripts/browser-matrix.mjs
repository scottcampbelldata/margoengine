// The browser matrix (parity batch 273): a fixed set of existing browser checks, run in one browser natively on
// WebGPU and on the WebGL2 compatibility layer, each result recorded as pass, refusal (a coded engine error with its
// help link), difference (measured numbers apart from native or from the check's bar) or bug (a crash, an uncoded
// error, a wrong value or a time limit), or unmeasured (the browser itself cannot give the measure: no WebGPU adapter
// for a native row, or a screenshot that shows no WebGL2 canvas at all for a picture row; see canvasShotsWork). The
// matrix in docs/limits.md ("Browser matrix") is this script's output.
//
// From the repository root, after `npm run build:packages`:
//   node scripts/run-with-timeout.mjs -- node packages/webgl2-compat/scripts/browser-matrix.mjs --browser=safari
//   node scripts/run-with-timeout.mjs -- node packages/webgl2-compat/scripts/browser-matrix.mjs --browser=firefox
// `--browser=safari` (macOS) drives the installed Safari through Apple's safaridriver (scripts/webdriver.mjs), and
// `--browser=ios-simulator` drives Safari in an iOS Simulator through it (a simulator on the Mac's GPU),
// `--browser=android-chrome` drives Chrome on the device adb lists (an emulator or a phone) through Playwright; any
// other name (firefox, chromium, msedge, webkit) launches it through the Playwright harness (scripts/lib/browser.mjs).
// `--cases=basic-scene,materials` runs a subset. Results: test-results/browser-matrix/<browser>-<os>.json. Exit code 1
// when any row is a bug. No timings are recorded: the matrix holds results only.
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { arch, platform, release } from 'node:os';
import { fileURLToPath } from 'node:url';
import { freePort, startDevServer } from '../../../scripts/browser.js';
import { compatShim } from '../../../scripts/support/compat-shim.js';
import { decodePNG } from '../../../tests/support/png.js';
import { openSession, startSafariDriver } from './webdriver.mjs';

/** The query parameter that runs a page on the WebGL2 layer (the matrix server's prelude installs it first). */
export const LAYER_PARAM = 'margo-matrix-compat';

/**
 * The script the matrix server puts first in every page: page errors (with a coded error's `code`) go to
 * `window.__matrixErrors`, and with `?margo-matrix-compat=1` the layer is installed by the harness's own init script
 * (scripts/support/compat-shim.js), as Playwright's `--compat` runs do, so the page itself is unchanged.
 */
export function prelude(shim = compatShim) {
  return (
    '(() => {' +
    'const errors = (window.__matrixErrors = []);' +
    'const keep = (e) => errors.push({ name: String(e && e.name), code: e && e.code !== undefined ? String(e.code) : null, message: String(e && e.message !== undefined ? e.message : e) });' +
    "addEventListener('error', (e) => keep(e.error ?? { name: 'Error', message: e.message }));" +
    "addEventListener('unhandledrejection', (e) => keep(e.reason));" +
    `if (new URLSearchParams(location.search).get('${LAYER_PARAM}') === '1') (${shim.toString()})();` +
    '})();'
  );
}

/** Vite plugin of the matrix server: the prelude at the head of every HTML page. */
export const preludePlugin = () => ({
  name: 'margo-browser-matrix-prelude',
  transformIndexHtml: () => [{ tag: 'script', children: prelude(), injectTo: 'head-prepend' }],
});

/** A link to the engine's error help page, which every coded refusal carries. */
const HELP_LINK = /https:\/\/margoengine\.com\//;

/**
 * The status of one thrown or page error: `refusal` when it has a code and the help link, else `bug` (an uncoded
 * error or a crash is a bug, never a result).
 */
export function classifyError(error) {
  return error?.code && HELP_LINK.test(error.message ?? '')
    ? { status: 'refusal', code: error.code, message: error.message }
    : { status: 'bug', code: error?.code ?? null, message: `${error?.name ?? 'Error'}: ${error?.message ?? error}` };
}

/** Largest RGB channel difference per pixel of two same-size RGBA images: share over 2, mean and largest. */
export function compareImages(a, b) {
  if (a.width !== b.width || a.height !== b.height) return { size: `${a.width}x${a.height} vs ${b.width}x${b.height}` };
  let over = 0,
    sum = 0,
    max = 0;
  const n = a.width * a.height;
  for (let i = 0; i < n; i++) {
    const o = i * 4,
      d = Math.max(
        Math.abs(a.data[o] - b.data[o]),
        Math.abs(a.data[o + 1] - b.data[o + 1]),
        Math.abs(a.data[o + 2] - b.data[o + 2]),
      );
    if (d > 2) over++;
    sum += d;
    max = Math.max(max, d);
  }
  return { share: over / n, mean: sum / n, max };
}

/** Pixels with an RGB sum over 120 (the compatibility check's measure of a picture that is not empty). */
export function litPixels(image) {
  let lit = 0;
  for (let i = 0; i < image.data.length; i += 4) if (image.data[i] + image.data[i + 1] + image.data[i + 2] > 120) lit++;
  return lit;
}

/**
 * The part of a viewport `image` under a CSS-pixel `rect` ({x, y, width, height}) at `scale` device pixels per CSS
 * pixel, clamped to the image.
 */
export function crop(image, rect, scale) {
  const x0 = Math.max(0, Math.round(rect.x * scale)),
    y0 = Math.max(0, Math.round(rect.y * scale)),
    x1 = Math.min(image.width, Math.round((rect.x + rect.width) * scale)),
    y1 = Math.min(image.height, Math.round((rect.y + rect.height) * scale)),
    width = Math.max(0, x1 - x0),
    height = Math.max(0, y1 - y0),
    data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    data.set(image.data.subarray(((y0 + y) * image.width + x0) * 4, ((y0 + y) * image.width + x1) * 4), y * width * 4);
  return { width, height, data };
}

/** RGB of the image at fractions (x, y) of its size. */
export const pixelAt = (image, x = 0.5, y = 0.5) => {
  const o = (Math.floor(image.height * y) * image.width + Math.floor(image.width * x)) * 4;
  return [image.data[o], image.data[o + 1], image.data[o + 2]];
};

/** Paths where two results differ (integers exactly, other numbers within 1e-6), at most `limit`, and the count. */
export function differences(a, b, path = '', out = { count: 0, first: [] }, limit = 3) {
  const add = (text) => (out.count++, out.first.length < limit && out.first.push(text));
  if (typeof a === 'number' && typeof b === 'number') {
    const same = Number.isInteger(a) && Number.isInteger(b) ? a === b : Math.abs(a - b) <= 1e-6 || (a !== a && b !== b);
    if (!same) add(`${path}: native ${a}, layer ${b}`);
  } else if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) add(`${path}: length ${a.length} vs ${b.length}`);
    else a.forEach((x, i) => differences(x, b[i], `${path}[${i}]`, out, limit));
  } else if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)]))
      differences(a[k], b[k], `${path}.${k}`, out, limit);
  } else if (a !== b) add(`${path}: native ${JSON.stringify(a)}, layer ${JSON.stringify(b)}`);
  return out;
}

/**
 * A probe's thrown value as an error: the features page records `String(error)`, "MargoError: <message>", whose
 * help link names the entry; the code is read from the link's anchor when nothing else gives it.
 */
export function thrownOf(thrown) {
  if (thrown && typeof thrown === 'object') return thrown;
  const text = String(thrown),
    named = /^(\w*Error): ([\s\S]*)$/.exec(text),
    anchor = /margoengine\.com\/errors#([\w-]+)/.exec(text)?.[1];
  return {
    name: named?.[1] ?? 'Error',
    code: named?.[1] === 'MargoError' ? (anchor ?? null) : null,
    message: named?.[2] ?? text,
  };
}

/** Largest error of the inverseTrig probe's results against float64 (features-browser.mjs's measure) and where. */
export function trigError(r) {
  let max = 0,
    at = null;
  for (let p = 0; p < r.length; p += 4) {
    const row = Math.floor(p / 4 / 4096),
      errors =
        row < 3
          ? [r[p + 1] - Math.acos(r[p]), r[p + 2] - Math.asin(r[p])]
          : row === 3
            ? [r[p + 2] - Math.atan2(r[p], r[p + 1])]
            : [r[p + 1] - Math.atan(r[p])];
    for (const e of errors) {
      const size = Number.isNaN(e) ? Infinity : Math.abs(e);
      if (size > max) {
        max = size;
        at = { sweep: row, index: (p / 4) % 4096, pixel: r.slice(p, p + 4) };
      }
    }
  }
  return { max, at };
}

/** The two legs of every case: the browser's own WebGPU, and the WebGL2 layer forced over it. */
export const MODES = ['native', 'layer'];

// Same-picture bar of the forced-compatibility check (compat-browser-check.mjs, roadmap decision 4).
const MAX_SHARE = 0.001,
  MAX_MEAN = 0.25;

/** Expected centre colours of the materials check (packages/materials/test/browser-check.mjs) that need no lighting. */
const MATERIAL_CENTRES = {
  basic: [0, 0, 255],
  canvas: [0, 255, 0],
  normal: [128, 128, 255],
  matcap: [255, 128, 0],
  loaded: [255, 128, 0],
  transparent: [130, 3, 4],
  additive: [5, 194, 9],
  mask: [5, 6, 9],
};

/** In-page: a camera-facing PBR quad parsed by gltf/pbr, drawn once. */
const GLTF_PROBE = `async () => {
  const { Engine } = await import('/packages/core/dist/index.js'), { parseGLTF } = await import('/packages/gltf/dist/pbr.js');
  const canvas = document.body.appendChild(document.createElement('canvas'));
  canvas.style.cssText = 'display:block;width:256px;height:256px';
  const engine = await Engine.create(canvas, { backend: 'webgpu', camera: { position: [0, 0, 3], target: [0, 0, 0] } }), errors = [];
  engine.gpu.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  const floats = new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
  const doc = { asset: { version: '2.0' }, buffers: [{ byteLength: 96 }, { byteLength: 12 }],
    bufferViews: [{ buffer: 0, byteLength: 48 }, { buffer: 0, byteOffset: 48, byteLength: 48 }, { buffer: 1, byteLength: 12 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [-1, -1, 0], max: [1, 1, 0] }, { bufferView: 1, componentType: 5126, count: 4, type: 'VEC3' }, { bufferView: 2, componentType: 5123, count: 6, type: 'SCALAR' }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.8, 0.2, 0.1, 1], metallicFactor: 0, roughnessFactor: 0.5 } }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }], nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0 };
  parseGLTF(engine, doc, [floats.buffer, indices.buffer], []);
  engine.render();
  await engine.gpu.queue.onSubmittedWorkDone();
  return { errors };
}`;

/** In-page: the post check's crease scene through GTAO, read back as linear floats, summarised on a 16 x 16 grid. */
const POST_PROBE = `async () => {
  const info = await window.check.run({ scene: 'creases', stack: [['gtao', {}]], size: [256, 256] }), r = await window.check.read();
  const bytes = Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0)), floats = new Float32Array(bytes.buffer), stride = r.row / 4, grid = [];
  let finite = true, sum = 0;
  for (let y = 0; y < r.height; y++) for (let x = 0; x < r.width; x++) { const v = floats[y * stride + x * 4]; finite &&= Number.isFinite(v); sum += v; }
  for (let gy = 0; gy < 16; gy++) for (let gx = 0; gx < 16; gx++) grid.push(floats[Math.floor((gy + 0.5) * r.height / 16) * stride + Math.floor((gx + 0.5) * r.width / 16) * 4]);
  return { errors: [...info.errors, ...r.errors], finite, mean: sum / (r.width * r.height), grid };
}`;

/** In-page: what the browser offers, read before any engine starts. */
const ENVIRONMENT_PROBE = `async () => {
  const out = { userAgent: navigator.userAgent, webgpu: 'gpu' in navigator, adapter: null, webgl2: null };
  if (out.webgpu) { const a = await navigator.gpu.requestAdapter(); out.adapter = a ? { vendor: a.info?.vendor ?? '', architecture: a.info?.architecture ?? '', description: a.info?.description ?? '' } : 'none'; }
  const gl = document.createElement('canvas').getContext('webgl2');
  if (gl) { const ext = gl.getExtension('WEBGL_debug_renderer_info'); out.webgl2 = { renderer: gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER), version: gl.getParameter(gl.VERSION) }; gl.getExtension('WEBGL_lose_context')?.loseContext(); }
  return out;
}`;

/**
 * Whether a bitmapCopies result keeps the two copy rules features-browser.mjs holds the layer to: straight RGB survives
 * alpha 0 and premultiplied alpha 0 is black (texel 1, 2 of an 8-wide copy).
 */
export function copyRules(side) {
  const texel = (key) => side.result[key]?.slice((2 * 8 + 1) * 4, (2 * 8 + 1) * 4 + 4);
  return (
    differences(texel('none/1/whole/up/straight'), [11, 200, 7, 0]).count +
      differences(texel('none/1/whole/up/premultiplied'), [0, 0, 0, 0]).count ===
    0
  );
}

/** In-page: a plain WebGL2 canvas (no engine) cleared to red, for `canvasShotsWork`. */
export const SHOT_PROBE = `() => {
  const c = document.createElement('canvas');
  c.id = 'margo-matrix-shot'; c.width = 32; c.height = 32;
  c.style.cssText = 'position:fixed;left:0;top:0;width:32px;height:32px;z-index:2147483647';
  document.body.append(c);
  const gl = c.getContext('webgl2', { preserveDrawingBuffer: true });
  if (!gl) return false;
  gl.clearColor(1, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))));
}`;

/**
 * Whether the browser's screenshot shows a WebGL2 canvas at all: a plain canvas cleared to red, no engine involved.
 * Chrome 124 in the Android emulator (SwiftShader through the emulator's GLES translator) draws it (readPixels reads
 * red) but composites it empty, and drawImage and toDataURL read it transparent too; there no picture of any WebGL
 * canvas, the layer's included, can be judged, so those rows are `unmeasured` with this reason, never a pass.
 */
export async function canvasShotsWork(driver) {
  const made = await driver.run(SHOT_PROBE);
  if (made.ok !== true) return false;
  const [r, g, b] = pixelAt(await driver.shot('#margo-matrix-shot'));
  await driver.run("() => document.getElementById('margo-matrix-shot').remove()");
  return r > 200 && g < 50 && b < 50;
}

/** The row of a picture the browser cannot show (see `canvasShotsWork`). */
export const UNSHOT = Object.freeze({
  status: 'unmeasured',
  message:
    "the browser's screenshot shows no WebGL2 canvas (a plain one cleared to red comes back empty), so no picture can be judged",
});

/** The native row in a browser that offers no WebGPU adapter: nothing native to measure or compare. */
export const NO_ADAPTER = Object.freeze({
  status: 'unmeasured',
  message: 'the browser offers no WebGPU adapter (requestAdapter answers null)',
});

/**
 * The row of a probe that cannot run because the browser lacks an API the test builds its input with (a features probe's
 * `missing`, a materials scenario in `window.check.lacks`): unmeasured, naming the API, never a bug of the layer.
 */
export const lacking = (api) => ({ status: 'unmeasured', message: `the browser has no ${api}, which the test needs` });

/**
 * A page's recorded error strings as one row: `refusal` when every one is a coded refusal with its help link (the
 * engine refusing, as on a browser without a WebGPU adapter), else null.
 */
export function refusalOf(errors) {
  if (!errors?.length) return null;
  const all = errors.map((e) => classifyError(thrownOf(String(e).split('\n')[0])));
  return all.every((r) => r.status === 'refusal') ? all[0] : null;
}

/**
 * The cases, each `(t) => void` over the test context `t` (see `context`), adding rows with `t.row`. Each names the
 * existing check it runs.
 */
export const CASES = {
  // compat-browser-check.mjs: the same scenes natively and on the layer, compared with its bar.
  async 'basic-scene'(t) {
    for (const [scene, exact] of [
      ['basic', 0],
      ['basic', 1],
      ['views', 0],
    ]) {
      const item = `${scene}${exact ? ' exact-pixel' : ' 4x MSAA'}`,
        images = {};
      for (const mode of MODES) {
        const page = await t.load(
          '/packages/webgl2-compat/test/compat-check.html',
          { mode: mode === 'native' ? 'native' : 'compat', scene, exact },
          { layer: false },
        );
        if (page.failed) {
          t.row(item, mode, page.failed);
          continue;
        }
        const info = await t.call('() => window.check.info()'),
          gl = mode === 'layer' ? await t.call('() => window.check.glError()') : 0;
        if (info.thrown || gl.thrown) {
          t.row(item, mode, classifyError(info.thrown ?? gl.thrown));
          continue;
        }
        // The engine refused to start (coded, with its help link): a refusal, whatever the empty canvas shows.
        const refused = refusalOf(info.ok.errors);
        if (refused) {
          t.row(item, mode, refused);
          continue;
        }
        if (!t.shotsWork) {
          t.row(item, mode, UNSHOT);
          continue;
        }
        const image = await t.shot('canvas'),
          lit = litPixels(image),
          problems = [
            ...info.ok.errors,
            ...(gl.ok ? [`GL error ${gl.ok}`] : []),
            ...((info.ok.vendor === 'margo-webgl2') === (mode === 'layer') ? [] : [`adapter vendor ${info.ok.vendor}`]),
            ...(lit * 12 > image.width * image.height
              ? []
              : [`only ${lit} lit pixels of ${image.width * image.height}`]),
          ];
        if (problems.length) t.row(item, mode, { status: 'bug', message: problems.join('; ') });
        else {
          images[mode] = image;
          if (mode === 'native') t.row(item, mode, { status: 'pass', numbers: { lit } });
        }
      }
      if (!images.layer) continue;
      if (!images.native) t.row(item, 'layer', { status: 'pass', note: 'no native picture to compare' });
      else {
        const m = compareImages(images.native, images.layer),
          same = m.share <= MAX_SHARE && m.mean <= MAX_MEAN;
        t.row(item, 'layer', { status: same ? 'pass' : 'difference', numbers: m });
      }
    }
  },
  // adapter-browser.mjs: core at the compatibility feature level against the full level, natively (no layer leg).
  async 'feature-levels'(t) {
    const page = await t.load('/packages/webgl2-compat/test/adapter.html', {}, { layer: false });
    if (page.failed) return t.row('compatibility feature level', 'native', page.failed);
    const r = await t.call('() => window.check.run()');
    if (r.thrown) return t.row('compatibility feature level', 'native', classifyError(r.thrown));
    const v = r.ok,
      wrong = [
        v.fullLimits?.core !== true && 'plain device not at the full level',
        v.different !== 0 && `frames differ in ${v.different} pixels`,
        v.pick !== true && 'pick missed the mesh',
        v.miss !== true && 'pick hit off the mesh',
        v.afterLoss?.replaced !== true && 'device not replaced after loss',
        v.coreErrors?.length && `core errors: ${v.coreErrors.join('; ')}`,
      ].filter(Boolean);
    t.row(
      'compatibility feature level',
      'native',
      wrong.length
        ? { status: 'bug', message: wrong.join('; ') }
        : { status: 'pass', numbers: { levelGiven: v.limits?.core } },
    );
  },
  // features-browser.mjs: each feature probe of the layer, run natively and on the layer by the page itself.
  async features(t) {
    const page = await t.load('/packages/webgl2-compat/test/features.html', {}, { layer: false });
    if (page.failed) return t.row('all', 'layer', page.failed);
    const names = await t.call('() => window.check.names()');
    if (names.thrown) return t.row('all', 'layer', classifyError(names.thrown));
    for (const name of names.ok) {
      // Without a native adapter the page's `run` (native and layer) cannot start; the layer runs alone, judged by
      // its own bars where the probe has one (inverseTrig against float64, bitmapCopies' copy rules).
      const r = t.nativeAdapter
        ? await t.call(`() => window.check.run(${JSON.stringify(name)})`)
        : await t.call(`async () => ({ native: null, compat: await window.check.runCompat(${JSON.stringify(name)}) })`);
      if (r.thrown) {
        t.row(name, 'layer', classifyError(r.thrown));
        continue;
      }
      let failed = false;
      for (const mode of MODES) {
        if (mode === 'native' && !t.nativeAdapter) {
          t.row(name, mode, NO_ADAPTER);
          continue;
        }
        const side = r.ok[mode === 'native' ? 'native' : 'compat'],
          wrong = [
            side.thrown && `threw ${side.thrown}`,
            side.errors?.length && side.errors.join('; '),
            side.gl && `GL error ${side.gl}`,
          ].filter(Boolean);
        if (wrong.length) {
          failed = true;
          t.row(
            name,
            mode,
            side.missing && !side.errors?.length && !side.gl
              ? lacking(side.missing)
              : side.thrown && !side.errors?.length && !side.gl
                ? classifyError(thrownOf(side.thrown))
                : { status: 'bug', message: wrong.join('; ') },
          );
        } else if (mode === 'native') t.row(name, mode, { status: 'pass' });
      }
      if (failed) continue;
      if (name === 'inverseTrig') {
        // As features-browser.mjs judges it: the layer within 1e-5 of float64 over the whole domain; native is reported.
        const layer = trigError(r.ok.compat.result),
          native = r.ok.native && trigError(r.ok.native.result),
          within = layer.max <= 1e-5;
        t.row(name, 'layer', {
          status: within ? 'pass' : 'bug',
          numbers: { layerError: layer.max, nativeError: native ? native.max : null },
          ...(within ? {} : { message: `layer ${layer.max} off float64 at ${JSON.stringify(layer.at)}` }),
        });
        continue;
      }
      if (!r.ok.native) {
        // No native result to hold the layer to: bitmapCopies keeps its two copy rules; the rest ran without an error.
        if (name === 'bitmapCopies' && !copyRules(r.ok.compat))
          t.row(name, 'layer', {
            status: 'bug',
            message: 'the layer breaks a copy rule (no native result to compare)',
          });
        else t.row(name, 'layer', { status: 'pass', note: 'no native result to compare' });
        continue;
      }
      const d = differences(r.ok.native.result, r.ok.compat.result);
      if (name === 'bitmapCopies' && d.count) {
        // features-browser.mjs holds the layer to native here (KB0477) and to two values the copy rules fix: straight RGB
        // survives alpha 0 and premultiplied alpha 0 is black (texel 1, 2 of an 8-wide copy). The layer breaking either
        // is a bug; a browser whose own copy breaks the first only differs from the layer.
        const layerKeeps = copyRules(r.ok.compat),
          nativeKeeps = copyRules(r.ok.native);
        t.row(
          name,
          'layer',
          layerKeeps
            ? {
                status: 'difference',
                numbers: { values: d.count },
                note: `the layer keeps both copy rules, native ${nativeKeeps ? 'too' : 'breaks one'}; first: ${d.first.join('; ')}`,
              }
            : { status: 'bug', message: `the layer breaks a copy rule; first: ${d.first.join('; ')}` },
        );
        continue;
      }
      t.row(
        name,
        'layer',
        d.count ? { status: 'difference', numbers: { values: d.count }, note: d.first.join('; ') } : { status: 'pass' },
      );
    }
  },
  // materials/test/browser-check.mjs: the unlit scenarios whose centre colour needs no lighting model.
  async materials(t) {
    for (const mode of MODES) {
      const page = await t.load('/packages/materials/test/browser-check.html', {}, { layer: mode === 'layer' });
      if (page.failed) {
        t.row('unlit centres', mode, page.failed);
        continue;
      }
      const lacks = (await t.call('() => window.check.lacks ?? {}')).ok ?? {};
      for (const [name, expected] of Object.entries(MATERIAL_CENTRES)) {
        if (lacks[name]) {
          t.row(name, mode, lacking(lacks[name]));
          continue;
        }
        const r = await t.call(`() => window.check.run(${JSON.stringify(name)})`);
        if (r.thrown) {
          t.row(name, mode, classifyError(r.thrown));
          continue;
        }
        if (r.ok.error || r.ok.errors.length) {
          t.row(name, mode, { status: 'bug', message: [r.ok.error, ...r.ok.errors].filter(Boolean).join('; ') });
          continue;
        }
        if (!t.shotsWork) {
          t.row(name, mode, UNSHOT);
          await t.call('() => window.check.clear()');
          continue;
        }
        const centre = pixelAt(await t.shot('canvas')),
          off = Math.max(...centre.map((c, i) => Math.abs(c - expected[i])));
        t.row(
          name,
          mode,
          off <= 3
            ? { status: 'pass' }
            : { status: 'bug', message: `centre ${centre.join(',')}, expected ${expected.join(',')}` },
        );
        // As the materials check does after each scenario: its mesh goes, so the next one draws alone.
        await t.call('() => window.check.clear()');
      }
    }
  },
  // A gltf/pbr quad (parseGLTF, the README's entry): natively and on the layer, compared with the bar above.
  async 'gltf/pbr'(t) {
    const images = {};
    for (const mode of MODES) {
      const page = await t.load('/tests/modern-extension.html', {}, { layer: mode === 'layer', ready: null });
      if (page.failed) {
        t.row('PBR quad', mode, page.failed);
        continue;
      }
      const r = await t.call(GLTF_PROBE);
      if (r.thrown) t.row('PBR quad', mode, classifyError(r.thrown));
      else if (r.ok.errors.length) t.row('PBR quad', mode, { status: 'bug', message: r.ok.errors.join('; ') });
      else if (!t.shotsWork) t.row('PBR quad', mode, UNSHOT);
      else {
        const image = await t.shot('canvas'),
          [red, green] = pixelAt(image);
        if (red <= green + 40)
          t.row('PBR quad', mode, {
            status: 'bug',
            message: `centre ${pixelAt(image).join(',')} is not the red material`,
          });
        else {
          images[mode] = image;
          if (mode === 'native') t.row('PBR quad', mode, { status: 'pass', numbers: { centre: pixelAt(image) } });
        }
      }
    }
    if (images.layer) {
      if (!images.native) t.row('PBR quad', 'layer', { status: 'pass', note: 'no native picture to compare' });
      else {
        const m = compareImages(images.native, images.layer);
        t.row('PBR quad', 'layer', {
          status: m.share <= MAX_SHARE && m.mean <= MAX_MEAN ? 'pass' : 'difference',
          numbers: m,
        });
      }
    }
  },
  // post-effects-gpu.mjs's crease scene through GTAO, its linear output summarised, natively and on the layer.
  async post(t) {
    const grids = {};
    for (const mode of MODES) {
      const page = await t.load('/examples/package-benchmarks/post-effects.html', {}, { layer: mode === 'layer' });
      if (page.failed) {
        t.row('GTAO creases', mode, page.failed);
        continue;
      }
      const r = await t.call(POST_PROBE);
      if (r.thrown) t.row('GTAO creases', mode, classifyError(r.thrown));
      else if (r.ok.errors.length || !r.ok.finite || !(r.ok.mean > 0))
        t.row('GTAO creases', mode, {
          status: 'bug',
          message: [...r.ok.errors, !r.ok.finite && 'non-finite output', `mean ${r.ok.mean}`]
            .filter(Boolean)
            .join('; '),
        });
      else {
        grids[mode] = r.ok;
        if (mode === 'native') t.row('GTAO creases', mode, { status: 'pass', numbers: { mean: r.ok.mean } });
      }
    }
    if (grids.layer) {
      if (!grids.native) t.row('GTAO creases', 'layer', { status: 'pass', numbers: { mean: grids.layer.mean } });
      else {
        const gaps = grids.native.grid.map((v, i) => Math.abs(v - grids.layer.grid[i])),
          largest = Math.max(...gaps);
        t.row('GTAO creases', 'layer', {
          status: largest <= 1 / 255 ? 'pass' : 'difference',
          numbers: {
            mean: grids.layer.mean,
            largestGap: largest,
            meanGap: gaps.reduce((a, b) => a + b, 0) / gaps.length,
          },
        });
      }
    }
  },
  // voxel-pathtracer/tests/browser-check.mjs `traversal`: GPU first hits against the CPU raycast, with its bar.
  async 'voxel-pathtracer'(t) {
    for (const mode of MODES) {
      const page = await t.load('/packages/voxel-pathtracer/tests/browser-check.html', {}, { layer: mode === 'layer' });
      if (page.failed) {
        t.row('traversal', mode, page.failed);
        continue;
      }
      const r = await t.call('() => window.check.traversal()');
      if (r.thrown) {
        t.row('traversal', mode, classifyError(r.thrown));
        continue;
      }
      const wrong = [];
      for (const view of ['perspective', 'orthographic']) {
        const v = r.ok[view];
        if (!(v.hits > v.pixels / 4)) wrong.push(`${view}: ${v.hits} hits of ${v.pixels}`);
        if (v.same < v.pixels - Math.ceil(v.pixels * 0.002)) wrong.push(`${view}: ${v.same}/${v.pixels} agree`);
        if (!(v.maxRelativeDepth < 1e-4)) wrong.push(`${view}: depth ${v.maxRelativeDepth}`);
      }
      if (r.ok.errors?.length) wrong.push(...r.ok.errors);
      t.row(
        'traversal',
        mode,
        wrong.length
          ? { status: 'bug', message: wrong.join('; ') }
          : {
              status: 'pass',
              numbers: {
                perspective: `${r.ok.perspective.same}/${r.ok.perspective.pixels}`,
                orthographic: `${r.ok.orthographic.same}/${r.ok.orthographic.pixels}`,
              },
            },
      );
    }
  },
};

/** Polls `expression` in the page until it is truthy, a page error is recorded, or `limitMs` passes. */
async function settle(driver, limitMs) {
  // wall-clock: a bound on a page's start, far from normal.
  const end = Date.now() + limitMs;
  for (;;) {
    const r = await driver.run('() => ({ ready: !!window.ready, errors: window.__matrixErrors ?? [] })');
    if (r.thrown) return { error: r.thrown };
    if (r.ok.errors.length) return { error: r.ok.errors[0] };
    if (r.ok.ready) return {};
    if (Date.now() > end) return { timeout: true };
    // fixed-wait: WebDriver pages cannot signal the runner, so readiness is polled until the deadline
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * WebDriver capabilities of the Safari names: macOS Safari, or Safari in the iOS Simulator (safaridriver's
 * `safari:useSimulator`; the simulator draws with the Mac's GPU, so it is no real-device result).
 */
export const SAFARI_CAPABILITIES = {
  safari: { browserName: 'safari' },
  'ios-simulator': {
    browserName: 'safari',
    platformName: 'iOS',
    'safari:useSimulator': true,
    'safari:deviceType': 'iPhone',
  },
};

/** A Safari driver: safaridriver on a free port, one session with `capabilities`. */
async function safariDriver(name) {
  const driver = await startSafariDriver(await freePort());
  let session;
  try {
    // MARGO_IOS_UDID picks the simulator (one `xcrun simctl list devices` names); safaridriver chooses one otherwise.
    const udid = name === 'ios-simulator' && process.env.MARGO_IOS_UDID;
    session = await openSession(driver.base, {
      ...SAFARI_CAPABILITIES[name],
      ...(udid ? { 'safari:deviceUDID': udid } : {}),
    });
    await session.timeouts(15 * 60_000, 180_000);
  } catch (error) {
    await driver.stop();
    throw error;
  }
  return {
    name,
    version: session.capabilities.browserVersion,
    platform: [
      session.capabilities.platformName,
      session.capabilities['safari:platformVersion'],
      session.capabilities['safari:deviceName'],
    ]
      .filter(Boolean)
      .join(' '),
    goto: (url) => session.goto(url),
    run: (source, arg) => session.run(source, arg),
    // The page shot cropped to the element: Safari's element shot of a WebGPU canvas is black (webdriver.mjs).
    async shot(selector) {
      const r = await session.run(
        `() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, scale: devicePixelRatio }; }`,
      );
      if (r.thrown) throw new Error(`no ${selector} to capture: ${r.thrown.message}`);
      const page = await decodePNG(await session.pageScreenshot()),
        // The shot's own scale: device pixels of the viewport over its CSS width.
        view = await session.run('() => innerWidth');
      return crop(page, r.ok, view.ok ? page.width / view.ok : r.ok.scale);
    },
    async close() {
      try {
        await session.close();
      } finally {
        await driver.stop();
      }
    },
  };
}

/** The driver of a Playwright `page`: `run` returns `{ok}` or `{thrown}` as the WebDriver client does. */
function pageDriver(page, name, version, close) {
  const wrap = (source, arg) =>
    `(async () => { try { const v = await (${source})(${JSON.stringify(arg ?? null)}); return { ok: v === undefined ? null : v }; } catch (e) { return { thrown: { name: String(e && e.name), code: e && e.code !== undefined ? String(e.code) : null, message: String(e && e.message !== undefined ? e.message : e) } }; } })()`;
  return {
    name,
    version,
    goto: (url) => page.goto(url, { timeout: 180_000 }),
    run: async (source, arg) => {
      try {
        return await page.evaluate(wrap(source, arg));
      } catch (error) {
        return { thrown: { name: 'HarnessError', code: null, message: error.message } };
      }
    },
    shot: async (selector) => decodePNG(await page.locator(selector).first().screenshot({ timeout: 120_000 })),
    close,
  };
}

/** A Playwright driver through the harness's launcher (MARGO_BROWSER names), one page. */
async function playwrightDriver(name) {
  const { launchBrowser } = await import('../../../scripts/lib/browser.mjs');
  const browser = await launchBrowser({ name });
  return pageDriver(await browser.newPage(), name, browser.version(), () => browser.close());
}

/** `promise`, or a rejection with `error()` once `ms` pass first. */
export function within(promise, ms, error) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(error()), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Why Chrome on an Android device opened no DevTools socket, from the device's `ro.debuggable` and focused window, or
 * null when they do not explain it. Chrome reads Playwright's command line (which skips the first-run screen) only on
 * a debuggable image.
 */
export function androidLaunchHint(debuggable, focus) {
  if (!/FirstRunActivity/.test(focus) || String(debuggable).trim() === '1') return null;
  return "Chrome's first-run screen is open, and this image is not debuggable (ro.debuggable=0), so Chrome ignores the command line Playwright writes to skip it; finish Chrome's first run on the device once";
}

/** How long Chrome on Android may take to open its DevTools socket. */
const ANDROID_LAUNCH_MS = 180_000;

/** The DevTools socket stock Chrome on Android opens while USB debugging is on, whatever its command line says. */
export const CHROME_ANDROID_SOCKET = 'chrome_devtools_remote';

/**
 * Chrome on the first Android device adb lists (an emulator or a phone); the device reaches the matrix server on its
 * own 127.0.0.1 by `adb reverse`, removed again on close and on a failed start. On a debuggable image Playwright's
 * Android support launches Chrome with its own command line. A user build (`ro.debuggable=0`: phones and the Google
 * Play emulator images) ignores that command line, so the socket Playwright waits for never opens; there the matrix
 * starts Chrome itself, forwards a local port to Chrome's own DevTools socket by `adb forward` (removed on close and
 * on a failed start) and connects over CDP, as chrome://inspect does. `ADB` names adb when it is not on PATH;
 * `android`, `chromium`, `spawn`, `fetch` and `localPort` stand in for Playwright's and node's in tests.
 */
export async function androidDriver(
  port,
  { android, chromium, spawn = spawnSync, fetch: get = fetch, launchMs = ANDROID_LAUNCH_MS, localPort = freePort } = {},
) {
  const _android = android ?? (await import('playwright-core'))._android;
  const adb = process.env.ADB ?? 'adb',
    run = (args) => spawn(adb, args, { encoding: 'utf8', timeout: 30_000 }),
    undo = [async () => run(['reverse', '--remove', `tcp:${port}`])],
    cleanup = async () => {
      for (const step of undo.splice(0).reverse()) await step();
    },
    reverse = run(['reverse', `tcp:${port}`, `tcp:${port}`]);
  if (reverse.status !== 0) throw new Error(`adb reverse failed: ${reverse.error?.message ?? reverse.stderr}`);
  const [device] = await _android.devices();
  if (!device) {
    await cleanup();
    throw new Error('no Android device: adb devices lists none');
  }
  undo.push(() => device.close());
  const shell = (...args) => run(['-s', device.serial(), 'shell', ...args]).stdout ?? '',
    model = `${device.model()} (serial ${device.serial()})`;
  try {
    let context, version, closeBrowser;
    if (shell('getprop', 'ro.debuggable').trim() === '1') {
      context = await within(
        device.launchBrowser(),
        launchMs,
        () => new Error(`Chrome on ${device.model()} opened no DevTools socket in ${launchMs / 1000} s`),
      );
      closeBrowser = () => context.close();
    } else {
      shell('am', 'start', '-a', 'android.intent.action.VIEW', '-d', 'about:blank', 'com.android.chrome');
      const hint = androidLaunchHint('0', shell('dumpsys', 'window', 'windows'));
      if (hint) throw new Error(`Chrome on ${device.model()} cannot be driven: ${hint}`);
      const local = await localPort(),
        forward = run(['-s', device.serial(), 'forward', `tcp:${local}`, `localabstract:${CHROME_ANDROID_SOCKET}`]);
      if (forward.status !== 0) throw new Error(`adb forward failed: ${forward.error?.message ?? forward.stderr}`);
      undo.push(async () => run(['-s', device.serial(), 'forward', '--remove', `tcp:${local}`]));
      const endpoint = `http://127.0.0.1:${local}`,
        info = await devtoolsVersion(`${endpoint}/json/version`, get, launchMs, `Chrome on ${device.model()}`);
      const browser = await (chromium ?? (await import('playwright-core')).chromium).connectOverCDP(endpoint, {
        timeout: 60_000,
      });
      context = browser.contexts()[0] ?? (await browser.newContext());
      version = info.Browser?.match(/Chrome\/([\d.]+)/)?.[1];
      closeBrowser = () => browser.close();
    }
    const page = await context.newPage();
    // Chrome's reduced user agent says 124.0.0.0; the DevTools version names the full build where there is one.
    version ??= (await page.evaluate('navigator.userAgent')).match(/Chrome\/([\d.]+)/)?.[1] ?? 'unknown';
    const driver = pageDriver(page, 'android-chrome', version, async () => {
      try {
        await page.close();
        await closeBrowser();
      } finally {
        await cleanup();
      }
    });
    return { ...driver, platform: model };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/**
 * Chrome's `/json/version` answer through the forward, asked every 500 ms for up to `ms` (Chrome binds its socket a
 * moment after it starts, and until then the forward refuses); after `ms` it rejects with the last answer or error.
 */
export async function devtoolsVersion(url, get, ms, who) {
  const end = Date.now() + ms;
  let last = 'no answer';
  for (;;) {
    try {
      const response = await get(url);
      if (response.ok) return await response.json();
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error.message;
    }
    if (Date.now() >= end)
      throw new Error(
        `${who} opened no DevTools socket (${CHROME_ANDROID_SOCKET}) in ${ms / 1000} s (${last}): is USB debugging on?`,
      );
    await new Promise((resolve) => setTimeout(resolve, Math.min(500, ms)));
  }
}

/** A page script: whether the page gets an animation frame within 5 s. */
export const FRAME_PROBE =
  '() => new Promise((resolve) => { requestAnimationFrame(() => resolve(true)); setTimeout(() => resolve(false), 5000); })';

/**
 * Refuses to run in a browser that fires no animation frames: the cases wait for frames, and a script waiting for one
 * never returns (Safari 27.2 on a locked macOS screen stopped them and its WebDriver session then stopped answering).
 */
export async function requireFrames(driver) {
  const r = await driver.run(FRAME_PROBE);
  if (r.ok !== true)
    throw new Error(
      `${driver.name} fires no animation frames (${r.thrown ? r.thrown.message : 'none in 5 s'}); a locked or sleeping screen stops them on macOS: unlock it and rerun`,
    );
}

/** Runs `cases` in the browser `name` and returns the report; rows are `{case, item, mode, status, ...}`. */
export async function runMatrix(
  name,
  cases = Object.keys(CASES),
  { pageLimitMs = 120_000, caseLimitMs = 15 * 60_000 } = {},
) {
  const server = await startDevServer({
      startPath: '/packages/webgl2-compat/test/compat-check.html',
      port: 'free',
      plugins: [preludePlugin()],
    }),
    origin = `http://127.0.0.1:${server.server.config.server.port}`;
  let driver;
  const rows = [];
  try {
    const port = server.server.config.server.port;
    driver =
      name in SAFARI_CAPABILITIES
        ? await safariDriver(name)
        : name === 'android-chrome'
          ? await androidDriver(port)
          : await playwrightDriver(name);
    await driver.goto(`${origin}/tests/modern-extension.html`);
    const environment = await driver.run(ENVIRONMENT_PROBE);
    await requireFrames(driver);
    const shotsWork = await canvasShotsWork(driver),
      nativeAdapter = environment.ok?.webgpu === true && environment.ok.adapter !== 'none';
    for (const key of cases) {
      if (!CASES[key]) throw new TypeError(`unknown case "${key}"; cases: ${Object.keys(CASES).join(', ')}`);
      const t = {
        row: (item, mode, result) => rows.push({ case: key, item, mode, ...result }),
        /** Whether the browser's screenshot shows a WebGL2 canvas (canvasShotsWork); false makes picture rows unmeasured. */
        shotsWork,
        /** Whether the browser offers a native WebGPU adapter. */
        nativeAdapter,
        /** Opens `path` with `params` (on the layer when `layer`), and waits for `window.ready` unless `ready` is null. */
        async load(path, params, { layer, ready = true }) {
          const query = new URLSearchParams({ ...params, ...(layer ? { [LAYER_PARAM]: '1' } : {}) });
          await driver.goto(`${origin}${path}${query.size ? `?${query}` : ''}`);
          if (ready === null) return {};
          const s = await settle(driver, pageLimitMs);
          if (s.error) return { failed: classifyError(s.error) };
          if (s.timeout) return { failed: { status: 'bug', message: `page not ready in ${pageLimitMs / 1000} s` } };
          return {};
        },
        call: (source) => driver.run(source),
        /** The element as the browser shows it: {width, height, data} RGBA. */
        shot: (selector) => driver.shot(selector),
      };
      let timer;
      try {
        await Promise.race([
          CASES[key](t),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`case over its ${caseLimitMs / 60_000} min limit`)), caseLimitMs);
          }),
        ]);
      } catch (error) {
        rows.push({ case: key, item: 'run', mode: '-', status: 'bug', message: error.message });
        if (/limit/.test(error.message)) break;
      } finally {
        clearTimeout(timer);
      }
    }
    return {
      browser: driver.name,
      version: driver.version,
      os: `${platform()} ${release()} ${arch()}`,
      device: driver.platform ?? null,
      environment: environment.ok ?? environment.thrown,
      canvasShots: shotsWork,
      rows,
    };
  } finally {
    try {
      await driver?.close();
    } finally {
      await server.close();
    }
  }
}

/** Markdown table of a report's rows: case, item, native and layer cells. */
export function table(report) {
  const cell = (r) =>
    !r
      ? 'not run'
      : r.status === 'refusal'
        ? `refusal \`${r.code}\``
        : r.status === 'pass'
          ? 'pass'
          : `${r.status}: ${r.message ?? (r.numbers ? JSON.stringify(r.numbers) : '')}${r.note ? ` (${r.note})` : ''}`;
  const keys = [...new Set(report.rows.map((r) => `${r.case}\u0000${r.item}`))];
  return [
    '| Case | Item | Native WebGPU | WebGL2 layer |',
    '| --- | --- | --- | --- |',
    ...keys.map((k) => {
      const [c, item] = k.split('\u0000'),
        find = (mode) =>
          report.rows.find((r) => r.case === c && r.item === item && (r.mode === mode || r.mode === '-'));
      return `| ${c} | ${item} | ${cell(find('native'))} | ${cell(find('layer'))} |`;
    }),
  ].join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  // Safari on macOS, Firefox elsewhere: the browsers without WebGPU most often in the wild.
  const name = arg('browser') ?? process.env.MARGO_BROWSER ?? (platform() === 'darwin' ? 'safari' : 'firefox'),
    cases = arg('cases')?.split(',');
  const report = await runMatrix(name, cases);
  await mkdir('test-results/browser-matrix', { recursive: true });
  const file = `test-results/browser-matrix/${report.browser}-${platform()}.json`;
  await writeFile(file, JSON.stringify(report, null, 1));
  console.log(`${report.browser} ${report.version}, ${report.os}`);
  console.log(JSON.stringify(report.environment));
  console.log(table(report));
  const bugs = report.rows.filter((r) => r.status === 'bug');
  console.log(`${report.rows.length} rows, ${bugs.length} bugs; ${file}`);
  process.exitCode = bugs.length ? 1 : 0;
}
