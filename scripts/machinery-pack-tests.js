// Real-GPU checks for machinery's part pack, glTF-pro buffer sharing and STEP linearDeflection, on loaded files only.
// Run after `npm run build:packages`; holds the shared GPU lock.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from './browser.js';
import { acquire } from './gpu-lock.mjs';
import { decodePNG } from '../tests/support/png.js';

const output = 'test-results/machinery-pack',
  port = 5221,
  report = { hardware: null, checks: [], failures: [], values: {} },
  pixel = (image, [x, y]) => Array.from(image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 3)),
  distance = (a, b) => Math.max(...a.map((value, channel) => Math.abs(value - b[channel]))),
  brightness = (rgb) => rgb.reduce((sum, value) => sum + value, 0) / 3;
function check(name, pass, actual) {
  report.checks.push({ name, pass, actual });
  if (!pass) report.failures.push(`${name}: ${JSON.stringify(actual)}`);
}

/** Outward quads on every face of an axis-aligned box, each face an n[u] x n[v] grid so neighbouring faces share edges. */
function objBox(name, min, max, n = [1, 1, 1]) {
  const lines = [`o ${name}`];
  for (let axis = 0; axis < 3; axis++)
    for (const side of [-1, 1]) {
      const u = (axis + 1) % 3,
        v = (axis + 2) % 3,
        at = (i, j) => {
          const p = [0, 0, 0];
          p[axis] = side < 0 ? min[axis] : max[axis];
          p[u] = min[u] + ((max[u] - min[u]) * i) / n[u];
          p[v] = min[v] + ((max[v] - min[v]) * j) / n[v];
          return p;
        };
      for (let i = 0; i < n[u]; i++)
        for (let j = 0; j < n[v]; j++) {
          const quad = [at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)];
          if (side < 0) quad.reverse();
          for (const p of quad) lines.push(`v ${p.join(' ')}`);
          lines.push('f -4 -3 -2 -1');
        }
    }
  return lines.join('\n');
}
// World layout (64 px per unit, screen x = 192 + 64x, y = 128 - 64y). The section keeps z < 0.
function assembly() {
  const parts = [
    objBox('probe', [-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]),
    objBox('second', [1.5, 1.0, -0.3], [2.0, 1.5, 0.3]),
    objBox('front', [0.6, -0.45, 0.1], [1.0, -0.1, 0.4]),
  ];
  for (let i = 0; i < 997; i++) {
    const x = (i % 40) - 20,
      y = -5 - Math.floor(i / 40);
    parts.push(objBox(`far-${i}`, [x, y, 0], [x + 0.2 + (i % 40) * 0.003, y + 0.2 + Math.floor(i / 40) * 0.005, 0.3]));
  }
  // Big part and shadow receiver: 60 x 40 quads on its front and back faces (over 4,096 welded vertices), wholly at z < 0.
  parts.push(objBox('wall', [-3, -2, -1.6], [3, 2, -1.5], [60, 40, 1]));
  parts.push(['o sheet', 'v 0 -60 0', 'v 1 -60 0', 'v 1 -59 0', 'v 0 -59 0', 'f -4 -3 -2 -1'].join('\n'));
  return parts.join('\n') + '\n';
}
/** A box glTF: two static meshes with separate but identical accessors, a skinned copy and a morphed copy. */
function dedupGLTF() {
  const positions = [],
    normals = [],
    indices = [];
  for (let axis = 0; axis < 3; axis++)
    for (const side of [-1, 1]) {
      const u = (axis + 1) % 3,
        v = (axis + 2) % 3,
        start = positions.length / 3,
        corners = [
          [-1, -1],
          [1, -1],
          [1, 1],
          [-1, 1],
        ];
      for (const [a, b] of corners) {
        const p = [0, 0, 0],
          n = [0, 0, 0];
        p[axis] = side * 0.5;
        p[u] = a * 0.5;
        p[v] = b * 0.5;
        n[axis] = side;
        positions.push(...p);
        normals.push(...n);
      }
      for (const i of side > 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2]) indices.push(start + i);
    }
  const chunks = [],
    bufferViews = [],
    accessors = [];
  let offset = 0;
  const add = (array, type, componentType, target, extra = {}) => {
    const bytes = new Uint8Array(array.buffer.slice(0));
    chunks.push(bytes);
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, target });
    offset += bytes.length;
    const pad = (4 - (offset % 4)) % 4;
    if (pad) {
      chunks.push(new Uint8Array(pad));
      offset += pad;
    }
    const size = { SCALAR: 1, VEC3: 3, VEC4: 4 }[type];
    accessors.push({ bufferView: bufferViews.length - 1, componentType, count: array.length / size, type, ...extra });
    return accessors.length - 1;
  };
  const box = () => ({
    POSITION: add(new Float32Array(positions), 'VEC3', 5126, 34962, { min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] }),
    NORMAL: add(new Float32Array(normals), 'VEC3', 5126, 34962),
  });
  const index = () => add(new Uint32Array(indices), 'SCALAR', 5125, 34963),
    a = box(),
    aIndex = index(),
    b = box(),
    bIndex = index(),
    skin = {
      ...box(),
      JOINTS_0: add(new Uint16Array(24 * 4), 'VEC4', 5123, 34962),
      WEIGHTS_0: add(
        new Float32Array(24 * 4).map((_, i) => (i % 4 ? 0 : 1)),
        'VEC4',
        5126,
        34962,
      ),
    },
    skinIndex = index(),
    morph = box(),
    morphIndex = index(),
    target = add(new Float32Array(positions.length), 'VEC3', 5126, 34962, { min: [0, 0, 0], max: [0, 0, 0] });
  const bin = new Uint8Array(offset);
  let at = 0;
  for (const chunk of chunks) {
    bin.set(chunk, at);
    at += chunk.length;
  }
  const gltf = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0, 1, 2, 3, 4] }],
    nodes: [
      { name: 'static-a', mesh: 0, translation: [-3, 0, 0] },
      { name: 'static-b', mesh: 1, translation: [-1, 0, 0] },
      { name: 'skinned', mesh: 2, skin: 0 },
      { name: 'joint', translation: [1, 0, 0] },
      { name: 'morphed', mesh: 3, translation: [3, 0, 0] },
    ],
    skins: [{ joints: [3] }],
    meshes: [
      { primitives: [{ attributes: a, indices: aIndex }] },
      { primitives: [{ attributes: b, indices: bIndex }] },
      { primitives: [{ attributes: skin, indices: skinIndex }] },
      { primitives: [{ attributes: morph, indices: morphIndex, targets: [{ POSITION: target }] }], weights: [0] },
    ],
    buffers: [{ byteLength: offset, uri: 'dedup.bin' }],
    bufferViews,
    accessors,
  };
  return { gltf: JSON.stringify(gltf), bin };
}
/** The cap color SectionPlanes writes to an 8-bit target: Reinhard then gamma 2.2 of the linear '#f2a65e'. */
const capColor = [0xf2, 0xa6, 0x5e].map((byte) => {
  const v = byte / 255,
    linear = v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  return Math.round(255 * (linear / (1 + linear)) ** (1 / 2.2));
});

