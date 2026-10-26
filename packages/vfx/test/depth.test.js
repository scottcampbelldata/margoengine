import test from 'node:test';
import assert from 'node:assert/strict';
import { VFX } from '../dist/index.js';
import { VFX as Base } from '../dist/base.js';
import { curves, MAX_CURVE_SAMPLES, MAX_GRADIENT_STOPS } from '../dist/curves.js';
import { emitter, MAX_EMITTER_TRIANGLES } from '../dist/emitter.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

const quad = { positions: new Float32Array([0, 0, 0, 2, 0, 0, 2, 0, 2, 0, 0, 2]), indices: [0, 1, 2, 0, 2, 3] };
const attach = (options, Class = VFX, features) => {
  const h = optionalGPU();
  h.engine.stats = { drawCalls: 0 };
  const effect = features ? new Class(options, features) : new Class(options);
  h.engine.use(effect);
  return { h, effect };
};
const code = (h, stage) =>
  h.pipelines.find((p) => p[stage]).module?.code ?? h.pipelines.find((p) => p[stage])[stage].module.code;

test('curves feature: size, alpha and colour edit only the billboard and write the uniform each frame', () => {
  const size = [0, 1, 0.5],
    { h, effect } = attach({
      capacity: 16,
      curves: {
        size,
        alpha: [0, 1, 1, 0],
        color: [
          { at: 0, color: [1, 1, 1] },
          { at: 0.5, color: [1, 0.5, 0] },
        ],
      },
    });
  h.frame();
  const billboard = code(h, 'vertex'),
    simulation = code(h, 'compute');
  assert.match(billboard, /sampleCurve\(0u,curves\.counts\.x,age\)/);
  assert.match(billboard, /sampleCurve\(8u,curves\.counts\.y,age\)/);
  assert.match(billboard, /sampleGradient\(curves\.counts\.z,age\)/);
  assert.ok(!simulation.includes('curves'), 'the simulation never sees curves');
  const buffer = h.resources.find((r) => r.size === 400 && !r.destroyed),
    f = new Float32Array(buffer.data),
    u = new Uint32Array(buffer.data);
  assert.deepEqual([...u.slice(0, 3)], [3, 4, 2]);
  assert.deepEqual([...f.slice(4, 7)], [0, 1, 0.5]);
  assert.deepEqual([...f.slice(36, 40)], [0, 1, 1, 0]);
  assert.deepEqual([...f.slice(68, 72)], [1, 1, 1, 0], 'first stop: colour then position');
  assert.deepEqual([...f.slice(72, 76)], [1, 0.5, 0, 0.5]);
  effect.options.curves = { size: [1, 0.25] };
  h.frame();
  assert.deepEqual([...new Uint32Array(buffer.data).slice(0, 3)], [2, 0, 0], 'the counts follow the curves set now');
  assert.deepEqual([...new Float32Array(buffer.data).slice(4, 6)], [1, 0.25]);
  assert.equal(new Float32Array(buffer.data)[6], 0, 'stale samples are cleared');
  effect.dispose();
  assert.ok(h.resources.every((r) => r.destroyed));
});

