import { createStage } from 'margoengine';
import type { Mesh } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import { applyQualityTier, paceEngine, watchQuality } from '@margoengine/quality';
import { parseGLTF } from '@margoengine/gltf-pro';
import { Animation } from '@margoengine/animation';
import { DragControls, OrbitControls } from '@margoengine/controls';
import { Animator, addCCDChain, type CCDChain, type CCDJointLimit, type CCDResult } from '../dist/index.js';
import { submitPrincipalScene, type PrincipalSceneReadiness } from '../../shared/demo-frame.js';
declare global {
  interface Window {
    animatorDemo?: {
      stage: Awaited<ReturnType<typeof createStage>>;
      animator: Animator;
      chain: CCDChain;
      marker: Mesh;
      last: CCDResult;
      readiness: PrincipalSceneReadiness;
      principalObjects: number;
    };
  }
}

const JOINTS = 10,
  SEGMENT = 0.24,
  BASE = 0.12;

// A skinned tentacle as glTF: JOINTS joints up +Y, SEGMENT apart, a tapered tube whose vertices blend between the two
// joints around them, and a 'Sway' clip that rolls a wave up the chain.
function tentacle(): { doc: object; buffers: ArrayBufferView[] } {
  const height = JOINTS * SEGMENT,
    rings = JOINTS * 4 + 1,
    around = 20,
    positions: number[] = [],
    normals: number[] = [],
    joints: number[] = [],
    weights: number[] = [],
    indices: number[] = [];
  const skin = (y: number) => {
    // Weight 1 at each bone's middle, half and half at the joints between bones.
    const s = Math.min(JOINTS - 1, Math.max(0, y / SEGMENT - 0.5)),
      k = Math.min(JOINTS - 2, Math.floor(s)),
      f = s - k;
    joints.push(k, k + 1, 0, 0);
    weights.push(1 - f, f, 0, 0);
  };
  for (let r = 0; r < rings; r++) {
    const y = (height * r) / (rings - 1),
      radius = 0.025 + 0.15 * (1 - y / height);
    for (let a = 0; a < around; a++) {
      const angle = (2 * Math.PI * a) / around,
        c = Math.cos(angle),
        s = Math.sin(angle),
        l = Math.hypot(1, 0.15 / height);
      positions.push(c * radius, y, s * radius);
      normals.push(c / l, 0.15 / height / l, s / l);
      skin(y);
    }
  }
  for (let r = 0; r < rings - 1; r++)
    for (let a = 0; a < around; a++) {
      const i = r * around + a,
        j = r * around + ((a + 1) % around);
      indices.push(i, i + around, j, j, i + around, j + around);
    }
  // Rounded tip: one vertex above the last ring.
  const tip = positions.length / 3;
  positions.push(0, height + 0.025, 0);
  normals.push(0, 1, 0);
  skin(height);
  for (let a = 0; a < around; a++) {
    const top = (rings - 1) * around;
    indices.push(top + a, tip, top + ((a + 1) % around));
  }
  const inverseBind: number[] = [];
  for (let i = 0; i < JOINTS; i++) inverseBind.push(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -i * SEGMENT, 0, 1);
  const frames = 9,
    times: number[] = [],
    period = 2.4;
  for (let k = 0; k < frames; k++) times.push((period * k) / (frames - 1));
  const buffers: ArrayBufferView[] = [],
    bufferViews: object[] = [],
    accessors: object[] = [];
  const add = (data: ArrayBufferView & { length: number }, type: string, componentType = 5126, extra = {}) => {
    buffers.push(data);
    bufferViews.push({ buffer: buffers.length - 1, byteLength: data.byteLength });
    accessors.push({
      bufferView: bufferViews.length - 1,
      componentType,
      count: data.length / { SCALAR: 1, VEC3: 3, VEC4: 4, MAT4: 16 }[type]!,
      type,
      ...extra,
    });
    return accessors.length - 1;
  };
  const position = add(new Float32Array(positions), 'VEC3', 5126, {
      min: [-0.18, 0, -0.18],
      max: [0.18, height + 0.025, 0.18],
    }),
    normal = add(new Float32Array(normals), 'VEC3'),
    joint = add(new Uint16Array(joints), 'VEC4', 5123),
    weight = add(new Float32Array(weights), 'VEC4'),
    index = add(new Uint32Array(indices), 'SCALAR', 5125),
    ibm = add(new Float32Array(inverseBind), 'MAT4'),
    input = add(new Float32Array(times), 'SCALAR', 5126, { min: [0], max: [period] });
  const channels: object[] = [],
    samplers: object[] = [];
  for (let i = 0; i < JOINTS; i++) {
    const keys: number[] = [];
    for (const t of times) {
      // A wave rolling up the chain: a little sway about z, less about x.
      const phase = (2 * Math.PI * t) / period - i * 0.55,
        az = 0.11 * Math.sin(phase),
        ax = 0.05 * Math.cos(phase),
        l = Math.hypot(ax, az) || 1,
        angle = Math.hypot(ax, az),
        s = Math.sin(angle / 2);
      keys.push((ax / l) * s, 0, (az / l) * s, Math.cos(angle / 2));
    }
    samplers.push({ input, output: add(new Float32Array(keys), 'VEC4'), interpolation: 'LINEAR' });
    channels.push({ sampler: samplers.length - 1, target: { node: i + 1, path: 'rotation' } });
  }
  const nodes: object[] = [{ name: 'Tentacle', mesh: 0, skin: 0 }];
  for (let i = 0; i < JOINTS; i++)
    nodes.push({
      name: `Joint ${i}`,
      translation: [0, i ? SEGMENT : 0, 0],
      ...(i < JOINTS - 1 ? { children: [i + 2] } : {}),
    });
  const doc = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0, 1] }],
    buffers: buffers.map((data) => ({ byteLength: data.byteLength })),
    bufferViews,
    accessors,
    materials: [
      { pbrMetallicRoughness: { baseColorFactor: [0.2, 0.62, 0.55, 1], metallicFactor: 0, roughnessFactor: 0.45 } },
    ],
    meshes: [
      {
        primitives: [
          {
            attributes: { POSITION: position, NORMAL: normal, JOINTS_0: joint, WEIGHTS_0: weight },
            indices: index,
            material: 0,
          },
        ],
      },
    ],
    nodes,
    skins: [{ joints: Array.from({ length: JOINTS }, (_, i) => i + 1), inverseBindMatrices: ibm }],
    animations: [{ name: 'Sway', channels, samplers }],
  };
  return { doc, buffers };
}

