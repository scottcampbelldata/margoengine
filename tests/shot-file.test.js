// The shot file format of tools/shot (docs/shots.md): a cutscene document with a shot header. Checks the defaults,
// every header rule, the cutscene rules passed through, the frame list with pre-roll, probe frames, the comparison of
// two renders, and that the Storm Light shot in the repository is valid. Plain data: no browser and no GPU.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  SHOT_DEFAULTS,
  SHOT_KINDS,
  compareRenders,
  firstSeconds,
  frameName,
  parseShot,
  probeFrames,
  shotFrames,
  validateShot,
} from '../tools/shot/shot-file.mjs';
import { shotBrowser, shotOutput, today } from '../tools/shot/platform.mjs';

const root = resolve(import.meta.dirname, '..');
const shot = (header = {}, document = {}) => ({
  format: 'margo-cutscene',
  version: 1,
  duration: 4,
  tracks: [],
  ...document,
  shot: {
    format: 'margo-shot',
    version: 1,
    id: 'test-shot',
    seconds: 2,
    page: { path: 'examples/storm-light/index.html', engine: 'stormLight.engine' },
    ...header,
  },
});
const paths = (input) => validateShot(input).map((issue) => issue.path);

test('a minimal shot is valid and gets the vertical 1080 x 1920, 60 fps defaults', () => {
  assert.deepEqual(validateShot(shot()), []);
  const file = parseShot(shot());
  assert.deepEqual(file.shot.size, [1080, 1920]);
  assert.equal(file.shot.fps, 60);
  assert.equal(file.shot.seed, SHOT_DEFAULTS.seed);
  assert.equal(file.shot.tier, 'high');
  assert.equal(file.shot.subframes, 1);
  assert.equal(file.shot.warmup, 60);
  assert.deepEqual(file.shot.page.query, {});
  assert.equal(file.shot.page.canvas, 'canvas');
  assert.ok(Object.isFrozen(file.shot.page), 'parsed shots are frozen');
  assert.equal(parseShot(JSON.stringify(shot())).shot.id, 'test-shot', 'JSON text is read too');
});

test('a long shot is footage for a long video: 1920 x 1080 at 30 fps by default, under 20 minutes', () => {
  assert.equal(SHOT_DEFAULTS.kind, 'short');
  assert.deepEqual(SHOT_KINDS.long, { size: [1920, 1080], fps: 30, maxSeconds: 1200 });
  const long = (header) => shot({ kind: 'long', ...header }, { duration: 1200 });
  const file = parseShot(long({ seconds: 600 }));
  assert.deepEqual(file.shot.size, [1920, 1080]);
  assert.equal(file.shot.fps, 30);
  assert.equal(file.shot.kind, 'long');
  assert.equal(shotFrames(file).length, 18_000, 'ten minutes at 30 fps');
  // The header's own size and rate win over the kind's.
  const own = parseShot(long({ size: [1280, 720], fps: 60 }));
  assert.deepEqual([own.shot.size, own.shot.fps], [[1280, 720], 60]);
  // A whole number of frames at the kind's 30 fps, and the kind's length limit.
  assert.deepEqual(paths(long({ seconds: 1 / 60 })), ['shot.seconds']);
  assert.match(validateShot(long({ seconds: 1200 }))[0].message, /under 1200 \(a long shot\)/);
  assert.match(validateShot(shot({ seconds: 60 }, { duration: 100 }))[0].message, /under 60 \(a short shot\)/);
  assert.deepEqual(paths(shot({ kind: 'film' })), ['shot.kind']);
  // A short is unchanged: 1080 x 1920 at 60 fps.
  assert.deepEqual([parseShot(shot({ kind: 'short' })).shot.size, parseShot(shot()).shot.fps], [[1080, 1920], 60]);
});

