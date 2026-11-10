// `npm run check:dev-servers`: every Vite dev server a newcomer can start from this checkout starts clean.
// It reads each package.json in the repository (the root, the workspace packages, the apps and the examples) for its
// `dev*`, `serve*` and `preview*` scripts that run `vite` (the `scripts/dev-examples.mjs` wrapper counts as the root
// `vite`), starts each one on its own port with a hard time limit, waits for the dependency scan to settle, fetches
// the first page and the modules it names, and fails on any warning or error line in the server output (failed
// dependency scan, unresolved import, missing file) or any non-200 answer. Every server is killed with its process
// tree afterwards. Servers that are not Vite (Next.js, plain Node) and the `create-margo` templates (they install
// their own dependencies) are listed as not covered. No GPU is used.
// Usage: node scripts/check-dev-servers.mjs [--only=<text in "<package.json path> <script>">] [--list]
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const viteBin = join(dirname(fileURLToPath(import.meta.resolve('vite/package.json'))), 'bin', 'vite.js');
const SERVER_LIMIT_MS = 90_000;
const LISTEN_LIMIT_MS = 40_000;
const SETTLE_MS = 6_000;
const BASE_PORT = 5400;
const BAD_LINE = /\(!\)|\berror\b|\bwarn(ing)?\b|failed|cannot find|could not resolve|not found|no matching export/i;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'test-results', 'private', '.lane', 'create-margo']);

const only = process.argv.find((arg) => arg.startsWith('--only='))?.slice(7);
const listOnly = process.argv.includes('--list');

function packageFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || name.startsWith('margoengine-lane')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) packageFiles(full, out);
    else if (name === 'package.json') out.push(full);
  }
  return out;
}

/** The `vite` arguments of a script, or null when the script does not run Vite (or only chains to another script). */
function viteArgs(command) {
  const last = command.split('&&').pop().trim();
  const wrapper = /^node scripts\/dev-examples\.mjs\b(.*)$/.exec(last);
  if (wrapper) return wrapper[1].trim().split(/\s+/).filter(Boolean);
  const match = /^vite(\s+(.*))?$/.exec(last);
  return match ? (match[2] ?? '').trim().split(/\s+/).filter(Boolean) : null;
}

const servers = [];
const notCovered = [];
for (const file of packageFiles(root)) {
  const dir = dirname(file);
  const scripts = JSON.parse(readFileSync(file, 'utf8')).scripts ?? {};
  for (const [name, command] of Object.entries(scripts)) {
    if (!/^(modern:)?(dev|serve|preview|start)\b/.test(name)) continue;
    const label = `${relative(root, file).replace(/\\/g, '/')} ${name}`;
    const args = viteArgs(command);
    if (!args) {
      if (!/^npm run /.test(command.split('&&').pop().trim())) notCovered.push(`${label} (${command})`);
      continue;
    }
    if (args[0] === 'preview') continue;
    // `--open <page>` names the first page; `vite <directory>` (dev:sandbox, dev:voxel) serves that directory.
    const openAt = args.indexOf('--open');
    const open = openAt >= 0 && args[openAt + 1]?.startsWith('/') ? args[openAt + 1] : undefined;
    const withoutOpen = open ? args.filter((_, i) => i !== openAt && i !== openAt + 1) : args;
    // The check picks the host and port itself.
    const rest = withoutOpen.filter((arg, i) => !['--host', '--port', '--strictPort'].includes(arg) && !['--host', '--port'].includes(withoutOpen[i - 1]));
    const directory = rest.find((arg, i) => !arg.startsWith('-') && rest[i - 1] !== '--config' && rest[i - 1] !== '--port');
    servers.push({ label, command, cwd: directory ? resolve(dir, directory) : dir, args: rest.filter((arg) => arg !== directory), open });
  }
}

function firstPage(server) {
  if (server.open) return server.open;
  for (const sub of ['', 'examples/', 'docs/']) if (existsSync(join(server.cwd, sub, 'index.html'))) return `/${sub}${sub ? 'index.html' : ''}`;
  return '/';
}

function killTree(child) {
  if (child.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGKILL');
}

async function get(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  return { status: response.status, body: await response.text() };
}

async function runServer(server, port) {
  const args = [viteBin, ...server.args, '--host', '127.0.0.1', '--port', String(port), '--strictPort', '--force'];
  const lines = [];
  const child = spawn(process.execPath, args, { cwd: server.cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const onData = (chunk) => lines.push(...chunk.toString().replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/).filter(Boolean));
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  const problems = [];
  const deadline = setTimeout(() => killTree(child), SERVER_LIMIT_MS);
  try {
    const started = Date.now();
    while (!lines.some((line) => /Local:/.test(line))) {
      if (child.exitCode !== null) throw new Error(`exited ${child.exitCode} before listening`);
      if (Date.now() - started > LISTEN_LIMIT_MS) throw new Error(`did not listen within ${LISTEN_LIMIT_MS / 1000} s`);
      await new Promise((r) => setTimeout(r, 200));
    }
    const url = `http://127.0.0.1:${port}${firstPage(server)}`;
    const { status, body } = await get(url);
    if (status !== 200) problems.push(`${url} answered ${status}`);
    for (const [, src] of body.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)) {
      if (/^https?:/.test(src)) continue;
      const moduleUrl = new URL(src, url).href;
      const module = await get(moduleUrl);
      if (module.status !== 200) problems.push(`${moduleUrl} answered ${module.status}`);
    }
    // The dependency scan and pre-bundling report after the first request; give them time to settle.
    await new Promise((r) => setTimeout(r, SETTLE_MS));
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(deadline);
    killTree(child);
  }
  for (const line of lines) if (BAD_LINE.test(line)) problems.push(`output: ${line.trim().slice(0, 240)}`);
  return { problems, lines };
}

const chosen = servers.filter((server) => !only || server.label.includes(only));
if (listOnly) {
  for (const server of chosen) console.log(`${server.label}: ${server.command}`);
  for (const line of notCovered) console.log(`not covered: ${line}`);
  process.exit(0);
}
let failures = 0;
for (const [index, server] of chosen.entries()) {
  const { problems, lines } = await runServer(server, BASE_PORT + index);
  if (problems.length === 0) console.log(`ok   ${server.label}`);
  else {
    failures += 1;
    console.error(`FAIL ${server.label}`);
    for (const problem of problems) console.error(`     ${problem}`);
    if (process.env.MARGO_DEV_SERVERS_VERBOSE) for (const line of lines) console.error(`     | ${line}`);
  }
}
for (const line of notCovered) console.log(`not covered (not Vite): ${line}`);
if (failures > 0) {
  console.error(`${failures} dev server(s) did not start clean.`);
  process.exit(1);
}
console.log(`${chosen.length} dev servers started clean.`);
