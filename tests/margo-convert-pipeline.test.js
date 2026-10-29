// margo-convert build / optimize (tools/margo-convert/pipeline): meshopt encoder round trips against Margo's decoder,
// golden round trips of the repository's sample models (the output validates, loads in Margo and matches the input
// triangle for triangle within the quantisation step), size reductions, presets, incremental builds and the CLI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { meshoptDecodeGltfBuffer } from '@margoengine/decoders/meshopt';
import { parseGLTFAsync } from '@margoengine/gltf-pro';
import { encodeTriangles, encodeVertexBuffer } from '../tools/margo-convert/pipeline/meshopt-encode.js';
import { optimizeModel } from '../tools/margo-convert/pipeline/optimize.js';
import { build, sha256 } from '../tools/margo-convert/pipeline/build.js';
import { PRESET_NAMES, PRESETS, preset } from '../tools/margo-convert/pipeline/presets.js';
import { boundsOf, matchTriangles, worldTriangles } from './support/convert-geometry.js';
import { headless, headlessModels } from './support/pbr-snapshot.js';

const root = resolve(import.meta.dirname, '..'),
  require = createRequire(join(root, 'package.json')),
  validator = require('gltf-validator'),
  cli = join(root, 'tools/margo-convert/cli.js');
const at = (path) => join(root, path);
const read = (path) => new Uint8Array(readFileSync(at(path)));

/** Deterministic pseudo-random numbers so a failure reproduces. */
function random(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

test('meshopt attribute encoder round-trips through the decoder for many strides and counts', {
  timeout: 60_000,
}, () => {
  const rand = random(7);
  for (const [count, size] of [
    [1, 4],
    [15, 4],
    [16, 8],
    [17, 8],
    [300, 12],
    [513, 16],
    [1000, 24],
    [4097, 32],
    [64, 256],
  ]) {
    const data = new Uint8Array(count * size);
    for (let i = 0; i < data.length; i++) data[i] = rand() < 0.3 ? Math.floor(rand() * 256) : (i >> 5) & 255;
    const encoded = encodeVertexBuffer(data, count, size);
    assert.deepEqual(meshoptDecodeGltfBuffer(encoded, count, size, 'ATTRIBUTES'), data, `${count} x ${size}`);
  }
  assert.throws(() => encodeVertexBuffer(new Uint8Array(6), 1, 6), RangeError);
});

test('meshopt triangle encoder: grid, random soup and renumbering decode to the same triangles', {
  timeout: 60_000,
}, () => {
  const canon = (a, b, c) => (a <= b && a <= c ? [a, b, c] : b <= c ? [b, c, a] : [c, a, b]).join();
  const check = (indices, vertices) => {
    const { bytes, remap, indices: renumbered } = encodeTriangles(indices, vertices);
    const decoded = new Uint32Array(meshoptDecodeGltfBuffer(bytes, indices.length, 4, 'TRIANGLES').buffer);
    assert.deepEqual([...decoded], [...renumbered]);
    assert.equal(new Set(remap).size, vertices, 'remap is a permutation');
    for (let t = 0; t < indices.length; t += 3)
      assert.equal(
        canon(decoded[t], decoded[t + 1], decoded[t + 2]),
        canon(remap[indices[t]], remap[indices[t + 1]], remap[indices[t + 2]]),
      );
    return bytes.length;
  };
  const rand = random(11),
    N = 40,
    grid = [];
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const a = y * (N + 1) + x;
      grid.push(a, a + N + 1, a + 1, a + 1, a + N + 1, a + N + 2);
    }
  const V = (N + 1) * (N + 1),
    perm = [...Array(V).keys()].sort(() => rand() - 0.5);
  const bytes = check(
    grid.map((i) => perm[i]),
    V,
  );
  assert.ok(bytes < grid.length * 4 * 0.2, `grid compresses below 20% of raw (${bytes} of ${grid.length * 4})`);
  for (let trial = 0; trial < 300; trial++) {
    const nv = 3 + Math.floor(rand() * 20),
      soup = [];
    for (let t = 0, n = 1 + Math.floor(rand() * 10); t < n; ) {
      const a = Math.floor(rand() * nv),
        b = Math.floor(rand() * nv),
        c = Math.floor(rand() * nv);
      if (a === b || b === c || a === c) continue;
      soup.push(a, b, c);
      t++;
    }
    check(soup, nv);
  }
  assert.throws(() => encodeTriangles([0, 1, 2, 3], 4), RangeError);
});

