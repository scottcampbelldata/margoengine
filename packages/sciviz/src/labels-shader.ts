import type { FusionVolume } from './labels.js';

/** @internal Clean-room sample-level fusion shader. No proxy surface or per-volume draw sorting. */
export function fusionShader(sources: readonly FusionVolume[]): string {
  const bindings = sources
    .map(
      (s, i) => /* wgsl */ `
@group(1) @binding(${2 + i * 2}) var data${i}: texture_3d<${s.kind === 'labels' ? 'u32' : 'f32'}>;
@group(1) @binding(${3 + i * 2}) var table${i}: texture_2d<f32>;`,
    )
    .join('\n');
  const functions = sources
    .map((s, i) => {
      const colour =
        s.kind === 'labels'
          ? /* wgsl */ `
  let dims = vec3i(textureDimensions(data${i}));
  let at = clamp(vec3i(round(p * vec3f(dims - 1))), vec3i(0), dims - 1);
  let id = textureLoad(data${i}, at, 0).r;
  if (id >= textureDimensions(table${i}).x) { return vec4f(0.0); }
  let fill = textureLoad(table${i}, vec2i(i32(id), 0), 0);
  let outline = textureLoad(table${i}, vec2i(i32(id), 1), 0);
  let width = i32(textureLoad(table${i}, vec2i(i32(id), 2), 0).r);
  var edge = false;
  for (var d = 1; d <= width; d++) {
    for (var k = 0u; k < 8u; k++) {
      let offsets = array<vec2f, 8>(vec2f(-1.0,-1.0),vec2f(0.0,-1.0),vec2f(1.0,-1.0),vec2f(-1.0,0.0),vec2f(1.0,0.0),vec2f(-1.0,1.0),vec2f(0.0,1.0),vec2f(1.0,1.0));
      let offset = offsets[k] * f32(d);
      let neighbour = (s.toUnit * vec4f(world + deltaX * offset.x + deltaY * offset.y, 1.0)).xyz;
      if (any(neighbour < vec3f(0.0)) || any(neighbour > vec3f(1.0))) { edge = true; }
      let cell = clamp(vec3i(round(neighbour * vec3f(dims - 1))), vec3i(0), dims - 1);
      if (textureLoad(data${i}, cell, 0).r != id) { edge = true; }
    }
  }
  return corrected(select(fill, outline, edge), step);`
          : s.kind === 'components'
            ? /* wgsl */ `
  let sample = textureSampleLevel(data${i}, linearSampler, (p * (s.dims.xyz - 1.0) + 0.5) / s.dims.xyz, 0.0);
  var result = vec4f(0.0);
  for (var c = 0u; c < ${s.components.length}u; c++) {
    let tf = textureSampleLevel(table${i}, linearSampler, vec2f((sample[c] * 255.0 + 0.5) / 256.0, (f32(c) + 0.5) / 4.0), 0.0);
    result = mixSample(result, corrected(tf, step * s.weights[c]), volume.settings.y);
  }
  return result;`
            : /* wgsl */ `
  return corrected(textureSampleLevel(data${i}, linearSampler, (p * (s.dims.xyz - 1.0) + 0.5) / s.dims.xyz, 0.0), step);`;
      return /* wgsl */ `
fn source${i}(world: vec3f, stepLength: f32, direction: vec3f, deltaX: vec3f, deltaY: vec3f) -> vec4f {
  let s = volume.sources[${i}];
  let p = (s.toUnit * vec4f(world, 1.0)).xyz;
  if (any(p < vec3f(0.0)) || any(p > vec3f(1.0))) { return vec4f(0.0); }
  let speed = length((s.toUnit * vec4f(direction, 0.0)).xyz * (s.dims.xyz - 1.0));
  let step = stepLength * speed * s.dims.w * volume.hi.w;
  ${colour}
}`;
    })
    .join('\n');
  return /* wgsl */ `
struct Source { toUnit: mat4x4f, dims: vec4f, weights: vec4f }
struct Volume { toData: mat4x4f, lo: vec4f, hi: vec4f, settings: vec4f, sources: array<Source, ${sources.length}> }
@group(1) @binding(0) var<uniform> volume: Volume;
@group(1) @binding(1) var linearSampler: sampler;
${bindings}
struct Out { @builtin(position) clip: vec4f, @location(0) ndc: vec2f }
@vertex fn vertex(@builtin(vertex_index) index: u32) -> Out {
  let positions = array<vec2f,3>(vec2f(-1.0,-1.0),vec2f(3.0,-1.0),vec2f(-1.0,3.0));
  var out: Out; out.ndc = positions[index]; out.clip = vec4f(out.ndc, 0.0, 1.0); return out;
}
fn corrected(c: vec4f, length: f32) -> vec4f {
  if (length <= 0.0) { return vec4f(0.0); }
  return vec4f(c.rgb, 1.0 - pow(max(0.0, 1.0 - c.a), length));
}
fn mixSample(a: vec4f, b: vec4f, mode: f32) -> vec4f {
  if (a.a <= 0.0) { return b; } if (b.a <= 0.0) { return a; }
  if (mode > 1.5) { return select(a, b, b.a > a.a); }
  let alpha = 1.0 - (1.0 - a.a) * (1.0 - b.a);
  if (mode > 0.5) { return vec4f((a.rgb * a.a + b.rgb * b.a * (1.0 - a.a)) / alpha, alpha); }
  let ta = -log(max(1e-7, 1.0 - a.a)); let tb = -log(max(1e-7, 1.0 - b.a));
  return vec4f((a.rgb * ta + b.rgb * tb) / (ta + tb), alpha);
}
${functions}
@fragment fn fragment(in: Out) -> @location(0) vec4f {
  let nearH = frame.inverse * vec4f(in.ndc, 1.0, 1.0);
  let farH = frame.inverse * vec4f(in.ndc, 0.00001, 1.0);
  let origin = (volume.toData * vec4f(nearH.xyz / nearH.w, 1.0)).xyz;
  let direction = normalize((volume.toData * vec4f(farH.xyz / farH.w, 1.0)).xyz - origin);
  let originX = dpdx(origin); let originY = dpdy(origin);
  let directionX = dpdx(direction); let directionY = dpdy(direction);
  // Branch on parallel axes to avoid 0*infinity on box boundaries.
  var enter = 0.0; var exit = 1e30;
  for (var a = 0u; a < 3u; a++) {
    if (abs(direction[a]) < 1e-20) { if (origin[a] < volume.lo[a] || origin[a] > volume.hi[a]) { discard; } }
    else { let t0 = (volume.lo[a] - origin[a]) / direction[a]; let t1 = (volume.hi[a] - origin[a]) / direction[a]; enter = max(enter, min(t0, t1)); exit = min(exit, max(t0, t1)); }
  }
  let opaque=opaquePoint(in.clip.xy,in.ndc);
  if(opaque.w>0.0){let p=(volume.toData*opaque).xyz;exit=min(exit,dot(p-origin,direction));}
  if (exit <= enter) { discard; }
  var rate = 0.0;
  for (var i = 0u; i < ${sources.length}u; i++) { let s = volume.sources[i]; rate = max(rate, length((s.toUnit * vec4f(direction, 0.0)).xyz * (s.dims.xyz - 1.0))); }
  let stride = max(1.0 / (rate * volume.lo.w), (exit - enter) / 2048.0);
  let count = min(2048u, u32(ceil((exit - enter) / stride)));
  var result = vec4f(0.0);
  for (var i = 0u; i < count; i++) {
    let t = enter + f32(i) * stride; let segment = min(stride, exit - t);
    let world = origin + direction * (t + segment * 0.5);
    let deltaX = originX + directionX * (t + segment * 0.5);
    let deltaY = originY + directionY * (t + segment * 0.5);
    var sample = vec4f(0.0);
    ${sources.map((_, i) => `sample = mixSample(sample, source${i}(world, segment, direction, deltaX, deltaY), volume.settings.x);`).join('\n')}
    result = mixSample(result, sample, 1.0);
    if (result.a > 0.9999) { break; }
  }
  if (result.a <= 0.0) { discard; }
  return vec4f(toOutput(result.rgb), result.a);
}`;
}
