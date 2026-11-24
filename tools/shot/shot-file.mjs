// The shot file: one JSON file per short. It is a cutscene document (@margoengine/cutscene: format, version, duration,
// tracks) with a `shot` header beside them, so any cutscene tool opens it and the tracks drive the camera and the
// scene. This module checks a shot file without rendering it and lists the frames a render makes. Plain data, no
// browser and no GPU, so the unit test runs it anywhere (tests/shot-file.test.js).
import { Cutscene, validateCutscene, EASING_NAMES } from '@margoengine/cutscene';
import { LOOK_CHECKS, LOOK_FAMILY_NAMES } from '@margoengine/headless/look';
import { scenes } from '@margoengine/scenes';

/** The format name of a shot header. */
export const SHOT_FORMAT = 'margo-shot';

/**
 * What a shot is for, and the size, rate and length limit that come with it: `short`, a vertical 1080 x 1920 short at
 * 60 fps under a minute, or `long`, footage for a long video, 1920 x 1080 at 30 fps (half the frames of 60 fps to
 * render), each shot under 20 minutes. A header's own `size` and `fps` win over its kind's.
 */
export const SHOT_KINDS = Object.freeze({
  short: Object.freeze({ size: Object.freeze([1080, 1920]), fps: 60, maxSeconds: 60 }),
  long: Object.freeze({ size: Object.freeze([1920, 1080]), fps: 30, maxSeconds: 1200 }),
});

/** What a header left out gets: a vertical 1080 x 1920 short at 60 frames per second (a `long` shot: SHOT_KINDS). */
export const SHOT_DEFAULTS = Object.freeze({
  kind: 'short',
  seed: 1,
  size: Object.freeze([1080, 1920]),
  fps: 60,
  from: 0,
  tier: 'high',
  kit: null,
  msaa: null,
  supersample: 1.5,
  subframes: 1,
  shutter: 0,
  grade: null,
  endCard: null,
  probes: Object.freeze({}),
  lookBounds: Object.freeze({}),
  lookFamily: null,
  warmup: 60,
  aovs: Object.freeze([]),
  horizon: null,
  moving: null,
  subject: null,
});

/**
 * Masks the tool works out itself from the page's `geometry` mask and the camera, given `shot.horizon`: `water` where
 * the view ray meets the horizon plane before any geometry, `sky` where it meets neither.
 */
export const DERIVED_AOVS = Object.freeze(['sky', 'water']);

/** Tiers a shot may force on the page, through `?quality=` of @margoengine/quality. */
export const SHOT_TIERS = Object.freeze(['high', 'low']);

/** MSAA sample counts a shot may force on the page's scene passes; null keeps the tier's own (4 on high, 1 on low). */
export const SHOT_MSAA = Object.freeze([1, 4]);

/** The largest canvas side a shot renders, supersampling included. */
export const MAX_RENDER_SIDE = 8192;

/** The canvas a shot renders at: its size times its supersampling, each side rounded. */
export const renderSize = (shot) =>
  shot.size.map((side) => Math.round(side * (shot.supersample ?? SHOT_DEFAULTS.supersample)));

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const whole = (value, least) => Number.isInteger(value) && value >= least;
// A dotted path from globalThis to a value in the page, for example `stormLight.engine`: names only, never code.
const DOTTED = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;

/**
 * Checks a shot file without rendering it. Returns every problem, each with its path and fix; an empty array means it
 * renders. Never throws.
 * @param {unknown} input The parsed JSON of a shot file.
 * @returns {{ path: string, message: string }[]}
 */
