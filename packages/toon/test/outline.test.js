import test from 'node:test';
import assert from 'node:assert/strict';
import { MeshOutline, creasedNormals, outlineColor } from '../dist/outline.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

// Three faces of a cube corner at the origin: three copies of one position, normals +x, +y, +z.
const corner = new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1]);
const close = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-6);

test('creasedNormals averages copies within the crease angle and keeps the rest', () => {
  const s = 1 / Math.sqrt(3);
  assert.ok(close(creasedNormals(corner, Math.PI), [s, s, s, s, s, s, s, s, s]), 'pi closes the corner');
  assert.ok(close(creasedNormals(corner, 0), [1, 0, 0, 0, 1, 0, 0, 0, 1]), '0 keeps each face normal');
  // 90 degrees apart: an angle just under 90 keeps the faces apart, just over joins them.
  assert.ok(close(creasedNormals(corner, Math.PI / 2 - 0.01), [1, 0, 0, 0, 1, 0, 0, 0, 1]));
  assert.ok(close(creasedNormals(corner, Math.PI / 2 + 0.01), [s, s, s, s, s, s, s, s, s]));
  // Two faces back to back sum to nothing: each keeps its own normal.
  const flat = new Float32Array([0, 0, 0, 0, 1, 0, 0, 0, 0, 0, -1, 0]);
  assert.ok(close(creasedNormals(flat, Math.PI), [0, 1, 0, 0, -1, 0]));
  // Unnormalised input normals still give unit hull normals.
  assert.ok(close(creasedNormals(new Float32Array([1, 2, 3, 0, 0, 5]), 0), [0, 0, 1]));
});

test('outlineColor encodes like a core surface: tone mapped or clamped, then sRGB', () => {
  assert.deepEqual(outlineColor([0, 0, 0], true), [0, 0, 0]);
  const clamped = outlineColor([0, 1, 4], false);
  assert.ok(close(clamped, [0, 1, 1]), 'toneMapped false clamps to 1 before encoding');
  const mapped = outlineColor([0, 1, 4], true);
  assert.ok(mapped[2] < 1 && mapped[1] < mapped[2], 'PBR Neutral rolls the peak off below white');
  assert.ok(Math.abs(outlineColor([0.5, 0.5, 0.5], false)[0] - 0.7353569830524495) < 1e-9, 'sRGB of 0.5');
});

test('MeshOutline validates its options', () => {
  const mesh = { id: 0 };
  assert.throws(() => new MeshOutline({}), RangeError);
  for (const bad of [
    { color: [0, 0] },
    { color: [0, -1, 0] },
    { opacity: 2 },
    { thickness: -1 },
    { thickness: Infinity },
    { angle: 4 },
    { renderOrder: 5000 },
    { polygonOffsetFactor: NaN },
  ])
    assert.throws(() => new MeshOutline({ mesh, ...bad }), RangeError, JSON.stringify(bad));
  const o = new MeshOutline({ mesh });
  assert.deepEqual(
    [o.color, o.opacity, o.transparent, o.thickness, o.screenspace, o.toneMapped, o.polygonOffset, o.angle],
    [[0, 0, 0], 1, false, 0.05, false, true, false, Math.PI],
  );
});

// A unit quad facing +z as a core geometry, in an engine of the fake GPU.
const scene = (options = {}, matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) => {
  const h = optionalGPU();
  const geometry = {
    vertices: new Float32Array([-1, -1, 0, 0, 0, 1, 1, -1, 0, 0, 0, 1, 1, 1, 0, 0, 0, 1, -1, 1, 0, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
  const mesh = { id: 1, visible: true, geometry, matrix: new Float32Array(matrix) };
  h.engine.meshes.set(1, mesh);
  const outline = new MeshOutline({ mesh, ...options });
  h.engine.use(outline);
  return { h, outline, mesh };
};

test('MeshOutline draws one front-culled hull after the opaque scene, with its options in the pipeline', () => {
  const { h } = scene();
  h.frame();
  assert.equal(h.counts.indexed, 1);
  const p = h.pipelines.at(-1);
  assert.equal(p.primitive.cullMode, 'front');
  assert.equal(p.depthStencil.depthWriteEnabled, true);
  assert.equal(p.fragment.targets[0].blend, undefined);
  h.cleanup();
});

test('MeshOutline transparent blends by opacity and leaves depth unwritten', () => {
  const { h } = scene({ transparent: true, opacity: 0.25 });
  h.frame();
  const p = h.pipelines.at(-1);
  assert.equal(p.depthStencil.depthWriteEnabled, false);
  assert.equal(p.fragment.targets[0].blend.color.srcFactor, 'src-alpha');
  h.cleanup();
});

test('MeshOutline culls back faces under a mirrored matrix and offsets depth on request', () => {
  const { h } = scene(
    { polygonOffset: true, polygonOffsetFactor: 2 },
    [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  );
  h.frame();
  const p = h.pipelines.at(-1),
    reversed = p.depthStencil.depthCompare?.startsWith('greater');
  assert.equal(p.primitive.cullMode, 'back');
  assert.equal(p.depthStencil.depthBiasSlopeScale, reversed ? -2 : 2);
  h.cleanup();
});

test('MeshOutline draws nothing for a hidden, removed or zero-width mesh', () => {
  const { h, outline, mesh } = scene();
  outline.thickness = 0;
  h.frame();
  outline.thickness = 0.1;
  mesh.visible = false;
  h.engine.store.hidden[1] = 1;
  h.frame();
  h.engine.store.hidden[1] = 0;
  h.engine.meshes.delete(1);
  h.frame();
  assert.equal(h.counts.indexed ?? 0, 0);
  h.cleanup();
});

test('MeshOutline rebuilds its hull when the angle changes and frees it on dispose', () => {
  const { h, outline } = scene();
  h.frame();
  const vertices = () => h.resources.filter((r) => r.usage & GPUBufferUsage.VERTEX);
  assert.equal(vertices().length, 1);
  outline.angle = 0;
  h.frame();
  assert.equal(vertices().length, 2);
  assert.equal(vertices().filter((r) => !r.destroyed).length, 1, 'the old hull is retired');
  outline.dispose();
  outline.dispose();
  assert.equal(vertices().filter((r) => !r.destroyed).length, 0);
  assert.equal(h.counts.indexed, 2);
  h.cleanup();
});
