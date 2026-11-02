// Molten Words: any typed word becomes dripping liquid chrome. The word is drawn once to a canvas, turned into a signed
// distance field by @margoengine/text, and ray marched by a @margoengine/shader/raw material with bloom from
// @margoengine/post. No other library is involved.
import { createStage } from 'margoengine';
import { engineRuntime } from '@margoengine/core/extension';
import { OrbitControls } from '@margoengine/controls';
import { Bloom } from '@margoengine/post/bloom';
import { RawMesh, RawShaderMaterial, RawShaders } from '@margoengine/shader/raw';
import { alphaToSdf } from '@margoengine/text';
import { paceEngine } from '@margoengine/quality';

const WIDTH = 1024,
  HEIGHT = 256,
  SDF = { size: 48, buffer: 8, radius: 32, cutoff: 0.5 };

const shader = /* wgsl */ `
struct Out { @builtin(position) clip:vec4f, @location(0) ndc:vec2f }
@vertex fn vertex(@builtin(vertex_index) i:u32)->Out {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u)) * 2.0 - 1.0;
  return Out(vec4f(p, 0.0, 1.0), p);
}
const HW = 3.6; const HH = 0.9; const POOL = -1.3; const CELL = 0.3;
fn hash(x:f32)->f32 { return fract(sin(x * 127.1 + 11.7) * 43758.5453); }
fn smin(a:f32, b:f32, k:f32)->f32 { let h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0); return mix(b, a, h) - k * h * (1.0 - h); }
fn texel(x:f32, y:f32)->vec4f { return textureSampleLevel(word, wordSampler, vec2f(x / (2.0 * HW) + 0.5, 0.5 - y / (2.0 * HH)), 0.0); }

fn letters(p:vec3f)->f32 {
  let t = camera.time;
  let q = p.xy + vec2f(0.012 * sin(p.y * 7.0 + t * 1.3 + p.x * 2.0), 0.018 * sin(p.x * 5.0 - t * 1.1));
  let s = texel(clamp(q.x, -HW, HW), clamp(q.y, -HH, HH));
  let v = mix(s.a, s.r, uniforms.morph);
  // alphaToSdf stores 1 - (distance / radius + cutoff); radius is 32 texels and a texel is 2 HW / 1024 world units.
  let d2 = (0.5 - v) * 32.0 * (2.0 * HW / 1024.0) + 0.03;
  // Inflate the outline into round liquid: the cross-section of a stroke is a tube.
  return length(vec2f(max(d2 + 0.1, 0.0), p.z)) - 0.1 - 0.018 * sin(p.x * 3.0 + t * 0.6) * sin(p.y * 4.0 - t * 0.4);
}

// One drip per cell along x, under the lowest ink of that column: a growing thread whose head falls off and returns.
struct Drip { x:f32, z:f32, top:f32, t:f32, length:f32, on:f32 }
fn dripAt(id:f32)->Drip {
  let a = hash(id); let b = hash(id + 3.1); let c = hash(id + 7.7);
  let x = (id + 0.5) * CELL + (a - 0.5) * 0.09;
  let s = texel(clamp(x, -HW, HW), 0.0);
  let top = HH - s.g * 2.0 * HH;
  let on = step(0.5, s.b) * step(b, 0.8) * step(abs(x), HW);
  let period = 2.8 + b * 3.6;
  let t = fract(camera.time / period + c);
  let longest = (top - POOL) * 0.42 + 0.1;
  let length = 0.07 + longest * smoothstep(0.0, 0.6, t) * (1.0 - smoothstep(0.62, 1.0, t));
  return Drip(x, (a - 0.5) * 0.14, top, t, length, on);
}
fn dropHeight(d:Drip)->f32 {
  let start = d.top - ((d.top - POOL) * 0.42 + 0.17);
  let f = max(d.t - 0.6, 0.0);
  return start - 24.0 * f * f;
}
fn drip(p:vec3f, id:f32)->f32 {
  let d = dripAt(id);
  if (d.on < 0.5) { return 9.0; }
  let a = clamp((d.top + 0.04 - p.y) / d.length, 0.0, 1.0);
  let r = mix(0.075, 0.017, sqrt(a));
  var v = length(p - vec3f(d.x, d.top + 0.04 - a * d.length, d.z)) - r;
  let grow = smoothstep(0.0, 0.6, d.t);
  if (d.t < 0.6) {
    v = smin(v, length(p - vec3f(d.x, d.top + 0.04 - d.length, d.z)) - (0.028 + 0.046 * grow), 0.06);
  } else {
    let y = dropHeight(d);
    if (y > POOL - 0.1) { v = min(v, length((p - vec3f(d.x, y, d.z)) * vec3f(1.0, 0.72, 1.0)) - 0.05); }
  }
  return v;
}

fn poolHeight(p:vec3f)->f32 {
  let t = camera.time;
  var h = 0.004 * sin(p.x * 1.9 + t * 0.7) * sin(p.z * 2.3 - t * 0.5) + 0.0012 * sin(p.x * 6.0 - p.z * 5.0 + t * 1.4);
  let c = floor(p.x / CELL);
  for (var k = -uniforms.rings; k <= uniforms.rings; k += 1.0) {
    let d = dripAt(c + k);
    if (d.on < 0.5 || d.t < 0.6) { continue; }
    let start = d.top - ((d.top - POOL) * 0.42 + 0.17);
    let hit = 0.6 + sqrt(max(start - POOL, 0.0) / 24.0);
    let age = (d.t - hit) * 5.0;
    if (age < 0.0) { continue; }
    let r = length(p.xz - vec2f(d.x, d.z));
    h += 0.03 * sin(r * 26.0 - age * 13.0) * exp(-age * 1.6) * exp(-r * 2.6) * smoothstep(age * 1.1 + 0.15, age * 1.1 - 0.15, r);
  }
  return h;
}

fn map(p:vec3f)->f32 {
  var v = (p.y - POOL) * 0.9;
  if (p.y < POOL + 0.25) { v = (p.y - POOL - poolHeight(p)) * 0.8; }
  let box = length(max(abs(p - vec3f(0.0, 0.0, 0.0)) - vec3f(HW, HH, 0.25), vec3f(0.0)));
  if (box > 0.3) { v = min(v, box); } else { v = smin(v, letters(p), 0.03); }
  if (p.y < HH + 0.1 && abs(p.z) < 0.6) {
    let c = floor(p.x / CELL);
    let side = select(-1.0, 1.0, p.x / CELL - c > 0.5);
    let a = min(drip(p, c), drip(p, c + side));
    v = smin(v, a, 0.1);
  } else if (abs(p.z) >= 0.6 && p.y < HH + 0.1) {
    v = min(v, abs(p.z) - 0.35);
  }
  return v;
}
fn normalAt(p:vec3f)->vec3f {
  let e = 0.0016;
  return normalize(
    vec3f(1.0, -1.0, -1.0) * map(p + vec3f(e, -e, -e)) + vec3f(-1.0, -1.0, 1.0) * map(p + vec3f(-e, -e, e)) +
    vec3f(-1.0, 1.0, -1.0) * map(p + vec3f(-e, e, -e)) + vec3f(1.0, 1.0, 1.0) * map(p + vec3f(e, e, e)));
}
fn box(d:vec3f, center:vec3f, size:vec2f, soft:f32)->f32 {
  let f = dot(d, center); if (f <= 0.0) { return 0.0; }
  let side = normalize(cross(center, vec3f(0.0, 1.0, 0.13)));
  let up = cross(side, center);
  let q = vec2f(dot(d, side), dot(d, up)) / f;
  return smoothstep(size.x + soft, size.x - soft, abs(q.x)) * smoothstep(size.y + soft, size.y - soft, abs(q.y));
}
// A dark studio: long softboxes overhead and at the sides, one ember-coloured strip low on the right.
fn env(d:vec3f)->vec3f {
  var c = mix(vec3f(0.018, 0.02, 0.026), vec3f(0.07, 0.075, 0.09), smoothstep(-0.2, 0.9, d.y));
  c += vec3f(0.5, 0.2, 0.07) * exp(-abs(d.y + 0.02) * 14.0) * 0.3;
  // The wall behind the camera, so flat faces of the chrome pick up a broad gradient with one bright band.
  c += vec3f(0.5, 0.52, 0.56) * smoothstep(0.1, 0.9, d.z) * (0.35 + 0.65 * smoothstep(-0.3, 0.6, d.y));
  c += vec3f(4.0, 4.1, 4.4) * smoothstep(0.1, 0.0, abs(d.y - 0.34 - 0.08 * sin(d.x * 5.0))) * smoothstep(0.2, 0.6, d.z);
  c += vec3f(5.5, 5.7, 6.0) * box(d, normalize(vec3f(0.0, 0.9, 0.42)), vec2f(1.5, 0.14), 0.05);
  c += vec3f(2.2, 2.4, 2.9) * box(d, normalize(vec3f(-0.8, 0.28, 0.55)), vec2f(0.1, 0.8), 0.04);
  c += vec3f(5.0, 2.1, 0.7) * box(d, normalize(vec3f(0.85, 0.06, 0.5)), vec2f(0.09, 0.55), 0.04);
  c += vec3f(0.55, 0.58, 0.65) * box(d, normalize(vec3f(0.1, 0.3, -0.95)), vec2f(1.4, 0.03), 0.03);
  return c;
}
fn march(o:vec3f, d:vec3f, steps:f32, far:f32, start:f32)->f32 {
  var t = start;
  for (var i = 0.0; i < steps; i += 1.0) {
    let h = map(o + d * t);
    if (h < 0.0009 * t) { return t; }
    t += h;
    if (t > far) { break; }
  }
  return -1.0;
}
@fragment fn fragment(i:Out)->@location(0) vec4f {
  let v = camera.view;
  let right = vec3f(v[0][0], v[1][0], v[2][0]); let up = vec3f(v[0][1], v[1][1], v[2][1]); let back = vec3f(v[0][2], v[1][2], v[2][2]);
  let p = camera.projection;
  let rd = normalize(right * i.ndc.x / p[0][0] + up * i.ndc.y / p[1][1] - back);
  let ro = camera.position;
  let t = march(ro, rd, uniforms.steps, 40.0, 0.0);
  let backdrop = mix(vec3f(0.012, 0.012, 0.016), vec3f(0.05, 0.03, 0.022), exp(-abs(rd.y) * 7.0));
  var color = backdrop;
  if (t > 0.0) {
    let hit = ro + rd * t;
    let n = normalAt(hit);
    let r = reflect(rd, n);
    let t2 = march(hit + n * 0.01, r, uniforms.steps * 0.32, 14.0, 0.01);
    var seen = env(r);
    if (t2 > 0.0) {
      let h2 = hit + n * 0.01 + r * t2;
      seen = env(reflect(r, normalAt(h2))) * 0.82;
    }
    let f = pow(1.0 - max(dot(n, -rd), 0.0), 5.0);
    let chrome = mix(vec3f(0.93, 0.92, 0.9), vec3f(1.0), f);
    color = mix(seen * chrome, backdrop, smoothstep(16.0, 36.0, t));
  }
  return margoDisplay(vec4f(color, 1.0));
}`;

