// The clean-frame checks T1 to T8 of the animated-feature look bar (roadmap section 3) on synthetic frames: each check
// fails the defect it exists for and passes the clean frame beside it, so a check that stops seeing its defect fails
// here. Every frame is built from a formula, so the numbers are the same every run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encodePNG } from '../dist/index.js';
import { decodePNG } from '../dist/compare.js';
import {
  GROUND_ALBEDO_LEVELS,
  GROUND_BLOCK,
  GROUND_MIN_PIXELS,
  GROUND_INSET,
  albedoOf,
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
  PENUMBRA_MIN_PIXELS,
  penumbra,
  penumbraPlants,
  reprojectionMotion,
  CLEAR_SUN_DIFFUSE,
  erbsDiffuseFraction,
  lightBounds,
  shadowTint,
  groundSample,
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
// T6 compares lit and shadowed ground within blocks a tenth of the frame's shorter side (GROUND_BLOCK): its ground
// fixtures are 60 pixels wide, 6 pixel blocks, with lit and shadowed stripes 3 pixels wide so each block holds both.
const litStripe = (x) => x % 6 < 3;
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
  // 96 x 96, so each half's interior (46 x 94) holds at least PENUMBRA_MIN_PIXELS.
  const rand = noise(7),
    quiet = image(96, 96, 120),
    grainy = image(96, 96, (x, y) => (x < 48 ? 120 : Math.round(120 + (rand() - 0.5) * 6))),
    left = mask(96, 96, (x) => x < 48),
    right = mask(96, 96, (x) => x >= 48);
  assert.ok(penumbra(quiet, { mask: left }).pass);
  assert.ok(penumbra(grainy, { mask: left }).pass, 'the grain is outside the mask');
  const noisy = penumbra(grainy, { mask: right });
  assert.equal(noisy.check, 'penumbra');
  assert.equal(noisy.pass, false, `grain ${noisy.value}`);
  assert.deepEqual(noisy.bound, [0, 0.7]);
});

// KB-LOOK-TV-PENUMBRA2. Foliage texture detail is not shadow noise: Immerkaer's estimator reads a plant's own leaves
// as grain, so T1 reads the penumbra on the ground (the plants mask left out) and holds the plants in the penumbra to
// the grain of the plants out of it in the same frame. A 128 x 128 frame: flat ground on the left, plants with a fixed
// leaf texture (+-4 codes, its grain about 2.3) on the right, the penumbra over the top half, where the light is 0.8.
const leaves = (() => {
  const rand = noise(11),
    t = new Float32Array(128 * 128);
  for (let i = 0; i < t.length; i++) t[i] = (rand() - 0.5) * 8;
  return t;
})();
const plantScene = ({ groundNoise = 0, plantNoise = 0 } = {}) => {
  const rand = noise(23);
  return {
    frame: image(128, 128, (x, y) => {
      const light = y < 64 ? 0.8 : 1,
        jitter = (rand() - 0.5) * 2;
      if (x < 64) return Math.round(100 * light + (y < 64 ? groundNoise * jitter : 0));
      return Math.round((100 + leaves[y * 128 + x]) * light + (y < 64 ? plantNoise * jitter : 0));
    }),
    penumbra: mask(128, 128, (x, y) => y < 64),
    plants: mask(128, 128, (x) => x >= 64),
  };
};

test('regression KB-LOOK-TV-PENUMBRA2: T1 reads the penumbra on the ground, and the plants against their own detail', () => {
  const clean = plantScene();
  // Before the fix the check read the whole penumbra mask, the plants' leaves with it: a false failure.
  const whole = penumbra(clean.frame, { mask: clean.penumbra });
  assert.equal(whole.pass, false, `the leaves read as grain: ${whole.value}`);
  const ground = penumbra(clean.frame, { mask: clean.penumbra, plants: clean.plants });
  assert.ok(ground.pass && ground.value < 0.1, `clean ground ${ground.value}`);
  assert.ok(ground.detail.pixels >= PENUMBRA_MIN_PIXELS);
  const leaf = penumbraPlants(clean.frame, clean);
  assert.equal(leaf.check, 'penumbraPlants');
  assert.ok(leaf.pass && leaf.value < 0.9, `clean plants ${leaf.value} (${JSON.stringify(leaf.detail)})`);
  assert.deepEqual(leaf.bound, [0, 1]);

  // Shadow-filter noise on the ground in the penumbra fails the ground check.
  const noisyGround = plantScene({ groundNoise: 3 });
  const g = penumbra(noisyGround.frame, { mask: noisyGround.penumbra, plants: noisyGround.plants });
  assert.equal(g.pass, false, `ground noise ${g.value}`);
  assert.ok(penumbraPlants(noisyGround.frame, noisyGround).pass, 'the plants are untouched');

  // The same noise on the plants in the penumbra passes the ground check and fails the plants check.
  const noisyPlants = plantScene({ plantNoise: 4 });
  assert.ok(penumbra(noisyPlants.frame, { mask: noisyPlants.penumbra, plants: noisyPlants.plants }).pass);
  const p = penumbraPlants(noisyPlants.frame, noisyPlants);
  assert.equal(p.pass, false, `plant noise ${p.value} (${JSON.stringify(p.detail)})`);
  assert.ok(p.value > 1.1, `plant noise ${p.value}`);
});

