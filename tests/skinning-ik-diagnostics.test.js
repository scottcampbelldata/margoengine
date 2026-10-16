import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { attachWorkshopDiagnostics } from '../examples/skinning-ik/diagnostics.ts';

function fixture(t) {
  const dom = new JSDOM('<div id="viewport"></div>'),
    parent = dom.window.document.querySelector('#viewport');
  t.after(() => dom.window.close());
  return parent;
}

test('default diagnostics do no recurring provider, JSON or DOM publication work', (t) => {
  const parent = fixture(t),
    source = { frames: 0, sampleIndex: 0, position: [1, 2, 3], safe: true },
    metrics = t.mock.fn(() => source),
    reflection = t.mock.fn(() => ({ captures: 4, position: source.position })),
    stringify = t.mock.method(JSON, 'stringify'),
    attribute = t.mock.method(parent, 'setAttribute'),
    diagnostics = attachWorkshopDiagnostics(parent, metrics, reflection);
  t.after(diagnostics.dispose);
  for (let i = 0; i < 1200; i++) {
    source.frames++;
    source.sampleIndex = Math.floor(source.frames / 6);
    diagnostics.publishMetrics();
    diagnostics.publishReflection();
  }
  assert.equal(metrics.mock.callCount(), 0);
  assert.equal(reflection.mock.callCount(), 0);
  assert.equal(stringify.mock.callCount(), 0);
  assert.equal(attribute.mock.callCount(), 0);
  assert.equal(parent.hasAttribute('data-metrics'), false);
  assert.equal(parent.hasAttribute('data-reflection'), false);
  assert.equal(Object.keys(parent).includes('readWorkshopDiagnostics'), false);
  const firstText = parent.readWorkshopDiagnostics(),
    first = JSON.parse(firstText);
  assert.equal(typeof firstText, 'string');
  assert.equal(first.frames, 1200);
  assert.equal(first.sampleIndex, 200);
  assert.equal(metrics.mock.callCount(), 1);
  assert.equal(stringify.mock.callCount(), 1);
  assert.equal(attribute.mock.callCount(), 0);
  first.position[0] = 900;
  first.safe = false;
  assert.deepEqual(source.position, [1, 2, 3]);
  assert.equal(source.safe, true);
  source.frames = 1207;
  source.position[1] = 8;
  assert.equal(JSON.parse(firstText).frames, 1200, 'the previous JSON owns its snapshot');
  assert.deepEqual(JSON.parse(parent.readWorkshopDiagnostics('metrics')).position, [1, 8, 3]);
  assert.deepEqual(JSON.parse(parent.readWorkshopDiagnostics('reflection')), { captures: 4, position: [1, 8, 3] });
  assert.equal(reflection.mock.callCount(), 1);
});

test('kind and provider failures do not publish partial snapshots, and requests can recover', (t) => {
  const parent = fixture(t),
    before = { frames: 1 },
    metrics = t.mock.fn(() => before),
    diagnostics = attachWorkshopDiagnostics(parent, metrics, () => undefined, true);
  t.after(diagnostics.dispose);
  for (const invalid of [null, false, 0, {}, 'all', 'Metrics'])
    assert.throws(() => parent.readWorkshopDiagnostics(invalid), /Unknown workshop diagnostic kind/);
  assert.equal(metrics.mock.callCount(), 0);
  diagnostics.publishMetrics();
  assert.equal(parent.dataset.metrics, '{"frames":1}');
  metrics.mock.mockImplementation(() => {
    throw new Error('provider failed');
  });
  assert.throws(diagnostics.publishMetrics, /provider failed/);
  assert.equal(parent.dataset.metrics, '{"frames":1}');
  assert.throws(diagnostics.publishReflection, /must produce JSON/);
  assert.equal(parent.hasAttribute('data-reflection'), false);
  const cyclic = {};
  cyclic.self = cyclic;
  metrics.mock.mockImplementation(() => cyclic);
  assert.throws(diagnostics.publishMetrics, TypeError);
  assert.equal(parent.dataset.metrics, '{"frames":1}');
  metrics.mock.mockImplementation(() => ({ frames: 2 }));
  diagnostics.publishMetrics();
  assert.equal(parent.dataset.metrics, '{"frames":2}');
});

