// The MagicaVoxel mapping: materials (current and older keys, missing keys), render objects (lighting, film, bounces,
// fog, ground), cameras, models and placement, and the tracer options it relies on reaching the frame uniform.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VoxelPathTracer,
  fromMagicaVoxel,
  magicaVoxelCamera,
  magicaVoxelLighting,
  magicaVoxelLinear,
  magicaVoxelMaterial,
  magicaVoxelMatrix,
  magicaVoxelModel,
} from '../dist/index.js';
import { fakeEngine, settle, simpleScene } from './support.js';

const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) <= e, `${a} is not within ${e} of ${b}`);
const near3 = (a, b, e = 1e-6) => a.forEach((v, k) => near(v, b[k], e));
const lin = (v) => (v / 255) ** 2.2;

test('palette colours are linear by a pure 2.2 power', () => {
  near(magicaVoxelLinear(255), 1);
  near(magicaVoxelLinear(128), (128 / 255) ** 2.2);
  near3(magicaVoxelMaterial(3, [255, 128, 0]).color, [1, lin(128), 0]);
});

test('metal: reflectance min(1, specular x colour), GGX width 0.13 x roughness, additive coat', () => {
  const m = magicaVoxelMaterial(5, [255, 191, 77], { _type: '_metal', _metal: '1', _rough: '0.2', _sp: '1.5' });
  assert.equal(m.type, 'metal');
  assert.equal(m.metalness, 1);
  near3(m.metalColor, [1, Math.min(1, 1.5 * lin(191)), 1.5 * lin(77)]);
  near(m.roughness, Math.sqrt(0.13 * 0.2));
  assert.equal(m.coat, 'additive');
  near(m.ior, 1, 0);
  // The older keys win where both are present: _weight is the metalness, _spec the specular minus 1.
  const old = magicaVoxelMaterial(5, [204, 204, 204], {
    _type: '_metal',
    _weight: '0.89',
    _metal: '0.23',
    _spec: '0.5',
    _sp: '1.34',
  });
  near(old.metalness, 0.89);
  near3(old.metalColor, [1.5 * lin(204), 1.5 * lin(204), 1.5 * lin(204)]);
  // Missing keys read as MagicaVoxel reads them: metalness 0, roughness 0, IOR 1 (no coat), specular 1.
  const bare = magicaVoxelMaterial(2, [200, 40, 100], { _type: '_metal' });
  assert.equal(bare.metalness, 0);
  assert.equal(bare.roughness, 0);
  near(bare.ior, 1);
  near3(bare.metalColor, [lin(200), lin(40), lin(100)]);
});

test('glass: _ior is n - 1, colour through _d absorption only, partial transparency per voxel face', () => {
  const g = magicaVoxelMaterial(6, [255, 60, 60], {
    _type: '_glass',
    _trans: '1',
    _ior: '0.5',
    _d: '0.05',
    _media_type: '_absorb',
  });
  assert.equal(g.type, 'glass');
  near(g.ior, 1.5);
  near(g.density, 0.05);
  assert.equal(g.tint, false);
  const half = magicaVoxelMaterial(6, [255, 255, 255], { _type: '_glass', _trans: '0.25', _ior: '0.3' });
  assert.equal(half.type, 'blend');
  near(half.transmission, 0.5);
  assert.equal(half.voxelwise, true);
  near(magicaVoxelMaterial(6, [255, 255, 255], { _type: '_glass', _weight: '1', _ior: '1.5' }).ior, 2.5);
  const scatter = magicaVoxelMaterial(6, [255, 255, 255], {
    _type: '_glass',
    _trans: '1',
    _d: '0.05',
    _media_type: '_scatter',
    _g: '0.3',
  });
  near(scatter.scatter, 0.05);
  near(scatter.anisotropy, 0.3);
});

test('emitters: colour x (1 + 3 x emission x 10^power), reflect nothing; _ldr changes only what the camera sees', () => {
  const e = magicaVoxelMaterial(7, [255, 128, 0], { _type: '_emit', _emit: '0.5', _flux: '2' });
  assert.equal(e.type, 'emit');
  near3(e.color, [0, 0, 0]);
  near3(e.emissionColor, [1, lin(128), 0]);
  near(e.emission, 1 + 3 * 0.5 * 100);
  assert.equal(e.cameraEmission, undefined);
  const l = magicaVoxelMaterial(7, [255, 255, 255], { _type: '_emit', _emit: '1', _flux: '1', _ldr: '0.5' });
  near(l.emission, 31);
  near(l.cameraEmission, 2.5);
  near(magicaVoxelMaterial(7, [255, 255, 255], { _type: '_emit', _weight: '1', _flux: '1' }).emission, 31);
});

