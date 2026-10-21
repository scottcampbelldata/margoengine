import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Clustered, clusteredSampling } from '../dist/index.js';
import { LocalShadows } from '../dist/shadows.js';
import { DirectionalLights, MAX_DIRECTIONAL_SHADOWS } from '../dist/directional.js';
import { AreaLights, MAX_AREA_SHADOWS } from '../dist/area.js';
import { Camera } from '../../core/dist/index.js';
import { wgsl } from '../../core/src/shaders.ts';
import { clusterBrdf } from '../../shared/light-terms.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

const hash = (text) => createHash('sha256').update(text).digest('hex');
// The frame grows from 1,604 floats to 2,644 while a directional or area light casts.
const FRAME_BYTES = 6416,
  EXTENDED_BYTES = 10576,
  SUN = 1604,
  SUN_CASCADES = SUN + 64,
  SUN_MATRICES = SUN_CASCADES + 64,
  AREA = SUN_MATRICES + 256,
  AREA_SLOTS = AREA + 256,
  AREA_MATRICES = AREA_SLOTS + 16;
function harness() {
  const h = optionalGPU(),
    gpu = h.engine.gpu,
    passes = [];
  globalThis.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2 };
  globalThis.GPUTextureUsage = {
    ...globalThis.GPUTextureUsage,
    COPY_DST: 2,
    TEXTURE_BINDING: 4,
    RENDER_ATTACHMENT: 16,
  };
  Object.assign(gpu.limits, { maxTextureDimension2D: 8192, maxTextureArrayLayers: 256 });
  gpu.createBindGroupLayout = (d) => ({ ...d });
  gpu.createPipelineLayout = (d) => ({ ...d });
  const begin = h.context.encoder.beginRenderPass;
  h.context.encoder.beginRenderPass = (d) => {
    passes.push(d.depthStencilAttachment.view);
    return { ...begin(d), setViewport() {} };
  };
  const camera = new Camera({ position: [0, 6, 6], target: [0, 0, 0], fov: 50, near: 0.1, far: 100 });
  camera.update(1, true);
  h.context.camera = h.engine.camera = camera;
  const frame = () => {
    passes.length = 0;
    h.context.shader = wgsl;
    h.context.bindings.length = 0;
    h.engine.frameGraph.execute(h.context);
    return passes.length;
  };
  return { ...h, camera, passes, frame };
}
const node = (engine) => ({
  id: 0,
  engine,
  matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
  check() {},
});
const caster = (engine) => ({
  shadowPrimitives: [{ node: node(engine), vertex: {}, index: {}, count: 36, stride: 80 }],
});
const frameData = (local) => new Float32Array(local.bindings()[0].resource.buffer.data);
const project = (m, p, at = 0) => {
  const c = [0, 1, 2, 3].map((r) => m[at + r] * p[0] + m[at + 4 + r] * p[1] + m[at + 8 + r] * p[2] + m[at + 12 + r]);
  return [(c[0] / c[3]) * 0.5 + 0.5, 0.5 - (c[1] / c[3]) * 0.5, c[2] / c[3], c[3]];
};

