import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseSync } from 'rolldown/utils';

const folder = new URL('./', import.meta.url);
for (const file of readdirSync(folder, { recursive: true }).filter(
  (name) => /\.[cm]?js$/.test(name) && !/\.test\.[cm]?js$/.test(name),
)) {
  test(`browser/support module parses before GPU execution: ${file}`, { timeout: 15_000 }, () => {
    const result = spawnSync(process.execPath, ['--check', fileURLToPath(new URL(file.replaceAll('\\', '/'), folder))], {
      encoding: 'utf8', timeout: 10_000, windowsHide: true,
    });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  });
  test(`browser/support asset URLs are statically resolvable by Vite: ${file}`, () => {
    const source = readFileSync(new URL(file.replaceAll('\\', '/'), folder), 'utf8');
    const { program } = parseSync(file, source);
    const visit = (node) => {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'NewExpression' && node.callee.name === 'URL' && node.arguments.length > 1) {
        const base = node.arguments[1];
        if (source.slice(base.start, base.end) === 'import.meta.url') {
          const path = node.arguments[0];
          assert.ok(
            typeof path.value === 'string' || (path.type === 'TemplateLiteral' && path.expressions.length === 0),
            `${file}: use a literal asset path; Vite dynamic URL patterns omit nested fixture directories`,
          );
        }
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === 'object') visit(value);
      }
    };
    visit(program);
  });
}
