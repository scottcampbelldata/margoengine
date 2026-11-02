// Cathedral Light: sun through stained glass into a dusty hall, with the time of day on a slider. The hall and the light
// shafts are ray marched by a @margoengine/shader/raw material; the dust is instanced by the same plugin, and the glow
// is @margoengine/post bloom. No other library is involved.
import { createStage } from 'margoengine';
import { engineRuntime } from '@margoengine/core/extension';
import { OrbitControls } from '@margoengine/controls';
import { Bloom } from '@margoengine/post/bloom';
import { RawMesh, RawShaderMaterial, RawShaders } from '@margoengine/shader/raw';
import { paceEngine } from '@margoengine/quality';

// The light model both materials share: where a ray toward the sun leaves the hall decides its colour.
const light = /* wgsl */ `
const W = 6.0; const L = 24.0; const BAY = 6.0; const COL = 4.1; const RCOL = 0.46;
// The lancets of the south wall and the rose of the east end, baked once in bakeGlass below.
fn lancet(q:vec2f)->vec4f { return textureSampleLevel(wall, wallSampler, vec2f((q.x + L) / (2.0 * L), 1.0 - q.y / 14.0), 0.0); }
fn rose(q:vec2f)->vec4f { return textureSampleLevel(roseMap, roseMapSampler, vec2f(q.x / 10.0 + 0.5, 0.5 - (q.y - 9.5) / 10.0), 0.0); }
// The colour the sun gives point p: through the south wall (+x) or the east end (-z), blocked by the columns between.
fn gobo(p:vec3f)->vec3f {
  let s = uniforms.sun;
  let sx = max(s.x, 0.02); let sz = min(s.z, -0.02);
  let q = p + s * (W - p.x) / sx;
  let g = lancet(vec2f(q.z, q.y));
  let z = p.z + s.z * (COL - p.x) / sx;
  let dz = z - floor(z / BAY) * BAY;
  let clear = mix(1.0, smoothstep(RCOL - 0.02, RCOL + 0.04, min(dz, BAY - dz)), step(p.x, COL));
  var c = g.rgb * g.a * clear * step(0.02, s.x);
  let q2 = p + s * (-L - p.z) / sz;
  let g2 = rose(vec2f(q2.x, q2.y));
  c += g2.rgb * g2.a * step(s.z, -0.02);
  return c * uniforms.sunColor;
}`;

