import { Geometry } from 'margoengine';
import { model } from 'margoengine/brep';
import { Raycaster } from 'margoengine/bvh';
import {
  Dimensions,
  EnvironmentLighting,
  SOLIDWORKS,
  SectionPlanes,
  Shadows,
  ViewCube,
  cadControls,
  createStage,
  snapFeature,
} from 'margoengine/cad';
import type { Anchor } from 'margoengine/machinery/dimensions';
import { Environment } from 'margoengine/environment';

// A mounting bracket modeled in code with Margo's own B-rep kernel (a union, four holes cut by Booleans, exact mass
// properties), drawn with CAD navigation, dimensions, a section plane and click-to-measure.
const info = document.querySelector('#info')!;

function bracket() {
  const { box, cylinder, boolean, frameOf } = model;
  let part = boolean('bracket', 'union', box('base', [0.08, 0.05, 0.008]), box('wall', [0.08, 0.008, 0.05]));
  [0.015, 0.065].forEach((x, i) => {
    const hole = cylinder(`hole${i}`, 0.005, 0.02, frameOf([x, 0.032, -0.005], [0, 0, 1], [1, 0, 0]));
    part = boolean(`base-hole${i}`, 'subtract', part, hole);
  });
  [0.025, 0.055].forEach((x, i) => {
    const hole = cylinder(`slot${i}`, 0.006, 0.02, frameOf([x, -0.005, 0.03], [0, 1, 0], [1, 0, 0]));
    part = boolean(`wall-hole${i}`, 'subtract', part, hole);
  });
  return part;
}

// A soft studio for image-based lighting: sky gradient, floor, two soft boxes.
function studio(width = 128, height = 64) {
  const data = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const up = Math.cos((Math.PI * (y + 0.5)) / height);
    for (let x = 0; x < width; x++) {
      const u = x / width,
        light = up > 0.3 && up < 0.75 && (Math.abs(u - 0.2) < 0.06 || Math.abs(u - 0.65) < 0.04) ? 8 : 0,
        sky = up > 0 ? 0.3 + 0.7 * up : 0.1;
      data.set([sky * 0.9 + light, sky * 0.95 + light, sky + light, 1], (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

async function start() {
  const stage = await createStage('#viewport', {
    controls: false,
    camera: { position: [0.17, 0.12, 0.19], target: [0.04, 0.02, 0.02], near: 0.005, fov: 40 },
  });
  const engine = stage.engine;
  cadControls(engine, { profile: SOLIDWORKS, keys: window }); // or AUTOCAD, INVENTOR, FUSION, ONSHAPE, RHINO
  const cube = ViewCube.attach(engine);
  EnvironmentLighting.attach(engine, await Environment.attach(engine, studio()));
  const shadows = Shadows.attach(engine, { resolution: 2048, distance: 0.5 });

  const started = performance.now();
  const part = bracket();
  const { volume, area } = model.massProperties(part);
  const [mesh] = model.meshBodies([part], { relativeDeflection: 0.0005, angle: 0.25 }).meshes;
  const ms = performance.now() - started;
  const solid = stage.mesh(new Geometry(mesh.positions, mesh.normals, mesh.indices), {
    color: '#a9b8c8',
    metalness: 1,
    roughness: 0.32,
  });
  const floor = stage.box({
    size: [0.6, 0.004, 0.6],
    position: [0.04, -0.002, 0.025],
    color: '#2b3038',
    roughness: 0.9,
  });
  shadows.add(solid);
  shadows.add(floor);
  info.innerHTML =
    `<b>Bracket</b>, modeled in ${ms.toFixed(0)} ms: ${part.faces.length} faces, ` +
    `volume ${(volume * 1e6).toFixed(2)} cm³, area ${(area * 1e4).toFixed(1)} cm², ` +
    `${(volume * 2.7e6).toFixed(1)} g in aluminium. Click two points to measure.`;

  // Dimensions follow the part: hole spacing, the wall's height and a hole diameter.
  const dimensions = Dimensions.attach(engine, { color: '#ffd166' });
  const at = (point: [number, number, number]): Anchor => ({ point, node: solid });
  dimensions.add({ a: at([0.015, 0.032, 0.008]), b: at([0.065, 0.032, 0.008]), offset: 28 });
  dimensions.add({ a: at([0.08, 0, 0]), b: at([0.08, 0, 0.05]), offset: -24 });
  dimensions.add({ kind: 'radius', center: at([0.065, 0.032, 0.008]), a: at([0.07, 0.032, 0.008]), diameter: true });

  // Click two points on the part: each snaps to the nearest corner or edge, and the distance is drawn between them.
  const raycaster = new Raycaster();
  let first: Anchor | null = null,
    measured: ReturnType<typeof dimensions.add> | null = null,
    down = [0, 0];
  const canvas = engine.canvas as HTMLCanvasElement;
  canvas.addEventListener('pointerdown', (event) => (down = [event.clientX, event.clientY]));
  canvas.addEventListener('pointerup', (event) => {
    if (Math.hypot(event.clientX - down[0], event.clientY - down[1]) > 4) return; // that was a drag
    const [hit] = raycaster.setFromEngine(engine, event.offsetX, event.offsetY).intersectObjects(engine, [solid]);
    if (!hit) return;
    const point = hit.point as [number, number, number];
    const anchor = snapFeature(solid, point, 'vertex', 0.004) ?? snapFeature(solid, point, 'edge', 0.003) ?? { point };
    if (!first) {
      if (measured) dimensions.remove(measured);
      first = anchor;
    } else {
      measured = dimensions.add({ a: first, b: anchor, offset: 20 });
      first = null;
    }
  });

  const section = new SectionPlanes({ planes: [[0, 0, -1, 0.032]] });
  section.enabled = false;
  engine.use(section);
  document.querySelector('#section')!.addEventListener('click', () => {
    section.enabled = !section.enabled;
  });
  cube.view('iso');

  // Your own part: STEP, IGES, STL, OBJ or glTF, from the file picker or dropped on the page.
  const open = async (file: File) => {
    const format = file.name.split('.').pop()?.toLowerCase().replace('stp', 'step').replace('igs', 'iges');
    const url = URL.createObjectURL(file);
    try {
      solid.visible = false;
      dimensions.clear();
      await stage.load(url, { format: format as 'step' | 'iges' | 'stl' | 'obj' | 'gltf' | 'glb' });
      info.textContent = `${file.name}: drag to rotate (SolidWorks mouse), click the view cube to snap.`;
    } finally {
      URL.revokeObjectURL(url);
    }
  };
  const picker = document.querySelector<HTMLInputElement>('#file')!;
  picker.addEventListener('change', () => picker.files?.[0] && void open(picker.files[0]));
  document.addEventListener('dragover', (event) => event.preventDefault());
  document.addEventListener('drop', (event) => {
    event.preventDefault();
    const file = event.dataTransfer?.files[0];
    if (file) void open(file);
  });
}

start().catch((error) => {
  document.querySelector('#error')!.textContent = `Could not start: ${error instanceof Error ? error.message : error}`;
});
