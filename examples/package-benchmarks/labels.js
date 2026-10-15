import { LabelRenderer } from '../../packages/labels/dist/index.js';
import { createScene, controls } from './ui-scene.js';

export function createWorkload(count = 16) {
  const scene = createScene(
    count,
    'Real mesh-following 2D labels track moving cubes and sort by depth. Click a label to select its cube. A CSS3D card follows the selection; toggle or remove/re-add its 2D label to exercise ownership.',
  );
  let overlay,
    ui,
    card,
    labels = [],
    selections = 0,
    removed = false,
    setupCpuMilliseconds = 0;
  return {
    ...scene,
    get overlay() {
      return overlay;
    },
    get labels() {
      return labels;
    },
    mount(context) {
      const start = performance.now();
      scene.mount(context);
      overlay = new LabelRenderer({ parent: context.stage });
      context.engine.use(overlay);
      const select = (index) => {
        scene.select(index);
        selections++;
        card.setMesh(context.meshes[index]);
        ui.actor.value = String(index + 1);
        context.render();
      };
      ui = controls(context.parent, count, select);
      const add = (index, existing) => {
        const button = existing ?? context.parent.ownerDocument.createElement('button');
        button.type = 'button';
        button.className = 'world-label';
        button.textContent = `Actor ${index + 1}`;
        if (!existing) ui.listen(button, 'click', () => select(index));
        return overlay.add(button, {
          mesh: context.meshes[index],
          offset: [0, 0.6, 0],
          offsetSpace: 'world',
          pointerEvents: 'auto',
        });
      };
      labels = context.meshes.map((_, index) => add(index));
      const element = context.parent.ownerDocument.createElement('div');
      element.className = 'world-card';
      element.textContent = 'CSS3D selection';
      card = overlay.add3D(element, { mesh: context.meshes[0], pixelScale: 0.006 });
      ui.button('Toggle selected label', () => {
        const label = labels[scene.selected];
        if (label?.element.isConnected) label.visible = !label.visible;
        context.render();
      }).dataset.uiToggle = '';
      ui.button('Remove / re-add first', () => {
        if (!removed) labels[0].remove();
        else labels[0] = add(0, labels[0].element);
        removed = !removed;
        context.render();
      }).dataset.uiReadd = '';
      select(0);
      setupCpuMilliseconds = performance.now() - start;
    },
    details: () => ({
      actors: count,
      registeredElements: overlay?.size ?? 0,
      labelsOnScreen: labels.filter((label) => label.onScreen && label.element.isConnected).length,
      css3dOnScreen: card?.onScreen ?? false,
      styleWrites: overlay?.writes ?? 0,
      selections,
      selectedActor: scene.selected + 1,
      setupCpuMilliseconds,
    }),
    dispose() {
      overlay?.dispose();
      ui?.dispose();
      labels = [];
      scene.dispose();
    },
  };
}