test('curves feature: an unset curve keeps the stock size and fade, and a colour-only effect keeps the stock fade', () => {
  const only = (curvesOption) => {
    const { h, effect } = attach({ capacity: 8, curves: curvesOption });
    h.frame();
    const billboard = code(h, 'vertex');
    effect.dispose();
    return billboard;
  };
  const colour = only({
    color: [
      { at: 0, color: [1, 0, 0] },
      { at: 1, color: [0, 0, 1] },
    ],
  });
  assert.ok(!colour.includes('sampleCurve(0u'), 'no size curve');
  assert.match(colour, /clamp\(p\.positionLife\.w\/p\.rotation\.z,0\.0,1\.0\)/, 'the stock fade stays');
  const size = only({ size: [1, 0] });
  assert.match(size, /sampleCurve\(0u/);
  assert.ok(!size.includes('sampleGradient(curves'), 'no gradient call');
});

test('curves feature: bad curves throw errors that name the fix', () => {
  const bad = (c, pattern, kind = TypeError) =>
    assert.throws(
      () => new VFX({ curves: c }),
      (e) => e instanceof kind && pattern.test(e.message),
      JSON.stringify(c),
    );
  bad({}, /at least one of size, alpha or color/);
  bad({ size: [1] }, /needs 2 to 32 samples/);
  bad({ size: Array(MAX_CURVE_SAMPLES + 1).fill(1) }, /needs 2 to 32 samples/);
  bad({ size: [0, 2] }, /size\[1\] must be a number from 0 to 1/, RangeError);
  bad({ alpha: [0, Number.NaN] }, /alpha\[1\]/, RangeError);
  bad({ color: [{ at: 0, color: [1, 1, 1] }] }, /needs 2 to 8 stops/);
  bad({ color: Array(MAX_GRADIENT_STOPS + 1).fill({ at: 0, color: [1, 1, 1] }) }, /needs 2 to 8 stops/);
  bad(
    {
      color: [
        { at: 0.5, color: [1, 1, 1] },
        { at: 0.2, color: [1, 1, 1] },
      ],
    },
    /ascend by "at"/,
    RangeError,
  );
  bad(
    {
      color: [
        { at: 0, color: [1, 1] },
        { at: 1, color: [1, 1, 1] },
      ],
    },
    /three linear channels/,
  );
  bad(
    {
      color: [
        { at: 0, color: [1, 1, 99] },
        { at: 1, color: [1, 1, 1] },
      ],
    },
    /color\[0\]\.color\[2\]/,
    RangeError,
  );
  assert.throws(() => new Base({ curves: { size: [0, 1] } }), /VFX curves needs curves from @margoengine\/vfx\/curves/);
  assert.doesNotThrow(() => new Base({ curves: { size: [0, 1] } }, { curves }));
});

const stock = () => {
  const { h, effect } = attach({ capacity: 8 });
  h.frame();
  const shaders = { billboardShader: code(h, 'vertex'), simulationShader: code(h, 'compute') };
  effect.dispose();
  return shaders;
};

test('curves feature: the patch refuses a billboard shader it was not written for', () => {
  assert.throws(
    () => curves.patch('struct Out {}', { size: [0, 1] }),
    (e) => e.code === 'unsupported',
  );
  assert.doesNotThrow(() => curves.patch(stock().billboardShader, { size: [0, 1] }));
});

test('emitter feature: sphere and cone patch only the birth, and write the shape numbers', () => {
  const sphere = attach({ capacity: 16, emitter: { shape: 'sphere', radius: 2, shell: true, speed: 3 } });
  sphere.h.frame();
  const sim = code(sphere.h, 'compute');
  assert.match(sim, /var origin=f\.emitterTime\.xyz/);
  assert.match(sim, /shapeDir=vec3f\(sr\*cos\(sa\),sz,sr\*sin\(sa\)\)/);
  assert.ok(!sim.includes('tris'), 'a sphere has no triangle buffer');
  const buffer = sphere.h.resources.find((r) => r.size === 48 && !r.destroyed),
    f = new Float32Array(buffer.data);
  assert.deepEqual([f[0], f[1], f[2]], [2, 1, 3]);
  sphere.effect.options.emitter = { shape: 'sphere', radius: 5, speed: -1 };
  sphere.h.frame();
  assert.deepEqual([f[0], f[1], f[2]], [5, 0, -1], 'numbers are read every frame');
  sphere.effect.dispose();
  assert.ok(sphere.h.resources.every((r) => r.destroyed));

  const cone = attach({
    capacity: 16,
    emitter: { shape: 'cone', radius: 0.5, angle: Math.PI / 3, axis: [0, 0, 2], speed: 4 },
  });
  cone.h.frame();
  assert.match(code(cone.h, 'compute'), /let cosT=mix\(1\.0,em\.a\.w,cv\)/);
  const g = new Float32Array(cone.h.resources.find((r) => r.size === 48 && !r.destroyed).data);
  assert.ok(Math.abs(g[3] - 0.5) < 1e-6, 'cosine of the half angle');
  assert.deepEqual([g[0], g[2], g[4], g[5], g[6]], [0.5, 4, 0, 0, 1], 'axis is normalised');
  cone.effect.dispose();
});

test('emitter feature: a mesh emitter uploads area-weighted triangles and survives device restoration', () => {
  const { h, effect } = attach({ capacity: 16, emitter: { shape: 'mesh', ...quad, scale: 2 } });
  h.frame();
  assert.match(code(h, 'compute'), /var<storage,read> tris:array<vec4f>/);
  const tris = h.resources.find((r) => r.size === 2 * 48 && !r.destroyed),
    f = new Float32Array(tris.data);
  assert.equal(f[3], 0.5, 'the first of two equal triangles holds half of the area');
  assert.equal(f[12 + 3], 1, 'the last holds the whole');
  assert.deepEqual([f[4], f[5], f[6]], [4, 0, 0], 'corner B, scaled');
  assert.equal(new Uint32Array(h.resources.find((r) => r.size === 48 && !r.destroyed).data)[8], 2, 'triangle count');
  effect.onDeviceRestored(h.engine);
  h.frame();
  assert.equal(h.resources.filter((r) => r.size === 96 && !r.destroyed).length, 1, 'rebuilt once');
  effect.dispose();
  assert.ok(h.resources.every((r) => r.destroyed));
});

test('emitter feature: degenerate triangles are left out and an all-degenerate mesh is refused', () => {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 5, 5, 5, 5, 5, 5, 5, 5, 5]);
  const { h, effect } = attach({ capacity: 8, emitter: { shape: 'mesh', positions } });
  h.frame();
  assert.ok(
    h.resources.some((r) => r.size === 48 && !r.destroyed),
    'one real triangle',
  );
  effect.dispose();
  assert.throws(
    () => new VFX({ emitter: { shape: 'mesh', positions: new Float32Array(9) } }),
    (e) => e instanceof RangeError && /no triangle with an area/.test(e.message),
  );
});

