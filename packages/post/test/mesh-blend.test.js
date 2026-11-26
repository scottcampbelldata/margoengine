import test from 'node:test';
import assert from 'node:assert/strict';
import { MeshBlend, meshBlendGap, meshBlendWeight } from '@margoengine/post/mesh-blend';

test('meshBlendGap reads a contact from either side and a silhouette from neither', () => {
  // A vertical face (flat distance 3.6) meets ground seen at a grazing angle, whose distance grows 0.14 per pixel away
  // from the seam; the seam lies half a pixel from each side's pixel.
  const face = [3.6, 3.6],
    ground = [3.67, 3.81];
  assert.ok(meshBlendGap(face, ground, 1) < 1e-9, 'from the face side: a contact');
  assert.ok(meshBlendGap(ground.toReversed(), face, 1) < 1e-9, 'from the ground side: a contact');
  // The same face against ground 6 units behind it: no slope explains the jump, however steep the ground.
  assert.ok(meshBlendGap(face, [9.6, 9.74], 1) > 5);
  assert.ok(meshBlendGap(face, [9.6, 14.6], 1) > 3, 'a far side at a grazing slope is carried only half a pixel');
  // Two flat sides at one distance meet; a wider span carries each slope further.
  assert.equal(meshBlendGap([2, 2], [2, 2], 3), 0);
  assert.ok(meshBlendGap([2, 2.1], [2.3, 2.4], 2) < 1e-9, 'slopes of 0.1 meet at 2.2 one pixel from each side');
});

test('meshBlendWeight is half at the seam and falls smoothly to 0 at the radius', () => {
  const at = (distance) => meshBlendWeight({ distance, radius: 10, gap: 0, tolerance: 1 });
  assert.equal(at(0), 0.5);
  assert.equal(at(10), 0);
  assert.equal(at(12), 0);
  // smoothstep falloff: the midpoint keeps a quarter, and the weight never rises with distance.
  assert.ok(Math.abs(at(5) - 0.25) < 1e-12);
  for (let d = 0; d < 10; d += 0.5) assert.ok(at(d + 0.5) <= at(d), `falls at ${d}`);
  // A larger radius reaches further at the same distance.
  assert.ok(meshBlendWeight({ distance: 5, radius: 20, gap: 0, tolerance: 1 }) > at(5));
});

test('meshBlendWeight rejects seams whose depth jumps past the slope prediction', () => {
  const at = (gap) => meshBlendWeight({ distance: 0, radius: 8, gap, tolerance: 0.2 });
  assert.equal(at(0), 0.5);
  assert.equal(at(0.1), 0.5, 'below half the tolerance the seam is a contact');
  assert.ok(at(0.15) > 0 && at(0.15) < 0.5, 'between half and the whole tolerance it fades');
  assert.equal(at(0.2), 0, 'at the tolerance a silhouette is rejected');
  assert.equal(at(50), 0, 'a far background never blends');
});

test('meshBlendWeight blends nothing without a radius', () => {
  assert.equal(meshBlendWeight({ distance: 0, radius: 0, gap: 0, tolerance: 1 }), 0);
  assert.equal(meshBlendWeight({ distance: 0, radius: -1, gap: 0, tolerance: 1 }), 0);
});

test('MeshBlend checks its options and tags, and needs a stack', () => {
  for (const bad of [
    { maxPixels: 0 },
    { maxPixels: 129 },
    { maxPixels: 1.5 },
    { samples: 3 },
    { samples: 65 },
    { samples: 8.5 },
    { depthTolerance: 0 },
    { depthTolerance: Infinity },
    { strength: 2 },
  ])
    assert.throws(() => new MeshBlend(bad), RangeError, JSON.stringify(bad));
  assert.throws(() => new MeshBlend({ enabled: 1 }), TypeError);
  assert.throws(() => new MeshBlend({ order: Number.NaN }), TypeError);
  const blend = new MeshBlend(),
    mesh = {};
  assert.throws(() => blend.tag(null, 1), TypeError);
  for (const radius of [0, -1, Number.NaN, 1e6]) assert.throws(() => blend.tag(mesh, radius), RangeError);
  const remove = blend.tag(mesh, 0.3);
  assert.equal(blend.tags.get(mesh), 0.3);
  blend.tag(mesh, 0.5);
  assert.equal(blend.tags.get(mesh), 0.5, 'tagging again changes the radius');
  remove();
  assert.equal(blend.tags.size, 0);
  assert.equal(blend.untag(mesh), false);
  assert.throws(() => blend.setup({ gpu: {} }), /PostStack/);
  blend.dispose();
  blend.dispose();
  assert.throws(() => blend.setup({ gpu: {} }), /disposed/);
});

test('MeshBlend tags capture models through their hook and releases it', () => {
  const calls = { set: 0, restored: 0 };
  let hook;
  const model = {
    setCapture(h) {
      calls.set++;
      hook = h;
      return () => calls.restored++;
    },
    onDispose: () => () => {},
    draw() {},
  };
  const blend = new MeshBlend();
  const remove = blend.tag(model, 0.25);
  assert.equal(calls.set, 1);
  assert.equal(blend.tags.get(model), 0.25);
  assert.deepEqual(
    hook.targets.map((t) => t.format),
    ['rgba16float'],
  );
  // The hook writes the model's radius and its key for a gltf/pbr surface and for terrain, and refuses anything else.
  assert.match(hook.declarations('struct Surface {base:vec4f,n:vec3f}'), /fn margoCapture\(s:Surface[^]*vec4f\(0\.25,/);
  // Water's own Surface ({position, normal, crest}) is not the PBR one: its stage returns margoSSR (KB-WATER-TARGETS1).
  assert.match(
    hook.declarations(
      'struct Frame {camera:mat4x4f,eye:vec4f,settings:vec4f,sun:vec4f}\nstruct Surface {position:vec3f,normal:vec3f,crest:f32}',
    ),
    /fn margoSSR\([^]*vec4f\(0\.25,/,
  );
  assert.match(
    hook.declarations('struct Frame {camera:mat4x4f,eye:vec4f,light:vec4f,radiance:vec4f}'),
    /fn margoSSR\([^]*vec4f\(0\.25,/,
  );
  // Core's lit shader (lit scatter's stage) spells it `struct Frame { camera`.
  assert.match(
    hook.declarations('struct Frame { camera:mat4x4f,eye:vec4f,light:vec4f,radiance:vec4f,ambient:vec4f }'),
    /fn margoSSR\([^]*vec4f\(0\.25,/,
  );
  assert.throws(() => hook.declarations('fn other() {}'), /terrain/);
  blend.tag(model, 0.5);
  assert.equal(calls.restored, 1, 'tagging again swaps the hook');
  assert.equal(blend.tags.get(model), 0.5);
  remove();
  assert.equal(calls.restored, 2);
  assert.equal(blend.tags.size, 0);
  blend.tag(model, 0.1);
  blend.dispose();
  assert.equal(calls.restored, 3, 'dispose releases tagged models');
});
