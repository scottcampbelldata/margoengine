// Look checks on synthetic frames: each check passes a clean frame and fails the defect it exists for (a banded
// gradient, a doubled moon disc, NaNs, a flicker and the rest), so a check that stops seeing its defect fails here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodePNG } from '../dist/index.js';
import { decodePNG } from '../dist/compare.js';
import {
  LOOK_CHECKS,
  banding,
  blocks,
  checkProbe,
  checkShot,
  crush,
  difference,
  flat,
  flicker,
  flip,
  foamEdges,
  grain,
  horizonLine,
  horizonSeam,
  lights,
  lookBound,
  lookReport,
  luma,
  maskTopEdge,
  nan,
  shimmer,
  skyClip,
  speckle,
  waterSeam,
} from '../dist/look.js';

/** An RGBA frame from a grey or colour function of (x, y). */
const image = (width, height, colour) => {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const c = colour(x, y),
        [r, g, b] = typeof c === 'number' ? [c, c, c] : c;
      data.set([r, g, b, 255], (y * width + x) * 4);
    }
  return { width, height, data };
};
const mask = (width, height, inside) => {
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[y * width + x] = inside(x, y) ? 255 : 0;
  return { width, height, data };
};
/** A seeded uniform noise source, so the noise frames are the same every run. */
const noise = (seed) => () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 32;
};
const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
/** A night sky gradient, darker towards the top, with a soft moon. */
const sky = (width, height, moons = [[0.5, 0.3]]) =>
  image(width, height, (x, y) => {
    let v = 20 + (60 * y) / height;
    for (const [mx, my] of moons) {
      const d = Math.hypot(x - mx * width, y - my * height);
      if (d < 8) v = 250;
      else if (d < 10) v = Math.max(v, 250 - (d - 8) * 60);
    }
    return clamp(v);
  });

test('with no sky mask, skyClip reads the sky package coverage and says so; grain and lights do not (KB-HEARTH-CLIP1)', () => {
  // A cabin interior: a clipped flame and kettle glint in the lower half, the window's sky in the top-left corner
  // (dark night sky with one bright star, so lights finds discs outside the sky too).
  const frame = image(40, 40, (x, y) => (y >= 20 && x >= 10 && x < 30 ? 255 : x < 12 && y < 12 ? 30 : 70)),
    coverage = mask(40, 40, (x, y) => x < 12 && y < 12);
  const bare = checkProbe({ name: 'mid', frame }, { skyClip: 0.5 }),
    covered = checkProbe({ name: 'mid', frame, masks: { 'sky-coverage': coverage } }, { skyClip: 0.5 }),
    row = (rows, check) => rows.find((r) => r.check === check);
  // Without the coverage the flame is counted as sky: 400 of 1,600 pixels clip.
  assert.equal(row(bare, 'skyClip').value, 25);
  assert.equal(row(bare, 'skyClip').mask, 'frame');
  assert.equal(row(covered, 'skyClip').value, 0);
  assert.equal(row(covered, 'skyClip').pass, true);
  assert.equal(row(covered, 'skyClip').detail.pixels, 144, 'measured inside the 12 x 12 window of sky');
  assert.equal(row(covered, 'skyClip').mask, 'sky-coverage');
  // grain and lights keep the whole frame without a page sky mask: the same rows as with no mask at all.
  for (const check of ['grain', 'lights', 'speckle', 'crush'])
    assert.deepEqual(row(covered, check), row(bare, check), check);
  assert.ok(!covered.some((r) => r.check === 'horizonSeam'));
  // A page sky mask wins over the coverage.
  const page = checkProbe({ name: 'mid', frame, masks: { sky: mask(40, 40, () => false), 'sky-coverage': coverage } });
  assert.equal(row(page, 'skyClip').mask, 'sky');
  assert.equal(row(page, 'skyClip').empty, '0 sky pixels');
  const report = lookReport([
    { name: 'mid', frame, results: covered },
    { name: 'close', frame, results: covered },
    { name: 'far', frame, results: bare },
  ]);
  assert.match(report.markdown, /\nMasks:\n- skyClip inside `sky-coverage`, the pixels `@margoengine\/sky` drew \(no page sky mask\): mid, close\n- skyClip over the whole frame \(no sky mask\): far\n$/);
  assert.equal(report.json.probes[0].results.find((r) => r.check === 'skyClip').mask, 'sky-coverage');
});

