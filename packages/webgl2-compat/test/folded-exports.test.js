// Regression (list 5 R6 row 28, Radeon 680M under ANGLE D3D11): environment fog-all found `fog.enabled = false` one
// binary16 step from no fog in 55 VFX pixels. The unfogged billboard wrote `colour * texel` straight to its output;
// the driver folds that last multiply into the 16-bit export and stores the half below at a few texels, where the
// disabled-fog program's mix (an identity at fog 0) and native WebGPU store the half above. Every float fragment
// output now goes through a select the compiler cannot fold. The GPU check is features-browser.mjs foldedExports (the
// layer equals native exactly) and environment test:gpu:fog-all under MARGO_COMPAT=1; this pins the emitted writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { translateWGSL } from '../dist/glsl.js';

const SOURCE = `struct V { @builtin(position) p: vec4f, @location(0) c: vec4f };
struct Out { @location(0) colour: vec4f, @location(1) id: u32, @location(2) level: f32, @location(3) n: vec2i };
@vertex fn v(@builtin(vertex_index) i: u32) -> V { return V(vec4f(f32(i), 0.0, 0.0, 1.0), vec4f(0.25)); }
@fragment fn f(@location(0) c: vec4f) -> Out { return Out(c * 0.5, 7u, c.x + c.y, vec2i(2)); }
@fragment fn g(@location(0) c: vec4f) -> @location(0) vec4f { return c * 0.5; }`;
const fragment = (entryPoint) =>
  translateWGSL({ vertex: { source: SOURCE, entryPoint: 'v' }, fragment: { source: SOURCE, entryPoint } }).fragment
    .source;

test('every float fragment output is written through a select on gl_FragCoord.w; integer outputs are written straight', () => {
  const struct = fragment('f');
  assert.match(struct, /_o0 = gl_FragCoord\.w > 0\.0 \? _r\.\w+ : vec4\(0\.0\);/);
  assert.match(struct, /_o2 = gl_FragCoord\.w > 0\.0 \? _r\.\w+ : float\(0\.0\);/);
  assert.match(struct, /_o1 = _r\.\w+;/);
  assert.match(struct, /_o3 = _r\.\w+;/);
  assert.match(fragment('g'), /_o0 = gl_FragCoord\.w > 0\.0 \? _r : vec4\(0\.0\);/);
});
