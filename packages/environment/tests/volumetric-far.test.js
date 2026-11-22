// VolumetricFog's far air on the recording mock GPU (`@margoengine/environment/volumetric`): `visibility` (Koschmieder,
// extinction 3.912 / V), the clear-air default (23 km, 1.2 km haze scale height), the analytic tail past `range` in the
// composite, and the sky's light (`sky`, or the scene's `sky` plugin) bound to the froxel and composite shaders. The
// measured bounds (2% contrast at V, exp(-optical depth) past range, the join at range, a fully fogged far sea against
// the horizon sky) run on a real GPU: tests/volumetric-far.browser.mjs (npm run test:fog-far:browser).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mockGPU, passes, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { Camera } from '../../core/dist/extension.js';
import { SceneTarget } from '../../shared/msaa.js';
import { publishSurfaceDepth } from '../../shared/surface-depth.js';
import { VolumetricFog } from '../dist/volumetric.js';

const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
const floats = (hex) => {
  const b = Buffer.from(hex, 'hex');
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
};

function rig({ options = {}, plugins = [], before } = {}) {
  const gpu = mockGPU(),
    view = context(gpu, { samples: 1, format: 'rgba16float', shader: 'lit shader' }),
    size = [view.state.width, view.state.height];
  const engine = {
    gpu: gpu.device,
    plugins: new Map(plugins.map((p) => [p.name, p])),
    lighting: { direction: new Float32Array([0, 0.6, -0.8, 3]), radiance: new Float32Array([1, 0.9, 0.8, 0.1]) },
    sceneOf() {
      return this;
    },
    removePlugin(name) {
      this.plugins.delete(name);
    },
  };
  const target = new SceneTarget(
    gpu.device,
    gpu.device.createTexture({ size, format: 'rgba16float', usage }),
    gpu.device.createTexture({ size, format: 'depth24plus-stencil8', usage }),
    1,
  );
  const fog = new VolumetricFog(options);
  engine.plugins.set(fog.name, fog);
  fog.setup(engine);
  const run = passes(fog);
  const frame = (i) => {
    fog.onPreUpdate(1 / 60);
    view.begin(i);
    target.begin(view.c);
    const camera = new Camera({ position: [0, 2, 0], target: [0, 2, -10], near: 0.1, far: 500 });
    camera.update(16 / 9, true);
    view.c.camera = camera;
    before?.(view.c, i);
    run(view.c);
  };
  return { gpu, fog, frame, record: (work) => gpu.record(work) };
}
const uniform = (log) => floats(log.find((e) => e[0] === 'writeBuffer' && e[3].length === 304 * 2)[3]);
const code = (log) =>
  log
    .filter((e) => e[0] === 'module')
    .map((e) => e[2].code)
    .join('\n');

test('visibility sets the extinction by Koschmieder (3.912 / V); the default is clear air, thinning with height', () => {
  const at = (options) => {
    const { frame, record, fog } = rig({ options });
    const u = uniform(record(() => frame(0)));
    return { density: u[45], falloff: u[46], fog };
  };
  const clear = at({});
  assert.equal(clear.density, Math.fround(Math.log(50) / 23000), 'no options: 23 km visibility');
  assert.equal(clear.falloff, Math.fround(1 / 1200), 'no options: the 1.2 km haze scale height');
  assert.equal(clear.fog.extinction, Math.log(50) / 23000);
  const mist = at({ visibility: 1000 });
  assert.equal(mist.density, Math.fround(Math.log(50) / 1000));
  assert.equal(mist.falloff, Math.fround(1 / 1200));
  // A black object at V: exp(-sigma V) = 2% contrast.
  assert.ok(Math.abs(Math.exp(-mist.fog.extinction * 1000) - 0.02) < 1e-12);
  // `density` keeps its meaning: uniform unless told otherwise.
  const dense = at({ density: 0.02 });
  assert.deepEqual([dense.density, dense.falloff], [Math.fround(0.02), 0]);
  assert.equal(at({ visibility: 500, heightFalloff: 0 }).falloff, 0, 'an explicit falloff wins');
  for (const bad of [
    { visibility: 0 },
    { visibility: -5 },
    { visibility: Number.NaN },
    { visibility: 1000, density: 0.01 },
  ])
    assert.throws(() => new VolumetricFog(bad), RangeError, JSON.stringify(bad));
  assert.throws(() => new VolumetricFog({ sky: 'sky' }), RangeError);
});