test('every header field is checked, each issue at its path', () => {
  const cases = [
    [{ format: 'shot' }, 'shot.format'],
    [{ version: 2 }, 'shot.version'],
    [{ id: 'Bad Id' }, 'shot.id'],
    [{ seed: -1 }, 'shot.seed'],
    [{ seed: 2 ** 32 }, 'shot.seed'],
    [{ size: [1080] }, 'shot.size'],
    [{ size: [1080.5, 1920] }, 'shot.size'],
    [{ size: [8, 1920] }, 'shot.size'],
    [{ fps: 0 }, 'shot.fps'],
    [{ fps: 29.97 }, 'shot.fps'],
    [{ seconds: 0 }, 'shot.seconds'],
    [{ seconds: 5 }, 'shot.seconds'],
    [{ seconds: 60 }, 'shot.seconds'],
    [{ seconds: 1.005 }, 'shot.seconds'],
    [{ from: -1 }, 'shot.from'],
    [{ from: 3 }, 'shot.seconds'],
    [{ tier: 'ultra' }, 'shot.tier'],
    [{ kit: 3 }, 'shot.kit'],
    [{ subframes: 0 }, 'shot.subframes'],
    [{ shutter: 400 }, 'shot.shutter'],
    [{ grade: 5 }, 'shot.grade'],
    [{ endCard: 'yes' }, 'shot.endCard'],
    [{ warmup: -1 }, 'shot.warmup'],
    [{ probes: [] }, 'shot.probes'],
    [{ probes: { Late: 1 } }, 'shot.probes.Late'],
    [{ probes: { late: 2 } }, 'shot.probes.late'],
    [{ lookBounds: { clip: 'x' } }, 'shot.lookBounds.clip'],
    // Checks the tool cannot run fail every render: an unknown name, and nan (no float frame is written).
    [{ lookBounds: { clipping: 1 } }, 'shot.lookBounds.clipping'],
    [{ lookBounds: { nan: 0 } }, 'shot.lookBounds.nan'],
    [{ lookFamily: 'cinematic' }, 'shot.lookFamily'],
    [{ lookFamily: 3 }, 'shot.lookFamily'],
    // A probe's own bounds: they name one of the probes, and each is checked as the shot's are.
    [{ probeLookBounds: [] }, 'shot.probeLookBounds'],
    [{ probes: { late: 1 }, probeLookBounds: { early: { lights: 1 } } }, 'shot.probeLookBounds.early'],
    [{ probes: { late: 1 }, probeLookBounds: { late: { clipping: 1 } } }, 'shot.probeLookBounds.late.clipping'],
    [{ probes: { late: 1 }, probeLookBounds: { late: { lights: 'x' } } }, 'shot.probeLookBounds.late.lights'],
    [{ page: null }, 'shot.page'],
  ];
  for (const [header, path] of cases) assert.deepEqual(paths(shot(header)), [path], JSON.stringify(header));
  const page = (fields) => paths(shot({ page: { path: 'examples/storm-light/index.html', engine: 'stormLight.engine', ...fields } }));
  assert.deepEqual(page({ path: '../outside.html' }), ['shot.page.path']);
  assert.deepEqual(page({ path: 'examples/storm-light/main.ts' }), ['shot.page.path']);
  assert.deepEqual(page({ engine: 'window["x"]' }), ['shot.page.engine'], 'the engine is a dotted path, never code');
  assert.deepEqual(page({ apply: 'a.b()' }), ['shot.page.apply']);
  assert.deepEqual(page({ query: { quality: 'low' } }), ['shot.page.query.quality'], 'the tier sets quality');
  assert.deepEqual(page({ query: { tour: {} } }), ['shot.page.query.tour']);
  assert.deepEqual(page({ ready: '' }), ['shot.page.ready']);
  assert.deepEqual(page({ css: 1 }), ['shot.page.css']);
  assert.deepEqual(paths({ format: 'margo-cutscene', version: 1, duration: 1, tracks: [] }), ['shot']);
  assert.deepEqual(paths(null), ['']);
  assert.throws(() => parseShot(shot({ fps: 0 })), /Invalid shot file; fix shot\.fps/);
  assert.throws(() => parseShot('{'), /not valid JSON/);
});

