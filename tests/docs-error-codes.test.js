// Bug (2026-11-12): MargoErrorCode gained `timeout` and `version`, but docs/api-overview.md still listed five codes and
// docs/conventions.md and the type's own doc comment had no `version`. Every code a MargoError can carry is documented
// in all three places.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const source = read('packages/math/src/errors.ts');
const union = /export type MargoErrorCode =([^;]+);/.exec(source);
assert.ok(union, 'packages/math/src/errors.ts still declares MargoErrorCode');
const codes = [...union[1].matchAll(/'([a-z-]+)'/g)].map((match) => match[1]);

test('MargoErrorCode lists the codes this test reads', () => {
  assert.ok(codes.length >= 7, `found ${codes.join(', ')}`);
});

for (const code of codes) {
  test(`error code \`${code}\` is documented`, () => {
    const tick = `\`${code}\``;
    assert.ok(source.includes(` * - ${tick}:`), `the MargoErrorCode doc comment explains ${tick}`);
    assert.ok(read('docs/conventions.md').includes(`| ${tick} |`), `docs/conventions.md has a ${tick} row`);
    const errors = /## Errors\r?\n([\s\S]*?)(?:\r?\n## |$)/.exec(read('docs/api-overview.md'));
    assert.ok(errors, 'docs/api-overview.md has an Errors section');
    assert.ok(errors[1].includes(`\`${code}\``), `docs/api-overview.md's Errors section names \`${code}\``);
  });
}
