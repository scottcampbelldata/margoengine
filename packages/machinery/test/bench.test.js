import { test } from 'node:test';
import assert from 'node:assert/strict';
import { box } from '@margoengine/core';
import { METALS, castIron } from '@margoengine/materials/presets';
import { CAD_FINISHES, CadBench, cadFinish } from '../dist/bench.js';

// A stand-in engine: meshes record what the bench sets on them; plugins are kept by name.
function fakeEngine() {
  const plugins = new Map(),
    meshes = [];
  return {
    plugins,
    meshes,
    use(plugin) {
      plugins.set(plugin.name, plugin);
      return this;
    },
    removePlugin(name) {
      plugins.delete(name);
    },
    createMesh() {
      const mesh = {
        name: '',
        visible: true,
        geometry: null,
        material: null,
        position: null,
        disposed: false,
        setGeometry(g) {
          this.geometry = g;
          return this;
        },
        setMaterial(m) {
          this.material = m;
          return this;
        },
        setPosition(p) {
          this.position = p;
          return this;
        },
        dispose() {
          this.disposed = true;
        },
      };
      meshes.push(mesh);
      return mesh;
    },
  };
}

test('every finish is a measured metal F0 times its tint, metalness 1', () => {
  for (const [name, spec] of Object.entries(CAD_FINISHES)) {
    const preset = cadFinish(name),
      base = spec.metal === 'castIron' ? castIron.color : METALS[spec.metal].color;
    for (let i = 0; i < 3; i++) assert.equal(preset.color[i], base[i] * spec.tint[i], `${name} channel ${i}`);
    assert.equal(preset.roughness, spec.roughness);
    assert.equal(preset.metalness, 1);
  }
  // A #rrggbb tint is sRGB and goes in linear: #808080 is 0.2158605 linear.
  const grey = cadFinish('machined', { tint: '#808080' });
  assert.ok(Math.abs(grey.color[0] - METALS.aluminium.color[0] * 0.2158605) < 1e-6);
  assert.equal(cadFinish('cut', { roughness: 0.5 }).roughness, 0.5);
  assert.throws(() => cadFinish('polished'), RangeError);
  assert.throws(() => cadFinish('machined', { roughness: 2 }), RangeError);
  assert.throws(() => cadFinish('machined', { tint: 'blue' }), TypeError);
});

// Edge lines bind to real engine meshes: bench-check.mjs draws them on WebGPU and the WebGL2 layer.
test('show finishes a part, registers it for shadows and shares materials', () => {
  const engine = fakeEngine(),
    registered = [],
    casters = {
      add(mesh) {
        registered.push(mesh);
        return () => registered.splice(registered.indexOf(mesh), 1);
      },
    },
    cad = CadBench.attach(engine, { deck: { size: [0.3, 0.2], top: 0.01 }, casters, edges: false });
  assert.ok(cad.deck, 'deck made');
  assert.deepEqual(cad.deck.position, [0, 0.01 - 0.02, 0]);
  assert.equal(cad.deckTop, 0.01);
  // By default the plate rests on the floor at y 0 and parts rest on its top.
  const resting = CadBench.attach(fakeEngine(), { deck: { thickness: 0.05 }, edges: false });
  assert.deepEqual(resting.deck.position, [0, 0.025, 0]);
  assert.equal(resting.deckTop, 0.05);
  assert.equal(CadBench.attach(fakeEngine(), { deck: false }).deckTop, 0);
  assert.ok(engine.plugins.has('cad-bench:lines'));
  const a = cad.show(box(0.1, 0.04, 0.06), { finish: 'anodised' }),
    b = cad.show(box(0.02, 0.02, 0.02), { finish: 'anodised' });
  assert.equal(a.material, b.material, 'one material per finish');
  assert.deepEqual([...a.material.data.slice(0, 3)].map((v) => +v.toFixed(5)), cadFinish('anodised').color.slice(0, 3).map((v) => +v.toFixed(5)));
  assert.notEqual(cad.material('machined'), a.material);
  assert.equal(b.edges, null);
  assert.deepEqual(registered, [a.mesh, b.mesh]);
  a.visible = false;
  assert.equal(a.mesh.visible, false);
  a.remove();
  assert.equal(a.mesh.disposed, true, 'a mesh the bench made goes with it');
  assert.deepEqual(registered, [b.mesh]);
  assert.equal(cad.lines.lines.size, 0);
  // A mesh from elsewhere keeps living.
  const outside = engine.createMesh().setGeometry(box());
  cad.show(outside).remove();
  assert.equal(outside.disposed, false);
  cad.dispose();
  assert.equal(cad.deck.disposed, true);
  assert.ok(!engine.plugins.has('cad-bench:lines'));
  assert.throws(() => cad.show(box()), TypeError);
});

test('bad options throw before anything is made', () => {
  const engine = fakeEngine();
  assert.throws(() => CadBench.attach(engine, { deck: { size: [0, 1] } }), RangeError);
  assert.throws(() => CadBench.attach(fakeEngine(), { edges: { width: 0 } }), RangeError);
  assert.throws(() => CadBench.attach({}), TypeError);
  const cad = CadBench.attach(fakeEngine(), { deck: false, edges: false });
  assert.equal(cad.deck, null);
  assert.equal(cad.show(box()).edges, null);
  assert.throws(() => cad.show(fakeEngine().createMesh()), TypeError);
});
