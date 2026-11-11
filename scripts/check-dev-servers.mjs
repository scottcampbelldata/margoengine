// `npm run check:dev-servers`: every server a newcomer can start from this checkout starts clean, and every start
// command the documentation names is one of them.
//
// 1. It reads each package.json in the repository (the root, the apps, the examples and the packages) for the `dev*`,
//    `serve*`, `preview*`, `start` and `server` scripts. Vite servers (the `scripts/dev-examples.mjs` wrapper counts as the
//    root `vite`) start on their own port with a fresh dependency cache; Next.js packages run `next dev`, then
//    `next build` and `next start`; plain Node servers need a row in NODE_SERVERS below, so a new one cannot slip by.
// 2. Each is probed by scripts/support/dev-server-probe.mjs with a hard time limit: the first page and everything it
//    loads must answer 200, and no output line may be a warning or an error (failed dependency scan, unresolved
//    import, missing file). The process tree is killed afterwards.
// 3. Every start command in a fenced code block of a Markdown file (`npm run`, `npm create`, `npx`, `vite`, `next`)
//    must map to a script checked in step 1, to the template check (`npm create margo`, scripts/template-install-check.mjs
//    covers the five templates), or to a row of DOC_COMMANDS_ELSEWHERE that says which check owns it.
// The scaffolded templates install their own dependencies, so scripts/template-install-check.mjs runs them. No GPU.
// Usage: node scripts/check-dev-servers.mjs [--only=<text in "<package.json path> <script>">] [--list] [--docs-only]
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, humanEnv, probe, runToEnd } from './support/dev-server-probe.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageDir = (name) => dirname(fileURLToPath(import.meta.resolve(`${name}/package.json`)));
const viteBin = join(packageDir('vite'), 'bin', 'vite.js');
const SERVER_NAME = /^(modern:)?(dev|serve|preview|start|server)\b/;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'test-results', 'private', '.lane', '.next']);

/**
 * Plain Node servers, by `<package.json path> <script>`. `args` get the free ports the check picked (`ports` of them);
 * `page` is the first URL ('' for a server with no web page, which is then probed by a TCP connection to the first port).
 */
const NODE_SERVERS = {
  'examples/gameplay-sandbox/package.json dev:lan': {
    needsLan: true, // binds to the machine's private IPv4 address and writes a certificate; 5200 and 5201 by default
    ports: 2,
    args: ([port, certPort]) => [`--port=${port}`, `--cert-port=${certPort}`],
    page: (lan, [port]) => `https://${lan}:${port}/`,
    insecure: true,
    isolatedHome: true,
  },
  'examples/voxel-sandbox/package.json server': {
    ports: 1,
    args: ([port]) => [`--port=${port}`],
    page: () => '',
  },
};

/** Start commands in the documentation that this script does not run, each with the check that owns it. */
const DOC_COMMANDS_ELSEWHERE = [
  // [pattern of the command line, owner]
  [/^npm create margo\b/, 'scripts/template-install-check.mjs (all five templates, from the packed CLI)'],
];

const only = process.argv.find((arg) => arg.startsWith('--only='))?.slice(7);
const listOnly = process.argv.includes('--list');
const docsOnly = process.argv.includes('--docs-only');
const slash = (path) => path.replace(/\\/g, '/');

function packageFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || name.startsWith('margoengine-lane')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) packageFiles(full, out);
    else if (name === 'package.json') out.push(full);
  }
  return out;
}

/** The `vite` arguments of a script, or null when the script does not run Vite. */
function viteArgs(command) {
  const last = command.split('&&').pop().trim();
  const wrapper = /^node scripts\/dev-examples\.mjs\b(.*)$/.exec(last);
  if (wrapper) return wrapper[1].trim().split(/\s+/).filter(Boolean);
  const match = /^vite(\s+(.*))?$/.exec(last);
  return match ? (match[2] ?? '').trim().split(/\s+/).filter(Boolean) : null;
}