test('the cutscene document is checked by @margoengine/cutscene, tween easings included', () => {
  const camera = (ease) => ({
    tracks: [
      {
        type: 'camera',
        id: 'c',
        keys: [
          { time: 0, position: [0, 0, 5], target: [0, 0, 0] },
          { time: 4, position: [5, 0, 5], target: [0, 0, 0], ease },
        ],
      },
    ],
  });
  assert.deepEqual(validateShot(shot({}, camera('easeInOutCubic'))), []);
  assert.deepEqual(paths(shot({}, camera('wobbly'))), ['tracks[0].keys[1].ease']);
  assert.ok(paths(shot({}, { duration: -1 })).includes('duration'));
  assert.ok(paths(shot({}, { format: 'other' })).includes('format'));
});

test('frames: pre-roll up to from is drawn and not kept, kept frames count from 0', () => {
  const file = parseShot(shot({ from: 0.5, seconds: 1, fps: 4 }));
  const frames = shotFrames(file);
  assert.deepEqual(
    frames.map((f) => [f.render, f.time, f.kept]),
    [
      [0, 0, null],
      [1, 0.25, null],
      [2, 0.5, 0],
      [3, 0.75, 1],
      [4, 1, 2],
      [5, 1.25, 3],
    ],
  );
  assert.equal(shotFrames(parseShot(shot())).length, 120, '2 s at 60 fps');
  assert.equal(frameName(7), 'frame_0007.png', 'named as headless/video imageSequence names them');
  assert.equal(frameName(1859), 'frame_1859.png');
});

test('probes land on the frame at or just after their time', () => {
  const file = parseShot(shot({ probes: { open: 0, mid: 1, odd: 1.001, edge: 1.99 } }));
  assert.deepEqual(probeFrames(file), { open: 0, mid: 60, odd: 61, edge: 119 });
  assert.ok(Object.is(probeFrames(file).open, 0), 'frame 0, not -0');
});

test('compareRenders finds the first differing frame, or null when identical', () => {
  const render = (hashes, extra = {}) => ({ size: [1080, 1920], warmup: 60, frames: hashes.map((sha256) => ({ sha256 })), ...extra });
  assert.equal(compareRenders(render(['a', 'b', 'c']), render(['a', 'b', 'c'])), null);
  const difference = compareRenders(render(['a', 'b', 'c', 'd']), render(['a', 'x', 'c', 'y']));
  assert.equal(difference.reason, 'pixels');
  assert.equal(difference.frame, 1);
  assert.deepEqual(difference.frames, [1, 3]);
  assert.match(difference.message, /2 of 4 frames differ between the two renders, first frame 1/);
  assert.equal(compareRenders(render(['a']), render(['a', 'b'])).reason, 'count');
  assert.equal(compareRenders(render(['a']), render(['a'], { warmup: 61 })).reason, 'warmup');
  assert.equal(compareRenders(render(['a']), render(['a'], { size: [1920, 1080] })).reason, 'size');
  // Renders that kept some frames only (a production render's probes) name frames by their record's index.
  const probes = (hashes) => ({ size: [1080, 1920], warmup: 60, frames: hashes.map((sha256, i) => ({ index: [0, 240, 479][i], sha256 })) });
  const probe = compareRenders(probes(['a', 'b', 'c']), probes(['a', 'b', 'x']));
  assert.deepEqual([probe.frame, probe.frames], [479, [479]]);
  assert.match(probe.message, /1 of 3 frames differ between the two renders, first frame 479/);
});

test('compareRenders checks the masks too: a mask that differs while the frames match is its own reason', () => {
  const render = (masks) => ({
    size: [1080, 1920],
    warmup: 60,
    frames: masks.map((sky, i) => ({ sha256: String(i), aovs: { sky: { sha256: sky }, depth: { sha256: 'd' } } })),
  });
  assert.equal(compareRenders(render(['a', 'b']), render(['a', 'b'])), null);
  const difference = compareRenders(render(['a', 'b', 'c']), render(['a', 'x', 'c']));
  assert.equal(difference.reason, 'aovs');
  assert.deepEqual(difference.masks, ['sky']);
  assert.equal(difference.frame, 1);
  assert.match(difference.message, /the sky mask differs in 1 of 3 frames between the two renders, first frame 1/);
  const both = render(['a']);
  both.frames[0].sha256 = 'other';
  assert.equal(compareRenders(render(['a']), both).reason, 'pixels', 'a frame that differs is a pixel difference first');
});