test('T1 penumbra and penumbraPlants need PENUMBRA_MIN_PIXELS interior pixels, so a sliver cannot pass', () => {
  assert.equal(PENUMBRA_MIN_PIXELS, 2055);
  const { frame, plants } = plantScene(),
    sliver = mask(128, 128, (x, y) => y < 6);
  const ground = penumbra(frame, { mask: sliver, plants });
  assert.equal(ground.pass, false);
  assert.ok(Number.isNaN(ground.value) && /2055 interior pixels/.test(ground.missing), ground.missing);
  const leaf = penumbraPlants(frame, { penumbra: sliver, plants });
  assert.equal(leaf.pass, false);
  assert.match(leaf.missing, /plants in the penumbra/);
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
  // A bar 24 wide from x = 30: sharp edges, or edges ramped over the whole travel (a 360 degree shutter's smear).
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

// KB-LOOK-TV-MOTIONBLUR1: a 180 degree shutter is open for half the frame interval, so a frame drawn from sub-frames
// over it smears an edge across half its travel to the next frame. The check took the whole travel as the smear and
// read the rail-line shot's correctly blurred frames (8 sub-frames, 180 degrees) as 60.5 and 46.5 percent sharp.
test('T8 motionBlur: a frame drawn from sub-frames over a 180 degree shutter passes, and the angle is the shot`s', () => {
  const width = 128,
    height = 24,
    travel = 24,
    motion = { width, height, data: new Float32Array(width * height * 2) };
  for (let i = 0; i < width * height; i++) motion.data[i * 2] = travel;
  // The bar [40, 72) drawn at each sub-frame's time ((k + 0.5) / n of the open shutter), each pixel its area's share.
  const exposed = (shutter, subframes = 8) =>
    image(width, height, (x) => {
      let cover = 0;
      for (let k = 0; k < subframes; k++) {
        const o = ((k + 0.5) / subframes) * (shutter / 360) * travel;
        cover += Math.max(0, Math.min(x + 1, 72 + o) - Math.max(x, 40 + o));
      }
      return Math.round(30 + 190 * (cover / subframes));
    });
  const film = motionBlur(exposed(180), motion);
  assert.ok(
    film.detail.edges > 0 && film.value === 0 && film.pass,
    `180 degrees: ${film.value} of ${film.detail.edges}`,
  );
  const strobe = motionBlur(exposed(180, 1), motion);
  assert.ok(
    strobe.detail.edges > 0 && strobe.value === 100,
    `one sub-frame: ${strobe.value} of ${strobe.detail.edges}`,
  );
  // A 90 degree frame smears a quarter of the travel: sharp against the 180 degree standard, clean at its own angle.
  assert.equal(motionBlur(exposed(90), motion).value, 100);
  assert.equal(motionBlur(exposed(90), motion, { shutter: 90 }).value, 0);
  for (const shutter of [0, -10, 400, Number.NaN])
    assert.throws(() => motionBlur(exposed(180), motion, { shutter }), RangeError, `${shutter}`);
  // checkProbe judges a moving probe at the shutter it names.
  const probe = (shutter) => ({
      name: 'p',
      frame: exposed(90),
      moving: { next: exposed(90), motion, shutter },
    }),
    row = (shutter) => checkProbe(probe(shutter), {}).find((r) => r.check === 'motionBlur');
  assert.equal(row(undefined).value, 100);
  assert.equal(row(90).value, 0);
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

test('T6 counts only ground its masks cover whole, over the pixel and the shutter (KB-SHOT-SHUTTERMASK1)', () => {
  // The shot tool's masks are the share of each pixel's area and open shutter a mask covers. A band the camera's motion
  // swept from shade into sun is lit for 5 of 8 sub-frames (mask 159) and its frame mixes both: read as lit ground it
  // dragged the lit mean toward the shade.
  const size = 64,
    sun = [200, 180, 140],
    shade = [96, 92, 100],
    swept = (x) => x >= 8 && x < 20,
    part = 159,
    lit = { width: size, height: size, data: new Uint8Array(size * size) },
    shadow = { width: size, height: size, data: new Uint8Array(size * size) };
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      lit.data[y * size + x] = swept(x) ? part : x < 32 ? 255 : 0;
      shadow.data[y * size + x] = swept(x) ? 255 - part : x < 32 ? 0 : 255;
    }
  const frame = image(size, size, (x) => (swept(x) ? mix(shade, sun, part / 255) : x < 32 ? sun : shade)),
    clean = image(size, size, (x) => (x < 32 ? sun : shade)),
    hard = mask(size, size, (x) => x < 32 && !swept(x)),
    hardShadow = mask(size, size, (x) => x >= 32),
    truth = bounce(clean, { lit: hard, shadow: hardShadow }),
    seen = bounce(frame, { lit, shadow });
  assert.ok(Math.abs(seen.value - truth.value) < 1e-9, `swept ${seen.value}, truth ${truth.value}`);
  assert.equal(seen.detail.lit, truth.detail.lit, 'the swept band is not lit ground');
  assert.ok(
    Math.abs(shadowTint(frame, { lit, shadow }).value - shadowTint(clean, { lit: hard, shadow: hardShadow }).value) <
      1e-9,
  );
});

test('T6 compares shadowed ground with the lit ground beside it, not across the frame (KB-LOOK-TV-POOLFAILS1)', () => {
  // The timber-valley rail-line read bounce 137.7 percent and shadowTint -4.7 b*: its few shadowed pixels lay at the
  // frame's edge beside the fire, whose glow in the haze brightens that side, and were compared with lit road across
  // the whole frame. One surface here under a weak sun and a sky, plus a warm glow that falls from the left edge to
  // nothing by a third of the way across; small shadows only near the left edge. The light's own ratio is
  // (sky + glow) / (sky + glow + sun) at each place, under 100 percent everywhere.
  const width = 320,
    height = 180,
    encode = (v) => {
      const c = Math.min(1, Math.max(0, v));
      return Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));
    },
    sun = [0.02, 0.004, 0.0003],
    sky = [0.05, 0.04, 0.03],
    glow = (x) => Math.max(0, 1 - x / 100) * 0.08,
    ground = [0.3, 0.25, 0.2],
    inShadow = (x, y) => x >= 8 && x < 30 && ((y >= 20 && y < 40) || (y >= 100 && y < 120)),
    frame = image(width, height, (x, y) =>
      ground.map((a, c) => encode(a * (sky[c] + (c === 0 ? glow(x) : glow(x) * 0.5) + (inShadow(x, y) ? 0 : sun[c])))),
    ),
    lit = mask(width, height, (x, y) => !inShadow(x, y)),
    shadow = mask(width, height, inShadow),
    luminance = (c) => 0.2126729 * c[0] + 0.7151522 * c[1] + 0.072175 * c[2],
    // The ratio the light gives at the shadows' middle (x 19) and at their far edge, where the glow is weakest.
    at = (x) => {
      const diffuse = sky.map((v, c) => v + (c === 0 ? glow(x) : glow(x) * 0.5));
      return (100 * luminance(diffuse)) / luminance(diffuse.map((v, c) => v + sun[c]));
    };
  assert.equal(GROUND_BLOCK, 1 / 10);
  const b = bounce(frame, { lit, shadow }),
    t = shadowTint(frame, { lit, shadow });
  assert.ok(b.value < 100, `bounce ${b.value} must stay under 100 percent, as the light gives`);
  assert.ok(Math.abs(b.value - at(19)) < 3, `bounce ${b.value} against the light's ${at(19)}`);
  // The sun is warm, so ground it leaves is cooler: a positive tint, not the glow's gradient.
  assert.ok(t.value > 0, `shadowTint ${t.value}`);
  // A shadow with no lit ground in its block is not compared: shadows alone in their blocks leave nothing to read.
  const lone = bounce(frame, { lit: mask(width, height, (x) => x >= 160), shadow });
  assert.equal(lone.pass, false);
  assert.match(lone.missing, /lit and shadowed ground/);
});

test('T6 bounce and shadowTint compare like surfaces when given the albedo (KB-LOOK-TV-TINTMATCH1)', () => {
  // The timber-valley blowup read mid bounce 103 percent and shadowTint 0.036 b* (bound 0.0448): shadowed ground
  // brighter than lit ground, which one surface under one light cannot be. Its lit and shadow masks held different
  // surfaces. Here one light falls on two surfaces, warm sand and grey ash: the lit mask is mostly sand, the shadow
  // mask mostly ash. Without the albedo the masks mix the surfaces and the checks measure sand against ash; with it
  // each surface is compared with itself and the pooled values are the light's own.
  // A 90 px frame holds 9 px blocks with one row in nine of each side the other surface: 10 of the 88 rows inside the
  // 1 px inset (11.4 %), the share of the whole-frame fixture this replaces (7 of 62, 11.3 %). Six-pixel blocks would
  // force one row in six (16.7 %), which mixes the masks less and is not the case this test was written for.
  const size = 90,
    stripe = (x) => x % 8 < 4,
    encode = (v) => {
      const c = Math.min(1, Math.max(0, v));
      return Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));
    },
    sun = [0.9, 0.8, 0.6],
    sky = [0.12, 0.13, 0.16],
    sand = [0.55, 0.45, 0.3],
    ash = [0.1, 0.1, 0.11],
    lit = mask(size, size, stripe),
    shadow = mask(size, size, (x) => !stripe(x)),
    // Lit: one row in nine ash, the rest sand. Shadow: one row in nine sand, the rest ash (every block holds both).
    surface = (x, y) => (stripe(x) ? (y % 9 === 4 ? ash : sand) : y % 9 === 4 ? sand : ash),
    shade = (a, inSun) => a.map((v, c) => encode(v * (sky[c] + (inSun ? sun[c] : 0)))),
    frame = image(size, size, (x, y) => shade(surface(x, y), stripe(x))),
    grey = (c) => mask(size, size, () => false),
    plane = (c) => {
      const m = grey(c);
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) m.data[y * size + x] = encode(surface(x, y)[c]);
      return m;
    },
    albedo = albedoOf(frame, { 'albedo-r': plane(0), 'albedo-g': plane(1), 'albedo-b': plane(2) }),
    // Each surface alone, a frame of nothing but it, lit on the left and shaded on the right.
    alone = (a) => image(size, size, (x) => shade(a, stripe(x))),
    truth = (check) => [sand, ash].map((a) => check(alone(a), { lit, shadow }).value);
  assert.equal(GROUND_ALBEDO_LEVELS, 16);
  assert.equal(albedoOf(frame, { 'albedo-r': plane(0) }), undefined, 'all three planes or none');
  const mixedTint = shadowTint(frame, { lit, shadow }),
    tint = shadowTint(frame, { lit, shadow, albedo }),
    mixedBounce = bounce(frame, { lit, shadow }),
    matched = bounce(frame, { lit, shadow, albedo }),
    [sandTint, ashTint] = truth(shadowTint),
    [sandBounce, ashBounce] = truth(bounce);
  // The old masks mix the surfaces: sand in sun against ash in shade reads a far warmer and darker shadow than the
  // light gives either surface.
  assert.ok(mixedTint.value > sandTint + 5, `mixed tint ${mixedTint.value} against sand ${sandTint}`);
  assert.ok(mixedBounce.value < Math.min(sandBounce, ashBounce) / 2, `mixed bounce ${mixedBounce.value}`);
  // Like for like: the pooled value lies between the two surfaces' own and is their Cochran-Mantel-Haenszel mean.
  const lo = Math.min(sandTint, ashTint),
    hi = Math.max(sandTint, ashTint);
  assert.ok(tint.value >= lo - 1e-9 && tint.value <= hi + 1e-9, `tint ${tint.value} in ${lo} to ${hi}`);
  assert.ok(
    matched.value >= Math.min(sandBounce, ashBounce) - 1e-9 && matched.value <= Math.max(sandBounce, ashBounce) + 1e-9,
    `bounce ${matched.value}`,
  );
  // Two surfaces in each of the 10 x 10 blocks.
  assert.equal(tint.detail.strata, 2 * 10 * 10);
  assert.equal(tint.detail.matched, tint.detail.lit + tint.detail.shadow);
  // A surface seen only in the sun is not compared: with the shadow all ash and the lit ground all sand nothing matches.
  const apart = (x) => (stripe(x) ? sand : ash),
    split = image(size, size, (x) => shade(apart(x), stripe(x))),
    splitAlbedo = albedoOf(split, {
      'albedo-r': mask(size, size, () => false),
      'albedo-g': mask(size, size, () => false),
      'albedo-b': mask(size, size, () => false),
    });
  for (let i = 0; i < size * size; i++)
    for (let c = 0; c < 3; c++) splitAlbedo.data[i * 4 + c] = encode(apart(i % size)[c]);
  const none = shadowTint(split, { lit, shadow, albedo: splitAlbedo });
  assert.equal(none.pass, false);
  assert.match(none.missing, /like albedo/);
  // checkProbe builds the albedo from the probe's masks.
  const probe = checkProbe({
    name: 'two surfaces',
    frame,
    masks: { lit, shadow, 'albedo-r': plane(0), 'albedo-g': plane(1), 'albedo-b': plane(2) },
  }).find((row) => row.check === 'shadowTint');
  assert.ok(Math.abs(probe.value - tint.value) < 1e-9, `${probe.value} ${tint.value}`);
});