const shader = /* wgsl */ `${light}
struct Out { @builtin(position) clip:vec4f, @location(0) ndc:vec2f }
@vertex fn vertex(@builtin(vertex_index) i:u32)->Out {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u)) * 2.0 - 1.0;
  return Out(vec4f(p, 0.0, 1.0), p);
}
fn noise(p:vec3f)->f32 {
  let i = floor(p); var f = fract(p); f = f * f * (3.0 - 2.0 * f);
  let n = dot(i, vec3f(1.0, 57.0, 113.0));
  let h = fract(sin(vec4f(n, n + 1.0, n + 57.0, n + 58.0)) * 43758.5453);
  let h2 = fract(sin(vec4f(n + 113.0, n + 114.0, n + 170.0, n + 171.0)) * 43758.5453);
  return mix(mix(mix(h.x, h.y, f.x), mix(h.z, h.w, f.x), f.y), mix(mix(h2.x, h2.y, f.x), mix(h2.z, h2.w, f.x), f.y), f.z);
}
// The room as a distance: a nave with a pointed vault, walls and end walls, repeated columns and transverse ribs.
fn vault(p:vec3f)->f32 {
  let spring = 12.0; let r = 8.6;
  return select(W - abs(p.x), r - length(vec2f(abs(p.x) + (r - W), p.y - spring)), p.y >= spring);
}
fn map(p:vec3f)->f32 {
  let room = vault(p);
  var d = min(p.y, min(room, L - abs(p.z)));
  let z = p.z - floor(p.z / BAY + 0.5) * BAY;
  let cx = abs(p.x) - COL;
  // Clustered column: a shaft with four engaged shafts and a splayed base.
  var col = length(vec2f(cx, z)) - RCOL;
  col = min(col, min(length(vec2f(abs(cx) - 0.38, z)), length(vec2f(cx, abs(z) - 0.38))) - 0.14);
  col -= 0.16 * smoothstep(0.7, 0.0, p.y);
  d = min(d, max(col, p.y - 12.8));
  // Ribs across the vault at each bay, and a pointed arcade above the columns.
  d = min(d, max(max(abs(z) - 0.2, room - 0.32), 11.0 - p.y));
  let az = p.z - (floor(p.z / BAY) + 0.5) * BAY;
  d = min(d, max(max(abs(cx) - 0.32, 3.4 - length(vec2f(abs(az) + 0.4, p.y - 9.6))), 8.0 - p.y));
  return d;
}
fn normalAt(p:vec3f)->vec3f {
  let e = 0.004;
  return normalize(vec3f(1.0, -1.0, -1.0) * map(p + vec3f(e, -e, -e)) + vec3f(-1.0, -1.0, 1.0) * map(p + vec3f(-e, -e, e)) +
    vec3f(-1.0, 1.0, -1.0) * map(p + vec3f(-e, e, -e)) + vec3f(1.0, 1.0, 1.0) * map(p + vec3f(e, e, e)));
}
fn ao(p:vec3f, n:vec3f)->f32 {
  let o = 0.6 * (0.5 - map(p + n * 0.5)) + 0.3 * (1.3 - map(p + n * 1.3));
  return clamp(1.0 - o * 0.55, 0.15, 1.0);
}
fn stone(p:vec3f)->vec3f {
  let n = noise(p * 2.3) * 0.6 + noise(p * 11.0) * 0.4;
  return vec3f(0.5, 0.46, 0.4) * (0.55 + 0.7 * n);
}
// What the eye sees of a surface: the sun's coloured pool, the sky through the glass as soft fill, candles at night.
fn surface(p:vec3f, n:vec3f, rd:vec3f)->vec3f {
  var albedo = stone(p);
  let fill = uniforms.sky * (0.3 + 0.35 * clamp(1.0 - abs(n.y) + 0.3 * n.y, 0.0, 1.0));
  let candle = vec3f(0.0, 0.7, -L + 3.0);
  let toCandle = candle - p; let dc = dot(toCandle, toCandle);
  // Polished floor flags with thin joints, and a soft mirror of the window glow.
  let floorHit = step(p.y, 0.01);
  let u = p.xz / 1.5; let f = abs(fract(u) - 0.5);
  let flag = mix(albedo * 0.45, albedo * (0.75 + 0.5 * step(0.5, fract((floor(u.x) + floor(u.y)) * 0.5))), smoothstep(0.495, 0.48, max(f.x, f.y)));
  albedo = mix(albedo, flag, floorHit);
  let r = reflect(rd, n);
  let mirror = p + r * (W - p.x) / max(r.x, 0.01);
  let g = lancet(vec2f(mirror.z, mirror.y));
  var c = g.rgb * g.a * step(0.01, r.x) * floorHit * uniforms.glow * 0.3 * pow(1.0 - max(dot(-rd, n), 0.0), 3.0);
  let sun = max(dot(n, uniforms.sun), 0.0);
  c += albedo * (gobo(p) * sun * 2.2 + fill * ao(p, n));
  c += albedo * uniforms.candle * vec3f(1.0, 0.55, 0.22) * 18.0 * max(dot(n, normalize(toCandle)), 0.0) / (dc + 3.0);
  return c;
}
@fragment fn fragment(i:Out)->@location(0) vec4f {
  let v = camera.view;
  let right = vec3f(v[0][0], v[1][0], v[2][0]); let up = vec3f(v[0][1], v[1][1], v[2][1]); let back = vec3f(v[0][2], v[1][2], v[2][2]);
  let m = camera.projection;
  let rd = normalize(right * i.ndc.x / m[0][0] + up * i.ndc.y / m[1][1] - back);
  let ro = camera.position;
  var t = 0.0; var hit = false;
  for (var k = 0.0; k < uniforms.marchSteps; k += 1.0) {
    let h = map(ro + rd * t);
    if (h < 0.002 * max(t, 1.0)) { hit = true; break; }
    t += h;
    if (t > 70.0) { break; }
  }
  let p = ro + rd * t;
  var color = vec3f(0.0);
  if (hit) {
    let n = normalAt(p);
    color = surface(p, n, rd);
    // Windows seen from inside: the glass glows with the sky, brighter where the sun stands behind it.
    let g = lancet(vec2f(p.z, p.y));
    color = mix(color, g.rgb * uniforms.glow, g.a * step(W - 0.02, p.x));
    let g2 = rose(vec2f(p.x, p.y));
    color = mix(color, g2.rgb * uniforms.glow * uniforms.rose, g2.a * step(p.z, -L + 0.02));
  }
  // Light shafts: march to the surface, adding what each dusty sample scatters toward the eye.
  let span = min(t, 60.0); let dt = span / uniforms.shaftSteps;
  let jitter = fract(52.9829189 * fract(dot(i.clip.xy, vec2f(0.06711056, 0.00583715))));
  var scatter = vec3f(0.0);
  let drift = vec3f(camera.time * 0.05, camera.time * 0.02, -camera.time * 0.03);
  for (var k = 0.0; k < uniforms.shaftSteps; k += 1.0) {
    let q = ro + rd * (k + jitter) * dt;
    let dust = 0.4 + 1.1 * noise(q * 1.1 + drift);
    scatter += gobo(q) * dust;
  }
  let phase = 1.0 + 1.6 * pow(max(dot(rd, uniforms.sun), 0.0), 6.0);
  color += scatter * dt * 0.03 * phase;
  let haze = 1.0 - exp(-span * 0.012);
  color = mix(color, uniforms.sky * 0.22, haze);
  return margoDisplay(vec4f(color, 1.0));
}`;

