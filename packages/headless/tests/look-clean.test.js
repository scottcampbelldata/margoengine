// The clean-frame checks T1 to T8 of the animated-feature look bar (roadmap section 3) on synthetic frames: each check
// fails the defect it exists for and passes the clean frame beside it, so a check that stops seeing its defect fails
// here. Every frame is built from a formula, so the numbers are the same every run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encodePNG } from '../dist/index.js';
import { decodePNG } from '../dist/compare.js';
import {
  GROUND_INSET,
  LOOK_CHECKS,
  LOOK_FAMILY_BOUNDS,
  LOOK_FAMILY_NAMES,
  banding,
  bounce,
  checkProbe,
  checkShot,
  chromaSmear,
  colourEdges,
  depthFromDistance,
  detailKeptFloor,
  familyBounds,
  motionBlur,
  nightLuma,
  nightPeak,
  penumbra,
  reprojectionMotion,
  shadowTint,
  shimmerMoving,
  silhouette,
  silhouetteShape,
  stairs,
} from '../dist/look.js';

const image = (width, height, colour) => {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const c = typeof colour === 'function' ? colour(x, y) : colour,
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
const mix = (a, b, t) =>
  typeof a === 'number' ? Math.round(a + (b - a) * t) : a.map((v, i) => Math.round(v + (b[i] - v) * t));
/** A frame split by the diagonal line x = y + 8: hard (a pixel is one side or the other) or resolved (4 x 4 coverage). */
const diagonal = (a, b, resolved, size = 64) =>
  image(size, size, (x, y) => {
    if (!resolved) return x > y + 8 ? b : a;
    let inside = 0;
    for (let sy = 0; sy < 4; sy++)
      for (let sx = 0; sx < 4; sx++) if (x + (sx + 0.5) / 4 > y + (sy + 0.5) / 4 + 8) inside++;
    return mix(a, b, inside / 16);
  });
const noise = (seed) => () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 32;
};

test('T3 stairs: a hard diagonal edge is all stair steps, a resolved one and a straight edge have none', () => {
  const hard = stairs(diagonal(30, 220, false)),
    resolved = stairs(diagonal(30, 220, true)),
    straight = stairs(image(64, 64, (x) => (x < 32 ? 30 : 220)));
  assert.ok(hard.value > 50, `hard ${hard.value}`);
  assert.equal(hard.pass, false);
  assert.ok(resolved.value <= 1 && resolved.pass, `resolved ${resolved.value}`);
  assert.equal(straight.value, 0, 'an axis aligned edge on a pixel boundary is one clean step, not a stair');
  assert.ok(straight.detail.edges > 0);
  assert.deepEqual(stairs(diagonal(30, 220, false), { bound: [0, 100] }).bound, [0, 100]);
});

/** An edge y = slope x + offset with exact area coverage (16 x 16 samples per pixel) or one sample at the pixel centre. */
const sloped = (a, b, slope, offset, resolved, size = 96) =>
  image(size, size, (x, y) => {
    if (!resolved) return y + 0.5 > slope * (x + 0.5) + offset ? b : a;
    let inside = 0;
    for (let sy = 0; sy < 16; sy++)
      for (let sx = 0; sx < 16; sx++) if (y + (sy + 0.5) / 16 > slope * (x + (sx + 0.5) / 16) + offset) inside++;
    return mix(a, b, inside / 256);
  });

