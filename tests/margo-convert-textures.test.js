// margo-convert textures: sizes, the built-in area resize and PNG writer, mip chains in DDS, sharp-backed WebP / JPEG
// encoding when sharp is installed, the model texture pass and standalone texture files in `build`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseDDS } from '@margoengine/decoders/dds';
import { decodePNG } from '@margoengine/decoders/png';
import { parseGLTFAsync } from '@margoengine/gltf-pro';
import { build } from '../tools/margo-convert/pipeline/build.js';
import { optimizeModel } from '../tools/margo-convert/pipeline/optimize.js';
import { preset } from '../tools/margo-convert/pipeline/presets.js';
import {
  decodeRgba,
  encodeDDS,
  encodePNG,
  loadSharp,
  mipChain,
  processImage,
  resizeArea,
  roleOfName,
  targetSize,
} from '../tools/margo-convert/pipeline/textures.js';
import { headless, headlessModels } from './support/pbr-snapshot.js';

const root = resolve(import.meta.dirname, '..'),
  require = createRequire(join(root, 'package.json')),
  validator = require('gltf-validator'),
  cli = join(root, 'tools/margo-convert/cli.js');
const at = (path) => join(root, path);
const read = (path) => new Uint8Array(readFileSync(at(path)));
const sharp = await loadSharp();
const needsSharp = sharp ? {} : { skip: 'sharp is not installed' };

/** RGBA8 test picture: a diagonal gradient with some detail, optionally with alpha varying. */
function picture(width, height, alpha = false) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = (x * 255) / (width - 1);
      data[i + 1] = (y * 255) / (height - 1);
      data[i + 2] = ((x ^ y) & 31) * 8;
      // Photographic grain, so lossy coding has something to save.
      for (let k = 0; k < 3; k++)
        data[i + k] = Math.min(255, data[i + k] + ((Math.imul(i + k, 2654435761) >>> 24) & 15));
      data[i + 3] = alpha ? (x * 200) / width + 55 : 255;
    }
  return data;
}

test('targetSize: limit, power of two, multiple of four, never upscaled', () => {
  const p = (over) => ({ ...preset('web').texture, ...over });
  assert.deepEqual(targetSize(4096, 2048, p({ maxSize: 2048 })), { width: 2048, height: 1024 });
  assert.deepEqual(targetSize(1500, 900, p({ maxSize: 1024, powerOfTwo: 'down' })), { width: 1024, height: 512 });
  assert.deepEqual(targetSize(1001, 501, p({ maxSize: 4096, multipleOf: 4 })), { width: 1000, height: 500 });
  assert.deepEqual(targetSize(100, 50, p({ powerOfTwo: 'down' })), { width: 64, height: 32 });
  assert.deepEqual(targetSize(3, 2, p({ multipleOf: 4 })), { width: 3, height: 2 }, 'too small to round');
  assert.deepEqual(targetSize(512, 512, p({ maxSize: 1024 })), { width: 512, height: 512 }, 'no upscale');
});

test('roleOfName: normal maps, data maps and colour maps', () => {
  assert.equal(roleOfName('rock_normal.png'), 'normal');
  assert.equal(roleOfName('Brick_N.png'), 'normal');
  assert.equal(roleOfName('metal_roughness.png'), 'data');
  assert.equal(roleOfName('crate_ORM.png'), 'data');
  assert.equal(roleOfName('knight_texture.png'), 'color');
});

test('encodePNG round-trips every colour type exactly and picks the narrowest', () => {
  const w = 37,
    h = 23;
  const rgba = picture(w, h, true);
  const opaque = picture(w, h, false);
  const grey = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) grey.set([(i * 7) & 255, (i * 7) & 255, (i * 7) & 255, 255], i * 4);
  const greyAlpha = grey.slice();
  for (let i = 0; i < w * h; i++) greyAlpha[i * 4 + 3] = (i * 3) & 255;
  const colorTypeOf = (png) => png[25];
  for (const [pixels, type] of [
    [rgba, 6],
    [opaque, 2],
    [grey, 0],
    [greyAlpha, 4],
  ]) {
    const png = encodePNG(pixels, w, h);
    assert.equal(colorTypeOf(png), type);
    const back = decodePNG(png);
    assert.deepEqual([back.width, back.height], [w, h]);
    assert.deepEqual(back.data, pixels);
  }
});