test('the composite carries the far air: an analytic tail from range to the surface or the sky', () => {
  const { frame, record } = rig({ options: { visibility: 1000 } });
  const wgsl = code(record(() => frame(0)));
  assert.match(wgsl, /fn tailDepth\(a:vec3f,w:vec3f,len:f32\)->f32/);
  assert.match(wgsl, /fn farLight\(w:vec3f,a:vec3f\)->vec3f/);
  // Beer-Lambert over both parts: opacity 1 - T_froxel T_tail.
  assert.match(wgsl, /let opacity=1\.0-through\*\(1\.0-farOpacity\);/);
  // No sky: the fog's own ambient, in the froxels and the tail alike.
  assert.match(wgsl, /fn fogAmbient\(w:vec3f\)->vec3f \{return volume\.ambient\.rgb;\}/);
  assert.doesNotMatch(wgsl, /skyMap/);
});

test("the scene's sky lights the fog near and far: its map at bindings 6 and 7 (froxels) and 4 and 5 (composite)", () => {
  let reads = 0;
  const map = { label: 'sky map', createView: () => ({ label: 'sky map view' }) },
    sky = {
      name: 'sky',
      get reflectionTexture() {
        reads++;
        return map;
      },
    };
  const { frame, record } = rig({ plugins: [sky] });
  const log = record(() => frame(0)),
    wgsl = code(log);
  assert.ok(reads >= 2, 'read before the sky draws (onPreUpdate) and in the frame');
  assert.match(wgsl, /@group\(0\) @binding\(6\) var skyMap:texture_2d<f32>;/);
  assert.match(wgsl, /@group\(0\) @binding\(4\) var skyMap:texture_2d<f32>;/);
  assert.match(wgsl, /let ambient=fogAmbient\(-v\);var light=ambient;/);
  assert.match(wgsl, /textureSampleLevel\(skyMap,skySampler,vec2f\(u,0\.484375\),0\)/);
  const groups = log.filter((e) => e[0] === 'group').map((e) => e[2].entries.map((x) => x.binding));
  assert.ok(
    groups.some((b) => b.includes(6) && b.includes(7)),
    'inject group binds the map',
  );
  assert.ok(
    groups.some((b) => b.includes(4) && b.includes(5) && b.includes(3)),
    'composite group binds the map',
  );
  const samplers = log.filter((e) => e[0] === 'sampler').map((e) => e[2]);
  assert.ok(
    samplers.some((s) => s.addressModeU === 'repeat'),
    'the map wraps round in azimuth',
  );
  // `ambient` given, or `sky: null`: the fog's own light, no map.
  for (const options of [{ ambient: [0.1, 0.1, 0.1] }, { sky: null }]) {
    const other = rig({ plugins: [sky], options }),
      text = code(other.record(() => other.frame(0)));
    assert.doesNotMatch(text, /skyMap/, JSON.stringify(options));
  }
  // An explicit sky object wins over discovery.
  const own = { reflectionTexture: map },
    given = rig({ options: { sky: own } });
  assert.match(code(given.record(() => given.frame(0))), /var skyMap/);
});

test("KB-FOG-WATERDEPTH1: with no `depth` the composite reads the depth a Water drew this frame, not the capture's", () => {
  // Water (order 4) draws its surface into its own copy of the scene depth and publishes it; the capture's depth holds
  // no water, so a fog reading it took every sea pixel for sky and fogged the sea fully in clear air.
  const surfaceView = { label: 'water surface depth view' },
    surface = { label: 'water surface depth', sampleCount: 1, createView: () => surfaceView };
  const composite = (log) =>
    log
      .filter((e) => e[0] === 'group')
      .map((e) => e[2].entries)
      .findLast((entries) => entries.some((x) => x.binding === 3))
      ?.find((x) => x.binding === 3).resource;
  const name = (r) => r?.label ?? r;
  const drawn = rig({ before: (c) => publishSurfaceDepth(c, surface) });
  assert.equal(
    name(composite(drawn.record(() => drawn.frame(0)))),
    surfaceView.label,
    'the water surface ends each sea ray',
  );
  // Published on an earlier frame's encoder only (the water gone or not drawn): never read stale. The recorder keeps
  // one encoder; an engine records each frame on a new one, as here.
  let first;
  const stale = rig({
    before: (c, i) => {
      if (i === 0) publishSurfaceDepth((first = c), surface);
      else c.encoder = { ...c.encoder };
    },
  });
  stale.frame(0);
  const later = composite(stale.record(() => stale.frame(1)));
  assert.ok(later && name(later) !== surfaceView.label, 'a surface depth from another frame is not read');
  assert.ok(first);
});