test('without castShadow, directional and area lights leave the pre-shadow shader text, bindings and uploads exact', () => {
  // Hashes recorded from the build before directional and area shadows existed (the same scene).
  const h = harness(),
    lights = new Clustered({ grid: [2, 2, 2] });
  h.engine.use(lights);
  lights.setLights([
    { position: [0, 3, 0], range: 10, castShadow: true },
    { position: [1, 3, 0], range: 10, direction: [0, -1, 0], outerAngle: 0.6, castShadow: true },
  ]);
  const local = LocalShadows.attach(h.engine, { lights, resolution: 64 });
  local.add(caster(h.engine));
  const sun = DirectionalLights.attach(h.engine, { lights }),
    area = AreaLights.attach(h.engine, { lights });
  sun.setLights([{ direction: [0.3, -1, 0.2], intensity: 3 }, { direction: [0, -1, 0] }]);
  area.setLights([
    { position: [0, 2, 0], direction: [0, -1, 0], width: 1, height: 0.5, intensity: 4 },
    { position: [0, 2, 2], direction: [0, 0, -1], width: 2, height: 1, twoSided: true },
  ]);
  h.frame();
  h.frame();
  assert.equal(hash(h.context.shader), 'f7cd4f02ff8aaaa83a00e3b72fc1f645971c7ec7e35d1729dfbc635c6864bc5f');
  assert.equal(hash(lights.pbr(2).declarations), '2e4e2be368ca17c4833451ffcf64c2d55734806935914e09f995f3f50d54cfa9');
  assert.equal(
    hash(lights['unshadowed'].pbr(2).declarations),
    'b8613a23e124cda441dbef61f71d9c65875b62dbc8b82bf7349caeb798f7cfe4',
  );
  assert.equal(
    hash(clusteredSampling(0, local, area, false, false, true, { directional: sun })),
    'eda2cb7f39a0228d63072c1b74dd77d62a06e0f3d8ab51c5fa1082844477ea9c',
  );
  assert.equal(hash(local.declarations(2)), '961f6b98277b21a35fb25375081db417e5364bb85c5b1ef39d54d879d1e76c6d');
  assert.deepEqual(
    lights.bindings().map((e) => e.binding),
    [4, 5, 6, 7, 14, 15, 16, 17, 141],
  );
  const buffer = local.bindings()[0].resource.buffer;
  assert.equal(buffer.size, FRAME_BYTES);
  assert.equal(hash(new Uint8Array(buffer.data)), '471f172a430a6e5e77150781ebc9ab1f61f14f286d2807f057f1a61310f5fe2b');
  assert.equal(local.directionalShadow, undefined);
  assert.equal(local.areaShadow, undefined);
  for (const plugin of [lights, local, sun, area]) plugin.dispose();
});

test('a castShadow directional light with bounds: one orthographic map, a shadow factor in the loop, cached', () => {
  const h = harness(),
    lights = Clustered.attach(h.engine, { grid: [2, 2, 2] }),
    local = LocalShadows.attach(h.engine, { lights, resolution: 64 }),
    sun = DirectionalLights.attach(h.engine, { lights }),
    bounds = { min: [-2, 0, -2], max: [2, 2, 2] };
  local.add(caster(h.engine));
  sun.setLights([{ direction: [0, -1, 0], intensity: 2 }]);
  h.frame();
  const plain = h.context.shader;
  sun.setLights([{ direction: [0, -1, 0], intensity: 2, castShadow: true, shadow: { bounds } }]);
  assert.equal(h.frame(), 1, 'one layer');
  const shader = h.context.shader;
  assert.match(shader, /\*nl\*light\.color\.rgb\*clusterDirectionalShadow\(j,position,n,l\);/);
  assert.match(shader, /sunMatrices:array<mat4x4f,16>/);
  // Materials' Lambert and Phong still find the point loop's BRDF text in both loops.
  assert.equal(shader.split('result+=' + clusterBrdf + '*nl*').length, 3);
  assert.equal(local.directionalShadow, 'clusterDirectionalShadow(j,position,n,l)');
  assert.deepEqual(
    lights.bindings().map((e) => e.binding),
    [4, 5, 6, 7, 14, 15, 16, 141],
    'no new binding',
  );
  assert.equal(local.bindings()[0].resource.buffer.size, EXTENDED_BYTES);
  const v = frameData(local);
  assert.deepEqual([...v.subarray(SUN, SUN + 4)], [0, 1, 1, 0], 'layer 0, slot 1, one map');
  // The box's top (nearest the light) is depth 1, its floor 0; its corners sit two texels inside the map.
  const top = project(v, [-2, 2, -2], SUN_MATRICES),
    floor = project(v, [2, 0, 2], SUN_MATRICES);
  assert.ok(Math.abs(top[2] - 1) < 1e-6 && Math.abs(floor[2]) < 1e-6, `${top[2]} ${floor[2]}`);
  for (const p of [top, floor])
    for (const uv of p.slice(0, 2))
      assert.ok(Math.abs(Math.min(uv, 1 - uv) - 2 / 64) < 1e-6, `corner uv ${uv} at the guard band`);
  assert.deepEqual(
    [...v.subarray(SUN_CASCADES, SUN_CASCADES + 4)].map((x) => +x.toFixed(5)),
    [+(4 / 60).toFixed(5), +(62 / 64).toFixed(5), +(62 / 64).toFixed(5), +(2 / 64).toFixed(5)],
    'texel size in world units and the valid UV box',
  );
  assert.equal(h.frame(), 0, 'cached');
  h.camera.position = [3, 6, 6];
  h.camera.update(1, true);
  assert.equal(h.frame(), 0, 'a bounds map ignores the camera');
  sun.setLights([{ direction: [0.1, -1, 0], intensity: 2, castShadow: true, shadow: { bounds } }]);
  assert.equal(h.frame(), 1, 'the light turned');
  sun.setLights([{ direction: [0.1, -1, 0], intensity: 2 }]);
  h.frame();
  assert.equal(h.context.shader, plain, 'castShadow off restores the shader');
  assert.equal(local.bindings()[0].resource.buffer.size, FRAME_BYTES);
  local.dispose();
  sun.dispose();
  lights.dispose();
  assert.ok(h.resources.every((r) => r.destroyed));
});

