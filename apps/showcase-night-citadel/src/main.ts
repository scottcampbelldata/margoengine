import { EngineKernel, PbrMaterial } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import { Bloom } from '@margoengine/post/bloom';
import { submitPrincipalScene } from '@margoengine/post/scene-fade';
import { Shadows } from '@margoengine/shadows';
import { ScatterInstances } from '@margoengine/scatter';
import { Clustered } from '@margoengine/clustered';
import { Water } from '@margoengine/water';
import { VFX } from '@margoengine/vfx/base';
import { sceneSamples } from '../../../packages/shared/quality.js';
import { applyQualityTier, watchQuality } from '@margoengine/quality';
applyQualityTier();
import { createCitadelPBR, moonDirection } from './scene.js';
import { frameDue, frameStatus } from '@margoengine/quality';
import { Sky } from '@margoengine/sky/base';
import { night } from '@margoengine/sky/night';
import { fog } from '@margoengine/sky/fog';
import './style.css';

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = element<HTMLCanvasElement>('scene'),
  status = element<HTMLParagraphElement>('status');
const orbit = element<HTMLInputElement>('orbit'),
  cadence = element<HTMLSelectElement>('cadence');
document.querySelector<HTMLDetailsElement>('.panel details')!.open = !matchMedia(
  '(max-width: 700px), (max-height: 600px) and (pointer: coarse)',
).matches;
const controls = [
  'azimuth',
  'elevation',
  'phase',
  'haze',
  'stars',
  'glow',
  'windows',
  'waves',
  'bloom',
  'exposure',
].map((id) => element<HTMLInputElement>(id));
const values = controls.map((input) => element<HTMLOutputElement>(input.id + '-value'));
const fpsText = element<HTMLOutputElement>('fps').firstChild as Text,
  deltaText = element<HTMLOutputElement>('delta').firstChild as Text;
const fpsLabels = Array.from({ length: 241 }, (_, i) => String(i)),
  deltaLabels = Array.from({ length: 1001 }, (_, i) => (i / 10).toFixed(1));

export class NightCitadel {
  readonly eye: [number, number, number] = [0, 12, 82];
  readonly moon: [number, number, number] = [0, 1, 0];
  readonly motion = new Float64Array([0.65, -0.03, 82, 0, 0, 0, 0, 0, 0, 0]);
  private readonly clock = new Float64Array(3);
  private readonly refresh = new Float64Array(3);
  private readonly renderOptions = { delta: 0 };
  readonly pointers = new Float64Array([-1, 0, 0, -1, 0, 0, 0]);
  readonly stats = { frames: 0, instances: 0, batches: 0, fps: 0, delta: 0, callbackRate: 0, samples: sceneSamples() };
  readiness: Awaited<ReturnType<typeof submitPrincipalScene>> | undefined;
  readonly post: Bloom;
  readonly shadows: Shadows;
  readonly instances: ScatterInstances;
  readonly lights: Clustered;
  readonly water: Water;
  readonly particles: VFX;
  readonly atmosphere: Sky;
  readonly camera;
  readonly device;
  private readonly events = new AbortController();
  private readonly horizon: [number, number, number] = [0, 0, 0];
  private readonly baseHorizon = new PbrMaterial({ color: '#11162b' }).data;
  private readonly reduced = matchMedia('(prefers-reduced-motion: reduce)');
  private raf = 0;
  private targetRate = 60;
  disposed = false;

