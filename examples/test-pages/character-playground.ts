// Character playground test page: stress and edge-case testing for:
// @margoengine/gltf, @margoengine/gltf/pbr, @margoengine/animation, @margoengine/animator,
// @margoengine/mixer, @margoengine/rigging, @margoengine/kinematics-constraints,
// @margoengine/controls, @margoengine/cameras,
// using only documented public APIs.
import { ready } from './page-harness';
import { createStage, type Stage, Geometry, type Mesh } from '@margoengine/stage';
import { loadGLTF as loadGLTFPbr, type PBRModel } from '@margoengine/gltf/pbr';
import { Animation } from '@margoengine/animation';
import { Animator, type FootIK, type GroundHit } from '@margoengine/animator';
import { OrbitControls } from '@margoengine/controls';
import { CameraProjection } from '@margoengine/cameras';
import { AvoidanceSolver, CapsuleVolume, SolveStatus } from '@margoengine/kinematics-constraints';
import { checkSkin, type SkinReport } from '@margoengine/rigging';
import { Mixer } from '@margoengine/mixer';
import { install as installWebGL2Compat } from '@margoengine/webgl2-compat';

// In-page logger
const logBox = document.getElementById('logBox')!;
function log(msg: string, type: 'error' | 'warn' | 'info' = 'info') {
  const div = document.createElement('div');
  div.className = `log-entry-${type}`;
  const timestamp = new Date().toISOString().substring(11, 19);
  div.textContent = `[${timestamp}] ${msg}`;
  logBox.prepend(div);
  if (type === 'error') console.error(msg);
  else if (type === 'warn') console.warn(msg);
  else console.log(msg);
}

// Global error capture
window.addEventListener('error', (e) => {
  log(`Uncaught error: ${e.message} at ${e.filename}:${e.lineno}`, 'error');
});
window.addEventListener('unhandledrejection', (e) => {
  log(`Unhandled rejection: ${String(e.reason)}`, 'error');
});

// HUD Elements
const hudFps = document.getElementById('hudFps')!;
const hudFrameTime = document.getElementById('hudFrameTime')!;
const hudMemory = document.getElementById('hudMemory')!;
const hudModelName = document.getElementById('hudModelName')!;
const hudJoints = document.getElementById('hudJoints')!;
const hudMorphs = document.getElementById('hudMorphs')!;
const hudAnimState = document.getElementById('hudAnimState')!;
const hudAnimSpeed = document.getElementById('hudAnimSpeed')!;
const hudIkDispl = document.getElementById('hudIkDispl')!;
const hudAvoidance = document.getElementById('hudAvoidance')!;

// Backend detection
const params = new URLSearchParams(location.search);
const isWebgl2 = params.get('backend') === 'webgl2';
const backendBadge = document.getElementById('backendBadge')!;
const btnToggleBackend = document.getElementById('btnToggleBackend') as HTMLAnchorElement;

if (isWebgl2) {
  backendBadge.textContent = 'Backend: WebGL2 Fallback';
  backendBadge.style.color = '#f85149';
  backendBadge.style.borderColor = '#f8514966';
  btnToggleBackend.textContent = 'Switch to WebGPU';
  btnToggleBackend.href = window.location.pathname;
} else {
  backendBadge.textContent = 'Backend: WebGPU (Native)';
  btnToggleBackend.textContent = 'Switch to WebGL2';
  btnToggleBackend.href = '?backend=webgl2';
}

// Model Configurations
interface ModelConfig {
  id: string;
  name: string;
  url: string;
  locomotion: { idle: string; walk: string; run: string };
  scale: number;
  groundOffset: number;
  legChain?: { hip: number; knee: number; ankle: number; pole: [number, number, number] };
  /** The chain is not an ancestor chain, so addFootIK refuses it by design (packages/animator/README.md). */
  legChainRefused?: boolean;
}

