import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { encodeZIP } from '../../exporters/dist/archive.js';
import { readZipDirectory, readZipEntry } from '@margoengine/loaders/common';
import { cellIndex } from '../dist/index.js';
import { parseCUB, parseKV6, parseVMAX } from '../dist/formats-extra.js';

const fixture = (name) => new Uint8Array(readFileSync(new URL(`fixtures/formats-extra/${name}`, import.meta.url)));
const at = (file, x, y, z) => {
  const { grid } = file.models[0],
    i = grid.voxels[cellIndex(grid.size, x, y, z)];
  return [...file.palette.subarray(4 * i, 4 * i + 4)];
};
const cub = (size, rgb) => {
  const bytes = new Uint8Array(12 + rgb.length),
    dv = new DataView(bytes.buffer);
  size.forEach((v, i) => dv.setUint32(i * 4, v, true));
  bytes.set(rgb, 12);
  return bytes;
};
function kv6() {
  const bytes = new Uint8Array(32 + 4 * 8 + 4 + 2),
    dv = new DataView(bytes.buffer);
  dv.setUint32(0, 0x6c78764b, true);
  [1, 1, 6].forEach((v, i) => dv.setUint32(4 + 4 * i, v, true));
  [0.25, 0.5, 1.5].forEach((v, i) => dv.setFloat32(16 + 4 * i, v, true));
  dv.setUint32(28, 4, true);
  // A solid span 0..2, then air, then 4 and 5; interiors inherit the preceding surface colour.
  for (const [i, z, flags, color] of [
    [0, 0, 16, [3, 2, 1]],
    [1, 2, 32, [6, 5, 4]],
    [2, 4, 16, [9, 8, 7]],
    [3, 5, 32, [12, 11, 10]],
  ]) {
    bytes.set([...color, 128], 32 + 8 * i);
    dv.setUint16(36 + 8 * i, z, true);
    bytes[38 + 8 * i] = flags;
  }
  dv.setUint32(64, 4, true);
  dv.setUint16(68, 4, true);
  return bytes;
}
async function rewrite(sceneChange, payloadChange) {
  const input = fixture('snapshots.vmax'),
    entries = [];
  for (const entry of readZipDirectory(input)) {
    let data = await readZipEntry(input, entry);
    if (entry.name === 'scene.json')
      data = new TextEncoder().encode(JSON.stringify(sceneChange(JSON.parse(new TextDecoder().decode(data)))));
    else if (entry.name === 'contents.vmaxb' && payloadChange) data = payloadChange(data);
    entries.push({ name: entry.name, data });
  }
  return encodeZIP(entries);
}

test('KV6: surfaces, closed interiors, cavity, BGR, downward Z and fractional pivot', () => {
  const file = parseKV6(kv6());
  assert.deepEqual(file.models[0].grid.size, [1, 6, 1]);
  assert.deepEqual(file.pivot, [0.25, 4.5, 0.5]);
  assert.deepEqual(file.models[0].position, [-0.25, -4.5, -0.5]);
  assert.deepEqual(at(file, 0, 4, 0), [1, 2, 3, 255]);
  assert.deepEqual(at(file, 0, 2, 0), [0, 0, 0, 0]);
  assert.deepEqual(at(file, 0, 0, 0), [10, 11, 12, 255]);
  const padded = new Uint8Array(90);
  padded.set(kv6(), 5);
  assert.deepEqual(parseKV6(padded.subarray(5, 75)), file);
});

test('KV6: CC0 Arm includes 78 surface cells plus 8 implicit interior cells', () => {
  const file = parseKV6(fixture('arm.kv6'));
  assert.deepEqual(file.models[0].grid.size, [3, 12, 3]);
  assert.equal(file.models[0].grid.voxels.filter(Boolean).length, 86);
  assert.deepEqual(at(file, 0, 0, 1), [237, 182, 57, 255]);
  assert.equal(file.colorsReduced, false);
});

test('CUB: asymmetric axes and RGB layout match independent converter probes; black is air', () => {
  const rgb = new Uint8Array(72);
  for (const [x, y, z, c] of [
    [0, 0, 0, [255, 0, 0]],
    [1, 0, 0, [0, 255, 0]],
    [0, 2, 0, [0, 0, 255]],
    [0, 0, 3, [20, 30, 40]],
  ])
    rgb.set(c, 3 * (x + 2 * (y + 3 * z)));
  const file = parseCUB(cub([2, 3, 4], rgb));
  assert.deepEqual(file.models[0].grid.size, [2, 3, 4]);
  assert.deepEqual(at(file, 0, 2, 0), [0, 0, 255, 255]);
  assert.deepEqual(at(file, 0, 0, 3), [20, 30, 40, 255]);
  assert.deepEqual(at(file, 1, 2, 3), [0, 0, 0, 0]);
  assert.equal(file.models[0].grid.voxels.filter(Boolean).length, 4);
  const real = parseCUB(fixture('arm.cub'));
  assert.deepEqual(real.models[0].grid.size, [3, 3, 12]);
  assert.ok(real.models[0].grid.voxels.some(Boolean));
});

