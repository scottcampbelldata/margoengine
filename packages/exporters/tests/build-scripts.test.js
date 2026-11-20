// The package's build and tool scripts: each Wasm build runs cargo against the committed lock under a deadline that
// ends cargo's whole tree, checks the output as Wasm and writes its blueprint record; the quality script scores and
// hashes the shipped blueprint and reads its fixtures beside itself; the browser run has a hard limit on each step.
// Running cargo is not part of the test; the committed records are checked here against the sources they name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { BLUEPRINTS, staleBlueprints } from '../../../scripts/wasm-blueprints.mjs';

const script = async (name) =>
  (await readFile(new URL(`../scripts/${name}`, import.meta.url), 'utf8')).replaceAll('\r\n', '\n');

for (const [name, entry] of [
  ['build-basis.mjs', 'basis-encoder'],
  ['build-draco.mjs', 'draco-encoder'],
])
  test(`${name} builds locked, ends the cargo tree on its deadline, validates and records the Wasm`, async () => {
    const text = await script(name);
    assert.match(text, /'--locked'/);
    assert.match(text, /endTree\(child\.pid\)/);
    assert.doesNotMatch(text, /execFileSync\(/, 'a sync timeout signals cargo alone and leaves rustc running');
    assert.match(text, /WebAssembly\.validate\(/);
    assert.match(text, new RegExp(`writeRecord\\(BLUEPRINTS\\.find\\(\\(entry\\) => entry\\.name === '${entry}'\\)\\)`));
    const blueprint = BLUEPRINTS.find((item) => item.name === entry);
    assert.deepEqual(staleBlueprints(undefined, [blueprint]), []);
  });

test('basis-quality.mjs scores and hashes the shipped blueprint and reads fixtures beside itself', async () => {
  const text = await script('basis-quality.mjs');
  assert.match(text, /readFileSync\(new URL\('\.\.\/native\/basis\/margo_basis_encoder\.wasm', import\.meta\.url\)\)/);
  assert.doesNotMatch(text, /target\/wasm32-unknown-unknown/);
  assert.match(text, /readFileSync\(new URL\('\.\.\/\.\.\/\.\.\/' \+ path, import\.meta\.url\)\)/);
});

test('test-browser.js puts a hard limit on loading, waiting for and running the page', async () => {
  const text = await script('test-browser.js');
  for (const step of ['loading tests/exporters.html', 'waiting for runExporterTests', 'runExporterTests'])
    assert.ok(text.includes(`limited(\n    '${step}'`) || text.includes(`limited('${step}'`), step);
  assert.doesNotMatch(text, /await page\.evaluate\(\(\) => window\.runExporterTests\(\)\);/);
});
