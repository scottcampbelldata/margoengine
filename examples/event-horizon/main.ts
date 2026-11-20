// Event Horizon: a spinning black hole drawn by @margoengine/shader/black-hole, with its light paths, redshift, beaming,
// temperature and image-order maps. The shot tool drives it through `eventHorizon.apply` (tools/shot/shots/eh-*.json):
// the camera from the shot's camera track, the hole from its `hole` property tracks.
import { OrbitControls } from '@margoengine/controls';
import type { Vec3 } from '@margoengine/core';
import { Bloom } from '@margoengine/post/bloom';
import { PostStack } from '@margoengine/post/stack';
import { paceEngine } from '@margoengine/quality';
import {
  BlackHole,
  type BlackHoleView,
  type Geodesic,
  kerrHorizon,
  kerrIsco,
  kerrPhotonOrbit,
  traceGeodesic,
} from '@margoengine/shader/black-hole';
import { Tonemap } from '@margoengine/tonemap';
import { createStage } from 'margoengine';

const params = new URLSearchParams(location.search);
const ui = params.get('ui') !== '0';
if (!ui) document.querySelector<HTMLElement>('#panel')!.hidden = true;

interface View {
  pos: Vec3;
  target: Vec3;
}
const VIEWS: View[] = [
  { pos: [-0.55, 0.95, 11.8], target: [0, -0.05, 0] }, // inclined, about 85 degrees from the spin axis
  { pos: [0, 0.12, 12.5], target: [0, 0, 0] }, // edge on: the far disk lensed over and under the shadow
  { pos: [0.3, 9.5, 6.2], target: [0, 0, 0] }, // high latitude, looking down the jet
  { pos: [-2.1, 0.52, 6.4], target: [-0.35, 0, 0] }, // skimming the inner rim
];

const stage = await createStage('#viewport', {
  backend: 'webgpu',
  controls: false,
  autoStart: false,
  label: 'Event Horizon: a spinning black hole',
  camera: { position: VIEWS[0].pos, target: VIEWS[0].target, fov: 38, near: 0.05, far: 1000 },
  onError: (value) => {
    document.querySelector('#error')!.textContent = String(value);
  },
});
paceEngine(stage.engine);
PostStack.attach(stage.engine, [
  new Bloom({ strength: 0.18, threshold: 1.1, exposure: 0 }),
  new Tonemap({ curve: 'agx', exposure: 0.1, contrast: 1.06, vignette: 0.2 }),
]);

const hole = BlackHole.attach(stage.engine, { spin: 0.9, accretion: 1, jet: 0.5 });

// Light paths: a fan of rays from a far viewer on +z, in the plane through the spin axis, plus two side fans.
let pathCount = 0;
let pathSpin = -1;
function showPaths(count: number): void {
  if (count === pathCount && hole.spin === pathSpin) return;
  pathCount = count;
  pathSpin = hole.spin;
  const rays: Geodesic[] = [];
  for (let i = 0; i < count; i++) {
    const y = -6 + (12 * (i + 0.5)) / count;
    rays.push(traceGeodesic([0, y, 30], [0, 0, -1], { spin: hole.spin, diskOuter: hole.diskOuter }));
  }
  hole.showGeodesics(rays);
}

// What the shot tool sets each frame: state.properties.hole.<name>.
interface HoleState {
  spin?: number;
  accretion?: number;
  jet?: number;
  turbulence?: number;
  exposure?: number;
  view?: number;
  prefilter?: number;
  paths?: number;
  flareAge?: number;
  peakTemperature?: number;
}
const VIEW_NAMES: BlackHoleView[] = ['beauty', 'redshift', 'beaming', 'temperature', 'orders'];
function apply(state: { properties?: Record<string, HoleState> }): void {
  const h = state.properties?.hole;
  if (!h) return;
  if (h.spin !== undefined) hole.spin = h.spin;
  if (h.accretion !== undefined) hole.accretion = h.accretion;
  if (h.jet !== undefined) hole.jet = h.jet;
  if (h.turbulence !== undefined) hole.turbulence = h.turbulence;
  if (h.exposure !== undefined) hole.exposure = h.exposure;
  if (h.peakTemperature !== undefined) hole.peakTemperature = h.peakTemperature;
  if (h.view !== undefined) hole.view = VIEW_NAMES[Math.min(Math.max(Math.round(h.view), 0), 4)];
  if (h.prefilter !== undefined) hole.prefilter = h.prefilter >= 0.5;
  if (h.paths !== undefined) showPaths(Math.round(h.paths));
  // The hot spot started flareAge seconds ago on the shader clock (performance.now, which the shot tool drives).
  if (h.flareAge !== undefined) hole.flare(performance.now() / 1000 - h.flareAge);
  telemetry();
}

