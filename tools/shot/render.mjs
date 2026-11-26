// Renders a shot file offline, frame by frame: the page runs in a real browser on the shot's own clock (driver.js), the
// cutscene's tracks are evaluated here for each frame (@margoengine/cutscene/render's cutsceneFrames timing), and each
// kept frame is copied out of the canvas, hashed and written as a PNG. A shot renders twice; the frame hashes must
// match (the determinism check), or the tool fails naming the first frame that differs and writes both copies.
// The PNG frames and manifest.json are the hand-off to encoding (P2 accumulation and P3 masters, docs/shots.md).
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Cutscene } from '@margoengine/cutscene';
import { openBrowser } from '../../scripts/browser.js';
import { installShotDriver } from './driver.js';
import { blueNoise } from './pixels.js';
import { pixelScript } from './pixel-script.mjs';
import { checkShotFileSettings, shotKeyedValuesAt, shotValuesAt } from './scene-settings.mjs';
import { writeMoving } from './motion.mjs';
import {
  DERIVED_AOVS,
  compareRenders,
  frameName,
  probeFrames,
  renderSize,
  shotFrames,
  subframeOffsets,
  filmTime,
} from './shot-file.mjs';
import { shotBrowser } from './platform.mjs';

/** The clock's first reading, ms: a frame at 0 would read as "no frame before" to engines that keep the last time. */
export const CLOCK_START = 1000;
/** What Date.now() reads at the shot's start: 2026-01-01T00:00:00Z, the same on every render. */
export const CLOCK_EPOCH = Date.UTC(2026, 0, 1);
/** A frame's thumbnail on the contact sheet is the frame scaled by this. */
const SHEET_SCALE = 1 / 4;
/** Contact sheet thumbnails when the shot names no probes. */
const SHEET_FRAMES = 8;
/** Frames of each kind of mismatch written for diffing. */
const MISMATCH_FILES = 3;
/** Side of the blue-noise dither tile (pixels.js blueNoise), and the tile, made once per process. */
export const NOISE_SIZE = 64;
let noiseTile;
const blueNoiseTile = () => (noiseTile ??= Array.from(blueNoise(NOISE_SIZE)));

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** The frames that go on the contact sheet, kept frame index to thumbnail index. */
function sheetFrames(file) {
  const probes = Object.values(probeFrames(file));
  const count = Math.round(file.shot.seconds * file.shot.fps);
  const frames = probes.length
    ? [...new Set(probes)].sort((a, b) => a - b)
    : [
        ...new Set(
          Array.from({ length: Math.min(SHEET_FRAMES, count) }, (_, i) =>
            Math.floor((i * count) / Math.min(SHEET_FRAMES, count)),
          ),
        ),
      ];
  return new Map(frames.map((frame, i) => [frame, i]));
}

/**
 * Opens the shot's page in a browser with the shot driver installed. The caller closes it.
 */
export async function openShotPage(file) {
  const { size, seed, msaa, page: target } = file.shot,
    render = renderSize(file.shot),
    cells = sheetFrames(file).size,
    cell = [Math.max(1, Math.round(size[0] * SHEET_SCALE)), Math.max(1, Math.round(size[1] * SHEET_SCALE))];
  // The browser opens on a blank page: renderOnce loads the shot's page once, with its query (KB-SHOT-DOUBLELOAD1).
  const browser = await openBrowser({
    startPath: `/${target.path}`,
    openPath: '/tools/shot/blank.html',
    port: 'free',
    channel: shotBrowser(),
  });
  try {
    // Supersampling: the window, and so the canvas that fills it, is the shot's size times its supersampling, at a
    // pixel ratio of 1; the driver takes each frame down to the shot's size.
    await browser.page.setViewportSize({ width: render[0], height: render[1] });
    await browser.page.addInitScript({ content: pixelScript() });
    await browser.page.addInitScript(installShotDriver, {
      seed,
      start: CLOCK_START,
      epoch: CLOCK_EPOCH,
      cell,
      cells,
      out: [...size],
      msaa,
      noise: blueNoiseTile(),
      noiseSize: NOISE_SIZE,
    });
    if (target.css)
      await browser.page.addInitScript((css) => {
        const style = document.createElement('style');
        style.dataset.margoShot = '';
        style.textContent = css;
        // Init scripts run as a document is created, before it may have its root element.
        const add = () => document.documentElement.appendChild(style);
        if (document.documentElement) add();
        else
          new MutationObserver((_, observer) => {
            if (!document.documentElement) return;
            observer.disconnect();
            add();
          }).observe(document, { childList: true });
      }, target.css);
  } catch (error) {
    await browser.close();
    throw error;
  }
  return browser;
}