test('masks: names, the horizon the sky and water masks need, geometry under them and the page hook', () => {
  const page = { path: 'examples/storm-light/index.html', engine: 'stormLight.engine', aovs: 'stormLight.aovs' };
  assert.deepEqual(validateShot(shot({ aovs: ['geometry', 'depth', 'sky', 'water', 'foam'], horizon: { y: 0 }, page })), []);
  assert.deepEqual(parseShot(shot()).shot.aovs, [], 'no masks by default');
  assert.equal(parseShot(shot()).shot.horizon, null);
  const cases = [
    [{ aovs: 'sky' }, 'shot.aovs'],
    [{ aovs: ['Sky'], page }, 'shot.aovs[0]'],
    [{ aovs: ['depth', 'depth'], page }, 'shot.aovs[1]'],
    // The tool's own mask (the pixels the page's sky drew, KB-HEARTH-CLIP1): a page cannot give it.
    [{ aovs: ['depth', 'sky-coverage'], page }, 'shot.aovs[1]'],
    [{ aovs: ['geometry', 'sky'], page }, 'shot.horizon'],
    [{ aovs: ['sky'], horizon: { y: 0 }, page }, 'shot.aovs'],
    [{ horizon: { y: 'sea' } }, 'shot.horizon'],
    [{ aovs: ['depth'] }, 'shot.page.aovs'],
    [{ aovs: ['depth'], page: { ...page, aovs: 'stormLight.aovs()' } }, 'shot.page.aovs'],
  ];
  for (const [header, path] of cases) assert.ok(paths(shot(header)).includes(path), `${JSON.stringify(header)} flags ${path}`);
});

test('the Storm Light tour shot in the repository is valid', () => {
  const file = parseShot(readFileSync(resolve(root, 'tools/shot/shots/storm-light-tour.json'), 'utf8'));
  assert.equal(file.shot.id, 'storm-light-tour');
  assert.deepEqual(file.shot.size, [1080, 1920]);
  assert.equal(file.shot.fps, 60);
  assert.equal(file.tracks[0].type, 'camera');
  // Its lit windows, lamps and lantern: 2 to 4 discs on the probes that face them, none on the two that look away;
  // the gallery sees one lantern through a lattice, 1 to 4 (coordinator rulings under Scott's 'your pick', 2026-11-16
  // 01:01 and 03:15; docs/shots.md, Bounds).
  assert.deepEqual(file.shot.lookBounds, {});
  assert.deepEqual(file.shot.probeLookBounds, {
    open: { lights: [0, 0] },
    strike: { lights: [0, 0] },
    climb: { lights: [2, 4] },
    gallery: { lights: [1, 4] },
    west: { lights: [2, 4] },
  });
  assert.match(JSON.parse(readFileSync(resolve(root, 'tools/shot/shots/storm-light-tour.json'), 'utf8')).shot.probeLookBoundsReason, /gallery sees one real lantern/);
});

test('the Cabin Hearth shots are valid, vertical, one MSAA sample, with probes and look bounds', () => {
  for (const id of ['cabin-window-snow', 'cabin-push-in', 'cabin-hearth-kettle', 'cabin-wireframe', 'cabin-bare']) {
    const file = parseShot(readFileSync(resolve(root, `tools/shot/shots/${id}.json`), 'utf8'));
    assert.equal(file.shot.id, id);
    assert.deepEqual(file.shot.size, [1080, 1920]);
    // Particles, fog and snow are in view: one sample, as KB5700f asks for transparent surfaces on NVIDIA.
    assert.equal(file.shot.msaa, 1, id);
    assert.equal(file.shot.page.path, 'examples/cabin-hearth/index.html');
    assert.equal(file.shot.page.query.ui, 0, `${id} turns the mouse orbit off`);
    assert.ok(Object.keys(file.shot.probes).length >= 3, `${id} names its probes`);
    assert.ok(Object.values(file.shot.probes).every((t) => t >= 0 && t < file.shot.seconds), `${id} probes inside the shot`);
    assert.ok(Object.keys(file.shot.lookBounds).length > 0, `${id} sets look bounds`);
  }
});

