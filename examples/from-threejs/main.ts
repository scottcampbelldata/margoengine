// Runs one migration example, picked by ?name=. Each example is a function that builds its scene on the canvas and
// returns a handle; `npm run test:from-threejs` drives every one of them through that handle.
import { demoStatus } from '../demo-status.ts';
import type { Example } from './example.ts';

const examples: Record<string, () => Promise<{ default: Example }>> = {
  'typical-scene': () => import('./typical-scene.ts'),
  basics: () => import('./basics.ts'),
  'model-animation': () => import('./model-animation.ts'),
  'instancing-picking': () => import('./instancing-picking.ts'),
  'post-processing': () => import('./post-processing.ts'),
};

const canvas = document.querySelector('canvas')!,
  status = document.querySelector<HTMLElement>('#status')!,
  page = demoStatus(canvas, status),
  asked = new URLSearchParams(location.search).get('name') ?? 'typical-scene';

try {
  const load = examples[asked];
  if (!load) throw new RangeError(`No example "${asked}"; use one of ${Object.keys(examples).join(', ')}`);
  document.querySelector(`nav a[href="?name=${asked}"]`)?.setAttribute('aria-current', 'page');
  const run = (await load()).default;
  const handle = await run(canvas, (text) => {
    status.textContent = text;
  });
  handle.engine.onError = (error) => page.error(error);
  window.addEventListener('pagehide', () => handle.engine.dispose(), { once: true });
  (window as unknown as { example: unknown }).example = handle;
  page.ready();
} catch (cause) {
  page.error(cause);
  throw cause;
}