/** The URL of the shot's page: its query, and the tier as @margoengine/quality reads it. */
function pageUrl(origin, file) {
  const { page, tier } = file.shot,
    query = new URLSearchParams(Object.entries(page.query).map(([key, value]) => [key, String(value)]));
  query.set('quality', tier);
  return `${origin}/${page.path}?${query}`;
}

/**
 * One frame of a render, run in the shot page (page.evaluate serializes it, so it reads nothing from this module): each
 * of `subs` drawn on its own clock time and camera, the shot's settings written through `settingsHook` and the cutscene
 * state through `apply` first, the GPU settled between them, and a kept frame captured from all of them. Exported for
 * the tests, which run it against a stand-in `globalThis.__margoShot`.
 */
export const shotStep = async ({
  subs,
  kept,
  capture = true,
  engine,
  apply,
  settingsHook,
  filmHook,
  ground,
  canvas,
  png,
  expectHash,
  thumbnail,
  warmup,
  masks,
  viewProjection,
  recordSky,
  skyCoverage,
}) => {
  const shot = globalThis.__margoShot;
  let result = null,
    drawn = null;
  for (let sub = 0; sub < subs.length; sub++) {
    const { time, state, settings, film } = subs[sub];
    let { camera } = subs[sub];
    // Heights above the ground (shot.page.ground): the page's ground added under the camera and the target,
    // as onGround in shot-file.mjs does. The page may give its ground only once it has loaded it.
    if (camera && ground) {
      const at = shot.get(ground);
      if (typeof at !== 'function') {
        if (!warmup)
          throw new Error(`${ground} is not a function in the page; set shot.page.ground to the page's ground`);
        camera = null;
      } else {
        const a = at(camera.position[0], camera.position[2]),
          b = at(camera.target[0], camera.target[2]);
        if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error(`${ground} gave ${a} and ${b}, not metres`);
        camera = {
          ...camera,
          position: [camera.position[0], camera.position[1] + a, camera.position[2]],
          target: [camera.target[0], camera.target[1] + b, camera.target[2]],
        };
      }
    }
    if (camera) drawn = camera;
    if (camera) {
      const target = shot.get(engine)?.camera;
      // The engine may appear only after the page's first frames, while it still loads.
      if (!target && !warmup) throw new Error(`no engine at ${engine}; set shot.page.engine to the page's engine`);
      if (target) {
        target.position = camera.position;
        target.target = camera.target;
        target.fov = camera.fov;
        target.up = camera.up;
      }
    }
    // The shot's settings through each package's own apply function, before page.apply (docs/shots.md).
    if (settings && settingsHook) {
      const write = shot.get(settingsHook);
      if (typeof write !== 'function') throw new Error(`${settingsHook} is not a function in the page`);
      await write(settings, { time: time.seconds, kept });
    }
    if (state && apply) {
      const hook = shot.get(apply);
      if (typeof hook !== 'function') throw new Error(`${apply} is not a function in the page`);
      await hook(state, { time: time.seconds, kept });
    }
    // The page's film hook, after the cutscene state and before the frame's callbacks: the page sets its FilmClock to the
    // sub-frame's exact time, moves its animation there and then its physics, so the frame draws bodies where the
    // animation put them in this frame, not the last (KB-PHYS-FRAMEORDER1), whatever order the page added its plugins in.
    if (film && filmHook) {
      const hook = shot.get(filmHook);
      if (typeof hook !== 'function') throw new Error(`${filmHook} is not a function in the page`);
      await hook(film, { time: time.seconds, kept });
    }
    // The sky's own coverage record, for skyClip of a shot with no page sky mask: on before the frame is drawn.
    if (recordSky) shot.recordSky(engine);
    const ran = shot.frame(time.ms);
    if (!ran) {
      if (warmup) return { idle: true };
      throw new Error('the page stopped asking for frames (its loop ended; see the page errors)');
    }
    if (kept !== null && capture) {
      // capture() starts its copy before its first await, so the frame is read before the browser presents it.
      const { size, via, render, done } = await shot.capture(canvas, { sub, subs: subs.length });
      if (done) {
        result = { size, via, render, samples: shot.samples, sha256: await shot.hash() };
        if (thumbnail !== undefined) shot.thumbnail(thumbnail);
        if (png || (expectHash && result.sha256 !== expectHash)) result.png = await shot.png();
        if (masks) result.aovs = await shot.masks({ ...masks, engine, png });
        if (skyCoverage) {
          const covered = await shot.skyCoverage({ engine, png });
          if (covered) result.aovs = { ...result.aovs, ...covered };
        }
        // A probe's camera as core drew it, for the look checks' analytic horizon (P4): the column-major
        // view-projection core computed for this frame, at the canvas's aspect.
        if (viewProjection) {
          const matrix = shot.get(engine)?.camera?.matrix;
          if (matrix?.length !== 16) throw new Error(`no engine camera at ${engine} for the probe's view-projection`);
          result.viewProjection = Array.from(matrix);
        }
        // The camera as drawn (heights above sea level, the ground added), for the stills' record.
        if (drawn) result.camera = { position: [...drawn.position], target: [...drawn.target], fov: drawn.fov };
      }
    }
    await shot.settle();
  }
  return result;
};

