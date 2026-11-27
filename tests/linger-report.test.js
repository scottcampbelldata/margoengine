// KB-P3h-stop: a browser suite printed its passing result and did not exit, with nothing saying what held the process.
// reportLinger names the open resources once, only when something else keeps the process running.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const helper = new URL('../scripts/support/shutdown.mjs', import.meta.url).href;
const suite = (body) =>
  spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `import { reportLinger } from ${JSON.stringify(helper)};\n${body}`],
    { encoding: 'utf8', timeout: 20_000 },
  );

test('a process held after its suite closed names what holds it, once', () => {
  const run = suite(`reportLinger('its browser suite closed', { ms: 100 });\nsetTimeout(() => {}, 1500);`);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr.match(/\[linger\]/g)?.length, 1, run.stderr);
  assert.match(run.stderr, /still running 0\.1 s after its browser suite closed; open resources: .*Timeout/);
});

test('a process with nothing else to do exits at once and says nothing', () => {
  const run = suite(`reportLinger('its browser suite closed', { ms: 15_000 });`);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, '');
});

test('openBrowser arms the report when its suite closes and clears it when another suite opens', () => {
  const source = readFileSync(new URL('../scripts/browser.js', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  const open = source.slice(source.indexOf('export async function openBrowser'));
  assert.match(open, /clearTimeout\(linger\);/);
  assert.match(open, /await closeServer\(\);\n\s+linger = reportLinger\(\);/);
});