test('bounds: a number is a ceiling, a pair a range; every check has a default', () => {
  assert.deepEqual(lookBound(2), [-Infinity, 2]);
  assert.deepEqual(lookBound([1, 3]), [1, 3]);
  assert.throws(() => lookBound([3, 1]), TypeError);
  assert.throws(() => lookBound('2'), TypeError);
  for (const [name, { bound, unit }] of Object.entries(LOOK_CHECKS)) {
    assert.ok(bound[0] <= bound[1], name);
    assert.ok(unit, name);
  }
});

test('luma uses the BT.709 weights on the encoded values', () => {
  const y = luma(image(3, 1, (x) => [[255, 0, 0], [0, 255, 0], [0, 0, 255]][x]));
  assert.deepEqual([...y].map((v) => Math.round(v * 1000) / 1000), [54.213, 182.376, 18.411]);
});

test('skyClip counts clipped sky pixels only', () => {
  const frame = image(20, 20, (x, y) => (y < 10 ? (x < 5 ? 255 : 120) : 255)),
    top = mask(20, 20, (x, y) => y < 10);
  const clipped = skyClip(frame, { sky: top });
  assert.equal(clipped.value, 25);
  assert.equal(clipped.pass, false);
  assert.equal(skyClip(image(20, 20, () => 120), { sky: top }).value, 0);
  assert.throws(() => skyClip(frame, { sky: mask(10, 10, () => true) }), RangeError);
  assert.equal(clipped.empty, undefined, 'a mask with sky in it measured something');
});

test('a sky mask with no sky in it says it measured 0 sky pixels: the pass is never silent (KB-HEARTH-CLIP1)', () => {
  // An interior shot: the flames clip, and none of it is sky.
  const frame = image(20, 20, (x, y) => (y < 10 ? 255 : 90)),
    none = mask(20, 20, () => false);
  const clip = skyClip(frame, { sky: none });
  assert.equal(clip.value, 0);
  assert.equal(clip.pass, true);
  assert.equal(clip.detail.pixels, 0);
  assert.equal(clip.empty, '0 sky pixels');
  assert.equal(grain(frame, { mask: none }).empty, '0 pixels inside the mask');
  assert.equal(lights(frame, { mask: none }).empty, '0 pixels inside the mask');
  assert.equal(grain(frame).empty, undefined, 'no mask: the whole frame was measured');
  assert.equal(skyClip(frame).empty, undefined);
  const rows = checkProbe({ name: 'kettle', frame, masks: { sky: none } }, { skyClip: 0.5 });
  assert.equal(rows.find((row) => row.check === 'skyClip').empty, '0 sky pixels');
  assert.equal(checkProbe({ name: 'kettle', frame }, { skyClip: 0.5 }).find((row) => row.check === 'skyClip').pass, false, 'with no mask the whole frame clips');
  const report = lookReport([{ name: 'kettle', frame, results: rows }]);
  assert.match(report.markdown, /\| kettle \| skyClip \| 0 % \| <= 0\.500 % \| pass \(measured 0 sky pixels\) \|/);
  assert.equal(report.json.probes[0].results.find((row) => row.check === 'skyClip').empty, '0 sky pixels');
});