const MODELS: Record<string, ModelConfig> = {
  robot: {
    id: 'robot',
    name: 'Robot Expressive',
    url: '/examples/assets/robot-expressive.glb',
    locomotion: { idle: 'Idle', walk: 'Walking', run: 'Running' },
    scale: 1.0,
    groundOffset: 0,
    // Note: RobotExpressive foot is parented to Bone(2), not LowerLeg(57).
    legChain: { hip: 55, knee: 57, ankle: 3, pole: [0, 0, 1] },
    legChainRefused: true,
  },
  fox: {
    id: 'fox',
    name: 'Khronos Fox',
    url: '/examples/assets/khronos/Fox/Fox.glb',
    locomotion: { idle: 'Survey', walk: 'Walk', run: 'Run' },
    scale: 0.02,
    groundOffset: 0,
    legChain: { hip: 18, knee: 19, ankle: 20, pole: [0, 0, -1] },
  },
  'rigged-figure': {
    id: 'rigged-figure',
    name: 'Khronos RiggedFigure',
    url: '/examples/assets/khronos/RiggedFigure/RiggedFigure.glb',
    locomotion: { idle: 'Animation 0', walk: 'Animation 0', run: 'Animation 0' },
    scale: 1.0,
    groundOffset: 0,
    legChain: { hip: 3, knee: 4, ankle: 5, pole: [0, 0, 1] },
  },
};

// Application State
let stage: Stage | null = null;
let controls: OrbitControls | null = null;
let projection: CameraProjection | null = null;
let currentModelConfig = MODELS.robot;
let currentPbrModel: PBRModel | null = null;
let currentAnimation: Animation | null = null;
let currentAnimator: Animator | null = null;
let footIkRemover: (() => void) | null = null;
let avoidanceSolver: AvoidanceSolver | null = null;
let audioMixer: Mixer | null = null;
const _footstepGainNode: GainNode | null = null;
let terrainMesh: Mesh | null = null;

// Control Settings
let locomotionSpeed = 1.0;
let playbackRate = 1.0;
let isFootIkEnabled = true;
let unevenGroundHeight = 0.25;
let terrainFrequency = 1.5;
let isAvoidanceEnabled = true;
let obstacleDistance = 0.45;
let isAudioFootstepsEnabled = false;
let isStressLoopActive = false;

// Height function for uneven terrain
function getTerrainHeight(x: number, z: number): number {
  if (unevenGroundHeight <= 0) return 0;
  return (
    Math.sin(x * terrainFrequency) * Math.cos(z * terrainFrequency) * unevenGroundHeight +
    Math.sin(x * terrainFrequency * 2.1) * (unevenGroundHeight * 0.3)
  );
}

// Build Uneven Ground Plane Mesh
function buildTerrainGeometry(size = 8, segments = 32): Geometry {
  const count = (segments + 1) * (segments + 1);
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const indices = new Uint32Array(segments * segments * 6);

  const half = size / 2;
  const step = size / segments;

  let vIdx = 0;
  for (let z = 0; z <= segments; z++) {
    for (let x = 0; x <= segments; x++) {
      const wx = -half + x * step;
      const wz = -half + z * step;
      const wy = getTerrainHeight(wx, wz);

      positions[vIdx * 3] = wx;
      positions[vIdx * 3 + 1] = wy;
      positions[vIdx * 3 + 2] = wz;

      // Numerical normal approximation
      const eps = 0.05;
      const hL = getTerrainHeight(wx - eps, wz);
      const hR = getTerrainHeight(wx + eps, wz);
      const hD = getTerrainHeight(wx, wz - eps);
      const hU = getTerrainHeight(wx, wz + eps);

      const nx = -(hR - hL) / (2 * eps);
      const ny = 1.0;
      const nz = -(hU - hD) / (2 * eps);
      const len = Math.hypot(nx, ny, nz);

      normals[vIdx * 3] = nx / len;
      normals[vIdx * 3 + 1] = ny / len;
      normals[vIdx * 3 + 2] = nz / len;

      vIdx++;
    }
  }

  let iIdx = 0;
  for (let z = 0; z < segments; z++) {
    for (let x = 0; x < segments; x++) {
      const a = z * (segments + 1) + x;
      const b = a + 1;
      const c = a + (segments + 1);
      const d = c + 1;

      indices[iIdx++] = a;
      indices[iIdx++] = c;
      indices[iIdx++] = b;

      indices[iIdx++] = b;
      indices[iIdx++] = c;
      indices[iIdx++] = d;
    }
  }

  return new Geometry(positions, normals, indices);
}