test('legacy publication is explicit, owning and limited to the caller’s existing cadence', (t) => {
  const parent = fixture(t),
    source = { frames: 6, sampleIndex: 1, position: [1, 2, 3] },
    metrics = t.mock.fn(() => source),
    reflection = t.mock.fn(() => ({ captures: 8, busy: true })),
    diagnostics = attachWorkshopDiagnostics(parent, metrics, reflection, true);
  t.after(diagnostics.dispose);
  assert.equal(parent.hasAttribute('data-metrics'), false, 'attachment does not publish');
  diagnostics.publishMetrics();
  diagnostics.publishReflection();
  assert.deepEqual(JSON.parse(parent.dataset.metrics), source);
  assert.deepEqual(JSON.parse(parent.dataset.reflection), { captures: 8, busy: true });
  source.frames = 12;
  source.position[0] = 9;
  assert.equal(JSON.parse(parent.dataset.metrics).frames, 6, 'legacy changes only when explicitly published');
  const requested = JSON.parse(parent.readWorkshopDiagnostics());
  assert.equal(requested.frames, 12);
  assert.equal(JSON.parse(parent.dataset.metrics).frames, 6, 'demand reads do not write attributes');
  diagnostics.publishMetrics();
  assert.equal(JSON.parse(parent.dataset.metrics).frames, 12);
  assert.equal(metrics.mock.callCount(), 3);
  assert.equal(reflection.mock.callCount(), 1);
});

test('dispose restores owned previous properties/attributes and disables retained readers', (t) => {
  const parent = fixture(t),
    previous = () => 'previous';
  Object.defineProperty(parent, 'readWorkshopDiagnostics', {
    configurable: true,
    enumerable: true,
    writable: true,
    value: previous,
  });
  const descriptor = Object.getOwnPropertyDescriptor(parent, 'readWorkshopDiagnostics');
  parent.dataset.metrics = 'old metrics';
  parent.dataset.reflection = 'old reflection';
  const metrics = t.mock.fn(() => ({ frames: 8 })),
    diagnostics = attachWorkshopDiagnostics(parent, metrics, () => ({ captures: 1 }), true),
    retained = parent.readWorkshopDiagnostics;
  diagnostics.publishMetrics();
  diagnostics.publishReflection();
  diagnostics.dispose();
  diagnostics.dispose();
  assert.deepEqual(Object.getOwnPropertyDescriptor(parent, 'readWorkshopDiagnostics'), descriptor);
  assert.equal(parent.dataset.metrics, 'old metrics');
  assert.equal(parent.dataset.reflection, 'old reflection');
  assert.throws(retained, /disposed/);
  diagnostics.publishMetrics();
  diagnostics.publishReflection();
  assert.equal(metrics.mock.callCount(), 1);
});

test('cleanup preserves later external replacements and tolerates a permanent reader', (t) => {
  const parent = fixture(t),
    metrics = t.mock.fn(() => ({ frames: 4 })),
    first = attachWorkshopDiagnostics(parent, metrics, () => null, true);
  first.publishMetrics();
  Object.defineProperty(parent, 'readWorkshopDiagnostics', { configurable: true, value: () => 'replacement' });
  parent.dataset.metrics = 'replacement metrics';
  first.dispose();
  assert.equal(parent.readWorkshopDiagnostics(), 'replacement');
  assert.equal(parent.dataset.metrics, 'replacement metrics');
  const second = attachWorkshopDiagnostics(parent, metrics, () => null),
    retained = parent.readWorkshopDiagnostics;
  Object.defineProperty(parent, 'readWorkshopDiagnostics', { configurable: false });
  assert.doesNotThrow(second.dispose);
  assert.throws(retained, /disposed/);
  assert.equal(metrics.mock.callCount(), 1, 'failed property removal must not leave a live provider');
});

test('invalid installation and disposal during a provider cannot leave a live publication', (t) => {
  const parent = fixture(t),
    provider = t.mock.fn(() => null);
  assert.throws(() => attachWorkshopDiagnostics(parent, null, provider), /providers must be functions/);
  assert.equal(Object.hasOwn(parent, 'readWorkshopDiagnostics'), false);
  let diagnostics;
  diagnostics = attachWorkshopDiagnostics(
    parent,
    () => {
      diagnostics.dispose();
      return { frames: 1 };
    },
    provider,
    true,
  );
  diagnostics.publishMetrics();
  assert.equal(parent.hasAttribute('data-metrics'), false);
  assert.equal(Object.hasOwn(parent, 'readWorkshopDiagnostics'), false);
  Object.defineProperty(parent, 'readWorkshopDiagnostics', { configurable: false, value: () => 'existing' });
  assert.throws(() => attachWorkshopDiagnostics(parent, provider, provider), TypeError);
  assert.equal(provider.mock.callCount(), 0);
  assert.equal(parent.readWorkshopDiagnostics(), 'existing');
});