test('grain estimates the noise standard deviation and ignores ramps', () => {
  const random = noise(7),
    // Uniform noise of +/- 6 codes has a standard deviation of 12 / sqrt(12), about 3.46.
    noisy = image(128, 128, (x) => clamp(60 + x * 0.5 + (random() - 0.5) * 12)),
    ramp = image(128, 128, (x, y) => clamp(30 + x + y * 0.5));
  const measured = grain(noisy).value;
  assert.ok(measured > 3 && measured < 4, `measured ${measured}`);
  assert.equal(grain(noisy).pass, false);
  assert.ok(grain(ramp).value < 0.6, `ramp ${grain(ramp).value}`);
  assert.equal(grain(ramp).pass, true);
});

test('speckle finds isolated hot and dead pixels', () => {
  const clean = image(100, 100, (x, y) => clamp(80 + x * 0.3 + y * 0.2)),
    hot = image(100, 100, (x, y) => ((x === 20 && y === 30) || (x === 70 && y === 60) ? 255 : (x === 50 && y === 50 ? 0 : clamp(80 + x * 0.3 + y * 0.2))));
  assert.equal(speckle(clean).value, 0);
  const found = speckle(hot);
  assert.equal(found.detail.speckles, 3);
  assert.equal(found.pass, false);
});

test('banding fails a gradient with too few levels and passes a smooth or dithered one', () => {
  const width = 256,
    height = 64,
    smooth = image(width, height, (x) => clamp(40 + x * 0.25)),
    banded = image(width, height, (x) => 40 + Math.floor((x * 0.25) / 4) * 4),
    random = noise(3),
    dithered = image(width, height, (x) => clamp(Math.floor(40 + x * 0.25 + random())));
  assert.equal(banding(smooth).value, 0);
  assert.ok(banding(banded).value > 90, `banded ${banding(banded).value}`);
  assert.equal(banding(banded).pass, false);
  assert.ok(banding(dithered).value < 1, `dithered ${banding(dithered).value}`);
  // A sharp edge between two areas is a thing, not a band.
  assert.equal(banding(image(width, height, (x) => (x < 128 ? 40 : 200))).value, 0);
});

test('flat finds constant areas but not black, white, a gradient or a slow sky', () => {
  const half = image(256, 256, (x, y) => (x < 128 ? 128 : clamp(30 + x / 2 + y / 3))),
    slowSky = image(256, 256, (x, y) => clamp(40 + y / 40));
  // The constant half, less the 32-pixel margin of the window: 64 of 256 columns and 192 of 256 rows.
  assert.equal(flat(half).value, 18.75);
  assert.equal(flat(half).pass, false);
  assert.equal(flat(image(256, 256, () => 0)).value, 0);
  assert.equal(flat(image(256, 256, () => 255)).value, 0);
  assert.equal(flat(image(256, 256, (x, y) => clamp(30 + x / 2 + y / 3))).value, 0);
  // One code every 40 rows: a smooth night sky at 8 bits, flat to a small window but not to the default one.
  assert.equal(flat(slowSky).value, 0);
  assert.ok(flat(slowSky, { radius: 8 }).value > 50);
});