/** How long the tool waits for the page to load or to ask for a frame, ms; an error on the page ends a wait at once. */
export const PAGE_TIMEOUT_MS = 180_000;

/**
 * Watches an open page: its errors as they come (uncaught exceptions and console errors), the files it loads from its
 * own origin (`loaded`, URL paths, for the stills' record of what a still depends on), and `failed`, a promise that
 * rejects at the first error, so a wait on the page ends at once instead of at its timeout (KB-SHOT-FAILFAST1: a page
 * whose module threw, for example on a model the loader refused, never asked for a frame, and the tool waited out its
 * 180 s timeout before saying why). `stop()` removes the listeners.
 * @param {import('@playwright/test').Page} page
 */
export function watchPage(page) {
  const errors = [],
    loaded = new Set();
  let reject;
  const failed = new Promise((_, fail) => (reject = fail));
  failed.catch(() => {});
  const add = (text) => {
    errors.push(text);
    reject(new Error(`the page reported an error: ${text}`));
  };
  const onError = (error) => add(error.message ?? String(error));
  const onConsole = (message) => message.type() === 'error' && add(message.text());
  const onLoaded = (request) => {
    const url = new URL(request.url()),
      origin = page.url().startsWith('http') ? new URL(page.url()).origin : null;
    if (url.origin === origin) loaded.add(decodeURIComponent(url.pathname));
  };
  page.on('pageerror', onError);
  page.on('console', onConsole);
  page.on('requestfinished', onLoaded);
  return {
    errors,
    loaded,
    failed,
    stop() {
      page.off('pageerror', onError);
      page.off('console', onConsole);
      page.off('requestfinished', onLoaded);
    },
  };
}

/** Waits for the page to ask for its next frame; rejects at the page's first error (watchPage) or at the timeout. */
export async function untilQueued(page, watch) {
  const asked = page.waitForFunction(() => globalThis.__margoShot.queued > 0, null, {
    timeout: PAGE_TIMEOUT_MS,
    polling: 250,
  });
  asked.catch(() => {});
  await Promise.race([asked, watch.failed]);
}

/** The page hooks every frame step passes on (shotStep). */
export const pageHooks = (shot, recordSky = false) => ({
  engine: shot.page.engine,
  apply: shot.page.apply,
  settingsHook: shot.page.settings,
  filmHook: shot.page.film,
  ground: shot.page.ground,
  canvas: shot.page.canvas,
  recordSky,
});

/**
 * Loads the shot's page in an open browser and draws its warm-up, as every render and measure does: the shot's first
 * instant drawn `warmup` times, so pipelines compile and the temporal passes (TAA, the cloud march) settle before
 * frame 0; the clock does not move, so the scene does not either. Resolves the shot's settings tables, checked
 * against the packages' own rows before anything draws (docs/shots.md). Rejects at the page's first error, when the
 * page is not ready after the warm-up, or when its canvas is not the render size.
 */