// Each mote is a soft quad, pulled from the instance index, seen only where a shaft of light crosses it.
const dustShader = /* wgsl */ `${light}
struct Out { @builtin(position) clip:vec4f, @location(0) uv:vec2f, @location(1) c:vec3f }
fn h(i:f32, k:f32)->f32 { return fract(sin(i * 12.9898 + k * 78.233) * 43758.5453); }
@vertex fn vertex(@builtin(vertex_index) v:u32, @builtin(instance_index) n:u32)->Out {
  let i = f32(n); let t = camera.time;
  var q = vec3f(h(i, 1.0), h(i, 2.0), h(i, 3.0));
  q = fract(q + vec3f(0.004, -0.0026, 0.003) * t + 0.01 * vec3f(sin(t * 0.3 + i), sin(t * 0.23 + i * 1.7), cos(t * 0.27 + i)));
  let p = vec3f(mix(-3.6, 5.8, q.x), q.y * 11.0, mix(-22.0, 22.0, q.z));
  let corner = array<vec2f, 6>(vec2f(-1, -1), vec2f(1, -1), vec2f(1, 1), vec2f(-1, -1), vec2f(1, 1), vec2f(-1, 1))[v];
  let view = camera.view;
  let right = vec3f(view[0][0], view[1][0], view[2][0]); let up = vec3f(view[0][1], view[1][1], view[2][1]);
  let size = 0.012 + 0.018 * h(i, 4.0);
  let twinkle = 0.55 + 0.45 * sin(t * (0.6 + h(i, 5.0)) + i);
  return Out(camera.viewProjection * vec4f(p + (right * corner.x + up * corner.y) * size, 1.0), corner, gobo(p) * twinkle * 2.4 + uniforms.sky * 0.05);
}
@fragment fn fragment(i:Out)->@location(0) vec4f {
  let a = exp(-dot(i.uv, i.uv) * 3.2);
  return margoDisplay(vec4f(i.c * a, 0.0));
}`;

const stage = await createStage('#viewport', {
  backend: 'webgpu',
  controls: false,
  autoStart: false,
  label: 'A stone hall lit through stained glass, with dust in the light shafts',
  camera: { position: [-1.6, 1.7, 17], target: [-0.3, 3.7, 7], fov: 62, far: 120 },
  onError: (value) => {
    document.querySelector('#error')!.textContent = String(value);
  },
});
paceEngine(stage.engine);
Bloom.attach(stage.engine, { strength: 0.22, threshold: 1.0, exposure: 0 });

