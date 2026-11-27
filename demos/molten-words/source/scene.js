import { box } from '@margoengine/core';
import { margoError } from '@margoengine/core/extension';
import { applyQualityTier } from '@margoengine/quality';
import { RawMesh, RawShaderMaterial, RawShaders } from '@margoengine/shader/raw';
import { extrudeText } from '@margoengine/text/extrude';
import { autoEngine } from '@margoengine/webgl2-compat/auto';
import { demoStatus } from 'margo-demo-status';
import { foundrySurface } from './surface.js';

const find = id => document.getElementById(id);
const canvas = find('foundry');
const notice = find('status');
const errorText = find('error');
const status = demoStatus(document.body, notice, errorText);
const word = find('word');
const heat = find('heat');
const temperature = find('temperature');
const pause = find('pause');
const lifetime = new AbortController();
const { signal } = lifetime;
const forced = new URLSearchParams(location.search).get('backend') === 'webgl2';
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const floor = -.77;
const dropCount = 11;
const field = new Intl.NumberFormat(undefined);
const declaredFont = new URL('./assets/FoundrySans-Black.ttf', import.meta.url);
let font, engine, shader, raw, sourceWord, drops, outlets = [];
let frame = 0;
let elapsed = 0;
let last = 0;
let pendingWord;
let lastWordWidth, lastWordValue;
let paused = reduceMotion.matches;
let observer, bloomTimer;

const readyFont = fetch(declaredFont, { signal }).then(response => {
  if (!response.ok) throw new Error('The casting font could not load.');
  return response.arrayBuffer();
});
readyFont.catch(() => {});

function geometryOf(boxGeometry) {
  const { vertices, indices } = boxGeometry;
  const positions = new Float32Array(vertices.length / 2);
  const normals = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    positions.set(vertices.subarray(i * 2, i * 2 + 3), i);
    normals.set(vertices.subarray(i * 2 + 3, i * 2 + 6), i);
  }
  return { positions, normals, indices };
}

function addSurface(geometry, surface, world = [0, 0, 0]) {
  const { positions, normals, indices } = geometry;
  const mesh = raw.add(new RawMesh({
    material: shader,
    frustumCulled: false,
    attributes: {
      position: { type: 'vec3f', data: positions },
      normal: { type: 'vec3f', data: normals },
      surface: { type: 'f32', data: new Float32Array(positions.length / 3).fill(surface) },
    },
    index: indices,
  }));
  mesh.matrix.set(world, 12);
  return mesh;
}

function beadGeometry() {
  const positions = [], normals = [], indices = [];
  const bands = 9, sides = 12;
  for (let ring = 0; ring <= bands; ring++) {
    const latitude = Math.PI * ring / bands;
    const y = Math.cos(latitude), width = Math.sin(latitude);
    for (let edge = 0; edge <= sides; edge++) {
      const theta = Math.PI * 2 * edge / sides;
      const x = Math.cos(theta) * width, z = Math.sin(theta) * width;
      positions.push(x, y, z);
      normals.push(x, y, z);
      if (ring && edge) {
        const i = ring * (sides + 1) + edge;
        indices.push(i - sides - 2, i - sides - 1, i, i - sides - 2, i, i - 1);
      }
    }
  }
  return { positions: Float32Array.from(positions), normals: Float32Array.from(normals), indices };
}

function castingBed() {
  const place = (width, height, depth, p, surface) => addSurface(geometryOf(box(width, height, depth)), surface, p);
  place(19, .24, 18, [0, floor - .14, -.1], 2);
  place(18, 6.6, .25, [0, 2.0, -3.42], 4);
  place(13.8, .31, .13, [0, -.24, -3.24], 3);
  place(13.8, .028, .105, [0, -.064, -3.20], 3);
  for (const x of [-4.8, -2.65, 2.65, 4.8]) place(.13, 5.1, .16, [x, 1.8, -3.26], 3);
  for (const z of [1.27, -1.23]) {
    place(6.54, .12, .16, [0, floor + .044, z], 3);
    place(6.58, .037, .2, [0, floor + .107, z], 3);
  }
  for (const x of [-3.26, 3.26]) place(.12, .13, 2.51, [x, floor + .051, .024], 3);
  const bead = beadGeometry();
  drops = Array.from({ length: dropCount }, () => addSurface(bead, 1));
}

