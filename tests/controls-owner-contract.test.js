import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { parseSync } from 'rolldown/utils';

test('all three Controls wrapper registrations retain the object used for scene cleanup', () => {
  let total = 0;
  for (const file of readdirSync('packages/controls/src').filter((name) => name.endsWith('.ts'))) {
    const source = readFileSync(`packages/controls/src/${file}`, 'utf8');
    const { program } = parseSync(file, source);
    let registrations = 0,
      resolutions = 0,
      nameOnly = 0;
    function visit(node) {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression') {
        const method = node.callee.property.name;
        if (method === 'use') {
          registrations++;
          assert.equal(node.arguments[0].type, 'Identifier', `${file}: preserve registration identity`);
        }
        if (method === 'sceneOf') resolutions++;
        if (method === 'removePlugin' && !source.slice(node.start, node.end).includes('.sceneOf(')) nameOnly++;
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) for (const child of value) visit(child);
        else if (value && typeof value === 'object') visit(value);
      }
    }
    visit(program);
    if (registrations) {
      total += registrations;
      assert.equal(resolutions, registrations, file);
      assert.equal(nameOnly, 0, file);
    }
  }
  assert.equal(total, 3);
});