const $ = <T extends HTMLElement>(s: string) => document.querySelector<T>(s)!;
function telemetry(): void {
  const a = hole.spin;
  $('#telemetry').textContent =
    `horizon ${kerrHorizon(a).toFixed(2)} M, ISCO ${kerrIsco(a).toFixed(2)} M, photon orbit ${kerrPhotonOrbit(a).toFixed(2)} M`;
}
function slider(id: string, set: (v: number) => void): void {
  const input = $<HTMLInputElement>(`#${id}`),
    out = $<HTMLOutputElement>(`#${id}-out`);
  input.addEventListener('input', () => {
    set(Number(input.value));
    out.value = Number(input.value).toFixed(2);
    if (pathCount) showPaths(pathCount);
    telemetry();
  });
}
slider('spin', (v) => (hole.spin = v));
slider('accretion', (v) => (hole.accretion = v));
slider('jet', (v) => (hole.jet = v));
document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((b) =>
  b.addEventListener('click', () => {
    hole.view = b.dataset.view as BlackHoleView;
    document.querySelectorAll('[data-view]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  }),
);
const toggle = (id: string, on: (pressed: boolean) => void) =>
  $(`#${id}`).addEventListener('click', (e) => {
    const b = e.currentTarget as HTMLElement,
      pressed = b.getAttribute('aria-pressed') !== 'true';
    b.setAttribute('aria-pressed', String(pressed));
    on(pressed);
  });
toggle('paths', (on) => showPaths(on ? 24 : 0));
toggle('filter', (on) => (hole.prefilter = on));
$('#flare').addEventListener('click', () => hole.flare(performance.now() / 1000));
$('#panel').addEventListener('submit', (e) => e.preventDefault());
telemetry();

// Orbit with the mouse, except when the shot tool drives the camera (`ui=0`); camera buttons fly to a view.
const controls = ui ? new OrbitControls(stage.engine.camera, stage.canvas) : null;
if (controls) {
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.enablePan = false;
  controls.minDistance = 2.2;
  controls.maxDistance = 120;
}
let flight: View | null = null;
document.querySelectorAll<HTMLButtonElement>('[data-cam]').forEach((b) =>
  b.addEventListener('click', () => (flight = VIEWS[Number(b.dataset.cam)])),
);
stage.canvas.addEventListener('pointerdown', () => (flight = null));
stage.canvas.addEventListener('wheel', () => (flight = null), { passive: true });

const viewport = $('#viewport');
stage.use({
  name: 'event-horizon',
  setup() {},
  onPreUpdate(delta) {
    const dt = Math.min(delta, 0.1),
      cam = stage.engine.camera;
    if (flight && controls) {
      const k = Math.min(1, dt * 4),
        f = flight;
      const lerp = (a: Vec3, b: Vec3): Vec3 => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
      cam.position = lerp(cam.position as Vec3, f.pos);
      cam.target = lerp(cam.target as Vec3, f.target);
      controls.target = cam.target as Vec3;
      if (Math.hypot(...f.pos.map((v, i) => v - cam.position[i])) < 0.01) flight = null;
    }
    controls?.update(dt);
    if (hole.raw.stats.drawCalls > 0 && hole.raw.stats.pending === 0 && viewport.dataset.ready !== 'true') {
      viewport.dataset.ready = 'true';
      document.querySelector('#status')?.remove();
    }
  },
  dispose: () => controls?.dispose(),
});

declare global {
  interface Window {
    eventHorizon: { engine: typeof stage.engine; hole: BlackHole; apply: typeof apply };
  }
}
window.eventHorizon = { engine: stage.engine, hole, apply };
stage.engine.start();
window.addEventListener('pagehide', () => stage.dispose(), { once: true });