  constructor(readonly engine: EngineKernel) {
    const runtime = engineRuntime(engine);
    this.camera = engine.camera;
    this.camera.position = this.eye;
    this.device = runtime.gpu!;
    this.post = Bloom.attach(engine, { strength: 0.25, threshold: 1, exposure: 0.3 });
    const zenith = new PbrMaterial({ color: '#020512' }).data,
      lunar = new PbrMaterial({ color: '#e2eeff' }).data;
    // Keep the fortress between the title and controls on wide screens.
    runtime.use({
      name: 'citadel:framing',
      setup() {},
      registerPasses: (graph) =>
        graph.add({
          name: 'citadel:framing',
          order: -100,
          execute: (c) => {
            if (c.width / c.height > 1.1)
              for (let i = 0; i < 4; i++) c.camera.matrix[i * 4] -= 0.12 * c.camera.matrix[i * 4 + 3];
          },
        }),
    });
    // Midnight sky with stars and a phased moon; height haze in the horizon colour over masonry and water.
    this.atmosphere = Sky.attach(
      engine,
      {
        hours: 0,
        timeScale: 0,
        night: {
          zenithColor: [zenith[0], zenith[1], zenith[2]],
          horizonColor: this.horizon,
          moonColor: [lunar[0], lunar[1], lunar[2]],
          moonDirection: this.moon,
          moonSize: 0.035,
          starIntensity: 1,
        },
        fog: {
          depth: () => this.water?.depthTexture ?? this.post.depthTexture,
          color: this.horizon,
          falloff: 'exp',
          height: 0.065,
          start: 0,
          density: 0,
        },
      },
      { night, fog },
    );
    this.shadows = Shadows.attach(engine, {
      resolution: this.stats.samples === 4 ? 1024 : 512,
      distance: 180,
      lightSize: 0.02,
      normalBias: 0.055,
      casterMargin: 70,
    });
    this.lights = Clustered.attach(engine, { grid: [8, 4, 16] });
    this.instances = ScatterInstances.attach(engine, () => createCitadelPBR().batches);
    this.shadows.add(this.instances, { static: true });
    this.lights.setLights(createCitadelPBR().lights);
    this.stats.instances = this.instances.batches.reduce((sum, b) => sum + b.instances, 0);
    this.stats.batches = this.instances.batches.length;
    element('draws').textContent = String(this.stats.batches);
    const light = (globalThis as { margoLow?: number }).margoLow;
    element('quality').textContent =
      this.stats.samples === 4
        ? 'Desktop · 4× MSAA · DPR capped at 1'
        : light
          ? `Desktop light · 1× sampling · DPR capped at ${light}`
          : 'Mobile · 1× sampling';
    // Resolve the nearby swells on both grids; horizon:true extends the distant ocean.
    this.water = Water.attach(engine, {
      size: [160, 160],
      segments: this.stats.samples === 4 ? 128 : 64,
      height: -27,
      horizon: true,
      depth: () => this.post.depthTexture,
      sceneColor: () => this.post.sceneTexture,
      lights: [{ direction: runtime.lighting.direction, radiance: runtime.lighting.radiance.subarray(0, 3) }],
      color: [0.004, 0.009, 0.022],
      foamDistance: 1.2,
      waves: [
        { direction: [1, 0.37], amplitude: 0.35, wavelength: 17.37, steepness: 0.3, phase: 0.43 },
        { direction: [0.87, 0.55], amplitude: 0.18, wavelength: 11.19, steepness: 0.3, phase: 2.17 },
      ],
    });
    const capacity = this.stats.samples === 4 ? 2048 : 512;
    this.particles = VFX.attach(engine, {
      capacity,
      initialCount: capacity,
      rate: capacity / 30,
      position: [0, 12, 0],
      emissionExtent: [28, 20, 25],
      velocity: [0, 0.04, 0],
      gravity: [0, 0, 0],
      spread: 0.06,
      lifetime: [25, 45],
      size: 0.035,
      ground: -26,
      turbulence: 0.05,
      frequency: 0.18,
      color: [1, 0.65, 0.22, 0.65],
      intensity: 4,
    });
    this.updateSky();
    orbit.checked = !this.reduced.matches;
    const options = { signal: this.events.signal };
    for (const input of controls) input.addEventListener('input', this.updateSky, options);
    cadence.addEventListener(
      'change',
      () => {
        this.targetRate = Number(cadence.value);
        this.clock.fill(0);
        this.refresh.fill(0);
        element('refresh-note').textContent = 'Measuring browser cadence…';
      },
      options,
    );
    this.reduced.addEventListener(
      'change',
      () => {
        if (this.reduced.matches) orbit.checked = false;
      },
      options,
    );
    canvas.addEventListener('pointerdown', this.pointerDown, options);
    canvas.addEventListener('pointermove', this.pointerMove, options);
    canvas.addEventListener('pointerup', this.pointerUp, options);
    canvas.addEventListener('pointercancel', this.pointerUp, options);
    canvas.addEventListener('lostpointercapture', this.pointerUp, options);
    // Handle both contacts together and cancel native page zoom on iPhone browsers.
    canvas.addEventListener('touchstart', this.touchState, { ...options, passive: false });
    canvas.addEventListener('touchmove', this.touchMove, { ...options, passive: false });
    canvas.addEventListener('touchend', this.touchState, { ...options, passive: false });
    canvas.addEventListener('touchcancel', this.touchState, { ...options, passive: false });
    window.addEventListener('resize', this.cancelGesture, options);
    window.addEventListener('blur', this.cancelGesture, options);
    canvas.addEventListener('wheel', this.wheel, { ...options, passive: false });
    canvas.addEventListener('keydown', this.keyDown, options);
    element('reset').addEventListener('click', this.reset, options);
    document.addEventListener('visibilitychange', this.visibility, options);
    window.addEventListener('pagehide', this.dispose, options);
    this.device.addEventListener(
      'uncapturederror',
      (event) => this.fail((event as GPUUncapturedErrorEvent).error),
      options,
    );
    engine.onError = (error) => this.fail(error instanceof Error ? error : new Error(String(error)));
    this.start();
  }
  private readonly updateSky = (): void => {
    moonDirection(this.moon, controls[0].valueAsNumber, controls[1].valueAsNumber);
    const phase = controls[2].valueAsNumber,
      haze = controls[3].valueAsNumber;
    for (let i = 0; i < 3; i++) this.horizon[i] = this.baseHorizon[i] * (0.55 + haze * 1.3) * (1 + 0.12 * this.moon[1]);
    Object.assign(this.atmosphere.options.night!, {
      moonPhase: phase,
      starTwinkleIntensity: controls[4].valueAsNumber,
      glowIntensity: controls[5].valueAsNumber,
      hazeDensity: haze * 3,
    });
    this.atmosphere.options.fog!.density = haze * 0.0075;
    const lighting = engineRuntime(this.engine).lighting;
    lighting.direction.set(this.moon);
    lighting.direction[3] = 0.4 + (phase + 1) * 2.2;
    lighting.radiance.set([0.5, 0.68, 1, 0.08]);
    this.instances.emissiveIntensity = controls[6].valueAsNumber;
    this.lights.intensityScale = controls[6].valueAsNumber;
    this.water.setWaveHeight(controls[7].valueAsNumber);
    this.post.options.strength = controls[8].valueAsNumber;
    this.post.options.exposure = controls[9].valueAsNumber;
    for (let i = 0; i < controls.length; i++)
      values[i].value = i < 2 ? controls[i].value + '°' : controls[i].valueAsNumber.toFixed(2) + (i === 7 ? ' m' : '');
  };
  private readonly frame = (now: number): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.frame);
    const last = this.refresh[0],
      callbackDelta = now - last;
    this.refresh[0] = now;
    if (last && callbackDelta > 0 && callbackDelta < 250) {
      this.refresh[1]++;
      this.refresh[2] += callbackDelta;
    }
    const m = this.motion,
      interval = 1000 / this.targetRate,
      elapsed = m[6] ? now - m[6] : interval;
    if (!frameDue(this.clock, now, this.targetRate)) return;
    const dt = m[6] ? Math.min(0.05, elapsed * 0.001) : interval * 0.001;
    m[6] = now;
    const decay = Math.exp(-8 * dt);
    if (this.reduced.matches && orbit.checked) orbit.checked = false;
    if (orbit.checked && !this.reduced.matches) m[0] += 0.025 * dt;
    m[0] += m[3] * dt;
    m[1] = Math.max(-0.08, Math.min(1.2, m[1] + m[4] * dt));
    m[2] = Math.max(42, Math.min(140, m[2] + m[5] * dt));
    m[3] *= decay;
    m[4] *= decay;
    m[5] *= decay;
    const horizontal = Math.cos(m[1]) * m[2];
    this.eye[0] = Math.sin(m[0]) * horizontal;
    this.eye[1] = 12 + Math.sin(m[1]) * m[2];
    this.eye[2] = Math.cos(m[0]) * horizontal;
    this.renderOptions.delta = this.reduced.matches ? 0 : dt;
    try {
      if (this.stats.frames) this.engine.render(this.renderOptions);
      else
        void submitPrincipalScene(() => this.engine.render(this.renderOptions), this.device.queue, {
          signal: this.events.signal,
        }).then(
          (value) => {
            this.readiness = value;
          },
          (error) => {
            if (!this.disposed) this.fail(error instanceof Error ? error : new Error(String(error)));
          },
        );
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    this.stats.frames++;
    m[7]++;
    m[8] += elapsed;
    if (now - m[9] >= 500) {
      this.stats.delta = m[8] / m[7];
      this.stats.fps = 1000 / this.stats.delta;
      this.stats.callbackRate = this.refresh[2] ? (1000 * this.refresh[1]) / this.refresh[2] : 0;
      fpsText.nodeValue = fpsLabels[Math.max(0, Math.min(240, Math.round(this.stats.fps)))];
      deltaText.nodeValue = deltaLabels[Math.max(0, Math.min(1000, Math.round(this.stats.delta * 10)))];
      const note = element('refresh-note'),
        text = frameStatus(this.targetRate, this.stats.callbackRate, this.stats.fps);
      if (note.textContent !== text) note.textContent = text;
      m[7] = m[8] = 0;
      m[9] = now;
      this.refresh[1] = this.refresh[2] = 0;
    }
  };
  readonly start = (): void => {
    if (!this.raf && !this.disposed) {
      this.motion[6] = 0;
      this.motion[7] = 0;
      this.motion[8] = 0;
      this.clock.fill(0);
      this.refresh.fill(0);
      this.motion[9] = performance.now();
      this.raf = requestAnimationFrame(this.frame);
    }
  };
  readonly stop = (): void => {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  };
  private readonly visibility = (): void => {
    if (document.hidden) this.stop();
    else this.start();
  };
  private readonly reset = (): void => {
    this.motion[0] = 0.65;
    this.motion[1] = -0.03;
    this.motion[2] = 82;
    this.motion[3] = this.motion[4] = this.motion[5] = 0;
  };
  private readonly pointerDown = (e: PointerEvent): void => {
    if (e.pointerType === 'touch' || e.button !== 0) return;
    const p = this.pointers,
      slot = p[0] < 0 ? 0 : p[3] < 0 ? 3 : -1;
    if (slot < 0) return;
    p[slot] = e.pointerId;
    p[slot + 1] = e.clientX;
    p[slot + 2] = e.clientY;
    canvas.setPointerCapture(e.pointerId);
    orbit.checked = false;
    p[6] = p[0] >= 0 && p[3] >= 0 ? Math.hypot(p[1] - p[4], p[2] - p[5]) : 0;
  };
  private readonly pointerMove = (e: PointerEvent): void => {
    if (e.pointerType === 'touch') return;
    const p = this.pointers,
      slot = p[0] === e.pointerId ? 0 : p[3] === e.pointerId ? 3 : -1;
    if (slot < 0) return;
    const dx = e.clientX - p[slot + 1],
      dy = e.clientY - p[slot + 2];
    p[slot + 1] = e.clientX;
    p[slot + 2] = e.clientY;
    if (p[0] >= 0 && p[3] >= 0) {
      const length = Math.hypot(p[1] - p[4], p[2] - p[5]);
      if (p[6] > 0) this.motion[2] = Math.max(42, Math.min(140, (this.motion[2] * p[6]) / Math.max(1, length)));
      p[6] = length;
      this.motion[3] = this.motion[4] = 0;
    } else {
      this.motion[3] = -dx * 0.16;
      this.motion[4] = dy * 0.13;
    }
  };
  private readonly pointerUp = (e: PointerEvent): void => {
    if (e.pointerType === 'touch') return;
    const p = this.pointers;
    if (p[0] === e.pointerId) p[0] = -1;
    if (p[3] === e.pointerId) p[3] = -1;
    p[6] = 0;
  };
  private readonly touchState = (e: TouchEvent): void => {
    if (e.cancelable) e.preventDefault();
    const a = e.targetTouches[0],
      b = e.targetTouches[1],
      p = this.pointers;
    if (e.type === 'touchstart' || b || p[3] >= 0) this.motion[3] = this.motion[4] = 0;
    this.motion[5] = 0;
    p[0] = a?.identifier ?? -1;
    p[1] = a?.clientX ?? 0;
    p[2] = a?.clientY ?? 0;
    p[3] = b?.identifier ?? -1;
    p[4] = b?.clientX ?? 0;
    p[5] = b?.clientY ?? 0;
    p[6] = a && b ? Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) : 0;
    if (a) orbit.checked = false;
  };
  private readonly touchMove = (e: TouchEvent): void => {
    if (e.cancelable) e.preventDefault();
    const a = e.targetTouches[0],
      b = e.targetTouches[1],
      p = this.pointers;
    if (!a) return;
    if (p[0] !== a.identifier || p[3] !== (b?.identifier ?? -1)) {
      this.touchState(e);
      return;
    }
    if (b) {
      const length = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      if (p[6] > 0 && length >= 1) this.motion[2] = Math.max(42, Math.min(140, (this.motion[2] * p[6]) / length));
      p[6] = length;
      p[4] = b.clientX;
      p[5] = b.clientY;
      this.motion[3] = this.motion[4] = this.motion[5] = 0;
    } else {
      this.motion[3] = -(a.clientX - p[1]) * 0.16;
      this.motion[4] = (a.clientY - p[2]) * 0.13;
    }
    p[1] = a.clientX;
    p[2] = a.clientY;
  };
  private readonly cancelGesture = (): void => {
    const p = this.pointers;
    for (const slot of [0, 3])
      if (p[slot] >= 0 && canvas.hasPointerCapture(p[slot])) canvas.releasePointerCapture(p[slot]);
    p[0] = p[3] = -1;
    p[6] = 0;
    this.motion[3] = this.motion[4] = this.motion[5] = 0;
  };
  private readonly wheel = (e: WheelEvent): void => {
    e.preventDefault();
    const delta = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? canvas.clientHeight : 1);
    this.motion[5] += Math.max(-200, Math.min(200, delta * 0.25));
  };
  private readonly keyDown = (e: KeyboardEvent): void => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      this.motion[3] = e.key === 'ArrowLeft' ? -1 : 1;
      orbit.checked = false;
      e.preventDefault();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      this.motion[4] = e.key === 'ArrowUp' ? -0.6 : 0.6;
      orbit.checked = false;
      e.preventDefault();
    } else if (e.key === '+' || e.key === '=') this.motion[5] = -50;
    else if (e.key === '-') this.motion[5] = 50;
  };

  private fail(error: { message: string }): void {
    status.hidden = false;
    status.setAttribute('role', 'alert');
    status.textContent = error.message;
    this.dispose();
  }
  readonly dispose = (): void => {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    this.events.abort();
    this.engine.dispose();
  };
}
declare global {
  interface Window {
    nightCitadel?: NightCitadel;
  }
}
async function boot(): Promise<void> {
  let engine: EngineKernel | undefined;
  try {
    if (!navigator.gpu)
      throw new Error('This showcase needs WebGPU. Open it in a WebGPU-enabled browser on localhost or HTTPS.');
    engine = await EngineKernel.create(canvas, {
      backend: 'webgpu',
      capacity: 1,
      camera: { position: [0, 12, 82], target: [0, 12, 0], fov: 58, near: 0.3, far: 500 },
    });
    window.nightCitadel = new NightCitadel(engine);
    watchQuality();
    status.hidden = true;
  } catch (error) {
    engine?.dispose();
    status.hidden = false;
    status.setAttribute('role', 'alert');
    status.textContent = error instanceof Error ? error.message : String(error);
  }
}
void boot();
if (import.meta.hot) import.meta.hot.dispose(() => window.nightCitadel?.dispose());