test('camera-fitted cascades: one layer each, re-fitted when the camera moves; slices hold the view', () => {
  const h = harness(),
    lights = Clustered.attach(h.engine, { grid: [2, 2, 2] }),
    local = LocalShadows.attach(h.engine, { lights, resolution: 64 }),
    sun = DirectionalLights.attach(h.engine, { lights });
  local.add(caster(h.engine));
  const point = { position: [0, 3, 0], range: 10, castShadow: true };
  lights.setLights([
    point,
    { position: [2, 3, 0], range: 10, direction: [0, -1, 0], outerAngle: 0.5, castShadow: true },
  ]);
  sun.setLights([{ direction: [1, -2, 0], castShadow: true, shadow: { cascades: 3, distance: 20 } }]);
  assert.equal(h.frame(), 6 + 1 + 3, 'six point faces, a spot, then three cascades');
  assert.deepEqual(
    [...frameData(local).subarray(SUN, SUN + 4)],
    [7, 1, 3, 0],
    'cascades follow the point and spot layers',
  );
  assert.equal(h.frame(), 0);
  h.camera.position = [1, 6, 6];
  h.camera.update(1, true);
  assert.equal(h.frame(), 3, 'the cascades move; the point and spot maps stay cached');
  // Without the spot the cascades move down a layer and re-render there.
  lights.setLights([point]);
  assert.equal(h.frame(), 3);
  assert.equal(frameData(local)[SUN], 6);
  // Every point of the view out to the distance lies in some cascade's filtered UV box, between its depths; the
  // cascades grow outward. Points come from the camera itself (independent of the fit).
  const v = frameData(local),
    texels = [0, 1, 2].map((k) => v[SUN_CASCADES + k * 4]),
    eye = h.camera.position,
    forward = [0, 1, 2].map((k) => h.camera.target[k] - eye[k]),
    length = Math.hypot(...forward),
    tan = Math.tan((50 * Math.PI) / 360),
    up = [0, 1, 0],
    right = [
      forward[1] * up[2] - forward[2] * up[1],
      forward[2] * up[0] - forward[0] * up[2],
      forward[0] * up[1] - forward[1] * up[0],
    ],
    rl = Math.hypot(...right),
    down = [0, 1, 2].map(
      (k) => (right[(k + 1) % 3] * forward[(k + 2) % 3] - right[(k + 2) % 3] * forward[(k + 1) % 3]) / rl / length,
    );
  assert.ok(texels[0] < texels[1] && texels[1] < texels[2], `${texels}`);
  let checked = 0;
  for (const depth of [0.2, 1, 3, 7, 12, 19.9])
    for (const sx of [-1, 0, 1])
      for (const sy of [-1, 0, 1]) {
        const p = [0, 1, 2].map(
          (k) =>
            eye[k] + (forward[k] / length) * depth + (right[k] / rl) * sx * tan * depth - down[k] * sy * tan * depth,
        );
        const held = [0, 1, 2].some((k) => {
          const q = project(v, p, SUN_MATRICES + k * 16),
            box = v.subarray(SUN_CASCADES + k * 4, SUN_CASCADES + k * 4 + 4);
          return q[0] >= box[3] && q[1] >= box[3] && q[0] <= box[1] && q[1] <= box[2] && q[2] > 0 && q[2] <= 1;
        });
        assert.ok(held, `view point ${p} (depth ${depth}) is in no cascade`);
        checked++;
      }
  assert.equal(checked, 54);
  // Turning the camera keeps every cascade's size (the boxes only move).
  h.camera.target = [3, 0, -1];
  h.camera.update(1, true);
  assert.equal(h.frame(), 3);
  assert.deepEqual(
    [0, 1, 2].map((k) => frameData(local)[SUN_CASCADES + k * 4]),
    texels,
  );
  h.camera.matrix.fill(0);
  assert.throws(() => h.frame(), /invertible camera matrix/);
  local.dispose();
  sun.dispose();
  lights.dispose();
});