export function validateShot(input) {
  const issues = [];
  const add = (path, message) => issues.push({ path, message });
  if (!isRecord(input)) {
    add('', 'must be a cutscene document with a shot header: {format, version, duration, tracks, shot}');
    return issues;
  }
  for (const issue of validateCutscene(input, EASING_NAMES)) add(issue.path, issue.message);
  const shot = input.shot;
  if (!isRecord(shot)) {
    add('shot', `must be the shot header {format: '${SHOT_FORMAT}', version: 1, id, seconds, page}`);
    return issues;
  }
  const at = (key) => `shot.${key}`;
  if (shot.format !== SHOT_FORMAT) add(at('format'), `must be '${SHOT_FORMAT}'`);
  if (shot.version !== 1) add(at('version'), 'must be 1; this file is from a newer shot tool');
  if (typeof shot.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(shot.id))
    add(at('id'), 'must be a name of lower-case letters, digits and dashes (it names the output folder)');
  if ('seed' in shot && !(Number.isInteger(shot.seed) && shot.seed >= 0 && shot.seed < 2 ** 32))
    add(at('seed'), 'must be a whole number from 0 to 2^32 - 1');
  if (
    'size' in shot &&
    !(Array.isArray(shot.size) && shot.size.length === 2 && shot.size.every((n) => whole(n, 16) && n <= 8192))
  )
    add(
      at('size'),
      'must be [width, height] in pixels, whole numbers from 16 to 8192 (a vertical short is [1080, 1920])',
    );
  if ('fps' in shot && !(whole(shot.fps, 1) && shot.fps <= 240)) add(at('fps'), 'must be a whole number from 1 to 240');
  if ('kind' in shot && !Object.hasOwn(SHOT_KINDS, shot.kind))
    add(
      at('kind'),
      `must be one of ${Object.keys(SHOT_KINDS).join(', ')} (a vertical short, or footage for a long video)`,
    );
  const kind = Object.hasOwn(SHOT_KINDS, shot.kind) ? shot.kind : SHOT_DEFAULTS.kind,
    { maxSeconds } = SHOT_KINDS[kind];
  const fps = whole(shot.fps, 1) ? shot.fps : SHOT_KINDS[kind].fps;
  const duration = finite(input.duration) && input.duration > 0 ? input.duration : Infinity;
  const from = 'from' in shot ? shot.from : 0;
  if (!(finite(from) && from >= 0)) add(at('from'), 'must be a time in seconds from 0');
  if (!(finite(shot.seconds) && shot.seconds > 0 && shot.seconds < maxSeconds))
    add(at('seconds'), `must be the length of the shot in seconds, above 0 and under ${maxSeconds} (a ${kind} shot)`);
  else if (finite(from) && from + shot.seconds > duration + 1e-9)
    add(at('seconds'), `from + seconds (${from + shot.seconds}) runs past the cutscene's duration (${duration})`);
  else if (Math.abs(shot.seconds * fps - Math.round(shot.seconds * fps)) > 1e-6)
    add(at('seconds'), `must be a whole number of frames at ${fps} fps`);
  if ('tier' in shot && !SHOT_TIERS.includes(shot.tier)) add(at('tier'), `must be one of ${SHOT_TIERS.join(', ')}`);
  if ('kit' in shot && shot.kit !== null && typeof shot.kit !== 'string')
    add(at('kit'), 'must be the name of a scene kit, or null');
  if ('msaa' in shot && shot.msaa !== null && !SHOT_MSAA.includes(shot.msaa))
    add(at('msaa'), "must be 1 or 4 MSAA samples for the page's scene passes, or null for the tier's own");
  if ('supersample' in shot && !(finite(shot.supersample) && shot.supersample >= 1 && shot.supersample <= 2))
    add(at('supersample'), 'must be the render scale from 1 to 2 (1.5 renders 1620 x 2880 for a 1080 x 1920 frame)');
  else if (
    Array.isArray(shot.size) &&
    shot.size.length === 2 &&
    shot.size.every((n) => whole(n, 16)) &&
    renderSize({ size: shot.size, supersample: shot.supersample }).some((side) => side > MAX_RENDER_SIDE)
  )
    add(at('supersample'), `renders a side over ${MAX_RENDER_SIDE} pixels at this size; lower it`);
  if ('subframes' in shot && !(whole(shot.subframes, 1) && shot.subframes <= 256))
    add(at('subframes'), 'must be a whole number from 1 to 256');
  if ('shutter' in shot && !(finite(shot.shutter) && shot.shutter >= 0 && shot.shutter <= 360))
    add(at('shutter'), 'must be the shutter angle in degrees, from 0 to 360');
  if ('grade' in shot && shot.grade !== null && typeof shot.grade !== 'string' && !isRecord(shot.grade))
    add(at('grade'), 'must be a grade name, a grade object, or null');
  if ('endCard' in shot && shot.endCard !== null && !isRecord(shot.endCard))
    add(at('endCard'), 'must be an end card object, or null');
  if ('warmup' in shot && !(whole(shot.warmup, 0) && shot.warmup <= 10_000))
    add(at('warmup'), 'must be a whole number of frames from 0 to 10000');
  // A shot cut by --seconds keeps its authored length here, so its settings keys are checked against the whole shot.
  if ('fullSeconds' in shot && !(finite(shot.fullSeconds) && finite(shot.seconds) && shot.fullSeconds >= shot.seconds))
    add(at('fullSeconds'), 'must be the authored length of a shot cut short, in seconds, at least seconds');
  if ('probes' in shot) {
    if (!isRecord(shot.probes)) add(at('probes'), 'must be an object of name: time in seconds');
    else
      for (const [name, time] of Object.entries(shot.probes)) {
        if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name))
          add(`${at('probes')}.${name}`, 'probe names are lower-case letters, digits and dashes (they name files)');
        if (!(finite(time) && time >= 0 && finite(shot.seconds) && time < shot.seconds))
          add(`${at('probes')}.${name}`, 'must be a time in seconds inside the shot, from 0 to before seconds');
      }
  }
  const bounds = (path, value) => {
    if (!isRecord(value)) add(path, 'must be an object of check name: bound');
    else
      for (const [name, bound] of Object.entries(value)) {
        if (!finite(bound) && !(Array.isArray(bound) && bound.length === 2 && bound.every(finite)))
          add(`${path}.${name}`, 'must be a number or [low, high]');
        // A bound for a check the tool cannot run fails every render: an unknown name, or nan, which needs the float
        // frame before tone mapping that the shot tool does not write (the Cabin Hearth shots asked for it).
        else if (!Object.hasOwn(LOOK_CHECKS, name))
          add(`${path}.${name}`, `is not a look check; use one of ${Object.keys(LOOK_CHECKS).join(', ')}`);
        else if (name === 'nan')
          add(`${path}.${name}`, 'needs the float frame, which the shot tool does not write; remove it');
      }
  };
  if ('lookBounds' in shot) bounds(at('lookBounds'), shot.lookBounds);
  if ('lookFamily' in shot && shot.lookFamily !== null && !LOOK_FAMILY_NAMES.includes(shot.lookFamily))
    add(
      at('lookFamily'),
      `must be a look family (${LOOK_FAMILY_NAMES.join(', ')}) or null: its bounds apply to every check the probes can run`,
    );
  // A probe's own bounds replace the shot's for the checks they name, on that probe only.
  if ('probeLookBounds' in shot) {
    if (!isRecord(shot.probeLookBounds))
      add(at('probeLookBounds'), 'must be an object of probe name: {check name: bound}');
    else
      for (const [name, value] of Object.entries(shot.probeLookBounds)) {
        if (!(isRecord(shot.probes) && Object.hasOwn(shot.probes, name)))
          add(`${at('probeLookBounds')}.${name}`, 'names no probe; name one of shot.probes');
        else bounds(`${at('probeLookBounds')}.${name}`, value);
      }
  }
  const aovs = Array.isArray(shot.aovs) ? shot.aovs : [];
  if ('aovs' in shot) {
    if (!Array.isArray(shot.aovs) || shot.aovs.length > 16)
      add(at('aovs'), "must be a list of up to 16 mask names, for example ['sky', 'water', 'foam', 'depth']");
    else
      shot.aovs.forEach((name, i) => {
        if (typeof name !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(name))
          add(`${at('aovs')}[${i}]`, 'mask names are lower-case letters, digits and dashes (they name folders)');
        else if (shot.aovs.indexOf(name) !== i) add(`${at('aovs')}[${i}]`, `names ${name} twice`);
        else if (name === 'sky-coverage')
          add(
            `${at('aovs')}[${i}]`,
            "sky-coverage is the tool's own mask (the pixels the page's sky drew); leave it out",
          );
      });
  }
  if ('horizon' in shot && shot.horizon !== null && !(isRecord(shot.horizon) && finite(shot.horizon.y)))
    add(at('horizon'), 'must be {y}, the world height of the water plane the sky and water masks split at, or null');
  // The shot's subject, for the film pipeline's camera checks (framing, depth of field, subject exposure at a cut).
  if ('subject' in shot && shot.subject !== null) {
    const subject = shot.subject;
    if (!isRecord(subject)) add(at('subject'), 'must be {target: [x, y, z] in metres, size: metres across}, or null');
    else {
      if (!(Array.isArray(subject.target) && subject.target.length === 3 && subject.target.every(finite)))
        add(`${at('subject')}.target`, 'must be the point the shot is about, [x, y, z] in world metres');
      if (!(finite(subject.size) && subject.size > 0))
        add(`${at('subject')}.size`, 'must be the subject size across, metres above 0');
    }
  }
  // The moving look checks (T4 shimmerMoving, T8 motionBlur): each probe also writes the frame after it and its camera motion.
  if ('moving' in shot && shot.moving !== null) {
    if (!(isRecord(shot.moving) && finite(shot.moving.depthScale) && shot.moving.depthScale > 0))
      add(
        at('moving'),
        'must be {depthScale}, the metres in the page depth mask nearness exp(-distance / depthScale), or null',
      );
    else if (!aovs.includes('depth'))
      add(at('aovs'), 'must list depth for shot.moving: the camera motion of each pixel is made from its distance');
    if (!(isRecord(shot.probes) && Object.keys(shot.probes).length))
      add(at('moving'), 'needs probes: the frame after each one is written');
    else if (finite(shot.seconds) && finite(shot.fps))
      for (const [name, time] of Object.entries(shot.probes))
        if (finite(time) && Math.ceil(time * shot.fps - 1e-9) >= Math.round(shot.seconds * shot.fps) - 1)
          add(
            `${at('probes')}.${name}`,
            'is on the last frame, which has no frame after it for shot.moving; move it earlier',
          );
  }
  const derived = aovs.filter((name) => DERIVED_AOVS.includes(name));
  if (derived.length && !(isRecord(shot.horizon) && finite(shot.horizon.y)))
    add(at('horizon'), `must be {y} for the ${derived.join(' and ')} mask: the plane that splits water from sky`);
  if (derived.length && !aovs.includes('geometry'))
    add(at('aovs'), `must list geometry for the ${derived.join(' and ')} mask: they are where no geometry is drawn`);
  if (aovs.length && !(isRecord(shot.page) && typeof shot.page.aovs === 'string'))
    add('shot.page.aovs', 'must name the page function that gives the mask textures, for example stormLight.aovs');
  if ('scene' in shot && !scenes.some((scene) => scene.name === shot.scene))
    add(at('scene'), `must be a scene of the catalogue (${scenes.map((scene) => scene.name).join(', ')})`);
  if ('settings' in shot) {
    const known = scenes.find((scene) => scene.name === shot.scene);
    if (typeof shot.scene !== 'string')
      add(at('settings'), 'needs shot.scene: the scene whose targets name the packages');
    else if (!isRecord(shot.settings) || !Object.values(shot.settings).every(isRecord))
      add(at('settings'), 'must be {target: {row: value or {keys: [{time, value, ease}]}}}');
    else if (known)
      for (const target of Object.keys(shot.settings))
        if (!Object.hasOwn(known.targets ?? {}, target))
          add(
            `shot.settings.${target}`,
            `is not a target of scene ${known.name}; use one of ${Object.keys(known.targets ?? {}).join(', ') || 'none (the scene lists no targets)'}`,
          );
    if (!(isRecord(shot.page) && typeof shot.page.settings === 'string'))
      add(
        'shot.page.settings',
        'must name the page function that writes the settings values, for example margoShot.settings, when shot.settings is set',
      );
  }
  const page = shot.page;
  if (!isRecord(page))
    add(at('page'), 'must say what to render: {path, query?, css?, engine, apply?, ready?, canvas?}');
  else {
    if (typeof page.path !== 'string' || !/^[\w][\w./-]*\.html$/.test(page.path) || page.path.includes('..'))
      add(
        'shot.page.path',
        'must be the path of an HTML page in the repository, for example examples/storm-light/index.html',
      );
    if ('query' in page) {
      if (!isRecord(page.query)) add('shot.page.query', 'must be an object of name: value');
      else
        for (const [key, value] of Object.entries(page.query)) {
          if (typeof value !== 'string' && !finite(value))
            add(`shot.page.query.${key}`, 'must be a string or a number');
          if (key === 'quality') add('shot.page.query.quality', 'is set by shot.tier; leave it out of the query');
        }
    }
    if ('css' in page && typeof page.css !== 'string') add('shot.page.css', 'must be CSS text');
    if (typeof page.engine !== 'string' || !DOTTED.test(page.engine))
      add('shot.page.engine', "must name the page's engine from globalThis, for example stormLight.engine");
    if ('apply' in page && (typeof page.apply !== 'string' || !DOTTED.test(page.apply)))
      add('shot.page.apply', 'must name a function from globalThis with dots, for example margoShot.apply');
    if ('settings' in page && (typeof page.settings !== 'string' || !DOTTED.test(page.settings)))
      add('shot.page.settings', 'must name a function from globalThis with dots, for example margoShot.settings');
    if ('aovs' in page && (typeof page.aovs !== 'string' || !DOTTED.test(page.aovs)))
      add('shot.page.aovs', 'must name a function from globalThis with dots, for example stormLight.aovs');
    if ('ground' in page && (typeof page.ground !== 'string' || !DOTTED.test(page.ground)))
      add('shot.page.ground', 'must name the page function (x, z) => ground height from globalThis, for example fauldStill.height');
    for (const key of ['ready', 'canvas'])
      if (key in page && (typeof page[key] !== 'string' || !page[key].trim()))
        add(`shot.page.${key}`, 'must be a CSS selector');
  }
  return issues;
}

