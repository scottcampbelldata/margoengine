// `npm run publish:rehearsal`: everything a first npm release does, except the release. It never publishes. No npm
// command here writes to a registry, and the stand-in registry below refuses every write (a write fails the run).
//
//   1. Packs every published package (packages/*, tools/margo-convert, tools/create-margo) into a temp folder.
//   2. Audits each tarball: manifest, exports, bin and types files present, LICENSE, NOTICE and README shipped, no test
//      or private files, no install script, no local dependency spec, no maintainer path or email, every bare import
//      in the shipped code declared, every internal dependency served at a version its range accepts.
//   3. Serves the tarballs from a stand-in registry on 127.0.0.1. Packages of ours come only from the tarballs (so the
//      real npm placeholder of margoengine is never seen); third-party metadata and tarballs are read from
//      registry.npmjs.org, read only.
//   4. In a clean temp project outside the repository, with an empty npm cache, runs the one line a reader runs,
//      `npm install margoengine`, then checks the result: the version installed, every margoengine entry imports in
//      Node with nothing but its own optional library added, every entry type-checks with skipLibCheck off, and the
//      README's first example builds with Vite.
//   5. `npm create margo` for every template through the same registry: scaffold, install, build. margo-convert --help.
//
// A browser render from tarballs is `npm run check:quickstart`; this script covers what that one cannot, the registry
// resolution of the one-line install.
//   node scripts/publish-rehearsal.mjs [--no-build] [--tarballs=<folder>] [--keep] [--limit=<seconds, default 1500>]
//     [--templates=web,game,viz,react,next]
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { builtinModules } from 'node:module';
import { homedir, tmpdir, userInfo } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { killTree, windowsCommandLine } from './gpu-lock.mjs';
import { publishedPackages } from './supply-chain.mjs';

const root = resolve(import.meta.dirname, '..');
const windows = process.platform === 'win32';
const UPSTREAM = 'https://registry.npmjs.org';

export const internalName = (name) =>
  name === 'margoengine' || name === 'create-margo' || name === 'margo-convert' || name.startsWith('@margoengine/');

/** Every file of an npm tarball: Map of path (without the leading package/) to its bytes. */
export function readTarball(gzipped) {
  const tar = gunzipSync(gzipped),
    files = new Map(),
    text = (from, length) => tar.toString('latin1', from, from + length).replace(/\0.*$/s, '');
  let longName = '';
  for (let at = 0; at + 512 <= tar.length && tar[at] !== 0; ) {
    const size = Number.parseInt(text(at + 124, 12).trim() || '0', 8),
      type = String.fromCharCode(tar[at + 156] || 48),
      body = tar.subarray(at + 512, at + 512 + size);
    if (type === 'x') longName = /\d+ path=([^\n]*)\n/.exec(body.toString('utf8'))?.[1] ?? '';
    else if (type === '0') {
      const prefix = tar.toString('latin1', at + 257, at + 263).startsWith('ustar') ? text(at + 345, 155) : '';
      const path = longName || (prefix ? `${prefix}/` : '') + text(at, 100);
      files.set(path.replace(/^[^/]*\//, ''), body);
      longName = '';
    }
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

/** The file paths an exports value names, whatever the nesting of conditions. */
export function exportTargets(value) {
  if (typeof value === 'string') return [value];
  if (value === null || typeof value !== 'object') return [];
  return Object.values(value).flatMap(exportTargets);
}

/** The package a bare import belongs to, or undefined for relative, URL and Node built-in imports. */
export function packageOf(specifier) {
  if (/^(\.|\/|[a-z][a-z0-9+.-]*:)/i.test(specifier)) return undefined;
  const parts = specifier.split('/'),
    name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  return builtinModules.includes(name) ? undefined : name;
}

/** Bare and relative imports of a piece of JavaScript: static, re-export and literal dynamic ones. */
export function importsOf(code) {
  const out = new Set();
  const stripped = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const pattern of [
    /(?:^|[\s;}])(?:import|export)\s[^'"`;]*?\sfrom\s*['"]([^'"]+)['"]/g,
    /(?:^|[\s;}])import\s*['"]([^'"]+)['"]/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  ])
    for (const match of stripped.matchAll(pattern)) if (/^[@\w./:-]+$/.test(match[1])) out.add(match[1]);
  return [...out];
}

/** Does a range this repository writes (`1.0.0`, `^1.0.0`, `>=1.0.0`, `*`) accept the lockstep version? */
export function rangeAccepts(range, version) {
  if (range === '*' || range === version) return true;
  const caret = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range);
  if (!caret) return false;
  const [major, minor, patch] = version.split('.').map(Number),
    [wantMajor, wantMinor, wantPatch] = caret.slice(1).map(Number);
  if (major !== wantMajor) return false;
  return minor > wantMinor || (minor === wantMinor && patch >= wantPatch);
}

