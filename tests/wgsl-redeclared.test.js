// The shared test harnesses reject a shader module that declares a module-scope WGSL name twice. Water broke this way
// twice on 2026-11-28 (KB-WATER-RIPPLEDUP1, and the surface's rippleAt in 5e00846ff): two chunks joined into one
// program each declared `fn rippleAt`, which every GPU rejects, and no CPU test saw it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertWgslDeclaredOnce, wgslRedeclarations } from './support/wgsl-redeclared.js';
import { mockGPU } from './support/gpu-recorder.js';

// The two halves as they were joined before f40f18e83: the surface's ripple layer and the Ripples field read.
const surface = `fn rippleAt(p:vec2f,turn:vec2f)->f32 {return dot(p,turn);}
fn surfaceHeight(p:vec2f)->f32 {return rippleAt(p,vec2f(1,0));}`;
const field = `struct RippleSurface { grid:vec4f, debug:vec4f }
@group(0) @binding(3) var<uniform> rippleSurface:RippleSurface;
@group(0) @binding(4) var<storage,read> rippleField:array<vec2f>;
fn rippleAt(p:vec2i)->vec2f {let n=i32(rippleSurface.grid.w);return rippleField[u32(p.y*n+p.x)];}`;

test('a program joined from two chunks that both declare rippleAt is caught (KB-WATER-RIPPLEDUP1)', () => {
  assert.deepEqual(wgslRedeclarations(surface + '\n' + field), ['rippleAt']);
  assert.throws(() => assertWgslDeclaredOnce(surface + '\n' + field), /wgsl-redeclared: .*'rippleAt'/);
});

test('every module-scope kind shares one namespace', () => {
  const code = `struct Light { c:vec3f }
alias Light = vec4f;
const k = 1.0;
override k: f32;
var<private> v: f32;
@group(0) @binding(0) var<storage, read_write> v: array<f32>;
fn light() {}`;
  assert.deepEqual(wgslRedeclarations(code), ['Light', 'k', 'v']);
});

test('locals, parameters, struct members and comments are not module-scope declarations', () => {
  const code = `// fn shade() is written below; this line is a comment
/* fn shade() {} */
struct A { x:f32, y:f32 }
struct B { x:f32 }
fn shade(x:f32)->f32 { let y=x; var z=y; const w=2.0; return z*w; }
fn other(x:f32)->f32 { let y=x; var z=y; const w=3.0; { var z=1.0; } return z*w; }
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u) { var shade=1.0; }
const_assert 1 < 2;
enable f16;`;
  assert.deepEqual(wgslRedeclarations(code), []);
  assert.doesNotThrow(() => assertWgslDeclaredOnce(code));
});

test('the shared mock device refuses the joined program at createShaderModule', () => {
  const { device } = mockGPU();
  assert.doesNotThrow(() => device.createShaderModule({ code: field }));
  assert.throws(() => device.createShaderModule({ code: surface + field }), /'rippleAt'/);
});
