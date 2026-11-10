import { JSDOM } from 'jsdom';
import { Camera } from '../../core/dist/index.js';

export function setup(options = {}) {
  const dom = new JSDOM('<div><canvas width="400" height="300"></canvas></div>'),
    canvas = dom.window.document.querySelector('canvas'),
    plugins = new Map(),
    passes = [];
  const engine = {
    canvas, camera: new Camera({ position: [0, 0, 10], target: [0, 0, 0], ...options }), plugins,
    use(p) { plugins.set(p.name, p); p.setup(engine); p.registerPasses?.({ add: (pass) => passes.push(pass) }); return engine; },
    hasPlugin: (name) => plugins.has(name),
    removePlugin(name) { const p = plugins.get(name); plugins.delete(name); p?.dispose?.(); },
    frame(dt = 1 / 60) { for (const p of plugins.values()) p.onPreUpdate?.(dt); engine.camera.update(4 / 3, true); for (const p of passes) p.execute({}); },
  };
  return { engine, dom };
}
