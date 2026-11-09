import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGlobalReports } from '../scripts/api-report-globals.mjs';

const options = {
  key: (path) => path.replaceAll('\\', '/').toLowerCase(),
  compare: (a, b) => (a < b ? -1 : a > b ? 1 : 0),
  render: (statement) => statement.global,
};

test('all entries share one snapshot list and one ordered global walk per package', async () => {
  const names = ['C:/p/B/z.d.ts', 'C:/p/A/z.d.ts', 'C:/p/A/a.d.ts', 'C:/p/Able/other.d.ts'];
  let lists = 0;
  const loaded = [],
    visited = [];
  const globals = createGlobalReports(
    {
      async getSourceFileNames() {
        lists++;
        return names;
      },
      async getSourceFile(path) {
        loaded.push(path);
        return { statements: [{ global: path }, {}, { global: 'declare global { shared: true }' }] };
      },
    },
    {
      ...options,
      render: (statement) => {
        visited.push(statement);
        return options.render(statement);
      },
    },
  );
  const [first, second, other] = await Promise.all([globals('c:/p/a/'), globals('c:/p/a/'), globals('c:/p/b/')]);
  assert.equal(first, ['C:/p/A/a.d.ts', 'declare global { shared: true }', 'C:/p/A/z.d.ts'].join('\n\n'));
  assert.equal(second, first);
  assert.equal(other, 'C:/p/B/z.d.ts\n\ndeclare global { shared: true }');
  assert.equal(await globals('c:/p/a/'), first);
  assert.equal(lists, 1);
  assert.equal(loaded.length, 3);
  assert.equal(visited.length, 9);
  assert.deepEqual(names, ['C:/p/B/z.d.ts', 'C:/p/A/z.d.ts', 'C:/p/A/a.d.ts', 'C:/p/Able/other.d.ts']);
});

test('missing source files and packages with no augmentations produce no globals', async () => {
  const globals = createGlobalReports(
    {
      async getSourceFileNames() {
        return ['C:/p/a/a.d.ts', 'C:/p/a/z.d.ts'];
      },
      async getSourceFile(path) {
        return path.endsWith('a.d.ts') ? undefined : { statements: [{}] };
      },
    },
    options,
  );
  assert.equal(await globals('c:/p/a/'), '');
  assert.equal(await globals('c:/p/b/'), '');
});

test('a failed snapshot query remains a failure for every entry without retrying it', async () => {
  const error = new Error('snapshot read failed');
  let lists = 0;
  const globals = createGlobalReports(
    {
      async getSourceFileNames() {
        lists++;
        throw error;
      },
    },
    options,
  );
  await assert.rejects(globals('c:/p/a/'), (cause) => cause === error);
  await assert.rejects(globals('c:/p/a/'), (cause) => cause === error);
  await assert.rejects(globals('c:/p/b/'), (cause) => cause === error);
  assert.equal(lists, 1);
});