test('a castShadow area light: five cube faces (six two-sided) around its centre, a PCSS factor per light', () => {
  const h = harness(),
    lights = Clustered.attach(h.engine, { grid: [2, 2, 2] }),
    local = LocalShadows.attach(h.engine, { lights, resolution: 64 }),
    area = AreaLights.attach(h.engine, { lights }),
    light = { position: [0, 3, 0], direction: [0, -1, 0], width: 1, height: 0.5, intensity: 3 };
  local.add(caster(h.engine));
  area.setLights([light]);
  h.frame();
  const plain = h.context.shader,
    unshadowed = lights['unshadowed'].pbr(2).declarations;
  area.setLights([{ ...light, castShadow: true, shadow: { far: 20 } }]);
  assert.equal(h.frame(), 5);
  assert.match(h.context.shader, /let radiance=light\.color\.rgb\*clusterAreaShadow\(j,position,n,c,r,u\);/);
  assert.match(h.context.shader, /areaMatrices:array<mat4x4f,24>/);
  assert.equal(lights['unshadowed'].pbr(2).declarations, unshadowed, 'receiveShadow false receivers stay unshadowed');
  assert.match(
    clusteredSampling(0, local, area, false, false, true),
    /\*select\(1\.0,clusterAreaShadow\(j,position,n,c,r,u\),clusterReceive\)/,
    'core meshes with receiveShadow false skip it',
  );
  const v = frameData(local);
  assert.deepEqual(
    [...v.subarray(AREA, AREA + 4)].map((x) => +x.toFixed(4)),
    [0, 1, 0.02, 20],
    'layer 0, slot 1, near far / 1000, far',
  );
  assert.deepEqual(
    [...v.subarray(AREA_SLOTS, AREA_SLOTS + 4)].map((x) => +x.toFixed(5)),
    [+(2.5 / 64).toFixed(5), +(0.1 - 1.5 / 64).toFixed(5), +(1.5 / 64).toFixed(5), 0],
  );
  // Faces +n, +r, -r, +u, -u: a point 2 units along each axis is the face's centre; 45 degrees off it, 0.1 UV from the edge.
  const axes = [
    [0, -1, 0],
    [1, 0, 0],
    [-1, 0, 0],
    [0, 0, 1],
    [0, 0, -1],
  ];
  axes.forEach((axis, face) => {
    const at = AREA_MATRICES + face * 16,
      centre = project(
        v,
        axis.map((a, k) => [0, 3, 0][k] + a * 2),
        at,
      );
    assert.ok(Math.abs(centre[0] - 0.5) < 1e-5 && Math.abs(centre[1] - 0.5) < 1e-5, `face ${face} centre ${centre}`);
    assert.ok(centre[2] > 0 && centre[2] < 1 && Math.abs(centre[3] - 2) < 1e-5);
    const side = face < 3 && face > 0 ? [0, 1, 0] : [1, 0, 0],
      edge = project(
        v,
        axis.map((a, k) => [0, 3, 0][k] + a * 2 + side[k] * 2),
        at,
      );
    assert.ok(
      [edge[0], edge[1]].some((uv) => Math.abs(uv - 0.1) < 1e-5 || Math.abs(uv - 0.9) < 1e-5),
      `face ${face} 45 degrees at ${edge}`,
    );
  });
  assert.equal(h.frame(), 0, 'cached');
  area.setLights([{ ...light, twoSided: true, castShadow: true, shadow: { far: 20 } }]);
  assert.equal(h.frame(), 6, 'two-sided adds the back face');
  assert.equal(frameData(local)[AREA_SLOTS + 3], 1);
  area.setLights([{ ...light, width: 2, twoSided: true, castShadow: true, shadow: { far: 20 } }]);
  assert.equal(h.frame(), 0, 'a wider light keeps its maps: only the penumbra changes');
  area.setLights([light]);
  h.frame();
  assert.equal(h.context.shader, plain);
  local.dispose();
  area.dispose();
  lights.dispose();
  assert.ok(h.resources.every((r) => r.destroyed));
});