test('T3 stairs: an edge near a pixel axis, resolved to exact coverage, is not a stair at any slope', () => {
  // Near an axis a resolved edge has one pixel of partial coverage per row, and that coverage can be 0.05 or 0.95: the
  // step to the plateau is nine tenths of the climb along the row, which the check once counted as a stair step.
  for (const slope of [0.04, 0.07, 0.13, 0.31, 0.5, 1, 2.3, 7.5, 14]) {
    const steep = slope > 1,
      resolved = steep
        ? stairs(sloped(30, 220, 1 / slope, -10 / slope + 1, true))
        : stairs(sloped(30, 220, slope, 20, true)),
      hard = steep
        ? stairs(sloped(30, 220, 1 / slope, -10 / slope + 1, false))
        : stairs(sloped(30, 220, slope, 20, false));
    assert.ok(
      resolved.value <= 1 && resolved.pass,
      `slope ${slope} resolved ${resolved.value} of ${resolved.detail.edges} edges`,
    );
    assert.ok(hard.detail.edges > 0, `slope ${slope} has edges`);
    assert.ok(hard.value > 5 && !hard.pass, `slope ${slope} one sample per pixel ${hard.value}`);
  }
});

const realFrame = async (name) =>
  decodePNG(new Uint8Array(readFileSync(new URL(`./fixtures/look-real/${name}`, import.meta.url))));

test('T3 stairs on real engine frames: the supersampled render and its 16 sample reference pass, one sample per pixel fails', async () => {
  // One 400 x 400 crop (lantern railing, cottage, wet cliff) of the storm-light shot, rendered three ways by the shot
  // tool at 720 x 1280: msaa 1 supersample 1, msaa 4 supersample 2 (the film setting), and a 1440 x 2560 render at
  // supersample 2 area-averaged to 720 x 1280 in linear light (16 samples per pixel). Texture detail, thin railings and
  // wave crests used to read 14 to 19% on the two resolved frames.
  const [one, film, reference] = await Promise.all(
    ['storm-1sample.png', 'storm-ss2.png', 'storm-16sample.png'].map(realFrame),
  );
  const read = (frame) => stairs(frame);
  assert.ok(read(reference).value <= 1, `16 sample reference ${read(reference).value}`);
  assert.ok(read(film).value <= 1, `msaa 4 supersample 2 ${read(film).value}`);
  assert.ok(read(one).value > 3 && !read(one).pass, `one sample per pixel ${read(one).value}`);
  assert.ok(read(reference).detail.edges > 1000, 'the crop holds real edges');
  // Banding (T2) never misread these: real probes read 0 to 0.1 % against the 1 % bound, and the film frame holds the 0.2 % of the family.
  assert.ok(banding(film).value <= 0.2, `banding ${banding(film).value}`);
});

test('T7 colour edges: a one pixel colour edge fails, one resolved over two or more pixels passes', () => {
  const red = [200, 40, 30],
    green = [40, 170, 60],
    hard = colourEdges(diagonal(red, green, false)),
    resolved = colourEdges(diagonal(red, green, true));
  assert.ok(hard.value > 50, `hard ${hard.value}`);
  assert.equal(hard.pass, false);
  assert.ok(resolved.value <= 10 && resolved.pass, `resolved ${resolved.value}`);
  assert.equal(colourEdges(image(32, 32, 120)).value, 0, 'a grey frame has no colour edge');
});

test('T1 penumbra: grain inside the penumbra mask is held to 0.7 codes, and only inside it', () => {
  const rand = noise(7),
    quiet = image(48, 48, 120),
    grainy = image(48, 48, (x, y) => (x < 24 ? 120 : Math.round(120 + (rand() - 0.5) * 6))),
    left = mask(48, 48, (x) => x < 24),
    right = mask(48, 48, (x) => x >= 24);
  assert.ok(penumbra(quiet, { mask: left }).pass);
  assert.ok(penumbra(grainy, { mask: left }).pass, 'the grain is outside the mask');
  const noisy = penumbra(grainy, { mask: right });
  assert.equal(noisy.check, 'penumbra');
  assert.equal(noisy.pass, false, `grain ${noisy.value}`);
  assert.deepEqual(noisy.bound, [0, 0.7]);
});

const translate = (tx) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, tx, 0, 0, 1];
const identity = translate(0);
const pattern = (x, y) => 128 + 90 * Math.sin(x * 0.35) * Math.cos(y * 0.3);