test('Cabin Hearth push-in: the camera goes through one window pane, clear of the cross bars and the frame', () => {
  // The first path ran through the middle of the window, where the cross bars meet: the camera cut through the bars.
  // examples/cabin-hearth/main.ts: front wall logs z 2.35 to 2.65, frame and sill out to z 2.34 to 2.76; opening x 0.6
  // to 1.8, y 0.97 to 2.03; cross bars 0.045 m wide at x 1.2 and y 1.5. Between keys the path is a straight line.
  const keys = parseShot(readFileSync(resolve(root, 'tools/shot/shots/cabin-push-in.json'), 'utf8')).tracks[0].keys;
  const before = keys.findLast((k) => k.position[2] > 2.76),
    after = keys.find((k) => k.position[2] < 2.34);
  assert.ok(before && after && after.time > before.time, 'the path goes from outside to inside');
  const margin = (x, y) =>
    Math.min(x - 0.6, 1.8 - x, y - 0.97, 2.03 - y, Math.abs(x - 1.2) - 0.0225, Math.abs(y - 1.5) - 0.0225);
  for (let z = 2.34; z <= 2.76; z += 0.01) {
    const t = (z - before.position[2]) / (after.position[2] - before.position[2]),
      [x, y] = [0, 1].map((i) => before.position[i] + t * (after.position[i] - before.position[i]));
    assert.ok(margin(x, y) >= 0.15, `at z ${z.toFixed(2)} the camera is ${margin(x, y).toFixed(3)} m from a bar or frame`);
  }
});

// Whiteout flakes are swept over their share of the shutter (sky Weather `exposure`): each sub-frame its share, so the
// sweeps join into one streak; without it the gale's flakes summed over eight sub-frames showed as rows of dots.
function assertExposure(file, id) {
  const { fps, subframes = 1, shutter = 180 } = file.shot;
  const share = shutter / 360 / fps / subframes;
  assert.ok(Math.abs(file.shot.page.query.exposure - share) < 1e-6, `${id} exposure ${file.shot.page.query.exposure}, its share ${share}`);
}

test('the Whiteout Pass shots are valid, vertical, one MSAA sample, with probes and look bounds', () => {
  const ids = ['whiteout-window', 'whiteout-walk-in', 'whiteout-window-close', 'whiteout-clearing', 'whiteout-wireframe', 'whiteout-wind', 'whiteout-bare'];
  for (const id of ids) {
    const file = parseShot(readFileSync(resolve(root, `tools/shot/shots/${id}.json`), 'utf8'));
    assert.equal(file.shot.id, id);
    assert.deepEqual(file.shot.size, [1080, 1920]);
    assert.equal(file.shot.msaa, 1, id);
    assert.equal(file.shot.page.path, 'examples/whiteout-pass/index.html');
    assert.equal(file.shot.page.query.ui, 0, `${id} turns the mouse orbit off`);
    assert.ok(Object.keys(file.shot.probes).length >= 3, `${id} names its probes`);
    assert.ok(Object.values(file.shot.probes).every((t) => t >= 0 && t < file.shot.seconds), `${id} probes inside the shot`);
    assert.ok(Object.keys(file.shot.lookBounds).length > 0, `${id} sets look bounds`);
    assertExposure(file, id);
  }
  // The clearing drives the storm through the page's apply hook from a property track that ends in the lull.
  const clearing = parseShot(readFileSync(resolve(root, 'tools/shot/shots/whiteout-clearing.json'), 'utf8'));
  assert.equal(clearing.shot.page.apply, 'whiteoutPass.apply');
  const track = clearing.tracks.find((t) => t.type === 'property');
  assert.deepEqual([track.target, track.property, track.keys[0].value, track.keys.at(-1).value], ['weather', 'storm', 1, 0]);
});

