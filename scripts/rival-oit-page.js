// Five unlit panes: Margo's default weighted OIT against Babylon's default depth peeling,
// and both against the sorted path-traced reference in packages/oit/scripts/oit-scene.mjs.
// Babylon is driven from its published types: WebGPUEngine, Scene.useOrderIndependentTransparency,
// DepthPeelingRenderer.passCount (read, not set), FreeCamera, MeshBuilder.CreatePlane, StandardMaterial.
// This file does not read that library's source.
import {
  FreeCamera,
  WebGPUEngine,
  Color3,
  Color4,
  Vector3,
  StandardMaterial,
  Material,
  MeshBuilder,
  Scene,
} from '@babylonjs/core/index.js';
import { Engine } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import { planeGeometry } from '@margoengine/geometry';
import { Material as MargoMaterial, createMesh } from '@margoengine/materials';
import { OIT } from '@margoengine/oit';
import { OIT_SCENE, pictureError, srgbByte, tracePixel } from '../packages/oit/scripts/oit-scene.mjs';
import { waitForPipelines } from './support/gpu-ready.js';

const ROUNDS = 7;
const sceneSpec = OIT_SCENE;

const fail = (error) => {
  window.__rival = {
    error: String(error && error.message ? error.message : error),
    stack: error && error.stack,
  };
};

const canvasOf = () => {
  const canvas = document.createElement('canvas');
  canvas.width = sceneSpec.width;
  canvas.height = sceneSpec.height;
  canvas.style.width = `${sceneSpec.width}px`;
  canvas.style.height = `${sceneSpec.height}px`;
  document.body.append(canvas);
  return canvas;
};

const pixelsOf = async (canvas) => {
  const blob = await (await fetch(canvas.toDataURL('image/png'))).blob();
  const bitmap = await createImageBitmap(blob);
  const out = new OffscreenCanvas(bitmap.width, bitmap.height);
  const g = out.getContext('2d', { willReadFrequently: true });
  g.drawImage(bitmap, 0, 0);
  bitmap.close();
  const data = g.getImageData(0, 0, out.width, out.height).data;
  // Binary source channels are invariant under the per-material display encoding.
  // Both canvases therefore hold linear alpha-compositing values. Apply one common
  // IEC display encoding after readback, outside the measured frames.
  for (let i = 0; i < data.length; i += 4) for (let c = 0; c < 3; c++) data[i + c] = srgbByte(data[i + c] / 255);
  return { width: out.width, height: out.height, data };
};

const layerRow = (error, layers) => error.byLayers.find((row) => row.layers === layers);

