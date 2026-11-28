// Ten Thousand Trees: a flight up a northern Rockies valley. The land, its creek, the ground materials and every tree
// come from @margoengine/biomes (rockiesValleyWorld drawn by BiomeView, the conifers from procedural/conifers with
// imposters far off); the sky, air and sun from @margoengine/sky, shadows from @margoengine/shadows, the grade from
// post and tonemap, the flight from controls/presentation on a splines curve. This page only wires them to the controls.
import { Engine } from '@margoengine/core';
import { Sky } from '@margoengine/sky';
import { sunlitSky, degrees } from '@margoengine/sky/sun';
import { AerialPerspective } from '@margoengine/sky/aerial';
import { BiomeWorld } from '@margoengine/biomes';
import { BiomeView } from '@margoengine/biomes/view';
import { coniferAge, rockiesValleyWorld } from '@margoengine/biomes/presets';
import { Shadows } from '@margoengine/shadows';
import { PostStack } from '@margoengine/post/stack';
import { Bloom } from '@margoengine/post/bloom';
import { Tonemap } from '@margoengine/tonemap';
import { Spline } from '@margoengine/splines';
import { PathControls } from '@margoengine/controls/presentation';
import { demoStatus } from 'margo-demo-status';
import { warmUp } from '@margoengine/quality/warm';

const $ = (selector) => document.querySelector(selector);
const canvas = $('#scene'), loading = $('#loading'), errorNotice = $('#error'), controls = $('#controls');
const route = $('#route'), wind = $('#wind'), playButton = $('#play');
const status = demoStatus($('#exhibit'), loading, errorNotice);
const lifetime = new AbortController();
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
/** Metres the flight holds over the creek: about 30 m over the crowns of the tallest firs either side. */
const flightHeight = 72;
/** The share of the creek the flight covers, from just inside the outlet to short of the valley head. */
const span = [0.03, 0.86];
/** Route legs by share of the flight. */
const legs = [[0, 'Valley mouth'], [0.25, 'Creek bottoms'], [0.55, 'Upper valley'], [0.8, 'Valley head']];
let engine, world, view, path, flight, observer, playing = false;

function size() {
  const bounds = canvas.getBoundingClientRect(), density = Math.min(devicePixelRatio, 2);
  canvas.width = Math.max(1, Math.round(bounds.width * density));
  canvas.height = Math.max(1, Math.round(bounds.height * density));
}

/** The flight: the creek line from the world (millimetres, outlet first), every 128 m, lifted over the trees. */
function flightPath() {
  const creek = world.rivers[0], points = [];
  for (let k = 0; k < creek.length; k += 16) {
    const x = creek[k] / 1000, z = creek[k + 1] / 1000;
    points.push([x, world.heightAt(x, z) + flightHeight, z]);
  }
  const full = new Spline(points), from = span[0] * full.length, length = (span[1] - span[0]) * full.length;
  const point = new Float64Array(3), xs = points.map((p) => p[0]), zs = points.map((p) => p[2]), reach = 700;
  const corridor = [Math.min(...xs) - reach, Math.min(...zs) - reach, Math.max(...xs) + reach, Math.max(...zs) + reach];
  return { length, corridor, at: (t) => full.atDistance(from + t * length, point), atDistance: (d) => full.atDistance(from + d, point) };
}

/** Wind from the west, up the valley: the slider's speed in km/h as scatter's strength and its mean speed in m/s. */
function setWind() {
  const kmh = Number(wind.value), speed = kmh / 3.6, strength = Math.min(1, speed / 12);
  for (const scatter of view.objects?.swaying ?? []) scatter.wind = [1, 0.15, strength, speed];
  $('#wind-value').textContent = `${kmh} km/h`;
}

function showFlight() {
  const share = flight.offset, [x, y, z] = engine.camera.position;
  route.value = String(Math.round(share * 1000));
  $('#route-value').textContent = `${Math.round(share * 100)}%`;
  $('#leg').textContent = legs.findLast(([at]) => share >= at)[1];
  $('#distance').textContent = `${Math.round(share * path.length).toLocaleString('en')} m along route`;
  $('#height').textContent = `${Math.round(y - world.heightAt(x, z))} m`;
  $('#count').textContent = (view.objects?.count ?? 0).toLocaleString('en');
}