const perspective = (fov, aspect, near, far) => {
  const f = 1 / Math.tan(fov / 2),
    m = new Array(16).fill(0);
  Object.assign(m, { 0: f / aspect, 5: f, 10: far / (near - far), 11: -1, 14: (near * far) / (near - far) });
  return m;
};
const multiply = (a, b) => {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return out;
};

test('depthFromDistance and reprojectionMotion: a camera moved sideways shifts a pixel by the disparity of its distance', () => {
  const width = 65,
    height = 33,
    near = 0.1,
    far = 500,
    projection = perspective(1.0, width / height, near, far),
    eye = [0, 0, 0],
    centre = 16 * width + 32,
    distance = new Float32Array(width * height).fill(20);
  distance[centre] = 8;
  distance[0] = Number.NaN;
  distance[1] = 0;
  const depth = depthFromDistance(distance, eye, projection, width, height);
  // The centre pixel looks down the axis, so its distance is its depth: z = far (d - near) / ((far - near) d).
  assert.ok(Math.abs(depth[centre] - (far * (8 - near)) / ((far - near) * 8)) < 1e-6, 'centre depth ' + depth[centre]);
  assert.ok(Number.isNaN(depth[0]) && Number.isNaN(depth[1]), 'no distance, no depth');
  // The camera moves 0.5 m to its right: the world moves -0.5 m in x in its view.
  const moved = multiply(
      projection,
      translate(-0.5).map((v, i) => v),
    ),
    motion = reprojectionMotion(depth, projection, moved, width, height),
    expected = (d) => ((-0.5 * (1 / Math.tan(0.5))) / (width / height) / d) * (width / 2);
  assert.ok(
    Math.abs(motion.data[centre * 2] - expected(8)) < 1e-2,
    'centre ' + motion.data[centre * 2] + ' against ' + expected(8),
  );
  assert.ok(Math.abs(motion.data[centre * 2 + 1]) < 1e-3);
  // A near pixel moves more than a far one.
  assert.ok(Math.abs(motion.data[(16 * width + 40) * 2]) < Math.abs(motion.data[centre * 2]));
  assert.throws(() => depthFromDistance(new Float32Array(3), eye, projection, width, height), RangeError);
  assert.throws(() => depthFromDistance(distance, [0, 0], projection, width, height), RangeError);
  assert.throws(() => depthFromDistance(distance, eye, new Array(16).fill(0), width, height), RangeError);
});

test('depthFromDistance: pixels with no distance meet the sea plane where the water mask is, and are far away where it is not', () => {
  const width = 33,
    height = 33,
    projection = perspective(1.0, 1, 0.1, 2000),
    view = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -2, 0, 1],
    vp = multiply(projection, view),
    eye = [0, 2, 0],
    nothing = new Float32Array(width * height),
    water = new Uint8Array(width * height).fill(255),
    wet = depthFromDistance(nothing, eye, vp, width, height, { water, plane: 0, far: 1000 }),
    dry = depthFromDistance(nothing, eye, vp, width, height, { far: 1000 }),
    bare = depthFromDistance(nothing, eye, vp, width, height);
  assert.ok(bare.every(Number.isNaN), 'no options, no depth');
  // The ray 45 degrees below the horizon (the bottom edge of a 1 radian view is lower; use the row that looks down
  // at tan = 2 / 8) meets y = 0 at distance sqrt(8^2 + 2^2) along it.
  const row = 16 + 6, // below the centre row
    lookDown = Math.tan(1.0 / 2) * ((row + 0.5 - 16.5) / 16.5),
    t = 2 / lookDown, // the ray meets the plane at depth t along -z
    wetDepth = wet[row * width + 16],
    expected = (2000 * (t - 0.1)) / ((2000 - 0.1) * t);
  assert.ok(Math.abs(wetDepth - expected) < 1e-4, 'sea depth ' + wetDepth + ' against ' + expected);
  // Above the horizon the ray never meets the sea: the far distance.
  const above = (16 - 6) * width + 16;
  assert.ok(wet[above] > 0.99 && Math.abs(wet[above] - dry[above]) < 1e-7, 'sky ' + wet[above]);
  assert.ok(dry[row * width + 16] > 0.99, 'with no water mask the sea is far');
});