test('blocks finds steps at the froxel pitch, not at another pitch, in noise or at an edge', () => {
  const random = noise(11),
    // Smooth fog with a little noise, where froxel blocks show.
    base = (x, y) => 90 + 20 * Math.sin(x / 23) + 15 * Math.cos(y / 17) + (random() - 0.5) * 2,
    blocky = image(256, 256, (x, y) => clamp(base(x, y) + ((Math.floor(x / 8) + Math.floor(y / 8)) % 2) * 3)),
    clean = image(256, 256, (x, y) => clamp(base(x, y))),
    period2 = image(256, 256, (x) => clamp(20 + Math.floor(x / 2))),
    tower = image(256, 256, (x, y) => (x >= 40 && x < 48 ? 200 : clamp(base(x, y))));
  const found = blocks(blocky);
  assert.equal(found.value, 100);
  assert.equal(found.pass, false);
  assert.equal(blocks(clean).value, 0);
  assert.equal(blocks(period2).value, 0);
  assert.equal(blocks(tower).value, 0, 'the two edges of one tower are no pattern');
  assert.equal(blocks(sky(256, 320)).value, 0, 'nor the rim of a moon');
  // Blocks in one corner only: that corner's tiles.
  const corner = image(256, 256, (x, y) => clamp(base(x, y) + (x < 128 && y < 128 ? ((Math.floor(x / 8) + Math.floor(y / 8)) % 2) * 3 : 0)));
  assert.equal(blocks(corner).value, 25);
  // Blocks of another size are found at their own pitch.
  const sixteen = image(256, 256, (x, y) => clamp(base(x, y) + ((Math.floor(x / 16) + Math.floor(y / 16)) % 2) * 3));
  assert.equal(blocks(sixteen, { pitch: 16 }).value, 100);
  assert.equal(blocks(sixteen, { pitch: 12 }).value, 0, 'their steps wander across the phases of a 12-pixel pitch');
  assert.equal(blocks(sixteen).value, 0, 'and fall in only half the periods of an 8-pixel one');
  assert.equal(blocks(sky(90, 160, [[0.3, 0.3], [0.7, 0.32]])).value, 0, 'two moons in one tile are no pattern');
});

/** A column-major perspective times a view looking along -z from the origin, pitched by `pitch` radians. */
const viewProjection = (pitch, aspect = 9 / 16) => {
  const f = 1 / Math.tan(Math.PI / 6),
    near = 0.1,
    far = 1000,
    projection = [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, far / (near - far), -1, 0, 0, (far * near) / (near - far), 0],
    c = Math.cos(pitch),
    s = Math.sin(pitch),
    // The view rotates the world by -pitch about x: a camera pitched up sees the horizon lower in the frame.
    view = [1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0, 0, 0, 0, 1],
    out = new Array(16).fill(0);
  for (let column = 0; column < 4; column++)
    for (let row = 0; row < 4; row++)
      for (let k = 0; k < 4; k++) out[column * 4 + row] += projection[k * 4 + row] * view[column * 4 + k];
  return out;
};

test('horizonLine is the centre row for a level camera and moves with pitch', () => {
  const level = horizonLine(viewProjection(0), 90, 160);
  for (const row of level) assert.ok(Math.abs(row - 80) < 1e-3, `level ${row}`);
  // Pitched up by 10 degrees the horizon falls tan(10 deg) / tan(30 deg) of the half height.
  const up = horizonLine(viewProjection((10 * Math.PI) / 180), 90, 160),
    expected = 80 + 80 * (Math.tan(Math.PI / 18) / Math.tan(Math.PI / 6));
  for (const row of up) assert.ok(Math.abs(row - expected) < 1e-2, `up ${row} against ${expected}`);
  // Looking straight down there is no horizon in the frame.
  assert.ok(horizonLine(viewProjection(-Math.PI / 2 + 0.01), 90, 160).every(Number.isNaN));
});

test('horizonSeam fails a hard step at the horizon and passes a blended one', () => {
  const width = 90,
    height = 160,
    vp = viewProjection(0),
    hard = image(width, height, (x, y) => (y < 80 ? clamp(90 - y * 0.2) : clamp(60 - (y - 80) * 0.2))),
    blended = image(width, height, (x, y) => clamp(90 - y * 0.4));
  const seamed = horizonSeam(hard, { viewProjection: vp });
  assert.ok(seamed.value > 12, `hard ${seamed.value}`);
  assert.equal(seamed.pass, false);
  assert.ok(horizonSeam(blended, { viewProjection: vp }).value < 1);
});

