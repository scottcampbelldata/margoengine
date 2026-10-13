import {EngineKernel} from '@margoengine/core';
import {engineRuntime} from '@margoengine/core/extension';
import {Sky} from '@margoengine/sky';
import {Shadows} from '@margoengine/shadows';
import {Water} from '@margoengine/water';
import {VFX} from '@margoengine/vfx';
import {Input} from '@margoengine/input';
import {Cinematic} from '@margoengine/cinematic';
import {Bloom} from '@margoengine/post/bloom';
import {Stats} from '@margoengine/stats';
import {poseHumanoid} from '@margoengine/procedural';
import {Clustered} from '@margoengine/clustered';
import {createCharacter, createLandscape, terrainHeight} from './scene.js';
import {stepLocomotion, type LocomotionOptions} from '@margoengine/controls';
import {createProceduralSettlement} from './procedural/index.js';
import './style.css';

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = element<HTMLCanvasElement>('scene'), status = element('status'), controls = element<HTMLFieldSetElement>('controls');
const sunSlider = element<HTMLInputElement>('sun'), waveSlider = element<HTMLInputElement>('wave'), countSelect = element<HTMLSelectElement>('particles');
const explore = element<HTMLButtonElement>('explore'), pause = element<HTMLButtonElement>('pause');

async function boot(): Promise<void> {
  if (!navigator.gpu) throw new Error('WebGPU is unavailable. Open this local demo in a WebGPU-enabled browser.');
  const engine = await EngineKernel.create(canvas, {backend: 'webgpu', capacity: 256, camera: {position: [8, 7, 25], target: [0, 2, 0], near: 0.15, far: 300, fov: 58}});
  const runtime = engineRuntime(engine), events = new AbortController(), signal = events.signal;
  let input: Input | undefined, disposed = false, playing = !matchMedia('(prefers-reduced-motion: reduce)').matches, timer: ReturnType<typeof setInterval> | undefined;
  const dispose = () => {if (disposed) return; disposed = true; events.abort(); clearInterval(timer); input?.dispose(); engine.dispose();};
  window.addEventListener('pagehide', dispose, {signal});
  if (import.meta.hot) import.meta.hot.dispose(dispose);
  try {
    const mobile = /Mobi|Android/.test(navigator.userAgent);
    engine.onError = error => {engine.stop(); fail(error);};
    runtime.gpu!.addEventListener('uncapturederror', event => engine.onError((event as GPUUncapturedErrorEvent).error), {signal});
    const post = Bloom.attach(engine, {strength: 0.2, threshold: 1.2, exposure: 0.45});
    let water: Water;
    const sky = Sky.attach(engine, {model: 'bruneton', clouds: {coverage: 0.38}, fog: {depth: () => water?.depthTexture ?? post.depthTexture, density: 0.008, start: 45}, hours: 17.57, timeScale: 1/120, turbidity: 3.2, exposure: -0.35, lighting: {intensity: 6, color: [1,0.97,0.92], sunset: [1,0.69,0.36], moon: {intensity: 0.6, color: [0.25,0.45,0.75]}, ambient: {day: [0.14,0.19,0.24], night: [0.02,0.04,0.09]}}});
    // Compile the sky and its LUT while the CPU builds the island.
    engine.render({delta: 0});
    const shadows = Shadows.attach(engine, {resolution: mobile ? 512 : 1024, distance: 115, lambda: 0.7, lightSize: 0.018, normalBias: 0.055, casterMargin: 65});
    const settlement = createProceduralSettlement(engine, shadows, terrainHeight), procedural = settlement.scatter;
    const lights = Clustered.attach(engine, {grid: [8,4,16]});
    procedural.emissiveIntensity = lights.intensityScale = () => sky.nightFactor;
    lights.setLights([{position: settlement.porchLightPosition, range: 6, color: [1,0.8,0.4], intensity: 18}]);
    const landscape = createLandscape(engine, shadows, settlement.exclusions, () => water?.coastalDepthTexture), character = createCharacter(engine, shadows);
    const state = new Float32Array([-12, terrainHeight(-12, 37), 37, Math.PI, 0, 0.18, 0, 0]);
    const cameraDistance = 14;
    const actions = new Float32Array(5);
    const locomotion: LocomotionOptions = {bounds: [-69,69,-69,69], minHeight: 0.45};
    const position = state.subarray(0, 3), emptyPads: readonly Gamepad[] = [];
    const camera = Cinematic.attach(engine, {offset: [4, 3.5, cameraDistance], damping: 5, lookDamping: 7, ground: terrainHeight, clearance: 0.65}); camera.follow(character.focus); const cameraDelta = camera.offset;
    water = Water.attach(engine, {size: [400, 400], segments: mobile ? 64 : 256, horizon: true, height: 0, foamDistance: 1.8, color: [0.006, 0.022, 0.05], depth: () => post.depthTexture, sceneColor: () => post.sceneTexture, reflection: () => sky.reflectionTexture, lights: sky.lights, spray: true, terrain: {heightmap: landscape.heightmap, origin: [-80,-80], size: [160,160]}, waves: [{direction: [1, 0.37], amplitude: 0.35, wavelength: 17.37, steepness: 0.3, phase: 0.43}, {direction: [0.87, 0.55], amplitude: 0.18, wavelength: 11.19, steepness: 0.3, phase: 2.17}, {direction: [1, 0.13], amplitude: 0.09, wavelength: 7.73, steepness: 0.25, phase: 4.91}]});
    let particles: VFX | undefined;
    const selectParticles = (capacity: number) => {
      if (![0, 100_000, 500_000, 1_000_000].includes(capacity)) throw new RangeError('Unknown particle tier');
      particles?.dispose();
      particles = undefined;
      if (capacity === 0) return;
      particles = VFX.attach(engine, {capacity, initialCount: capacity, rate: capacity / 20, position: [0, 4, 0], emissionExtent: [80, 3, 80], velocity: [0, 0.03, 0], gravity: [0, 0, 0], spread: 0.08, lifetime: [25, 45], size: 0.01, ground: 0.35, turbulence: 0.035, frequency: 0.22, color: [1, 0.85, 0.4, 0.5], intensity: 5});
    };
    countSelect.value = mobile ? '100000' : '1000000';
    selectParticles(Number(countSelect.value));
    input = new Input({
      strafe: [{type: 'key', code: 'KeyD'}, {type: 'key', code: 'ArrowRight'}, {type: 'key', code: 'KeyA', scale: -1}, {type: 'key', code: 'ArrowLeft', scale: -1}, {type: 'touch', id: 'move', axis: 'x'}],
      forward: [{type: 'key', code: 'KeyW'}, {type: 'key', code: 'ArrowUp'}, {type: 'key', code: 'KeyS', scale: -1}, {type: 'key', code: 'ArrowDown', scale: -1}, {type: 'touch', id: 'move', axis: 'y', scale: -1}],
      lookX: [{type: 'pointer', axis: 'x', scale: 0.004}], lookY: [{type: 'pointer', axis: 'y', scale: 0.004}],
      touchX: [{type: 'touch', id: 'look', axis: 'x'}], touchY: [{type: 'touch', id: 'look', axis: 'y'}],
      sprint: [{type: 'key', code: 'ShiftLeft'}, {type: 'key', code: 'ShiftRight'}],
    }, {target: window, gamepads: () => emptyPads});
    input.createStick(element('touch-controls'), 'move'); input.createStick(element('touch-controls'), 'look');
    const strafe = input.state('strafe'), forward = input.state('forward'), lookX = input.state('lookX'), lookY = input.state('lookY'), sprint = input.state('sprint'), touchX = input.state('touchX'), touchY = input.state('touchY');
    let dragging = false;
    const timing = new Float32Array(2);
    engine.onFrame((_engine, delta) => {
      input!.update(); timing[0] = delta;
      actions[0] = strafe.value; actions[1] = forward.value; actions[4] = sprint.value;
      actions[2] = ((dragging || document.pointerLockElement === canvas) ? lookX.value : 0) + touchX.value * delta * 1.5;
      actions[3] = ((dragging || document.pointerLockElement === canvas) ? lookY.value : 0) + touchY.value * delta;
      stepLocomotion(state, actions, timing[0], terrainHeight, locomotion);
      poseHumanoid(character,position,state[3],state[6],state[7]);
      camera.setOrbitOffset(state[4],state[5],cameraDistance,0.8);
      timing[1]++;
    });
    const stats = Stats.attach(engine, {parent: element('telemetry'), samples: 120});
    const renderStill = () => {if (!playing) engine.render({delta: 0});};
    sunSlider.addEventListener('input', () => {sky.options.hours = sunSlider.valueAsNumber; renderStill();}, {signal});
    waveSlider.addEventListener('input', () => {water.setWaveHeight(waveSlider.valueAsNumber); element<HTMLOutputElement>('wave-value').value = `${waveSlider.valueAsNumber.toFixed(2)} m`; renderStill();}, {signal});
    countSelect.addEventListener('change', () => {selectParticles(Number(countSelect.value)); renderStill();}, {signal});
    element<HTMLInputElement>('wireframe').addEventListener('change', event => {landscape.wireframe.visible = (event.target as HTMLInputElement).checked; renderStill();}, {signal});
    canvas.addEventListener('pointerdown', event => {dragging = true; canvas.focus(); canvas.setPointerCapture(event.pointerId);}, {signal});
    const release = () => {dragging = false;};
    canvas.addEventListener('pointerup', release, {signal}); canvas.addEventListener('pointercancel', release, {signal}); canvas.addEventListener('lostpointercapture', release, {signal});
    window.addEventListener('blur', () => {dragging = false; input!.reset();}, {signal});
    canvas.addEventListener('dblclick', () => {void canvas.requestPointerLock()?.catch(error => {status.textContent = `Mouse capture unavailable: ${String(error)}. Drag to look.`;});}, {signal});
    window.addEventListener('keydown', event => {
      if (event.code === 'Escape') {document.exitPointerLock(); document.body.classList.remove('exploring');}
      if (document.activeElement === canvas && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(event.code)) event.preventDefault();
    }, {signal});
    const setPlaying = (value: boolean) => {playing = value; pause.textContent = playing ? 'Pause' : 'Resume'; pause.setAttribute('aria-pressed', String(!playing)); status.textContent = playing ? 'All systems online. No assets to download.' : 'World paused. Resume or explore when ready.'; if (playing && !document.hidden) engine.start(); else engine.stop();};
    pause.addEventListener('click', () => setPlaying(!playing), {signal});
    document.addEventListener('visibilitychange', () => {input!.reset(); if (document.hidden) engine.stop(); else if (playing) engine.start();}, {signal});
    explore.addEventListener('click', () => {document.body.classList.add('exploring'); setPlaying(true); canvas.focus();}, {signal});
    poseHumanoid(character,position,state[3],state[6],state[7]);
    camera.setOrbitOffset(state[4],state[5],cameraDistance,0.8);
    // Warm pipelines and the one-time atmospheric LUT before measuring cadence.
    engine.render({delta: 0}); await runtime.gpu!.queue.onSubmittedWorkDone();
    controls.disabled = false; explore.disabled = false; explore.innerHTML = 'Explore the island <span aria-hidden="true">↗</span>';
    setPlaying(playing);
    timer = setInterval(() => {
      const hours = sky.options.hours!, minutes = Math.floor((hours % 1) * 60);
      element<HTMLOutputElement>('sun-value').value = `${String(Math.floor(hours)).padStart(2,'0')}:${String(minutes).padStart(2,'0')}`;
      element('time-label').textContent = sky.nightFactor > 0.5 ? 'Moon / night' : 'Sun / day';
      sunSlider.setAttribute('aria-valuetext', `${element<HTMLOutputElement>('sun-value').value}, ${sky.nightFactor > 0.5 ? 'night' : 'day'}`);
      if (document.activeElement !== sunSlider) sunSlider.value = String(hours);
    }, 500);
    Object.assign(window, {sandbox: {engine, stats, state, actions, camera, cameraDelta, timing, sky, water, shadows, lights, procedural, get particles() {return particles;}, dispose}});
  } catch (error) {dispose(); throw error;}
}

function fail(error: unknown): void {
  document.body.classList.add('failed'); controls.disabled = true; explore.disabled = true;
  const message = error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error);
  explore.textContent = 'World unavailable';
  status.textContent = message.includes('generated metal:') ? 'A GPU shader could not compile. Open technical error details below.' : message;
  element('error-message').textContent = message; element('error-details').hidden = false;
  console.error(message);
}
void boot().catch(fail);