function play(on) {
  playing = on;
  playButton.setAttribute('aria-pressed', String(on));
  playButton.firstChild.textContent = on ? 'Pause flight ' : 'Fly over canopy ';
  playButton.lastElementChild.textContent = on ? '❚❚' : '▶';
}

function dispose() {
  lifetime.abort();
  observer?.disconnect();
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
  const options = { backend: 'webgpu', exactSize: true, antialias: true, startupTimeout: 9000, signal: lifetime.signal, camera: { fov: 55, near: 0.5, far: 20000 } };
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
  // A late afternoon sun in the west-southwest, behind the flight's left shoulder: the slopes ahead are lit from the side
  // and the crowns throw long shadows across the valley floor.
  const sky = Sky.attach(engine, { ...sunlitSky({ azimuth: degrees(235), elevation: degrees(26), intensity: 4 }), timeScale: 0, turbidity: 2.2 });
  const { climate, relief } = rockiesValleyWorld;
  // Old timber: the presets' firs, pines, cedars and larches at a hundred years, closing their crowns over the slopes.
  const biomes = coniferAge(rockiesValleyWorld.biomes, 'mature');
  world = await BiomeWorld.create({ climate, height: { relief }, biomes, signal: lifetime.signal });
  const shadows = Shadows.attach(engine, { resolution: 2048, cascades: 4, distance: 1600, filter: 'soft' });
  view = await BiomeView.attach(engine, world, { sky, shadows, water: { rivers: 'auto' }, horizon: true, budget: 1, signal: lifetime.signal });
  const stack = PostStack.attach(engine, [new Bloom({ strength: 0.05, threshold: 1.2 }), new Tonemap({ curve: 'agx', exposure: 0.4, contrast: 1.08, vignette: 0.25 })]);
  AerialPerspective.attach(engine, { sky, depth: () => stack.depthTexture });

  path = flightPath();
  flight = new PathControls(engine, path, { loop: false, offset: Number(route.value) / 1000, damping: 0.35, lookAhead: 0.03, focusDamping: 0.6 });
  flight.update(0);
  // Make the whole corridor of the flight before it starts, so a jump along the slider lands on finished ground.
  await view.prefetch(path.corridor, { signal: lifetime.signal });
  await view.ready;
  setWind();
  engine.onFrame((_, delta) => {
    if (playing) {
      // About 40 m a second, a low glider's pace; it stops at the valley head.
      flight.current = Math.min(1, flight.current + (delta * 40) / path.length);
      if (flight.current >= 1) play(false);
    }
    showFlight();
  });
  // Compile every pipeline with the async API before the first visible frame. On the WebGL2 layer the first frame
  // otherwise linked the water surface and the post stack and compiled them again for their targets in one task of
  // 9 s, and a loaded machine took it past 15 s (KB-WATER-WARMUP1).
  await warmUp(engine, { signal: lifetime.signal });
  engine.start();
  await engine.gpu.queue.onSubmittedWorkDone();
  if (lifetime.signal.aborted) return;

  const listen = { signal: lifetime.signal };
  route.addEventListener('input', () => ((flight.current = Number(route.value) / 1000), play(false)), listen);
  wind.addEventListener('input', setWind, listen);
  playButton.addEventListener('click', () => {
    if (!playing && flight.current >= 1) flight.current = 0;
    play(!playing);
  }, listen);
  observer = new ResizeObserver(size);
  observer.observe(canvas);
  controls.disabled = false;
  loading.hidden = true;
  Object.assign(document.body.dataset, { ready: 'true', renderer: compatibility ? 'compatibility' : 'webgpu' });
  status.ready();
  if (!reduced) play(true);
}

window.addEventListener('pagehide', (event) => { if (!event.persisted) dispose(); }, { signal: lifetime.signal });
start().catch(fail);
