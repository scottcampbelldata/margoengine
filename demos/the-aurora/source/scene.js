import { Engine } from '@margoengine/core';
import { Sky } from '@margoengine/sky/base';
import { preetham } from '@margoengine/sky/preetham';
import { night } from '@margoengine/sky/night';
import { lighting } from '@margoengine/sky/lighting';
import { AstroSky, fetchBrightStarCatalog } from '@margoengine/sky/astro';
import { MilkyWay } from '@margoengine/sky/milky-way';
import { Aurora } from '@margoengine/sky/aurora';
import { Moon, loadMoonAlbedo } from '@margoengine/sky/moon';
import { degrees } from '@margoengine/sky/sun';
import { Snow } from '@margoengine/weather/snow';
import { Shadows } from '@margoengine/shadows';
import { distanceShadows } from '@margoengine/shadows/distance';
import { PostStack } from '@margoengine/post/stack';
import { Bloom } from '@margoengine/post/bloom';
import { Tonemap } from '@margoengine/tonemap';
import { demoStatus } from 'margo-demo-status';
import { buildLandscape, ground } from './land.js';

const $ = (selector) => document.querySelector(selector);
const canvas = $('#scene'), loading = $('#loading'), errorNotice = $('#error'), controls = $('#controls');
const slider = $('#night'), playButton = $('#play');
const status = demoStatus($('#exhibit'), loading, errorNotice);
const lifetime = new AbortController();
const site = { latitude: degrees(69.72), longitude: degrees(23.59) };
const midnight = Date.parse('2027-02-15T00:00:00Z');
/** Seconds of the aurora's own clock per minute of the night slider: the curtains fold as the night is scrubbed. */
const foldsPerMinute = 9;
let engine, astro, aurora, moon, land, frame, last, observer, minutes = 120, playing = false;

const pad = (n) => String(n).padStart(2, '0');

function size() {
  const bounds = canvas.getBoundingClientRect(), density = Math.min(devicePixelRatio, 2);
  canvas.width = Math.max(1, Math.round(bounds.width * density));
  canvas.height = Math.max(1, Math.round(bounds.height * density));
  if (!engine) return;
  // Looking north-northwest from the shore, a little up; a tall screen tilts further up to keep the curtains in view.
  const lift = canvas.height > canvas.width ? 0.3 : 0.17;
  // A knoll on the south shore, 14 m over the ice.
  const eye = ground(0, 0) + 14;
  engine.camera.position = [0, eye, 0];
  engine.camera.target = [-0.38, eye + lift, -1];
}

function setNight() {
  astro.options.date = new Date(midnight + minutes * 60000);
  aurora.time = minutes * foldsPerMinute;
  $('#time').textContent = `${pad(Math.floor(minutes / 60))}:${pad(Math.floor(minutes % 60))} UTC`;
}

function showMoon() {
  const m = astro.moon;
  Object.assign(moon.options, { direction: m.direction, sunDirection: astro.sun.direction });
  $('#elevation').textContent = `${m.elevation.degrees.toFixed(1)}°`;
  $('#phase').textContent = `${Math.round(m.illumination * 100)}%`;
  document.body.dataset.moon = `${m.elevation.degrees.toFixed(3)},${m.illumination.toFixed(4)}`;
}

function draw(now) {
  frame = undefined;
  const delta = last === undefined ? 0 : Math.min(0.05, (now - last) / 1000);
  last = playing ? now : undefined;
  if (playing) {
    // Two minutes of night a second, round the three hours.
    minutes = (minutes + delta * 2) % Number(slider.max);
    slider.value = String(Math.round(minutes));
    setNight();
  }
  // Place the Moon for this frame's date before anything draws it: the textured disc, then the lake's capture of the
  // sky (the ice mirrors it, captured before each frame this page renders itself), then the frame.
  astro.advanceTime(0);
  showMoon();
  land.ice.update();
  engine.render({ delta: playing ? delta : 0 });
  if (playing) schedule();
}

function schedule() {
  if (frame !== undefined || lifetime.signal.aborted) return;
  frame = requestAnimationFrame((now) => {
    try { draw(now); } catch (error) { fail(error); }
  });
}

function play(on) {
  playing = on;
  playButton.setAttribute('aria-pressed', String(on));
  playButton.firstChild.textContent = on ? 'Pause night ' : 'Play night ';
  schedule();
}

function dispose() {
  lifetime.abort();
  observer?.disconnect();
  if (frame !== undefined) cancelAnimationFrame(frame);
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
  const options = { backend: 'webgpu', exactSize: true, antialias: true, startupTimeout: 9000, signal: lifetime.signal, camera: { fov: 58, near: 0.1, far: 4000 } };
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
  const [catalog, albedo] = await Promise.all([
    fetchBrightStarCatalog(url('bright-stars.gz'), { signal: lifetime.signal }),
    loadMoonAlbedo(url('moon.jpg'), { signal: lifetime.signal }),
  ]);
  // The night sky lights the land with the Moon it draws; the catalogue's stars, the band and the curtains go on top.
  const sky = Sky.attach(engine, { timeScale: 0, exposure: -2.5, turbidity: 2, night: { hazeDensity: 0.2, glowIntensity: 0.12, zenithColor: [0.002, 0.004, 0.012], horizonColor: [0.012, 0.02, 0.036] }, lighting: { moon: {} } }, { preetham, night, lighting });
  astro = AstroSky.attach(engine, { ...site, date: new Date(midnight), timeScale: 0, sky, catalog, brightness: 5 });
  MilkyWay.attach(engine, { astro, clouds: 1 });
  aurora = Aurora.attach(engine, { sky, intensity: 450, brightness: 5, red: 0.5, blue: 0.35, arcs: 3, distance: 130, speed: 1 });
  // The lunar map, drawn 2.9 times its true size so the maria read at this field of view.
  moon = Moon.attach(engine, { albedo, angularRadius: 0.2725 * 2.9, intensity: 3, earthshine: 0.002 });
  Snow.attach(engine, { cover: 0.65, depth: 0.25, variation: 0.6, drift: 3, grain: 0.7 });
  land = buildLandscape(engine);
  // Moon shadows: cascades for the shore and the firs, the height field's own march for the fells' long ridges.
  Shadows.attach(engine, { resolution: 2048, cascades: 4, distance: 900, filter: 'soft', casterMargin: 250, effects: [distanceShadows({ ...land.field, fade: 0.2, sunSize: 0.0091, bias: 4 })] });
  PostStack.attach(engine, [new Bloom({ strength: 0.3 }), new Tonemap({ curve: 'agx', exposure: 0.6, contrast: 1.1, vignette: 0.3 })]);
  setNight();
  size();
  draw(performance.now());
  await engine.gpu.queue.onSubmittedWorkDone();
  if (lifetime.signal.aborted) return;

  const listen = { signal: lifetime.signal };
  slider.addEventListener('input', () => ((minutes = Number(slider.value)), setNight(), schedule()), listen);
  playButton.addEventListener('click', () => play(!playing), listen);
  observer = new ResizeObserver(() => (size(), schedule()));
  observer.observe(canvas);
  controls.disabled = false;
  loading.hidden = true;
  Object.assign(document.body.dataset, { ready: 'true', renderer: compatibility ? 'compatibility' : 'webgpu' });
  status.ready();
}

window.addEventListener('pagehide', (event) => { if (!event.persisted) dispose(); }, { signal: lifetime.signal });
start().catch(fail);
