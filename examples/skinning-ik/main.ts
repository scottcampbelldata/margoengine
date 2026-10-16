import { createStage } from 'margoengine';
import { engineRuntime, meshRuntime, type Mesh, type Vec3 } from '@margoengine/core/extension';
import { loadGLTF } from '@margoengine/gltf-pro';
import { Animation } from '@margoengine/animation';
import { Animator } from '@margoengine/animator';
import { DragControls, OrbitControls, TransformControls } from '@margoengine/controls';
import { TransparentCanvas, Environment, loadEnvironmentImage } from '@margoengine/environment';
import { LightProbes } from '@margoengine/environment/probes';
import { Shadows } from '@margoengine/shadows';
import { Tonemap } from '@margoengine/tonemap';
import { PostStack } from '@margoengine/post/stack';
import { SSAO } from '@margoengine/post/ssao';
import { Bloom } from '@margoengine/post/bloom';
import { Line, Lines } from '@margoengine/lines';
import { Quaternion } from '@margoengine/math/quaternion';
import { multiplyQuaternions } from '@margoengine/math/quat';
import { SRGBToLinear } from '@margoengine/math/color';
import {
  worldPosition,
  worldRotation,
  rotateWorld,
  localPoint,
  gripPosition,
  holdObjectAtGrip,
} from './rig-ik';
import { attachWorkshopStats } from './performance-hud';
import { BodyIK } from './body-ik';
import { attachGPUAudit } from './gpu-audit';
import { showShadowDebug } from './shadow-debug';
import { workshopShadowPoints } from './shadow-bounds';

type Point = [number, number, number];
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const checkbox = (id: string) => $<HTMLInputElement>(id);
const error = $('error'),
  state = $('reach-state'),
  distance = $<HTMLOutputElement>('distance');
const abort = new AbortController();
let dispose: (() => void) | undefined;
addEventListener(
  'pagehide',
  () => {
    abort.abort();
    dispose?.();
  },
  { once: true },
);
const subtract = (a: Vec3, b: Vec3): Point => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Point => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const conjugate = (q: readonly number[]) => [-q[0], -q[1], -q[2], q[3]];
const between = (a: Vec3, b: Vec3) => {
  const al = Math.hypot(...a),
    bl = Math.hypot(...b);
  if (al < 1e-7 || bl < 1e-7) return [0, 0, 0, 1];
  const q = new Quaternion().setFromUnitVectors(
    { x: a[0] / al, y: a[1] / al, z: a[2] / al },
    { x: b[0] / bl, y: b[1] / bl, z: b[2] / bl },
  );
  // Limit the optical head's neck travel; smooth and stable at targets behind the body.
  const angle = 2 * Math.acos(Math.min(1, Math.abs(q.w)));
  if (angle > 0.85)
    q.identity().slerp(
      new Quaternion().setFromUnitVectors(
        { x: a[0] / al, y: a[1] / al, z: a[2] / al },
        { x: b[0] / bl, y: b[1] / bl, z: b[2] / bl },
      ),
      0.85 / angle,
    );
  return [q.x, q.y, q.z, q.w];
};

// Playback control belongs to this demo; Animator remains the single owner of the base pose.
class WorkshopAnimator extends Animator {
  playing = true;
  override onPreUpdate(dt: number) {
    this.playing = checkbox('idle').checked;
    super.onPreUpdate(this.playing ? dt : 0);
  }
}