test('resizeArea averages by overlapping area; colour in linear light, alpha-weighted', () => {
  // Data map: plain average, fractional overlaps.
  const row = Uint8Array.from([30, 0, 0, 255, 60, 0, 0, 255, 90, 0, 0, 255]);
  const out = resizeArea(row, 3, 1, 2, 1, false);
  assert.equal(out[0], 40);
  assert.equal(out[4], 80);
  // Constant colour stays constant at any ratio.
  const flat = new Uint8Array(17 * 9 * 4).fill(0);
  for (let i = 0; i < 17 * 9; i++) flat.set([200, 100, 50, 255], i * 4);
  const small = resizeArea(flat, 17, 9, 5, 3, true);
  for (let i = 0; i < 15; i++) assert.deepEqual([...small.subarray(i * 4, i * 4 + 4)], [200, 100, 50, 255]);
  // Black next to white averages to sRGB 188 (half the light), not 128.
  const bw = resizeArea(Uint8Array.from([0, 0, 0, 255, 255, 255, 255, 255]), 2, 1, 1, 1, true);
  assert.deepEqual([...bw], [188, 188, 188, 255]);
  const bwData = resizeArea(Uint8Array.from([0, 0, 0, 255, 255, 255, 255, 255]), 2, 1, 1, 1, false);
  assert.deepEqual([...bwData], [128, 128, 128, 255]);
  // A transparent neighbour does not darken the colour.
  const edge = resizeArea(Uint8Array.from([255, 0, 0, 255, 0, 255, 0, 0]), 2, 1, 1, 1, true);
  assert.deepEqual([...edge], [255, 0, 0, 128]);
});

test('mip chains: full length, last level 1x1, written as DDS that Margo reads back', () => {
  const w = 64,
    h = 20,
    pixels = picture(w, h, true);
  const levels = mipChain(pixels, w, h, true);
  assert.deepEqual(
    levels.map((l) => `${l.width}x${l.height}`),
    ['64x20', '32x10', '16x5', '8x2', '4x1', '2x1', '1x1'],
  );
  const dds = parseDDS(encodeDDS(levels));
  assert.equal(dds.format, 'rgba8unorm');
  assert.equal(dds.mipmaps.length, levels.length);
  assert.deepEqual(
    dds.mipmaps.map((l) => [l.width, l.height]),
    levels.map((l) => [l.width, l.height]),
  );
  assert.deepEqual(dds.mipmaps[0].data, pixels);
  assert.deepEqual(dds.mipmaps[3].data, levels[3].data);
});

test('processImage without sharp: PNG is resized and recompressed, other formats are left with the reason', {
  timeout: 60_000,
}, async () => {
  const web = { ...preset('web').texture, maxSize: 32 };
  const png = encodePNG(picture(100, 60, false), 100, 60);
  const result = await processImage(png, 'image/png', 'color', web, null);
  assert.equal(result.mimeType, 'image/png');
  assert.match(result.note, /needs sharp, kept PNG/);
  const back = decodePNG(result.bytes);
  assert.deepEqual([back.width, back.height], [32, 16], '32 x 19 rounded down to a multiple of 4');

  const jpeg = read('examples/assets/khronos/BoomBox/BoomBox.glb').subarray(0, 4);
  const kept = await processImage(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...jpeg]), 'image/jpeg', 'color', web, null);
  assert.equal(kept.mimeType, 'image/jpeg');
  assert.match(kept.note, /JPEG left as it is/);

  // Unchanged when already small enough and the rewrite is not smaller.
  const tiny = encodePNG(picture(8, 8, false), 8, 8);
  const same = await processImage(tiny, 'image/png', 'color', { ...web, maxSize: 64 }, null);
  assert.equal(same.bytes.length <= tiny.length, true);
});