test('the Whiteout Pass long footage: the seven shots as long kind, 1920 x 1080 at 30 fps, with a probe in the last second', () => {
  for (const id of ['window', 'walk-in', 'window-close', 'clearing', 'wireframe', 'wind', 'bare']) {
    const short = parseShot(readFileSync(resolve(root, `tools/shot/shots/whiteout-${id}.json`), 'utf8'));
    const file = parseShot(readFileSync(resolve(root, `tools/shot/shots/whiteout-long-${id}.json`), 'utf8'));
    assert.equal(file.shot.id, `whiteout-long-${id}`);
    assert.equal(file.shot.kind, 'long', id);
    assert.deepEqual([file.shot.size, file.shot.fps], [[1920, 1080], 30], id);
    assert.equal(file.shot.seconds, short.shot.seconds * 1.5, `${id} runs half again as long as its short`);
    assert.equal(file.shot.page.path, 'examples/whiteout-pass/index.html');
    // A production render checks only the probes, so one near the end covers the whole shot.
    assert.ok(Object.values(file.shot.probes).some((t) => t >= file.shot.seconds - 1 && t < file.shot.seconds), `${id} probes its end`);
    assertExposure(file, id);
  }
});

test('a short is under a minute', () => {
  assert.deepEqual(validateShot(shot({ seconds: 59.5 }, { duration: 60 })), []);
  assert.deepEqual(paths(shot({ seconds: 60 }, { duration: 61 })), ['shot.seconds']);
});

test('the browser per platform: Edge on Windows, Chrome on macOS, MARGO_BROWSER or --browser= over both', () => {
  assert.equal(shotBrowser({ platform: 'win32', env: {}, argv: [] }), 'edge');
  assert.equal(shotBrowser({ platform: 'darwin', env: {}, argv: [] }), 'chrome');
  assert.equal(shotBrowser({ platform: 'linux', env: {}, argv: [] }), 'chromium');
  assert.equal(shotBrowser({ platform: 'win32', env: { MARGO_BROWSER: 'Chrome' }, argv: [] }), 'chrome');
  assert.equal(shotBrowser({ platform: 'darwin', env: { MARGO_BROWSER: 'chrome' }, argv: ['--browser=edge'] }), 'edge');
});

test('output: one folder per day, the frames in <id>/, the master and caption named for the encoder', () => {
  const repo = resolve('/repo');
  const output = shotOutput('storm-light-tour', { repo, day: '2026-11-14', env: {} });
  assert.equal(output.folder, resolve('/repo/test-results/shots/2026-11-14'));
  assert.equal(output.frames, resolve('/repo/test-results/shots/2026-11-14/storm-light-tour'));
  assert.equal(output.master, 'storm-light-tour.mp4');
  assert.equal(output.caption, 'storm-light-tour.txt');
  const queued = shotOutput('a', { repo, day: '2026-11-15', env: { MARGO_SHOT_OUT: resolve('/renders') } });
  assert.equal(queued.frames, resolve('/renders/2026-11-15/a'));
  assert.throws(() => shotOutput('a', { repo, day: '14-11-2026', env: {} }), /YYYY-MM-DD/);
  assert.equal(today(new Date(2026, 0, 5, 23, 59)), '2026-01-05', 'the local date');
});

