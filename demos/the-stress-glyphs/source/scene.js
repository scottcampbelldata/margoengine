import { Geometry, PbrMaterial } from '@margoengine/core';
import { margoError } from '@margoengine/core/extension';
import { boxGeometry, cylinderGeometry } from '@margoengine/geometry/primitives';
import { prepareGlyphs } from '@margoengine/sciviz/glyph';
import { tensorEigen } from '@margoengine/sciviz/tensor';
import { autoEngine } from '@margoengine/webgl2-compat/auto';
import { demoStatus } from 'margo-demo-status';
import { plate, startAngle, toRadians, stressAt, glyphField, samples } from './field.mjs';
import { shell, signalShape, rimSection } from './geometry.mjs';

const $ = id => document.getElementById(id);
const overlay = $('status'), slider = $('angle');
const buttons = ['principal', 'shear'].map($);
const controller = new AbortController(), { signal } = controller;
let canvas = $('view'), status = demoStatus(canvas, overlay, $('reason'));
let engine, assembly, observer, frame, stale = false, drawing = false;
let desired = { deg: startAngle, mode: 'principal' }, revision = 0, action = '';
const edgeSections = 60, edgeStep = 2 * Math.PI / edgeSections;
const appliedLength = .036, scalePerMPa = .00098;

const material = (color, options = {}) => new PbrMaterial({ color, roughness: .56, ...options });
const finishes = {
  sheet: material('#344852', { roughness: .47 }),
  frame: material('#25333d', { roughness: .76 }),
  base: material('#192731', { roughness: .84 }),
  fastening: material('#8ba0a2', { roughness: .32 }),
  recess: material('#1d2930', { roughness: .94 }),
  datum: material('#5a726f', { roughness: .75 }),
  tension: material('#e9b082', { roughness: .42, emissive: [.15, .075, .022] }),
  compression: material('#79e3e8', { roughness: .41, emissive: [.018, .14, .16] }),
  shear: material('#d1b8f1', { roughness: .44, emissive: [.11, .078, .15] }),
  pull: material('#f4ddb3', { roughness: .42, emissive: [.09, .086, .05] }),
  probe: material('#e1e3bd', { roughness: .32, emissive: [.27, .23, .11] }),
};
const rimPalette = ['#72d9df','#72a6b4','#61818e','#60747d','#6e7c79','#839080',
  '#9a967f','#b2a080','#cca57e','#dfab76','#edb575','#f5c17e','#ffcb8d']
  .map((c, i) => material(c, { roughness: .62, emissive: i < 3 ? [.018,.075,.068] : [.05,.022,.006] }));

function geometry({ points, positions, normals, indices }) {
  return new Geometry(points ?? positions, normals, indices);
}

function part(g, m, position, scale, name) {
  const mesh = engine.createMesh().setGeometry(g).setMaterial(m);
  if (position) mesh.setPosition(position);
  if (scale) mesh.setScale(scale);
  if (name) mesh.name = name;
  return mesh;
}

function assemble() {
  const stages = [
    [.367,.258,plate.radius,-.026,-.013,.0041,finishes.base, 'Lower specimen cradle'],
    [.346,.239,plate.radius,-.013,-.0003,.0025,finishes.frame, 'Beveled backing frame'],
    [plate.width,plate.depth,plate.radius,0,plate.thickness,.00145,finishes.sheet,'Sheet'],
  ];
  for (const [width, depth, radius, lower, top, bevel, tint, name] of stages)
    part(geometry(shell(width, depth, radius, lower, top, bevel)), tint, null, null, name);
  const circle = geometry(cylinderGeometry(.0368,.0368,.0017,72));
  part(circle, finishes.recess, [0,-.025,0], null, 'Dark aperture well');
  const bolt = geometry(cylinderGeometry(.0051,.006,.003,12));
  const inset = geometry(cylinderGeometry(.0032,.0032,.001,6));
  const line = geometry(boxGeometry(1,1,1));
  for (const x of [-.172,.172]) for (const z of [-.101,.101]) {
    part(bolt, finishes.fastening, [x,.0002,z], null, 'Cradle fastener');
    part(inset, finishes.recess, [x,.00185,z], null, 'Hex recess');
  }
  for (const end of [-1,1]) {
    for (let index = -8; index <= 8; index++) {
      const length = index % 4 === 0 ? .005 : .0024;
      part(line, finishes.datum, [index * .015,.00713,end * (.100 - length * .5)], [.00045,.00025,length], 'Datum graduation');
    }
    part(line, finishes.datum, [0,.0071,end * .100], [.253,.00020,.00049], 'Datum rule');
  }
  const edgeGeometry = geometry(rimSection(0, edgeStep));
  const edge = Array.from({ length: edgeSections }, (_, i) => {
    const theta = i * edgeStep;
    return part(edgeGeometry, rimPalette[3], null, null, 'Hoop stress sector').setRotation([0,theta,0]);
  });
  const probe = geometry(cylinderGeometry(.0024,.0024,.0013,18));
  part(probe, finishes.probe, [plate.radius + .0036,.0086,0], null, 'Right rim probe');
  const load = geometry(signalShape('pull'));
  const arrows = [part(load, finishes.pull, null, [appliedLength,.004,.023], 'Remote pull A'),
    part(load, finishes.pull, null, [appliedLength,.004,.023], 'Remote pull B')];
  const glyphs = Object.fromEntries(['tension','compression','shear'].map(name => [
    name, { pool: [], geometry: geometry(signalShape(name)), tint: finishes[name] },
  ]));
  return { edge, arrows, glyphs };
}