test('processImage with sharp: lossy WebP for colour, lossless for data, JPEG stays JPEG when kept', {
  ...needsSharp,
  timeout: 60_000,
}, async () => {
  const w = 256,
    h = 128;
  const png = encodePNG(picture(w, h, true), w, h);
  const web = preset('web').texture;
  const colour = await processImage(png, 'image/png', 'color', web, sharp);
  assert.equal(colour.mimeType, 'image/webp');
  assert.ok(colour.bytes.length < png.length * 0.6, `${png.length} -> ${colour.bytes.length}`);
  const info = await sharp(colour.bytes).metadata();
  assert.deepEqual([info.width, info.height, info.format], [w, h, 'webp']);

  // A normal map is encoded losslessly: the pixels come back identical.
  const normal = await processImage(png, 'image/png', 'normal', web, sharp);
  const before = await decodeRgba(png, 'image/png', sharp),
    after = await decodeRgba(normal.bytes, normal.mimeType, sharp);
  assert.deepEqual(after.data, before.data);

  // Resizing to a power of two for the mobile preset.
  const mobile = await processImage(
    encodePNG(picture(300, 200, false), 300, 200),
    'image/png',
    'color',
    { ...preset('mobile').texture, maxSize: 128 },
    sharp,
  );
  const resized = await sharp(mobile.bytes).metadata();
  assert.deepEqual([resized.width, resized.height], [128, 64]);

  // `keep`: a JPEG stays a JPEG, untouched unless it has to be resized (then smaller, still a JPEG).
  const jpeg = new Uint8Array(
    await sharp(Buffer.from(decodePNG(png).data), { raw: { width: w, height: h, channels: 4 } })
      .removeAlpha()
      .jpeg({ quality: 98 })
      .toBuffer(),
  );
  const unity = preset('unity').texture;
  const same = await processImage(jpeg, 'image/jpeg', 'color', unity, sharp);
  assert.equal(same.bytes, jpeg, 'not resized: not re-encoded');
  const smaller = await processImage(jpeg, 'image/jpeg', 'color', { ...unity, maxSize: 64 }, sharp);
  assert.equal(smaller.mimeType, 'image/jpeg');
  assert.deepEqual(
    [(await sharp(smaller.bytes).metadata()).width, (await sharp(smaller.bytes).metadata()).height],
    [64, 32],
  );
});

async function loadsInMargo(glb) {
  const model = await headlessModels(async () => parseGLTFAsync(await headless(), glb.slice()));
  return model.primitives.reduce((n, p) => n + p.indices.length / 3, 0);
}

test('web preset shrinks the textures of a model: WebP through EXT_texture_webp, valid, loads in Margo', {
  ...needsSharp,
  timeout: 300_000,
}, async () => {
  const input = read('examples/assets/khronos/BoomBox/BoomBox.glb');
  const result = await optimizeModel(input, preset('web').model, {
    textures: { preset: preset('web').texture, sharp },
  });
  const report = await validator.validateBytes(result.glb, { maxIssues: 50 });
  assert.equal(
    report.issues.numErrors,
    0,
    JSON.stringify(report.issues.messages.filter((m) => m.severity === 0).slice(0, 3)),
  );
  assert.ok(result.glb.length < input.length * 0.5, `${input.length} -> ${result.glb.length}`);
  assert.ok(result.stats.imageBytesAfter < result.stats.imageBytesBefore * 0.5);
  const json = JSON.parse(
    new TextDecoder().decode(
      result.glb.subarray(20, 20 + new DataView(result.glb.buffer, result.glb.byteOffset).getUint32(12, true)),
    ),
  );
  assert.ok(json.extensionsRequired.includes('EXT_texture_webp'));
  // A texture points at WebP through the extension; one whose image was not smaller as WebP keeps its PNG.
  for (const t of json.textures) {
    const webp = t.extensions?.EXT_texture_webp;
    if (webp) {
      assert.equal(t.source, undefined);
      assert.equal(json.images[webp.source].mimeType, 'image/webp');
    } else assert.equal(json.images[t.source].mimeType, 'image/png');
  }
  assert.ok(json.textures.some((t) => t.extensions?.EXT_texture_webp));
  assert.equal(await loadsInMargo(result.glb), await loadsInMargo(input));
});

