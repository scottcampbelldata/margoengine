// Timber Valley: @margoengine/scenes/timber-valley in a page, for viewing and for the shot tool (tools/shot). URL options:
// `view` (an anchor or view name, default aerial-west), `fov` (degrees), and any scene setting by name (weather, date,
// hour, fire, fireTime, windFrom, houses, quality, look, seed). The page sets #viewport[data-ready="true"] after 30
// frames and exposes `window.timberValley = {engine, scene}`.
import { Engine } from '@margoengine/core';
import { attach, info } from '@margoengine/scenes/timber-valley';

const query = new URLSearchParams(location.search),
  viewport = document.querySelector<HTMLElement>('#viewport')!,
  error = document.querySelector<HTMLElement>('#error')!,
  status = document.querySelector<HTMLElement>('#status');
const settings: Record<string, unknown> = {};
for (const [key, spec] of Object.entries(info.settings)) {
  const value = query.get(key);
  if (value === null) continue;
  settings[key] =
    typeof spec.default === 'number' ? Number(value) : typeof spec.default === 'boolean' ? value !== '0' : value;
}
const canvas = document.createElement('canvas');
viewport.append(canvas);
const resize = () => {
  canvas.width = Math.round(innerWidth * devicePixelRatio);
  canvas.height = Math.round(innerHeight * devicePixelRatio);
};
resize();
addEventListener('resize', resize);
try {
  const engine = await Engine.create(canvas, { camera: { fov: 50, near: 0.5, far: 30000 } });
  const scene = await attach(engine, settings);
  scene.view(query.get('view') ?? 'aerial-west', Number(query.get('fov') ?? 50));
  let frames = 0;
  engine.use({
    name: 'timber-valley-page',
    setup() {},
    onPreUpdate() {
      if (++frames === 30) {
        status?.remove();
        viewport.dataset.ready = 'true';
      }
    },
  });
  (window as unknown as Record<string, unknown>).timberValley = { engine, scene };
  addEventListener('pagehide', () => scene.dispose(), { once: true });
} catch (cause) {
  error.textContent = String(cause);
}