test('T6 leaves out ground an effect is drawn over, given the over mask (KB-LOOK-TV-TINTRES1)', () => {
  // The timber-valley blowup's T6 drifted 3.6 b* from frame to frame: its flame volumes, drawn over the ground after
  // the scene, sat on ground the sun's masks still counted as lit or shadowed, and moved and flickered along the shot.
  // One surface under one light here, a bright orange flame over part of the shadowed ground: without `over` the
  // shadow reads far warmer and brighter than the light gives it; with the flame's coverage the value is the light's.
  const size = 60,
    encode = (v) => {
      const c = Math.min(1, Math.max(0, v));
      return Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));
    },
    sun = [0.9, 0.8, 0.6],
    sky = [0.12, 0.13, 0.16],
    flame = [1.0, 0.45, 0.08],
    soil = [0.3, 0.25, 0.2],
    lit = mask(size, size, litStripe),
    shadow = mask(size, size, (x) => !litStripe(x)),
    // The flame's coverage: a soft-edged patch over the shadowed ground, rows 8 to 40, columns 36 to 60.
    cover = (x, y) => (!litStripe(x) && x >= 36 && x < 60 && y >= 8 && y < 40 ? (x < 40 || x >= 56 ? 0.2 : 0.9) : 0),
    over = mask(size, size, () => false),
    pixel = (x, y) =>
      soil.map((a, c) => {
        const ground = a * (sky[c] + (litStripe(x) ? sun[c] : 0)),
          k = cover(x, y);
        return encode(ground * (1 - k) + flame[c] * k);
      }),
    frame = image(size, size, pixel),
    clean = image(size, size, (x) => soil.map((a, c) => encode(a * (sky[c] + (litStripe(x) ? sun[c] : 0)))));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) over.data[y * size + x] = Math.round(255 * cover(x, y));
  const truth = shadowTint(clean, { lit, shadow }).value,
    trueBounce = bounce(clean, { lit, shadow }).value,
    drawn = shadowTint(frame, { lit, shadow }).value,
    left = shadowTint(frame, { lit, shadow, over }),
    leftBounce = bounce(frame, { lit, shadow, over }).value;
  // shadowTint is the lit minus the shadowed b*: a warmer shadow reads lower.
  assert.ok(drawn < truth - 5, `the flame warms the shadow: ${drawn} against ${truth}`);
  assert.ok(Math.abs(left.value - truth) < 1e-9, `with over: ${left.value} against ${truth}`);
  assert.ok(Math.abs(leftBounce - trueBounce) < 1e-9, `bounce with over: ${leftBounce} against ${trueBounce}`);
  assert.ok(left.detail.shadow < shadowTint(clean, { lit, shadow }).detail.shadow, 'the covered pixels are out');
  // checkProbe takes it from the probe's masks.
  const rows = checkProbe({ name: 'mid', frame, masks: { lit, shadow, over } }, {});
  assert.ok(Math.abs(rows.find((r) => r.check === 'shadowTint').value - truth) < 1e-9, 'checkProbe passes over on');
  // The share of the ground interior left out is reported; none without a mask.
  assert.ok(left.detail.over > 0 && left.detail.over < 50, `over ${left.detail.over} %`);
  assert.equal(shadowTint(frame, { lit, shadow }).detail.over, undefined);
  assert.equal(shadowTint(clean, { lit, shadow, over: mask(size, size, () => false) }).detail.over, 0);
  // A real tint fault still fails with the mask on: a shadow warmer than the sun (ground the light tints wrong, with
  // nothing drawn over it) reads below the bound, as it does without the mask.
  const warm = [0.25, 0.12, 0.02],
    faulty = image(size, size, (x, y) =>
      soil.map((a, c) => {
        const ground = a * (sky[c] + (litStripe(x) ? sun[c] : warm[c] * 4)),
          k = cover(x, y);
        return encode(ground * (1 - k) + flame[c] * k);
      }),
    ),
    fault = shadowTint(faulty, { lit, shadow, over, bound: [3, 100] });
  assert.equal(fault.pass, false, `the warm shadow fails with over: ${fault.value}`);
  assert.ok(fault.value < 0 && !fault.missing);
  // Too little ground left: a mask over nearly all the shadowed ground leaves fewer than GROUND_MIN_PIXELS there.
  const most = mask(size, size, (x, y) => !litStripe(x) && !(x === 40 && y < 20)),
    gone = shadowTint(frame, { lit, shadow, over: most });
  assert.equal(gone.pass, false);
  assert.match(gone.missing, new RegExp(`^${GROUND_MIN_PIXELS} lit and shadowed ground pixels nothing is drawn over`));
  assert.ok(gone.detail.over > 40, `over ${gone.detail.over} %`);
});

