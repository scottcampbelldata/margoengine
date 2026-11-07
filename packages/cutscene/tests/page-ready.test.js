// The browser suites' plumbing, on the CPU: each one finds its page from the folder test:gpu runs it in, and a page that
// never gets ready names why instead of only timing out.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { waitReady, watchPage } from './page-ready.mjs';

const pkg = resolve(import.meta.dirname, '..');

test('every browser suite in test:gpu finds its page in the folder the dev server serves', () => {
  // The dev server serves the directory a suite runs in (scripts/browser.js), and test:gpu runs from the package folder
  // until a `cd`: a suite run there asked for /packages/cutscene/... under packages/cutscene and waited out its minute.
  const script = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).scripts['test:gpu'],
    tokens = script.split(/\s+/),
    suites = [];
  let dir = pkg;
  tokens.forEach((token, i) => {
    if (token === 'cd') dir = resolve(dir, tokens[i + 1]);
    else if (/\.mjs$/.test(token) && tokens[i - 1] === 'node') suites.push({ file: resolve(dir, token), served: dir });
  });
  assert.equal(suites.length, 3);
  for (const { file, served } of suites) {
    const startPath = /startPath: '([^']+)'/.exec(readFileSync(file, 'utf8'))?.[1];
    assert.ok(startPath, `${file} names its page`);
    assert.ok(existsSync(join(served, startPath)), `${startPath} is under ${served}, where ${file} runs`);
  }
});

/** A page stand-in: `waitForFunction` times out, and `evaluate` answers `state`. */
const page = (state) => {
  const handlers = {};
  return {
    reloads: 0,
    on: (name, handler) => (handlers[name] = handler),
    emit: (name, value) => handlers[name](value),
    async reload() {
      this.reloads++;
    },
    waitForFunction: async () => {
      throw new Error('page.waitForFunction: Timeout 5ms exceeded.');
    },
    evaluate: async () => {
      if (state instanceof Error) throw state;
      return state;
    },
  };
};

test('a page that never gets ready names its errors', async () => {
  const fake = page({
      url: 'http://127.0.0.1:1/x.html',
      status: 200,
      title: 'x',
      scripts: ['http://127.0.0.1:1/x.js'],
    }),
    errors = await watchPage(fake);
  assert.equal(fake.reloads, 1, 'loaded again, so an error at load is heard');
  fake.emit('pageerror', new Error('boom at load'));
  fake.emit('console', { type: () => 'error', text: () => 'Failed to load resource: 404' });
  fake.emit('console', { type: () => 'log', text: () => 'chatter' });
  const thrown = await waitReady(fake, errors, { timeout: 5, root: '/repo' }).catch((error) => error);
  assert.match(thrown.message, /never set window\.ready in 5 ms/);
  assert.match(thrown.message, /boom at load \| Failed to load resource: 404\./);
  assert.doesNotMatch(thrown.message, /chatter|no script of its own/);
  assert.match(thrown.cause.message, /Timeout/);
});

test('a page with no script of its own says the served folder may not hold it', async () => {
  const fake = page({ url: 'http://127.0.0.1:1/x.html', status: 404, title: '', scripts: [] }),
    thrown = await waitReady(fake, [], { timeout: 5, root: '/repo/packages/cutscene' }).catch((error) => error);
  assert.match(thrown.message, /Page errors: none\./);
  assert.match(thrown.message, /"status":404/);
  assert.match(thrown.message, /served from \/repo\/packages\/cutscene\. The page has no script of its own/);
});

test('a page that cannot be read still names the timeout', async () => {
  const thrown = await waitReady(page(new Error('Target closed')), [], { timeout: 5 }).catch((error) => error);
  assert.match(thrown.message, /never set window\.ready.*"unreadable":"Target closed"/);
});