test('detailKeptFloor: 0.5 for the natural look and 0.6 for the animated feature family', () => {
  assert.equal(detailKeptFloor(), 0.5);
  assert.equal(detailKeptFloor(null), 0.5);
  assert.equal(detailKeptFloor('natural'), 0.5);
  assert.equal(detailKeptFloor('animatedFeature'), 0.6);
  assert.throws(() => detailKeptFloor('cartoon'), RangeError);
});

test('T4 shimmerMoving: the camera motion undone leaves 0, a flickering surface or a missed motion fails', () => {
  const width = 64,
    height = 48,
    shift = 3,
    frame = image(width, height, (x, y) => pattern(x, y)),
    next = image(width, height, (x, y) => pattern(x - shift, y)),
    depth = new Float32Array(width * height).fill(0),
    motion = reprojectionMotion(depth, identity, translate((2 * shift) / width), width, height);
  assert.ok(Math.abs(motion.data[0] - shift) < 1e-4 && Math.abs(motion.data[1]) < 1e-4, `motion ${motion.data[0]}`);
  const clean = shimmerMoving(frame, { next, motion });
  assert.equal(clean.value, 0, `clean ${clean.value}`);
  assert.ok(clean.pass);
  const rand = noise(3),
    flicker = image(width, height, (x, y) => pattern(x - shift, y) + (rand() - 0.5) * 60),
    bad = shimmerMoving(frame, { next: flicker, motion });
  assert.ok(bad.value > 5 && !bad.pass, `flicker ${bad.value}`);
  const still = { width, height, data: new Float32Array(width * height * 2) },
    missed = shimmerMoving(frame, { next, motion: still });
  assert.ok(missed.value > 5 && !missed.pass, `missed ${missed.value}`);
  assert.throws(
    () => shimmerMoving(frame, { next, motion: { width: 8, height: 8, data: new Float32Array(128) } }),
    RangeError,
  );
  assert.throws(() => reprojectionMotion(depth, new Array(16).fill(0), identity, width, height), RangeError);
});

test('T4 reprojectionMotion: a nearer pixel moves more than a farther one under a sideways camera', () => {
  // A perspective camera: the same sideways step moves the near surface more pixels than the far one.
  const f = 1,
    near = 0.1,
    far = 100,
    persp = (tx) => [f, 0, 0, 0, 0, f, 0, 0, 0, 0, far / (near - far), -1, tx * f, 0, (near * far) / (near - far), 0],
    zNdc = (d) => ((far / (near - far)) * -d + (near * far) / (near - far)) / d,
    width = 8,
    height = 8,
    depth = Float32Array.from({ length: width * height }, (_, i) => zNdc(i % 2 ? 40 : 2)),
    motion = reprojectionMotion(depth, persp(0), persp(-0.5), width, height),
    nearMove = Math.abs(motion.data[0]),
    farMove = Math.abs(motion.data[2]);
  assert.ok(nearMove > farMove * 5, `${nearMove} against ${farMove}`);
});

test('T8 motionBlur: a sharp mover fails and one smeared across its travel passes', () => {
  const width = 96,
    height = 24,
    travel = 12,
    motion = { width, height, data: new Float32Array(width * height * 2) };
  for (let i = 0; i < width * height; i++) motion.data[i * 2] = travel;
  // A bar 24 wide from x = 30: sharp edges, or edges ramped over the whole travel (a 180 degree shutter's smear).
  const sharp = image(width, height, (x) => (x >= 30 && x < 54 ? 220 : 30)),
    ramp = (x) => Math.min(1, Math.max(0, x / travel)),
    smeared = image(width, height, (x) => Math.round(30 + 190 * Math.min(ramp(x - 30), 1 - ramp(x - 54)))),
    bad = motionBlur(sharp, motion),
    good = motionBlur(smeared, motion);
  assert.ok(bad.detail.edges > 0 && bad.value === 100 && !bad.pass, `sharp ${bad.value} of ${bad.detail.edges}`);
  assert.ok(good.detail.edges > 0 && good.value === 0 && good.pass, `smeared ${good.value} of ${good.detail.edges}`);
  const slow = { width, height, data: new Float32Array(width * height * 2).fill(2) };
  assert.equal(motionBlur(sharp, slow).detail.edges, 0, 'a mover under 8 pixels a frame is not judged');
});