test('without sharp a model keeps its formats: PNG textures are recompressed and capped, the GLB stays valid', {
  timeout: 300_000,
}, async () => {
  const input = read('examples/assets/khronos/BoomBox/BoomBox.glb');
  const small = { ...preset('web').texture, maxSize: 256 };
  const result = await optimizeModel(input, preset('web').model, { textures: { preset: small, sharp: null } });
  const report = await validator.validateBytes(result.glb, { maxIssues: 50 });
  assert.equal(report.issues.numErrors, 0);
  assert.ok(result.glb.length < input.length * 0.15, `${input.length} -> ${result.glb.length}`);
  const json = JSON.parse(
    new TextDecoder().decode(
      result.glb.subarray(20, 20 + new DataView(result.glb.buffer, result.glb.byteOffset).getUint32(12, true)),
    ),
  );
  assert.ok(!(json.extensionsRequired ?? []).some((e) => e.startsWith('EXT_texture')));
  assert.ok(json.images.every((i) => i.mimeType === 'image/png'));
  assert.match(result.stats.notes.join('\n'), /needs sharp, kept PNG/);
});

test('game presets keep PNG and JPEG and write no texture extension', { ...needsSharp, timeout: 300_000 }, async () => {
  const input = read('examples/assets/khronos/BoomBox/BoomBox.glb');
  const unity = preset('unity');
  const result = await optimizeModel(input, unity.model, {
    textures: { preset: { ...unity.texture, maxSize: 512 }, sharp },
  });
  const json = JSON.parse(
    new TextDecoder().decode(
      result.glb.subarray(20, 20 + new DataView(result.glb.buffer, result.glb.byteOffset).getUint32(12, true)),
    ),
  );
  assert.deepEqual(json.extensionsRequired, undefined);
  assert.ok(json.images.every((i) => i.mimeType === 'image/png' || i.mimeType === 'image/jpeg'));
  assert.ok(result.glb.length < input.length * 0.2);
  const report = await validator.validateBytes(result.glb, { maxIssues: 50 });
  assert.equal(report.issues.numErrors, 0);
});

/** A folder with textures: one colour map, one normal map, a packed data map. */
function textureWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'margo-convert-tex-'));
  const input = join(dir, 'in');
  mkdirSync(input, { recursive: true });
  copyFileSync(
    at('examples/assets/kaykit/adventurers/characters/knight_texture.png'),
    join(input, 'knight_texture.png'),
  );
  writeFileSync(join(input, 'rock_normal.png'), encodePNG(picture(256, 256, false), 256, 256));
  writeFileSync(join(input, 'crate_orm.png'), encodePNG(picture(64, 64, false), 64, 64));
  return { dir, input, out: join(dir, 'out') };
}

