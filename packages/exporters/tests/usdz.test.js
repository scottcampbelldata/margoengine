import test from 'node:test';
import assert from 'node:assert/strict';
import { box, PbrMaterial } from '@margoengine/core';
import { exportUSDZ } from '../dist/index.js';
import { parseUSDZ, readZipDirectory, readZipEntry } from '@margoengine/loaders';
import { headlessEngine } from './helpers.js';
test('USDZ packages world-space reflected hierarchy and PreviewSurface colors', async () => {
  const engine = await headlessEngine();
  const parent = engine.createMesh().setPosition([1, 2, 3]).setScale([-2, 1, 1]);
  const mesh = engine
    .createMesh(parent)
    .setGeometry(box())
    .setPosition([0.5, 0, 0])
    .setMaterial(new PbrMaterial({ color: '#ff0000', roughness: 0.25, metalness: 0.5 }));
  mesh.name = 'Quoted "mesh"';
  engine.createMesh().setGeometry(box()).visible = false;
  const archive = exportUSDZ(engine),
    entries = readZipDirectory(archive);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, 'scene.usda');
  assert.equal(entries[0].method, 0);
  const view = new DataView(archive.buffer),
    offset = 30 + view.getUint16(26, true) + view.getUint16(28, true);
  assert.equal(offset % 64, 0);
  const source = new TextDecoder().decode(await readZipEntry(archive, entries[0]));
  assert.match(source, /defaultPrim = "Margo"/);
  assert.match(source, /UsdPreviewSurface/);
  assert.match(source, /inputs:roughness = 0.25/);
  const parsed = await parseUSDZ(archive);
  assert.equal(parsed.groups.length, 1);
  assert.equal(parsed.groups[0].name, mesh.name);
  assert.ok(Math.abs(parsed.groups[0].color[0] - 1) < 1e-6);
  assert.equal(parsed.indices.length, 36);
  const xs = Array.from(parsed.positions).filter((_, i) => i % 3 === 0);
  assert.equal(Math.min(...xs), -1);
  assert.equal(Math.max(...xs), 1);
  engine.dispose();
});
test('USDZ rejects unsupported appearance and an empty scene', () => {
  assert.throws(() => exportUSDZ({ nodes: [] }), /at least one mesh/);
  assert.throws(
    () =>
      exportUSDZ({
        nodes: [
          {
            geometry: box(),
            material: { normalTexture: { image: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), mimeType: 'image/jpeg' } },
          },
        ],
      }),
    /texture/,
  );
  assert.throws(() => exportUSDZ({ nodes: [{ geometry: box(), material: { alphaMode: 'MASK' } }] }), /alpha-mask/);
  assert.throws(
    () =>
      exportUSDZ({
        nodes: [{ scale: [1e30, 1e30, 1e30], children: [{ geometry: box(), scale: [1e30, 1e30, 1e30] }] }],
      }),
    /Float32/,
  );
});

test('USDZ preserves linear AO vertex colors and alpha in connected PreviewSurface primvars', async () => {
  const geometry = {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    colors: new Float32Array([1, 0.5, 0.25, 1, 0.25, 0.5, 1, 0.5, 0, 1, 0.5, 0]),
  };
  const archive = exportUSDZ({
    nodes: [
      {
        name: 'parent',
        translation: [4, 0, 0],
        children: [
          {
            name: 'AO',
            geometry,
            material: {
              color: [0.5, 0.25, 1, 0.5],
              alphaMode: 'BLEND',
              roughness: 0.2,
              metalness: 0.3,
              emissive: [0.1, 0.2, 0.3],
            },
          },
        ],
      },
    ],
  });
  const [entry] = readZipDirectory(archive);
  const source = new TextDecoder().decode(await readZipEntry(archive, entry));
  const values = (name) =>
    [...source.match(new RegExp(`${name} = \\[([^\\]]+)\\]`))[1].matchAll(/[-+]?\d*\.?\d+(?:e[-+]?\d+)?/g)].map((v) =>
      Number(v[0]),
    );
  assert.deepEqual(values('primvars:displayColor'), [0.5, 0.125, 0.25, 0.125, 0.125, 1, 0, 0.25, 0.5]);
  assert.deepEqual(values('primvars:displayOpacity'), [0.5, 0.25, 0]);
  assert.match(source, /primvars:displayColor = .*\(interpolation = "vertex"\)/);
  assert.match(source, /info:id = "UsdPrimvarReader_float3"/);
  assert.match(source, /string inputs:varname = "displayColor"/);
  assert.match(source, /inputs:diffuseColor.connect = <\/Margo\/Material_0\/Color.outputs:result>/);
  assert.match(source, /inputs:opacity.connect = <\/Margo\/Material_0\/Opacity.outputs:result>/);
  assert.match(source, /inputs:roughness = 0.2/);
  assert.match(source, /inputs:metallic = 0.3/);
  assert.deepEqual(values('points'), [4, 0, 0, 5, 0, 0, 4, 1, 0]);
  assert.deepEqual([...geometry.colors], [1, 0.5, 0.25, 1, 0.25, 0.5, 1, 0.5, 0, 1, 0.5, 0]);
  const parsed = await parseUSDZ(archive);
  const linear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const expected = [0.5, 0.125, 0.25, 0.125, 0.125, 1, 0, 0.25, 0.5];
  parsed.colors.forEach((v, i) => assert.ok(Math.abs(linear(v) - expected[i]) < 1e-6));
  assert.deepEqual([...parsed.attributes.opacity], [0.5, 0.25, 0]);
  assert.equal(parsed.groups[0].color, undefined, 'precombined vertex color must not be tinted twice');
});