const disc = (size, r, subjectColour, backColour) => {
  const inside = (x, y) => Math.hypot(x - size / 2, y - size / 2) < r;
  return {
    frame: image(size, size, (x, y) => (inside(x, y) ? subjectColour : backColour)),
    subject: mask(size, size, inside),
  };
};

test('T5 silhouette: a dark subject on pale haze has a clear outline, a subject close to its background has none', () => {
  const clear = disc(80, 20, [20, 22, 28], [200, 205, 210]),
    muddy = disc(80, 20, [120, 120, 120], [128, 128, 128]),
    good = silhouette(clear.frame, { subject: clear.subject }),
    bad = silhouette(muddy.frame, { subject: muddy.subject });
  assert.equal(good.value, 100);
  assert.ok(good.pass);
  assert.equal(bad.value, 0);
  assert.equal(bad.pass, false);
  assert.ok(good.detail.outline > 40);
});

test('T5 silhouetteShape: one value reads as one shape, three bands do not', () => {
  const size = 80,
    inside = (x, y) => Math.hypot(x - 40, y - 40) < 28,
    subject = mask(size, size, inside),
    one = image(size, size, (x, y) => (inside(x, y) ? 40 : 220)),
    bands = image(size, size, (x, y) =>
      inside(x, y) ? ([10, 120, 220][Math.min(2, Math.floor((y - 12) / 19))] ?? 10) : 250,
    ),
    good = silhouetteShape(one, { subject }),
    bad = silhouetteShape(bands, { subject });
  assert.equal(good.value, 100);
  assert.ok(good.pass);
  assert.ok(bad.value < 70 && !bad.pass, `bands ${bad.value}`);
});

test('T6 bounce and shadowTint: shadow holds 10 to 35 percent of the lit ground and runs cooler', () => {
  const size = 64,
    lit = mask(size, size, (x) => x < 32),
    shadow = mask(size, size, (x) => x >= 32),
    ground = (litColour, shadowColour) => image(size, size, (x) => (x < 32 ? litColour : shadowColour)),
    rich = ground([230, 200, 150], [96, 100, 118]),
    crushed = ground([230, 200, 150], [4, 4, 6]),
    flatLit = ground([230, 200, 150], [225, 195, 145]);
  const ok = bounce(rich, { lit, shadow });
  assert.ok(ok.pass, `rich ${ok.value}`);
  assert.ok(ok.value >= 10 && ok.value <= 35);
  assert.equal(bounce(crushed, { lit, shadow }).pass, false, 'crushed shadow');
  assert.equal(bounce(flatLit, { lit, shadow }).pass, false, 'shadow as bright as the sun');
  const cool = shadowTint(rich, { lit, shadow });
  assert.ok(cool.pass && cool.value >= 3, `cool ${cool.value}`);
  assert.equal(shadowTint(flatLit, { lit, shadow }).pass, false, 'a shadow of the same hue');
  const empty = bounce(rich, { lit: mask(size, size, () => false), shadow });
  assert.equal(empty.pass, false);
  assert.match(empty.missing, /lit and shadowed ground/);
});