function fail(error) {
  if (status.failed || signal.aborted) return;
  status.error(error);
  const unsupported = error?.code === 'unsupported';
  overlay.querySelector('strong').textContent = unsupported ?
    'This view needs WebGPU or full WebGL2.' : 'The stress field could not open.';
  $('help').hidden = !unsupported;
  overlay.hidden = false;
  for (const control of [slider, ...buttons]) control.disabled = true;
}

function fit() {
  const ratio = Math.min(1.7, Math.max(1, devicePixelRatio));
  const w = Math.round(canvas.clientWidth * ratio), h = Math.round(canvas.clientHeight * ratio);
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const camera = engine.camera, target = [.008, -.004, 0], height = Math.max(.305,.470 * h / w);
  const depth = camera.far - camera.near;
  camera.position = [.064,.63,.31];
  camera.target = target;
  camera.project = (out, aspect, webgpu) => {
    out[0] = 2 / (height * aspect);
    out[5] = 2 / height;
    out[10] = webgpu ? 1 / depth : -2 / depth;
    out[14] = webgpu ? camera.far / depth : -(camera.far + camera.near) / depth;
    out[15] = 1;
  };
  const probe = $('probe');
  probe.hidden = false;
  probe.style.left = canvas.clientWidth * .5 + canvas.clientHeight * .046 / height + 'px';
  probe.style.top = canvas.clientHeight * .5 + canvas.clientHeight * .009 / height + 'px';
}

function placeIndicators(angle) {
  for (const [index, mesh] of assembly.arrows.entries()) {
    const a = angle + Math.PI * index, c = Math.cos(a), s = Math.sin(a);
    const radius = Math.min(.158 / Math.abs(c), .109 / Math.abs(s)) + .026;
    mesh.setPosition([c * radius,.009,-s * radius]).setRotation([0,a,0]);
  }
  for (const [index, tile] of assembly.edge.entries()) {
    const theta = index * edgeStep;
    const hoop = stressAt(Math.cos(theta) * plate.radius, Math.sin(theta) * plate.radius, angle).tt;
    const tint = Math.round((hoop + 10) * .30);
    tile.setMaterial(rimPalette[Math.max(0, Math.min(rimPalette.length - 1, tint))]);
  }
}

async function renderGlyphs(snapshot) {
  const a = toRadians(snapshot.deg), field = glyphField(a, snapshot.mode, tensorEigen);
  const packs = await Promise.all(Object.entries(field.marks).map(async ([name, marks]) => [
    name, await prepareGlyphs({ points: marks.flatMap(mark => mark.position) }, {
      vectors: marks.flatMap(mark => mark.vector), scaleMode: 'magnitude', scaleFactor: scalePerMPa, signal,
    }),
  ]));
  signal.throwIfAborted();
  if (snapshot !== desired) return false;
  for (const [name, instances] of packs) {
    const { pool, geometry, tint } = assembly.glyphs[name];
    for (let i = 0; i < instances.ids.length; i++) {
      if (!pool[i]) pool[i] = part(geometry, tint, null, null, name + ' glyph');
      const mesh = pool[i], index = i * 3;
      mesh.visible = true;
      mesh.setPosition(Array.from(instances.positions.subarray(index, index + 3)));
      mesh.setQuaternion(instances.quaternions.subarray(i * 4, i * 4 + 4));
      mesh.setScale([instances.scales[index], .00325, .00435]);
    }
    for (let i = instances.ids.length; i < pool.length; i++) pool[i].visible = false;
    canvas.dataset[name] = String(instances.ids.length);
  }
  canvas.dataset.residual = String(field.residual);
  placeIndicators(a);
  return true;
}