const stage = await createStage('#viewport', {
  backend: 'webgpu',
  controls: false,
  autoStart: false,
  label: 'A typed word made of dripping liquid chrome above a chrome pool',
  camera: { position: [0, 0.15, 7], target: [0, -0.15, 0], fov: 38, far: 100 },
  onError: (value) => {
    document.querySelector('#error')!.textContent = String(value);
  },
});
paceEngine(stage.engine);
const device = engineRuntime(stage.engine).gpu!;
Bloom.attach(stage.engine, { strength: 0.32, threshold: 1.1, exposure: 0 });

const controls = new OrbitControls(stage.engine.camera, stage.canvas);
controls.minDistance = 3.5;
controls.maxDistance = 22;
controls.maxPolarAngle = Math.PI / 2 + 0.03;
controls.minPolarAngle = Math.PI / 2 - 0.65;

// Far enough back that the whole word fits, on a phone in portrait too.
function frameWord() {
  const aspect = stage.canvas.clientWidth / Math.max(stage.canvas.clientHeight, 1),
    fit = 3.75 / (Math.min(aspect, 1.7) * Math.tan((38 * Math.PI) / 360));
  stage.engine.camera.position = [0, 0.15, Math.min(Math.max(fit, 6), 20)];
}
frameWord();

const texture = device.createTexture({
  size: [WIDTH, HEIGHT],
  format: 'rgba8unorm',
  usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
});
const material = new RawShaderMaterial({
  vertexShader: shader,
  uniforms: { morph: { value: 1 }, steps: { value: 90 }, rings: { value: 3 } },
  textures: { word: texture },
  depthTest: false,
  depthWrite: false,
  cull: 'none',
  name: 'molten-words',
  onError: (error) => {
    document.querySelector('#error')!.textContent = error.message;
  },
});
const raw = RawShaders.attach(stage.engine);
raw.add(new RawMesh({ material, vertexCount: 3 }));

