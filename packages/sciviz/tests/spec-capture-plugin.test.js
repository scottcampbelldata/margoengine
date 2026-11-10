import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { specCapturePlugin } from './spec-capture-plugin.mjs';

test('exact-size demo capture is a pre-compilation transform with no page-owned HTTP re-fetch', async () => {
  const plugin = specCapturePlugin();
  assert.equal(plugin.enforce, 'pre');
  const source = 'export const input: number = 17;';
  for (const id of [
    '/examples/sciviz-moving-flow.ts',
    'C:\\repo\\examples\\sciviz-cinematic.ts',
    '/examples/sciviz-demo.ts?t=1',
  ]) {
    const result = plugin.transform(source, id);
    assert.ok(result.code.endsWith(source), 'source is retained for the real compiler');
    // Execute the injected setup against a structural Engine, retaining the actual factory options contract.
    const calls = [],
      engine = {
        create(canvas, options) {
          calls.push({ canvas, options });
          return options;
        },
      };
    const setup = result.code.slice(result.code.indexOf('\n') + 1, -source.length);
    const install = new Function('SpecCaptureEngine', 'devicePixelRatio', setup);
    install(engine, 1.5);
    const canvas = { clientWidth: 101, clientHeight: 51 };
    assert.deepEqual(engine.create(canvas, { controls: false }), { exactSize: [152, 77], controls: false });
    assert.deepEqual(
      engine.create(canvas, { exactSize: [8, 9] }),
      { exactSize: [8, 9] },
      'explicit options retain precedence',
    );
    const wrapped = engine.create;
    install(engine, 1.5);
    assert.equal(engine.create, wrapped, 'multiple transformed modules install once');
    assert.equal(calls.length, 2);
  }
  assert.equal(plugin.transform(source, '/examples/other.ts'), null);
  const fixture = readFileSync(new URL('./spec-demos-browser.mjs', import.meta.url), 'utf8');
  assert.match(fixture, /plugins:\s*\[specCapturePlugin\(\)\]/);
  assert.doesNotMatch(
    fixture,
    /\.route\(|route\.fetch\(/,
    'navigation and disposal cannot cancel a second route-owned HTTP request',
  );
});