test('horizonSeam counts only columns where the sky meets the line: a wall across it is no horizon', () => {
  // Cabin Hearth's interior: the analytic horizon crosses a mantel, a hard step with no sky above it. Before the sky
  // mask limited the columns, it measured 15.8 codes there and failed the shot.
  const width = 90,
    height = 160,
    vp = viewProjection(0),
    wall = image(width, height, (x, y) => (y < 80 ? 90 : 60)),
    noSky = mask(width, height, () => false),
    inside = horizonSeam(wall, { viewProjection: vp, sky: noSky });
  assert.equal(inside.value, 0);
  assert.equal(inside.pass, true);
  assert.equal(inside.detail.columns, 0);
  // Sky over the left half only: the right half's wall is left out, the left half's hard seam still counts.
  const half = mask(width, height, (x, y) => x < 45 && y < 80),
    seamed = horizonSeam(wall, { viewProjection: vp, sky: half });
  assert.equal(seamed.detail.columns, 45);
  assert.ok(seamed.value > 12, `seam where the sky is ${seamed.value}`);
  // checkProbe runs it only with a sky mask; named in the bounds without one, it fails as missing.
  const probe = { name: 'hearth', frame: wall, viewProjection: vp };
  assert.equal(checkProbe(probe).find((row) => row.check === 'horizonSeam'), undefined);
  assert.equal(checkProbe(probe, { horizonSeam: 6 }).find((row) => row.check === 'horizonSeam').missing, 'the sky mask');
  assert.equal(checkProbe({ ...probe, masks: { sky: noSky } }).find((row) => row.check === 'horizonSeam').value, 0);
});

test('waterSeam reads the water line off the water mask', () => {
  const width = 64,
    height = 64,
    line = (x) => 30 + Math.round(4 * Math.sin(x / 8)),
    water = mask(width, height, (x, y) => y >= line(x)),
    edge = maskTopEdge(water);
  assert.deepEqual([...edge], Array.from({ length: width }, (_, x) => line(x)));
  const seamed = image(width, height, (x, y) => (y >= line(x) ? 40 : 100)),
    smooth = image(width, height, (x, y) => clamp(100 - y));
  assert.ok(waterSeam(seamed, { water }).value >= 59);
  assert.equal(waterSeam(seamed, { water }).pass, false);
  assert.ok(waterSeam(smooth, { water }).value < 1);
});

test('lights counts one moon, and a doubled moon fails', () => {
  const one = lights(sky(180, 320)),
    two = lights(sky(180, 320, [[0.3, 0.3], [0.7, 0.32]]));
  assert.equal(one.value, 1);
  assert.equal(one.pass, true);
  assert.equal(two.value, 2);
  assert.equal(two.pass, false);
  assert.equal(lights(sky(180, 320, [[0.3, 0.3], [0.7, 0.32]]), { expected: 2 }).pass, true);
  assert.ok(Math.abs(one.discs[0].x - 90) < 0.5 && Math.abs(one.discs[0].y - 96) < 0.5);
  // A bolt of lightning is bright but no disc; single stars are too small.
  const bolt = image(180, 320, (x, y) => (Math.abs(x - 40 - y * 0.3) < 2 && y < 200 ? 255 : (x % 37 === 0 && y % 41 === 0 ? 255 : 30)));
  assert.equal(lights(bolt).value, 0);
  // A dim moon (luma 200, under the clip) in a dark sky still counts: it stands clear of the sky round it.
  const dim = image(180, 320, (x, y) => (Math.hypot(x - 90, y - 96) < 8 ? 200 : 25));
  assert.equal(lights(dim).value, 1);
});

