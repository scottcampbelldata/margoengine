import { createStage } from 'margoengine';
import { engineRuntime, meshRuntime, type Mesh, type Vec3 } from '@margoengine/core/extension';
import { loadGLTF } from '@margoengine/gltf-pro';
import { Animation } from '@margoengine/animation';
import { Animator, type AdditiveLayer, type FootIK } from '@margoengine/animator';
import { DragControls, OrbitControls, TransformControls } from '@margoengine/controls';
import { TransparentCanvas, Environment, loadEnvironmentImage } from '@margoengine/environment';
import { LightProbes } from '@margoengine/environment/probes';
import { Shadows } from '@margoengine/shadows';
import { Tonemap } from '@margoengine/tonemap';
import { PostStack } from '@margoengine/post/stack';
import { SSAO } from '@margoengine/post/ssao';
import { Bloom } from '@margoengine/post/bloom';
import { Line, Lines } from '@margoengine/lines';
import { SRGBToLinear } from '@margoengine/math/color';
import { worldPosition, worldPositionInto, localPoint, gripPosition, holdObjectAtGrip } from './rig-ik';
import { attachWorkshopStats } from './performance-hud';
import { BodyIK, type BodyIKResult } from './body-ik';
import { HeadAim } from './head-aim';
import { ArmHeadClearance } from './arm-head-clearance';
import { cowlingHull } from './head-aim-shape';
import { TorsoAim } from './torso-aim';
import { TargetMotion } from './target-motion';
import { PoseUpdateOrder, PresentedPoseSnapshot, ProbePoseReuse } from './probe-pose-reuse';
import { mapArmControl, nearestArmControlParameter, type ArmControl } from './arm-controls';
import { ArmControlRoute } from './arm-control-route';
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

// Playback control belongs to this demo; Animator remains the single owner of the base pose.
class WorkshopAnimator extends Animator {
  playing = true;
  probeReuse?: ProbePoseReuse;
  probeCompatible = true;
  override onPreUpdate(dt: number) {
    this.playing = checkbox('idle').checked;
    if (this.probeReuse?.skipAnimation(dt)) return;
    super.onPreUpdate(this.playing ? dt : 0);
  }
  replayProbePose(): void {
    super.onPreUpdate(0);
  }
  override transition(state: string, duration = 0.15): this {
    this.probeCompatible = false;
    this.probeReuse?.invalidate();
    return super.transition(state, duration);
  }
  override addLayer(layer: AdditiveLayer): () => void {
    this.probeCompatible = false;
    this.probeReuse?.invalidate();
    return super.addLayer(layer);
  }
  override addFootIK(foot: FootIK): () => void {
    this.probeCompatible = false;
    this.probeReuse?.invalidate();
    return super.addFootIK(foot);
  }
  override dispose(): void {
    this.probeCompatible = false;
    this.probeReuse?.invalidate();
    super.dispose();
  }
}