export async function loadShotPage(browser, file, watch, common) {
  const { page, server } = browser,
    { shot } = file,
    origin = `http://127.0.0.1:${server.config.server.port}`,
    loading = page.goto(pageUrl(origin, file), { waitUntil: 'load', timeout: PAGE_TIMEOUT_MS });
  loading.catch(() => {});
  await Promise.race([loading, watch.failed]);
  // The page asks for its first frame once it has loaded what it needs; nothing is drawn before that.
  await untilQueued(page, watch);
  const tables = await checkShotFileSettings(shot),
    first = new Cutscene(file).evaluate(0),
    args = {
      ...common,
      subs: [
        {
          time: { ms: CLOCK_START, seconds: 0 },
          camera: first.camera,
          state: shot.page.apply ? first : null,
          settings: shotValuesAt(shot, tables, shot.from),
        },
      ],
      kept: null,
      warmup: true,
    };
  for (let w = 0; w < shot.warmup; w++) {
    // A page still loading between its first frames asks for the next one when it is ready: wait for that.
    while ((await page.evaluate(shotStep, args))?.idle) await untilQueued(page, watch);
  }
  if (watch.errors.length)
    throw new Error(`the page reported errors while loading:\n  ${watch.errors.slice(0, 10).join('\n  ')}`);
  if (shot.page.ready && !(await page.$(shot.page.ready)))
    throw new Error(
      `the page is not ready after ${shot.warmup} warm-up frames (${shot.page.ready} matches nothing); raise shot.warmup`,
    );
  const size = await page.evaluate((selector) => {
      const canvas = document.querySelector(selector);
      return canvas ? [canvas.width, canvas.height] : null;
    }, shot.page.canvas),
    render = renderSize(shot);
  if (!size || size[0] !== render[0] || size[1] !== render[1])
    throw new Error(
      `the canvas is ${size ? size.join(' x ') : 'missing'}, not ${render.join(' x ')} (${shot.size.join(' x ')} at ${shot.supersample}x supersampling): make it fill the window with shot.page.css`,
    );
  return tables;
}

/**
 * One render of a shot in an open page: load, warm up, then every frame of shotFrames(). `write` keeps PNG files;
 * `expect` (another render's hashes) writes the frames that differ from it into `out/mismatch`. `only` (a set of
 * kept frame indices, the probes of a production render) captures and hashes just those: every frame up to the
 * last of them is still drawn, sub-frames and all, so the page reaches each one as the full render did, and the
 * render stops there. Resumes from `progress` (a file this writes after each captured frame) when a crashed or hung
 * render is run again; nothing else stops a render.
 * @returns {Promise<{ size: number[], warmup: number, frames: { index: number, time: number, file?: string, sha256: string }[], adapter: unknown }>}
 */