const canvas2d = new OffscreenCanvas(WIDTH, HEIGHT),
  context = canvas2d.getContext('2d', { willReadFrequently: true })!,
  pixels = new Uint8Array(WIDTH * HEIGHT * 4);
let previous = new Uint8Array(WIDTH * HEIGHT).fill(255),
  morphStart = -Infinity;

function setWord(word: string) {
  const family = '900 200px "Arial Black", Impact, Arial, sans-serif';
  context.clearRect(0, 0, WIDTH, HEIGHT);
  context.font = family;
  const room = WIDTH - 110,
    measured = Math.max(context.measureText(word).width, 1),
    size = Math.min(205, (200 * room) / measured);
  context.font = `900 ${size}px "Arial Black", Impact, Arial, sans-serif`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillStyle = '#fff';
  context.fillText(word, WIDTH / 2, HEIGHT / 2);
  const image = context.getImageData(0, 0, WIDTH, HEIGHT).data,
    sdf = alphaToSdf(image, WIDTH, HEIGHT, SDF, 4, 3);
  for (let x = 0; x < WIDTH; x++) {
    let bottom = HEIGHT - 1,
      ink = 0;
    for (let y = HEIGHT - 1; y >= 0; y--)
      if (image[(y * WIDTH + x) * 4 + 3] > 127) {
        bottom = y;
        ink = 255;
        break;
      }
    for (let y = 0; y < HEIGHT; y++) {
      const at = (y * WIDTH + x) * 4,
        cell = y * WIDTH + x;
      pixels[at] = sdf[cell];
      pixels[at + 1] = (bottom * 255) / (HEIGHT - 1);
      pixels[at + 2] = ink;
      pixels[at + 3] = previous[cell];
    }
  }
  previous = sdf.slice();
  device.queue.writeTexture({ texture }, pixels, { bytesPerRow: WIDTH * 4 }, [WIDTH, HEIGHT]);
  morphStart = performance.now();
}

const input = document.querySelector<HTMLInputElement>('#word')!,
  asked = new URLSearchParams(location.search).get('word');
if (asked) input.value = asked.slice(0, 16);
input.addEventListener('input', () => setWord(input.value));
document.querySelector('#form')!.addEventListener('submit', (event) => event.preventDefault());
setWord(input.value);

stage.use({
  name: 'molten-morph',
  setup() {},
  onPreUpdate() {
    if (raw.stats.drawCalls > 0 && raw.stats.pending === 0) document.querySelector('#status')?.remove();
    const k = Math.min((performance.now() - morphStart) / 450, 1);
    material.uniforms.morph.value = k * k * (3 - 2 * k);
  },
  dispose: () => {
    controls.dispose();
    texture.destroy();
  },
});
stage.engine.start();
window.addEventListener('pagehide', () => stage.dispose(), { once: true });