test('T6 limits follow the light: a clear sun keeps 10 to 35 percent and 3 b*, a pall moves them, wrong bounce fails', () => {
  // KB-LOOK-TV-PALL1. Lights as the shot tool records them (sun toward the light; ambient is irradiance over pi on
  // level ground). Clear: the calm rail-line sun (3.21 at 29.5 degrees up) over a clear sky's diffuse share; pall: the
  // blowup's red sun (0.249, [1, 0.30, 0.04]) under the smoky sky's light, measured 2026-11-26.
  const up = Math.sin((29.5 * Math.PI) / 180),
    dir = [Math.cos((29.5 * Math.PI) / 180), up, 0],
    clear = { sun: { direction: dir, intensity: 3.21, colour: [1, 0.86, 0.72] }, ambient: [0.06, 0.08, 0.12] },
    flatClear = { sun: clear.sun, ambient: [0.1, 0.1, 0.1] },
    pall = { sun: { direction: dir, intensity: 0.249, colour: [1, 0.3, 0.04] }, ambient: [0.3266, 0.286, 0.2735] },
    overcast = { sun: { direction: dir, intensity: 0.4, colour: [1, 1, 1] }, ambient: [0.5, 0.52, 0.55] };
  assert.ok(Math.abs(erbsDiffuseFraction(0.65) - 0.3336) < 5e-4 && CLEAR_SUN_DIFFUSE === erbsDiffuseFraction(0.65));
  assert.equal(erbsDiffuseFraction(0.9), 0.165);
  for (const light of [clear, flatClear]) {
    const b = lightBounds(light);
    assert.ok(b.diffuse <= CLEAR_SUN_DIFFUSE, `clear diffuse ${b.diffuse}`);
    assert.deepEqual(b.bounce, [10, 35]);
    assert.deepEqual(b.shadowTint, [3, 100]);
  }
  const p = lightBounds(pall),
    o = lightBounds(overcast);
  assert.ok(p.diffuse > 0.9 && o.diffuse > 0.7, `${p.diffuse} ${o.diffuse}`);
  // Never looser than the sunlit limits at the low end: diffuse light asks for brighter shadows, never darker.
  for (const b of [p, o]) assert.ok(b.bounce[0] > 10 && b.bounce[1] > 35 && b.bounce[1] <= 100, `${b.bounce}`);
  assert.ok(p.shadowTint[0] < 0.5 && p.shadowTint[0] > 0, `${p.shadowTint}`);
  // A family's own limits move the same way, and a light needs real numbers.
  assert.deepEqual(lightBounds(clear, { bounce: [12, 30] }).bounce, [12, 30]);
  assert.throws(
    () => lightBounds({ sun: { direction: [0, 1], intensity: 1, colour: [1, 1, 1] }, ambient: [0, 0, 0] }),
    RangeError,
  );

  // Ground frames: lit ground at 200, shadows on the left at the luminance share asked for, cooler by `cool` in blue.
  const size = 120,
    lit = mask(size, size, litStripe),
    shadow = mask(size, size, (x) => !litStripe(x)),
    ground = (share, cool = 0) => {
      const code = (v) => Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)),
        linear = 0.578;
      return image(size, size, (x) => {
        if (litStripe(x)) return [200, 200, 200];
        const v = code(linear * share);
        return [Math.max(0, v - cool), v, Math.min(255, v + cool)];
      });
    },
    probe = (name, frame, light) => ({ name, frame, masks: { lit, shadow }, light }),
    row = (rows, check) => rows.find((r) => r.check === check),
    family = { family: 'animatedFeature' };
  // The pall's frame as measured (shadows 92 percent of the lit ground, barely tinted) passes under its own light ...
  const pallFrame = ground(0.92, 1),
    underPall = checkProbe(probe('pall', pallFrame, pall), {}, family);
  assert.ok(row(underPall, 'bounce').pass, JSON.stringify(row(underPall, 'bounce')));
  assert.ok(row(underPall, 'shadowTint').pass, JSON.stringify(row(underPall, 'shadowTint')));
  assert.ok(Math.abs(row(underPall, 'bounce').detail.diffuse - p.diffuse) < 1e-9);
  // ... and fails as a clear-sun frame: flat bounce under a clear sun is still wrong (the flat-ambient failure).
  const flat = checkProbe(probe('flat', pallFrame, clear), {}, family);
  assert.equal(row(flat, 'bounce').pass, false);
  assert.equal(row(flat, 'shadowTint').pass, false);
  assert.deepEqual(row(flat, 'bounce').bound, [10, 35]);
  // The wrong bounce for a pall: sunlit-looking 20 percent shadows under nearly all diffuse light fail.
  const sunlit = checkProbe(probe('sunlit', ground(0.2, 8), pall), {}, family);
  assert.equal(row(sunlit, 'bounce').pass, false, JSON.stringify(row(sunlit, 'bounce')));
  // The same sunlit frame under a clear sun passes, as before.
  assert.ok(row(checkProbe(probe('ok', ground(0.2, 8), clear), {}, family), 'bounce').pass);
  // A bound the shot names wins over the light's.
  assert.deepEqual(row(checkProbe(probe('named', pallFrame, pall), { bounce: [10, 35] }), 'bounce').bound, [10, 35]);
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

