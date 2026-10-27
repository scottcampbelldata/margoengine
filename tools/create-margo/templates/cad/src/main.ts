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
import type { LoadedModel } from 'margoengine';
import { addCAD } from 'margoengine/stage/cad';
import { addGLTF } from 'margoengine/stage/gltf';

// A STEP part (public/plate.step) read with OpenCascade, drawn with CAD navigation, dimensions, a section plane and
// click-to-measure. Open your own STEP, IGES, STL, OBJ or glTF part with the file picker or by dropping it on the page.
const info = document.querySelector('#info')!;

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
  const dimensions = Dimensions.attach(engine, { color: '#ffd166' });
  const raycaster = new Raycaster();
  const section = new SectionPlanes({ planes: [[0, 0, -1, 0.004]] });
  section.enabled = false;
  engine.use(section);
  document.querySelector('#section')!.addEventListener('click', () => {
    section.enabled = !section.enabled;
  });

  // The part on screen: STEP and IGES come through OpenCascade in a worker, in meters.
  let part: LoadedModel | null = null;
  const show = async (url: string, name: string, format?: 'step' | 'iges' | 'stl' | 'obj' | 'gltf' | 'glb') => {
    const next =
      format === 'gltf' || format === 'glb' ? await addGLTF(stage, url) : await addCAD(stage, url, { format });
    part?.destroy();
    dimensions.clear();
    part = next;
    for (const mesh of next.meshes) shadows.add(mesh);
    // Overall size, drawn along three edges of the part's bounding box.
    const [x0, y0, z0, x1, y1, z1] = next.bounds;
    dimensions.add({ a: { point: [x0, y0, z0] }, b: { point: [x1, y0, z0] }, offset: 28 });
    dimensions.add({ a: { point: [x1, y0, z0] }, b: { point: [x1, y1, z0] }, offset: 28 });
    dimensions.add({ a: { point: [x1, y0, z0] }, b: { point: [x1, y0, z1] }, offset: 28 });
    const size = [x1 - x0, y1 - y0, z1 - z0].map((v) => (v * 1000).toFixed(1)).join(' x ');
    info.textContent = `${name}: ${size} mm. Click two points to measure; drag to rotate (SolidWorks mouse).`;
    cube.view('iso');
  };

  // Click two points on the part: each snaps to the nearest corner or edge, and the distance is drawn between them.
  let first: Anchor | null = null,
    measured: ReturnType<typeof dimensions.add> | null = null,
    down = [0, 0];
  const canvas = engine.canvas as HTMLCanvasElement;
  canvas.addEventListener('pointerdown', (event) => (down = [event.clientX, event.clientY]));
  canvas.addEventListener('pointerup', (event) => {
    if (!part || Math.hypot(event.clientX - down[0], event.clientY - down[1]) > 4) return; // none yet, or a drag
    const [hit] = raycaster.setFromEngine(engine, event.offsetX, event.offsetY).intersectObjects(engine, part.meshes);
    if (!hit) return;
    const point = hit.point as [number, number, number];
    const anchor = snapFeature(hit.mesh, point, 'vertex', 0.004) ??
      snapFeature(hit.mesh, point, 'edge', 0.003) ?? { point };
    if (!first) {
      if (measured) dimensions.remove(measured);
      first = anchor;
    } else {
      measured = dimensions.add({ a: first, b: anchor, offset: 20 });
      first = null;
    }
  });

  await show('/plate.step', 'plate.step');

  // Your own part: STEP, IGES, STL, OBJ or glTF, from the file picker or dropped on the page.
  const open = async (file: File) => {
    const format = file.name.split('.').pop()?.toLowerCase().replace('stp', 'step').replace('igs', 'iges');
    const url = URL.createObjectURL(file);
    try {
      await show(url, file.name, format as 'step' | 'iges' | 'stl' | 'obj' | 'gltf' | 'glb');
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
