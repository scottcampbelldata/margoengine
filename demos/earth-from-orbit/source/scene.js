import { Engine } from '@margoengine/core';
import { Planet } from '@margoengine/creative/planet';
import { OrbitControls } from '@margoengine/controls/orbit';
import { AstroSky, fetchBrightStarCatalog, subsolarPoint, sunPosition } from '@margoengine/sky/astro';
import { MilkyWay } from '@margoengine/sky/milky-way';
import { degrees, sunDirectionFrom } from '@margoengine/sky/sun';
import { PostStack } from '@margoengine/post/stack';
import { Bloom } from '@margoengine/post/bloom';
import { Tonemap } from '@margoengine/tonemap';
import { demoStatus } from 'margo-demo-status';

const $ = (selector) => document.querySelector(selector);
const canvas = $('#scene'), loading = $('#loading'), errorNotice = $('#error'), controls = $('#controls');
const timeInput = $('#time'), dateInput = $('#date');
const status = demoStatus($('#exhibit'), loading, errorNotice);
const lifetime = new AbortController();
// World axes are fixed to the Earth: +Y is the north pole, and an observer standing on the pole at 90 degrees west has
// the sky package's horizon frame lined up with the planet's map, so the Sun and the stars come straight from it.
const pole = { latitude: degrees(90), longitude: degrees(-90) };
const home = { latitude: -28, longitude: -66, distance: 4.4 };
let engine, earth, astro, orbit, frame, observer;

const pad = (n) => String(n).padStart(2, '0');
const clock = () => `${pad(Math.floor(timeInput.value / 60))}:${pad(timeInput.value % 60)}`;
const moment = () => new Date(`${dateInput.value || '2027-03-20'}T${clock()}:00Z`);
const place = (value, plus, minus, digits = 1) => `${Math.abs(value).toFixed(digits)}° ${value >= 0 ? plus : minus}`;
const turnDegrees = 180 / Math.PI;

function size() {
  const bounds = canvas.getBoundingClientRect(), density = Math.min(devicePixelRatio, 2);
  canvas.width = Math.max(1, Math.round(bounds.width * density));
  canvas.height = Math.max(1, Math.round(bounds.height * density));
}

function lookFrom({ latitude, longitude, distance }) {
  // Above a place: the sky package's compass angle from +Z is the longitude east of the frame's 90 W meridian.
  // On a tall screen the camera backs off so the whole globe stays in frame.
  const direction = sunDirectionFrom(degrees(longitude + 90), degrees(latitude)), fit = Math.max(1, (1.3 * canvas.height) / canvas.width);
  engine.camera.target = [0, 0, 0];
  engine.camera.position = direction.map((v) => v * distance * fit);
}

function setTime() {
  const date = moment();
  $('#time-value').textContent = clock();
  earth.setSunDirection(sunPosition(date, pole, { refraction: false }).direction);
  astro.options.date = date;
  const sun = subsolarPoint(date);
  $('#latitude').textContent = place(sun.latitude.degrees, 'N', 'S');
  $('#longitude').textContent = place(sun.longitude.degrees, 'E', 'W');
  document.body.dataset.subsolar = `${sun.latitude.degrees.toFixed(3)},${sun.longitude.degrees.toFixed(3)}`;
  schedule();
}

function showOrigin() {
  const latitude = 90 - orbit.getPolarAngle() * turnDegrees;
  const longitude = ((orbit.getAzimuthalAngle() * turnDegrees + 90) % 360 + 360) % 360 - 180;
  $('#view-origin').textContent = `${place(latitude, 'N', 'S', 0)} · ${place(longitude, 'E', 'W', 0)}`;
}

function draw() {
  frame = undefined;
  const moving = orbit.update(1 / 60);
  showOrigin();
  engine.render({ delta: 1 / 60 });
  if (moving) schedule();
}

function schedule() {
  if (frame !== undefined || lifetime.signal.aborted) return;
  frame = requestAnimationFrame(() => {
    try { draw(); } catch (error) { fail(error); }
  });
}

function dispose() {
  lifetime.abort();
  observer?.disconnect();
  if (frame !== undefined) cancelAnimationFrame(frame);
  orbit?.dispose();
  engine?.dispose();
}

function fail(error) {
  if (lifetime.signal.aborted) return;
  console.error(error);
  status.error(error);
  errorNotice.hidden = false;
  loading.hidden = true;
  controls.disabled = true;
  dispose();
}

async function start() {
  const options = { backend: 'webgpu', exactSize: true, antialias: true, startupTimeout: 9000, signal: lifetime.signal, camera: { fov: 30, near: 0.05, far: 100 } };
  size();
  if (new URLSearchParams(location.search).get('backend') !== 'webgl2') {
    engine = await Engine.create(canvas, options).catch((error) => { if (error?.code !== 'unsupported') throw error; });
  }
  const compatibility = !engine;
  if (compatibility) {
    await (await import('@margoengine/webgl2-compat')).install({ force: true, signal: lifetime.signal });
    engine = await Engine.create(canvas, options);
  }
  engine.onError = fail;
  const url = (name) => new URL(`./${name}`, import.meta.url).href;
  const [catalog, planet] = await Promise.all([
    fetchBrightStarCatalog(url('bright-stars.gz'), { signal: lifetime.signal }),
    Planet.attach(engine, {
      dayMap: url('earth-day.webp'), nightMap: url('earth-night.webp'), specularRoughnessMap: url('earth-shine.webp'),
      clouds: url('earth-clouds.webp'), radius: 1, tilt: 0, atmosphere: { color: [0.32, 0.6, 1], intensity: 1.35 }, signal: lifetime.signal,
    }),
  ]);
  earth = planet;
  // The stars and the Milky Way over the whole sphere, as seen from orbit: no horizon and no air.
  astro = AstroSky.attach(engine, { ...pole, date: moment(), timeScale: 0, catalog, horizon: false, brightness: 8, pointSize: 1 });
  MilkyWay.attach(engine, { astro, horizon: false, surfaceBrightness: 17.6, clouds: 1 });
  PostStack.attach(engine, [new Bloom({ strength: 0.22 }), new Tonemap({ curve: 'agx', exposure: 0.15, contrast: 1.12, vignette: 0.25 })]);
  orbit = OrbitControls.attach(engine);
  Object.assign(orbit, { enableDamping: true, dampingFactor: 0.12, enablePan: false, minDistance: 1.6, maxDistance: 7, rotateSpeed: 0.6 });
  orbit.connect(canvas);
  orbit.listenToKeyEvents(canvas);
  lookFrom(home);
  orbit.update(0);
  orbit.saveState();
  setTime();
  draw();
  await engine.gpu.queue.onSubmittedWorkDone();
  if (lifetime.signal.aborted) return;

  const listen = { signal: lifetime.signal };
  timeInput.addEventListener('input', setTime, listen);
  dateInput.addEventListener('change', setTime, listen);
  $('#reset-view').addEventListener('click', () => (orbit.reset(), schedule()), listen);
  orbit.addEventListener('change', schedule);
  for (const type of ['pointerdown', 'pointermove', 'wheel', 'keydown']) canvas.addEventListener(type, schedule, listen);
  observer = new ResizeObserver(() => (size(), schedule()));
  observer.observe(canvas);
  controls.disabled = false;
  loading.hidden = true;
  Object.assign(document.body.dataset, { ready: 'true', renderer: compatibility ? 'compatibility' : 'webgpu' });
  status.ready();
}

window.addEventListener('pagehide', (event) => { if (!event.persisted) dispose(); }, { signal: lifetime.signal });
start().catch(fail);