function readout(snapshot) {
  const principal = snapshot.mode === 'principal';
  slider.value = String(snapshot.deg);
  slider.setAttribute('aria-valuetext', snapshot.deg + ' degrees');
  $('degrees').textContent = snapshot.deg + '°';
  for (const button of buttons) button.setAttribute('aria-pressed', String(button.id === snapshot.mode));
  $('principal-legend').hidden = !principal;
  $('shear-legend').hidden = principal;
  const hoop = stressAt(plate.radius, 0, toRadians(snapshot.deg)).tt;
  $('rim-stress').textContent = (hoop < 0 ? '−' : '+') + Math.abs(hoop).toFixed(1) + ' MPa';
  canvas.dataset.hoop = hoop.toFixed(8);
}

function schedule() {
  stale = true;
  if (frame === undefined && !drawing && !status.failed && !signal.aborted) frame = requestAnimationFrame(draw);
}
function change(patch, name) {
  desired = { ...desired, ...patch };
  revision++;
  action = name;
  readout(desired);
  schedule();
}
async function complete(snapshot, version, trigger) {
  fit();
  engine.render({ delta: 0 });
  await engine.gpu.queue.onSubmittedWorkDone();
  signal.throwIfAborted();
  canvas.dataset.angle = String(snapshot.deg);
  canvas.dataset.mode = snapshot.mode;
  canvas.dataset.samples = String(samples.length);
  canvas.dataset.revision = String(version);
  canvas.dataset.action = trigger;
  if (version > 0 && !performance.getEntriesByName('stress-first-change').length)
    performance.mark('stress-first-change');
}
async function draw() {
  frame = undefined;
  if (status.failed || signal.aborted || !stale) return;
  stale = false;
  drawing = true;
  try {
    const snapshot = desired, version = revision, trigger = action;
    if (await renderGlyphs(snapshot)) await complete(snapshot, version, trigger);
  } catch (error) { fail(error); }
  finally {
    drawing = false;
    if (stale) schedule();
  }
}

function controls() {
  slider.addEventListener('input', () => change({ deg: Number(slider.value) }, 'angle'), { signal });
  for (const button of buttons) button.addEventListener('click', () => change({ mode: button.id }, button.id), { signal });
  let previous = canvas.clientWidth + 'x' + canvas.clientHeight;
  observer = new ResizeObserver(() => {
    const size = canvas.clientWidth + 'x' + canvas.clientHeight;
    if (size !== previous) {
      previous = size;
      schedule();
    }
  });
  observer.observe(canvas);
}

async function open() {
  const force = new URLSearchParams(location.search).get('backend') === 'webgl2';
  const known = force || !navigator.gpu;
  const loadCompat = async () => {
    const compat = await import('@margoengine/webgl2-compat');
    return { install: () => compat.install({ force, signal }) };
  };
  if (known) await (await loadCompat()).install();
  engine = await autoEngine(canvas, async target => {
    if (!target.gpu) throw margoError('unsupported', 'The stress scene needs the full Margo graphics layer', 'sciviz');
    engine = target;
    canvas = target.canvas;
    status = demoStatus(canvas, overlay, $('reason'));
    engine.scene.background = '#202b33';
    engine.lighting.direction.set([-.42,.77,.29,2.75]);
    engine.lighting.radiance.set([1,.93,.78,.76]);
    engine.lighting.ambient.set([.47,.61,.68]);
    assembly = assemble();
    await renderGlyphs(desired);
    await complete(desired, 0, '');
  }, {
    loadCompat, signal, backend: known ? 'webgpu' : undefined, exactSize: true, antialias: true,
    capacity: 512, startupTimeout: 8500, camera: { near: .04, far: 8 },
  });
  signal.throwIfAborted();
  engine.onError = fail;
  canvas.dataset.renderer = engine.gpu.adapterInfo?.vendor === 'margo-webgl2' ? 'webgl2' : 'webgpu';
  readout(desired);
  for (const control of [slider, ...buttons]) control.disabled = false;
  controls();
  overlay.hidden = true;
  performance.mark('margo-first-usable-frame');
  status.ready();
}
window.addEventListener('pagehide', event => {
  if (event.persisted) return;
  controller.abort();
  observer?.disconnect();
  if (frame !== undefined) cancelAnimationFrame(frame);
  engine?.dispose();
});
open().catch(fail);