const privateIPv4 = () =>
  Object.values(networkInterfaces()).flat().find((a) => a.family === 'IPv4' && !a.internal && /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address))?.address;

const packages = new Map(); // relative package.json path -> { dir, manifest }
const servers = [];
const templateServers = new Set();
for (const file of packageFiles(root)) {
  const dir = dirname(file);
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  const path = slash(relative(root, file));
  packages.set(path, { dir, manifest });
  for (const [name, command] of Object.entries(manifest.scripts ?? {})) {
    if (!SERVER_NAME.test(name)) continue;
    const label = `${path} ${name}`;
    // The scaffolded templates install their own dependencies: scripts/template-install-check.mjs starts them.
    if (path.startsWith('tools/create-margo/templates/')) {
      templateServers.add(label);
      continue;
    }
    const last = command.split('&&').pop().trim();
    const args = viteArgs(command);
    if (args) {
      if (args[0] === 'preview') continue;
      // `--open <page>` names the first page; `vite <directory>` (dev:sandbox, dev:voxel) serves that directory.
      const openAt = args.indexOf('--open');
      const open = openAt >= 0 && args[openAt + 1]?.startsWith('/') ? args[openAt + 1] : undefined;
      const withoutOpen = open ? args.filter((_, i) => i !== openAt && i !== openAt + 1) : args;
      // The check picks the host and port itself.
      const rest = withoutOpen.filter((arg, i) => !['--host', '--port', '--strictPort'].includes(arg) && !['--host', '--port'].includes(withoutOpen[i - 1]));
      const directory = rest.find((arg, i) => !arg.startsWith('-') && rest[i - 1] !== '--config');
      servers.push({ kind: 'vite', label, command, cwd: directory ? resolve(dir, directory) : dir, args: rest.filter((arg) => arg !== directory), open });
    } else if (/^next (dev|start)\b/.test(last)) {
      const build = manifest.scripts?.build;
      servers.push({ kind: 'next', mode: last.split(/\s+/)[1], label, command, cwd: dir, args: last.split(/\s+/).slice(2), build });
    } else if (/^node /.test(last)) {
      servers.push({ kind: 'node', label, command, cwd: dir, config: NODE_SERVERS[label] });
    } else if (!/^npm run /.test(last)) {
      servers.push({ kind: 'unknown', label, command });
    }
  }
}

const runnable = servers.filter((server) => server.kind !== 'unknown' && (!only || server.label.includes(only)));
const checked = new Set([...templateServers, ...servers.filter((server) => server.kind !== 'unknown' && !(server.kind === 'node' && !server.config)).map((server) => server.label)]);

function firstPage(server) {
  if (server.open) return server.open;
  for (const sub of ['', 'examples/', 'docs/']) if (existsSync(join(server.cwd, sub, 'index.html'))) return `/${sub}${sub ? 'index.html' : ''}`;
  return '/';
}

