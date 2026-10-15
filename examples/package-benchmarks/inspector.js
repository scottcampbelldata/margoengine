import { Inspector } from '../../packages/inspector/dist/index.js';
import { PbrMaterial } from '../../packages/core/dist/index.js';
import { createScene, controls } from './ui-scene.js';

export function createWorkload(count = 16) {
  const scene = createScene(
    count,
    'Select cubes through the actual Inspector hierarchy or the actor control. Edit names, transforms, visibility and independent PBR materials. WebGPU draws real AABB debug bounds; other cubes continue moving.',
  );
  let inspector,
    ui,
    setupCpuMilliseconds = 0;
  return {
    ...scene,
    get inspector() {
      return inspector;
    },
    mount(context) {
      const start = performance.now();
      scene.mount(context);
      context.meshes.forEach((mesh) => {
        const material = new PbrMaterial();
        material.data.set(mesh.material.data);
        mesh.setMaterial(material);
      });
      inspector = Inspector.attach(context.engine, { parent: context.parent });
      inspector.element.style.position = 'static';
      inspector.element.style.width = '100%';
      inspector.element.style.maxWidth = '100%';
      inspector.element.style.maxHeight = '420px';
      inspector.root.querySelector('section').style.maxHeight = '420px';
      ui = controls(context.parent, count, (index) => {
        scene.select(index);
        inspector.select(context.meshes[index]);
        context.render();
      });
      inspector.select(context.meshes[0]);
      scene.select(0);
      if (context.engine.backend === 'webgpu') inspector.setDebug('bounds', true);
      ui.listen(inspector.root, 'change', () => {
        const index = context.meshes.indexOf(inspector.selected);
        if (index >= 0) scene.select(index);
        context.render();
      });
      ui.listen(inspector.root, 'input', context.render);
      ui.listen(inspector.root, 'click', () => {
        const index = context.meshes.indexOf(inspector.selected);
        if (index >= 0) {
          scene.select(index);
          ui.actor.value = String(index + 1);
        }
        context.render();
      });
      ui.listen(inspector.root.querySelector('[role=tree]'), 'keydown', () => {
        const index = context.meshes.indexOf(inspector.selected);
        if (index >= 0) {
          scene.select(index);
          ui.actor.value = String(index + 1);
        }
        context.render();
      });
      setupCpuMilliseconds = performance.now() - start;
    },
    step(delta) {
      if (inspector?.selected) {
        const index = scene.meshes.indexOf(inspector.selected);
        if (index >= 0) scene.select(index);
      }
      scene.step(delta);
    },
    details: () => ({
      actors: count,
      hierarchyItems: inspector?.root.querySelectorAll('[role=treeitem]').length ?? 0,
      selectedActor: scene.selected + 1,
      selectedX: inspector?.selected?.position.x ?? null,
      boundsEnabled: inspector?.debug.bounds ?? false,
      setupCpuMilliseconds,
    }),
    dispose() {
      inspector?.dispose();
      ui?.dispose();
      scene.dispose();
    },
  };
}