test('T6 bounce and shadowTint read the ground masks inside their edges, where the frame mixes both sides', () => {
  // KB-LOOK-TV-BOUNCE1: the timber-valley rail-line shot read bounce 146 percent (calm, 1080p) because its shadows
  // are strips a few pixels wide between plants, and the frame, resolved from supersamples with motion blur, gives
  // a strip's edge pixels the lit ground's light while the sharp mask still calls them shadow. Here: 9-pixel shadow
  // strips across lit ground, blurred by a 5 x 5 box (2 pixels each way) as a resolve and blur would.
  const size = 720,
    sun = [200, 180, 140],
    shade = [96, 92, 100],
    strip = (x) => x >= 360 && x % 40 < 9,
    lit = mask(size, size, (x) => !strip(x)),
    shadow = mask(size, size, (x) => strip(x)),
    sharp = image(size, size, (x) => (strip(x) ? shade : sun)),
    blurred = image(size, size, (x, y) => {
      const sum = [0, 0, 0];
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const i = (Math.min(size - 1, Math.max(0, y + dy)) * size + Math.min(size - 1, Math.max(0, x + dx))) * 4;
          for (let c = 0; c < 3; c++) sum[c] += sharp.data[i + c];
        }
      return sum.map((v) => Math.round(v / 25));
    }),
    truth = bounce(sharp, { lit, shadow }),
    seen = bounce(blurred, { lit, shadow }),
    tint = shadowTint(blurred, { lit, shadow });
  assert.ok(truth.pass, `sharp ${truth.value}`);
  // 720 pixels: an inset of 2, the blur's reach, so the strips' interiors are pure shadow again.
  assert.ok(Math.abs(seen.value - truth.value) < 0.5, `blurred ${seen.value}, sharp ${truth.value}`);
  assert.ok(seen.pass, `blurred ${seen.value}`);
  assert.ok(Math.abs(tint.value - shadowTint(sharp, { lit, shadow }).value) < 0.5, `tint ${tint.value}`);
  assert.equal(GROUND_INSET, 1 / 360);
  // A shadow no wider than the inset has no interior: nothing to measure, not a pass.
  const thin = mask(size, size, (x) => x >= 360 && x % 40 < 4),
    none = bounce(blurred, { lit, shadow: thin });
  assert.equal(none.pass, false);
  assert.match(none.missing, /lit and shadowed ground/);
});

test('T7 night: a night that reads on a phone has a mean luma of 24 and lights over 180', () => {
  const rand = noise(11),
    dark = image(64, 64, 10),
    reads = image(64, 64, (x, y) => (y < 2 ? 230 : 40 + Math.round(rand() * 4))),
    low = nightLuma(dark),
    fine = nightLuma(reads);
  assert.ok(!low.pass && fine.pass, `${low.value} ${fine.value}`);
  assert.equal(nightPeak(dark).pass, false);
  assert.equal(nightPeak(reads).pass, true);
  assert.ok(nightPeak(reads).value > 180);
});

test('look families: animatedFeature holds the T bounds, natural keeps every default, an unknown name throws', () => {
  assert.deepEqual(LOOK_FAMILY_NAMES, ['natural', 'animatedFeature']);
  assert.deepEqual(familyBounds('natural'), {});
  const bounds = familyBounds('animatedFeature');
  assert.deepEqual(bounds.grain, [0, 0.5]);
  assert.deepEqual(bounds.speckle, [0, 5]);
  assert.deepEqual(bounds.banding, [0, 0.2]);
  assert.deepEqual(bounds.shimmer, [0, 0.1]);
  assert.deepEqual(bounds.flicker, [0, 0.3]);
  assert.deepEqual(bounds.shimmerMoving, [0, 0.5]);
  assert.deepEqual(bounds.silhouette, [80, 100]);
  assert.deepEqual(bounds.silhouetteShape, [70, 100]);
  assert.deepEqual(bounds.bounce, [10, 35]);
  assert.deepEqual(bounds.shadowTint, [3, 100]);
  assert.deepEqual(bounds.crush, [0, 0.1]);
  assert.deepEqual(bounds.reference, [0, 0.04]);
  for (const name of Object.keys(bounds)) assert.ok(name in LOOK_CHECKS, name);
  bounds.grain[0] = 9;
  assert.deepEqual(LOOK_FAMILY_BOUNDS.animatedFeature.grain, [0, 0.5], 'the table is frozen: a copy is returned');
  assert.throws(() => familyBounds('cinematic'), RangeError);
  assert.throws(() => checkProbe({ name: 'p', frame: image(8, 8, 9) }, {}, { family: 'cinematic' }), RangeError);
});

