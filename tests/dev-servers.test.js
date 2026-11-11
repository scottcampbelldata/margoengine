// `vite` started at the repository root (`npm run modern:dev:extensions`, `npm run dev:examples`) printed "Failed to run
// dependency scan. Skipping dependency pre-bundling" because the scan read every HTML file in the checkout, the rival
// comparison pages included: they import engines that are deliberately not installed here and are served by their own
// scripts, never by Vite. The root vite.config.mjs keeps them out of the scan. This starts the root dev server with a
// fresh dependency cache and fails on any warning or error line (scripts/check-dev-servers.mjs, which verify runs for
// every dev server in the repository).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

test('the root dev server starts without a dependency scan failure', { timeout: 150_000 }, () => {
  const run = spawnSync(process.execPath, [join(root, 'scripts/check-dev-servers.mjs'), '--only=package.json modern:dev:extensions'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 140_000,
    killSignal: 'SIGKILL',
  });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /ok\s+package\.json modern:dev:extensions/);
});

test('the root Vite config leaves the rival comparison pages out of the dependency scan', () => {
  const config = readFileSync(join(root, 'vite.config.mjs'), 'utf8');
  for (const page of ['scripts/rival-*.html', 'scripts/sciviz-compare/**', 'packages/*/scripts/rival-page.html']) {
    assert.ok(config.includes(`'!${page}'`), `${page} is excluded`);
  }
});

// The scan also skips every top-level folder git ignores (test output, lane scratch and local-only folders). The names
// come from git at load time, so the tracked config names none of the local-only ones (tests/no-private-paths.test.js).
test('the root Vite config leaves every top-level git-ignored folder out of the dependency scan', async () => {
  const { default: config, ignoredRootFolders } = await import('../vite.config.mjs'),
    folders = ignoredRootFolders(),
    { entries } = config.optimizeDeps;
  assert.ok(folders.includes('node_modules/'), `git lists the ignored folders: ${folders}`);
  for (const folder of folders) assert.ok(entries.includes(`!${folder}**`), `${folder} is excluded`);
});

// The probe behind check:dev-servers and the template check: a clean server passes; a warning line, a missing module
// and a server that never answers each fail it.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { probe } from '../scripts/support/dev-server-probe.mjs';

function fixture(source) {
  const dir = mkdtempSync(join(tmpdir(), 'margo-probe-'));
  writeFileSync(join(dir, 'server.mjs'), source);
  return dir;
}
const serverSource = (body, main = 'import "/dep.js";') => `
import http from 'node:http';
const port = Number(process.argv[2]);
http.createServer((request, response) => {
  if (request.url === '/') { response.setHeader('content-type', 'text/html'); response.end('<script type="module" src="/main.js"></script>'); }
  else if (request.url === '/main.js') { response.setHeader('content-type', 'text/javascript'); response.end(${JSON.stringify(main)}); }
  else if (request.url === '/dep.js') { response.setHeader('content-type', 'text/javascript'); response.end('export {};'); }
  else { response.statusCode = 404; response.end(); }
}).listen(port, '127.0.0.1', () => { ${body} });
`;
async function run(source, port) {
  const dir = fixture(source);
  try {
    return await probe({ command: process.execPath, args: ['server.mjs', String(port)], cwd: dir, page: `http://127.0.0.1:${port}/`, settleMs: 200, listenLimitMs: 10_000, limitMs: 30_000 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the probe passes a clean server and follows the modules a page loads', async () => {
  const { problems } = await run(serverSource("console.log('Local: ready');"), 5701);
  assert.deepEqual(problems, []);
});

test('the probe fails on a warning line in the server output', async () => {
  const { problems } = await run(serverSource("console.warn('(!) Failed to run dependency scan.');"), 5702);
  assert.ok(problems.some((p) => p.startsWith('output:')), problems.join('\n'));
});

test('the probe fails on a module the page loads that does not exist', async () => {
  const source = serverSource('', 'import "/missing.js";');
  const { problems } = await run(source, 5703);
  assert.ok(problems.some((p) => /missing\.js answered 404/.test(p)), problems.join('\n'));
});

test('the probe fails on a server that exits before it answers', async () => {
  const { problems } = await run('process.exit(3);', 5704);
  assert.ok(problems.some((p) => /exited 3/.test(p)), problems.join('\n'));
});

test('every start command in the documentation maps to a checked server', { timeout: 60_000 }, () => {
  const run = spawnSync(process.execPath, [join(root, 'scripts/check-dev-servers.mjs'), '--docs-only'], { cwd: root, encoding: 'utf8', timeout: 50_000 });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
});