/** Models the pipeline must reproduce exactly. [path, expected minimum size reduction] */
const SAMPLES = [
  ['examples/assets/khronos/Fox/Fox.glb', 0.3],
  ['examples/assets/khronos/RiggedFigure/RiggedFigure.glb', 0.3],
  ['examples/assets/khronos/MorphStressTest/MorphStressTest.glb', 0.02],
  ['examples/assets/khronos/OrientationTest/OrientationTest.glb', 0.3],
  ['examples/assets/khronos/NegativeScaleTest/NegativeScaleTest.glb', 0.2],
  ['examples/assets/kaykit/adventurers/characters/Knight.glb', 0.4],
  ['examples/assets/robot-expressive.glb', 0.3],
  ['examples/assets/khronos/BoxVertexColors/BoxVertexColors.glb', 0],
  ['packages/exporters/tests/fixtures/Box.glb', 0],
];

const quantizedPreset = (name) => name !== 'unity';

async function loadsInMargo(glb) {
  const model = await headlessModels(async () => parseGLTFAsync(await headless(), glb.slice()));
  return {
    triangles: model.primitives.reduce((n, p) => n + p.indices.length / 3, 0),
    bounds: [...model.bounds],
  };
}

for (const [path, minimum] of SAMPLES) {
  for (const name of ['web', 'mobile', 'unity']) {
    test(`${name} preset on ${path.split('/').pop()}: valid, loads in Margo, same triangles`, {
      timeout: 120_000,
    }, async () => {
      const input = read(path),
        result = await optimizeModel(input, preset(name).model);
      assert.equal(result.skipped, null);
      const report = await validator.validateBytes(result.glb, { maxIssues: 50 });
      // The input may carry errors of its own (robot-expressive has unnormalised skin weights); never more than it had.
      const origin = await validator.validateBytes(input, { maxIssues: 0 });
      assert.ok(
        report.issues.numErrors <= origin.issues.numErrors,
        JSON.stringify(report.issues.messages.filter((m) => m.severity === 0).slice(0, 3)),
      );
      if (quantizedPreset(name)) assert.equal(report.issues.numErrors, 0, 'quantised output validates');

      const before = worldTriangles(input),
        after = worldTriangles(result.glb),
        b = boundsOf(before),
        diagonal = Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]);
      const quantized = quantizedPreset(name);
      // int16 positions are within half a step of the mesh half-extent; the plain preset must be exact.
      const tolerance = quantized ? diagonal * 3e-5 : diagonal * 1e-7;
      const { worst, worstNormal } = matchTriangles(before, after, tolerance);
      if (!quantized) assert.ok(worst <= tolerance);
      // 8-bit normals are within one step (2/254 per component, plus the renormalisation).
      assert.ok(worstNormal <= (quantized ? 0.02 : 1e-6), `normals deviate by ${worstNormal}`);

      const loaded = await loadsInMargo(result.glb),
        original = await loadsInMargo(input);
      assert.equal(loaded.triangles, before.length, 'Margo sees the same triangles');
      for (let i = 0; i < 6; i++)
        assert.ok(Math.abs(loaded.bounds[i] - original.bounds[i]) <= diagonal * 1e-4, `bounds[${i}]`);

      if (name === 'web')
        assert.ok(
          result.glb.length <= input.length * (1 - minimum),
          `${path}: ${input.length} -> ${result.glb.length}`,
        );
      assert.ok(result.glb.length <= input.length, 'never larger than the input');
      if (name === 'web') assert.ok(result.compressedViews > 0 || input.length < 4000, 'meshopt was used');
    });
  }
}