/** Imports a package makes without declaring them: each is looked up in a try and documented as the user's choice. */
const OPTIONAL_LOOKUPS = { 'margo-convert': ['sharp'] };

const INSTALL_HOOKS = ['preinstall', 'install', 'postinstall'];
const FORBIDDEN_FILE = /(^|\/)(tests?|__tests__|private|\.lane|\.env[^/]*|\.npmrc)(\/|$)|\.test\.[cm]?[jt]sx?$/;
const TEXT_FILE = /\.(c?m?js|ts|json|md|txt|html|css|wgsl)$/;

/**
 * Every reason one tarball must not be published. `files` is readTarball's map, `names` maps each of our package names
 * to the version being released, `secrets` lists strings no shipped text file may contain.
 */
export function auditTarball(files, names, secrets = []) {
  const problems = [],
    raw = files.get('package.json');
  if (!raw) return ['no package.json in the tarball'];
  const manifest = JSON.parse(raw.toString('utf8')),
    who = manifest.name,
    say = (message) => problems.push(`${who}: ${message}`);
  if (manifest.private) say('"private": true');
  if (names[who] !== manifest.version) say(`version ${manifest.version} is not the release version ${names[who]}`);
  for (const need of ['LICENSE', 'NOTICE', 'README.md']) if (!files.has(need)) say(`${need} is not in the tarball`);
  for (const hook of INSTALL_HOOKS) if (manifest.scripts?.[hook]) say(`install script "${hook}"`);
  const has = (path) => {
    const wanted = path.replace(/^\.\//, '');
    if (!wanted.includes('*')) return files.has(wanted);
    const [head, tail] = wanted.split('*');
    return [...files.keys()].some((f) => f.startsWith(head) && f.endsWith(tail));
  };
  const targets = [
    ...exportTargets(manifest.exports),
    ...exportTargets(typeof manifest.bin === 'string' ? { [who]: manifest.bin } : manifest.bin),
    ...[manifest.main, manifest.module, manifest.types].filter(Boolean),
  ];
  for (const target of new Set(targets)) if (!has(target)) say(`${target} is named by the manifest but not shipped`);
  for (const path of files.keys()) if (FORBIDDEN_FILE.test(path)) say(`ships ${path}`);
  const declared = new Set([
    who,
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
    ...(OPTIONAL_LOOKUPS[who] ?? []),
  ]);
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies'])
    for (const [name, range] of Object.entries(manifest[field] ?? {})) {
      if (/^(workspace|file|link|git|github|https?):/.test(range)) say(`${name} has the local spec ${range}`);
      if (!internalName(name)) continue;
      if (!names[name]) say(`depends on ${name}, which is not in this release`);
      else if (!rangeAccepts(range, names[name])) say(`${name} ${range} does not accept ${names[name]}`);
    }
  for (const [path, bytes] of files) {
    if (!TEXT_FILE.test(path)) continue;
    const code = bytes.toString('utf8');
    for (const secret of secrets) if (code.includes(secret)) say(`${path} contains a maintainer path or email`);
    // Templates are copied into a new app with its own manifest: their imports are that app's, not this package's.
    if (!/\.(c?m?js)$/.test(path) || path.startsWith('templates/')) continue;
    for (const specifier of importsOf(code)) {
      const name = packageOf(specifier);
      if (name && !declared.has(name)) say(`${path} imports ${specifier}, which the manifest does not declare`);
    }
  }
  return problems;
}

/** The packument npm reads for one of our packages. */
export function packument(manifest, tarballUrl, bytes) {
  const version = {
    ...manifest,
    _id: `${manifest.name}@${manifest.version}`,
    dist: {
      tarball: tarballUrl,
      shasum: createHash('sha1').update(bytes).digest('hex'),
      integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    },
  };
  return {
    _id: manifest.name,
    name: manifest.name,
    'dist-tags': { latest: manifest.version },
    versions: { [manifest.version]: version },
  };
}

/**
 * The stand-in registry. `packages` maps a name to {manifest, bytes}. Reads of anything else go to `upstream`. Writes
 * are refused and recorded in `refused`, because nothing in a rehearsal may publish.
 */
export function startRegistry(packages, upstream = UPSTREAM) {
  const refused = [],
    served = new Set(),
    relayed = new Set();
  const server = createServer(async (request, response) => {
    const send = (status, body, type = 'application/json') => {
      response.writeHead(status, { 'content-type': type });
      response.end(body);
    };
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      refused.push(`${request.method} ${request.url}`);
      return send(405, JSON.stringify({ error: 'the rehearsal registry refuses writes' }));
    }
    const path = decodeURIComponent(new URL(request.url, 'http://x').pathname).slice(1);
    const own = /^-\/own\/(.+)\.tgz$/.exec(path);
    if (own) {
      const found = packages.get(own[1].replaceAll('~', '/'));
      if (!found) return send(404, '{}');
      return send(200, found.bytes, 'application/octet-stream');
    }
    const found = packages.get(path);
    if (found) {
      served.add(path);
      const { port } = server.address();
      const url = `http://127.0.0.1:${port}/-/own/${path.replaceAll('/', '~')}.tgz`;
      return send(200, JSON.stringify(packument(found.manifest, url, found.bytes)));
    }
    if (internalName(path)) return send(404, JSON.stringify({ error: `${path} is not in this release` }));
    try {
      const reply = await fetch(`${upstream}/${path.replace('/', '%2f')}`, {
        headers: { accept: request.headers.accept ?? 'application/json' },
      });
      relayed.add(path);
      send(reply.status, Buffer.from(await reply.arrayBuffer()), reply.headers.get('content-type') ?? 'application/json');
    } catch (error) {
      send(502, JSON.stringify({ error: String(error) }));
    }
  });
  return new Promise((done) => {
    server.listen(0, '127.0.0.1', () =>
      done({ url: `http://127.0.0.1:${server.address().port}/`, refused, served, relayed, close: () => server.close() }),
    );
  });
}