test('T6 reads the precise frame, pools frames and gives its standard error (KB-LOOK-TV-TINTRES1)', () => {
  // The blowup's shadow interior is a few hundred pixels and one 8-bit blue code is 0.4 b* at its dark ground, both
  // coarser than the 0.0448 b* floor. Here the lit and shadowed ground share their 8-bit codes but not their floats:
  // only the precise frame shows the shadow cooler. Pooled frames add their pixels, and the standard error follows.
  const size = 60,
    lit = mask(size, size, litStripe),
    shadow = mask(size, size, (x) => !litStripe(x)),
    frame = image(size, size, () => [60, 40, 20]),
    // Shadow blue 0.3 of a code higher (cooler), lit 0.3 lower; one pixel in four 0.2 higher again, for a spread.
    precise = (lift = 0) => {
      const data = new Float32Array(size * size * 3);
      for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++) {
          const i = (y * size + x) * 3;
          data[i] = 60 / 255;
          data[i + 1] = 40 / 255;
          data[i + 2] = (20 + (litStripe(x) ? -0.3 : 0.3) + ((x + y) % 4 ? 0 : 0.2) + lift) / 255;
        }
      return { width: size, height: size, data };
    };
  const eight = shadowTint(frame, { lit, shadow }),
    one = shadowTint(frame, { lit, shadow, precise: precise() });
  assert.equal(eight.value, 0, 'the 8-bit codes are one colour');
  assert.ok(one.value > 0.1, `the precise frame reads the shadow cooler: ${one.value}`);
  assert.ok(one.detail.se > 0 && one.detail.se < one.value, `a pixel standard error: ${one.detail.se}`);
  assert.equal(one.detail.frames, undefined);
  // Three frames pooled, one of them a little bluer all over: three times the pixels, the same difference.
  const pool = [precise(0.5), precise()].map((p) => ({ precise: p, lit, shadow })),
    three = shadowTint(frame, { lit, shadow, precise: precise(), pool });
  assert.equal(three.detail.frames, 3);
  assert.equal(three.detail.lit, 3 * one.detail.lit);
  assert.ok(Math.abs(three.value - one.value) < 0.02, `pooled ${three.value} against one ${one.value}`);
  // Identical frames repeat the same pixels: the batch-means error is 0 and the pixels' error, smaller by root 3, stays.
  const same = shadowTint(frame, {
    lit,
    shadow,
    precise: precise(),
    pool: [precise(), precise()].map((p) => ({ precise: p, lit, shadow })),
  });
  assert.ok(Math.abs(same.detail.se - one.detail.se / Math.sqrt(3)) < 1e-3, `se ${same.detail.se}`);
  // Frames that disagree: the batch-means error is the larger and is used.
  const apart = (lift) => {
      const p = precise();
      for (let i = 2; i < p.data.length; i += 3) if (!litStripe((i - 2) / 3 % size)) p.data[i] += lift / 255;
      return p;
    },
    spread = shadowTint(frame, {
      lit,
      shadow,
      precise: apart(-2),
      pool: [apart(2), apart(0)].map((p) => ({ precise: p, lit, shadow })),
    });
  assert.ok(spread.detail.se > 0.3, `the frames' spread sets the error: ${spread.detail.se}`);
  // A pooled frame cut to its strata gives the same, and pooling it again (the next check) leaves it as it was.
  const samples = [precise(0.5), precise()].map((p) => groundSample({ precise: p, lit, shadow })),
    once = shadowTint(frame, { lit, shadow, precise: precise(), pool: samples }),
    twice = shadowTint(frame, { lit, shadow, precise: precise(), pool: samples });
  assert.equal(once.value, three.value);
  assert.deepEqual(twice, once);
  // bounce reads the precise frame too, and a frame of the wrong length throws.
  assert.ok(bounce(frame, { lit, shadow, precise: precise() }).detail.se > 0);
  assert.throws(
    () => shadowTint(frame, { lit, shadow, precise: { width: size, height: size, data: new Float32Array(3) } }),
    RangeError,
  );
});

test('checkShot passes a probe its precise frame and pooled frames for T6 (KB-LOOK-TV-TINTRES1)', async () => {
  const size = 60,
    frame = image(size, size, () => [60, 40, 20]),
    grey = (inside) => {
      const m = mask(size, size, inside),
        rgba = new Uint8Array(size * size * 4);
      for (let i = 0; i < size * size; i++) rgba.fill(m.data[i], i * 4, i * 4 + 3), (rgba[i * 4 + 3] = 255);
      return { width: size, height: size, data: rgba };
    },
    floats = () => {
      const data = new Float32Array(size * size * 3);
      for (let i = 0; i < size * size; i++) {
        data[i * 3] = 60 / 255;
        data[i * 3 + 1] = 40 / 255;
        data[i * 3 + 2] = (20 + (litStripe(i % size) ? -0.4 : 0.4)) / 255;
      }
      return new Uint8Array(data.buffer);
    },
    files = {
      'probes/a.png': await encodePNG(frame),
      'probes/a.lit.png': await encodePNG(grey(litStripe)),
      'probes/a.shadow.png': await encodePNG(grey((x) => !litStripe(x))),
      'probes/a.rgb32f': floats(),
      'frames/1.rgb32f': floats(),
      'frames/1.geometry.png': new Uint8Array(1),
    },
    read = async (path) => files[path] ?? Promise.reject(new Error(`no file ${path}`)),
    entry = { frame: 0, file: 'probes/a.png', aovs: { lit: 'probes/a.lit.png', shadow: 'probes/a.shadow.png' } },
    tintOf = async (probe) =>
      (await checkShot({ manifest: { probes: { a: probe } }, read, thumbWidth: 32 })).json.probes[0].results.find(
        (row) => row.check === 'shadowTint',
      ),
    eight = await tintOf(entry),
    pooled = await tintOf({
      ...entry,
      precise: 'probes/a.rgb32f',
      // A pooled frame's other masks are not read (a geometry mask that is no PNG would throw).
      pool: [{ frame: 1, precise: 'frames/1.rgb32f', aovs: { ...entry.aovs, geometry: 'frames/1.geometry.png' } }],
    });
  assert.equal(eight.value, 0);
  assert.ok(pooled.value > 0.1, `the precise frames read the cooler shadow: ${pooled.value}`);
  assert.equal(pooled.detail.frames, 2);
  await assert.rejects(
    tintOf({ ...entry, precise: 'frames/1.geometry.png' }),
    RangeError,
    'a precise frame of the wrong size',
  );
});

test('T4 shimmerMoving leaves out what the next frame covers or uncovers, by the forward-backward test (KB-LOOK-TV-SHIMMER2)', () => {
  // The camera pans 2 px; a near post in the next frame stands over columns 20 to 23 and moves with itself (back 0),
  // covering background the probe saw there. Without the back motion those pixels read as shimmer; with it they are
  // occluded and left out, and the rest of the frame, which moved as the camera says, is clean.
  const size = 48,
    shade = (x) => 60 + ((x * 7) % 50),
    frame = image(size, size, (x) => shade(x)),
    next = image(size, size, (x) => (x >= 20 && x < 24 ? 250 : shade(x - 2))),
    motion = { width: size, height: size, data: new Float32Array(size * size * 2) },
    back = { width: size, height: size, data: new Float32Array(size * size * 2) };
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 2;
      motion.data[i] = 2;
      back.data[i] = x >= 20 && x < 24 ? 0 : -2;
    }
  const without = shimmerMoving(frame, { next, motion }),
    withBack = shimmerMoving(frame, { next, motion, back });
  assert.ok(without.value > 5, `the post reads as shimmer without the back motion: ${without.value}`);
  assert.equal(withBack.value, 0);
  assert.equal(withBack.detail.occluded, 4 * size);
  assert.equal(without.detail.occluded, undefined);
  assert.throws(() => shimmerMoving(frame, { next, motion, back: { ...back, data: new Float32Array(2) } }), RangeError);
});