const fract = (x: number) => x - Math.floor(x),
  hash2 = (x: number, y: number) => fract(Math.sin(x * 127.1 + y * 311.7) * 43758.5453),
  ramp = (from: number, to: number, x: number) => {
    const k = Math.min(Math.max((x - from) / (to - from), 0), 1);
    return k * k * (3 - 2 * k);
  },
  GLASS = [
    [0.3, 217, 15, 13],
    [0.58, 13, 36, 230],
    [0.76, 255, 158, 15],
    [0.9, 15, 158, 71],
    [2, 242, 230, 184],
  ];
const glass = (x: number, y: number) => GLASS.find((row) => hash2(x, y) < row[0])!;
// Diamond quarries in pointed arches, one arch per six-metre bay, with lead lines and two stone mullions.
function bakeWall(width: number, height: number) {
  const data = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row++)
    for (let column = 0; column < width; column++) {
      const along = ((column + 0.5) / width) * 48 - 24,
        y = (1 - (row + 0.5) / height) * 14,
        bay = Math.floor(along / 6),
        z = along - (bay + 0.5) * 6,
        spring = 9.8,
        half = 1.45,
        radius = 2 * half * 1.15,
        inside =
          Math.abs(along) < 23 &&
          (y >= spring ? Math.hypot(Math.abs(z) + radius - half, y - spring) < radius : Math.abs(z) < half && y > 3.2);
      if (!inside) continue;
      const u = (z + y * 0.62) * 1.25,
        v = (z - y * 0.62) * 1.25,
        fu = Math.abs(fract(u) - 0.5),
        fv = Math.abs(fract(v) - 0.5),
        lead = ramp(0.5, 0.43, Math.max(fu, fv)) * ramp(0.05, 0.1, Math.abs(Math.abs(z) - 0.5)),
        tone = glass(Math.floor(u) + bay * 17, Math.floor(v) + bay * 17),
        at = (row * width + column) * 4;
      data.set([tone[1], tone[2], tone[3], lead * 255], at);
    }
  return data;
}
// Twelve petals in rings around a hub.
function bakeRose(size: number) {
  const data = new Uint8Array(size * size * 4);
  for (let row = 0; row < size; row++)
    for (let column = 0; column < size; column++) {
      const x = ((column + 0.5) / size) * 10 - 5,
        y = 5 - ((row + 0.5) / size) * 10,
        r = Math.hypot(x, y);
      if (r > 4.6) continue;
      const a = ((Math.atan2(y, x) / (Math.PI * 2)) * 12 + 12) % 12,
        ring = Math.floor(r / 1.15),
        tracery =
          ramp(0.02, 0.06, Math.abs(fract(a) - 0.5) * r * 0.5) *
          ramp(0, 0.08, Math.abs(fract(r / 1.15) - 0.03)) *
          ramp(4.6, 4.5, r),
        tone = glass(Math.floor(a) + ring * 13, ring);
      data.set([tone[1], tone[2], tone[3], tracery * 255], (row * size + column) * 4);
    }
  return data;
}
function bakeGlass(data: Uint8Array, width: number, height: number) {
  const device = engineRuntime(stage.engine).gpu!,
    texture = device.createTexture({
      size: [width, height],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
  device.queue.writeTexture({ texture }, data as Uint8Array<ArrayBuffer>, { bytesPerRow: width * 4 }, [width, height]);
  return texture;
}
const glassTextures = { wall: bakeGlass(bakeWall(2048, 600), 2048, 600), roseMap: bakeGlass(bakeRose(640), 640, 640) };

const uniforms = () => ({
  sun: { value: [0, 1, 0], type: 'vec3f' as const },
  sunColor: { value: [1, 1, 1], type: 'vec3f' as const },
  sky: { value: [0, 0, 0], type: 'vec3f' as const },
  glow: { value: 1 },
  rose: { value: 1 },
  candle: { value: 0 },
  marchSteps: { value: 80 },
  shaftSteps: { value: 40 },
});
const hall = new RawShaderMaterial({
    vertexShader: shader,
    uniforms: uniforms(),
    textures: glassTextures,
    depthTest: false,
    depthWrite: false,
    cull: 'none',
    name: 'cathedral-hall',
    onError: (error) => {
      document.querySelector('#error')!.textContent = error.message;
    },
  }),
  dust = new RawShaderMaterial({
    vertexShader: dustShader,
    uniforms: uniforms(),
    textures: glassTextures,
    transparent: true,
    blending: 'additive',
    depthTest: false,
    depthWrite: false,
    cull: 'none',
    name: 'cathedral-dust',
    onError: (error) => {
      document.querySelector('#error')!.textContent = error.message;
    },
  });
const raw = RawShaders.attach(stage.engine);
raw.add(new RawMesh({ material: hall, vertexCount: 3 }));
raw.add(new RawMesh({ material: dust, vertexCount: 6, instanceCount: 3500 }));

// Drag to look around from where you stand.
const camera = stage.engine.camera,
  controls = new OrbitControls(camera, stage.canvas);
controls.enablePan = false;
controls.minDistance = 4;
controls.maxDistance = 12;
controls.minAzimuthAngle = -0.55;
controls.maxAzimuthAngle = 0.55;
controls.minPolarAngle = 0.9;
controls.maxPolarAngle = Math.PI / 2 + 0.05;

const smooth = (a: number, b: number, x: number) => {
  const k = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return k * k * (3 - 2 * k);
};
function setHour(hour: number) {
  // Sun: rises behind the rose at the east end, crosses the south windows, sets toward the west door.
  const day = (hour - 6) / 13,
    elevation = Math.sin(day * Math.PI) * 0.92 + 0.02,
    azimuth = (day - 0.5) * 2.5,
    sun = [Math.cos(elevation) * Math.cos(azimuth), Math.sin(elevation), Math.cos(elevation) * Math.sin(azimuth)],
    up = smooth(-0.03, 0.12, sun[1]),
    warm = 1 - smooth(0.05, 0.55, sun[1]),
    sunColor = [(1 + warm * 0.25) * up * 1.5, (0.92 - warm * 0.34) * up * 1.5, (0.8 - warm * 0.58) * up * 1.5],
    dusk = smooth(-0.15, 0.1, sun[1]),
    sky = [0.018 + dusk * (0.2 + warm * 0.08), 0.022 + dusk * 0.2, 0.05 + dusk * (0.22 - warm * 0.1)],
    glow = 0.12 + dusk * 2.6;
  for (const material of [hall, dust]) {
    const u = material.uniforms;
    u.sun.value = sun;
    u.sunColor.value = sunColor;
    u.sky.value = sky;
    u.glow.value = glow;
    u.rose.value = sun[2] < 0 ? 1.5 : 0.8;
    u.candle.value = 1 - dusk;
  }
  const whole = Math.floor(hour),
    minutes = Math.floor((hour - whole) * 60);
  clock.value = `${whole}:${String(minutes).padStart(2, '0')}`;
}

const slider = document.querySelector<HTMLInputElement>('#hour')!,
  clock = document.querySelector<HTMLOutputElement>('#clock')!,
  play = document.querySelector<HTMLButtonElement>('#play')!;
let playing = false;
const asked = Number(new URLSearchParams(location.search).get('hour'));
if (asked >= 5 && asked <= 21) slider.value = String(asked);
slider.addEventListener('input', () => {
  playing = false;
  play.textContent = 'Play';
  play.setAttribute('aria-pressed', 'false');
  setHour(Number(slider.value));
});
play.addEventListener('click', () => {
  playing = !playing;
  play.textContent = playing ? 'Pause' : 'Play';
  play.setAttribute('aria-pressed', String(playing));
});
document.querySelector('#form')!.addEventListener('submit', (event) => event.preventDefault());
setHour(Number(slider.value));

stage.use({
  name: 'cathedral-day',
  setup() {},
  onPreUpdate(delta) {
    if (raw.stats.drawCalls > 0 && raw.stats.pending === 0) document.querySelector('#status')?.remove();
    if (!playing) return;
    let hour = Number(slider.value) + delta * 0.5;
    if (hour > 21) hour = 5;
    slider.value = String(hour);
    setHour(hour);
  },
  dispose: () => controls.dispose(),
});
stage.engine.start();
window.addEventListener('pagehide', () => stage.dispose(), { once: true });