// Before the stage exists: core reads the tier when it builds pipelines and sizes the canvas.
applyQualityTier();
const $ = <T extends HTMLElement>(id: string) => document.querySelector<T>(`#${id}`)!;
const status = $<HTMLParagraphElement>('status'),
  solveLine = $<HTMLParagraphElement>('solve');
const life = new AbortController();
let dispose = () => {};
window.addEventListener(
  'pagehide',
  () => {
    life.abort();
    dispose();
  },
  { once: true },
);
try {
  const stage = await createStage('#viewport', {
    backend: 'webgpu',
    controls: false,
    autoStart: false,
    label: 'A skinned tentacle on a pedestal reaching for an orange target sphere',
    camera: { position: [2.6, 1.9, 3.6], target: [0, 1.25, 0], fov: 45 },
    onError: (error) => {
      if (!life.signal.aborted) status.textContent = String(error);
    },
  });
  dispose = () => stage.dispose();
  if (life.signal.aborted) {
    dispose();
    life.signal.throwIfAborted();
  }
  paceEngine(stage.engine);
  stage.box({ size: [7, 0.1, 7], position: [0, -0.05, 0], color: [0.08, 0.1, 0.15], roughness: 0.9 });
  stage.box({ size: [0.62, BASE, 0.62], position: [0, BASE / 2, 0], color: [0.3, 0.32, 0.38], roughness: 0.5 });
  const { doc, buffers } = tentacle(),
    model = parseGLTF(stage.engine, doc, buffers);
  model.root.setPosition([0, BASE, 0]);
  const animation = Animation.attach(model),
    animator = Animator.attach(animation, { initial: 'sway', states: { sway: 'Sway' } });
  const marker = stage.sphere({ radius: 0.09, segments: 24, position: [1.2, 1.6, 0.6], color: [1, 0.5, 0.08] });
  const drag = DragControls.attach(stage.engine, [marker]),
    orbit = OrbitControls.attach(stage.engine);
  orbit.enableDamping = true;
  orbit.minDistance = 1.5;
  orbit.maxDistance = 9;
  orbit.maxPolarAngle = Math.PI * 0.49;
  // Cones: the base may lean 1.3 rad from upright, every other joint swing 0.5 rad from its rest direction, each with a
  // small twist range.
  const cones: CCDJointLimit[] = Array.from({ length: JOINTS }, (_, i) => ({
    type: 'cone',
    angle: i ? 0.5 : 1.3,
    twist: [-0.4, 0.4],
  }));
  let last: CCDResult = { iterations: 0, distance: 0, angle: 0, reached: false };
  const chain: CCDChain = {
    joints: Array.from({ length: JOINTS }, (_, i) => i + 1),
    target: [1.2, 1.6, 0.6],
    tip: [0, SEGMENT, 0],
    limits: cones,
    iterations: 16,
    onSolve: (result) => {
      last = result;
    },
  };
  let remove = addCCDChain(animator, chain);
  const reach = $<HTMLInputElement>('reach'),
    limits = $<HTMLInputElement>('limits'),
    sway = $<HTMLInputElement>('sway'),
    wander = $<HTMLInputElement>('wander'),
    iterations = $<HTMLInputElement>('iterations'),
    weight = $<HTMLInputElement>('weight'),
    on = { signal: life.signal };
  // Under prefers-reduced-motion (and so in the visual checks' still frame) the clip and the target start held still;
  // both boxes turn them on.
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    sway.checked = wander.checked = false;
    animator.playing = false;
  }
  reach.addEventListener('change', () => (chain.reach = reach.checked), on);
  limits.addEventListener(
    'change',
    () => {
      // Limits are validated and copied when a chain is added: swap the chain.
      remove();
      chain.limits = limits.checked ? cones : undefined;
      remove = addCCDChain(animator, chain);
    },
    on,
  );
  sway.addEventListener('change', () => (animator.playing = sway.checked), on);
  iterations.addEventListener(
    'input',
    () => {
      chain.iterations = iterations.valueAsNumber;
      $<HTMLOutputElement>('iterations-value').value = iterations.value;
    },
    on,
  );
  weight.addEventListener(
    'input',
    () => {
      chain.weight = weight.valueAsNumber;
      $<HTMLOutputElement>('weight-value').value = weight.value;
    },
    on,
  );
  // Wandering target: around the tentacle, from close in to just past its 2.4 m reach.
  let time = 0,
    frames = 0;
  const target = chain.target as [number, number, number];
  stage.onTick((delta) => {
    time += delta;
    if (wander.checked && !drag.dragging) {
      const angle = 0.45 * time,
        radius = 1.15 + 0.75 * Math.sin(0.31 * time);
      marker.setPosition([radius * Math.cos(angle), 1.35 + 0.95 * Math.sin(0.53 * time), radius * Math.sin(angle)]);
    }
    target[0] = marker.position.x;
    target[1] = marker.position.y;
    target[2] = marker.position.z;
    if (++frames % 10 === 0) {
      const root = Math.hypot(target[0], target[1] - BASE, target[2]);
      solveLine.textContent =
        `${last.iterations} sweep${last.iterations === 1 ? '' : 's'} · ` +
        `${(last.distance * 1000).toFixed(1)} mm from the target · ` +
        (last.reached ? 'reached' : root > JOINTS * SEGMENT ? 'out of reach: stretched toward it' : 'not reached');
    }
  });
  const readiness = await submitPrincipalScene(() => stage.engine.render(), engineRuntime(stage.engine).gpu!.queue, {
    signal: life.signal,
  });
  life.signal.throwIfAborted();
  window.animatorDemo = {
    stage,
    animator,
    chain,
    marker,
    get last() {
      return last;
    },
    readiness,
    principalObjects: 4,
  };
  stage.engine.start();
  watchQuality();
  status.textContent = 'WebGPU ready · drag the orange target';
} catch (error) {
  dispose();
  if (!life.signal.aborted) status.textContent = `Unable to start: ${String(error)}`;
}
