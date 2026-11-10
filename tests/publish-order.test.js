import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { publishOrder } from '../scripts/publish-order.mjs';
import { KIT_MEMBERS } from '../scripts/umbrella.mjs';

test('publication places every profile after its members and the umbrella last', () => {
  const root = new URL('../', import.meta.url);
  const directories = JSON.parse(readFileSync(new URL('package.json', root))).workspaces.filter((p) =>
    p.startsWith('packages/'),
  );
  const manifests = new Map(
    directories.map((path) => [
      path.slice('packages/'.length),
      JSON.parse(readFileSync(new URL(path + '/package.json', root))),
    ]),
  );
  const order = publishOrder(manifests);
  assert.equal(order.length, manifests.size);
  assert.equal(new Set(order).size, manifests.size);
  assert.equal(order.at(-1), 'margoengine');
  for (const [kit, members] of Object.entries(KIT_MEMBERS))
    for (const member of members) assert.ok(order.indexOf(member) < order.indexOf(kit), `${member} before ${kit}`);
  const workflow = readFileSync(new URL('.github/workflows/publish.yml', root), 'utf8');
  assert.match(workflow, /node scripts\/publish-order\.mjs/);
  assert.ok(workflow.indexOf('node scripts/publish-order.mjs >') < workflow.indexOf('while IFS= read -r workspace'));
  assert.doesNotMatch(workflow, /< <\(node scripts\/publish-order/);
  assert.doesNotMatch(workflow, /npm publish --workspace packages /);
});
