// check:merge runs verify's full unit suite, including this pass-state audit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { parseSync } from 'rolldown/utils';
function missing(source) {
  const { program, comments } = parseSync('passes.ts', source),
    problems = [];
  function visit(node, ancestors = []) {
    if (!node || typeof node !== 'object') return;
    if (
      node.type === 'CallExpression' &&
      node.callee.type === 'MemberExpression' &&
      node.callee.property.name === 'beginRenderPass'
    ) {
      const statement = ancestors.findLast((n) => n.type === 'VariableDeclaration' || n.type === 'ExpressionStatement');
      const comment = comments.findLast(
        (c) => c.end <= statement.start && !source.slice(c.end, statement.start).trim(),
      );
      const local = comment && /view-state: (offscreen|resolve-only|clear-only) .+/.test(comment.value);
      if (local) {
        if (/view:\s*(?:c|context)\.color\b/.test(source.slice(statement.start, statement.end)))
          problems.push(node.start);
      } else {
        const block = ancestors.findLast((n) => n.type === 'BlockStatement');
        const tail = source.slice(node.end, block.end),
          draw = tail.search(/\b\w+\.draw(?:Indexed)?\(/);
        if (!/applyView\(/.test(tail.slice(0, draw < 0 ? tail.length : draw))) problems.push(node.start);
      }
    }
    for (const value of Object.values(node))
      if (Array.isArray(value)) for (const child of value) visit(child, [...ancestors, node]);
      else if (value && typeof value === 'object') visit(value, [...ancestors, node]);
  }
  visit(program);
  return problems;
}
test('environment and staging render passes declare and apply their view state', () => {
  for (const packageName of ['environment', 'staging'])
    for (const file of readdirSync(`packages/${packageName}/src`))
      if (file.endsWith('.ts')) {
        assert.deepEqual(
          missing(readFileSync(`packages/${packageName}/src/${file}`, 'utf8')),
          [],
          `${packageName}/${file}`,
        );
      }
});
test('pass-state audit rejects a missing applyView and a mislabeled scene attachment', () => {
  const bad =
    'function draw(c){const pass=c.encoder.beginRenderPass({colorAttachments:[{view:c.color}]});pass.draw(3);pass.end();}';
  assert.equal(missing(bad).length, 1);
  assert.equal(missing(bad.replace('pass.draw', 'applyView(pass,c);pass.draw')).length, 0);
  assert.equal(
    missing(bad.replace('const pass', '// view-state: offscreen incorrectly claimed\nconst pass')).length,
    1,
  );
});