test('web preset makes the sample models much smaller overall', { timeout: 300_000 }, async () => {
  let before = 0,
    after = 0;
  for (const [path] of SAMPLES) {
    const input = read(path);
    before += input.length;
    after += (await optimizeModel(input, preset('web').model)).glb.length;
  }
  assert.ok(after < before * 0.7, `${before} -> ${after}`);
});

test('a .gltf with external files becomes one GLB with the same triangles', { timeout: 60_000 }, async () => {
  const dir = at('examples/assets/kaykit/adventurers/props'),
    file = join(dir, 'dagger.gltf');
  const resolveUri = (uri) => new Uint8Array(readFileSync(join(dir, uri)));
  const input = new Uint8Array(readFileSync(file)),
    result = await optimizeModel(input, preset('web').model, { resolve: resolveUri });
  assert.equal(result.skipped, null);
  const json = JSON.parse(
    new TextDecoder().decode(
      result.glb.subarray(20, 20 + new DataView(result.glb.buffer, result.glb.byteOffset).getUint32(12, true)),
    ),
  );
  assert.ok(
    json.buffers.every((b) => b.uri === undefined),
    'no external buffer uri left',
  );
  assert.ok(
    json.images?.every((i) => i.uri === undefined && i.bufferView !== undefined),
    'images are embedded',
  );
  const before = worldTriangles(input, resolveUri),
    after = worldTriangles(result.glb),
    b = boundsOf(before);
  matchTriangles(before, after, Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]) * 3e-5);
  assert.match((await optimizeModel(input, preset('web').model)).skipped ?? '', /external file .* needs a folder/);
});

test('a Draco model is passed through untouched with the reason', { timeout: 30_000 }, async () => {
  const input = read('examples/assets/tokyo-diorama.glb'),
    result = await optimizeModel(input, preset('web').model);
  assert.match(result.skipped ?? '', /KHR_draco_mesh_compression/);
  assert.equal(result.glb, input);
});

test('every preset is defined with the documented fields', () => {
  assert.deepEqual([...PRESET_NAMES], ['web', 'mobile', 'unity', 'unreal', 'godot', 'roblox']);
  for (const name of PRESET_NAMES) {
    const p = PRESETS[name];
    assert.ok(p.title && p.summary, name);
    assert.ok(p.texture.maxSize >= 256 && p.texture.quality >= 1 && p.texture.quality <= 100, name);
    assert.equal(typeof p.audio.requireCompressed, 'boolean');
  }
  assert.throws(() => preset('ps5'), /unknown preset "ps5"; use one of web, mobile, unity, unreal, godot, roblox/);
  // Game-engine presets keep the hierarchy and write no extension a game importer may not know.
  for (const name of ['unity', 'unreal', 'godot', 'roblox']) {
    assert.equal(PRESETS[name].model.meshopt, false);
    assert.equal(PRESETS[name].model.quantize, false);
    assert.equal(PRESETS[name].model.merge, false);
    assert.equal(PRESETS[name].model.pruneEmptyNodes, false);
  }
  for (const name of ['web', 'mobile']) assert.equal(PRESETS[name].model.meshopt, true);
});

/** A scratch folder with a few models, a textured .gltf with its files, a texture and an unknown file. */
function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'margo-convert-'));
  const input = join(dir, 'in');
  mkdirSync(join(input, 'props'), { recursive: true });
  copyFileSync(at('examples/assets/khronos/Fox/Fox.glb'), join(input, 'Fox.glb'));
  copyFileSync(at('examples/assets/khronos/OrientationTest/OrientationTest.glb'), join(input, 'OrientationTest.glb'));
  for (const f of ['dagger.gltf', 'dagger.bin', 'rogue_texture.png'])
    copyFileSync(at(`examples/assets/kaykit/adventurers/props/${f}`), join(input, 'props', f));
  writeFileSync(join(input, 'notes.txt'), 'not an asset');
  return { dir, input, out: join(dir, 'out') };
}