test('emitter feature: bad shapes throw errors that name the fix, and the shape is fixed at attach', () => {
  const bad = (e, pattern, kind) =>
    assert.throws(
      () => new VFX({ emitter: e }),
      (error) => error instanceof kind && pattern.test(error.message),
      JSON.stringify(e),
    );
  bad({ shape: 'torus' }, /"sphere", "cone" or "mesh"/, TypeError);
  bad({}, /VFX emitter needs a shape/, TypeError);
  bad({ shape: 'sphere', radius: -1 }, /radius must be a number from 0/, RangeError);
  bad({ shape: 'sphere', shell: 1 }, /shell must be true or false/, TypeError);
  bad({ shape: 'sphere', speed: 1e9 }, /speed/, RangeError);
  bad({ shape: 'cone', angle: 2 }, /angle/, RangeError);
  bad({ shape: 'cone', axis: [0, 0] }, /axis needs \[x, y, z\]/, TypeError);
  bad({ shape: 'cone', axis: [0, 0, 0] }, /axis must not be zero/, RangeError);
  bad({ shape: 'mesh', positions: [1, 2] }, /at least one triangle/, TypeError);
  bad({ shape: 'mesh', positions: [0, 0, 0, 1, 0, Number.NaN, 0, 1, 0] }, /must be finite/, RangeError);
  bad({ shape: 'mesh', positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1] }, /multiple of 3/, TypeError);
  bad({ shape: 'mesh', positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 3] }, /past the positions/, RangeError);
  bad({ shape: 'mesh', positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], scale: 0 }, /scale/, RangeError);
  bad(
    { shape: 'mesh', positions: new Float32Array(MAX_EMITTER_TRIANGLES * 9 + 9) },
    /more than 262144 triangles/,
    RangeError,
  );
  assert.throws(
    () => new Base({ emitter: { shape: 'sphere' } }),
    /VFX emitter needs emitter from @margoengine\/vfx\/emitter/,
  );
  const { h, effect } = attach({ capacity: 8, emitter: { shape: 'sphere' } });
  h.frame();
  effect.options.emitter = { shape: 'cone' };
  assert.throws(
    () => h.frame(),
    (e) => e instanceof TypeError && /shape is fixed at attach \(sphere\)/.test(e.message),
  );
  effect.options.emitter = undefined;
  assert.throws(
    () => h.frame(),
    (e) => e instanceof TypeError && /cannot be removed/.test(e.message),
  );
});

test('emitter feature: the patch refuses a simulation shader it was not written for', () => {
  assert.throws(
    () => emitter.patch('nothing here', { shape: 'sphere' }),
    (e) => e.code === 'unsupported',
  );
  const out = emitter.patch(stock().simulationShader, { shape: 'sphere' });
  assert.equal(out.split('var origin=').length, 2);
  assert.ok(out.includes('shapeDir*em.a.z'));
});

test('curves and emitter together compile alongside every other feature without clashing bindings', () => {
  const { h, effect } = attach({
    capacity: 64,
    initialCount: 64,
    emissionExtent: [1, 1, 1],
    wrap: true,
    sort: true,
    obstacles: [{ kind: 'sphere', center: [0, 0, 0], radius: 1 }],
    texture: {
      width: 2,
      height: 2,
      data: new Uint8Array(16).fill(255),
      atlas: { columns: 2, rows: 2, frames: 'random' },
    },
    curves: { size: [0, 1, 0], alpha: [0, 1, 0] },
    emitter: { shape: 'mesh', ...quad },
  });
  h.frame();
  h.frame();
  effect.onDeviceRestored(h.engine);
  h.frame();
  effect.dispose();
  assert.ok(h.resources.every((r) => r.destroyed));
});
