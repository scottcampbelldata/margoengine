import {Transitions} from '../../packages/transitions/dist/index.js';
import {fetchBytes, parsePLY, parseOFF} from '../../packages/loaders/dist/index.js';
import {assetWorkload, displayGeometry} from './asset-scene.js';
import {controls} from './ui-scene.js';

export async function createWorkload(count = 4, options = {}) {
  const [knight, dolphin] = await Promise.all([
    fetchBytes(new URL('../../packages/loaders/tests/fixtures/decimated-knight.off', import.meta.url), {...options, maxBytes: 100000}),
    fetchBytes(new URL('../../packages/loaders/tests/fixtures/dolphins.ply', import.meta.url), {...options, maxBytes: 100000})
  ]), geometries = [displayGeometry(parseOFF(knight)), displayGeometry(parsePLY(dolphin))], kinds = ['wipe', 'dissolve', 'radial', 'chromatic'];
  let selected = 0, switches = 0, elapsed = 0, next = 1.5, effect, ui, context, disposed = false;
  const scene = await assetWorkload(count, () => geometries[selected], 'Actual captured knight/dolphin scene images alternate through wipe, seeded dissolve, radial and chromatic transitions. Run switches real model geometry every 1.5 seconds and animates 0.75-second composites; the button starts another switch while paused or running.', {...options, repeat: false, cleanup: () => {disposed = true; effect?.dispose(); ui?.dispose(); context = null;}});
  const mount = scene.mount, step = scene.step;
  const change = () => {if (disposed || !effect) return; effect.start(kinds[switches % kinds.length], 0.75); next = elapsed + 1.5; selected ^= 1; switches++; context.meshes.forEach(mesh => mesh.setGeometry(geometries[selected])); context.render();};
  return Object.assign(scene, {
    mount(value) {context = value; mount(value); effect = Transitions.attach(value.engine); ui = controls(value.parent, count, () => {}); ui.actor.parentElement.remove(); ui.button('Start transition (Run animates)', change).dataset.uiTransition = '';},
    step(delta) {if (disposed) return; step(delta); elapsed += delta; if (elapsed >= next) {next = elapsed + 1.5; change();}},
    details: () => ({models: count, sourceBytes: knight.length + dolphin.length, scene: selected ? 'dolphins' : 'knight', sceneSwitches: switches, transitionKind: switches ? kinds[(switches - 1) % kinds.length] : 'none', progress: effect?.progress ?? null})
  });
}