test('T4 shimmerMoving leaves out what moves other than the camera moves it, by the engine velocity (KB-LOOK-TV-SHIMMER2)', () => {
  // The camera pans 2 px; a swaying patch at columns 10 to 15 moves 1 px further in the engine's velocity, so its shade
  // differs from the camera's warp. Without the velocity it reads as shimmer; with it it is animated and left out, and
  // the rest, where the velocity is the camera's (within half a pixel), still counts.
  const size = 48,
    shade = (x) => 60 + ((x * 7) % 50),
    sway = (x) => x >= 12 && x < 18,
    frame = image(size, size, (x) => shade(x)),
    next = image(size, size, (x) => (sway(x) ? shade(x - 3) : shade(x - 2))),
    motion = { width: size, height: size, data: new Float32Array(size * size * 2) },
    velocity = { width: size, height: size, data: new Float32Array(size * size * 2) };
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 2;
      motion.data[i] = 2;
      velocity.data[i] = sway(x) ? 3 : 2.3;
    }
  const without = shimmerMoving(frame, { next, motion }),
    withVelocity = shimmerMoving(frame, { next, motion, nextVelocity: velocity });
  assert.ok(without.value > 5, `the patch reads as shimmer without the velocity: ${without.value}`);
  assert.equal(withVelocity.value, 0);
  assert.equal(withVelocity.detail.animated, 6 * size);
  assert.equal(without.detail.animated, undefined);
  // A real fault in still ground (a pixel that flips) still counts with the velocity.
  const flicker = image(size, size, (x, y) => (x === 30 && y < 24 ? 250 : sway(x) ? shade(x - 3) : shade(x - 2)));
  assert.ok(shimmerMoving(frame, { next: flicker, motion, nextVelocity: velocity }).value > 1);
  assert.throws(
    () => shimmerMoving(frame, { next, motion, nextVelocity: { ...velocity, data: new Float32Array(2) } }),
    RangeError,
  );
  // What a swaying branch leaves: in the probe a branch (250) over columns 30 to 33 moving 3 px more than the camera,
  // in the next frame the sky behind it where the camera puts it. The next frame's velocity there is the sky's, the
  // camera's, so only the probe's own velocity finds it.
  const branch = (x) => x >= 30 && x < 34,
    leaving = image(size, size, (x) => (branch(x) ? 250 : shade(x))),
    own = { width: size, height: size, data: new Float32Array(size * size * 2) };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) own.data[(y * size + x) * 2] = branch(x) ? 5 : 2;
  const still = { width: size, height: size, data: new Float32Array(size * size * 2) };
  for (let i = 0; i < size * size; i++) still.data[i * 2] = 2;
  const vacated = image(size, size, (x) => shade(x - 2)),
    next2 = shimmerMoving(leaving, { next: vacated, motion, nextVelocity: still }),
    both = shimmerMoving(leaving, { next: vacated, motion, velocity: own, nextVelocity: still });
  assert.ok(next2.value > 5, `the branch's place reads as shimmer with the next frame's velocity alone: ${next2.value}`);
  assert.equal(both.value, 0);
  assert.equal(both.detail.animated, 4 * size);
});

test('T4 shimmerMoving counts a pixel off only outside its four reprojection taps, so a sharp edge warped between pixels is not shimmer and one-pixel shimmer still fails (KB-LOOK-TV-SHIMMER2)', () => {
  // A hard vertical edge (sky 230 against branch 40) moved 2.5 pixels: each pixel lands between two pixels of the next
  // frame, where a bilinear read blends the edge into a value the frame never had.
  const width = 48,
    height = 32,
    edge = (x) => (x < 20 ? 40 : 230),
    frame = image(width, height, (x) => edge(x)),
    next = image(width, height, (x) => edge(x - 2)),
    motion = { width, height, data: new Float32Array(width * height * 2) };
  for (let i = 0; i < width * height; i++) motion.data[i * 2] = 2.5;
  const warped = shimmerMoving(frame, { next, motion });
  assert.equal(warped.value, 0, `a warped edge reads as shimmer: ${warped.value}`);
  // Real one-pixel shimmer: single pixels on and beside the edge flash to a value none of their taps hold in the next
  // frame (a one-pixel line on a silhouette that is there one frame and gone the next).
  const lines = image(width, height, (x, y) => (x === 19 && y % 2 === 0 ? 255 : y % 3 === 0 && x === 30 ? 0 : edge(x)));
  const shimmering = shimmerMoving(lines, { next, motion });
  assert.ok(shimmering.detail.off >= height / 2, `one-pixel shimmer found: ${shimmering.detail.off}`);
  assert.ok(shimmering.value > 0.5 && !shimmering.pass, `one-pixel shimmer fails: ${shimmering.value}`);
});

test('T8 motionBlur judges each edge by its surface`s own travel when given the engine velocity (KB-LOOK-TV-MBVEL1)', () => {
  // The camera sweeps 12 px a frame, but a leaf (the bar) sways back against it and moves 2 px: drawn as it moved, its
  // edges are near sharp. Judged by the camera's motion it read as strobing; by its own velocity it is under the 8 px
  // floor and not judged. The same edge with the leaf really moving 12 px still fails.
  const width = 96,
    height = 24,
    motion = { width, height, data: new Float32Array(width * height * 2) },
    velocity = { width, height, data: new Float32Array(width * height * 2) },
    leaf = (x) => x >= 30 && x < 54;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      motion.data[(y * width + x) * 2] = 12;
      velocity.data[(y * width + x) * 2] = leaf(x) || leaf(x - 1) || leaf(x + 1) ? 2 : 12;
    }
  const frame = image(width, height, (x) => (leaf(x) ? 220 : 30)),
    camera = motionBlur(frame, motion),
    own = motionBlur(frame, motion, { velocity });
  assert.ok(camera.value === 100 && !camera.pass, `by the camera's motion: ${camera.value}`);
  assert.equal(own.detail.edges, 0, 'the swaying leaf moves 2 px: not a fast edge');
  assert.ok(own.pass);
  const fast = motionBlur(frame, motion, { velocity: motion });
  assert.ok(fast.value === 100 && !fast.pass, `a leaf really moving 12 px drawn sharp: ${fast.value}`);
  assert.throws(() => motionBlur(frame, motion, { velocity: { ...velocity, data: new Float32Array(2) } }), RangeError);
});

