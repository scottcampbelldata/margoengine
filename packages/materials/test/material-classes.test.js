// One class per shading model: fixed shading, typed options passed through, core PbrMaterial defaults, tree-shaking.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { PbrMaterial as CorePbrMaterial } from '../../core/dist/index.js';
import {
  Material,
  UnlitMaterial,
  LambertMaterial,
  PhongMaterial,
  PbrMaterial,
  NormalMaterial,
  MatcapMaterial,
  DepthMaterial,
  DistanceMaterial,
} from '../dist/index.js';

test('each class is a Material with its shading fixed, whatever options say', () => {
  for (const [Class, shading] of [
    [UnlitMaterial, 'basic'],
    [LambertMaterial, 'lambert'],
    [PhongMaterial, 'phong'],
    [PbrMaterial, 'standard'],
    [NormalMaterial, 'normal'],
    [MatcapMaterial, 'matcap'],
    [DepthMaterial, 'depth'],
    [DistanceMaterial, 'distance'],
  ]) {
    const m = new Class({ shading: 'normal' === shading ? 'basic' : 'normal' });
    assert.ok(m instanceof Material, Class.name);
    assert.equal(m.shading, shading, Class.name);
    assert.equal(new Class().shading, shading);
  }
  const phong = new PhongMaterial({ specular: '#ffffff', shininess: 64, opacity: 0.5 });
  assert.deepEqual(phong.specular, [1, 1, 1]);
  assert.equal(phong.shininess, 64);
  assert.equal(phong.opacity, 0.5);
  assert.equal(new DistanceMaterial({ farDistance: 50 }).farDistance, 50);
  assert.equal(new DistanceMaterial().depthPacking, 'rgba', 'distance keeps its packing default');
  assert.equal(new DepthMaterial().depthPacking, 'basic');
  // Options that need another model still fail as on Material.
  assert.throws(() => new LambertMaterial({ specular: '#fff' }), /phong/);
  assert.throws(() => new UnlitMaterial({ clearcoat: 1 }), /standard shading/);
});

test('PbrMaterial takes core PbrMaterial options with the same meaning, and untinted textured defaults', () => {
  const pbr = new PbrMaterial();
  assert.deepEqual(pbr.color, [1, 1, 1, 1], 'white, so a map shows its own colours');
  assert.deepEqual([pbr.roughness, pbr.metalness, pbr.doubleSided], [1, 0, false]);
  const options = { color: '#84d6bd', roughness: 0.3, metalness: 1, doubleSided: false },
    a = new CorePbrMaterial(options),
    b = new PbrMaterial(options);
  for (let k = 0; k < 3; k++) assert.ok(Math.abs(b.color[k] - a.data[k]) < 1e-6);
  assert.deepEqual([b.roughness, b.metalness, b.doubleSided], [0.3, 1, false]);
  assert.deepEqual(new PbrMaterial({ color: [0.1, 0.2, 0.3] }).color, [0.1, 0.2, 0.3, 1], 'linear arrays as core');
  assert.equal(new PbrMaterial({ doubleSided: true }).side, 'double', 'core doubleSided means the same');
  assert.equal(new PbrMaterial({ clearcoat: 1 }).clearcoat, 1, 'physical options');
  assert.equal(new Material().roughness, 1, 'Material keeps its own defaults');
});

test('an app that imports only Material ships none of the classes', async () => {
  const entry = fileURLToPath(new URL('../dist/index.js', import.meta.url)).replaceAll('\\', '/');
  const result = await build({
    configFile: false,
    publicDir: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'entry',
        resolveId: (id) => (id === 'entry' ? id : undefined),
        load: (id) =>
          id === 'entry' ? `import {Material} from '${entry}'; globalThis.m = new Material();` : undefined,
      },
    ],
    build: {
      write: false,
      minify: false,
      rollupOptions: { input: 'entry', external: (id) => id.startsWith('@margoengine/') },
    },
  });
  const out = Array.isArray(result) ? result[0] : result,
    code = out.output.map((c) => c.code ?? '').join('\n');
  // dist is minified, so the classes show as their fixed shading literals.
  assert.ok(code.includes('Material specular and shininess need phong shading'), 'the entry bundles Material');
  assert.equal(code.match(/shading: ?"\w+"/g), null, 'no subclass survives');
});