// Every server starts on a port the operating system reports free at that moment, never a fixed one: other work on
// the machine (another lane's dev server or GPU suite) holds fixed ports, and probe() fails a server that exits
// because its port was taken, so an answer from someone else's server never passes.
async function runServer(server, report) {
  if (server.kind === 'vite') {
    const assigned = await freePort();
    return probe({
      command: process.execPath,
      args: [viteBin, ...server.args, '--host', '127.0.0.1', '--port', String(assigned), '--strictPort', '--force'],
      cwd: server.cwd,
      page: `http://127.0.0.1:${assigned}${firstPage(server)}`,
    });
  }
  if (server.kind === 'next') {
    const next = join(packageDir('next'), 'dist', 'bin', 'next');
    const env = { ...humanEnv(), NEXT_TELEMETRY_DISABLED: '1' };
    const withoutPort = server.args.filter((arg, i) => !['--port', '-p'].includes(arg) && !['--port', '-p'].includes(server.args[i - 1]));
    if (server.mode === 'start') {
      // `next start` serves what `next build` wrote; both must be clean.
      const buildCommand = server.build?.split(/\s+/).slice(1) ?? [];
      const built = await runToEnd({ command: process.execPath, args: [next, ...buildCommand], cwd: server.cwd, env });
      if (built.problems.length) return { problems: built.problems.map((p) => `build: ${p}`), lines: built.lines };
    }
    const assigned = await freePort();
    return probe({ command: process.execPath, args: [next, server.mode, ...withoutPort, '--port', String(assigned)], cwd: server.cwd, env, page: `http://127.0.0.1:${assigned}/` });
  }
  const config = server.config;
  if (!config) return { problems: [`no NODE_SERVERS row in scripts/check-dev-servers.mjs for \`${server.command}\`; add one so this server is started and checked`], lines: [] };
  let lan = '';
  if (config.needsLan) {
    lan = privateIPv4();
    if (!lan) {
      report.notRun.push(`${server.label}: this machine has no private IPv4 address, which the LAN server requires`);
      return { problems: [], lines: [] };
    }
  }
  const script = /^node (\S+)/.exec(server.command.split('&&').pop().trim())[1];
  const env = { ...process.env };
  if (config.isolatedHome) {
    // The LAN server writes a certificate under %LOCALAPPDATA% or the home folder; keep that out of the user's profile.
    const home = mkdtempSync(join(tmpdir(), 'margo-dev-servers-'));
    env.LOCALAPPDATA = home;
    env.HOME = home;
    env.USERPROFILE = home;
  }
  const ports = [];
  for (let i = 0; i < config.ports; i += 1) ports.push(await freePort(lan || '127.0.0.1'));
  if (new Set(ports).size !== ports.length) return { problems: [`the operating system gave the same free port twice: ${ports.join(', ')}`], lines: [] };
  return probe({
    command: process.execPath,
    args: [script, ...config.args(ports)],
    cwd: server.cwd,
    env,
    page: config.page(lan, ports),
    tcpPort: ports[0],
    insecure: config.insecure,
  });
}

// ---- Documentation commands ----

function markdownFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    if (name.startsWith('margoengine-lane') || name === 'CHANGELOG.md') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) markdownFiles(full, out);
    else if (name.endsWith('.md')) out.push(full);
  }
  return out;
}

const COMMAND = /^(?:\$\s*)?((?:npm (?:run|start|create|init|exec)\b|npx\b|pnpm\b|yarn\b|bun\b|vite(?:\s|$)|next (?:dev|start|build)\b).*?)(?:\s+#.*)?$/;

function docCommands() {
  const found = [];
  for (const file of markdownFiles(root)) {
    if (/(^|\/)docs\/(known-bugs|clean-room|limits)\.md$/.test(slash(relative(root, file))) || /whitepaper|work-lists|handoffs/.test(file)) continue;
    let inFence = false;
    for (const [index, line] of readFileSync(file, 'utf8').split(/\r?\n/).entries()) {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        continue;
      }
      if (!inFence) continue;
      const match = COMMAND.exec(line.trim());
      if (match) found.push({ file, line: index + 1, text: match[1].trim() });
    }
  }
  return found;
}

/** The workspace (by name or path) a command names, or the package that sits beside the Markdown file, or the root. */
function packageFor(file, workspaceName) {
  if (workspaceName) {
    for (const [path, { manifest }] of packages) if (manifest.name === workspaceName || dirname(path) === workspaceName.replace(/\/$/, '')) return path;
    return null;
  }
  const beside = slash(relative(root, join(dirname(file), 'package.json')));
  return packages.has(beside) ? beside : 'package.json';
}

