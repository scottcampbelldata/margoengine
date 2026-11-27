// The scene-copy transmission pass lives in gltf as its own lazy entry (KB4000, step 1): `@margoengine/gltf/transmission`
// holds `Transmission`, materials re-exports the same class instead of shipping a copy, and gltf's default model and
// loader entries do not import it statically, so a load that never meets KHR_materials_transmission never pays for it.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

const dist = new URL('../dist/', import.meta.url),
  materialsDist = new URL('../../materials/dist/', import.meta.url),
  manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('gltf/transmission is a package entry with its own build', () => {
  assert.deepEqual(manifest.exports['./transmission'], {
    types: './dist/transmission.d.ts',
    import: './dist/transmission.js',
  });
  assert.match(readFileSync(new URL('transmission.js', dist), 'utf8'), /transmission:copy/);
});

test('materials re-exports the gltf Transmission class itself', async () => {
  const gltf = await import('@margoengine/gltf/transmission'),
    materials = await import('@margoengine/materials/transmission');
  assert.equal(typeof gltf.Transmission, 'function');
  assert.equal(materials.Transmission, gltf.Transmission);
});

test('materials ships no copy of the scene-copy pass', () => {
  for (const file of readdirSync(materialsDist).filter((name) => name.endsWith('.js')))
    assert.doesNotMatch(
      readFileSync(new URL(file, materialsDist), 'utf8'),
      /transmission:copy/,
      `materials dist/${file} holds the pass`,
    );
});

test('the default model and loader entries import no transmission chunk statically', () => {
  for (const entry of ['pbr.js', 'model-entry.js', 'asset-entry.js']) {
    const code = readFileSync(new URL(entry, dist), 'utf8');
    assert.doesNotMatch(code, /^import[^;]*transmission/m, `${entry} imports the pass`);
    assert.doesNotMatch(code, /transmission:copy/, `${entry} holds the pass`);
  }
});

// KB4000 step 2: the pass takes a view only when it has a scene to read (an HDR or display PostStack target, or the
// native glass capture of the display target); a view with neither (an environment probe face, an external renderer
// pass) leaves gltf/pbr's transmissive primitives on the tinted blend instead of dropping them.
test('Transmission.takes is false for a view with no scene capture', async () => {
  const { Transmission } = await import('@margoengine/gltf/transmission');
  const pass = new Transmission();
  assert.equal(pass.takes({ backend: 'webgpu', color: {}, depth: {} }), false);
  pass.dispose();
  assert.equal(pass.takes({ backend: 'webgpu', color: {}, depth: {} }), false);
});

test('the PBR transmission hook leaves untaken views on the tint (model.ts routes through takes)', () => {
  const model = readFileSync(new URL('../src/model.ts', import.meta.url), 'utf8');
  assert.match(model, /hook\.takes\?\.\(c\) !== false/);
  // The three routing sites (pose, beauty draw, run join) ask the hook; none skips a primitive on the hook alone.
  assert.equal(model.match(/this\.transmitted\(m, c\)/g)?.length, 3);
  assert.doesNotMatch(model, /\(this\.transmission && transmits\(m\)\)\) (continue|return false)/);
});