test('media: scatter, absorb, emit and subsurface types', () => {
  const cloud = magicaVoxelMaterial(8, [255, 255, 255], {
    _type: '_media',
    _d: '0.05',
    _media_type: '_scatter',
    _g: '-0.2',
  });
  assert.deepEqual([cloud.type, cloud.density, cloud.anisotropy], ['media', 0.05, -0.2]);
  const absorb = magicaVoxelMaterial(8, [255, 60, 60], { _type: '_media', _d: '0.05', _media_type: '_absorb' });
  assert.deepEqual([absorb.type, absorb.ior, absorb.density, absorb.tint], ['glass', 1, 0.05, false]);
  const glow = magicaVoxelMaterial(8, [255, 160, 60], { _type: '_media', _d: '0.2', _media_type: '_emit' });
  assert.equal(glow.density, 0);
  near(glow.emission, 0.93 * 0.2);
  const sss = magicaVoxelMaterial(8, [255, 255, 255], { _type: '_media', _d: '0.05', _media_type: '_sss' });
  assert.deepEqual([sss.type, sss.sunlit], ['media', true]);
  near(sss.density, 0.5);
  // The older _weight reads as density 0.1, scattering.
  near(magicaVoxelMaterial(8, [255, 255, 255], { _type: '_media', _weight: '0.3' }).density, 0.1);
  assert.throws(() => magicaVoxelMaterial(0, [0, 0, 0]), RangeError);
});

test('render objects: sky, sun, ground fade, film, bounces and fog', () => {
  const {
    environment: e,
    options: o,
    unsupported,
  } = magicaVoxelLighting([
    { _type: '_uni', _i: '0.5', _k: '255 255 255' },
    { _type: '_inf', _i: '0.4', _k: '255 255 255', _angle: '45 90', _area: '0.07', _disk: '0' },
    { _type: '_film', _expo: '0.5', _aces: '1', _gam: '2.2' },
    { _type: '_bounce', _diffuse: '2', _specular: '5', _scatter: '5' },
    { _type: '_ground', _color: '80 80 80', _hor: '0.1' },
    { _type: '_fog_uni', _d: '5', _k: '255 200 150', _g: '0.3' },
    { _type: '_edge', _color: '0 0 0', _width: '0.2' },
    { _type: '_setting', _ground: '1', _edge: '1' },
  ]);
  assert.equal(e.skyIntensity, 0.5);
  near(e.sunIntensity, 2);
  // Elevation 45, yaw 90: azimuth 0, from +x; tracer (x, z, -y).
  near3(e.sunDirection, [Math.SQRT1_2, Math.SQRT1_2, 0]);
  near(e.sunAngularSize, 0.69 * 0.07);
  assert.equal(e.sunVisible, false);
  near3(e.groundColor, [lin(80), lin(80), lin(80)]);
  near(e.groundFade, 20400);
  near(e.fog.density, 0.005);
  near3(e.fog.color, [1, 200 / 255, 150 / 255]);
  near(e.fog.anisotropy, 0.3);
  assert.equal(o.toneMapping, 'aces-narkowicz');
  assert.equal(o.gamma, 2.2);
  near(o.exposure, -1);
  assert.deepEqual(o.bounceLimits, { diffuse: 2, specular: 5, scatter: 5 });
  assert.deepEqual(
    [o.transparentShadows, o.sunSpecular, o.sunInMedia, o.energyCompensation],
    [false, false, false, false],
  );
  assert.ok(unsupported.some((u) => u.includes('_edge')));
  assert.equal(magicaVoxelLighting([{ _type: '_setting', _ground: '0' }]).environment.groundColor, undefined);
  assert.equal(magicaVoxelLighting([{ _type: '_film', _aces: '0' }]).options.toneMapping, 'linear');
});

