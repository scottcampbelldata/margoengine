import {Gizmo} from '../../packages/gizmo/dist/index.js';
import {createScene, controls} from './ui-scene.js';

export function createWorkload(count = 16) {
  const scene = createScene(count, 'Drag the selected cube’s real Gizmo handles. Translate, rotate and scale in world/local space; reset restores its attach-time pose or the start of its last drag. Selected cubes keep edits while the other cubes move.');
  let gizmo, ui, changes = 0, selections = 0, setupCpuMilliseconds = 0;
  return {...scene, get gizmo() {return gizmo;},
    interaction() {
      const frame = gizmo?.frame(); if (!frame) return null;
      const canvas = gizmo.engine.canvas, matrix = gizmo.engine.camera.matrix;
      for (const fraction of [0.4, 0.5, 0.6, 0.7, 0.8]) {
        const [x, y, z] = frame.origin.map((value, axis) => value + frame.axes[0][axis] * frame.size * fraction);
        const w = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
        const handleX = ((matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12]) / w + 1) * canvas.clientWidth / 2;
        const handleY = (1 - (matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13]) / w) * canvas.clientHeight / 2;
        if (gizmo.pick(handleX, handleY) === 'X') return {handleX, handleY};
      }
      return null;
    },
    mount(context) {
      const start = performance.now(); scene.mount(context);
      gizmo = new Gizmo(context.engine, {translationSnap: 0.25, rotationSnap: Math.PI / 12, scaleSnap: 0.25, size: 0.65});
      const select = index => {scene.select(index); gizmo.attach(context.meshes[index]); selections++; context.render();};
      ui = controls(context.parent, count, select);
      const mode = ui.select('Transform', ['translate', 'rotate', 'scale'], value => gizmo.setMode(value)); mode.dataset.uiMode = '';
      ui.select('Space', ['world', 'local'], value => gizmo.setSpace(value));
      ui.button('Reset selected', () => gizmo.reset()).dataset.uiReset = '';
      gizmo.addEventListener('objectChange', () => {changes++; scene.step(0);});
      gizmo.addEventListener('change', context.render); select(0); setupCpuMilliseconds = performance.now() - start;
    },
    details: () => ({actors: count, selections, objectChanges: changes, selectedActor: scene.selected + 1, mode: gizmo?.mode ?? 'unmounted',
      selectedX: scene.meshes[scene.selected]?.position.x ?? null, selectedScale: scene.meshes[scene.selected]?.scale.x ?? null, setupCpuMilliseconds}),
    dispose() {gizmo?.dispose(); ui?.dispose(); scene.dispose();}
  };
}
