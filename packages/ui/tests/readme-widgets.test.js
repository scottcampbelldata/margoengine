import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformWithOxc } from 'vite';
import { readmeEntries } from '../../../scripts/support/readme-types.mjs';

test('the widgets README completes module setup without waiting for user activation', {
  timeout: 10_000,
}, async () => {
  const markdown = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const entry = readmeEntries(markdown).find((e) => e.heading === 'Widgets');
  assert.ok(entry);
  const source = entry.code.replace(
    "'@margoengine/ui'",
    JSON.stringify(new URL('../dist/index.js', import.meta.url).href),
  );
  const { code } = await transformWithOxc(source + '\nexport {ui};', 'widgets.ts');
  const module = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
  assert.equal(
    module.ui.modalLayer.children.length,
    0,
    'no dialog waits for a user before module initialization completes',
  );
  assert.ok(
    module.ui.root.children.some((w) => w.text === 'Respawn options'),
    'the user can request the dialog',
  );
});
