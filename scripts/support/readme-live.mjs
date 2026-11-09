// A finite live-link session: native EventSource and fetch, real Blender bytes, then external pagehide.
import { readFileSync } from 'node:fs';

export const usesLiveLink = (code) => /from\s*['"](?:@margoengine|margoengine)\/blender\/live['"]/.test(code);

/** Served by the page harness, including the open SSE connection until the example closes it. */
export function serveLiveLink(request, response) {
  const { pathname } = new URL(request.url, 'http://example.test');
  if (pathname === '/__readme-live/events') {
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    });
    response.write('event: scene\ndata: 1\n\n');
    return true;
  }
  if (pathname === '/__readme-live/scene.margo') {
    response.writeHead(200, {
      'content-type': 'application/octet-stream',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    });
    response.end(readFileSync(new URL('../../packages/blender/tests/fixtures/triangle.margo', import.meta.url)));
    return true;
  }
  return false;
}

/** Runs in the page before the unmodified example. Observes real calls and retains their results and errors. */
export function observeLiveExample(PBRModel, Camera) {
  const state = (window.__live = { loaded: 0, framed: 0, disposed: 0, closed: 0, attached: 0, remaining: 0 }),
    engines = new WeakMap(),
    disposing = new WeakSet(),
    setup = PBRModel.prototype.setup,
    dispose = PBRModel.prototype.dispose,
    fit = Camera.prototype.fitToBoundingBox,
    close = EventSource.prototype.close;
  PBRModel.prototype.setup = function (engine, ...args) {
    const result = setup.call(this, engine, ...args);
    engines.set(this, engine);
    state.loaded++;
    state.attached += this.nodes.filter((node) => engine.meshes.has(node.id)).length;
    return result;
  };
  PBRModel.prototype.dispose = function (...args) {
    // Engine.removePlugin re-enters this idempotent method while its outer cleanup still owns the nodes.
    if (disposing.has(this)) return dispose.apply(this, args);
    const nodes = [...this.nodes];
    disposing.add(this);
    let result;
    try {
      result = dispose.apply(this, args);
    } finally {
      disposing.delete(this);
    }
    state.disposed++;
    const engine = engines.get(this);
    state.remaining += nodes.filter((node) => engine.meshes.has(node.id)).length;
    return result;
  };
  Camera.prototype.fitToBoundingBox = function (...args) {
    const result = fit.apply(this, args);
    state.framed++;
    return result;
  };
  EventSource.prototype.close = function (...args) {
    const result = close.apply(this, args);
    state.closed++;
    return result;
  };
}

/** Abort only after the loop has received and framed its real model, then require module completion and cleanup. */
export async function finishLiveExample(page, timeout) {
  await page.waitForFunction(() => window.__live?.framed > 0 || window.__ran, undefined, { timeout });
  const errors = await page.evaluate(() => window.__errors);
  if (errors.length) throw new Error(errors[0]);
  const loaded = await page.evaluate(() => window.__live);
  if (!loaded?.loaded || !loaded.framed || !loaded.attached)
    throw new Error(`Live-link example did not load, attach and frame the fixture model: ${JSON.stringify(loaded)}`);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  await page.waitForFunction(() => window.__ran, undefined, { timeout });
  const state = await page.evaluate(() => window.__live);
  if (state.loaded !== 1 || state.disposed !== 1 || state.closed !== 1 || state.remaining !== 0)
    throw new Error(`Live-link example did not dispose its model and close its event stream: ${JSON.stringify(state)}`);
  return state;
}