test('the Event Horizon shots are valid, one MSAA sample, with probes, and drive the hole through eventHorizon.apply', () => {
  const long = ['approach', 'inclinations', 'spin', 'accretion', 'geodesics', 'redshift', 'beaming', 'orders', 'before-after', 'jet', 'rim', 'plunge'];
  const short = ['approach', 'fix', 'maps'];
  let seconds = 0;
  for (const [kind, ids] of [['long', long], ['short', short]])
    for (const name of ids) {
      const id = `eh-${kind}-${name}`,
        file = parseShot(readFileSync(resolve(root, `tools/shot/shots/${id}.json`), 'utf8'));
      assert.equal(file.shot.id, id);
      assert.equal(file.shot.kind, kind);
      assert.equal(file.shot.msaa, 1, id);
      assert.equal(file.shot.page.path, 'examples/event-horizon/index.html');
      assert.equal(file.shot.page.apply, 'eventHorizon.apply');
      assert.equal(file.shot.page.query.ui, 0, `${id} hides the panel`);
      assert.ok(Object.keys(file.shot.probes).length >= 3, `${id} names its probes`);
      assert.ok(Object.values(file.shot.probes).every((t) => t >= 0 && t < file.shot.seconds), `${id} probes inside the shot`);
      for (const track of file.tracks.filter((t) => t.type === 'property')) assert.equal(track.target, 'hole', id);
      if (kind === 'long') seconds += file.shot.seconds;
    }
  assert.ok(seconds >= 600 && seconds <= 720, `about 11 minutes of long footage (${seconds} s)`);
});

test('the Event Horizon shot files match what examples/event-horizon/make-shots.mjs writes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eh-shots-'));
  try {
    execFileSync(process.execPath, [resolve(root, 'examples/event-horizon/make-shots.mjs'), dir]);
    const made = readdirSync(dir).sort();
    assert.equal(made.length, 15);
    for (const name of made)
      // Compared as data: a Windows checkout may turn the line ends into CRLF.
      assert.deepEqual(JSON.parse(readFileSync(join(dir, name), 'utf8')), JSON.parse(readFileSync(resolve(root, 'tools/shot/shots', name), 'utf8')), name);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a shot header may name a catalogue scene and settings; each is checked, the page needs a settings hook', () => {
  const page = { path: 'examples/storm-light/index.html', engine: 'stormLight.engine', settings: 'margoShot.settings' };
  assert.deepEqual(paths(shot({ scene: 'dune-coast', page })), []);
  assert.deepEqual(paths(shot({ scene: 'nowhere', page })), ['shot.scene']);
  assert.deepEqual(paths(shot({ settings: { weather: {} }, page })), ['shot.settings']);
  assert.deepEqual(paths(shot({ scene: 'dune-coast', settings: 5, page })), ['shot.settings']);
  // dune-coast lists no targets, so a target of it is refused with the names it has (none).
  assert.deepEqual(paths(shot({ scene: 'dune-coast', settings: { weather: {} }, page })), ['shot.settings.weather']);
  assert.deepEqual(paths(shot({ scene: 'dune-coast', settings: { weather: {} } })), ['shot.settings.weather', 'shot.page.settings']);
  assert.deepEqual(paths(shot({ page: { ...page, settings: 'not a name' } })), ['shot.page.settings']);
});

