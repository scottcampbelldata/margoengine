import test from 'node:test';
import assert from 'node:assert/strict';
import { Reflector, reflectionConeTangent, reflectionConeLevel } from '../dist/reflector.js';
import { Refractor } from '../dist/refractor.js';
import { PBRReflector, MeshReflector } from '../dist/reflector-pbr.js';
import { reflectionConeShader } from '../../shared/reflection-cone.js';

// Independent form of the cone: Phong exponent n = 2 / alpha^2 - 2 (Walter et al. 2007) for alpha = roughness^2, the
// half-vector cone holding 3/4 of cos^n (cos^(n+1) t = 1/4), the reflected cone twice as wide, capped at 1.4 rad.
const reference = (roughness) => {
  const alpha = roughness * roughness,
    n = 2 / (alpha * alpha) - 2,
    half = Math.acos(0.25 ** (1 / (n + 1)));
  return Math.tan(Math.min(2 * half, 1.4));
};

test('roughness maps to the reflected cone of 3/4 of the lobe, twice the half-vector angle', () => {
  assert.equal(reflectionConeTangent(0), 0, 'a mirror has no cone');
  assert.ok(Math.abs(reflectionConeTangent(1) - Math.tan(1.4)) < 1e-12, 'fully rough caps at 1.4 rad');
  for (const r of [0.1, 0.25, 0.5, 0.6, 0.75, 0.9])
    assert.ok(Math.abs(reflectionConeTangent(r) / reference(r) - 1) < 1e-9, `roughness ${r}`);
  // Roughness 0.5: the half-vector cone is 17.0 degrees, so the reflected cone is 34.0 degrees.
  assert.ok(Math.abs(Math.atan(reflectionConeTangent(0.5)) * (180 / Math.PI) - 34.02) < 0.01);
  let last = 0;
  for (let i = 1; i <= 100; i++) {
    const t = reflectionConeTangent(i / 100);
    // Strictly wider until the 1.4 rad cap (reached near roughness 0.76), then flat.
    assert.ok(t > last || t === Math.tan(1.4), `the cone widens with roughness at ${i / 100}`);
    last = t;
  }
  // Smooth surfaces keep a cone (no cancellation to 0): in the small-angle limit tan(2 t) ~ 2 tan t ~ 2 sqrt(-x),
  // with x = ln cos^2 t = 2 ln(1/4) alpha^2 / (2 - alpha^2).
  for (const r of [1e-3, 0.01, 0.03]) {
    const a2 = r ** 4,
      x = (2 * Math.log(0.25) * a2) / (2 - a2);
    assert.ok(Math.abs(reflectionConeTangent(r) / (2 * Math.sqrt(-x)) - 1) < 1e-3, `smooth ${r}`);
  }
});

test('contact hardening: level 0 at the contact, one level per doubling of distance, clamped', () => {
  const t = reflectionConeTangent(0.5);
  assert.equal(reflectionConeLevel(0.5, 0, 100, 7), 0, 'the contact is sharp');
  assert.equal(reflectionConeLevel(0, 50, 100, 7), 0, 'a mirror is sharp at any distance');
  // Footprint diameter 2 d tan in texels: level log2 of it.
  const d = 4 / (2 * t * 100);
  assert.ok(Math.abs(reflectionConeLevel(0.5, d, 100, 7) - 2) < 1e-12);
  assert.ok(Math.abs(reflectionConeLevel(0.5, 2 * d, 100, 7) - 3) < 1e-12);
  assert.equal(reflectionConeLevel(0.5, 1e6, 100, 7), 7, 'far points take the coarsest level');
  assert.equal(reflectionConeLevel(0.5, 1e-6, 100, 7), 0, 'under one texel reads level 0');
  let last = -1;
  for (let i = 0; i <= 50; i++) {
    const level = reflectionConeLevel(0.4, i * 0.05, 200, 7);
    assert.ok(level >= last, 'blur never falls with distance');
    last = level;
  }
});

test('the WGSL cone carries the same constants as the CPU form', () => {
  assert.match(reflectionConeShader, new RegExp(`x=${(2 * Math.log(0.25)).toFixed(7)}\\*a2/\\(2\\.0-a2\\)`));
  assert.match(reflectionConeShader, /min\(2\.0\*atan\(sqrt\(m\/exp\(x\)\)\),1\.4\)/);
  assert.match(reflectionConeShader, /fn margoCaptureRay\(m:mat4x4f,p:vec3f,d:f32,height:f32\)->vec2f/);
});

test('contactHardening is an option of Reflector, Refractor and PBRReflector and swaps only the blur read', () => {
  const mirror = new Reflector({ roughness: 0.4, contactHardening: true });
  assert.equal(mirror.contactHardening, true);
  assert.equal(new Reflector().contactHardening, false, 'default keeps one blur for the surface');
  assert.equal(new Refractor({ contactHardening: true }).contactHardening, true);
  assert.throws(() => new Reflector({ contactHardening: 1 }), /contactHardening/);
  assert.throws(() => (mirror.contactHardening = 'yes'), /contactHardening/);
  const flat = mirror.surfaceShader,
    cone = mirror.coneShader(flat);
  assert.doesNotMatch(flat, /captureDepth/, 'the default surface binds no depth');
  assert.match(cone, /@binding\(5\) var captureDepth:texture_depth_2d/);
  assert.match(cone, /margoConeLevel\(u\.flags\.w,ray\.x,ray\.y,u\.size\.z\)/);
  assert.doesNotMatch(cone, /uv,u\.size\.z\)\.rgb/, 'the uniform blur read is gone');
  const floor = new PBRReflector({ roughness: 0.5, contactHardening: true }),
    pbr = floor.coneShader(floor.surfaceShader);
  assert.match(pbr, /let lod=margoConeLevel\(u\.flags\.w,ray\.x,ray\.y,u\.size\.z\);/);
  assert.doesNotMatch(pbr, /planeDistance\/u\.pbr\.z/);
  assert.equal((pbr.match(/var captureDepth/g) ?? []).length, 1, 'PBR keeps its one depth binding');
  assert.throws(() => new MeshReflector({ contactHardening: true }), /depthScale/);
  const mesh = new MeshReflector();
  assert.equal(mesh.contactHardening, false);
  assert.throws(() => (mesh.contactHardening = true), /depthScale/);
});