/**
 * Reads a shot file: JSON text or an object. Returns a deep-frozen copy with every header default filled in.
 * @throws TypeError naming the first problem's path and fix.
 */
export function parseShot(input) {
  let value;
  try {
    value = typeof input === 'string' ? JSON.parse(input) : JSON.parse(JSON.stringify(input));
  } catch (error) {
    throw new TypeError(`Shot file is not valid JSON (${error.message})`);
  }
  const issues = validateShot(value);
  if (issues.length)
    throw new TypeError(
      `Invalid shot file; fix ${issues[0].path || 'the file'}: ${issues[0].message}${issues.length > 1 ? ` (and ${issues.length - 1} more)` : ''}`,
    );
  const { size, fps } = SHOT_KINDS[value.shot.kind ?? SHOT_DEFAULTS.kind];
  value.shot = {
    ...SHOT_DEFAULTS,
    size,
    fps,
    ...value.shot,
    page: { query: {}, css: '', canvas: 'canvas', ...value.shot.page },
  };
  return deepFreeze(value);
}

const deepFreeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
};

/** File name of frame `index`, as @margoengine/headless/video's imageSequence names them. */
export const frameName = (index) => `frame_${String(index).padStart(4, '0')}.png`;

/**
 * The frames of a parsed shot, in order: pre-roll frames from 0 up to `from` are drawn and not kept, so the page's own
 * clock and the cutscene's agree; kept frames are numbered from 0. Frame `i` of the render is at `i / fps` seconds.
 * @returns {{ render: number, time: number, kept: number | null }[]}
 */
