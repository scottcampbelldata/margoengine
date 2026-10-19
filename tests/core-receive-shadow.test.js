// Core meshes opt out of receiving shadows: `mesh.receiveShadow = false` adds 0.25 to the mesh's instance float 22 (the
// doubleSided factor core's fragment shader reads as i.material.z), so core's, selection's, culling's and WebGL's
// `< 0.5` single-sided tests keep their meaning while shadow plugins can tell the mesh apart.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore, PbrMaterial, box } from '../packages/core/dist/extension.js';
import { wgsl } from '../packages/core/src/shaders.ts';
import { mockGPU } from '../examples/package-benchmarks/proofs/gpu-recorder.js';
import { coreReceives } from '../packages/shared/shadow-source.js';

async function rig() {
  const gpu = mockGPU(),
    store = await TransformStore.create(8),
    drawn = [];
  const engine = new Engine(
    { width: 64, height: 64, clientWidth: 64, clientHeight: 64 },
    store,
    {
      backend: 'webgpu',
      gpu: gpu.device,
      add() {},
      remove() {},
      render(_camera, _lighting, batches) {
        drawn.splice(0, drawn.length, ...batches);
      },
      dispose() {},
    },
    { position: [0, 2, 6], target: [0, 0, 0] },
    null,
  );
  return { engine, drawn };
}

test('instance float 22 is doubleSided + 0.25 for a mesh that does not receive; a toggle re-collects', async () => {
  const { engine, drawn } = await rig(),
    geometry = box();
  try {
    const meshes = [
      [false, true],
      [true, true],
      [false, false],
      [true, false],
    ].map(([doubleSided, receiveShadow]) => {
      const mesh = engine.createMesh().setGeometry(geometry).setMaterial(new PbrMaterial({ doubleSided }));
      assert.equal(mesh.receiveShadow, true, 'default true');
      mesh.receiveShadow = receiveShadow;
      return mesh;
    });
    const factors = () => {
      engine.render();
      const { instances } = drawn[0];
      return meshes.map((_, k) => instances[k * 24 + 22]);
    };
    assert.deepEqual(factors(), [0, 1, 0.25, 1.25]);
    assert.equal(engine.unshadowed, 2);
    meshes[2].receiveShadow = true;
    meshes[1].receiveShadow = false;
    assert.deepEqual(factors(), [0, 1.25, 0, 1.25], 'the setter re-collects with no other change');
    meshes[3].setPosition([1, 0, 0]);
    assert.deepEqual(factors(), [0, 1.25, 0, 1.25], "a moved matrix (no re-collection) keeps the mesh's factor");
    meshes[1].receiveShadow = meshes[3].receiveShadow = true;
    assert.deepEqual(factors(), [0, 1, 0, 1]);
    assert.equal(engine.unshadowed, 0);
    for (const value of [0, 'false', null]) assert.throws(() => (meshes[0].receiveShadow = value), TypeError);
    assert.equal(meshes[0].receiveShadow, true);
  } finally {
    engine.dispose();
  }
});

test("core's single-sided test and the shadow plugins' receive test read the four factors as intended", () => {
  // WGSL `i.material.z<0.5` (core, selection, culling, WebGL) and shared/shadow-source.js `coreReceives`.
  assert.ok(wgsl.includes('i.material.z<0.5'));
  assert.equal(coreReceives, 'fract(i.material.z+0.125)<0.25');
  const fract = (x) => x - Math.floor(x),
    singleSided = (z) => z < 0.5,
    receives = (z) => fract(Math.fround(z + 0.125)) < 0.25;
  // Interpolated factors may land a little off the stored value.
  for (const e of [0, 1e-6, -1e-6])
    assert.deepEqual(
      [0, 1, 0.25, 1.25].map((z) => [singleSided(z + e), receives(z + e)]),
      [
        [true, true],
        [false, true],
        [true, false],
        [false, false],
      ],
    );
});