export async function renderOnce(browser, file, { out, label, write, expect, only = null, progress, log = () => {} }) {
  const { page, hardware } = browser,
    { shot } = file,
    cutscene = new Cutscene(file),
    last = only ? Math.max(...only) : Infinity,
    frames = shotFrames(file).filter((frame) => frame.kept === null || frame.kept <= last),
    wanted = only ? only.size : Math.round(shot.seconds * shot.fps),
    probes = new Set(Object.values(probeFrames(file))),
    // With `shot.moving` the frame after each probe also gets its view-projection, for the probe's motion.
    nextProbes = new Set(shot.moving ? [...probes].map((kept) => kept + 1) : []),
    sheet = write ? sheetFrames(file) : new Map(),
    shotHash = sha256(JSON.stringify(file));
  let done = [],
    capture;
  if (progress && existsSync(progress)) {
    const saved = JSON.parse(readFileSync(progress, 'utf8'));
    if (saved.shotHash === shotHash && saved.label === label) done = saved.frames;
  }
  if (done.length === wanted) {
    log(`${label}: already complete (${done.length} frames)`);
    return { size: [...shot.size], warmup: shot.warmup, frames: done, adapter: hardware.webgpu };
  }
  if (done.length) log(`${label}: resuming at kept frame ${done.length}`);
  const watch = watchPage(page),
    { errors } = watch;
  try {
    // One frame of the render: each of `subs` (one, or a kept frame's sub-frames over the shutter) drawn on its own
    // clock time and camera, the GPU settled between them, and a kept frame captured from all of them.
    const step = (args) => page.evaluate(shotStep, args);
    // A shot with no page sky mask asks the page's sky (if it has one) where it drew, for skyClip (KB-HEARTH-CLIP1).
    const recordSky = !shot.aovs.includes('sky') && probes.size > 0,
      common = pageHooks(shot, recordSky),
      tables = await loadShotPage(browser, file, watch, common),
      masks = shot.aovs.length
        ? {
            hook: shot.page.aovs,
            names: [...shot.aovs],
            derived: shot.aovs.filter((name) => DERIVED_AOVS.includes(name)),
            horizon: shot.horizon,
          }
        : null;
    if (write) mkdirSync(join(out, 'frames'), { recursive: true });
    // Frames up to the last one a resumed render had captured are drawn again, one sub-frame each, not captured.
    const passed = done.length ? done.at(-1).index : -1;
    for (const frame of frames) {
      const kept = frame.kept,
        skip = kept !== null && kept <= passed,
        // A kept frame of a production render's check that is not a probe: drawn in full, not captured.
        pass = !skip && kept !== null && only !== null && !only.has(kept),
        // A kept frame's sub-frames over the shutter (P2); pre-roll and skipped frames draw at the frame's own time.
        drawnOnce = kept === null || skip,
        offsets = drawnOnce ? [0] : subframeOffsets(shot),
        subs = offsets.map((offset, k) => {
          const seconds = frame.time + offset,
            state = cutscene.evaluate(seconds);
          return {
            time: { ms: CLOCK_START + (frame.render * 1000) / shot.fps + offset * 1000, seconds },
            camera: state.camera,
            state: shot.page.apply ? state : null,
            // The shot's keyed rows at this sub-frame's own time, written through the page's settings hook each
            // sub-frame, so they move (KB-SHOT-SETTINGS2: only the warm-up wrote them, so a keyed row held its first
            // value for the whole shot); a held row went in once, with the warm-up.
            settings: shotKeyedValuesAt(shot, tables, seconds),
            // The exact film time for the page's film hook (shot.page.film): its FilmClock, animation and physics.
            film: shot.page.film ? filmTime(shot, frame.render, k, drawnOnce) : null,
          };
        });
      const result = await step({
        ...common,
        subs,
        kept: skip ? null : kept,
        capture: !pass,
        png: write && !skip && !pass,
        expectHash: !skip && !pass && kept !== null ? expect?.[kept] : undefined,
        thumbnail: skip || pass ? undefined : sheet.get(kept),
        masks: skip || pass || kept === null ? null : masks,
        viewProjection: write && !skip && !pass && (probes.has(kept) || nextProbes.has(kept)),
        skyCoverage: recordSky && !skip && !pass && probes.has(kept),
      });
      if (!result) continue;
      if (result.size[0] !== shot.size[0] || result.size[1] !== shot.size[1])
        throw new Error(`frame ${kept} is ${result.size.join(' x ')}, not ${shot.size.join(' x ')}`);
      const record = { index: kept, time: frame.time - shot.from, sha256: result.sha256 };
      if (result.viewProjection) record.viewProjection = result.viewProjection;
      // The eye of the last sub-frame, the one the view-projection above is of.
      if (result.viewProjection && result.camera) record.eye = [...result.camera.position];
      if (result.camera) record.camera = result.camera;
      capture ??= { via: result.via, render: result.render, samples: result.samples };
      if (result.aovs) {
        record.aovs = {};
        for (const [name, mask] of Object.entries(result.aovs)) {
          record.aovs[name] = { sha256: mask.sha256, mean: mask.mean };
          if (!write) continue;
          mkdirSync(join(out, 'aovs', name), { recursive: true });
          record.aovs[name].file = `aovs/${name}/${frameName(kept)}`;
          writeFileSync(join(out, record.aovs[name].file), Buffer.from(mask.png, 'base64'));
        }
      }
      if (write) {
        record.file = `frames/${frameName(kept)}`;
        writeFileSync(join(out, record.file), Buffer.from(result.png, 'base64'));
      } else if (expect && result.sha256 !== expect[kept]) {
        const written = done.filter((d) => d.mismatch).length;
        if (written < MISMATCH_FILES && result.png) {
          mkdirSync(join(out, 'mismatch'), { recursive: true });
          record.mismatch = `mismatch/${frameName(kept).replace('.png', `.${label}.png`)}`;
          writeFileSync(join(out, record.mismatch), Buffer.from(result.png, 'base64'));
        }
      }
      done.push(record);
      if (progress) writeFileSync(progress, JSON.stringify({ shotHash, label, frames: done }));
      if (kept % shot.fps === 0 || only) log(`${label}: frame ${kept} of ${Math.round(shot.seconds * shot.fps)}`);
    }
    if (write) {
      const contact = await page.evaluate(() => globalThis.__margoShot.sheet());
      if (contact) writeFileSync(join(out, 'contact.png'), Buffer.from(contact, 'base64'));
    }
    if (errors.length) throw new Error(`the page reported errors:\n  ${errors.slice(0, 10).join('\n  ')}`);
    if (capture && shot.msaa && capture.samples !== shot.msaa)
      throw new Error(`the page draws with ${capture.samples} MSAA samples, not the shot's ${shot.msaa}`);
    return {
      size: [...shot.size],
      warmup: shot.warmup,
      frames: done,
      adapter: hardware.webgpu,
      capture,
      loaded: [...watch.loaded].sort(),
    };
  } finally {
    watch.stop();
  }
}