test('build writes a manifest with sizes and hashes, a size report, and handles .gltf dependencies', {
  timeout: 120_000,
}, async () => {
  const w = workspace();
  try {
    const { manifest, report } = await build({ input: w.input, outDir: w.out });
    assert.equal(manifest.preset, 'web');
    const sources = manifest.files.map((f) => f.source);
    assert.deepEqual(
      sources,
      ['Fox.glb', 'OrientationTest.glb', 'props/dagger.gltf'],
      'dagger.bin and the png belong to the .gltf',
    );
    for (const f of manifest.files) {
      assert.equal(f.status, 'built');
      for (const o of f.outputs) {
        const bytes = readFileSync(join(w.out, o.path));
        assert.equal(o.bytes, bytes.length);
        assert.equal(o.sha256, sha256(bytes));
      }
    }
    assert.equal(manifest.totals.inputs, 3);
    assert.ok(manifest.totals.outputBytes < manifest.totals.inputBytes * 0.7);
    assert.equal(JSON.parse(readFileSync(join(w.out, 'margo-manifest.json'), 'utf8')).totals.inputs, 3);
    assert.match(report, /Fox\.glb\s+model\s+built/);
    assert.match(report, /ignored 1 file/);
    assert.equal(readFileSync(join(w.out, 'margo-size-report.txt'), 'utf8'), report);
    const dagger = manifest.files.find((f) => f.source === 'props/dagger.gltf');
    assert.equal(dagger.outputs[0].path, 'props/dagger.glb');
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
});

test('build converts no CAD file: a .step file is listed as ignored, not built (CAD conversion left the pipeline)', {
  timeout: 120_000,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'margo-convert-')),
    input = join(dir, 'in');
  try {
    mkdirSync(input);
    copyFileSync(at('examples/assets/khronos/OrientationTest/OrientationTest.glb'), join(input, 'OrientationTest.glb'));
    writeFileSync(join(input, 'part.step'), 'not a model');
    const { manifest, report } = await build({ input, outDir: join(dir, 'out') });
    assert.deepEqual(
      manifest.files.map((f) => f.source),
      ['OrientationTest.glb'],
    );
    assert.match(report, /ignored 1 file that are not models, textures or audio/);
    assert.ok(!existsSync(join(dir, 'out', 'part.glb')), 'no GLB was converted from the .step file');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('incremental builds skip unchanged inputs and rebuild only what changed', { timeout: 180_000 }, async () => {
  const w = workspace();
  try {
    const first = await build({ input: w.input, outDir: w.out });
    const fox = first.manifest.files[0].outputs[0];
    const stamp = readFileSync(join(w.out, fox.path));

    const second = await build({ input: w.input, outDir: w.out });
    assert.deepEqual(
      second.manifest.files.map((f) => f.status),
      ['cached', 'cached', 'cached'],
    );
    assert.deepEqual(readFileSync(join(w.out, fox.path)), stamp);

    // The dagger's external texture changed: the .gltf alone rebuilds.
    const png = join(w.input, 'props', 'rogue_texture.png');
    writeFileSync(png, Buffer.concat([readFileSync(png), Buffer.from([0])]));
    const third = await build({ input: w.input, outDir: w.out });
    assert.deepEqual(
      third.manifest.files.map((f) => f.status),
      ['cached', 'cached', 'built'],
    );

    // A different preset has different settings: everything rebuilds.
    const mobile = await build({ input: w.input, outDir: w.out, preset: 'mobile' });
    assert.deepEqual(
      mobile.manifest.files.map((f) => f.status),
      ['built', 'built', 'built'],
    );
    assert.equal(mobile.manifest.preset, 'mobile');

    // A tampered output is detected and rebuilt, and --force rebuilds regardless.
    writeFileSync(join(w.out, 'Fox.glb'), 'broken');
    const healed = await build({ input: w.input, outDir: w.out, preset: 'mobile' });
    assert.deepEqual(
      healed.manifest.files.map((f) => f.status),
      ['built', 'cached', 'cached'],
    );
    const forced = await build({ input: w.input, outDir: w.out, preset: 'mobile', force: true });
    assert.ok(forced.manifest.files.every((f) => f.status === 'built'));

    // An input that disappears takes its output with it.
    rmSync(join(w.input, 'OrientationTest.glb'));
    const pruned = await build({ input: w.input, outDir: w.out, preset: 'mobile' });
    assert.deepEqual(
      pruned.manifest.files.map((f) => f.source),
      ['Fox.glb', 'props/dagger.gltf'],
    );
    assert.ok(!existsSync(join(w.out, 'OrientationTest.glb')), 'stale output removed');
    assert.ok(existsSync(join(w.out, 'Fox.glb')));

    // Hash names put the content hash in the file name; the manifest says where each file went.
    const hashed = await build({ input: w.input, outDir: join(w.dir, 'hashed'), hashNames: true });
    for (const f of hashed.manifest.files)
      for (const o of f.outputs) assert.ok(o.path.includes(`.${o.sha256.slice(0, 8)}.`), o.path);
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
});

test('build reports a failed input and keeps going; a missing input is an error', { timeout: 60_000 }, async () => {
  const w = workspace();
  try {
    writeFileSync(join(w.input, 'broken.glb'), 'glTFnot really');
    const { manifest } = await build({ input: w.input, outDir: w.out });
    const broken = manifest.files.find((f) => f.source === 'broken.glb');
    assert.equal(broken.status, 'failed');
    assert.ok(broken.notes[0].length > 0);
    assert.equal(manifest.totals.failed, 1);
    assert.equal(manifest.files.filter((f) => f.status === 'built').length, 3);
    await assert.rejects(build({ input: join(w.dir, 'nope'), outDir: w.out }), /does not exist/);
    await assert.rejects(build({ input: w.input, outDir: w.dir }), /would contain the input folder/);
    await assert.rejects(build({ input: w.input, outDir: w.out, preset: 'ps5' }), /unknown preset/);
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
});

test('CLI: build, optimize, help and errors', { timeout: 120_000 }, () => {
  const w = workspace();
  const run = (...args) => {
    try {
      return {
        code: 0,
        out: execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', stdio: 'pipe', timeout: 60_000 }),
      };
    } catch (e) {
      return { code: e.status, out: `${e.stdout}${e.stderr}` };
    }
  };
  try {
    const built = run('build', w.input, '--out', w.out, '--preset', 'unity');
    assert.equal(built.code, 0, built.out);
    assert.match(built.out, /margo-convert unity preset/);
    assert.ok(existsSync(join(w.out, 'margo-manifest.json')));
    assert.equal(JSON.parse(run('build', w.input, '--out', w.out, '--preset', 'unity', '--json').out).preset, 'unity');

    const single = join(w.dir, 'fox.optimized.glb');
    const optimized = run('optimize', join(w.input, 'Fox.glb'), single);
    assert.equal(optimized.code, 0, optimized.out);
    assert.match(optimized.out, /% smaller/);
    assert.ok(readFileSync(single).length < readFileSync(join(w.input, 'Fox.glb')).length);

    assert.match(run('build', '--help').out, /Presets:[\s\S]*roblox/);
    const bad = run('build', w.input, '--preset', 'ps5');
    assert.equal(bad.code, 1);
    assert.match(bad.out, /unknown preset "ps5"/);
    assert.equal(run('optimize', join(w.input, 'Fox.glb'), join(w.input, 'Fox.glb')).code, 1);
    assert.equal(run('build').code, 1);
    // Without a mode the CLI converts nothing: --help prints the build and optimize usage, anything else exits 1 with it.
    const help = run('--help');
    assert.equal(help.code, 0);
    assert.match(help.out, /^Usage:\n {2}margo-convert build /);
    for (const args of [[], ['part.step']]) {
      const none = run(...args);
      assert.equal(none.code, 1, args.join(' '));
      assert.match(none.out, /margo-convert optimize <model\.glb\|\.gltf>/, args.join(' '));
    }
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
});