test('cameras: rCAM focus, pitch, yaw and radius; the lens object gives the field of view', () => {
  const c = magicaVoxelCamera({ _mode: 'pers', _focus: '-2 0 8', _angle: '-28.3 42 0', _radius: '122.3', _fov: '30' }, [
    { _type: '_lens', _fov: '35' },
  ]);
  assert.equal(c.fov, 35);
  near3(c.target, fromMagicaVoxel([-2, 0, 8]));
  const p = (-28.3 * Math.PI) / 180,
    y = (42 * Math.PI) / 180;
  near3(
    c.position,
    fromMagicaVoxel([
      -2 + 122.3 * Math.cos(p) * Math.sin(y),
      -122.3 * Math.cos(p) * Math.cos(y),
      8 - 122.3 * Math.sin(p),
    ]),
    1e-9,
  );
  assert.equal(magicaVoxelCamera({ _fov: '30' }).fov, 30);
  // Straight down: screen up is MagicaVoxel +y, tracer -z.
  near3(magicaVoxelCamera({ _focus: '0 0 1', _angle: '-90 0 0', _radius: '190' }).up, [0, 0, -1], 1e-9);
});

test('models and placement: voxel (x, y, z) fills MagicaVoxel world t - floor(size / 2) + cell', () => {
  const size = [2, 3, 4],
    m = magicaVoxelModel('m', 1, size, new Uint8Array([1, 2, 3, 9]));
  assert.deepEqual(m.size, [2, 4, 3]);
  // Tracer cell (x, z, sy - 1 - y) = (1, 3, 0): index x + sx (z_t + sz_t y_t) with tracer size [2, 4, 3].
  assert.equal(m.voxels[1 + 2 * (0 + 3 * 3)], 9);
  const M = magicaVoxelMatrix(size, [10, 20, 30]),
    at = (p) => [0, 1, 2].map((r) => M[r] * p[0] + M[4 + r] * p[1] + M[8 + r] * p[2] + M[12 + r]);
  // Pivot floor(size / 2) = (1, 1, 2): the voxel's MagicaVoxel box starts at t - pivot + cell = (10, 21, 31), so its
  // centre (10.5, 21.5, 31.5) is the image of the tracer cell's centre.
  near3(at([1.5, 3.5, 0.5]), fromMagicaVoxel([10.5, 21.5, 31.5]), 1e-9);
  assert.throws(() => magicaVoxelModel('m', 1, [0, 1, 1], new Uint8Array()), RangeError);
});

test('MagicaVoxel options and environment reach the frame uniform; invalid ones are refused', async () => {
  const h = fakeEngine(),
    scene = simpleScene({
      environment: {
        sunIntensity: 1,
        sunVisible: false,
        groundColor: [0.1, 0.1, 0.1],
        groundFade: 500,
        fog: { density: 0.01, color: [1, 0.5, 0.25], anisotropy: 0.3 },
      },
    }),
    tracer = VoxelPathTracer.attach(h.engine, {
      scene,
      bounceLimits: { diffuse: 2, specular: 5 },
      transparentShadows: false,
      sunSpecular: false,
      sunInMedia: false,
      energyCompensation: false,
      toneMapping: 'aces-narkowicz',
      gamma: 2.2,
    });
  await tracer.ready;
  h.frame();
  await settle();
  h.frame();
  const frame = h.device.buffers.findLast((b) => b.size === 720 && !b.destroyed),
    u = new Uint32Array(frame.data),
    f = new Float32Array(frame.data);
  assert.equal(u[42] & (1024 | 2048 | 4096 | 8192 | 16384), 1024 | 2048 | 4096 | 8192 | 16384);
  assert.equal(u[42] & 512, 0, 'no glass walks with opaque shadows');
  assert.deepEqual([...u.subarray(152, 155)], [2, 5, 0xffff]);
  assert.equal(f[155], 500);
  near(f[156], 0.01);
  near(f[157], 0.3);
  assert.equal(f[158], 1);
  near3([...f.subarray(160, 163)], [1, 0.5, 0.25]);
  near(f[164 + 7], f[164 + 8], 0.05); // isotropy near the horizon is about a half either side
  assert.deepEqual(tracer.options.bounceLimits, { diffuse: 2, specular: 5, scatter: undefined });
  assert.throws(() => tracer.setOptions({ gamma: 0.5 }), RangeError);
  assert.throws(() => tracer.setOptions({ toneMapping: 'filmic' }), TypeError);
  assert.throws(() => tracer.setOptions({ bounceLimits: { diffuse: 0 } }), RangeError);
  assert.throws(() => tracer.setOptions({ transparentShadows: 1 }), TypeError);
  assert.throws(() => tracer.setScene(simpleScene({ revision: 2, environment: { fog: { density: -1 } } })), RangeError);
  assert.throws(
    () =>
      tracer.setScene(
        simpleScene({ revision: 2, materials: [{ id: 1, color: [1, 1, 1], type: 'diffuse', coat: 'thick' }] }),
      ),
    TypeError,
  );
  tracer.dispose();
});