try {
  const margoCanvas = canvasOf();
  const engine = await Engine.create(margoCanvas, {
    backend: 'webgpu',
    powerPreference: 'high-performance',
    exactSize: [sceneSpec.width, sceneSpec.height],
    camera: {
      position: sceneSpec.eye,
      target: sceneSpec.target,
      fov: sceneSpec.fov,
      near: sceneSpec.near,
      far: sceneSpec.far,
    },
  });
  engine.stop();
  engine.scene.background = '#000000';
  const device = engineRuntime(engine).gpu;
  const oit = OIT.attach(engine);
  const geometry = planeGeometry(sceneSpec.half * 2, sceneSpec.half * 2);
  for (const pane of sceneSpec.panes) {
    const mesh = createMesh(
      engine,
      geometry,
      new MargoMaterial({
        shading: 'basic',
        color: pane.color,
        opacity: pane.alpha,
        transparent: true,
      }),
    );
    mesh.root.setPosition([0, 0, pane.z]);
    oit.add(mesh);
  }
  const frameMargo = async () => {
    engine.render();
    await device.queue.onSubmittedWorkDone();
  };
  await waitForPipelines(frameMargo, { timeoutMs: 120_000, describe: () => 'margo oit' });

  const rivalCanvas = canvasOf();
  const gpu = new WebGPUEngine(rivalCanvas, { antialias: false, powerPreference: 'high-performance' });
  await gpu.initAsync();
  gpu.setSize(sceneSpec.width, sceneSpec.height);
  const scene = new Scene(gpu);
  scene.clearColor = new Color4(0, 0, 0, 1);
  scene.ambientColor = new Color3(0, 0, 0);
  scene.imageProcessingConfiguration.isEnabled = false;
  scene.imageProcessingConfiguration.toneMappingEnabled = false;
  const camera = new FreeCamera('cam', new Vector3(sceneSpec.eye[0], sceneSpec.eye[1], sceneSpec.eye[2]), scene);
  camera.fov = (sceneSpec.fov * Math.PI) / 180;
  camera.fovMode = 0;
  camera.minZ = sceneSpec.near;
  camera.maxZ = sceneSpec.far;
  camera.setTarget(new Vector3(sceneSpec.target[0], sceneSpec.target[1], sceneSpec.target[2]));
  scene.activeCamera = camera;
  for (const pane of sceneSpec.panes) {
    const mesh = MeshBuilder.CreatePlane(
      `pane-${pane.z}`,
      { width: sceneSpec.half * 2, height: sceneSpec.half * 2 },
      scene,
    );
    mesh.position.z = pane.z;
    const material = new StandardMaterial(`mat-${pane.z}`, scene);
    material.disableLighting = true;
    material.diffuseColor = new Color3(0, 0, 0);
    material.specularColor = new Color3(0, 0, 0);
    material.emissiveColor = new Color3(pane.color[0], pane.color[1], pane.color[2]);
    material.ambientColor = new Color3(0, 0, 0);
    material.alpha = pane.alpha;
    material.transparencyMode = Material.MATERIAL_ALPHABLEND;
    material.backFaceCulling = true;
    mesh.material = material;
  }
  scene.useOrderIndependentTransparency = true;
  const stall = new Uint8Array(4);
  const frameRival = async () => {
    scene.render();
    await gpu.readPixels(0, 0, 1, 1, true, true, stall);
  };
  await scene.whenReadyAsync();
  await waitForPipelines(frameRival, { timeoutMs: 120_000, describe: () => 'babylon oit' });
  const peeling = scene.depthPeelingRenderer;
  if (!peeling) throw new Error('depth peeling renderer was not created');
  const passCount = peeling.passCount;

  const roundsA = [];
  const roundsB = [];
  for (let i = 0; i < 2; i++) {
    await frameMargo();
    await frameRival();
  }
  for (let i = 0; i < ROUNDS; i++) {
    if (i % 2 === 0) {
      const t0 = performance.now();
      await frameMargo();
      roundsA.push(performance.now() - t0);
      const t1 = performance.now();
      await frameRival();
      roundsB.push(performance.now() - t1);
    } else {
      const t1 = performance.now();
      await frameRival();
      roundsB.push(performance.now() - t1);
      const t0 = performance.now();
      await frameMargo();
      roundsA.push(performance.now() - t0);
    }
  }

  await frameMargo();
  await frameRival();
  const margoPic = await pixelsOf(margoCanvas);
  const rivalPic = await pixelsOf(rivalCanvas);
  if (margoPic.width !== sceneSpec.width || margoPic.height !== sceneSpec.height) {
    throw new Error(`margo readback ${margoPic.width}x${margoPic.height}`);
  }
  if (rivalPic.width !== sceneSpec.width || rivalPic.height !== sceneSpec.height) {
    throw new Error(`rival readback ${rivalPic.width}x${rivalPic.height}`);
  }
  const margoError = pictureError(margoPic.data, sceneSpec);
  const rivalError = pictureError(rivalPic.data, sceneSpec);
  const center = tracePixel(sceneSpec, (sceneSpec.width / 2) | 0, (sceneSpec.height / 2) | 0);
  const at = (pic, x, y) => {
    const i = (y * pic.width + x) * 4;
    return [pic.data[i], pic.data[i + 1], pic.data[i + 2]];
  };
  const cx = (sceneSpec.width / 2) | 0;
  const cy = (sceneSpec.height / 2) | 0;
  window.__rival = {
    method: 'weighted',
    rivalMethod: 'dual-depth-peeling',
    passCount,
    useOrderIndependentTransparency: scene.useOrderIndependentTransparency,
    width: sceneSpec.width,
    height: sceneSpec.height,
    roundsA,
    roundsB,
    minA: Math.min(...roundsA),
    minB: Math.min(...roundsB),
    margo: margoError,
    rival: rivalError,
    centerRef: center.rgb,
    centerMargo: at(margoPic, cx, cy),
    centerRival: at(rivalPic, cx, cy),
    cornerMargo: at(margoPic, 0, 0),
    cornerRival: at(rivalPic, 0, 0),
    margoLayer1: layerRow(margoError, 1) ?? null,
    rivalLayer1: layerRow(rivalError, 1) ?? null,
    margoBackground: layerRow(margoError, 0) ?? null,
    rivalBackground: layerRow(rivalError, 0) ?? null,
    drawingBuffer: [gpu.getRenderWidth(), gpu.getRenderHeight()],
  };
} catch (error) {
  fail(error);
}