try {
  const homeEye: Point = [-1.9, 1.34, -2.8],
    homeLook: Point = [0.05, 0.58, 0.04];
  const frameScale = () => Math.max(1, 1.4 / ($('viewport').clientWidth / $('viewport').clientHeight));
  const framedEye = (eye: Point, look: Point): Point =>
    add(look, subtract(eye, look).map((v) => v * frameScale()) as Point);
  const stage = await createStage('#viewport', {
    backend: 'webgpu',
    features: ['timestamp-query'],
    autoStart: false,
    controls: false,
    capacity: 2048,
    label: 'The light keeper: an interactive skinned robot in a 360 degree workshop',
    camera: { fov: 35, position: framedEye(homeEye, homeLook), target: homeLook, near: 0.03, far: 40 },
    onError: (reason) => {
      error.textContent = String(reason);
    },
  });
  let stopped = false,
    bakeJob: Promise<void> | undefined;
  const teardown: (() => void)[] = [];
  dispose = () => {
    if (stopped) return;
    stopped = true;
    stage.engine.stop();
    for (const cleanup of teardown) cleanup();
    // Let an already submitted probe readback finish before destroying its GPU resources.
    if (bakeJob) void bakeJob.catch(() => {}).finally(() => stage.dispose());
    else stage.dispose();
  };
  const runtime = engineRuntime(stage.engine);
  const performanceHUD = attachWorkshopStats(stage.engine, $('viewport'));
  teardown.push(() => performanceHUD.dispose());
  stage.canvas.tabIndex = 0;
  TransparentCanvas.attach(stage.engine);
  runtime.lighting.direction.set([-3, 3.5, 2.5, 4]);
  runtime.lighting.radiance.set([1, 0.91, 0.78, 0.5]);
  const [model, orb] = await Promise.all([
    loadGLTF(stage.engine, new URL('../assets/skinning-ik.glb', import.meta.url), { signal: abort.signal }),
    loadGLTF(stage.engine, new URL('../assets/skinning-ik-orb.glb', import.meta.url), { signal: abort.signal }),
  ]);
  abort.signal.throwIfAborted();
  const defs = model.asset.doc.nodes;
  const node = (name: string) => {
    const index = defs.findIndex((n: { name?: string }) => n.name === name);
    if (index < 0) throw new Error('Missing workshop joint: ' + name);
    return model.nodes[index];
  };
  const shoulder = node('UpperArm'),
    elbow = node('Forearm'),
    wrist = node('Hand'),
    head = node('Head');
  runtime.store.tick(false);
  const orbOffset: Point = [0, 0.13, 0],
    home = add(worldPosition(wrist), orbOffset);
  orb.root.setPosition(home);
  const localGrip = localPoint(wrist, home);
  const targetHandle = runtime.createMesh().setPosition(home);
  const keepOrbHeld = () => holdObjectAtGrip(meshRuntime(orb.root), wrist, localGrip);
  const wristOrientation = worldRotation(wrist);
  const bodyIK = new BodyIK({ frame: meshRuntime(model.root), shoulder, elbow, wrist, localGrip });
  $('viewport').dataset.constraintSolver = '@margoengine/kinematics-constraints';
  const animation = Animation.attach(model);
  if (!animation.clips.length) throw new Error('The robot is missing its Blender-authored idle animation');
  const animator = new WorkshopAnimator(animation, { initial: 'idle', states: { idle: animation.clips[0].name } });
  stage.use(animator);

  // Target manipulation owns pointer-down before orbit sees it. Both controls release on cancel/Escape.
  const transform = TransformControls.attach(stage.engine, { mode: 'translate', space: 'world', size: 0.55 });
  transform.attach(targetHandle);
  const drag = DragControls.attach(stage.engine, [orb]);
  const orbit = OrbitControls.attach(stage.engine);
  orbit.enableDamping = true;
  orbit.dampingFactor = 0.12;
  orbit.minDistance = 0.75;
  orbit.maxDistance = 7;
  orbit.minPolarAngle = 0.08;
  orbit.maxPolarAngle = Math.PI * 0.49;
  orbit.saveState();
  let orbitInteracting = false,
    lastInteraction = 0;
  orbit.addEventListener('start', () => {
    orbitInteracting = true;
    lastInteraction = performance.now();
    document.body.dataset.view = 'free';
    document.querySelectorAll('.views button').forEach((button) => button.classList.remove('active'));
  });
  orbit.addEventListener('end', () => {
    orbitInteracting = false;
    lastInteraction = performance.now();
  });
  $('control-fields').addEventListener('input', () => { lastInteraction = performance.now(); });
  let previousFrameScale = frameScale();
  const resize = new ResizeObserver(() => {
    const scale = frameScale(),
      ratio = scale / previousFrameScale;
    if (document.body.dataset.view !== 'close') {
      const look = stage.engine.camera.target;
      stage.engine.camera.position = add(
        look,
        subtract(stage.engine.camera.position, look).map((v) => v * ratio) as Point,
      );
    }
    previousFrameScale = scale;
  });
  resize.observe($('viewport'));
  teardown.push(() => resize.disconnect());
  const startDrag = () => {
    lastInteraction = performance.now();
    orbit.enabled = false;
    checkbox('autopilot').checked = false;
  };
  const endDrag = () => {
    lastInteraction = performance.now();
    orbit.enabled = true;
  };
  drag.addEventListener('dragstart', startDrag);
  drag.addEventListener('dragend', endDrag);
  transform.addEventListener('mouseDown', startDrag);
  transform.addEventListener('mouseUp', endDrag);
  drag.addEventListener('hoveron', () => {
    stage.canvas.style.cursor = 'grab';
  });
  drag.addEventListener('hoveroff', () => {
    stage.canvas.style.cursor = '';
  });
  const pointers = new Map<number, string>();
  const trackPointer = (event: PointerEvent) => {
    pointers.set(event.pointerId, event.pointerType);
  };
  const forgetPointer = (event: PointerEvent) => {
    pointers.delete(event.pointerId);
  };
  stage.canvas.addEventListener('pointerdown', trackPointer, true);
  stage.canvas.addEventListener('pointerup', forgetPointer, true);
  stage.canvas.addEventListener('pointercancel', forgetPointer, true);
  const releaseInteractions = () => {
    for (const [pointerId, pointerType] of [...pointers]) {
      stage.canvas.dispatchEvent(new PointerEvent('pointercancel', { pointerId, pointerType }));
      if (stage.canvas.hasPointerCapture(pointerId)) stage.canvas.releasePointerCapture(pointerId);
    }
    orbit.enabled = true;
  };
  teardown.push(() => {
    releaseInteractions();
    stage.canvas.removeEventListener('pointerdown', trackPointer, true);
    stage.canvas.removeEventListener('pointerup', forgetPointer, true);
    stage.canvas.removeEventListener('pointercancel', forgetPointer, true);
    drag.dispose();
    transform.dispose();
    orbit.dispose();
  });

  const shadows = Shadows.attach(stage.engine, {
    resolution: 2048,
    bounds: { min: [-1.5, -0.27, -1.48], max: [1.5, 1.82, 1.53], points: workshopShadowPoints },
    casterMargin: 1,
    lightSize: 0.012,
    normalBias: 0.0004,
    bias: 0.00003,
  });
  shadows.add(model);
  shadows.add(orb);
  const contact = new SSAO({ radius: 0.1, bias: 0.0015, samples: 32 });
  contact.add(model);
  contact.add(orb);
  PostStack.attach(stage.engine, [
    contact,
    new Bloom({ threshold: 1.3, strength: 0.12 }),
    new Tonemap({ curve: 'neutral', exposure: 0.25 }),
  ]);
  // CC0 Artist Workshop by Oliksiy Yakovlyev / Poly Haven. Add broad cream bounce
  // light to its linear HDR radiance so shaded paint/stone stay legible. The same
  // environment lights the scene and reflection captures; bright windows retain
  // their original contrast. The downloaded HDR itself remains unchanged.
  const environmentImage = await loadEnvironmentImage(new URL('../assets/skinning-ik-workshop.hdr', import.meta.url), {
    signal: abort.signal,
  });
  abort.signal.throwIfAborted();
  const fill = [244, 239, 235].map((channel) => SRGBToLinear(channel / 255) * 0.16);
  for (let pixel = 0; pixel < environmentImage.data.length; pixel += 4)
    for (let channel = 0; channel < 3; channel++) environmentImage.data[pixel + channel] += fill[channel];
  const environment = await Environment.attach(stage.engine, environmentImage, {
    size: 256,
    specularSize: 256,
    samples: 128,
    brdfSize: 64,
    brdfSamples: 64,
    intensity: 1.0,
  });
  abort.signal.throwIfAborted();
  const probes = LightProbes.attach(stage.engine, {
    environment,
    resolution: 128,
    near: 0.02,
    far: 15,
    reflections: [{ position: home, min: [-4, -1, -4], max: [4, 5, 4], blend: 0 }],
  });
  probes.add(model);
  // Receive the reflection, but exclude the orb itself from its six-face capture.
  const removeOrbReflection = orb.addLighting(probes);
  teardown.push(removeOrbReflection);
  const lines = Lines.attach(stage.engine);
  const bones = lines.add(
    new Line({
      mode: 'strip',
      positions: [0, 0, 0, 0, 0, 0, 0, 0, 0],
      color: '#e4a75e',
      width: 2,
      opacity: 0.85,
      onTop: true,
    }),
  );
  const tether = lines.add(
    new Line({
      positions: [0, 0, 0, 0, 0, 0],
      color: '#bd5837',
      width: 1.5,
      opacity: 0.7,
      dashed: true,
      dashSize: 0.025,
      gapSize: 0.018,
      onTop: true,
    }),
  );

  let elapsed = 0,
    manual = true,
    savedPose: number[][] | undefined;
  let residual = 0,
    bodyContact = false,
    frameCount = 0,
    animationFrames = 0,
    poseUpdates = 0,
    reflectionCount = 0,
    reflectionBusy = false,
    reflectionLast = 0;
  let frameStamp = 0, frameMs = 0, p95Ms = 0, probeEncodeMs = 0, probeTotalMs = 0;
  const gpuAudit = attachGPUAudit(performanceHUD.stats, $('viewport'), {
    engine: runtime,
    report: () => ({ probeEncodeMs, probeTotalMs, reflectionBusy, reflections: reflectionCount }),
  });
  teardown.push(gpuAudit.dispose);
  const frameTimes: number[] = [];
  const t = runtime.store.transforms;
  const localRotation = (mesh: Mesh) => [t.qx[mesh.id], t.qy[mesh.id], t.qz[mesh.id], t.qw[mesh.id]];
  const syncSliders = () => {
    const p = targetHandle.position;
    ['x', 'y', 'z'].forEach((axis, i) => {
      const input = checkbox('target-' + axis),
        value = p[['x', 'y', 'z'][i] as 'x' | 'y' | 'z'] - home[i];
      input.value = String(Math.max(Number(input.min), Math.min(Number(input.max), value)));
      $<HTMLOutputElement>('target-' + axis + '-value').value = Math.abs(value) < 0.05 ? '0.0' : value.toFixed(1);
    });
  };
  const moveOrb = (position: Vec3) => {
    const bounded = position.map((v, i) =>
      Math.max([-1.3, 0.48, -1.0][i], Math.min([0.75, 1.85, 0.85][i], v)),
    ) as Point;
    targetHandle.setPosition(bounded);
    syncSliders();
  };
  drag.addEventListener('drag', () => {
    moveOrb([orb.root.position.x, orb.root.position.y, orb.root.position.z]);
    keepOrbHeld();
  });
  transform.addEventListener('objectChange', () =>
    moveOrb([targetHandle.position.x, targetHandle.position.y, targetHandle.position.z]),
  );
  stage.use({
    name: 'workshop-pose',
    setup() {},
    onPreUpdate(dt: number) {
      if (dt > 0) {
        animationFrames++;
        const now = performance.now();
        if (frameStamp) {
          frameTimes.push(now - frameStamp);
          if (frameTimes.length > 120) frameTimes.shift();
          if (frameCount % 30 === 0) {
            frameMs = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length;
            p95Ms = [...frameTimes].sort((a, b) => a - b)[Math.floor(frameTimes.length * 0.95)];
          }
        }
        frameStamp = now;
      }
      elapsed += Math.min(dt, 0.05);
      frameCount++;
      if (checkbox('moving-light').checked)
        runtime.lighting.direction.set([
          -2.5 + Math.sin(elapsed * 0.35) * 2,
          3,
          2.3 + Math.cos(elapsed * 0.35) * 1.4,
          4,
        ]);
      if (checkbox('autopilot').checked && !drag.dragging && !transform.dragging)
        moveOrb(
          add(home, [Math.sin(elapsed * 0.65) * 0.17, Math.sin(elapsed * 0.85) * 0.14, Math.cos(elapsed * 0.65) * 0.1]),
        );
      runtime.store.tick(false);
      const desiredOrb = worldPosition(targetHandle);
      if (checkbox('ik-enabled').checked) {
        rotateWorld(wrist, multiplyQuaternions(wristOrientation, conjugate(worldRotation(wrist))));
        runtime.store.tick(false);
      }
      const maintainedOffset = subtract(gripPosition(wrist, localGrip), worldPosition(wrist));
      const target = subtract(desiredOrb, maintainedOffset);
      if (dt > 0 || !savedPose) bodyContact = false;
      if (checkbox('ik-enabled').checked) {
        // Probe captures render zero-delta frames. Reuse the presented pose so
        // those extra renders cannot advance contact recovery or shoulder roll.
        if ((dt > 0 || !savedPose) && (checkbox('auto-ik').checked || manual || !savedPose)) {
          poseUpdates++;
          // Only initial setup may solve without an elapsed frame. Probe renders
          // reuse savedPose and never advance constraint history.
          bodyContact = bodyIK.solve(desiredOrb, dt > 0 ? dt : 1 / 60).blocked;
          manual = false;
        } else [shoulder, elbow, wrist].forEach((mesh, i) => mesh.setQuaternion(savedPose![i]));
      }
      const contact = bodyIK.enforce();
      bodyContact ||= contact.blocked;
      if (checkbox('ik-enabled').checked) savedPose = [shoulder, elbow, wrist].map(localRotation);
      runtime.store.tick(false);
      const heldOrb = keepOrbHeld();
      if (checkbox('look').checked) {
        // The custom robot's optical face points along local -Z.
        const m = head.matrix,
          forward: Point = [-m[8], -m[9], -m[10]];
        rotateWorld(head, between(forward, subtract(worldPosition(meshRuntime(orb.root)), worldPosition(head))));
      }
      runtime.store.tick(false);
      const a = worldPosition(shoulder),
        b = worldPosition(elbow),
        c = worldPosition(wrist);
      residual = Math.hypot(...subtract(heldOrb, desiredOrb));
      const gripError = Math.hypot(...subtract(heldOrb, gripPosition(wrist, localGrip)));
      bones.visible = checkbox('show-rig').checked;
      bones.setPositions([...a, ...b, ...c]);
      tether.visible = checkbox('show-rig').checked && residual > 0.008;
      tether.setPositions([...heldOrb, ...desiredOrb]);
      transform.visible = checkbox('show-rig').checked;
      transform.enabled = checkbox('show-rig').checked;
      if (checkbox('follow').checked && !drag.dragging && !transform.dragging) {
        const desired = worldPosition(meshRuntime(orb.root)),
          old = stage.engine.camera.target;
        const next = old.map((v, i) => v + (desired[i] - v) * Math.min(dt * 4, 1)) as Point;
        stage.engine.camera.position = add(stage.engine.camera.position, subtract(next, old));
        orbit.target = next;
      }
      if (frameCount % 6 === 0) {
        state.textContent = !checkbox('ik-enabled').checked
          ? 'Held in hand · IK off'
          : !checkbox('auto-ik').checked
            ? 'Held pose · solve one step'
            : bodyContact
              ? 'At body surface'
              : residual > 0.012
                ? 'At arm’s reach'
                : 'Held in hand';
        distance.value = residual > 0.012 ? (residual * 100).toFixed(1) + ' cm to target' : 'Grip secure';
        $('viewport').dataset.metrics = JSON.stringify({
          residual,
          gripError,
          desiredOrb,
          gripCenter: gripPosition(wrist, localGrip),
          frames: frameCount,
          animationFrames,
          poseUpdates,
          reflections: reflectionCount,
          shadowDraws: shadows.stats.dynamicDraws,
          wrist: c,
          target,
          orb: worldPosition(meshRuntime(orb.root)),
          camera: [...stage.engine.camera.position],
          light: [...runtime.lighting.direction],
          dragging: !!drag.dragging || transform.dragging,
          orbitEnabled: orbit.enabled,
          animationTime: animator.time,
          arm: { shoulder: a, elbow: b, wrist: c, bodyContact, safe: contact.safe },
          head: { position: worldPosition(head), forward: [-head.matrix[8], -head.matrix[9], -head.matrix[10]] },
          performance: { frameMs, p95Ms, probeEncodeMs, probeTotalMs },
        });
      }
    },
  });

  for (const [i, axis] of ['x', 'y', 'z'].entries())
    checkbox('target-' + axis).addEventListener('input', () => {
      checkbox('autopilot').checked = false;
      const p: Point = [targetHandle.position.x, targetHandle.position.y, targetHandle.position.z];
      p[i] = home[i] + checkbox('target-' + axis).valueAsNumber;
      moveOrb(p);
    });
  const poses: Record<string, Point> = {
    home: [0, 0, 0],
    high: [0.24, 0.52, 0.23],
    front: [0.33, -0.07, -0.22],
    back: [-0.03, -0.12, 0.56],
    wide: [-0.15, -0.06, 0.05],
    far: [-0.4, 0.28, -0.15],
  };
  document.querySelectorAll<HTMLButtonElement>('[data-pose]').forEach((button) =>
    button.addEventListener('click', () => {
      checkbox('autopilot').checked = false;
      moveOrb(add(home, poses[button.dataset.pose!]));
    }),
  );
  $('solve-once').addEventListener('click', () => {
    manual = true;
    checkbox('ik-enabled').checked = true;
  });
  $('light-cue').addEventListener('click', () => {
    checkbox('moving-light').checked = !checkbox('moving-light').checked;
  });
  const view = (position: Point, target: Point, fit = true) => {
    orbit.reset();
    stage.engine.camera.position = fit ? framedEye(position, target) : position;
    orbit.target = target;
  };
  $('view-close').addEventListener('click', () => view([0.25, 1.45, -1.0], [-0.36, 1.15, -0.17], false));
  $('view-room').addEventListener('click', () => view(homeEye, homeLook));
  $('view-back').addEventListener('click', () => view([1.9, 1.5, 2.4], [0, 0.78, 0]));
  for (const id of ['view-close', 'view-room', 'view-back'])
    $(id).addEventListener('click', () => {
      document.body.dataset.view = id.slice(5);
      document
        .querySelectorAll('.views button')
        .forEach((button) => button.classList.toggle('active', button.id === id));
    });
  const reset = () => {
    releaseInteractions();
    for (const id of ['ik-enabled', 'auto-ik', 'look', 'idle', 'moving-light', 'reflections'])
      checkbox(id).checked = true;
    for (const id of ['follow', 'autopilot', 'show-rig']) checkbox(id).checked = false;
    animator.time = 0;
    animator.playing = true;
    elapsed = 0;
    manual = true;
    savedPose = undefined;
    bodyIK.reset();
    moveOrb(home);
    view(homeEye, homeLook);
    orbit.enabled = true;
    document.body.dataset.view = 'room';
    document
      .querySelectorAll('.views button')
      .forEach((button) => button.classList.toggle('active', button.id === 'view-room'));
    document.querySelector('aside')!.scrollTop = 0;
  };
  $('reset').addEventListener('click', reset);
  $('orb-keyboard').addEventListener('keydown', (event: KeyboardEvent) => {
    const offsets: Record<string, Point> = {
      ArrowLeft: [-0.025, 0, 0],
      ArrowRight: [0.025, 0, 0],
      ArrowUp: [0, 0.025, 0],
      ArrowDown: [0, -0.025, 0],
      PageUp: [0, 0, -0.025],
      PageDown: [0, 0, 0.025],
    };
    if (!offsets[event.key]) return;
    event.preventDefault();
    lastInteraction = performance.now();
    checkbox('autopilot').checked = false;
    moveOrb(add([targetHandle.position.x, targetHandle.position.y, targetHandle.position.z], offsets[event.key]));
  });
  stage.canvas.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      releaseInteractions();
      return;
    }
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '-'].includes(event.key)) {
      event.preventDefault();
      if (event.key === '+' || event.key === '-')
        stage.canvas.dispatchEvent(
          new WheelEvent('wheel', { deltaY: event.key === '+' ? -100 : 100, cancelable: true }),
        );
      else if (event.shiftKey) {
        orbit.pan(
          event.key === 'ArrowLeft' ? 15 : event.key === 'ArrowRight' ? -15 : 0,
          event.key === 'ArrowUp' ? 15 : event.key === 'ArrowDown' ? -15 : 0,
        );
      } else {
        orbit.rotateLeft(event.key === 'ArrowLeft' ? 0.12 : event.key === 'ArrowRight' ? -0.12 : 0);
        orbit.rotateUp(event.key === 'ArrowUp' ? 0.12 : event.key === 'ArrowDown' ? -0.12 : 0);
      }
    }
  });
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  if (reduced.matches) {
    checkbox('idle').checked = false;
    checkbox('moving-light').checked = false;
  }
  let reflectionCadenceMs = 50,
    reflectionFinalRequested = false,
    reflectionFrame = 0;
  let reflectionPosition: Point | undefined;
  const publishReflection = () => {
    $('viewport').dataset.reflection = JSON.stringify({
      resolution: probes.resolution,
      cadenceMs: reflectionCadenceMs,
      position: reflectionPosition,
      captures: reflectionCount,
      busy: reflectionBusy,
      encodeMs: probeEncodeMs,
      totalMs: probeTotalMs,
    });
  };
  const queueFinalReflection = () => {
    reflectionFinalRequested = true;
    if (!reflectionFrame)
      reflectionFrame = requestAnimationFrame(() => {
        reflectionFrame = 0;
        void refresh();
      });
  };
  const refresh = async () => {
    if (stopped || document.hidden || reflectionBusy) return;
    const enabled = checkbox('reflections').checked;
    if (!enabled) {
      reflectionFinalRequested = false;
      return;
    }
    const now = performance.now();
    const moving = drag.dragging || transform.dragging || orbitInteracting || now - lastInteraction < 250 ||
      checkbox('idle').checked || checkbox('moving-light').checked || checkbox('autopilot').checked;
    // Keep the mirror live during interaction. Spread measured capture work over
    // at least four capture durations; a final input update bypasses this delay.
    reflectionCadenceMs = Math.max(moving ? 50 : 250, probeTotalMs * 4);
    if (reflectionCount && now - reflectionLast < 50) return;
    if (!reflectionFinalRequested && reflectionCount && now - reflectionLast < reflectionCadenceMs) return;
    reflectionFinalRequested = false;
    reflectionBusy = true;
    reflectionLast = now;
    try {
      runtime.store.tick(false);
      reflectionPosition = worldPosition(meshRuntime(orb.root));
      probes.setReflectionPosition(0, reflectionPosition);
      const started = performance.now();
      gpuAudit.mark('reflection-start');
      bakeJob = probes.bake({ samples: 256 });
      probeEncodeMs = performance.now() - started;
      publishReflection();
      await bakeJob;
      probeTotalMs = performance.now() - started;
      gpuAudit.mark('reflection-complete', probeTotalMs);
      if (!stopped) reflectionCount++;
    } catch (reason) {
      if (!stopped) error.textContent = String(reason);
    } finally {
      reflectionBusy = false;
      bakeJob = undefined;
      if (!stopped) {
        publishReflection();
        if (reflectionFinalRequested) queueFinalReflection();
      }
    }
  };
  drag.addEventListener('dragend', queueFinalReflection);
  transform.addEventListener('mouseUp', queueFinalReflection);
  $('control-fields').addEventListener('change', queueFinalReflection);
  $('control-fields').addEventListener('click', queueFinalReflection);
  $('orb-keyboard').addEventListener('keyup', queueFinalReflection);
  teardown.push(() => {
    cancelAnimationFrame(reflectionFrame);
    drag.removeEventListener('dragend', queueFinalReflection);
    transform.removeEventListener('mouseUp', queueFinalReflection);
    $('control-fields').removeEventListener('change', queueFinalReflection);
    $('control-fields').removeEventListener('click', queueFinalReflection);
    $('orb-keyboard').removeEventListener('keyup', queueFinalReflection);
  });
  reset();
  if (reduced.matches) {
    checkbox('idle').checked = false;
    checkbox('moving-light').checked = false;
  }
  stage.engine.render();
  if (new URLSearchParams(location.search).get('shadowDebug') === '1') {
    const proof = await showShadowDebug(stage.engine, shadows, $('viewport'));
    teardown.push(proof.dispose);
  }
  await refresh();
  abort.signal.throwIfAborted();
  stage.engine.start();
  const timer = setInterval(() => {
    void refresh();
  }, 25);
  teardown.push(() => clearInterval(timer));
  $<HTMLFieldSetElement>('control-fields').disabled = false;
  $<HTMLButtonElement>('orb-keyboard').disabled = false;
  $('viewport').dataset.ready = 'true';
  syncSliders();
  state.textContent = 'Held in hand';
} catch (reason) {
  dispose?.();
  if (!abort.signal.aborted) {
    state.textContent = 'Workshop could not load';
    error.textContent = String(reason);
  }
}