function resizeCanvas() {
  const ratio = Math.min(1.6, devicePixelRatio || 1);
  const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
  const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const aspect = width / height;
  engine.camera.position = [Math.min(1.46, aspect * .76), 1.16, 6.30];
  engine.camera.target = [0, -.01, 0];
  return Math.min(5.64, aspect * 2.85);
}

function allowed(value) {
  return value.normalize('NFKD').replace(/\p{Mark}/gu, '').toUpperCase().replace(/[^A-Z0-9 -]/g, '').trim();
}

function letters(value, width) {
  if (sourceWord) {
    sourceWord.dispose();
    sourceWord = undefined;
  }
  outlets = [];
  if (!value) return;
  const cast = extrudeText(value, {
    font, size: 1, depth: .24, align: 'center', letterSpacing: .025,
    curveSegments: 3, bevelEnabled: true, bevelSize: .002, bevelThickness: .012, bevelSegments: 2,
  });
  if (!cast.indices.length) return;
  const { positions } = cast;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    minX = Math.min(minX, positions[i]);
    maxX = Math.max(maxX, positions[i]);
    minY = Math.min(minY, positions[i + 1]);
    maxY = Math.max(maxY, positions[i + 1]);
  }
  const scale = Math.min(width / Math.max(maxX - minX, .01), 1.56 / Math.max(maxY - minY, .01), 2);
  const centerX = (minX + maxX) * .5;
  const centerY = (minY + maxY) * .5;
  const coords = new Float32Array(positions);
  const bins = new Map();
  const left = (minX - centerX) * scale;
  for (let i = 0; i < coords.length; i += 3) {
    const x = coords[i] = (coords[i] - centerX) * scale;
    const y = coords[i + 1] = (coords[i + 1] - centerY) * scale + .35;
    coords[i + 2] = (coords[i + 2] - .095) * Math.min(1.4, scale);
    if (y > .30) continue;
    const bin = Math.floor((x - left) / .26);
    if (y < (bins.get(bin)?.y ?? Infinity)) bins.set(bin, { x, y, z: .11 });
  }
  const candidates = [...bins.entries()].sort(([a], [b]) => a - b).map(([, edge]) => edge);
  const stride = Math.max(1, Math.ceil(candidates.length / dropCount));
  outlets = candidates.filter((_, i) => i % stride === 0);
  sourceWord = addSurface({ ...cast, positions: coords }, 0);
}

function dropsAt(time) {
  for (let i = 0; i < drops.length; i++) {
    const bead = drops[i];
    const origin = outlets[i];
    if (!origin) { bead.visible = false; continue; }
    const cycle = 1.84 + (i % 5) * .24;
    const phase = (time + i * .417) % cycle;
    const fall = Math.max(0, phase - .63);
    const beadY = origin.y - .042 - 2.50 * fall * fall;
    const grows = Math.min(1, phase / .55);
    bead.visible = phase > .07 && beadY > floor + .027;
    if (!bead.visible) continue;
    const radius = .013 + .026 * grows + (i % 3) * .004;
    bead.matrix[0] = radius;
    bead.matrix[5] = radius * (phase < .63 ? 1.4 + 1.9 * grows : 1.3 + fall);
    bead.matrix[10] = radius * .9;
    bead.matrix.set([origin.x + fall * .027 * Math.sin(i), beadY, origin.z + fall * .04], 12);
  }
}

function fail(error) {
  if (signal.aborted) return;
  status.error(error);
  notice.hidden = true;
  errorText.hidden = false;
  word.disabled = heat.disabled = pause.disabled = true;
  console.error(error);
  dispose();
}