export function shotFrames(file) {
  const { fps, from, seconds } = file.shot,
    skip = Math.round(from * fps),
    count = Math.round(seconds * fps),
    frames = [];
  for (let render = 0; render < skip + count; render++)
    frames.push({ render, time: render / fps, kept: render < skip ? null : render - skip });
  return frames;
}

/**
 * When the sub-frames of a kept frame are drawn (P2 accumulation), in seconds after the frame's own time: `subframes`
 * evenly spread over the open shutter, `shutter` degrees of the frame interval from the frame's time, each at the
 * middle of its slice. One sub-frame is drawn at the frame's own time.
 */
export function subframeOffsets({ fps, subframes, shutter }) {
  if (subframes <= 1) return [0];
  const open = shutter / 360 / fps;
  return Array.from({ length: subframes }, (_, k) => ((k + 0.5) / subframes) * open);
}

/** The kept frame index of each probe, by name: the frame at or just after its time. */
export function probeFrames(file) {
  const { fps, probes, seconds } = file.shot,
    last = Math.round(seconds * fps) - 1;
  return Object.fromEntries(
    Object.entries(probes).map(([name, time]) => [name, Math.max(0, Math.min(last, Math.ceil(time * fps - 1e-9)))]),
  );
}

/**
 * Compares the frame records of two renders of one shot. Returns null when every frame and mask is identical, or the
 * first difference: a different count, warm-up or size, the first frame whose pixels differ, or (frames all equal) the
 * first frame whose masks differ. Frames are named by their record's `index` (the kept frame) when they have one, so
 * renders that kept only some frames (the probes of a production render) name the right ones.
 * @param {{ size: number[], warmup: number, frames: { sha256: string, aovs?: Record<string, { sha256: string }> }[] }} a
 * @param {{ size: number[], warmup: number, frames: { sha256: string, aovs?: Record<string, { sha256: string }> }[] }} b
 */