/** The checked server scripts a `npm run` chain ends in, or null when the script is not a server. */
function terminals(packagePath, script, seen = new Set()) {
  const entry = packages.get(packagePath);
  const command = entry?.manifest.scripts?.[script];
  const label = `${packagePath} ${script}`;
  if (command === undefined || seen.has(label)) return command === undefined ? undefined : [];
  seen.add(label);
  const last = command.split('&&').pop().trim();
  const chained = /^npm run (\S+)(?:\s+(?:--workspace|-w)[ =](\S+))?/.exec(last);
  if (chained) {
    const target = chained[2] ? packageFor(entry.dir, chained[2]) : packagePath;
    return target ? (terminals(target, chained[1], seen) ?? []) : [];
  }
  if (/^(vite(?! build)|next (dev|start)|node scripts\/dev-examples)\b/.test(last)) return [label];
  if (SERVER_NAME.test(script) && !/^(vite|next|tsc)\b.*\bbuild\b/.test(last)) return [label];
  return [];
}

function checkDocs() {
  const problems = [];
  let commands = 0;
  for (const { file, line, text } of docCommands()) {
    const where = `${slash(relative(root, file))}:${line}`;
    const elsewhere = DOC_COMMANDS_ELSEWHERE.find(([pattern]) => pattern.test(text));
    if (elsewhere) {
      commands += 1;
      continue;
    }
    const run = /^npm (?:run |start|run-script )(\S+)?(.*)$/.exec(text);
    if (run || /^npm start\b/.test(text)) {
      const script = /^npm start\b/.test(text) ? 'start' : run[1];
      const workspace = /(?:--workspace|-w)[ =](\S+)/.exec(text)?.[1];
      const path = packageFor(file, workspace);
      let ends = path && terminals(path, script);
      if (ends === undefined && !workspace && path !== 'package.json') ends = terminals('package.json', script);
      if (ends === undefined) {
        // A script that is not in this repository's manifests: only a server start is a problem.
        if (SERVER_NAME.test(script)) problems.push(`${where}: \`${text}\` names a script no package.json has`);
        continue;
      }
      if (ends.length === 0) continue; // not a server start (build, test, bench ...)
      commands += 1;
      const missing = ends.filter((label) => !checked.has(label));
      if (missing.length) problems.push(`${where}: \`${text}\` starts ${missing.join(', ')}, which no check starts`);
      continue;
    }
    // npx vite, vite, next dev, pnpm dev ...: a server start in a project of the reader's own.
    if (/^(npx |pnpm |yarn |bun |vite\b|next\b|npm (create|init|exec))/.test(text) && /\b(vite|next|dev|start|serve|preview)\b/.test(text)) {
      problems.push(`${where}: \`${text}\` starts a server that no check covers; map it in DOC_COMMANDS_ELSEWHERE with the check that owns it`);
    }
  }
  return { problems, commands };
}

// ---- Main ----

if (listOnly) {
  for (const server of servers) console.log(`${server.label}: ${server.command}${server.kind === 'node' && !server.config ? '  (NO ROW)' : ''}`);
  process.exit(0);
}
let failures = 0;
const report = { notRun: [] };
if (!docsOnly) {
  for (const server of runnable) {
    const { problems, lines } = await runServer(server, report);
    if (problems.length === 0) console.log(`ok   ${server.label}`);
    else {
      failures += 1;
      console.error(`FAIL ${server.label}`);
      for (const problem of problems) console.error(`     ${problem}`);
      if (process.env.MARGO_DEV_SERVERS_VERBOSE) for (const line of lines) console.error(`     | ${line}`);
    }
  }
  for (const line of report.notRun) console.log(`not run: ${line}`);
}
for (const server of servers.filter((s) => s.kind === 'unknown')) {
  failures += 1;
  console.error(`FAIL ${server.label}: \`${server.command}\` is a server script this check does not know how to start`);
}
const docs = checkDocs();
if (docs.problems.length) {
  failures += docs.problems.length;
  for (const problem of docs.problems) console.error(`FAIL doc ${problem}`);
} else console.log(`ok   ${docs.commands} documented start commands map to a checked server`);
if (failures > 0) {
  console.error(`${failures} problem(s) with dev servers or documented start commands.`);
  process.exit(1);
}
if (!docsOnly) console.log(`${runnable.length} servers started clean.`);