function draw(now) {
  frame = 0;
  if (signal.aborted || !engine || document.hidden) return;
  try {
    const delta = !last || paused ? 0 : Math.min(.05, (now - last) / 1000);
    last = now;
    elapsed += delta;
    shader.uniforms.time.value = elapsed;
    shader.uniforms.heat.value = (+heat.value - 850) / 1000;
    const width = resizeCanvas();
    const value = allowed(word.value);
    const wordChanged = value !== lastWordValue || width !== lastWordWidth;
    if (wordChanged) {
      letters(value, width);
      lastWordValue = value;
      lastWordWidth = width;
    }
    const applied = pendingWord;
    pendingWord = undefined;
    dropsAt(elapsed);
    engine.render({ delta });
    engine.gpu.queue.onSubmittedWorkDone().then(() => {
      if (signal.aborted) return;
      if (raw.stats.pending || raw.stats.drawCalls < 1) {
        if (applied !== undefined) pendingWord = applied;
        schedule();
        return;
      }
      if (!document.body.dataset.ready && status.ready()) {
        document.body.dataset.renderer = engine.gpu.adapterInfo?.vendor === 'margo-webgl2' ? 'webgl2' : 'webgpu';
        document.body.dataset.appliedWord = value;
        notice.hidden = true;
        word.disabled = heat.disabled = pause.disabled = false;
        performance.mark('margo-first-usable-frame');
        bloomTimer = setTimeout(addBloom, 700);
      }
      if (applied !== undefined) {
        document.body.dataset.appliedWord = value;
        performance.mark('molten-word-rendered');
      }
      if (!paused || pendingWord !== undefined) schedule();
    }, fail);
  } catch (error) { fail(error); }
}

function schedule() {
  if (!frame && !signal.aborted && !document.hidden) frame = requestAnimationFrame(draw);
}

function updatePause() {
  pause.textContent = paused ? 'Resume pour' : 'Pause pour';
  pause.setAttribute('aria-pressed', String(paused));
  last = 0;
  schedule();
}

async function addBloom() {
  try {
    const [{ Bloom }, { PostStack }] = await Promise.all([
      import('@margoengine/post/bloom'),
      import('@margoengine/post/stack'),
    ]);
    if (signal.aborted) return;
    PostStack.attach(engine, [new Bloom({ strength: .22, threshold: .82 })]);
    schedule();
  } catch (error) { fail(error); }
}

function dispose() {
  lifetime.abort();
  clearTimeout(bloomTimer);
  if (frame) cancelAnimationFrame(frame);
  observer?.disconnect();
  engine?.dispose();
}

async function loadCompatibility() {
  const { install } = await import('@margoengine/webgl2-compat');
  return { install: () => install({ force: true, signal }) };
}

async function setup(target) {
  if (!target.gpu) throw margoError('unsupported', 'Molten casting requires the shader renderer.');
  engine = target;
  engine.onError = fail;
  font = await readyFont;
  signal.throwIfAborted();
  engine.scene.background = '#211713';
  raw = RawShaders.attach(engine);
  shader = new RawShaderMaterial({
    vertexShader: foundrySurface,
    uniforms: { time: { value: 0 }, heat: { value: .60 } },
    cull: 'none',
    name: 'foundry-surfaces',
  });
  castingBed();
}

async function open() {
  applyQualityTier();
  const options = { signal, exactSize: true, antialias: true, startupTimeout: 3500, camera: { near: .08, far: 28, fov: 34 } };
  if (forced || !navigator.gpu) {
    await (await loadCompatibility()).install();
    await autoEngine(canvas, setup, { ...options, backend: 'webgpu' });
  } else {
    await autoEngine(canvas, setup, { ...options, loadCompat: loadCompatibility });
  }
  if (signal.aborted) return;
  find('controls').addEventListener('submit', event => event.preventDefault(), { signal });
  word.addEventListener('input', () => { pendingWord = word.value; schedule(); }, { signal });
  heat.addEventListener('input', () => { temperature.value = field.format(Number(heat.value)) + ' K'; schedule(); }, { signal });
  pause.addEventListener('click', () => { paused = !paused; updatePause(); }, { signal });
  document.addEventListener('visibilitychange', () => { last = 0; schedule(); }, { signal });
  observer = new ResizeObserver(schedule);
  observer.observe(canvas);
  updatePause();
}
addEventListener('pagehide', event => { if (!event.persisted) dispose(); });
open().catch(fail);