/** The terminal of a new reader: no npm_* variables, no repository .bin on PATH. */
function readerEnv(extra) {
  const env = {};
  for (const [key, value] of Object.entries(process.env))
    if (!/^npm_/i.test(key) && key !== 'INIT_CWD') env[key] = value;
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path');
  if (pathKey)
    env[pathKey] = env[pathKey]
      .split(delimiter)
      .filter((p) => !/node_modules[\\/]\.bin$/.test(p))
      .join(delimiter);
  return { ...env, ...extra };
}

/** Runs a command to its end with a time limit; rejects with its output on failure. */
function run(command, args, { cwd, env, seconds = 300 }) {
  return new Promise((done, fail) => {
    const options = { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] };
    const child = windows
      ? spawn(windowsCommandLine([command, ...args]), { ...options, shell: true })
      : spawn(command, args, options);
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    const timer = setTimeout(() => {
      killTree(child.pid);
      fail(new Error(`${command} ${args.join(' ')}: timed out after ${seconds} s\n${output.slice(-3000)}`));
    }, seconds * 1000);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) done(output);
      else fail(new Error(`${command} ${args.join(' ')}: exit ${code}\n${output.slice(-6000)}`));
    });
  });
}

const folderBytes = (dir) =>
  readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile())
    .reduce((sum, e) => sum + statSync(join(e.parentPath, e.name)).size, 0);

/** Strings that must never ship: this machine's home folder, user name path and the committer's own email. */
function secretsOfThisMachine() {
  const secrets = [homedir(), homedir().replaceAll('\\', '/'), homedir().replaceAll('\\', '\\\\')];
  if (userInfo().username.length > 3) secrets.push(`Users/${userInfo().username}`, `Users\\${userInfo().username}`);
  for (const key of ['user.email']) {
    const value = execFileSync('git', ['config', key], { cwd: root, encoding: 'utf8' }).trim();
    if (value && !value.endsWith('@users.noreply.github.com')) secrets.push(value);
  }
  return [...new Set(secrets)];
}

/** Entries that need an optional library installed first, and the libraries the check adds for them. */
const OPTIONAL_LIBRARIES = ['react', 'react-dom', '@dimforge/rapier3d-compat', '@dimforge/rapier2d-compat'];

/** What the app itself installs to type-check and build. Node's types: margoengine/voxel-net has a server entry. */
const TOOLS = ['typescript', 'vite', '@types/node', '@types/react', '@types/react-dom'];