test('extra binary readers: budgets, malformed counts and every truncated prefix', () => {
  for (const [parse, bytes] of [
    [parseKV6, kv6()],
    [parseCUB, cub([1, 1, 1], [1, 2, 3])],
  ]) {
    for (let n = 0; n < bytes.length; n++) assert.throws(() => parse(bytes.subarray(0, n)));
    assert.throws(() => parse(bytes, { maxCells: 0 }), RangeError);
    assert.throws(() => parse(bytes, { maxCells: NaN }), RangeError);
  }
  const data = kv6(),
    dv = new DataView(data.buffer);
  assert.throws(() => parseKV6(data, { maxCells: 5 }), /size|cells/);
  dv.setUint32(64, 3, true);
  assert.throws(() => parseKV6(data), /counts disagree/);
  dv.setUint32(64, 4, true);
  dv.setUint16(44, 0, true);
  assert.throws(() => parseKV6(data), /unsorted/);
  assert.throws(() => parseCUB(cub([0xffffffff, 0xffffffff, 0xffffffff], [])), RangeError);
});

test('VMAX: compressed plist snapshots, last per chunk wins, Morton offsets, RGBA and materials', async () => {
  const file = await parseVMAX(fixture('snapshots.vmax')),
    model = file.models[0];
  assert.deepEqual(model.grid.size, [34, 2, 2]);
  assert.deepEqual(model.position, [12, 23, 34]);
  assert.equal(file.groups[0].name, 'group');
  assert.equal(model.node.parentId, 'g');
  assert.equal(model.grid.voxels.filter(Boolean).length, 3);
  assert.deepEqual(at(file, 33, 0, 1), [30, 220, 40, 128]);
  assert.deepEqual(at(file, 32, 1, 1), [50, 60, 210, 255]);
  assert.equal(model.materialSlots[cellIndex(model.grid.size, 33, 0, 1)], 7);
  assert.equal(model.settings.materials[0].rc, 0.2);
  assert.equal(model.settings.name, 'palette \u00e9toile');
  assert.equal(model.settings.signed, -241);
  assert.equal(file.scene.v, 1);
});

test('VMAX: both legacy chunk encodings and real CC0 model data', async () => {
  for (const name of ['legacy.vmax', 'legacy2.vmax']) {
    const file = await parseVMAX(fixture(name));
    assert.deepEqual(file.models[0].grid.size, [2, 1, 2]);
    assert.equal(file.models[0].grid.voxels.filter(Boolean).length, 2);
    assert.deepEqual(at(file, 1, 0, 1), [30, 220, 40, 128]);
  }
  const arm = await parseVMAX(fixture('arm.vmax'));
  assert.deepEqual(arm.models[0].grid.size, [3, 12, 3]);
  assert.equal(arm.models[0].grid.voxels.filter(Boolean).length, 78);
});

test('VMAX: PNG palettes, nested packages, plain plists and empty winning snapshots', async () => {
  const png = await parseVMAX(fixture('png.vmax')),
    settings = await parseVMAX(fixture('snapshots.vmax'));
  assert.deepEqual(png.palette, settings.palette);
  assert.deepEqual(png.models[0].grid, settings.models[0].grid);
  const empty = await parseVMAX(fixture('deleted.vmax'));
  assert.deepEqual(empty.models[0].grid.size, [1, 1, 1]);
  assert.equal(empty.models[0].grid.voxels[0], 0);
  await assert.rejects(parseVMAX(fixture('odd.vmax')), /chunk/);
  await assert.rejects(parseVMAX(fixture('overflow.vmax')), /chunk/);
});

test('VMAX: scale and axis-angle transforms compose through groups and around model center', async () => {
  const bytes = await rewrite((scene) => {
    scene.groups[0].t_r = [0, 0, 1, Math.PI / 2];
    scene.groups[0].t_s = [2, 2, 2];
    scene.objects[0].center = [1, 2, 3];
    return scene;
  });
  const file = await parseVMAX(bytes),
    m = file.models[0].gridToWorld;
  assert.ok(Math.abs(m[0]) < 1e-12);
  assert.equal(m[1], 2);
  assert.ok(Math.abs(m[12] - 8) < 1e-12);
  assert.ok(Math.abs(m[13] - 22) < 1e-12);
  assert.equal(m[14], 32);
});

test('VMAX: invalid hierarchy, corrupt payloads, missing data, archive limits and abort', async () => {
  for (const change of [
    (s) => {
      s.groups[0].pid = 'g';
      return s;
    },
    (s) => {
      s.objects[0].pid = 'missing';
      return s;
    },
    (s) => {
      s.objects[0].data = '../bad';
      return s;
    },
    (s) => {
      s.objects[0].id = 'g';
      return s;
    },
  ])
    await assert.rejects(parseVMAX(await rewrite(change)), RangeError);
  await assert.rejects(
    parseVMAX(
      await rewrite(
        (s) => s,
        () => Uint8Array.of(0),
      ),
    ),
    /plist/,
  );
  await assert.rejects(parseVMAX(fixture('snapshots.vmax'), { maxCells: 100 }), /size|cells/);
  await assert.rejects(parseVMAX(fixture('legacy.vmax'), { maxCells: 32767 }), /maxCells/);
  await assert.rejects(parseVMAX(fixture('snapshots.vmax'), { maxBytes: 100 }), /maxBytes/);
  await assert.rejects(parseVMAX(fixture('snapshots.vmax'), { maxEntries: 1 }), /entries/);
  const controller = new AbortController(),
    reason = new Error('stop');
  controller.abort(reason);
  await assert.rejects(
    parseVMAX(fixture('snapshots.vmax'), { signal: controller.signal }),
    (error) => error === reason,
  );
});
