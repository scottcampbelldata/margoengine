import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { runInPage } from '../scripts/run-readme-examples.mjs';
import { finishLiveExample, observeLiveExample, serveLiveLink, usesLiveLink } from '../scripts/support/readme-live.mjs';

test('observer measures completed outer cleanup when plugin removal re-enters dispose', () => {
  class Model {
    nodes = [{ id: 7 }];
    setup(engine) {
      this.engine = engine;
      return 'setup';
    }
    dispose() {
      if (this.disposed) return;
      this.disposed = true;
      this.dispose();
      this.engine.meshes.delete(7);
      return 'disposed';
    }
  }
  class Camera {
    fitToBoundingBox() {
      return 'framed';
    }
  }
  class Source {
    close() {
      return 'closed';
    }
  }
  const window = {};
  runInNewContext(`(${observeLiveExample.toString()})(Model, Camera)`, { window, EventSource: Source, Model, Camera });
  const model = new Model();
  assert.equal(model.setup({ meshes: new Map([[7, model.nodes[0]]]) }), 'setup');
  assert.equal(new Camera().fitToBoundingBox(), 'framed');
  assert.equal(model.dispose(), 'disposed');
  assert.equal(new Source().close(), 'closed');
  assert.deepEqual({ ...window.__live }, { loaded: 1, framed: 1, disposed: 1, closed: 1, attached: 1, remaining: 0 });
});

test('live fixture serves native SSE and the exact real Blender model, and releases its open connection', {
  timeout: 5000,
}, async () => {
  let closed;
  const disconnected = new Promise((resolve) => {
    closed = resolve;
  });
  const server = createServer((request, response) => {
    if (request.url.endsWith('/events')) response.on('close', closed);
    if (!serveLiveLink(request, response)) response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const controller = new AbortController();
  try {
    const stream = await fetch(`${origin}/__readme-live/events`, { signal: controller.signal });
    assert.equal(stream.headers.get('content-type'), 'text/event-stream');
    const reader = stream.body.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value), 'event: scene\ndata: 1\n\n');
    const model = await fetch(`${origin}/__readme-live/scene.margo?v=1`);
    assert.deepEqual(
      Buffer.from(await model.arrayBuffer()),
      readFileSync('packages/blender/tests/fixtures/triangle.margo'),
    );
    controller.abort();
    await disconnected;
  } finally {
    controller.abort();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

function livePage({ loaded = 1, disposed = 1, closed = 1, remaining = 0 } = {}) {
  let hidden = false;
  const calls = [];
  return {
    calls,
    route: async () => {},
    goto: async () => {},
    waitForFunction: async (fn) => {
      if (fn.toString().includes('framed')) calls.push('loaded');
      else if (!hidden) throw new Error('module waits for pagehide');
    },
    waitForTimeout: async () => {},
    evaluate: async (fn) => {
      if (fn.toString().includes('dispatchEvent')) {
        calls.push('pagehide');
        hidden = true;
        return true;
      }
      if (fn.toString().includes('__errors')) return [];
      return {
        loaded,
        framed: loaded,
        attached: loaded,
        disposed: hidden ? disposed : 0,
        closed: hidden ? closed : 0,
        remaining,
      };
    },
    close: async () => {
      calls.push('closed page');
    },
  };
}

test('runner drives pagehide after a live model, then requires module completion and disposal', {
  timeout: 5000,
}, async () => {
  const page = livePage();
  const result = await runInPage(
    { id: 'runner-test/live', code: "import { margoLive } from 'margoengine/blender/live';" },
    {
      origin: 'http://example.test',
      browser: { newPage: async () => page },
    },
  );
  assert.equal(result.result, 'pass', result.reason);
  assert.deepEqual(page.calls, ['loaded', 'pagehide', 'closed page']);
  assert.equal(usesLiveLink("import {margoLive} from '@margoengine/blender/live';"), true);
  assert.equal(usesLiveLink("import {loadMargo} from 'margoengine/blender';"), false);
});

test('live lifecycle refuses no model, missing disposal, open stream and attached nodes', {
  timeout: 5000,
}, async () => {
  for (const state of [{ loaded: 0 }, { disposed: 0 }, { closed: 0 }, { remaining: 1 }]) {
    const page = livePage(state);
    await assert.rejects(finishLiveExample(page, 500), /did not (load|dispose)/);
    if (state.loaded === 0) assert.deepEqual(page.calls, ['loaded'], 'no abort before a model is proved');
  }
});
