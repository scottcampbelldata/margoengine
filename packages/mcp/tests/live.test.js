import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LivePageBridge, createLiveTools } from '../dist/live.js';
import { createLiveHost } from '../dist/live-host.js';
import { createMcpServer } from '../dist/index.js';

const context = () => {
  const mesh = { id: 7, name: 'box', position: new Float32Array([0, 0, 0]), visible: true };
  const settings = { exposure: 1, enabled: true };
  const engine = {
    backend: 'webgpu',
    lighting: { direction: [0, 1, 0, 1], radiance: [1, 1, 1, 1], ambient: [1, 1, 1] },
    plugins: new Map(),
    scene: { meshes: new Map([[7, mesh]]) },
    gpu: new EventTarget(),
  };
  return { mesh, settings, engine };
};

test('live scene uses inspector setters, bounds errors and disposes listeners', { timeout: 10000 }, async () => {
  assert.throws(() => new LivePageBridge({ enabled: false }), /enabled/);
  const { engine, settings, mesh } = context();
  const events = new EventTarget();
  const bridge = new LivePageBridge({ enabled: true, objects: { settings }, events, errorLimit: 2 });
  bridge.setup(engine);
  const scene = await bridge.handle('scene');
  assert.ok(scene.objects.some((o) => o.id === 'mesh:7'));
  await bridge.handle('set', { id: 'mesh:7', key: 'position', value: [2, 3, 4] });
  assert.deepEqual([...mesh.position], [2, 3, 4]);
  await bridge.handle('set', { id: 'object:settings', key: 'exposure', value: 2 });
  assert.equal(settings.exposure, 2);
  await assert.rejects(bridge.handle('set', { id: 'object:settings', key: 'exposure', value: NaN }), /finite/);
  await assert.rejects(bridge.handle('set', { id: 'object:settings', key: '__proto__', value: 1 }), /no property/);
  await assert.rejects(bridge.handle('set', { id: 'object:settings', key: 'enabled', value: 3 }), /boolean/);
  for (let i = 0; i < 3; i++) bridge.reportError(`error ${i}`);
  assert.deepEqual(
    (await bridge.handle('errors', { clear: true })).map((e) => e.message),
    ['error 1', 'error 2'],
  );
  assert.deepEqual(await bridge.handle('errors'), []);
  bridge.dispose();
  await assert.rejects(bridge.handle('scene'));
});

test('authenticated relay connects page polling to MCP tools and propagates failures', { timeout: 10000 }, async () => {
  const host = await createLiveHost({ origins: ['http://localhost:5173'], timeoutMs: 1000 });
  const { engine, settings } = context();
  const page = new LivePageBridge({ enabled: true, endpoint: host.endpoint, token: host.token, objects: { settings } });
  const server = createMcpServer({ tools: createLiveTools(host) });
  try {
    assert.equal((await fetch(`${host.endpoint}/poll`)).status, 401);
    assert.equal((await fetch(`${host.endpoint}/poll`, { headers: { Origin: 'https://evil.test' } })).status, 403);
    page.setup(engine);
    const result = await server.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'live_set',
        arguments: { id: 'object:settings', key: 'exposure', value: 3 },
      },
    });
    assert.equal(result.result.isError, undefined, JSON.stringify(result));
    assert.equal(settings.exposure, 3);
    await assert.rejects(host.request('properties', { id: 'missing' }), /Unknown object/);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(host.request('scene', {}, controller.signal));
  } finally {
    page.dispose();
    await page.closed;
    server.dispose();
    await host.close();
  }
});

test('unconnected relay times out and shutdown rejects pending work', { timeout: 10000 }, async () => {
  const host = await createLiveHost({ origins: [], timeoutMs: 100 });
  await assert.rejects(host.request('scene', {}), /timeout/i);
  const pending = host.request('scene', {});
  const rejected = assert.rejects(pending, /closed/);
  await host.close();
  await rejected;
});