test('directional and area shadows compose with point lights in one map array; smaller maps use corners', () => {
  const h = harness(),
    lights = Clustered.attach(h.engine, { grid: [2, 2, 2] }),
    local = LocalShadows.attach(h.engine, { lights, resolution: 64 }),
    sun = DirectionalLights.attach(h.engine, { lights }),
    area = AreaLights.attach(h.engine, { lights });
  local.add(caster(h.engine));
  lights.setLights([{ position: [0, 3, 0], range: 10, castShadow: true }]);
  sun.setLights([
    { direction: [0, -1, 0] },
    { direction: [1, -2, 0], castShadow: true, shadow: { cascades: 2, resolution: 32 } },
    { direction: [0, -1, 1], castShadow: true, shadow: { bounds: { min: [-1, -1, -1], max: [1, 1, 1] } } },
  ]);
  area.setLights([
    { position: [0, 2, 0], direction: [0, -1, 0], width: 1, height: 1 },
    {
      position: [0, 3, 0],
      direction: [0, -1, 0],
      width: 1,
      height: 1,
      castShadow: true,
      shadow: { resolution: [32, 16] },
    },
  ]);
  assert.equal(h.frame(), 6 + 2 + 1 + 5);
  const v = frameData(local);
  assert.deepEqual([...v.subarray(SUN, SUN + 12)], [0, 0, 0, 0, 6, 1, 2, 0, 8, 2, 1, 0], 'per list index');
  assert.deepEqual(
    [...v.subarray(AREA, AREA + 8)].slice(0, 6).map((x) => +x.toFixed(3)),
    [0, 0, 0, 0, 9, 1],
  );
  // A 32-texel cascade samples the top-left quarter: its valid UV box ends at 30 / 64.
  assert.deepEqual(
    [...v.subarray(SUN_CASCADES + 1, SUN_CASCADES + 4)].map((x) => +x.toFixed(5)),
    [+(30 / 64).toFixed(5), +(30 / 64).toFixed(5), +(2 / 64).toFixed(5)],
  );
  assert.ok(v[AREA_SLOTS + 1] > 0 && v[AREA_SLOTS + 1] < 0.1, 'a smaller face has a narrower guard band');
  sun.setLights([{ direction: [1, -2, 0], castShadow: true, shadow: { resolution: 128 } }]);
  assert.throws(() => h.frame(), /directional light's shadow\.resolution exceeds LocalShadows resolution 64/);
  for (const plugin of [local, sun, area, lights]) plugin.dispose();
});

test('a directional map that leaves the array while a caster moves re-renders when it returns', () => {
  const h = harness(),
    lights = Clustered.attach(h.engine, { grid: [2, 2, 2] }),
    local = LocalShadows.attach(h.engine, { lights, resolution: 64 }),
    sun = DirectionalLights.attach(h.engine, { lights }),
    box = caster(h.engine),
    bounds = { min: [-2, 0, -2], max: [2, 2, 2] },
    a = { direction: [0, -1, 0], castShadow: true, shadow: { bounds } },
    b = { direction: [1, -2, 0], castShadow: true, shadow: { bounds } };
  local.add(box);
  sun.setLights([a, b]);
  assert.equal(h.frame(), 2);
  sun.setLights([a]);
  assert.equal(h.frame(), 0, 'the first map stays');
  box.shadowPrimitives[0].node.matrix[13] = 1;
  assert.equal(h.frame(), 1);
  sun.setLights([a, b]);
  assert.equal(h.frame(), 1, "the second map's layer missed the caster move");
  for (const plugin of [local, sun, lights]) plugin.dispose();
});

test('directional and area shadow settings are validated before anything changes', () => {
  const lights = { setLights() {} },
    sun = new DirectionalLights({ lights }),
    area = new AreaLights({ lights }),
    rect = { position: [0, 2, 0], direction: [0, -1, 0], width: 1, height: 1 };
  sun.setLights([{ direction: [0, -1, 0], castShadow: true }]);
  area.setLights([{ ...rect, castShadow: true }]);
  for (const [shadow, type] of [
    [{ bounds: { min: [0, 0, 0], max: [1, 0, 1] } }, RangeError],
    [{ bounds: { min: [0, 0], max: [1, 1, 1] } }, TypeError],
    [{ bounds: 3 }, TypeError],
    [{ cascades: 0 }, RangeError],
    [{ cascades: 5 }, RangeError],
    [{ cascades: 1.5 }, RangeError],
    [{ distance: 0 }, RangeError],
    [{ distance: Infinity }, RangeError],
    [{ resolution: 8 }, RangeError],
    [[], TypeError],
    [true, TypeError],
  ])
    assert.throws(
      () => sun.setLights([{ direction: [0, -1, 0], castShadow: true, shadow }]),
      type,
      JSON.stringify(shadow),
    );
  assert.throws(() => sun.setLights([{ direction: [0, -1, 0], castShadow: 1 }]), TypeError);
  assert.throws(() => sun.setLights([{ direction: [0, -1, 0], shadow: { cascades: 9 } }]), RangeError);
  assert.throws(
    () => sun.setLights(Array(MAX_DIRECTIONAL_SHADOWS + 1).fill({ direction: [0, -1, 0], castShadow: true })),
    /At most 4 directional lights may cast shadows/,
  );
  for (const [shadow, type] of [
    [{ near: 0 }, RangeError],
    [{ near: 5, far: 4 }, RangeError],
    [{ far: 200 }, undefined],
    [{ far: '8' }, TypeError],
    [{ resolution: [16, 8] }, RangeError],
    [1, TypeError],
  ])
    if (type)
      assert.throws(() => area.setLights([{ ...rect, castShadow: true, shadow }]), type, JSON.stringify(shadow));
    else area.setLights([{ ...rect, castShadow: true, shadow }]);
  assert.throws(() => area.setLights([{ ...rect, castShadow: 'yes' }]), TypeError);
  assert.throws(
    () => area.setLights(Array(MAX_AREA_SHADOWS + 1).fill({ ...rect, castShadow: true })),
    /At most 4 area lights may cast shadows/,
  );
  assert.equal(sun.shadowLights().length, 1);
  assert.equal(area.shadowLights()[0].far, 200, 'the last valid list');
  assert.deepEqual(
    area.shadowLights()[0].right.map((v) => v + 0),
    [1, 0, 0],
  );
});

test('without LocalShadows a castShadow directional or area light changes nothing', () => {
  const h = harness(),
    lights = Clustered.attach(h.engine, { grid: [2, 2, 2] }),
    sun = DirectionalLights.attach(h.engine, { lights }),
    area = AreaLights.attach(h.engine, { lights }),
    rect = { position: [0, 2, 0], direction: [0, -1, 0], width: 1, height: 1 };
  sun.setLights([{ direction: [0, -1, 0] }]);
  area.setLights([rect]);
  h.frame();
  const plain = h.context.shader;
  sun.setLights([{ direction: [0, -1, 0], castShadow: true }]);
  area.setLights([{ ...rect, castShadow: true }]);
  assert.equal(h.frame(), 0);
  assert.equal(h.context.shader, plain);
  for (const plugin of [sun, area, lights]) plugin.dispose();
});