test('build: standalone textures follow the preset (web: WebP, unity: PNG, mobile: power of two, --mipmaps: DDS)', {
  ...needsSharp,
  timeout: 300_000,
}, async () => {
  const w = textureWorkspace();
  try {
    const web = await build({ input: w.input, outDir: w.out });
    const names = web.manifest.files.flatMap((f) => f.outputs.map((o) => o.path)).sort();
    assert.deepEqual(
      names.filter((n) => !n.startsWith('crate_orm')),
      ['knight_texture.webp', 'rock_normal.webp'],
    );
    assert.ok(
      names.some((n) => /^crate_orm[.](webp|png)$/.test(n)),
      'the packed map keeps whichever format is smaller',
    );
    const normal = web.manifest.files.find((f) => f.source === 'rock_normal.png');
    assert.equal(normal.status, 'built');
    // The normal map is lossless: same pixels after the round trip.
    const back = await decodeRgba(new Uint8Array(readFileSync(join(w.out, 'rock_normal.webp'))), 'image/webp', sharp);
    assert.deepEqual(back.data, picture(256, 256, false));

    const unity = await build({ input: w.input, outDir: join(w.dir, 'unity'), preset: 'unity' });
    assert.ok(unity.manifest.files.every((f) => f.outputs.every((o) => o.path.endsWith('.png'))));

    const mips = await build({ input: w.input, outDir: join(w.dir, 'mips'), mipmaps: true });
    const dds = mips.manifest.files
      .find((f) => f.source === 'rock_normal.png')
      .outputs.find((o) => o.path.endsWith('.dds'));
    assert.ok(dds, 'a DDS with the mip chain is written next to the image');
    const file = parseDDS(new Uint8Array(readFileSync(join(w.dir, 'mips', dds.path))));
    assert.equal(file.mipmaps.length, 9);
    assert.deepEqual(file.mipmaps[0].data, picture(256, 256, false));
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
});

test('build: without sharp PNG textures are recompressed and the manifest says what WebP would need', {
  timeout: 120_000,
}, async () => {
  const w = textureWorkspace();
  try {
    const { manifest } = await build({
      input: w.input,
      outDir: w.out,
      sharp: false,
      overrides: { texture: { maxSize: 64 } },
    });
    assert.equal(manifest.encoders.sharp, null);
    for (const f of manifest.files) {
      assert.ok(f.outputs[0].path.endsWith('.png'));
      // A map whose PNG is already as small as it gets is copied unchanged.
      if (f.source === 'crate_orm.png') continue;
      assert.equal(f.status, 'built', f.source);
      assert.ok(
        f.notes.some((n) => /needs sharp, kept PNG/.test(n)),
        f.notes.join(),
      );
    }
    const rock = decodePNG(new Uint8Array(readFileSync(join(w.out, 'rock_normal.png'))));
    assert.deepEqual([rock.width, rock.height], [64, 64]);
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
});

test('CLI texture flags: --max-texture, --texture-format, --mipmaps', { timeout: 120_000 }, () => {
  const w = textureWorkspace();
  try {
    const out = execFileSync(
      process.execPath,
      [cli, 'build', w.input, '--out', w.out, '--preset', 'unity', '--max-texture', '32', '--mipmaps', '--json'],
      { encoding: 'utf8', timeout: 60_000 },
    );
    const manifest = JSON.parse(out);
    const rock = manifest.files.find((f) => f.source === 'rock_normal.png');
    assert.ok(rock.outputs.some((o) => o.path.endsWith('.dds')));
    const png = decodePNG(
      new Uint8Array(readFileSync(join(w.out, rock.outputs.find((o) => o.path.endsWith('.png')).path))),
    );
    assert.deepEqual([png.width, png.height], [32, 32]);
    assert.throws(
      () => execFileSync(process.execPath, [cli, 'build', w.input, '--texture-format', 'bmp'], { stdio: 'pipe' }),
      /texture-format/,
    );
    assert.ok(existsSync(join(w.out, 'margo-manifest.json')));
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
});

test('each preset sizes a 1500 x 900 texture by its own rule', { ...needsSharp, timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'margo-convert-sizes-'));
  try {
    const input = join(dir, 'in');
    mkdirSync(input, { recursive: true });
    writeFileSync(join(input, 'wall.png'), encodePNG(picture(1500, 900, false), 1500, 900));
    const expected = {
      web: [1500, 900, 'webp'],
      mobile: [1024, 512, 'webp'],
      unity: [1500, 900, 'png'],
      unreal: [1024, 512, 'png'],
      godot: [1500, 900, 'png'],
      roblox: [1024, 614, 'png'],
    };
    for (const [name, [width, height, format]] of Object.entries(expected)) {
      const { manifest } = await build({ input, outDir: join(dir, name), preset: name });
      const out = manifest.files[0].outputs[0];
      const info = await sharp(readFileSync(join(dir, name, out.path))).metadata();
      assert.deepEqual([name, info.width, info.height, info.format], [name, width, height, format]);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