test('checkProbe with a family: its bounds apply to the checks that can run, a shot bound wins, a named check still needs its input', () => {
  const rand = noise(5),
    size = 64,
    frame = image(size, size, (x, y) => Math.round(120 + (rand() - 0.5) * 4 + y * 0.1)),
    byName = (rows) => Object.fromEntries(rows.map((row) => [row.check, row])),
    natural = byName(checkProbe({ name: 'p', frame }, {})),
    family = byName(checkProbe({ name: 'p', frame }, {}, { family: 'animatedFeature' }));
  assert.equal(natural.grain.pass, true, `grain ${natural.grain.value}`);
  assert.deepEqual(family.grain.bound, [0, 0.5]);
  assert.equal(family.grain.pass, false, 'the family holds grain to 0.5 codes');
  assert.equal(family.silhouette, undefined, 'no subject mask: the family does not make the check a failure');
  assert.equal(family.bounce, undefined);
  assert.ok(family.stairs && family.colourEdges);
  const own = byName(checkProbe({ name: 'p', frame }, { grain: 3 }, { family: 'animatedFeature' }));
  assert.deepEqual(own.grain.bound, [-Infinity, 3], "the shot's own bound replaces the family's");
  const named = byName(
    checkProbe({ name: 'p', frame }, { silhouette: [80, 100], shimmerMoving: 1 }, { family: 'animatedFeature' }),
  );
  assert.equal(named.silhouette.pass, false);
  assert.equal(named.silhouette.missing, 'the subject mask');
  assert.equal(named.shimmerMoving.missing, 'the next frame and its motion');
  const night = byName(checkProbe({ name: 'p', frame }, { nightLuma: [24, 255], nightPeak: [180, 255] }));
  assert.ok(night.nightLuma.pass && !night.nightPeak.pass);
  assert.equal(natural.nightLuma, undefined, 'night checks run only when a shot names them');
});

test('checkProbe does not run a mask check on a mask that marks no pixel (KB-LOOK-EMPTYMASK1)', () => {
  // A landscape with no subject in frame and no penumbra: an empty subject mask read 0 % silhouette (a failure) and an
  // empty penumbra mask 0 codes of grain (a pass), though neither had anything to measure.
  const size = 64,
    frame = image(size, size, (x, y) => [80 + x, 90 + y, 70]),
    empty = mask(size, size, () => false),
    half = mask(size, size, (x) => x < 32),
    byName = (rows) => Object.fromEntries(rows.map((row) => [row.check, row])),
    rows = byName(
      checkProbe(
        { name: 'p', frame, masks: { subject: empty, penumbra: empty, lit: half, shadow: empty } },
        {},
        { family: 'animatedFeature' },
      ),
    );
  for (const check of ['silhouette', 'silhouetteShape', 'penumbra', 'bounce', 'shadowTint'])
    assert.equal(rows[check], undefined, `${check} does not run on an empty mask`);
  assert.ok(rows.stairs, 'the checks with their inputs still run');
  const named = byName(checkProbe({ name: 'p', frame, masks: { subject: empty } }, { silhouette: [80, 100] }));
  assert.equal(named.silhouette.pass, false, 'a shot that names the check fails it as missing');
  assert.equal(named.silhouette.missing, 'subject pixels (the subject mask is empty)');
});