let browser, release;
try {
  await mkdir(output, { recursive: true });
  await writeFile(`${output}/assembly.obj`, assembly());
  const { gltf, bin } = dedupGLTF();
  await writeFile(`${output}/dedup.gltf`, gltf);
  await writeFile(`${output}/dedup.bin`, bin);
  release = await acquire({ owner: 'machinery-pack-tests' });
  browser = await openBrowser({ startPath: '/tests/machinery-pack.html?scenario=cad&samples=4', port });
  report.hardware = browser.hardware;
  assert.equal(browser.hardware.webgpu?.fallback, false, 'Physical WebGPU adapter required');
  const { page } = browser,
    pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const shot = async (name) => decodePNG(await page.locator('canvas').screenshot({ path: `${output}/${name}.png` }));
  for (const samples of [4, 1]) {
    if (samples === 1) await page.goto(`http://127.0.0.1:${port}/tests/machinery-pack.html?scenario=cad&samples=1`);
    await page.waitForFunction(() => window.machineryPack, null, { timeout: 120_000 });
    const run = (body, arg) => page.evaluate(body, arg),
      v = (report.values[`${samples}x`] = {});
    const loaded = await run(() => ({ parts: machineryPack.parts, geometries: machineryPack.geometries }));
    check(
      `${samples}x OBJ loads 1,002 part meshes with 1,002 geometries`,
      loaded.parts === 1002 && loaded.geometries === 1002,
      loaded,
    );
    v.unpacked = await run(() => machineryPack.frame());
    await run(() => machineryPack.attach());
    v.firstPacked = await run(() => machineryPack.frame());
    v.packed = await run(() => machineryPack.frame());
    v.packedStats = await run(() => machineryPack.stats());
    check(`${samples}x without the pack: one draw per part`, v.unpacked.draws === 1002, v.unpacked);
    check(
      `${samples}x packed: 1,000 boxes draw as 1 pack draw; big part and open sheet keep their own (3 draws)`,
      v.packed.draws === 3 && v.packed.drawCalls === 2 && v.packedStats.packs === 1 && v.packedStats.packed === 1000,
      { frame: v.packed, stats: v.packedStats },
    );
    await run(() => machineryPack.move('far-10', 0.5));
    v.moved = await run(() => machineryPack.frame());
    v.movedNext = await run(() => machineryPack.frame());
    check(
      `${samples}x a moved part returns to its own draw`,
      v.moved.draws === 4 && v.movedNext.drawCalls === 3 && (await run(() => machineryPack.stats())).packed === 999,
      { moved: v.moved, next: v.movedNext },
    );
    await run(() => machineryPack.setPack(false));
    v.off = await run(() => machineryPack.frame());
    v.offNext = await run(() => machineryPack.frame());
    check(`${samples}x pack turned off: one draw per part`, v.off.draws === 1002 && v.offNext.drawCalls === 1002, {
      off: v.off,
      next: v.offNext,
    });
    await run(() => machineryPack.setPack(true));
    v.on = await run(() => machineryPack.frame());
    check(`${samples}x pack turned on again: 3 draws`, v.on.draws === 3, v.on);
    const targets = { probe: [192, 128], second: [304, 48], front: [243, 146], wall: [336, 112] };
    v.enginePick = {};
    for (const [name, [x, y]] of Object.entries(targets))
      v.enginePick[name] = await run(([x, y]) => machineryPack.enginePick(x, y), [x, y]);
    check(
      `${samples}x engine.pick returns the packed part hit`,
      Object.entries(v.enginePick).every(([name, hit]) => name === hit),
      v.enginePick,
    );
    await run(() => machineryPack.attachPicking());
    v.capture = await run(() => machineryPack.frame());
    v.picking = {};
    for (const [name, [x, y]] of Object.entries(targets))
      v.picking[name] = await run(([x, y]) => machineryPack.picking(x, y), [x, y]);
    check(
      `${samples}x Picking.pick returns the packed part hit`,
      Object.entries(v.picking).every(([name, hit]) => name === hit),
      v.picking,
    );
    if (samples === 1)
      check('1x selection id pass (partIds) drew the pack one part at a time', v.capture.single === 1000, {
        perPartDraws: v.capture.single,
        frame: v.capture,
      });
    await run(() => machineryPack.removePicking());
    await run(() => machineryPack.attachSection());
    const points = {
      capProbe: [176, 112],
      beautyRemoved: [243, 146],
      shadowRemovedProbe: [336, 112],
      shadowRemovedFront: [368, 147],
      shadowKept: [272, 112],
      wallUncut: [320, 224],
    };
    const capture = async (name, enabled, caster, parts = false) => {
      const state = await run(([e, c, p]) => machineryPack.section(e, c, p), [enabled, caster, parts]),
        image = await shot(`${samples}x-${name}`);
      assert.equal(state.sampleCount, samples, 'actual render sample count');
      return {
        state,
        image,
        pixels: Object.fromEntries(Object.entries(points).map(([key, point]) => [key, pixel(image, point)])),
      };
    };
    const full = await capture('full', false, true),
      clipped = await capture('clipped', true, true),
      lit = await capture('no-caster', true, false),
      f = full.pixels,
      c = clipped.pixels,
      l = lit.pixels;
    v.pixels = { full: f, clipped: c, noCaster: l, capColor };
    check(
      `${samples}x section draws a cap on the packed part`,
      distance(c.capProbe, capColor) <= 3 && distance(f.capProbe, c.capProbe) >= 30,
      {
        full: f.capProbe,
        clipped: c.capProbe,
        expected: capColor,
      },
    );
    for (const key of ['shadowRemovedProbe', 'shadowRemovedFront'])
      check(
        `${samples}x section removes the shadow of the cut (${key})`,
        brightness(l[key]) - brightness(f[key]) >= 30 && distance(c[key], l[key]) <= 3,
        { full: f[key], clipped: c[key], noCaster: l[key] },
      );
    check(
      `${samples}x shadow of the kept half stays`,
      brightness(l.shadowKept) - brightness(c.shadowKept) >= 30 && distance(c.shadowKept, f.shadowKept) <= 3,
      { full: f.shadowKept, clipped: c.shadowKept, noCaster: l.shadowKept },
    );
    check(
      `${samples}x the section misses the wall`,
      distance(c.wallUncut, f.wallUncut) <= 2 && distance(c.wallUncut, l.wallUncut) <= 2,
      {
        full: f.wallUncut,
        clipped: c.wallUncut,
        noCaster: l.wallUncut,
      },
    );
    // Same clipped, shadowed, capped frame drawn from the pack and from the parts' own draws.
    const packedFrame = await capture('packed-with-part-casters', true, true, true);
    await run(() => machineryPack.setPack(false));
    const ownFrame = await capture('unpacked-with-part-casters', true, true, true);
    await run(() => machineryPack.setPack(true));
    // The fully cut part removed by hiding it instead: what the wall behind it looks like without it.
    await run(() => machineryPack.hide('front'));
    const without = await capture('front-hidden', true, true),
      w = without.pixels;
    v.pixels.frontHidden = w;
    check(
      `${samples}x section removes the fully cut part's beauty pixels`,
      distance(c.beautyRemoved, w.beautyRemoved) <= 2 && distance(f.beautyRemoved, c.beautyRemoved) >= 30,
      { full: f.beautyRemoved, clipped: c.beautyRemoved, partHidden: w.beautyRemoved },
    );
    let differing = 0,
      largest = 0;
    for (let i = 0; i < packedFrame.image.data.length; i += 4) {
      const d = distance(
        Array.from(packedFrame.image.data.subarray(i, i + 3)),
        Array.from(ownFrame.image.data.subarray(i, i + 3)),
      );
      largest = Math.max(largest, d);
      if (d > 2) differing++;
    }
    v.packVsOwn = {
      differing,
      largest,
      pixels: packedFrame.image.width * packedFrame.image.height,
      draws: [packedFrame.state.draws, ownFrame.state.draws],
    };
    check(`${samples}x packed and per-part frames match (beauty, shadow, cap)`, differing <= 64, v.packVsOwn);
    await run(() => machineryPack.dispose());
  }

  await page.goto(`http://127.0.0.1:${port}/tests/machinery-pack.html?scenario=gltf`);
  await page.waitForFunction(() => window.machineryPack, null, { timeout: 60_000 });
  const g = (report.values.gltf = await page.evaluate(() => ({
    names: machineryPack.names,
    vertices: machineryPack.vertices,
    distinctArrays: machineryPack.distinctArrays,
  })));
  g.before = await page.evaluate(() => machineryPack.before());
  await page.evaluate(() => machineryPack.frame());
  const beforeImage = await shot('gltf-before');
  g.dedup = await page.evaluate(() => machineryPack.dedup());
  g.after = await page.evaluate(() => machineryPack.after());
  await page.evaluate(() => machineryPack.frame());
  const afterImage = await shot('gltf-after');
  let changed = 0;
  for (let i = 0; i < beforeImage.data.length; i++) if (beforeImage.data[i] !== afterImage.data[i]) changed++;
  g.changedBytes = changed;
  const same = (x, y) => x[0] === y[0] && x[1] === y[1],
    { before, after } = g;
  check(
    'glTF fixture: four 24-vertex primitives with distinct CPU arrays',
    g.distinctArrays === 4 && g.vertices.every((n) => n === 24),
    g,
  );
  check('glTF before dedup: four distinct GPU buffer pairs', new Set(Object.values(before).flat()).size === 8, before);
  check(
    'glTF after dedup: static-a and static-b share one GPU buffer pair',
    same(after['static-a'], after['static-b']),
    after,
  );
  check(
    'glTF after dedup: the skinned and morphed primitives keep their own pair',
    same(after.skinned, before.skinned) &&
      same(after.morphed, before.morphed) &&
      !same(after.skinned, after['static-a']) &&
      !same(after.morphed, after['static-a']),
    after,
  );
  check('glTF rendering unchanged by buffer sharing', changed === 0, { changedBytes: changed });
  await page.evaluate(() => machineryPack.dispose());

  await page.goto(`http://127.0.0.1:${port}/tests/machinery-pack.html?scenario=step`);
  await page.waitForFunction(() => window.machineryPack, null, { timeout: 120_000 });
  const s = (report.values.step = { direct: await page.evaluate(() => machineryPack.direct) });
  s.omitted = await page.evaluate(() => machineryPack.load({}));
  s.coarse = await page.evaluate(() => machineryPack.load({ linearDeflection: 0.001 }));
  s.fine = await page.evaluate(() => machineryPack.load({ linearDeflection: 0.000001 }));
  check(
    'rounded-cube.step: omitting linearDeflection keeps the direct OpenCascade triangle count',
    s.omitted === s.direct,
    s,
  );
  check(
    'rounded-cube.step: setting linearDeflection changes the triangle count',
    s.coarse < s.omitted && s.fine > s.omitted,
    s,
  );
  check('No browser errors', pageErrors.length === 0, pageErrors);
  await writeFile(`${output}/gpu.json`, JSON.stringify(report, null, 2) + '\n');
  console.log(`Hardware: ${JSON.stringify(report.hardware.webgpu)}`);
  for (const { name, pass, actual } of report.checks)
    console.log(`${pass ? 'PASS' : 'FAIL'} ${name}: ${JSON.stringify(actual)}`);
  console.log(
    `Checks ${report.checks.length}; passed ${report.checks.length - report.failures.length}; failed ${report.failures.length}`,
  );
  assert.deepEqual(report.failures, [], 'Machinery pack real-GPU assertions');
} finally {
  await browser?.page.evaluate(() => window.machineryPack?.dispose?.()).catch(() => {});
  await browser?.close();
  release?.();
}