test('shot settings are checked against the packages\' tables, evaluated per time from the shot start, and written from info.shots', async () => {
  const { checkShotFileSettings, shotValuesAt, shotFilesFromScene } = await import('../tools/shot/scene-settings.mjs');
  const { TONEMAP_SETTINGS } = await import('@margoengine/tonemap/settings');
  const info = { name: 'demo', targets: { tonemap: '@margoengine/tonemap/settings' } };
  const settings = { tonemap: { 'tonemap.exposure': { keys: [{ time: 0, value: -1 }, { time: 2, value: 1 }] } } };
  const page = { path: 'examples/storm-light/index.html', engine: 'stormLight.engine', settings: 'margoShot.settings' };
  // dune-coast lists no targets, so the header is parsed without them and the settings joined after (the check takes its own info).
  const parsed = { ...parseShot(shot({ scene: 'dune-coast', page }, { duration: 6, tracks: [] })).shot, settings };
  const from = { ...parsed, from: 2 };
  const tables = await checkShotFileSettings(from, info);
  assert.equal(tables.tonemap, TONEMAP_SETTINGS);
  assert.equal(shotValuesAt(from, tables, 2).tonemap['tonemap.exposure'], -1, 'the shot clock starts at from');
  assert.equal(shotValuesAt(from, tables, 3).tonemap['tonemap.exposure'], 0);
  assert.equal(shotValuesAt(from, null, 3), null);
  assert.equal(await checkShotFileSettings({ ...parsed, settings: undefined }, info), null);
  await assert.rejects(() => checkShotFileSettings({ ...parsed, settings: { tonemap: { 'tonemap.exposure': 99 } } }, info), { name: 'RangeError', message: /tonemap.exposure/ });
  await assert.rejects(() => checkShotFileSettings({ ...parsed, settings: { tonemap: { 'tonemap.exposure': { keys: [{ time: 0, value: 0 }, { time: 9, value: 1 }] } } } }, info), RangeError);
  await assert.rejects(() => checkShotFileSettings({ ...parsed, settings: { weather: {} } }, info), { name: 'TypeError', message: /no target weather/ });
  const made = shotFilesFromScene({ ...info, shots: [{ name: 'one', seconds: 2, camera: ['a'], settings, about: 'x' }] }, { page, tracks: { one: [] }, kind: 'long' });
  assert.equal(made.length, 1);
  assert.deepEqual(validateShot(made[0]).map((i) => i.path), ['shot.scene'], 'a scene outside the catalogue is refused when the file is checked');
  assert.equal(made[0].shot.id, 'demo-one');
  assert.deepEqual(made[0].shot.settings, settings);
  assert.throws(() => shotFilesFromScene({ ...info, shots: [{ name: 'two', seconds: 1, camera: [], about: 'x' }] }, { page, tracks: {} }), /No tracks for shot two/);
});

test('--seconds keeps the authored length, so a settings key past the cut is checked against the whole shot (KB-SHOT-SECONDS-KEYS1)', async () => {
  const { checkShotFileSettings } = await import('../tools/shot/scene-settings.mjs');
  const json = JSON.parse(readFileSync(resolve(root, 'tools/shot/shots/timber-valley-ridge-smoke.json'), 'utf8')),
    keys = Object.values(json.shot.settings).flatMap((rows) => Object.values(rows)).flatMap((row) => row?.keys ?? []);
  assert.ok(keys.some((key) => key.time > 1.1), 'the shot keys a row past 1.1 s');
  const cut = parseShot(firstSeconds(json, 1.1)).shot;
  assert.equal(cut.seconds, 1.1);
  assert.equal(cut.fullSeconds, json.shot.seconds);
  assert.ok(await checkShotFileSettings(cut), 'the keys are checked against the authored length');
  // Cut without its authored length (the old --seconds), the same keys leave the shot.
  await assert.rejects(() => checkShotFileSettings({ ...cut, fullSeconds: undefined }), { name: 'RangeError', message: /key times must be seconds inside the shot/ });
  assert.equal(firstSeconds(json, 99).shot.fullSeconds, undefined, 'a cut past the end changes nothing');
  assert.deepEqual(validateShot({ ...json, shot: { ...json.shot, fullSeconds: 1 } }).map((i) => i.path), ['shot.fullSeconds']);
  assert.throws(() => firstSeconds(json, 0), /above 0/);
});

test('an entry with several settings tables gives the one named after its package; another needs #NAME (KB-ROOT-RED18)', async () => {
  const { loadShotTables } = await import('../tools/shot/scene-settings.mjs');
  const { WEATHER_SETTINGS, SNOW_SETTINGS } = await import('@margoengine/weather/settings');
  const shot = { scene: 'test', settings: { weather: {} } };
  const tables = await loadShotTables(shot, { targets: { weather: '@margoengine/weather/settings' } });
  assert.equal(tables.weather, WEATHER_SETTINGS, 'weather/settings exports five tables; WEATHER_SETTINGS is its own');
  const named = await loadShotTables(shot, { targets: { weather: '@margoengine/weather/settings#SNOW_SETTINGS' } });
  assert.equal(named.weather, SNOW_SETTINGS);
  await assert.rejects(() => loadShotTables(shot, { targets: { weather: '@margoengine/weather/settings#NONE_SETTINGS' } }), {
    name: 'TypeError',
    message: /name one as @margoengine\/weather\/settings#NAME/,
  });
});
