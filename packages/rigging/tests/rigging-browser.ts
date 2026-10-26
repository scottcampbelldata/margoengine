// Real-GPU fixture for @margoengine/rigging: meshes weighted, posed and checked by this package, deformed by
// @margoengine/animation's GPU skinning and drawn by the engine. Built imports, so it exercises the published package
// boundary. tests/rigging-browser.mjs drives it and checks the numbers.
import { Engine } from '../../core/dist/extension.js';
import { UnlitMaterial, createMesh } from '../../materials/dist/index.js';
import type { MeshGeometry } from '../../materials/dist/index.js';
import { PostStack } from '../../post/dist/index.js';
import { Tonemap } from '../../tonemap/dist/index.js';
import { Skeleton, Skin } from '../../animation/dist/index.js';
import { boneHeatWeights, checkSkin, type RigJoint } from '../dist/index.js';
import { solveSkeletonIK } from '../dist/ik.js';
import { tube } from './fixtures.js';

declare const GPUBufferUsage: { COPY_DST: number; MAP_READ: number };
declare const GPUMapMode: { READ: number };

const W = 320,
  H = 240,
  canvas = document.querySelector('canvas')!,
  engine = await Engine.create(canvas, { backend: 'webgpu', camera: { position: [0, 0, 3], target: [0, 0, 0] } }),
  errors: string[] = [],
  disposers: (() => void)[] = [];
engine.stop();
// x in [-2, 2] and y in [-1.5, 1.5] fill the canvas (80 pixels per unit), reverse-Z orthographic.
engine.camera.project = (out) => {
  out.fill(0);
  out[0] = 0.5;
  out[5] = 2 / 3;
  out[10] = 1 / 99.9;
  out[14] = 100 / 99.9;
  out[15] = 1;
};
engine.onError = (error) => errors.push(String(error));
const device = engine.gpu!;
device.addEventListener('uncapturederror', (event) => errors.push((event as GPUUncapturedErrorEvent).error.message));
const stack = PostStack.attach(engine, [new Tonemap({ curve: 'neutral' })]);

async function frame(): Promise<void> {
  device.pushErrorScope('validation');
  try {
    engine.render();
    await device.queue.onSubmittedWorkDone();
  } finally {
    const error = await device.popErrorScope();
    if (error) errors.push(error.message);
  }
}
const half = (word: number) => {
  const exponent = (word >> 10) & 31,
    mantissa = word & 1023,
    value = exponent ? 2 ** (exponent - 15) * (1 + mantissa / 1024) : (2 ** -14 * mantissa) / 1024;
  return word & 32768 ? -value : value;
};
/** The HDR scene (linear, before the tone map) as RGBA floats. */
async function read(): Promise<Float32Array> {
  await frame();
  await frame();
  const buffer = device.createBuffer({ size: W * H * 8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  try {
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture: stack.sceneTexture! }, { buffer, bytesPerRow: W * 8 }, [W, H]);
    device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    return Float32Array.from(new Uint16Array(buffer.getMappedRange()), half);
  } finally {
    buffer.unmap();
    buffer.destroy();
  }
}
/** Whether the white mesh covers the pixel at world (x, y) (red channel above half; the background is dark). */
const covered = (img: Float32Array, x: number, y: number) => {
  const px = Math.floor((x + 2) * 80),
    py = Math.floor((1.5 - y) * 80);
  return px >= 0 && px < W && py >= 0 && py < H && img[(py * W + px) * 4] > 0.5;
};
function clear() {
  for (const dispose of disposers.splice(0).reverse()) dispose();
}
/** Render geometry for a test mesh: radial normals around the y axis (caps face up and down). */
function geometry(mesh: { positions: Float32Array; indices: Uint32Array }): MeshGeometry {
  const p = mesh.positions,
    normals = new Float32Array(p.length);
  for (let i = 0; i < p.length / 3; i++) {
    const x = p[i * 3],
      z = p[i * 3 + 2],
      r = Math.hypot(x, z);
    if (r > 1e-6) normals.set([x / r, 0, z / r], i * 3);
    else normals.set([0, p[i * 3 + 1] > 0 ? 1 : -1, 0], i * 3);
  }
  return { positions: p, normals, indices: mesh.indices };
}
/** A Skeleton whose bind pose puts each joint at its rest position (no rotations). */
const skeletonOf = (joints: readonly RigJoint[]) =>
  new Skeleton(
    joints.map((joint) => {
      const p = joint.parent < 0 ? [0, 0, 0] : joints[joint.parent].position;
      return {
        name: joint.name,
        parent: joint.parent,
        translation: [0, 1, 2].map((c) => joint.position[c] - p[c]) as [number, number, number],
      };
    }),
  );

