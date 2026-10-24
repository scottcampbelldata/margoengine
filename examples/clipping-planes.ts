// Clipping planes demo: five materials meshes, each material with its own clipping planes (materials
// `clippingPlanes`), cut open where the planes pass; the cut shows in their directional shadows too. The planes sweep
// up and down (held still under prefers-reduced-motion, which the visual check uses).
import { createStage } from 'margoengine';
import { boxGeometry, sphereGeometry, torusKnotGeometry, cylinderGeometry, torusGeometry } from '@margoengine/geometry';
import {
  Material,
  LambertMaterial,
  ToonMaterial,
  UnlitMaterial,
  NormalMaterial,
  createMesh,
} from '@margoengine/materials';
import { Shadows } from '@margoengine/shadows';
import { Lines, Line, LineMaterial } from '@margoengine/lines';
import { PointsPlugin, PointCloud } from '@margoengine/points';
import { engineRuntime } from '@margoengine/core/extension';
import { still } from './multi-view.js';

declare global {
  interface Window {
    clippingDemo?: { materials: Material[]; line: LineMaterial; cloud: { material: { clippingPlanes: number[][] } } };
  }
}

const status = document.querySelector<HTMLParagraphElement>('#status')!,
  canvas = document.querySelector<HTMLCanvasElement>('#viewport')!;
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
  const stage = await createStage(canvas, {
    backend: 'webgpu',
    camera: { position: [0, 5.5, 11], target: [0, 0.8, 0] },
    onError: (error) => {
      if (!life.signal.aborted) status.textContent = String(error);
    },
  });
  dispose = () => stage.dispose();
  life.signal.throwIfAborted();
  const engine = stage.engine;
  engineRuntime(engine).lighting.direction.set([-3, 7, 4, 3.2]);
  const floor = stage.box({ size: [16, 0.2, 10], position: [0, -0.1, 0], color: '#56647a', roughness: 0.9 });
  const shadows = Shadows.attach(engine, { resolution: 2048, distance: 30 });
  shadows.add(floor, { static: true });
  // Each shape with its material and the planes that cut it ([a, b, c, d]: a x + b y + c z + d < 0 is cut away).
  const items = [
    {
      geometry: torusKnotGeometry(0.8, 0.28, 160, 20),
      material: new Material({ color: '#e0a040', roughness: 0.35, metalness: 0.6, doubleSided: true }),
      x: -5.6,
    },
    {
      geometry: sphereGeometry(1, 48, 24),
      material: new LambertMaterial({ color: '#58b0e0', doubleSided: true }),
      x: -2.8,
    },
    { geometry: boxGeometry(1.6, 1.6, 1.6), material: new ToonMaterial({ color: '#e06a8c', doubleSided: true }), x: 0 },
    {
      geometry: cylinderGeometry(0.8, 0.8, 1.8, 48),
      material: new UnlitMaterial({ color: '#8fd47a', doubleSided: true }),
      x: 2.8,
    },
    { geometry: torusGeometry(0.85, 0.32, 24, 64), material: new NormalMaterial({ doubleSided: true }), x: 5.6 },
  ];
  const materials: Material[] = [];
  for (const { geometry, material, x } of items) {
    const mesh = createMesh(engine, geometry, material);
    mesh.root.setPosition([x, 1.2, 0]);
    shadows.add(mesh);
    materials.push(material);
  }
  // A helix of fat line and a sphere of points behind the shapes, each with its own plane.
  const helix: number[] = [];
  for (let k = 0; k <= 240; k++) {
    const a = (k / 240) * Math.PI * 10;
    helix.push(-3 + Math.cos(a) * 0.8, 0.2 + (k / 240) * 2.6, -3 + Math.sin(a) * 0.8);
  }
  const lineMaterial = new LineMaterial({ width: 4, color: '#ffd166' });
  Lines.attach(engine).add(new Line({ positions: helix, material: lineMaterial }));
  const dots = new Float32Array(3 * 1500);
  for (let k = 0; k < 1500; k++) {
    const y = 1 - (2 * (k + 0.5)) / 1500,
      r = Math.sqrt(1 - y * y),
      a = k * 2.399963;
    dots.set([3 + Math.cos(a) * r * 1.1, 1.4 + y * 1.1, -3 + Math.sin(a) * r * 1.1], k * 3);
  }
  const cloud = PointsPlugin.attach(engine).add(
    new PointCloud({ positions: dots, material: { size: 4, color: '#f2f2f2' } }),
  );
  // A slanted plane through every shape's centre height, and on the toon box a second one cutting a corner. The torus
  // knot uses clipIntersection: only what is behind both of its planes goes, a wedge out of the front quadrant.
  materials[0].clipIntersection = true;
  const cut = (t: number) =>
    materials.forEach((material, i) => {
      const x = items[i].x,
        height = 1.2 + 0.5 * Math.sin(t + i);
      material.clippingPlanes =
        i === 0
          ? [
              [-1, 0, 0, x + 0.3 * Math.sin(t)],
              [0, 0, -1, 0],
            ]
          : [[0.25, -1, 0.35, height - 0.25 * x], ...(i === 2 ? [[-0.7, 0, -0.7, 0.75]] : [])];
      lineMaterial.clippingPlanes = [[0, -1, 0, 1.6 + 0.6 * Math.sin(t)]];
      cloud.material.clippingPlanes = [[-1, 0, 0.3, 3.9 + 0.4 * Math.sin(t)]];
    });
  cut(0);
  let time = 0;
  if (!still)
    stage.use({
      name: 'clipping-demo',
      setup() {},
      onPreUpdate(delta) {
        time += delta;
        cut(time);
      },
    });
  window.clippingDemo = { materials, line: lineMaterial, cloud };
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  status.textContent = 'Five materials, a line and a point cloud, each clipped by its own planes.';
  canvas.dataset.ready = 'true';
} catch (error) {
  if (!life.signal.aborted) status.textContent = String(error);
}
