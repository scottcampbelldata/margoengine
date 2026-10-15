import { HTML } from '../../packages/html/dist/index.js';
import { createScene, controls } from './ui-scene.js';

export function createWorkload(count = 16) {
  const scene = createScene(
    count,
    'HTML projects one clickable label above each moving cube and one anchor inside it. WebGPU asynchronously tests actual rendered scene depth to hide inside anchors. Toggle inside anchors above the cubes to compare visible depth results.',
  );
  let overlay,
    ui,
    labels = [],
    probes = [],
    inside = true,
    depthAvailable = false,
    setupCpuMilliseconds = 0,
    settle,
    stopPreview = () => {},
    previewSettling = false;
  return {
    ...scene,
    get overlay() {
      return overlay;
    },
    get labels() {
      return labels;
    },
    get probes() {
      return probes;
    },
    afterReady() {
      settle?.();
    },
    mount(context) {
      const start = performance.now();
      scene.mount(context);
      depthAvailable = context.engine.backend === 'webgpu';
      overlay = HTML.attach(context.engine, { parent: context.stage, capacity: count * 2 });
      const view = context.parent.ownerDocument.defaultView,
        queue = depthAvailable ? context.engine.canvas.getContext('webgpu').getConfiguration().device.queue : null;
      let generation = 0,
        frame = 0,
        disposed = false;
      settle = () => {
        if (!queue || disposed) return;
        const ticket = ++generation;
        if (frame) view.cancelAnimationFrame(frame);
        previewSettling = true;
        queueMicrotask(async () => {
          try {
            await queue.onSubmittedWorkDone();
          } catch {
            if (ticket === generation) previewSettling = false;
            return;
          }
          if (disposed || ticket !== generation) return;
          frame = view.requestAnimationFrame(() => {
            frame = 0;
            if (disposed || ticket !== generation || !context.render()) {
              previewSettling = false;
              return;
            }
            frame = view.requestAnimationFrame(() => {
              frame = 0;
              if (!disposed && ticket === generation) {
                context.render();
                previewSettling = false;
              }
            });
          });
        });
      };
      stopPreview = () => {
        disposed = true;
        generation++;
        if (frame) view.cancelAnimationFrame(frame);
        previewSettling = false;
      };
      const select = (index) => {
        scene.select(index);
        ui.actor.value = String(index + 1);
        context.render();
      };
      ui = controls(context.parent, count, select);
      context.meshes.forEach((mesh, index) => {
        const button = context.parent.ownerDocument.createElement('button');
        button.type = 'button';
        button.className = 'world-label';
        button.textContent = `Actor ${index + 1}`;
        ui.listen(button, 'click', () => select(index));
        labels.push(overlay.add(button, { mesh, offset: [0, 0.6, 0], offsetSpace: 'world', pointerEvents: 'auto' }));
        const element = context.parent.ownerDocument.createElement('span');
        element.className = 'world-probe';
        element.textContent = 'Depth anchor';
        probes.push(overlay.add(element, { mesh, offset: [0, 0, 0], offsetSpace: 'world' }));
      });
      ui.button('Move depth anchors above / inside', () => {
        inside = !inside;
        probes.forEach((label) => label.setOffset([0, inside ? 0 : 1, 0]));
        if (context.render()) settle();
      }).dataset.uiDepth = '';
      select(0);
      setupCpuMilliseconds = performance.now() - start;
    },
    details: () => ({
      actors: count,
      registeredAnchors: overlay?.size ?? 0,
      labelsOnScreen: labels.filter((label) => label.onScreen).length,
      probesOnScreen: probes.filter((label) => label.onScreen).length,
      anchorsInside: inside,
      depthAvailable,
      previewSettling,
      styleWrites: overlay?.writes ?? 0,
      selectedActor: scene.selected + 1,
      setupCpuMilliseconds,
    }),
    dispose() {
      stopPreview();
      overlay?.dispose();
      ui?.dispose();
      labels = [];
      probes = [];
      scene.dispose();
    },
  };
}
