// Page for scripts/lifecycle-browser-tests.mjs: a stage (with Rapier physics) or a React Canvas whose frame loop the
// test drives through lifecycleClock (tests/lifecycle-browser.html): background the tab, resize at fractional pixel
// ratios, lose the GPU device, or run with no WebGPU at all.
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import RAPIER from '@dimforge/rapier3d-compat';
import { Canvas, useFrame, useMargo, type MargoContextValue } from '@margoengine/react';
import { Box } from '@margoengine/react/geometry';
import { box } from '@margoengine/core';
import { createStage, type Engine, type Stage } from '@margoengine/stage';
import { Physics, type PhysicsBody } from '@margoengine/physics';

declare global {
  interface Window {
    lifecycleClock: { jump(ms: number): void; visibility(state: 'visible' | 'hidden'): void };
    lifecycle: typeof lifecycle;
  }
}
interface Frame {
  delta: number;
  steps: number;
  y: number;
}
const host = document.querySelector<HTMLElement>('#app')!,
  errors: string[] = [],
  log: Frame[] = [];
// The newest frame logged, kept when the log is drained.
let latest: Frame | null = null;
window.addEventListener('unhandledrejection', (event) => errors.push(`unhandled rejection: ${String(event.reason)}`));
window.addEventListener('error', (event) => errors.push(`uncaught: ${event.message}`));
let stage: Stage | undefined,
  root: Root | undefined,
  context: MargoContextValue | undefined,
  body: PhysicsBody | undefined,
  marked: GPUDevice | null = null,
  lost: { reason: string; message: string } | null = null,
  steps = 0;

const frames = (count: number) =>
  new Promise<void>((resolve) => {
    const tick = () => (count-- <= 0 ? resolve() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  });
const engine = () => (stage?.engine ?? context?.gl) as unknown as Engine | undefined;
const failure = (error: unknown) => {
  const { name, code, message } = error as { name?: string; code?: string; message?: string };
  return { name, code, message };
};

function Probe({ mode }: { mode: 'always' | 'demand' }) {
  context = useMargo();
  useFrame((_, delta) => {
    log.push((latest = { delta, steps: 0, y: 0 }));
  });
  React.useEffect(() => {
    if (mode === 'demand' && context?.ready) context.invalidate();
  }, [mode, context?.ready]);
  return null;
}

const lifecycle = {
  errors,
  /** Creates a stage in #app, with a falling Rapier body when `physics`; resolves the rejection when it fails. */
  async stage({ physics = false } = {}) {
    try {
      stage = await createStage(host, { onError: (error) => errors.push(`onError: ${String(error)}`) });
    } catch (error) {
      return { rejected: failure(error) };
    }
    stage.box({ color: '#c08040' });
    if (physics) {
      await RAPIER.init();
      const world = new Physics(stage.engine, { rapier: RAPIER });
      body = world.addBody(stage.box({ position: [0, 5, 0] }), {});
      world.on('afterstep', () => steps++);
    }
    // Registered after the physics plugin, so it sees the steps that frame ran.
    stage.engine.use({
      name: 'lifecycle-log',
      setup() {},
      onPreUpdate(delta) {
        log.push((latest = { delta, steps, y: body?.position[1] ?? 0 }));
        steps = 0;
      },
      dispose() {},
    });
    await frames(5);
    return { rejected: null };
  },
  /** Mounts a React Canvas in #app; resolves the text of its alert when it shows one instead of a scene. */
  async react(mode: 'always' | 'demand') {
    root = createRoot(host);
    root.render(
      <Canvas frameloop={mode} onError={(error) => errors.push(`onError: ${String(error)}`)}>
        <Box />
        <Probe mode={mode} />
      </Canvas>,
    );
    for (let i = 0; i < 600 && !context?.ready && !host.querySelector('[role=alert]'); i++) await frames(1);
    await frames(5);
    return { alert: host.querySelector('[role=alert]')?.textContent ?? null, ready: !!context?.ready };
  },
  invalidate() {
    context!.invalidate();
  },
  /**
   * The page goes to the background for `ms` (the clock jumps, no waiting) and comes back. Returns the last frame
   * before and empties the log in the same task, so the next logged frame is the first one back.
   */
  background(ms: number) {
    const last = latest;
    log.length = 0;
    window.lifecycleClock.visibility('hidden');
    window.lifecycleClock.jump(ms);
    window.lifecycleClock.visibility('visible');
    return last;
  },
  /** Jumps the clock by `ms` (one long frame) and empties the log in the same task. */
  jump(ms: number) {
    log.length = 0;
    window.lifecycleClock.jump(ms);
  },
  setMaxDelta(seconds: number) {
    engine()!.maxDelta = seconds;
  },
  async frames(count: number) {
    await frames(count);
  },
  /** The frames logged since the last call. */
  drain() {
    return log.splice(0);
  },
  resize(width: string, height: string) {
    host.style.width = width;
    host.style.height = height;
  },
  size() {
    const canvas = engine()!.canvas;
    return {
      dpr: devicePixelRatio,
      css: [canvas.getBoundingClientRect().width, canvas.getBoundingClientRect().height],
      client: [canvas.clientWidth, canvas.clientHeight],
      pixels: [canvas.width, canvas.height],
    };
  },
  /** Destroys the engine's GPU device as a driver reset would; resolves the new device's state once it is back. */
  async loseDevice() {
    lifecycle.markDevice();
    marked!.destroy();
    return lifecycle.replacedSinceMark();
  },
  /**
   * Loses the device with geometry changing all through the restore: on the lost device while the new one is awaited
   * (a batch that grows, a new batch), and inside onDeviceRestored on the new one. Resolves what the frames then draw.
   */
  async loseDeviceSettingGeometry() {
    const e = engine()!,
      shared = box(),
      meshes = [e.createMesh().setGeometry(shared), e.createMesh().setGeometry(shared)],
      idle = [e.createMesh(), e.createMesh(), e.createMesh(), e.createMesh()];
    e.use({
      name: 'lifecycle-restore',
      setup() {},
      onDeviceRestored() {
        idle[2].setGeometry(shared);
        idle[3].setGeometry(box(2));
      },
    });
    await frames(3);
    const before = e.stats.visible;
    lifecycle.markDevice();
    marked!.destroy();
    await marked!.lost; // the renderer's own handler ran first: the restore is under way, on the lost renderer
    idle[0].setGeometry(shared);
    idle[1].setGeometry(box(3));
    const state = await lifecycle.replacedSinceMark();
    return { ...state, added: e.stats.visible - before, meshes: meshes.length + idle.length };
  },
  /** Remembers the current device, for `replacedSinceMark` after a loss the test causes from outside the page. */
  markDevice() {
    marked = engine()!.gpu;
    lost = null;
    void marked?.lost.then((info) => (lost = { reason: info.reason, message: info.message }));
  },
  /** Resolves once the engine has a device other than the marked one (or after 1200 frames) and draws again. */
  async replacedSinceMark() {
    for (let i = 0; i < 1200 && engine()!.gpu === marked; i++) await frames(1);
    log.length = 0;
    await frames(5);
    return { replaced: engine()!.gpu !== marked, frames: log.length, lost };
  },
};
window.lifecycle = lifecycle;