const IMPORT_EVERY_ENTRY = `
import { readFileSync } from 'node:fs';
const manifest = JSON.parse(readFileSync('node_modules/margoengine/package.json', 'utf8'));
const failed = [];
let imported = 0;
for (const subpath of Object.keys(manifest.exports)) {
  const specifier = 'margoengine' + subpath.slice(1);
  try { await import(specifier); imported++; } catch (error) { failed.push(specifier + ': ' + (error?.message ?? error)); }
}
const engine = await import('margoengine');
if (typeof engine.createStage !== 'function') failed.push('margoengine has no createStage');
console.log(JSON.stringify({ imported, failed }));
process.exit(0);
`;

const FIRST_EXAMPLE_HTML = `<!doctype html><title>rehearsal</title><canvas id="viewport"></canvas>
<script type="module" src="/main.ts"></script>`;

function firstExample() {
  const readme = readFileSync(join(root, 'packages/margoengine/README.md'), 'utf8');
  const block = /```ts\r?\n([\s\S]*?)```/.exec(readme);
  if (!block) throw new Error('packages/margoengine/README.md has no ts example');
  return block[1];
}

async function rehearse(options) {
  const started = Date.now(),
    work = mkdtempSync(join(tmpdir(), `margo-rehearsal-${randomBytes(3).toString('hex')}-`)),
    say = (line) => console.log(`[${Math.round((Date.now() - started) / 1000)} s] ${line}`);
  const npm = (args, cwd, seconds) => run('npm', args, { cwd, env: options.env(work), seconds });
  const report = { problems: [] };
  try {
    // 1. Pack.
    const tarballs = options.tarballs ?? join(work, 'tarballs');
    if (!options.tarballs) {
      mkdirSync(tarballs);
      if (options.build) await run('npm', ['run', 'build:packages'], { cwd: root, env: process.env, seconds: 600 });
      await run('npm', ['pack', '--workspace', 'packages', '--ignore-scripts', '--pack-destination', tarballs], {
        cwd: root,
        env: process.env,
        seconds: 300,
      });
    }
    for (const tool of ['tools/margo-convert', 'tools/create-margo'])
      await run('npm', ['pack', `./${tool}`, '--ignore-scripts', '--pack-destination', tarballs], {
        cwd: root,
        env: process.env,
        seconds: 120,
      });

    // 2. Audit.
    const packages = new Map(),
      names = {};
    for (const file of readdirSync(tarballs).filter((f) => f.endsWith('.tgz'))) {
      const bytes = readFileSync(join(tarballs, file)),
        files = readTarball(bytes),
        manifest = JSON.parse(files.get('package.json').toString('utf8'));
      packages.set(manifest.name, { bytes, files, manifest });
      names[manifest.name] = manifest.version;
    }
    for (const { manifest } of publishedPackages())
      if (!packages.has(manifest.name)) report.problems.push(`${manifest.name}: no tarball`);
    const secrets = secretsOfThisMachine();
    for (const { files } of packages.values()) report.problems.push(...auditTarball(files, names, secrets));
    const packedBytes = [...packages.values()].reduce((sum, p) => sum + p.bytes.length, 0);
    say(`${packages.size} tarballs audited, ${packedBytes} B packed, ${report.problems.length} problems`);
    for (const problem of report.problems) console.error(`  ${problem}`);
    for (const problem of report.problems) console.error(`  ${problem}`);

    // 3. The stand-in registry.
    const registry = await startRegistry(packages);
    const registryArgs = [
      `--registry=${registry.url}`,
      '--replace-registry-host=never',
      '--no-audit',
      '--no-fund',
      '--no-update-notifier',
    ];
    try {
      // 4. The one line.
      const app = join(work, 'app');
      mkdirSync(app);
      writeFileSync(join(app, 'package.json'), '{"name":"rehearsal-app","private":true,"type":"module"}\n');
      const installStart = Date.now();
      await npm(['install', 'margoengine', ...registryArgs], app, 300);
      const installSeconds = (Date.now() - installStart) / 1000,
        installBytes = folderBytes(join(app, 'node_modules')),
        installed = JSON.parse(readFileSync(join(app, 'node_modules/margoengine/package.json'), 'utf8'));
      if (installed.version !== names.margoengine)
        report.problems.push(`npm install margoengine gave ${installed.version}`);
      say(`npm install margoengine: ${installSeconds.toFixed(1)} s, ${installBytes} B in node_modules`);
      report.install = { seconds: installSeconds, bytes: installBytes };

      await npm(['install', ...OPTIONAL_LIBRARIES, ...TOOLS, ...registryArgs], app, 300);
      writeFileSync(join(app, 'every-entry.mjs'), IMPORT_EVERY_ENTRY);
      const output = await run(process.execPath, ['every-entry.mjs'], { cwd: app, env: options.env(work), seconds: 180 });
      const { imported, failed } = JSON.parse(output.trim().split('\n').at(-1));
      report.problems.push(...failed.map((line) => `import ${line}`));
      say(`${imported} entries imported in Node, ${failed.length} failed`);

      const entries = Object.keys(installed.exports).map((subpath) => `margoengine${subpath.slice(1)}`);
      writeFileSync(
        join(app, 'types.ts'),
        entries.map((entry, i) => `import type * as Entry${i} from '${entry}';`).join('\n') +
          `\nexport type All = [${entries.map((_, i) => `typeof Entry${i}`).join(', ')}];\n`,
      );
      writeFileSync(join(app, 'main.ts'), firstExample());
      writeFileSync(
        join(app, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'Bundler',
            lib: ['ES2023', 'DOM', 'DOM.Iterable'],
            types: ['node'],
            strict: true,
            noEmit: true,
            skipLibCheck: false,
          },
          files: ['types.ts', 'main.ts'],
        }),
      );
      const tsc = join(app, 'node_modules/typescript/bin/tsc');
      if (existsSync(tsc)) await run(process.execPath, [tsc], { cwd: app, env: options.env(work), seconds: 300 });
      else await npm(['exec', '--no', '--', 'tsc'], app, 300);
      say(`${entries.length} entries and the README example type-check with skipLibCheck off`);

      writeFileSync(join(app, 'index.html'), FIRST_EXAMPLE_HTML);
      await npm(['exec', '--no', '--', 'vite', 'build', '--logLevel', 'warn'], app, 180);
      say('the README example builds with Vite');

      // 5. npm create margo and margo-convert, from the same registry.
      for (const template of options.templates) {
        const dir = `${template}-app`;
        await npm(
          ['exec', '--yes', ...registryArgs, '--package=create-margo@latest', '--', 'create-margo', dir, '--template', template],
          work,
          120,
        );
        await npm(['install', ...registryArgs], join(work, dir), 400);
        await npm(['run', 'build'], join(work, dir), 400);
        say(`npm create margo --template ${template}: installed and built`);
      }
      await npm(['exec', '--yes', ...registryArgs, '--package=margo-convert@latest', '--', 'margo-convert', '--help'], work, 120);
      say('margo-convert --help runs');
      if (registry.refused.length) report.problems.push(`registry writes attempted: ${registry.refused.join(', ')}`);
      report.relayed = registry.relayed.size;
      report.served = registry.served.size;
    } finally {
      registry.close();
    }
  } finally {
    if (options.keep) console.log(`kept ${work}`);
    else if (windows)
      // Deleting node_modules takes minutes on Windows: a detached process does it after the run.
      spawn('cmd.exe', ['/c', 'rmdir', '/s', '/q', work], { detached: true, stdio: 'ignore' }).unref();
    else rmSync(work, { recursive: true, force: true });
  }
  return report;
}

