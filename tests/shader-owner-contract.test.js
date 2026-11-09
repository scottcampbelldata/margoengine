import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { parseSync } from 'rolldown/utils';

function missing(source) {
  const { program } = parseSync('owner.ts', source),
    problems = [];
  let checked = 0;
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'ClassDeclaration' && node.implements?.some((i) => i.expression?.name === 'EnginePlugin')) {
      checked++;
      const dispose = node.body.body.find((m) => m.key?.name === 'dispose');
      const body = dispose && source.slice(dispose.start, dispose.end);
      if (!body || !/\.sceneOf\(this\)/.test(body) || /\bengine\??\.removePlugin\(/.test(body))
        problems.push(node.id.name);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) for (const child of value) visit(child);
      else if (value && typeof value === 'object') visit(value);
    }
  }
  visit(program);
  return { checked, problems };
}

test('shader EnginePlugin cleanup removes actual scene ownership', () => {
  let checked = 0;
  for (const file of readdirSync('packages/shader/src').filter((f) => f.endsWith('.ts'))) {
    const result = missing(readFileSync(`packages/shader/src/${file}`, 'utf8'));
    checked += result.checked;
    assert.deepEqual(result.problems, [], file);
  }
  assert.equal(checked, 4);
});
test('shader owner guard rejects absent and active-scene detachment', () => {
  const source = (body) => `class Pass implements EnginePlugin {dispose(){${body}}}`;
  for (const body of ['', 'engine.removePlugin(this.name)', 'this.engine=undefined'])
    assert.deepEqual(missing(source(body)).problems, ['Pass']);
  assert.deepEqual(missing(source('engine?.sceneOf(this)?.removePlugin(this.name)')).problems, []);
});