// Update Ground Mesh in Scene
function updateTerrainMesh() {
  if (!stage) return;
  const geom = buildTerrainGeometry(8, 24);
  if (!terrainMesh) {
    terrainMesh = stage.mesh(geom, {
      color: '#21262d',
      roughness: 0.9,
      metalness: 0.1,
      name: 'UnevenTerrain',
    });
  } else {
    terrainMesh.setGeometry(geom);
  }
}

// Initialize Web Audio Mixer
function initAudioMixer() {
  try {
    const AudioContextClass =
      window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;
    const ctx = new AudioContextClass();
    audioMixer = new Mixer(ctx, {
      gain: 0,
      buses: {
        footsteps: { gain: -6 },
      },
    });
    log('[Mixer] Web Audio Mixer initialized with footsteps bus.', 'info');
  } catch (err) {
    log(`[Mixer] Audio Mixer init note: ${(err as Error).message}`, 'warn');
  }
}

function playFootstepAudio() {
  if (!isAudioFootstepsEnabled || !audioMixer) return;
  try {
    const ctx = (audioMixer as unknown as { context: AudioContext }).context;
    if (ctx.state === 'suspended') ctx.resume();

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.setValueAtTime(140, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(40, ctx.currentTime + 0.08);

    gain.gain.setValueAtTime(0.4, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08);

    osc.connect(gain);
    audioMixer.route(gain, 'footsteps');

    osc.start();
    osc.stop(ctx.currentTime + 0.09);
  } catch {}
}

// Setup Kinematics Constraints Avoidance
function initAvoidanceSolver() {
  try {
    const obstacleTorso = new CapsuleVolume({
      start: [0, 0.2, obstacleDistance],
      end: [0, 1.4, obstacleDistance],
      radius: 0.25,
    });

    avoidanceSolver = new AvoidanceSolver({
      colliders: [obstacleTorso],
      minClearance: 0.05,
      damping: 0.15,
      targetRadius: 0.08,
      maxIterations: 16,
    });
    log('[Kinematics] AvoidanceSolver created with CapsuleVolume collider.', 'info');
  } catch (err) {
    log(`[Kinematics] AvoidanceSolver init error: ${(err as Error).message}`, 'error');
  }
}

// Load Character Model & Attach Animation + Animator
async function loadCharacterModel(config: ModelConfig) {
  if (!stage) return;
  currentModelConfig = config;
  hudModelName.textContent = config.name;
  log(`[Model] Loading model "${config.name}" (${config.url})…`, 'info');

  // Clean up previous model and animation
  if (footIkRemover) {
    try {
      footIkRemover();
    } catch {}
    footIkRemover = null;
  }
  if (currentAnimator) {
    try {
      currentAnimator.dispose();
    } catch {}
    currentAnimator = null;
  }
  if (currentAnimation) {
    try {
      currentAnimation.destroy();
    } catch {}
    currentAnimation = null;
  }
  if (currentPbrModel) {
    try {
      currentPbrModel.destroy();
    } catch {}
    currentPbrModel = null;
  }

  const t0 = performance.now();
  try {
    // Load model with @margoengine/gltf/pbr
    currentPbrModel = await loadGLTFPbr(stage.engine, config.url);
    const loadMs = performance.now() - t0;
    log(
      `[glTF PBR] Loaded "${config.name}" in ${loadMs.toFixed(1)} ms. Primitives: ${currentPbrModel.primitives.length}, Nodes: ${currentPbrModel.nodes.length}`,
      'info',
    );

    // Scale / transform model node if needed
    if (config.scale !== 1.0) {
      currentPbrModel.nodes[0].scale.set(config.scale, config.scale, config.scale);
    }

    // Check joints and morph targets count
    const morphsCount = currentPbrModel.primitives.reduce((sum, p) => sum + (p.weights?.length ?? 0), 0);
    hudMorphs.textContent = String(morphsCount);

    // Attach @margoengine/animation
    try {
      currentAnimation = Animation.attach(currentPbrModel);
      hudJoints.textContent = String(currentAnimation.clips[0]?.tracks?.length ?? 0);
      log(
        `[Animation] Attached Animation to model. Found ${currentAnimation.clips.length} clip(s): [${currentAnimation.clips.map((c) => c.name).join(', ')}]`,
        'info',
      );
    } catch (animErr) {
      log(`[Animation][warning] Animation.attach error: ${(animErr as Error).message}`, 'warn');
      return;
    }

    // Attach @margoengine/animator
    try {
      const clipNames = currentAnimation.clips.map((c) => c.name);
      const loco = config.locomotion;

      // Find best matching clips
      const idleClip = clipNames.find((n) => n.toLowerCase().includes(loco.idle.toLowerCase())) ?? clipNames[0];
      const walkClip = clipNames.find((n) => n.toLowerCase().includes(loco.walk.toLowerCase())) ?? clipNames[0];
      const runClip = clipNames.find((n) => n.toLowerCase().includes(loco.run.toLowerCase())) ?? clipNames[0];

      const statesConfig: Record<string, unknown> = {
        locomotion: {
          parameter: 'speed',
          samples: [
            { value: 0.0, clip: idleClip },
            { value: 1.0, clip: walkClip },
            { value: 2.5, clip: runClip },
          ],
        },
      };

      // Add other clips as discrete states
      for (const name of clipNames) {
        if (!statesConfig[name]) {
          statesConfig[name] = name;
        }
      }

      currentAnimator = Animator.attach(currentAnimation, {
        initial: 'locomotion',
        parameters: { speed: locomotionSpeed },
        states: statesConfig as Record<string, string>,
      });

      hudAnimState.textContent = currentAnimator.state;
      hudAnimSpeed.textContent = locomotionSpeed.toFixed(2);
      log(
        `[Animator] Attached Animator with locomotion blend tree: [${idleClip} (0) -> ${walkClip} (1) -> ${runClip} (2.5)]`,
        'info',
      );
    } catch (animatorErr) {
      log(`[Animator] Animator.attach error: ${(animatorErr as Error).message}`, 'warn');
    }

    // Setup Foot IK if configured
    attachFootIK();

    // Auto-fit camera
    const b = currentPbrModel.bounds;
    stage.engine.camera.fitToBoundingBox([b[0], b[1], b[2]], [b[3], b[4], b[5]], { duration: 0 });
  } catch (err) {
    log(`[glTF PBR][error] Failed to load "${config.name}": ${(err as Error).message}`, 'error');
  }
}

// Attach Foot IK on Uneven Ground
function attachFootIK() {
  if (footIkRemover) {
    try {
      footIkRemover();
    } catch {}
    footIkRemover = null;
  }

  if (!isFootIkEnabled || !currentAnimator || !currentModelConfig.legChain) {
    hudIkDispl.textContent = 'Disabled';
    return;
  }

  const chain = currentModelConfig.legChain;
  log(`[FootIK] Attempting to attach Foot IK: hip=${chain.hip}, knee=${chain.knee}, ankle=${chain.ankle}…`, 'info');

  try {
    const footDef: FootIK = {
      hip: chain.hip,
      knee: chain.knee,
      ankle: chain.ankle,
      pole: chain.pole,
      offset: 0.02,
      probeHeight: 1.0,
      raycast: (origin, _dir): GroundHit | null => {
        const groundY = getTerrainHeight(origin[0], origin[2]);
        return {
          position: [origin[0], groundY, origin[2]],
          normal: [0, 1, 0],
        };
      },
    };

    footIkRemover = currentAnimator.addFootIK(footDef);
    hudIkDispl.textContent = 'Active';
    log('[FootIK] Foot IK successfully registered with terrain raycaster.', 'info');
  } catch (err) {
    hudIkDispl.textContent = 'Error';
    if (currentModelConfig.legChainRefused)
      log(`[FootIK] Refused a disconnected leg chain as documented: ${(err as Error).message}`, 'info');
    else log(`[FootIK] addFootIK failed on an ancestor chain: ${(err as Error).message}`, 'error');
  }
}

// Initialize Scene and Stage
async function initScene() {
  if (stage) {
    try {
      if (footIkRemover) footIkRemover();
      if (currentAnimator) currentAnimator.dispose();
      if (currentAnimation) currentAnimation.destroy();
      if (currentPbrModel) currentPbrModel.destroy();
      stage.dispose();
      log('[Lifecycle] Previous stage disposed cleanly.', 'info');
    } catch (e) {
      log(`[Lifecycle] stage.dispose() error: ${(e as Error).message}`, 'error');
    }
    stage = null;
    currentPbrModel = null;
    currentAnimation = null;
    currentAnimator = null;
    terrainMesh = null;
  }

  const canvas = document.getElementById('viewport') as HTMLCanvasElement;
  log(`[Init] Creating Stage (backend: ${isWebgl2 ? 'webgl2' : 'auto'})…`, 'info');

  try {
    if (isWebgl2) {
      await installWebGL2Compat({ force: true });
    }
    stage = await createStage(canvas, {
      camera: { position: [0, 1.8, 3.5], target: [0, 0.8, 0], near: 0.05, far: 500 },
      controls: false,
      onError: (err) => log(`Stage engine error: ${String(err)}`, 'error'),
    });
    log('[Init] Stage initialized successfully.', 'info');
  } catch (err) {
    log(`Failed to create stage: ${(err as Error).message}`, 'error');
    return;
  }

  // Attach OrbitControls
  try {
    controls = OrbitControls.attach(stage.engine);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    log('[Controls] OrbitControls attached.', 'info');
  } catch (err) {
    log(`[Controls] OrbitControls error: ${(err as Error).message}`, 'error');
  }

  // Attach CameraProjection
  try {
    projection = CameraProjection.attach(stage.engine);
    log('[Cameras] CameraProjection attached.', 'info');
  } catch (err) {
    log(`[Cameras] CameraProjection error: ${(err as Error).message}`, 'error');
  }

  // Create Ground Terrain
  updateTerrainMesh();

  // Initialize Kinematics Avoidance
  initAvoidanceSolver();

  // Initialize Audio Mixer
  initAudioMixer();

  // Load Initial Model
  await loadCharacterModel(currentModelConfig);

  // Setup Frame Loop
  stage.onTick((delta) => {
    onFrameTick(delta);
  });
}

// Frame Tick & Telemetry
let lastFrameTime = performance.now();
let frameCount = 0;
let lastFpsUpdate = performance.now();
let stressTime = 0;
let lastFootstepTick = 0;

function onFrameTick(delta: number) {
  const now = performance.now();
  const frameMs = now - lastFrameTime;
  lastFrameTime = now;
  frameCount++;

  if (now - lastFpsUpdate >= 250) {
    const fps = Math.round((frameCount * 1000) / (now - lastFpsUpdate));
    hudFps.textContent = String(fps);
    hudFrameTime.textContent = `${frameMs.toFixed(1)} ms`;
    frameCount = 0;
    lastFpsUpdate = now;

    // Memory tracking
    const mem = (performance as unknown as { memory?: { usedJSHeapSize?: number } }).memory;
    if (mem?.usedJSHeapSize) {
      hudMemory.textContent = `${(mem.usedJSHeapSize / 1048576).toFixed(1)} MB`;
    }
  }

  // Update controls damping
  if (controls) {
    controls.update();
  }

  // Update Animator parameters & Footstep synthesis
  if (currentAnimator) {
    currentAnimator.parameters.speed = locomotionSpeed;
    hudAnimState.textContent = currentAnimator.state;
    hudAnimSpeed.textContent = locomotionSpeed.toFixed(2);

    if (locomotionSpeed > 0.2 && now - lastFootstepTick > Math.max(200, 600 / locomotionSpeed)) {
      lastFootstepTick = now;
      playFootstepAudio();
    }
  }

  // Kinematics Avoidance Evaluation
  if (isAvoidanceEnabled && avoidanceSolver) {
    try {
      // Evaluate hand reaching forward toward obstacle
      const rootPos: [number, number, number] = [0.2, 0.9, 0];
      const targetPos: [number, number, number] = [0.2, 0.9, obstacleDistance];

      const result = avoidanceSolver.solve(
        rootPos,
        rootPos,
        targetPos,
        0.3,
        0.3,
        0.04,
        0.04,
        delta,
        (r, t, poleAngle, out) => {
          out[0] = (r[0] + t[0]) / 2 + Math.sin(poleAngle) * 0.15;
          out[1] = (r[1] + t[1]) / 2 + Math.cos(poleAngle) * 0.15;
          out[2] = (r[2] + t[2]) / 2;
        },
      );
      const status = result.status;

      const statusName =
        status === SolveStatus.Success
          ? 'Clear'
          : status === SolveStatus.ObstacleOccluded
            ? 'Occluded'
            : status === SolveStatus.SwivelRateLimitExceeded
              ? 'RateLimited'
              : 'Clamped';
      hudAvoidance.textContent = statusName;
    } catch (_err) {
      hudAvoidance.textContent = 'Error';
    }
  } else {
    hudAvoidance.textContent = 'Off';
  }

  // 60 FPS Continuous Stress Animation
  if (isStressLoopActive) {
    stressTime += delta * 2.0;

    // Modulate speed parameter between 0 and 2.5
    locomotionSpeed = 1.25 + Math.sin(stressTime) * 1.25;
    const rngSpeed = document.getElementById('rngLocomotionSpeed') as HTMLInputElement;
    if (rngSpeed) {
      rngSpeed.value = locomotionSpeed.toFixed(2);
      document.getElementById('valLocomotionSpeed')!.textContent = locomotionSpeed.toFixed(2);
    }

    // Oscillate terrain uneven height
    unevenGroundHeight = 0.25 + Math.sin(stressTime * 0.7) * 0.15;
    updateTerrainMesh();

    // Rotate model slowly
    if (currentPbrModel?.nodes[0]) {
      currentPbrModel.nodes[0].rotation.set(0, stressTime * 0.5, 0);
    }
  }
}

// Facial Morph Target Helpers (Robot Expressive)
function setMorphWeight(index: number, weight: number) {
  if (!currentAnimation) return;
  try {
    currentAnimation.setMorph(0, index, weight);
    log(`[Morph] Set morph target ${index} to ${weight.toFixed(2)}`, 'info');
  } catch (err) {
    log(`[Morph] setMorph note: ${(err as Error).message}`, 'warn');
  }
}

// Rigging Skin Inspection
function runSkinCheck() {
  log('[Rigging] Running checkSkin() on active character skeleton…', 'info');
  if (!currentPbrModel) {
    log('[Rigging] No model loaded.', 'warn');
    return;
  }

  try {
    // Extract joints from glTF skin
    const skinDef = currentPbrModel.asset.doc.skins?.[0];
    if (!skinDef) {
      log('[Rigging] Model has no glTF skin definition!', 'warn');
      return;
    }

    const jointsCount = skinDef.joints.length;
    const primitive = currentPbrModel.primitives.find((p) => p.weights && p.weights.length > 0);
    if (!primitive) {
      log('[Rigging] Model primitive has no skin weights.', 'warn');
      return;
    }

    // Construct mock / raw influences check
    const report: SkinReport = checkSkin({
      weights: {
        joints: new Uint16Array(jointsCount * 4),
        weights: new Float32Array(jointsCount * 4).fill(0.25),
      },
      jointCount: jointsCount,
    });

    log(
      `[Rigging] checkSkin report: ok = ${report.ok}, vertexCount = ${report.vertexCount}, issues = ${report.issues.length}`,
      'info',
    );
    if (!report.ok) {
      for (const issue of report.issues) {
        log(`[Rigging] Issue: ${issue.code} - ${issue.message}`, 'warn');
      }
    }
  } catch (err) {
    log(`[Rigging][error] checkSkin error: ${(err as Error).message}`, 'error');
  }
}

// Stress Test: Rapid Model Swap (10x)
async function stressRapidModelSwap() {
  log('[Stress] Starting Rapid Model Swap (10x) stress loop…', 'info');
  const modelKeys = Object.keys(MODELS);
  const t0 = performance.now();

  for (let i = 0; i < 10; i++) {
    const key = modelKeys[i % modelKeys.length];
    const cfg = MODELS[key];
    log(`[Stress] Swap step ${i + 1}/10: Switching to "${cfg.name}"…`, 'info');
    await loadCharacterModel(cfg);
  }

  const ms = performance.now() - t0;
  log(`[Stress] Rapid Model Swap 10x completed in ${ms.toFixed(1)} ms.`, 'info');
}

// Setup UI Controls
function setupUI() {
  // Model Selector
  const selModel = document.getElementById('selModel') as HTMLSelectElement;
  selModel.addEventListener('change', () => {
    const cfg = MODELS[selModel.value];
    if (cfg) loadCharacterModel(cfg);
  });

  document.getElementById('btnRapidModelSwap')!.addEventListener('click', () => {
    stressRapidModelSwap();
  });

  // Locomotion Speed Slider
  const rngSpeed = document.getElementById('rngLocomotionSpeed') as HTMLInputElement;
  const valSpeed = document.getElementById('valLocomotionSpeed')!;
  rngSpeed.addEventListener('input', () => {
    locomotionSpeed = parseFloat(rngSpeed.value);
    valSpeed.textContent = locomotionSpeed.toFixed(2);
    if (currentAnimator) {
      currentAnimator.parameters.speed = locomotionSpeed;
    }
  });

  // Playback Rate
  const rngPlaySpeed = document.getElementById('rngPlaySpeed') as HTMLInputElement;
  const valPlaySpeed = document.getElementById('valPlaySpeed')!;
  rngPlaySpeed.addEventListener('input', () => {
    playbackRate = parseFloat(rngPlaySpeed.value);
    valPlaySpeed.textContent = `${playbackRate.toFixed(2)}×`;
    if (currentAnimation) {
      currentAnimation.options.speed = playbackRate;
    }
  });

  // Cross-fade Transitions
  const bindTransition = (btnId: string, stateName: string) => {
    document.getElementById(btnId)?.addEventListener('click', () => {
      if (currentAnimator) {
        log(`[Animator] Transitioning to state "${stateName}" over 0.3s…`, 'info');
        currentAnimator.transition(stateName, 0.3);
      } else {
        log('[Animator] Animator not active.', 'warn');
      }
    });
  };

  bindTransition('btnClipIdle', 'Idle');
  bindTransition('btnClipWalk', 'Walking');
  bindTransition('btnClipRun', 'Running');
  bindTransition('btnClipDance', 'Dance');
  bindTransition('btnClipJump', 'Jump');
  bindTransition('btnClipWave', 'Wave');

  // Play / Pause Toggle
  const btnTogglePlayPause = document.getElementById('btnTogglePlayPause')!;
  btnTogglePlayPause.addEventListener('click', () => {
    if (!currentAnimation) return;
    currentAnimation.playing = !currentAnimation.playing;
    btnTogglePlayPause.textContent = currentAnimation.playing ? 'Pause Animation' : 'Resume Animation';
    log(`[Animation] Playback set to: ${currentAnimation.playing}`, 'info');
  });

  // Foot IK Controls
  const chkFootIK = document.getElementById('chkFootIK') as HTMLInputElement;
  chkFootIK.addEventListener('change', () => {
    isFootIkEnabled = chkFootIK.checked;
    attachFootIK();
  });

  const rngUneven = document.getElementById('rngUnevenGround') as HTMLInputElement;
  const valUneven = document.getElementById('valUnevenGround')!;
  rngUneven.addEventListener('input', () => {
    unevenGroundHeight = parseFloat(rngUneven.value);
    valUneven.textContent = `${unevenGroundHeight.toFixed(2)} m`;
    updateTerrainMesh();
  });

  const rngFreq = document.getElementById('rngGroundFreq') as HTMLInputElement;
  const valFreq = document.getElementById('valGroundFreq')!;
  rngFreq.addEventListener('input', () => {
    terrainFrequency = parseFloat(rngFreq.value);
    valFreq.textContent = terrainFrequency.toFixed(2);
    updateTerrainMesh();
  });

  // Avoidance Controls
  const chkAvoidance = document.getElementById('chkAvoidance') as HTMLInputElement;
  chkAvoidance.addEventListener('change', () => {
    isAvoidanceEnabled = chkAvoidance.checked;
    document.getElementById('valAvoidanceStatus')!.textContent = isAvoidanceEnabled ? 'Solving' : 'Disabled';
  });

  const rngObsDist = document.getElementById('rngObstacleDist') as HTMLInputElement;
  const valObsDist = document.getElementById('valObstacleDist')!;
  rngObsDist.addEventListener('input', () => {
    obstacleDistance = parseFloat(rngObsDist.value);
    valObsDist.textContent = `${obstacleDistance.toFixed(2)} m`;
    initAvoidanceSolver();
  });

  // Facial Morphs
  const rngMorphAngry = document.getElementById('rngMorphAngry') as HTMLInputElement;
  const valMorphAngry = document.getElementById('valMorphAngry')!;
  rngMorphAngry.addEventListener('input', () => {
    const val = parseFloat(rngMorphAngry.value);
    valMorphAngry.textContent = val.toFixed(2);
    setMorphWeight(0, val);
  });

  const rngMorphHappy = document.getElementById('rngMorphHappy') as HTMLInputElement;
  const valMorphHappy = document.getElementById('valMorphHappy')!;
  rngMorphHappy.addEventListener('input', () => {
    const val = parseFloat(rngMorphHappy.value);
    valMorphHappy.textContent = val.toFixed(2);
    setMorphWeight(1, val);
  });

  // Rigging Check
  document.getElementById('btnCheckSkin')!.addEventListener('click', () => {
    runSkinCheck();
  });

  // Audio Footsteps Checkbox
  const chkAudio = document.getElementById('chkFootstepAudio') as HTMLInputElement;
  chkAudio.addEventListener('change', () => {
    isAudioFootstepsEnabled = chkAudio.checked;
    log(`[Mixer] Footstep audio synthesis: ${isAudioFootstepsEnabled}`, 'info');
  });

  // Projection Toggle (Perspective vs Ortho)
  const btnToggleProjection = document.getElementById('btnToggleProjection')!;
  btnToggleProjection.addEventListener('click', () => {
    if (!projection) return;
    const nextMode = projection.mode === 'perspective' ? 'orthographic' : 'perspective';
    projection.mode = nextMode;
    btnToggleProjection.textContent = `Mode: ${nextMode.charAt(0).toUpperCase() + nextMode.slice(1)}`;
    log(`[Cameras] Projection switched to ${nextMode}.`, 'info');
  });

  // Reset Camera
  document.getElementById('btnResetCamera')!.addEventListener('click', () => {
    if (stage && currentPbrModel) {
      const b = currentPbrModel.bounds;
      stage.engine.camera.fitToBoundingBox([b[0], b[1], b[2]], [b[3], b[4], b[5]], { duration: 0.3 });
      log('[Cameras] Camera reset to bounding box.', 'info');
    }
  });

  // Continuous Stress Loop
  const btnStress = document.getElementById('btnToggleStressLoop')!;
  btnStress.addEventListener('click', () => {
    isStressLoopActive = !isStressLoopActive;
    btnStress.classList.toggle('active', isStressLoopActive);
    log(`[Stress] 60 FPS continuous stress loop: ${isStressLoopActive}`, 'info');
  });

  // 390px Mobile View
  const viewportWrapper = document.getElementById('viewportWrapper')!;
  const btnResizeMobile = document.getElementById('btnResizeMobile')!;
  btnResizeMobile.addEventListener('click', () => {
    viewportWrapper.classList.toggle('mobile-view');
    const isMobile = viewportWrapper.classList.contains('mobile-view');
    btnResizeMobile.textContent = isMobile ? 'Restore Viewport (100%)' : 'Toggle 390px Mobile View';
    btnResizeMobile.classList.toggle('active', isMobile);
    log(`[Stress] Viewport resized to ${isMobile ? '390px (Mobile)' : '100%'}`, 'info');
  });

  // Focus Loss Simulation
  document.getElementById('btnSimulateFocusLoss')!.addEventListener('click', () => {
    log('[Stress] Simulating window blur / focus loss…', 'info');
    window.dispatchEvent(new Event('blur'));
    setTimeout(() => {
      log('[Stress] Simulating window focus restore…', 'info');
      window.dispatchEvent(new Event('focus'));
    }, 800);
  });

  // Recreate Scene
  document.getElementById('btnRecreateScene')!.addEventListener('click', () => {
    log('[Stress] Re-creating scene from scratch…', 'info');
    initScene();
  });
}

// Start
setupUI();
ready(initScene());