export function compareRenders(a, b) {
  if (a.size[0] !== b.size[0] || a.size[1] !== b.size[1])
    return { reason: 'size', message: `the renders differ in size: ${a.size.join('x')} and ${b.size.join('x')}` };
  if (a.warmup !== b.warmup)
    return { reason: 'warmup', message: `the renders warmed up for ${a.warmup} and ${b.warmup} frames` };
  if (a.frames.length !== b.frames.length)
    return { reason: 'count', message: `the renders made ${a.frames.length} and ${b.frames.length} frames` };
  const mismatched = [];
  const masks = new Set();
  for (let i = 0; i < a.frames.length; i++) {
    const [x, y] = [a.frames[i], b.frames[i]];
    let same = x.sha256 === y.sha256;
    for (const name of new Set([...Object.keys(x.aovs ?? {}), ...Object.keys(y.aovs ?? {})]))
      if (x.aovs?.[name]?.sha256 !== y.aovs?.[name]?.sha256) {
        same = false;
        masks.add(name);
      }
    if (!same) mismatched.push(i);
  }
  if (!mismatched.length) return null;
  const named = mismatched.map((i) => a.frames[i].index ?? i);
  if (mismatched.every((i) => a.frames[i].sha256 === b.frames[i].sha256))
    return {
      reason: 'aovs',
      frame: named[0],
      frames: named,
      masks: [...masks],
      message: `the ${[...masks].join(', ')} mask differs in ${mismatched.length} of ${a.frames.length} frames between the two renders, first frame ${named[0]}`,
    };
  return {
    reason: 'pixels',
    frame: named[0],
    frames: named,
    message: `${mismatched.length} of ${a.frames.length} frames differ between the two renders, first frame ${named[0]}`,
  };
}

