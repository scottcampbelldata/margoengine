import { SOLIDWORKS, SectionPlanes, ViewCube, cadControls, createStage } from 'margoengine/cad';
import { cylinderGeometry } from 'margoengine/geometry/primitives';
import { toGeometry } from 'margoengine/geometry/utils';

// A small assembly with SolidWorks mouse navigation, a view cube and a section plane. Drop or pick a STEP, IGES,
// STL, OBJ or glTF file to open your own part.
async function start() {
  const stage = await createStage('#viewport', {
    controls: false,
    camera: { position: [4, 3, 5], target: [0, 0.5, 0] },
  });
  const engine = stage.engine;
  cadControls(engine, { profile: SOLIDWORKS, keys: window }); // or AUTOCAD, INVENTOR, FUSION, ONSHAPE, RHINO
  const cube = ViewCube.attach(engine);
  const section = new SectionPlanes({ planes: [[0, 0, -1, 0.4]] }); // cut away everything in front of z = 0.4
  engine.use(section);

  stage.box({ size: [3, 0.2, 2], color: '#9aa4b2', metalness: 0.6, roughness: 0.4 });
  stage.mesh(toGeometry(cylinderGeometry(0.4, 0.4, 1.2, 64)), {
    position: [-0.6, 0.7, 0],
    color: '#d0a050',
    metalness: 1,
  });
  stage.box({ size: [0.6, 0.6, 0.6], position: [0.9, 0.4, 0.3], color: '#84d6bd' });
  cube.view('iso');

  const open = async (file: File) => {
    const format = file.name.split('.').pop()?.toLowerCase().replace('stp', 'step').replace('igs', 'iges');
    const url = URL.createObjectURL(file);
    try {
      await stage.load(url, { format: format as 'step' | 'iges' | 'stl' | 'obj' | 'gltf' | 'glb' });
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
  document.querySelector('#section')!.addEventListener('click', () => {
    section.enabled = !section.enabled;
  });
}

start().catch((error) => {
  document.querySelector('#error')!.textContent = `Could not start: ${error instanceof Error ? error.message : error}`;
});