test('T4 shimmerMoving leaves out only the pixels a moving surface`s own blur reaches, so shimmer on a static edge beside a swaying branch still fails (KB-LOOK-TV-SHIMMER2)', () => {
  // A still camera; a branch (250) over columns 20 to 23 sways 8 px a frame, so a 180 degree shutter smears it 2 px each
  // way (half its motion over the open shutter). The next frame holds that smear on columns 18, 19, 24 and 25, and a
  // static edge at column 30, 7 px from the branch, flashes one pixel in two.
  const width = 48,
    height = 32,
    branch = (x) => x >= 20 && x < 24,
    base = (x) => (branch(x) ? 250 : x >= 30 ? 200 : 60),
    frame = image(width, height, (x) => base(x)),
    smear = (x) => x === 18 || x === 19 || x === 24 || x === 25,
    next = image(width, height, (x, y) => (x === 30 && y % 2 === 0 ? 0 : smear(x) ? 150 : base(x))),
    motion = { width, height, data: new Float32Array(width * height * 2) },
    velocity = { width, height, data: new Float32Array(width * height * 2) };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) velocity.data[(y * width + x) * 2] = branch(x) ? 8 : 0;
  const row = shimmerMoving(frame, { next, motion, velocity });
  assert.equal(row.detail.animated, 4 * height);
  assert.equal(row.detail.blurred, 4 * height, 'the smear within 2 px of the branch is left out');
  assert.equal(row.detail.off, height / 2, 'the static edge`s shimmer is still counted');
  assert.ok(row.value > 0.5 && !row.pass, `shimmer beside a swaying branch fails: ${row.value}`);
  // The reach is the blur the shot really draws: a 1 px maxBlur leaves column 25's smear counted, a 360 degree shutter
  // reaches 4 px, and neither reaches the static edge.
  const capped = shimmerMoving(frame, { next, motion, velocity, maxBlur: 1 });
  assert.equal(capped.detail.blurred, 2 * height);
  assert.equal(capped.detail.off, height / 2 + 2 * height);
  const open = shimmerMoving(frame, { next, motion, velocity, shutter: 360 });
  assert.equal(open.detail.blurred, 8 * height);
  assert.equal(open.detail.off, height / 2);
  assert.equal(shimmerMoving(frame, { next, motion }).detail.blurred, undefined);
  for (const bad of [{ maxBlur: 0 }, { maxBlur: 200 }, { shutter: 0 }, { shutter: 400 }])
    assert.throws(() => shimmerMoving(frame, { next, motion, velocity, ...bad }), RangeError, JSON.stringify(bad));
});

test('T4 shimmerMoving leaves out the trail a near swaying leaf smears over the sky across its sub-frames, by its whole screen velocity (KB-SCATTER-FRINGEVEL1)', () => {
  // The timber-valley blowup: a leaf near the lens moves 63 px a frame on screen, 53 px of it the camera's parallax and
  // 10 px its sway, over sky the camera moves by nothing. Eight sub-frames over a 180 degree shutter smear it 31.5 px;
  // the velocity and depth are the last sub-frame's, so the trail behind the leaf (columns 50 to 79) holds the sky's
  // velocity and changes completely by the next frame, which `shimmerMoving` read as shimmer (1.72 percent, mid).
  const width = 160,
    height = 16,
    leaf = (x) => x >= 80 && x < 100,
    trail = (x) => x >= 50 && x < 80,
    frame = image(width, height, (x) => (leaf(x) ? 40 : trail(x) ? 40 + ((80 - x) * 190) / 31 : 230)),
    // The next frame: the leaf 63 px on, its trail over columns 113 to 142, the sky back where it was, and a static
    // edge at column 20 that flashes one row in two (real shimmer, which still counts).
    next = image(width, height, (x, y) =>
      x === 20 && y % 2 === 0 ? 0 : x >= 143 ? 40 : x >= 113 ? 40 + ((143 - x) * 190) / 31 : 230,
    ),
    motion = { width, height, data: new Float32Array(width * height * 2) },
    velocity = { width, height, data: new Float32Array(width * height * 2) };
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 2;
      motion.data[i] = leaf(x) ? 53 : 0;
      velocity.data[i] = leaf(x) ? 63 : 0;
    }
  // The next frame's own velocity and back motion: the leaf at columns 143 to 162 moving 63 px, the sky still, so the
  // sky of this frame landing in the leaf's next trail (columns 113 to 142) is that frame's smear, not shimmer.
  const nextVelocity = { width, height, data: new Float32Array(width * height * 2) },
    back = { width, height, data: new Float32Array(width * height * 2) };
  for (let y = 0; y < height; y++)
    for (let x = 143; x < width; x++) {
      nextVelocity.data[(y * width + x) * 2] = 63;
      back.data[(y * width + x) * 2] = -53;
    }
  const moving = { next, motion, velocity, nextVelocity, back, shutter: 180 },
    once = shimmerMoving(frame, moving),
    exposed = shimmerMoving(frame, { ...moving, subframes: 8 }),
    before = shimmerMoving(frame, { next, motion, velocity, nextVelocity, shutter: 180, subframes: 8 });
  // Drawn once, the blur is centred on the leaf: 63 x 0.5 / 2 = 15.75 px each way (capped by MotionBlur's 32), on
  // columns 64 to 79 and 100 to 115, and 127 to 142 behind the next frame's leaf. By the sway alone (10 px, the
  // camera's part taken out) it reached 2.5 px.
  assert.equal(once.detail.blurred, (16 + 16 + 16) * height, 'a frame drawn once: the centred 15.75 px blur');
  // Eight sub-frames: the travel from the first to the last (7/8 of 31.5 px) plus half a slice's blur, 29.5 px behind
  // (columns 50 to 79) and half a slice, 2 px, ahead (100 and 101); the next frame's trail the same (113 to 142).
  assert.equal(exposed.detail.blurred, (30 + 2 + 30) * height, 'the whole trail behind the leaf is left out');
  assert.equal(exposed.detail.off, height / 2, 'only the static edge`s shimmer is counted');
  // Without the back motion the next frame's camera motion is unknown, and its trail is counted.
  assert.equal(before.detail.off, height / 2 + 30 * height);
  // The sky ahead of the leaf is not reached beyond half a slice, so a fault 5 px ahead of it still counts.
  const ahead = image(width, height, (x, y) => (x === 104 && y % 2 === 0 ? 0 : next.data[(y * width + x) * 4]));
  assert.equal(shimmerMoving(frame, { ...moving, next: ahead, subframes: 8 }).detail.off, height);
  // A mover's smear over a surface moving with it changes nothing there: under a camera pan the same 63 px, the sky
  // pixels move with the leaf and none is left out.
  const pan = { width, height, data: new Float32Array(width * height * 2) };
  for (let i = 0; i < width * height; i++) pan.data[i * 2] = 63;
  const panned = { width, height, data: pan.data.slice() };
  for (let y = 0; y < height; y++) for (let x = 80; x < 100; x++) panned.data[(y * width + x) * 2] = 53;
  assert.equal(shimmerMoving(frame, { ...moving, motion: panned, velocity: pan, subframes: 8 }).detail.blurred, 0);
  for (const bad of [0, 1.5, 5000])
    assert.throws(() => shimmerMoving(frame, { ...moving, subframes: bad }), RangeError, String(bad));
});