// KB-LOOK-LIGHTS-CLOUD1: a sky of sunlit cumulus (the Kitty Hawk film's volumetric clouds) failed with 5 to 14 "lights":
// the brightest puffs clear 0.85 of the brightest luma as round blobs, but shade smoothly into the cloud round them.
test('lights does not count the sunlit puffs of cumulus, and still finds a sun among them', () => {
  const puffs = [[40, 60, 14], [120, 50, 10], [80, 140, 12], [150, 200, 9], [50, 240, 11]],
    cloud = (x, y) => {
      let v = 120 + (40 * y) / 320;
      for (const [px, py, r] of puffs) {
        const d = Math.hypot(x - px, y - py) / (3 * r);
        if (d < 1) v = Math.max(v, 150 + 62 * (1 - d * d));
      }
      return v;
    };
  const clouds = image(180, 320, (x, y) => clamp(cloud(x, y)));
  const naive = lights(clouds);
  assert.equal(naive.value, 0, JSON.stringify(naive.discs));
  // The same sky with the sun in it (a clipped disc): one light.
  const sun = image(180, 320, (x, y) => clamp(Math.hypot(x - 100, y - 100) < 7 ? 255 : cloud(x, y)));
  assert.equal(lights(sun).value, 1);
});

test('foamEdges fails thresholded foam and passes soft foam', () => {
  const width = 128,
    height = 128,
    blobs = [[30, 40, 12], [80, 70, 16], [60, 105, 10]],
    distance = (x, y) => Math.min(...blobs.map(([bx, by, r]) => Math.hypot(x - bx, y - by) - r)),
    foam = mask(width, height, (x, y) => distance(x, y) < 0),
    hard = image(width, height, (x, y) => (distance(x, y) < 0 ? 230 : 40)),
    soft = image(width, height, (x, y) => clamp(40 + 190 / (1 + Math.exp(distance(x, y) / 2.5))));
  const found = foamEdges(hard, { foam });
  assert.ok(found.detail.edges > 50);
  assert.ok(found.value > 90, `hard ${found.value}`);
  assert.equal(found.pass, false);
  assert.ok(foamEdges(soft, { foam }).value < 10, `soft ${foamEdges(soft, { foam }).value}`);
  assert.throws(() => foamEdges(hard, {}), TypeError);
});

test('crush counts black outside the declared dark areas', () => {
  const frame = image(20, 20, (x) => (x < 10 ? 0 : 60)),
    dark = mask(20, 20, (x) => x < 10);
  assert.equal(crush(frame).value, 50);
  assert.equal(crush(frame).pass, false);
  assert.equal(crush(frame, { dark }).value, 0);
});

test('flicker fails a brightness jump on a still camera and passes a fade', () => {
  const frames = (level) => level.map((v) => image(32, 32, (x, y) => clamp(v + ((x + y) % 5))));
  const flickering = flicker(frames([100, 100, 106, 100, 100]));
  assert.equal(flickering.detail.frame, 2);
  assert.ok(Math.abs(flickering.value - 6) < 1e-6, `${flickering.value}`);
  assert.equal(flickering.pass, false);
  assert.ok(flicker(frames([100, 102, 104, 106, 108])).value < 1e-6);
  assert.throws(() => flicker(frames([1, 2])), RangeError);
});

test('shimmer fails pixels jumping off their trend while the mean holds', () => {
  const random = noise(5),
    noisy = [0, 1, 2, 3].map(() => image(32, 32, () => clamp(100 + (random() - 0.5) * 40))),
    steady = [0, 1, 2, 3].map((t) => image(32, 32, (x) => clamp(100 + x + t)));
  assert.ok(flicker(noisy).value < 1.5, `mean ${flicker(noisy).value}`);
  assert.ok(shimmer(noisy).value > 30, `shimmer ${shimmer(noisy).value}`);
  assert.equal(shimmer(noisy).pass, false);
  assert.equal(shimmer(steady).value, 0);
});