try {
  const homeEye: Point = [-2.05, 1.4, -3.03],
    homeLook: Point = [0.05, 0.78, 0.04];
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
    head = node('Head'),
    body = node('Body');
  runtime.store.tick(false);
  const orbOffset: Point = [0, 0.13, 0],
    home = add(worldPosition(wrist), orbOffset);
  orb.root.setPosition(home);
  const localGrip = localPoint(wrist, home);
  const targetHandle = runtime.createMesh().setPosition(home);
  const targetMotion = new TargetMotion(home),
    controlRoute = new ArmControlRoute();
  const acceptedOrbLocal = localPoint(meshRuntime(model.root), home);
  let routeControl: ArmControl | undefined,
    routeParameter = 0.5;
  const solved: BodyIKResult = { safe: true, limited: false, blocked: false, orb: [0, 0, 0], collision: null };
  const enforced: BodyIKResult = { safe: true, limited: false, blocked: false, orb: [0, 0, 0], collision: null };
  const heldPosition: Point = [0, 0, 0],
    heldInverse = new Float64Array(16);
  const keepOrbHeld = () => holdObjectAtGrip(meshRuntime(orb.root), wrist, localGrip, heldPosition, heldInverse);
  const torsoAim = new TorsoAim(body, meshRuntime(model.root));
  teardown.push(() => torsoAim.dispose());
  const armHeadClearance = new ArmHeadClearance(torsoAim.frame, head, shoulder, elbow);
  const opticalLocal = localPoint(head, gripPosition(meshRuntime(model.root), [0, 1.34, -0.232]));
  const headAim = new HeadAim(head, opticalLocal, 1.3, {
    min: [-0.194, -0.039, -0.236],
    max: [0.194, 0.307, 0.134],
    targetRadius: 0.10465342044830322,
    margin: 0.003,
    chestFloor: -0.032,
    chestPoints: cowlingHull,
    rotationClearance: (rotation, out) => armHeadClearance.evaluate(rotation, out),
  });
  const bodyIK = new BodyIK({
    frame: torsoAim.frame,
    armHeadClearance,
    shoulder,
    elbow,
    wrist,
    head,
    localGrip,
    extraClearance(orb, out) {
      if (checkbox('look').checked) headAim.update(orb);
      else headAim.reset(orb);
      out[0] = headAim.headClearance;
    },
  });
  $('viewport').dataset.constraintSolver = '@margoengine/kinematics-constraints';
  const animation = Animation.attach(model);
  if (!animation.clips.length) throw new Error('The robot is missing its Blender-authored idle animation');
  const animator = new WorkshopAnimator(animation, { initial: 'idle', states: { idle: animation.clips[0].name } });

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
  // Orbit's inherited Controls hook updates the camera. Register the base-pose
  // owner after it so no camera hook separates animation from pose validation.
  stage.use(animator);
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
  $('control-fields').addEventListener('input', () => {
    lastInteraction = performance.now();
  });
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
  let frameStamp = 0,
    frameMs = 0,
    p95Ms = 0,
    probeEncodeMs = 0,
    probeTotalMs = 0;
  const auditContext = { probeEncodeMs, probeTotalMs, reflectionBusy, reflections: reflectionCount };
  const gpuAudit = attachGPUAudit(performanceHUD.stats, $('viewport'), {
    engine: runtime,
    report: () => {
      auditContext.probeEncodeMs = probeEncodeMs;
      auditContext.probeTotalMs = probeTotalMs;
      auditContext.reflectionBusy = reflectionBusy;
      auditContext.reflections = reflectionCount;
      return auditContext;
    },
  });
  teardown.push(gpuAudit.dispose);
  const frameTimes = new Float64Array(120).fill(Infinity),
    sortedFrameTimes = new Float64Array(120);
  let frameTimeCursor = 0,
    frameTimeCount = 0;
  const savedRotations = [
    [0, 0, 0, 1],
    [0, 0, 0, 1],
    [0, 0, 0, 1],
  ];
  const armNodes = [shoulder, elbow, wrist];
  const desiredPosition: Point = [0, 0, 0],
    localTarget: Point = [0, 0, 0],
    shoulderPosition: Point = [0, 0, 0],
    elbowPosition: Point = [0, 0, 0],
    wristPosition: Point = [0, 0, 0],
    actualGrip: Point = [0, 0, 0],
    boundedTarget: Point = [0, 0, 0],
    movingTarget: Point = [0, 0, 0],
    sliderWorld: Point = [0, 0, 0],
    sliderLocal: Point = [0, 0, 0];
  const targetInverse = new Float64Array(16),
    sliderInverse = new Float64Array(16),
    bonePoints = new Float64Array(9),
    tetherPoints = new Float64Array(6);
  const armControls: readonly ArmControl[] = ['side', 'height', 'nearFar'];
  const controlAxes = ['x', 'y', 'z'] as const;
  const controlPoint: Point = [0, 0, 0];
  const eventPosition: Point = [0, 0, 0],
    metricTarget: Point = [0, 0, 0],
    metricHead: Point = [0, 0, 0];
  const metrics = {
    residual: 0,
    gripError: 0,
    desiredOrb: desiredPosition,
    commandOrb: targetMotion.position,
    targetMotion: { settled: false, maxSpeed: targetMotion.maxSpeed, routing: false },
    gripCenter: actualGrip,
    frames: 0,
    animationFrames: 0,
    poseUpdates: 0,
    reflections: 0,
    probePose: { attempts: 0, reused: 0, fallback: 0 },
    shadowDraws: 0,
    wrist: wristPosition,
    target: metricTarget,
    orb: heldPosition,
    camera: stage.engine.camera.position,
    cameraTarget: stage.engine.camera.target,
    light: [0, 0, 0, 0],
    dragging: false,
    orbitEnabled: true,
    animationTime: 0,
    arm: { shoulder: shoulderPosition, elbow: elbowPosition, wrist: wristPosition, bodyContact: false, safe: true },
    torso: { yaw: 0, desiredYaw: 0, maxYaw: torsoAim.maxYaw },
    head: {
      position: metricHead,
      opticalOrigin: headAim.origin,
      forward: headAim.forward,
      limited: false,
      angle: 0,
      rayError: 0,
      rayDistance: 0,
      clearanceResolved: true,
      headClearance: Infinity,
    },
    performance: { frameMs: 0, p95Ms: 0, probeEncodeMs: 0, probeTotalMs: 0 },
  };
  const syncSliders = () => {
    runtime.store.tick(false);
    const p = localPoint(
      meshRuntime(model.root),
      worldPositionInto(targetHandle, sliderWorld),
      sliderLocal,
      sliderInverse,
    );
    controlAxes.forEach((axis, i) => {
      const input = checkbox('target-' + axis),
        value = nearestArmControlParameter(armControls[i], p);
      input.value = String(value);
      $<HTMLOutputElement>('target-' + axis + '-value').value = Math.round(value * 100) + '%';
    });
  };
  const releaseControlRoute = () => {
    controlRoute.release();
    routeControl = undefined;
  };
  const moveOrb = (position: Vec3, routed = false) => {
    if (!routed) releaseControlRoute();
    boundedTarget[0] = Math.max(-1.3, Math.min(0.75, position[0]));
    boundedTarget[1] = Math.max(0.48, Math.min(1.85, position[1]));
    boundedTarget[2] = Math.max(-1.0, Math.min(0.85, position[2]));
    targetHandle.setPosition(boundedTarget);
    syncSliders();
  };
  drag.addEventListener('dragstart', releaseControlRoute);
  transform.addEventListener('mouseDown', releaseControlRoute);
  drag.addEventListener('drag', () => {
    eventPosition[0] = orb.root.position.x;
    eventPosition[1] = orb.root.position.y;
    eventPosition[2] = orb.root.position.z;
    moveOrb(eventPosition);
    keepOrbHeld();
  });
  transform.addEventListener('objectChange', () => {
    eventPosition[0] = targetHandle.position.x;
    eventPosition[1] = targetHandle.position.y;
    eventPosition[2] = targetHandle.position.z;
    moveOrb(eventPosition);
  });
  const workshopPose = {
    name: 'workshop-pose',
    setup() {},
    onPreUpdate(dt: number) {
      if (dt > 0) {
        animationFrames++;
        const now = performance.now();
        if (frameStamp) {
          frameTimes[frameTimeCursor] = now - frameStamp;
          frameTimeCursor = (frameTimeCursor + 1) % frameTimes.length;
          frameTimeCount = Math.min(frameTimeCount + 1, frameTimes.length);
          if (frameCount % 30 === 0) {
            let sum = 0;
            for (let i = 0; i < frameTimeCount; i++)
              sum += frameTimes[(frameTimeCursor - frameTimeCount + i + frameTimes.length) % frameTimes.length];
            frameMs = sum / frameTimeCount;
            sortedFrameTimes.set(frameTimes);
            sortedFrameTimes.sort();
            p95Ms = sortedFrameTimes[Math.floor(frameTimeCount * 0.95)];
          }
        }
        frameStamp = now;
      }
      elapsed += Math.min(dt, 0.05);
      frameCount++;
      if (checkbox('moving-light').checked) {
        const direction = runtime.lighting.direction;
        direction[0] = -2.5 + Math.sin(elapsed * 0.35) * 2;
        direction[1] = 3;
        direction[2] = 2.3 + Math.cos(elapsed * 0.35) * 1.4;
        direction[3] = 4;
      }
      if (checkbox('autopilot').checked && !drag.dragging && !transform.dragging) {
        movingTarget[0] = home[0] + Math.sin(elapsed * 0.65) * 0.17;
        movingTarget[1] = home[1] + Math.sin(elapsed * 0.85) * 0.14;
        movingTarget[2] = home[2] + Math.cos(elapsed * 0.65) * 0.1;
        moveOrb(movingTarget);
      }
      runtime.store.tick(false);
      const desiredOrb = worldPositionInto(targetHandle, desiredPosition);
      // Animation can restore Body between renders. Reapply the accepted turn
      // before any collision query; only a real arm solve advances its history.
      const reusePose = probePoseReuse.reusePose(dt);
      if (!reusePose) {
        torsoAim.applyHeld();
        if (dt > 0 || !savedPose) bodyContact = false;
        if (checkbox('ik-enabled').checked) {
          // Probe captures render zero-delta frames. Reuse the presented pose so
          // those extra renders cannot advance contact recovery or shoulder roll.
          if ((dt > 0 || !savedPose) && (checkbox('auto-ik').checked || manual || !savedPose)) {
            poseUpdates++;
            // Only initial setup may solve without an elapsed frame. Probe renders
            // reuse savedPose and never advance constraint history.
            const step = dt > 0 ? dt : 1 / 60;
            let goal = desiredOrb;
            if (controlRoute.active) {
              // Animator has already restored its inputs. Route from the final
              // accepted pose presented last frame, in the moving model's frame.
              const waypoint = controlRoute.update(acceptedOrbLocal, step);
              goal = gripPosition(meshRuntime(model.root), waypoint, eventPosition);
            }
            const command = targetMotion.update(goal, step);
            torsoAim.update(localPoint(meshRuntime(model.root), command, localTarget, targetInverse), step);
            bodyContact = bodyIK.solve(command, step, solved).blocked;
            manual = false;
          } else for (let i = 0; i < armNodes.length; i++) armNodes[i].setQuaternion(savedPose![i]);
        }
        const contact = bodyIK.enforce(enforced);
        bodyContact ||= contact.blocked;
        if (checkbox('ik-enabled').checked) {
          const t = runtime.store.transforms;
          for (let i = 0; i < armNodes.length; i++) {
            const id = armNodes[i].id,
              q = savedRotations[i];
            q[0] = t.qx[id];
            q[1] = t.qy[id];
            q[2] = t.qz[id];
            q[3] = t.qw[id];
          }
          savedPose = savedRotations;
        }
        runtime.store.tick(false);
        const heldOrb = keepOrbHeld();
        localPoint(meshRuntime(model.root), heldOrb, acceptedOrbLocal, targetInverse);
        // The accepted head pose was checked with the arm. Refresh diagnostics
        // against the float32-held center without changing that accepted rotation.
        headAim.checkClearance(heldOrb);
      }
      const heldOrb = heldPosition,
        contact = enforced;
      runtime.store.tick(false);
      const a = worldPositionInto(shoulder, shoulderPosition),
        b = worldPositionInto(elbow, elbowPosition),
        c = worldPositionInto(wrist, wristPosition);
      residual = Math.hypot(heldOrb[0] - desiredOrb[0], heldOrb[1] - desiredOrb[1], heldOrb[2] - desiredOrb[2]);
      gripPosition(wrist, localGrip, actualGrip);
      const gripError = Math.hypot(heldOrb[0] - actualGrip[0], heldOrb[1] - actualGrip[1], heldOrb[2] - actualGrip[2]);
      bones.visible = checkbox('show-rig').checked;
      if (bones.visible) {
        bonePoints.set(a);
        bonePoints.set(b, 3);
        bonePoints.set(c, 6);
        bones.setPositions(bonePoints);
      }
      tether.visible = checkbox('show-rig').checked && residual > 0.008;
      if (tether.visible) {
        tetherPoints.set(heldOrb);
        tetherPoints.set(desiredOrb, 3);
        tether.setPositions(tetherPoints);
      }
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
        const stateText = !checkbox('ik-enabled').checked
          ? 'Held in hand · IK off'
          : !checkbox('auto-ik').checked
            ? 'Held pose · solve one step'
            : bodyContact
              ? 'At body surface'
              : residual > 0.012
                ? 'At arm’s reach'
                : 'Held in hand';
        if (state.textContent !== stateText) state.textContent = stateText;
        const distanceText = residual > 0.012 ? (residual * 100).toFixed(1) + ' cm to target' : 'Grip secure';
        if (distance.value !== distanceText) distance.value = distanceText;
        metrics.residual = residual;
        metrics.gripError = gripError;
        metrics.targetMotion.settled = targetMotion.settled && (!controlRoute.active || controlRoute.settled);
        metrics.targetMotion.routing = controlRoute.active && !controlRoute.settled;
        metrics.frames = frameCount;
        metrics.animationFrames = animationFrames;
        metrics.poseUpdates = poseUpdates;
        metrics.reflections = reflectionCount;
        metrics.probePose.attempts = probePoseReuse.counters.attempts;
        metrics.probePose.reused = probePoseReuse.counters.reused;
        metrics.probePose.fallback = probePoseReuse.counters.fallback;
        metrics.shadowDraws = shadows.stats.dynamicDraws;
        for (let i = 0; i < 3; i++) metricTarget[i] = desiredOrb[i] - (heldOrb[i] - c[i]);
        metrics.camera = stage.engine.camera.position;
        metrics.cameraTarget = stage.engine.camera.target;
        for (let i = 0; i < 4; i++) metrics.light[i] = runtime.lighting.direction[i];
        metrics.dragging = !!drag.dragging || transform.dragging;
        metrics.orbitEnabled = orbit.enabled;
        metrics.animationTime = animator.time;
        metrics.arm.bodyContact = bodyContact;
        metrics.arm.safe = contact.safe;
        metrics.torso.yaw = torsoAim.yaw;
        metrics.torso.desiredYaw = torsoAim.desiredYaw;
        worldPositionInto(head, metricHead);
        metrics.head.limited = headAim.limited;
        metrics.head.angle = headAim.angle;
        metrics.head.rayError = headAim.rayError;
        metrics.head.rayDistance = headAim.rayDistance;
        metrics.head.clearanceResolved = headAim.clearanceResolved;
        metrics.head.headClearance = headAim.headClearance;
        metrics.performance.frameMs = frameMs;
        metrics.performance.p95Ms = p95Ms;
        metrics.performance.probeEncodeMs = probeEncodeMs;
        metrics.performance.probeTotalMs = probeTotalMs;
        $('viewport').dataset.metrics = JSON.stringify(metrics);
      }
      if (!reusePose) probePoseReuse.accept(contact.safe && headAim.clearanceResolved);
    },
  };
  stage.use(workshopPose);

  // This demo intentionally omits redundant setter calls during an unchanged,
  // validated repeat capture. Every ordinary or changed-input frame still uses
  // the public Animator and Mesh paths, including their guards and overrides.
  const modelNodeCount = model.nodes.length,
    orbNodeCount = orb.nodes.length,
    poseNodes = [
      meshRuntime(model.root),
      ...model.nodes,
      meshRuntime(orb.root),
      ...orb.nodes,
      targetHandle,
      torsoAim.frame,
    ],
    poseMorphs = [...model.primitives, ...orb.primitives];
  // Animation inputs are mutable typed arrays. Snapshot their contents too; an
  // external edit must take the ordinary validated Animator path.
  const poseClips = animation.clips.map((clip) => ({
    clip,
    name: clip.name,
    duration: clip.duration,
    tracks: clip.tracks,
    entries: clip.tracks.map((track) => ({
      track,
      node: track.node,
      path: track.path,
      width: track.width,
      interpolation: track.interpolation,
    })),
  }));
  for (let i = 0; i < poseClips.length; i++)
    for (let j = 0; j < poseClips[i].entries.length; j++) {
      const track = poseClips[i].entries[j].track;
      poseMorphs.push({
        get weights() {
          return track.times;
        },
      } as (typeof poseMorphs)[number]);
      poseMorphs.push({
        get weights() {
          return track.values;
        },
      } as (typeof poseMorphs)[number]);
    }
  const poseState = new Float64Array(32),
    poseSnapshot = new PresentedPoseSnapshot(poseNodes, poseMorphs, poseState.length),
    expectedBaseUpdate = Animator.prototype.onPreUpdate,
    expectedAnimationUpdate = animation.onPreUpdate,
    poseUpdateOrder = new PoseUpdateOrder(runtime.plugins, animator, workshopPose);
  const readPoseState = (out: Float64Array): boolean => {
    if (
      stopped ||
      model.disposed ||
      orb.disposed ||
      !savedPose ||
      !checkbox('ik-enabled').checked ||
      !animator.probeCompatible ||
      Animator.prototype.onPreUpdate !== expectedBaseUpdate ||
      animation.onPreUpdate !== expectedAnimationUpdate ||
      runtime.plugins.get(animator.name) !== animator ||
      runtime.plugins.get(animation.name) !== animation ||
      runtime.plugins.get(workshopPose.name) !== workshopPose ||
      animator.state !== 'idle' ||
      animator.options.initial !== 'idle' ||
      animator.options.states.idle !== poseClips[0].name ||
      animator.options.transitions !== undefined ||
      animation.playing ||
      model.nodes.length !== modelNodeCount ||
      orb.nodes.length !== orbNodeCount ||
      meshRuntime(model.root) !== poseNodes[0] ||
      meshRuntime(orb.root) !== poseNodes[modelNodeCount + 1] ||
      animation.clips.length !== poseClips.length
    )
      return false;
    // This demo creates one parameter-free idle state. More general Animator
    // layers, feet, transitions or caller parameters keep their normal callbacks.
    for (const key in animator.parameters) if (Object.hasOwn(animator.parameters, key)) return false;
    for (const key in animator.options.states)
      if (Object.hasOwn(animator.options.states, key) && key !== 'idle') return false;
    if (!poseUpdateOrder.matches()) return false;
    for (let i = 0; i < model.nodes.length; i++) if (model.nodes[i] !== poseNodes[i + 1]) return false;
    for (let i = 0; i < orb.nodes.length; i++) if (orb.nodes[i] !== poseNodes[modelNodeCount + 2 + i]) return false;
    for (let i = 0; i < poseClips.length; i++) {
      const entry = poseClips[i],
        clip = animation.clips[i];
      if (
        clip !== entry.clip ||
        clip.name !== entry.name ||
        clip.duration !== entry.duration ||
        clip.tracks !== entry.tracks ||
        clip.tracks.length !== entry.entries.length
      )
        return false;
      for (let j = 0; j < entry.entries.length; j++) {
        const old = entry.entries[j],
          track = clip.tracks[j];
        if (
          track !== old.track ||
          track.node !== old.node ||
          track.path !== old.path ||
          track.width !== old.width ||
          track.interpolation !== old.interpolation
        )
          return false;
      }
    }
    let mask = 0;
    for (let i = 0; i < poseCheckboxes.length; i++) if (poseCheckboxes[i].checked) mask |= 1 << i;
    out[0] = mask;
    out[1] = +manual;
    out[2] = animator.time;
    out[3] = elapsed;
    out[4] = torsoAim.yaw;
    out[5] = torsoAim.desiredYaw;
    out[6] = targetMotion.position[0];
    out[7] = targetMotion.position[1];
    out[8] = targetMotion.position[2];
    out[9] = +targetMotion.settled;
    out[10] = +controlRoute.active;
    out[11] = +controlRoute.settled;
    out[12] = controlRoute.position[0];
    out[13] = controlRoute.position[1];
    out[14] = controlRoute.position[2];
    out[15] = routeParameter;
    out[16] = routeControl === 'side' ? 1 : routeControl === 'height' ? 2 : routeControl === 'nearFar' ? 3 : 0;
    out[17] = headAim.angle;
    out[18] = headAim.headClearance;
    out[19] = +headAim.clearanceResolved;
    out[20] = acceptedOrbLocal[0];
    out[21] = acceptedOrbLocal[1];
    out[22] = acceptedOrbLocal[2];
    out[23] = +enforced.safe;
    out[24] = +bodyContact;
    out[25] = localGrip[0];
    out[26] = localGrip[1];
    out[27] = localGrip[2];
    out[28] = targetMotion.maxSpeed;
    out[29] = targetMotion.response;
    out[30] = headAim.maxAngle;
    out[31] = torsoAim.maxYaw;
    return true;
  };
  const poseCheckboxes = [
    'ik-enabled',
    'auto-ik',
    'look',
    'idle',
    'moving-light',
    'autopilot',
    'follow',
    'show-rig',
  ].map(checkbox);
  const probePoseReuse = new ProbePoseReuse(poseSnapshot, poseState, readPoseState, () => animator.replayProbePose());
  animator.probeReuse = probePoseReuse;
  teardown.push(() => probePoseReuse.invalidate());

  const routeToControl = (control: ArmControl, parameter: number) => {
    checkbox('autopilot').checked = false;
    routeControl = control;
    routeParameter = parameter;
    controlRoute.request(control, parameter, acceptedOrbLocal);
    mapArmControl(control, parameter, controlPoint);
    moveOrb(gripPosition(meshRuntime(model.root), controlPoint, eventPosition), true);
  };
  for (const [i, axis] of controlAxes.entries()) {
    const input = checkbox('target-' + axis),
      control = armControls[i];
    input.addEventListener('input', () => routeToControl(control, input.valueAsNumber));
    // An inactive track can already display its nearest endpoint. Native range
    // inputs emit nothing for an unchanged value, but selecting it must still
    // choose that complete track rather than leave the previous goal active.
    input.addEventListener('pointerdown', () => routeToControl(control, input.valueAsNumber));
    input.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key !== 'Home' && event.key !== 'End') return;
      event.preventDefault();
      routeToControl(control, event.key === 'Home' ? 0 : 1);
    });
  }
  const resumeControlRoute = () => {
    if (!routeControl || controlRoute.active) return;
    controlRoute.request(routeControl, routeParameter, acceptedOrbLocal);
  };
  checkbox('ik-enabled').addEventListener('change', () => {
    if (checkbox('ik-enabled').checked) resumeControlRoute();
    else controlRoute.release();
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
      if (button.dataset.pose === 'home') routeToControl('side', 0.5);
      else if (button.dataset.pose === 'high') routeToControl('height', 1);
      else moveOrb(add(home, poses[button.dataset.pose!]));
    }),
  );
  $('solve-once').addEventListener('click', () => {
    manual = true;
    checkbox('ik-enabled').checked = true;
    resumeControlRoute();
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
    probePoseReuse.invalidate();
    releaseInteractions();
    for (const id of ['ik-enabled', 'auto-ik', 'look', 'idle', 'moving-light', 'reflections'])
      checkbox(id).checked = true;
    for (const id of ['follow', 'autopilot', 'show-rig']) checkbox(id).checked = false;
    animator.time = 0;
    animator.playing = true;
    elapsed = 0;
    manual = true;
    savedPose = undefined;
    targetMotion.reset(home);
    releaseControlRoute();
    torsoAim.reset();
    bodyIK.reset();
    headAim.reset();
    localPoint(meshRuntime(model.root), keepOrbHeld(), acceptedOrbLocal, targetInverse);
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
  const reflectionPoint: Point = [0, 0, 0],
    bakeOptions = { samples: 256 },
    reflectionMetrics = {
      resolution: probes.resolution,
      cadenceMs: reflectionCadenceMs,
      position: reflectionPosition,
      captures: reflectionCount,
      busy: reflectionBusy,
      encodeMs: probeEncodeMs,
      totalMs: probeTotalMs,
    };
  const publishReflection = () => {
    reflectionMetrics.resolution = probes.resolution;
    reflectionMetrics.cadenceMs = reflectionCadenceMs;
    reflectionMetrics.position = reflectionPosition;
    reflectionMetrics.captures = reflectionCount;
    reflectionMetrics.busy = reflectionBusy;
    reflectionMetrics.encodeMs = probeEncodeMs;
    reflectionMetrics.totalMs = probeTotalMs;
    $('viewport').dataset.reflection = JSON.stringify(reflectionMetrics);
  };
  const finalReflection = () => {
    reflectionFrame = 0;
    void refresh();
  };
  const queueFinalReflection = () => {
    reflectionFinalRequested = true;
    if (!reflectionFrame) reflectionFrame = requestAnimationFrame(finalReflection);
  };
  const refresh = (): Promise<void> | undefined => {
    if (stopped || document.hidden || reflectionBusy) return;
    const enabled = checkbox('reflections').checked;
    if (!enabled) {
      reflectionFinalRequested = false;
      return;
    }
    const now = performance.now();
    const moving =
      drag.dragging ||
      transform.dragging ||
      orbitInteracting ||
      now - lastInteraction < 250 ||
      checkbox('idle').checked ||
      checkbox('moving-light').checked ||
      checkbox('autopilot').checked;
    // Keep the mirror live during interaction. Spread measured capture work over
    // at least four capture durations; a final input update bypasses this delay.
    reflectionCadenceMs = Math.max(moving ? 50 : 250, probeTotalMs * 4);
    if (reflectionCount && now - reflectionLast < 50) return;
    if (!reflectionFinalRequested && reflectionCount && now - reflectionLast < reflectionCadenceMs) return;
    reflectionFinalRequested = false;
    reflectionBusy = true;
    reflectionLast = now;
    return captureReflection();
  };
  const captureReflection = async () => {
    try {
      runtime.store.tick(false);
      reflectionPosition = worldPositionInto(meshRuntime(orb.root), reflectionPoint);
      probes.setReflectionPosition(0, reflectionPosition);
      const started = performance.now();
      gpuAudit.mark('reflection-start');
      probePoseReuse.begin();
      try {
        bakeJob = probes.bake(bakeOptions);
      } finally {
        // bake renders twice before its first await. Async readback and every
        // ordinary zero-delta/manual render remain outside this private scope.
        probePoseReuse.end();
      }
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