const fixture = {
  /**
   * A tube weighted by bone heat, bent 90 degrees at its middle joint by GPU skinning: the drawn silhouette matches
   * the CPU pose of the same weights, and the weights pass the export checks.
   */
  async weights() {
    const mesh = tube({ radius: 0.15, y0: -1, y1: 1, rings: 24, sides: 16 }),
      joints: RigJoint[] = [
        { name: 'base', parent: -1, position: [0, -1, 0] },
        { name: 'middle', parent: 0, position: [0, 0, 0] },
        { name: 'tip', parent: 1, position: [0, 1, 0] },
      ],
      started = performance.now(),
      weights = await boneHeatWeights(mesh, joints),
      solveMs = performance.now() - started,
      influences = weights.toInfluences(4),
      report = checkSkin({ weights: influences, joints }),
      model = createMesh(engine, geometry(mesh), new UnlitMaterial({ color: [1, 1, 1] })),
      skeleton = skeletonOf(joints),
      skin = Skin.attach(model, skeleton, influences.joints, influences.weights);
    disposers.push(
      () => model.destroy(),
      () => skin.dispose(),
    );
    const straight = await read(),
      s = Math.SQRT1_2;
    skeleton.setPose(1, { rotation: [0, 0, -s, s] });
    const bent = await read(),
      posed = skin.pose(mesh.positions).positions;
    // Triangle centroids of the CPU-posed mesh: each must be drawn by the GPU-skinned mesh.
    let inside = 0,
      total = 0;
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const c = [0, 1, 2].map(
        (k) =>
          (posed[mesh.indices[t] * 3 + k] + posed[mesh.indices[t + 1] * 3 + k] + posed[mesh.indices[t + 2] * 3 + k]) /
          3,
      );
      if (c[2] < 0.1) continue; // only faces toward the camera, not the silhouette seen edge-on
      total++;
      if (covered(bent, c[0], c[1])) inside++;
    }
    const result = {
      solveMs,
      report,
      straightTip: covered(straight, 0, 0.8),
      straightSide: covered(straight, 0.8, 0),
      bentTip: covered(bent, 0, 0.8),
      bentSide: covered(bent, 0.8, 0),
      base: covered(bent, 0, -0.8),
      inside,
      total,
    };
    clear();
    return result;
  },
  /**
   * The same weighted tube posed by solveSkeletonIK so its tip reaches a target off to the side, bending toward a
   * pole: the GPU-skinned tip is drawn at the target and the drawn mesh matches the CPU pose.
   */
  async ik() {
    const mesh = tube({ radius: 0.12, y0: -1, y1: 1, rings: 24, sides: 16 }),
      joints: RigJoint[] = [
        { name: 'base', parent: -1, position: [0, -1, 0] },
        { name: 'middle', parent: 0, position: [0, 0, 0] },
        { name: 'tip', parent: 1, position: [0, 1, 0] },
      ],
      influences = (await boneHeatWeights(mesh, joints)).toInfluences(4),
      model = createMesh(engine, geometry(mesh), new UnlitMaterial({ color: [1, 1, 1] })),
      skeleton = skeletonOf(joints),
      skin = Skin.attach(model, skeleton, influences.joints, influences.weights);
    disposers.push(
      () => model.destroy(),
      () => skin.dispose(),
    );
    const target: [number, number, number] = [0.9, -0.4, 0],
      solved = solveSkeletonIK(skeleton, { joints: ['base', 'middle', 'tip'], target, pole: [-1, 0.5, 0] }),
      m = skeleton.matrices,
      tip = [m[32 + 12], m[32 + 13], m[32 + 14]],
      elbow = [m[16 + 12], m[16 + 13], m[16 + 14]],
      image = await read(),
      posed = skin.pose(mesh.positions).positions;
    let inside = 0,
      total = 0;
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const c = [0, 1, 2].map(
        (k) =>
          (posed[mesh.indices[t] * 3 + k] + posed[mesh.indices[t + 1] * 3 + k] + posed[mesh.indices[t + 2] * 3 + k]) /
          3,
      );
      if (c[2] < 0.08) continue; // only faces toward the camera
      total++;
      if (covered(image, c[0], c[1])) inside++;
    }
    const result = {
      reached: solved.reached,
      tip,
      elbow,
      // 0.08 back from the tip along the forearm (toward the elbow): drawn.
      drawnNearTarget: (() => {
        const d = Math.hypot(elbow[0] - tip[0], elbow[1] - tip[1]);
        return covered(image, tip[0] + ((elbow[0] - tip[0]) / d) * 0.08, tip[1] + ((elbow[1] - tip[1]) / d) * 0.08);
      })(),
      straightTipDrawn: covered(image, 0, 0.9),
      inside,
      total,
    };
    clear();
    return result;
  },
};

declare global {
  interface Window {
    riggingFixture: { run(name: keyof typeof fixture): Promise<{ result: unknown; errors: string[] }> };
  }
}
window.riggingFixture = {
  async run(name) {
    errors.length = 0;
    const result = await fixture[name]();
    return { result, errors: errors.slice() };
  },
};