test('T4 shimmerMoving still fails one-pixel shimmer on a static edge just outside a fast mover`s sub-frame trail (KB-SCATTER-FRINGEVEL1 guard)', () => {
  // The leaf of the test above: 63 px a frame on screen, 53 px of it camera parallax, eight sub-frames at 180 degrees,
  // so its trail reaches 29.5 px behind (columns 50 to 79), 2 px ahead (100, 101) and the next frame's trail covers
  // 113 to 142. A static edge at column 49 (pale ground left of it) and the sky at columns 102 and 112, one pixel past
  // each reach, flash in every row: the wider reach must not swallow them.
  const width = 160,
    height = 16,
    leaf = (x) => x >= 80 && x < 100,
    trail = (x) => x >= 50 && x < 80,
    edge = (x) => x < 50,
    frame = image(width, height, (x) => (leaf(x) ? 40 : trail(x) ? 40 + ((80 - x) * 190) / 31 : edge(x) ? 200 : 230)),
    shimmer = (x) => x === 49 || x === 102 || x === 112,
    next = image(width, height, (x) =>
      shimmer(x) ? 0 : x >= 143 ? 40 : x >= 113 ? 40 + ((143 - x) * 190) / 31 : edge(x) ? 200 : 230,
    ),
    motion = { width, height, data: new Float32Array(width * height * 2) },
    velocity = { width, height, data: new Float32Array(width * height * 2) },
    nextVelocity = { width, height, data: new Float32Array(width * height * 2) },
    back = { width, height, data: new Float32Array(width * height * 2) };
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 2;
      motion.data[i] = leaf(x) ? 53 : 0;
      velocity.data[i] = leaf(x) ? 63 : 0;
      if (x >= 143) {
        nextVelocity.data[i] = 63;
        back.data[i] = -53;
      }
    }
  const row = shimmerMoving(frame, { next, motion, velocity, nextVelocity, back, shutter: 180, subframes: 8 });
  assert.equal(row.detail.blurred, (30 + 2 + 30) * height, 'the reach is the trail alone');
  assert.equal(row.detail.off, 3 * height, 'every pixel one past a reach is still counted');
  assert.ok(row.value > 0.5 && !row.pass, `shimmer just outside the trail fails: ${row.value}`);
});

test('T4 shimmerMoving still fails shimmer in a background a fast mover`s reach covers when the background moves with it (KB-SCATTER-FRINGEVEL1 guard)', () => {
  // A camera pan of 63 px a frame: the sky moves 63 px, the leaf near the lens 63 px on screen too (53 px parallax
  // plus its sway), so the leaf's smear lies on sky moving the same way and changes nothing there. Shimmer in that sky,
  // inside the leaf's 29.5 px sub-frame trail (column 60, landing on 123), is real and must count; the same shimmer
  // over a still sky, where the smear does change the pixel, is the trail and is left out.
  const width = 160,
    height = 16,
    leaf = (x) => x >= 80 && x < 100,
    frame = image(width, height, (x) => (leaf(x) ? 40 : 230)),
    panned = image(width, height, (x) => (x === 123 ? 0 : 230)),
    still = image(width, height, (x) => (x === 60 ? 0 : 230)),
    motion = { width, height, data: new Float32Array(width * height * 2) },
    velocity = { width, height, data: new Float32Array(width * height * 2) },
    stillMotion = { width, height, data: new Float32Array(width * height * 2) },
    stillVelocity = { width, height, data: new Float32Array(width * height * 2) };
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 2;
      motion.data[i] = leaf(x) ? 53 : 63;
      velocity.data[i] = 63;
      stillMotion.data[i] = leaf(x) ? 53 : 0;
      stillVelocity.data[i] = leaf(x) ? 63 : 0;
    }
  const row = shimmerMoving(frame, { next: panned, motion, velocity, shutter: 180, subframes: 8 });
  assert.equal(row.detail.blurred, 0, 'a smear over a surface moving with it reaches nothing');
  assert.equal(row.detail.off, height, 'the shimmer inside the trail is counted');
  assert.ok(row.value > 0.5 && !row.pass, `shimmer under a mover moving with it fails: ${row.value}`);
  const over = shimmerMoving(frame, {
    next: still,
    motion: stillMotion,
    velocity: stillVelocity,
    shutter: 180,
    subframes: 8,
  });
  assert.equal(over.detail.blurred, (30 + 2) * height, `the trail behind and half a slice ahead`);
  assert.equal(over.detail.off, 0, 'over a still sky the same column is the trail');
});

test('T8 motionBlur fails a stepped trail: eight sharp copies over a 180 degree shutter are not a smear (KB-LOOK-TV-SUBSTEP1)', () => {
  // Bars moving 96 and 64 px a frame, exposed at 180 degrees as 8 sharp copies (each sub-frame drawn without blurring over
  // its own slice of the shutter, the old timber-valley trail) or as one continuous smear.
  for (const [bar, travel] of [
    [24, 96],
    [3, 64],
  ]) {
    const width = 256,
      height = 8,
      motion = { width, height, data: new Float32Array(width * height * 2) };
    for (let i = 0; i < width * height; i++) motion.data[i * 2] = travel;
    const exposed = (copies) =>
      image(width, height, (x) => {
        let cover = 0;
        for (let k = 0; k < copies; k++) {
          const o = ((k + 0.5) / copies) * 0.5 * travel;
          cover += Math.max(0, Math.min(x + 1, 60 + bar + o) - Math.max(x, 60 + o));
        }
        return Math.round(20 + 235 * (cover / copies));
      });
    const trail = motionBlur(exposed(8), motion),
      smooth = motionBlur(exposed(256), motion);
    assert.ok(trail.detail.edges > 0 && trail.value === 100 && !trail.pass, `${bar} px stepped: ${trail.value}`);
    assert.ok(smooth.value === 0 && smooth.pass, `${bar} px smeared: ${smooth.value} of ${smooth.detail.edges}`);
  }
});

// KB-LOOK-TV-MBNARROW1: a mover narrower than its smear ramps over its own width however well it is blurred, so a
// 12 px bar smeared correctly over a 180 degree shutter at 64 px a frame read 100 percent sharp. Its ramp plus the
// plateau it holds spans the smear; the check now judges that. A sharp bar and a half-length smear still fail.
test('T8 motionBlur passes a correctly smeared mover narrower than its smear, not a sharp or half-smeared one (KB-LOOK-TV-MBNARROW1)', () => {
  const width = 256,
    height = 8,
    bar = 12,
    travel = 64,
    motion = { width, height, data: new Float32Array(width * height * 2) };
  for (let i = 0; i < width * height; i++) motion.data[i * 2] = travel;
  // The bar's coverage of each pixel, the mean of `copies` positions spread over `length` of its travel.
  const exposed = (copies, length) =>
    image(width, height, (x) => {
      let cover = 0;
      for (let k = 0; k < copies; k++) {
        const o = ((k + 0.5) / copies) * length;
        cover += Math.max(0, Math.min(x + 1, 60 + bar + o) - Math.max(x, 60 + o));
      }
      return Math.round(20 + 235 * (cover / copies));
    });
  const good = motionBlur(exposed(256, travel / 2), motion),
    sharp = motionBlur(exposed(1, 0), motion),
    half = motionBlur(exposed(256, travel / 4), motion),
    // Eight sharp copies over the shutter: a staircase of three jumps up the bar's 12 px ramp (KB-LOOK-TV-SUBSTEP1).
    trail = motionBlur(exposed(8, travel / 2), motion);
  assert.ok(good.detail.edges > 0 && good.value === 0 && good.pass !== false, `smeared: ${good.value} of ${good.detail.edges}`);
  assert.ok(sharp.detail.edges > 0 && sharp.value === 100, `sharp: ${sharp.value} of ${sharp.detail.edges}`);
  assert.ok(half.detail.edges > 0 && half.value === 100, `half smear: ${half.value} of ${half.detail.edges}`);
  assert.ok(trail.detail.edges > 0 && trail.value === 100, `8 copies: ${trail.value} of ${trail.detail.edges}`);
});