test('checkProbe runs every clean-frame check once its inputs are there', () => {
  const size = 64,
    { frame, subject } = disc(size, 20, [20, 22, 28], [200, 205, 210]),
    motion = { width: size, height: size, data: new Float32Array(size * size * 2) },
    rows = checkProbe(
      {
        name: 'all',
        frame,
        masks: {
          subject,
          penumbra: mask(size, size, (x) => x < 8),
          lit: mask(size, size, (x) => x > 56),
          shadow: subject,
        },
        moving: { next: frame, motion },
      },
      { nightLuma: 0, nightPeak: 0 },
    ),
    names = rows.map((row) => row.check);
  for (const name of [
    'penumbra',
    'stairs',
    'colourEdges',
    'shimmerMoving',
    'motionBlur',
    'silhouette',
    'silhouetteShape',
    'bounce',
    'shadowTint',
    'nightLuma',
    'nightPeak',
  ])
    assert.ok(names.includes(name), name);
});

test('checkShot reads lookFamily from the manifest header and a probe moving pair of files', async () => {
  const rand = noise(9),
    size = 48,
    frame = image(size, size, (x, y) => Math.round(120 + (rand() - 0.5) * 4 + y * 0.1)),
    next = image(size, size, (x, y) => 120 + y * 0.1),
    motion = new Float32Array(size * size * 2),
    files = {
      'probes/a.png': await encodePNG(frame),
      'probes/a.next.png': await encodePNG(next),
      'probes/a.motion.f32': new Uint8Array(motion.buffer),
    },
    read = async (path) => files[path] ?? Promise.reject(new Error(`no file ${path}`)),
    probes = {
      a: { frame: 0, file: 'probes/a.png', moving: { next: 'probes/a.next.png', motion: 'probes/a.motion.f32' } },
    },
    rowsOf = (report) => Object.fromEntries(report.json.probes[0].results.map((row) => [row.check, row])),
    plain = rowsOf(await checkShot({ manifest: { probes }, read, thumbWidth: 32 })),
    family = rowsOf(
      await checkShot({ manifest: { header: { lookFamily: 'animatedFeature' }, probes }, read, thumbWidth: 32 }),
    ),
    own = rowsOf(
      await checkShot({
        manifest: { header: { lookFamily: 'animatedFeature', lookBounds: { grain: 3 } }, probes },
        read,
        thumbWidth: 32,
      }),
    );
  assert.ok(plain.shimmerMoving && plain.motionBlur, 'the moving pair ran');
  assert.equal(plain.grain.pass, true);
  assert.equal(family.grain.pass, false);
  assert.equal(family.shimmerMoving.value >= 0, true);
  assert.equal(own.grain.pass, true, "the shot's lookBounds replace the family's");
  const short = { ...files, 'probes/a.motion.f32': new Uint8Array(8) };
  await assert.rejects(checkShot({ manifest: { probes }, read: async (p) => short[p] }), RangeError);
  await assert.rejects(checkShot({ manifest: { header: { lookFamily: 'cinematic' }, probes }, read }), RangeError);
});

test('T7 chroma smear: one pixel colour stripes move visibly at 4:2:0, flat and smooth colour do not', () => {
  const red = [200, 40, 30],
    green = [40, 170, 60],
    stripes = chromaSmear(image(64, 64, (x) => ((x & 1) === 0 ? red : green))),
    wide = chromaSmear(image(64, 64, (x) => (((x >> 3) & 1) === 0 ? red : green))),
    flat = chromaSmear(image(64, 64, red)),
    ramp = chromaSmear(image(64, 64, (x) => mix(red, green, x / 63)));
  assert.ok(stripes.value > 80 && !stripes.pass, `stripes ${stripes.value}`);
  assert.ok(
    wide.value > 10 && wide.value < 25,
    `eight pixel stripes ${wide.value}: only the pixels beside each hard edge move`,
  );
  assert.equal(flat.value, 0);
  assert.equal(ramp.value, 0, 'a smooth ramp survives');
  assert.equal(stripes.detail.pixels, 64 * 64);
  const half = chromaSmear(
    image(64, 64, (x) => ((x & 1) === 0 ? red : green)),
    { mask: mask(64, 64, (x) => x < 32) },
  );
  assert.equal(half.detail.pixels, 64 * 32);
});