function parseArgs(argv) {
  const value = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  return {
    build: !argv.includes('--no-build'),
    keep: argv.includes('--keep'),
    limit: Number(value('limit') ?? 1500),
    tarballs: value('tarballs') ? resolve(value('tarballs')) : undefined,
    templates: (value('templates') ?? 'web,game,viz,react,next').split(',').filter(Boolean),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const options = parseArgs(process.argv.slice(2));
  // Each run gets an empty cache and no user .npmrc: what a first-time reader's install resolves, with no saved token.
  options.env = (work) =>
    readerEnv({
      npm_config_cache: join(work, 'npm-cache'),
      npm_config_userconfig: join(work, 'no-user-npmrc'),
    });
  const limit = setTimeout(() => {
    console.error(`publish rehearsal: over the ${options.limit} s limit`);
    process.exit(1);
  }, options.limit * 1000);
  try {
    const report = await rehearse(options);
    clearTimeout(limit);
    if (report.problems.length) {
      console.error(`publish rehearsal FAILED: ${report.problems.length} problems`);
      process.exit(1);
    }
    console.log(`publish rehearsal passed; nothing was published (${report.served} of ours served, ${report.relayed} third-party names read)`);
    process.exit(0);
  } catch (error) {
    console.error(`publish rehearsal FAILED: ${error.message}`);
    process.exit(1);
  }
}
