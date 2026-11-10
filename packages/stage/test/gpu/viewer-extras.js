import { createStage } from '../../dist/index.js';
import { addViewer } from '../../dist/viewer.js';
import { addViewerExtras, registerViewerElement } from '../../dist/viewer-extras.js';
import { Animation } from '../../../animation/dist/index.js';
import { waitForPipelines } from '../../../../scripts/support/gpu-ready.js';

if (new URLSearchParams(location.search).has('compat')) {
  const { install } = await import('../../../webgl2-compat/dist/index.js');
  await install({ force: true });
}
const errors = [],
  stages = [],
  settings = { environment: false, shadows: false, tonemap: false, background: false, turntable: false };
for (const selector of ['#a', '#b']) {
  const stage = await createStage(selector, {
    controls: false,
    autoStart: false,
    onError: (e) => errors.push(String(e)),
  });
  stage.engine.gpu.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  stages.push(stage);
}
async function frame() {
  for (const stage of stages) {
    stage.engine.render({ delta: 0 });
    await stage.engine.gpu.queue.onSubmittedWorkDone();
  }
}
let wrapped, direct, player;
window.check = {
  async load(url, animated) {
    wrapped = await addViewerExtras(stages[0], url, {
      ...settings,
      poster: '/examples/assets/khronos/ToyCar/screenshot.jpg',
      reveal: 'manual',
    });
    direct = await addViewer(stages[1], url, settings);
    player = animated ? Animation.attach(direct.model) : null;
    if (animated) {
      wrapped.play(0);
      wrapped.pause();
      wrapped.seek(0.3);
      player.play(0);
      player.playing = false;
      player.seek(0.3);
    }
    await waitForPipelines(frame);
    const manual = !wrapped.poster.hidden;
    wrapped.dismissPoster();
    return { manual, playing: wrapped.animation?.playing ?? false, variants: wrapped.model.variants };
  },
  async variant(value) {
    wrapped.selectVariant(value);
    direct.model.selectVariant(value);
    await waitForPipelines(frame);
  },
  async hotspot() {
    const element = document.querySelector('#hotspot'),
      node = wrapped.model.nodes.find((node) => node !== wrapped.model.root);
    const label = await wrapped.addHotspot({ element, position: [...stages[0].engine.camera.target] });
    await frame();
    const visible = label.onScreen,
      screen = [label.screen.x, label.screen.y];
    wrapped.removeHotspot(element);
    await wrapped.addHotspot({ element, mesh: node, offset: [0, 0.1, 0] });
    await frame();
    return { visible, screen, moved: element.parentElement.id !== 'annotations' };
  },
  async pick() {
    let hit = null;
    for (const [x, y] of [
      [160, 160],
      [150, 180],
      [160, 210],
      [180, 160],
    ]) {
      hit = await wrapped.pick(x, y);
      if (hit) break;
    }
    return { own: hit?.model === wrapped.model, miss: (await wrapped.pick(-1, -1)) === null };
  },
  async play() {
    wrapped.play();
    const playing = wrapped.animation.playing;
    wrapped.pause();
    return playing && !wrapped.animation.playing;
  },
  drop() {
    wrapped.dispose();
    direct.dispose();
    return {
      restored: document.querySelector('#hotspot').parentElement.id === 'annotations',
      posters: document.querySelectorAll('#left img').length,
    };
  },
  async element() {
    registerViewerElement('margo-gpu-viewer', { stage: { autoStart: false, controls: false }, viewer: settings });
    const element = document.createElement('margo-gpu-viewer');
    element.style.cssText = 'width:320px;height:320px';
    element.src = '/packages/exporters/tests/fixtures/BoxTextured.glb';
    element.setAttribute('poster', '/examples/assets/khronos/ToyCar/screenshot.jpg');
    element.setAttribute('reveal', 'manual');
    const hotspot = document.createElement('button');
    hotspot.slot = 'hotspot-top';
    hotspot.dataset.position = '0 0.5 0';
    hotspot.textContent = 'Top';
    element.append(hotspot);
    let load = new Promise((resolve) => element.addEventListener('load', resolve, { once: true }));
    document.body.append(element);
    await load;
    const first = element.stage,
      manual = !element.viewer.poster.hidden;
    element.dismissPoster();
    load = new Promise((resolve) => element.addEventListener('load', resolve, { once: true }));
    element.src = '/examples/assets/khronos/MaterialsVariantsShoe/MaterialsVariantsShoe.glb';
    await load;
    element.setAttribute('variant-name', element.availableVariants[0]);
    const variant = element.viewer.model.selectedVariant === 0,
      replaced = first.signal.aborted;
    const previous = element.stage;
    element.remove();
    const restored = hotspot.parentElement === element;
    load = new Promise((resolve) => element.addEventListener('load', resolve, { once: true }));
    document.body.append(element);
    await load;
    const reconnected = previous !== element.stage;
    element.remove();
    return { manual, variant, replaced, restored, reconnected };
  },
  async ar() {
    const viewer = await addViewerExtras(stages[0], '/packages/exporters/tests/fixtures/BoxTextured.glb', {
      ...settings,
      ar: true,
      picking: false,
    });
    const result = {
      button: viewer.ar.element.textContent,
      mode: viewer.ar.element.dataset.xrButton,
      disabled: viewer.ar.element.disabled,
      reason: viewer.ar.reason,
    };
    viewer.dispose();
    return result;
  },
  close() {
    for (const stage of stages) stage.dispose();
    return errors;
  },
};