/**
 * The first `seconds` of a shot document (`--seconds`): the header's `seconds` cut to at most `seconds`, the probes inside
 * the cut kept with their bounds, and the authored length kept as `fullSeconds`, so the shot's settings keys are still
 * checked against the whole shot and a key past the cut keeps shaping the rows before it (KB-SHOT-SECONDS-KEYS1).
 * Returns a new document; parse it with {@link parseShot}.
 * @param {any} json The parsed JSON of a shot file.
 * @param {number} seconds Above 0.
 */
export function firstSeconds(json, seconds) {
  if (!(seconds > 0)) throw new TypeError('--seconds must be a number above 0');
  const authored = json.shot?.fullSeconds ?? json.shot?.seconds,
    shot = { ...json.shot, seconds: Math.min(seconds, json.shot?.seconds ?? seconds) };
  if (Number.isFinite(authored) && authored > shot.seconds) shot.fullSeconds = authored;
  if (shot.probes)
    shot.probes = Object.fromEntries(Object.entries(shot.probes).filter(([, time]) => time < shot.seconds));
  if (shot.probeLookBounds)
    shot.probeLookBounds = Object.fromEntries(
      Object.entries(shot.probeLookBounds).filter(([name]) => Object.hasOwn(shot.probes ?? {}, name)),
    );
  return { ...json, shot };
}