/**
 * Renders a shot twice and checks the two renders match frame for frame. Writes `out/frames`,
 * `out/probes`, `out/contact.png` and `out/manifest.json`. Resolves the manifest; rejects naming the first differing
 * frame.
 * `check: 'probes'` is the production render: the second render captures and compares the probe frames only, and
 * stops after the last of them (docs/shots.md, Production renders). The default, `'every'`, compares every frame.
 * @param {object} file A parsed shot file (parseShot).
 * `output` (platform.mjs shotOutput) names the day and the master and caption files the manifest hands on.
 * @param {{ out: string, output?: { day: string, master: string, caption: string }, source?: string, runs?: 1 | 2, check?: 'every' | 'probes', log?: (line: string) => void, env?: NodeJS.ProcessEnv }} options
 */
export async function shoot(file, { out, output, source, runs = 2, check = 'every', log = console.error, env } = {}) {
  if (check !== 'every' && check !== 'probes') throw new TypeError(`check is 'every' or 'probes', not ${check}`);
  const probeSet = new Set(Object.values(probeFrames(file)));
  if (runs === 2 && check === 'probes' && !probeSet.size)
    throw new TypeError(
      `shot ${file.shot.id} names no probes: a production render checks its probe frames, so name some in shot.probes`,
    );
  mkdirSync(out, { recursive: true });
  let browser;
  try {
    browser = await openShotPage(file);
    log(
      `shot ${file.shot.id}: ${file.shot.size.join(' x ')} at ${file.shot.fps} fps, ${file.shot.seconds} s, on ${describeAdapter(browser.hardware)}`,
    );
    const a = await renderOnce(browser, file, {
      out,
      label: 'a',
      write: true,
      progress: join(out, 'progress-a.json'),
      log,
    });
    let verdict = { runs: 1, identical: null };
    if (runs === 2) {
      const only = check === 'probes' ? probeSet : null,
        expect = a.frames.map((frame) => frame.sha256),
        b = await renderOnce(browser, file, {
          out,
          label: 'b',
          write: false,
          expect,
          only,
          progress: join(out, 'progress-b.json'),
          log,
        });
      // A production render compares the probe frames of render a with render b's copies of them.
      const difference = compareRenders(
        only ? { ...a, frames: a.frames.filter((frame) => only.has(frame.index)) } : a,
        b,
      );
      verdict = {
        runs: 2,
        check,
        ...(only ? { checked: [...only].sort((x, y) => x - y) } : {}),
        identical: !difference,
        ...(difference ? { difference } : {}),
      };
      if (difference) {
        // The first differing frame of render a beside render b's copy, for a look by eye.
        for (const frame of b.frames.filter((f) => f.mismatch))
          log(`differs: ${frame.mismatch} against frames/${frameName(frame.index)}`);
      }
    }
    const probes = Object.fromEntries(
      Object.entries(probeFrames(file)).map(([name, index]) => {
        mkdirSync(join(out, 'probes'), { recursive: true });
        writeFileSync(join(out, 'probes', `${name}.png`), readFileSync(join(out, 'frames', frameName(index))));
        // The shot's masks and, on a page whose sky records its coverage, `sky-coverage`.
        const record = a.frames.find((frame) => frame.index === index),
          names = Object.keys(record?.aovs ?? {}),
          aovs = Object.fromEntries(
            names.map((aov) => {
              const copy = `probes/${name}.${aov}.png`;
              writeFileSync(join(out, copy), readFileSync(join(out, 'aovs', aov, frameName(index))));
              return [aov, copy];
            }),
          ),
          viewProjection = record?.viewProjection,
          // The probe's own look bounds (shot.probeLookBounds), which replace the shot's for the checks they name.
          lookBounds = file.shot.probeLookBounds?.[name];
        return [
          name,
          {
            frame: index,
            file: `probes/${name}.png`,
            ...(names.length ? { aovs } : {}),
            ...(viewProjection ? { viewProjection } : {}),
            ...(lookBounds ? { lookBounds } : {}),
          },
        ];
      }),
    );
    // The frame after each probe and its camera motion, for the moving look checks (shot.moving, motion.mjs).
    if (file.shot.moving)
      for (const [name, entry] of Object.entries(probes)) {
        const record = a.frames.find((frame) => frame.index === entry.frame),
          next = a.frames.find((frame) => frame.index === entry.frame + 1);
        if (!next?.viewProjection || !record?.viewProjection || !record.eye)
          throw new Error(
            `probe ${name} has no frame after it or no camera: shot.moving needs a camera track and a probe before the last frame`,
          );
        entry.moving = await writeMoving({
          out,
          name,
          nextFile: next.file,
          eye: record.eye,
          viewProjection: record.viewProjection,
          nextViewProjection: next.viewProjection,
          shot: file.shot,
        });
      }
    const manifest = {
      format: 'margo-shot-frames',
      version: 1,
      id: file.shot.id,
      ...(source ? { source } : {}),
      shotSha256: sha256(JSON.stringify(file)),
      size: [...file.shot.size],
      fps: file.shot.fps,
      seconds: file.shot.seconds,
      frames: a.frames.length,
      header: file.shot,
      adapter: a.adapter,
      // How the frames were read: 'gpu' from the WebGPU canvas texture, '2d' by a copy of the composited canvas.
      capture: a.capture?.via ?? null,
      // How each frame was made (P2): the canvas size (the shot's size times its supersampling), the scene's MSAA
      // samples as core read them, the sub-frames over the shutter, the filter down to the shot's size and the dither.
      render: {
        size: a.capture?.render ?? renderSize(file.shot),
        supersample: file.shot.supersample,
        samples: a.capture?.samples ?? null,
        subframes: file.shot.subframes,
        shutter: file.shot.shutter,
        filter: 'area, linear light',
        dither: `blue noise ${NOISE_SIZE} x ${NOISE_SIZE}, void and cluster`,
      },
      browser: {
        name: browser.hardware.browserName,
        version: browser.hardware.browserVersion,
        channel: browser.hardware.requestedChannel,
        platform: browser.hardware.hostPlatform,
      },
      // The encoder's targets (P3), beside this folder in the day's folder: a vertical MP4 with no audio track and the
      // same-name caption file the variation system writes.
      output: { ...(output ?? {}), audio: false },
      determinism: verdict,
      contact: existsSync(join(out, 'contact.png')) ? 'contact.png' : null,
      // Masks (AOVs) beside each frame, 8-bit grey PNGs in aovs/<name>/, for the look checks (P4).
      aovs: [...file.shot.aovs],
      // The probes' `sky-coverage` mask, the pixels the page's sky drew, when the shot has no sky mask and its page's
      // sky records its coverage (@margoengine/sky `coverage`); skyClip measures inside it.
      skyCoverage: Object.values(probes).some((probe) => probe.aovs?.['sky-coverage']),
      probes,
      files: a.frames,
      next: 'Encode the files in order at fps (P2 accumulation and P3 masters); docs/shots.md says what each field means.',
    };
    writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    if (verdict.identical === false)
      throw Object.assign(new Error(`determinism check failed: ${verdict.difference.message}`), { manifest });
    for (const name of ['progress-a.json', 'progress-b.json']) rmSync(join(out, name), { force: true });
    return manifest;
  } finally {
    await browser?.close();
  }
}

const describeAdapter = (hardware) =>
  hardware?.webgpu
    ? [hardware.webgpu.vendor, hardware.webgpu.architecture, hardware.webgpu.description].filter(Boolean).join(' ')
    : 'no WebGPU adapter';