test('nan finds NaN and infinite pixels in float and half-float frames', () => {
  const floats = new Float32Array(4 * 4 * 4).fill(0.5);
  assert.equal(nan({ width: 4, height: 4, data: floats }).value, 0);
  floats[5 * 4 + 1] = Number.NaN;
  floats[9 * 4 + 3] = Infinity;
  const found = nan({ width: 4, height: 4, data: floats });
  assert.equal(found.value, 2);
  assert.deepEqual(found.detail, { x: 1, y: 1 });
  assert.equal(found.pass, false);
  const half = new Uint16Array(4 * 4 * 4).fill(0x3c00);
  half[2] = 0x7e00; // A half-float NaN.
  half[7 * 4] = 0xfc00; // Minus infinity.
  assert.equal(nan({ width: 4, height: 4, data: half }).value, 2);
  assert.throws(() => nan({ width: 4, height: 4, data: new Uint8Array(64) }), TypeError);
});

test('flip is 0 for identical frames, small for a slight change and large for a visible one', () => {
  const random = noise(9),
    reference = image(96, 96, (x, y) => [clamp(60 + x), clamp(40 + y), clamp(120 + 40 * Math.sin(x / 9))]),
    slight = image(96, 96, (x, y) => [clamp(61 + x), clamp(40 + y), clamp(120 + 40 * Math.sin(x / 9))]),
    noisy = image(96, 96, (x, y) => [clamp(60 + x + (random() - 0.5) * 80), clamp(40 + y), clamp(120 + 40 * Math.sin(x / 9))]);
  const same = flip(reference, reference);
  assert.equal(same.mean, 0);
  assert.equal(same.max, 0);
  const small = flip(slight, reference).mean,
    large = flip(noisy, reference).mean;
  assert.ok(small > 0 && small < 0.04, `slight ${small}`);
  assert.ok(large > 0.05 && large > 3 * small, `noisy ${large}`);
  // Seen from further away (more pixels per degree) the same noise is harder to see.
  assert.ok(flip(noisy, reference, { pixelsPerDegree: 200 }).mean < large);
  // Black against white is the largest luminance error FLIP gives short of colour: close to 1 before features.
  const black = image(32, 32, () => 0),
    white = image(32, 32, () => 255);
  const extreme = flip(black, white).mean;
  assert.ok(extreme > 0.9 && extreme <= 1, `black and white ${extreme}`);
  const row = difference(noisy, reference, 'reference');
  assert.equal(row.check, 'reference');
  assert.equal(row.pass, false);
  assert.equal(difference(reference, reference, 'backends').pass, true);
  assert.throws(() => flip(reference, black), RangeError);
});

test('checkProbe runs what a probe has inputs for and fails a named check it cannot run', () => {
  const frame = sky(90, 160),
    rows = checkProbe({ name: 'opening', frame }, { reference: 0.05, lights: 1, glare: 2 });
  const byName = Object.fromEntries(rows.map((row) => [row.check, row]));
  for (const name of ['skyClip', 'grain', 'speckle', 'banding', 'flat', 'blocks', 'lights', 'crush']) assert.ok(byName[name], name);
  assert.equal(byName.reference.pass, false);
  assert.equal(byName.reference.missing, 'the 16-sample reference frame');
  assert.equal(byName.glare.pass, false);
  assert.match(byName.glare.missing, /a check named glare/);
  assert.equal(byName.foamEdges, undefined, 'not named and no foam mask: left out');
  const full = checkProbe(
    {
      name: 'full',
      frame,
      reference: frame,
      compat: frame,
      masks: { sky: mask(90, 160, (x, y) => y < 80), water: mask(90, 160, (x, y) => y >= 80), foam: mask(90, 160, () => false) },
      hdr: { width: 90, height: 160, data: new Float32Array(90 * 160 * 4) },
      viewProjection: viewProjection(0),
      still: [frame, frame, frame],
    },
    { lights: [1, 1] },
  );
  // The clean-frame checks that need their own inputs (look-clean.test.js) and the night checks a shot names are not in this probe.
  const needInputs = ['penumbra', 'shimmerMoving', 'motionBlur', 'silhouette', 'silhouetteShape', 'bounce', 'shadowTint', 'nightLuma', 'nightPeak'];
  assert.equal(full.length, Object.keys(LOOK_CHECKS).length - needInputs.length);
  assert.ok(full.every((row) => row.pass), full.filter((row) => !row.pass).map((row) => `${row.check} ${row.value}`).join(', '));
});