/**
 * A camera whose heights are above the ground (`shot.page.ground`) set on the ground: `ground(x, z)` added to the
 * position's height under the position and to the target's height under the target. Returns a new camera; `up`, `fov`
 * and `roll` are kept. The render does the same in the page, with the page's ground function.
 * @param {{ position: number[], target: number[] }} camera
 * @param {(x: number, z: number) => number} ground
 */
export function onGround(camera, ground) {
  const [px, py, pz] = camera.position,
    [tx, ty, tz] = camera.target,
    a = ground(px, pz),
    b = ground(tx, tz);
  if (!Number.isFinite(a) || !Number.isFinite(b))
    throw new RangeError(`the page's ground gave ${a} under the camera and ${b} under the target; it must give metres`);
  return { ...camera, position: [px, py + a, pz], target: [tx, ty + b, tz] };
}

/**
 * The camera of every kept frame of a parsed shot, read from its camera track the way a render reads it (each frame at
 * its own time, pre-roll included in the clock): `{ id, fps, frames, size, subject, cameras: [{ frame, time,
 * position, target, fov, roll }] }`, fov in degrees, roll in radians, time in seconds from the first kept frame. Plain
 * data, no browser: the film pipeline's camera checks read it (`cli.mjs --cameras`).
 * @throws TypeError when a kept frame has no camera (the shot has no camera track).
 */
export function cameraFrames(file) {
  const cutscene = new Cutscene(file),
    { shot } = file,
    cameras = [];
  for (const frame of shotFrames(file)) {
    if (frame.kept === null) continue;
    const camera = cutscene.evaluate(frame.time).camera;
    if (!camera)
      throw new TypeError(`shot ${shot.id} has no camera at kept frame ${frame.kept}: give it a camera track`);
    cameras.push({
      frame: frame.kept,
      time: frame.time - shot.from,
      position: [...camera.position],
      target: [...camera.target],
      fov: camera.fov,
      roll: camera.roll,
    });
  }
  return {
    id: shot.id,
    fps: shot.fps,
    frames: cameras.length,
    size: [...shot.size],
    subject: shot.subject,
    // With page.ground the camera and target heights are above the ground under each (the page adds it as it draws):
    // a reader that needs heights above sea level takes them from the stills' stills.json.
    heights: shot.page?.ground ? 'ground' : 'world',
    cameras,
  };
}