test('lookReport makes one table and one contact sheet, failures marked', async () => {
  const good = sky(90, 160),
    bad = sky(90, 160, [[0.3, 0.3], [0.7, 0.32]]),
    probes = [
      { name: 'opening', frame: good, results: checkProbe({ name: 'opening', frame: good, reference: good }) },
      { name: 'strike', frame: bad, results: checkProbe({ name: 'strike', frame: bad }) },
    ],
    report = lookReport(probes, { thumbWidth: 45, columns: 4 });
  assert.equal(report.pass, false);
  assert.equal(report.json.format, 'margo-look-report');
  assert.equal(report.json.probes[0].pass, true);
  assert.equal(report.json.probes[1].pass, false);
  assert.ok(!('map' in report.json.probes[0].results.find((row) => row.check === 'reference')));
  JSON.parse(JSON.stringify(report.json));
  // The doubled moon has a two pixel graded rim: stairs (T3) passes (it read 1.02 % when a step was judged against the
  // climb along one row, KB-LOOK-STAIRS-REAL1) and only the lights fail.
  assert.match(report.markdown, /^# Look checks\n\nFAIL: 2 probes, 1 failing check\(s\)\./);
  assert.match(report.markdown, /\| strike \| stairs \| 0 % \| 0 to 1 % \| pass \|/);
  assert.match(report.markdown, /\| strike \| lights \| 2 discs \| 0 to 1 discs \| \*\*FAIL\*\* \|/);
  // Three tiles (the opening, its FLIP map, the strike), each 45 wide plus border and gap.
  assert.equal(report.sheet.width, 3 * (45 + 6 + 8) + 8);
  const at = (x, y) => [...report.sheet.data.subarray((y * report.sheet.width + x) * 4, (y * report.sheet.width + x) * 4 + 3)];
  assert.deepEqual(at(8, 8), [46, 160, 67], 'the passing probe is framed green');
  assert.deepEqual(at(8 + 2 * (45 + 6 + 8), 8), [211, 47, 47], 'the failing probe is framed red');
  const png = await encodePNG(report.sheet);
  assert.deepEqual((await decodePNG(png)).data, report.sheet.data);
});

test('checkShot reads a shot tool manifest and its probe files', async () => {
  const frame = sky(90, 160),
    files = {
      'probes/opening.png': await encodePNG(frame),
      'probes/opening.sky.png': await encodePNG(image(90, 160, (x, y) => (y < 80 ? 255 : 0))),
      'probes/opening.ref.png': await encodePNG(frame),
      'probes/opening.rgba32f': new Uint8Array(new Float32Array(90 * 160 * 4).fill(0.25).buffer),
    },
    read = async (path) => {
      if (!(path in files)) throw new Error(`no file ${path}`);
      return files[path];
    },
    manifest = {
      id: 'storm-light-tour',
      header: { lookBounds: { lights: 1, nan: 0 } },
      probes: { opening: { frame: 0, file: 'probes/opening.png', aovs: { sky: 'probes/opening.sky.png' }, reference: 'probes/opening.ref.png', hdr: 'probes/opening.rgba32f' } },
    };
  const report = await checkShot({ manifest, read, thumbWidth: 45 });
  assert.equal(report.pass, true, report.markdown);
  assert.match(report.markdown, /^# Look checks: storm-light-tour/);
  const checks = report.json.probes[0].results.map((row) => row.check);
  assert.ok(checks.includes('nan') && checks.includes('reference') && checks.includes('skyClip'));
  await assert.rejects(checkShot({ manifest: { probes: {} }, read }), RangeError);
  await assert.rejects(checkShot({ manifest, read, signal: AbortSignal.abort() }), { name: 'AbortError' });
});
