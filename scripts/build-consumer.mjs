#!/usr/bin/env node
// A source-aware build boundary for applications consuming local engine packages.
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageOrder } from './package-order.js';

const repository = fileURLToPath(new URL('..', import.meta.url));
const FORMAT = 'margo-consumer-build',
  VERSION = 1;
const fullPipeline = new Set(['core', 'stage', 'margoengine', 'react']);
const slash = (value) => value.split(sep).join('/');
const digest = (value) => createHash('sha256').update(value).digest('hex');
const hashRecord = (value) =>
  digest(JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))));
const missing = (error) => error.code === 'ENOENT';

async function bytes(path) {
  try {
    return await readFile(path);
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

async function walk(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else if (entry.isFile()) files.push(path);
    else
      throw new TypeError(
        `Consumer fingerprint input is not a regular file: ${path}; replace the link with owned source`,
      );
  }
  return files;
}

function inside(root, path) {
  const rest = relative(root, path);
  return rest !== '..' && !rest.startsWith('..' + sep) && !isAbsolute(rest);
}

async function fingerprints(root, paths) {
  const result = {};
  for (const path of [...new Set(paths)].sort()) {
    if (!inside(root, path))
      throw new RangeError(`Consumer build input escapes the engine: ${path}; keep build inputs inside the workspace`);
    const content = await bytes(path);
    result[slash(relative(root, path))] = content === null ? null : digest(content);
  }
  return result;
}

async function buildInputs(root) {
  const paths = new Set(
    [
      'package.json',
      'package-lock.json',
      'LICENSE',
      'NOTICE',
      'scripts/build-consumer.mjs',
      'scripts/build-modern.js',
      'scripts/build-optional.js',
      'scripts/build-workers.js',
      'scripts/worker-decoder-stub.js',
      'scripts/package-declarations.js',
      'scripts/package-legal.js',
      'scripts/package-order.js',
    ].map((file) => resolve(root, file)),
  );
  const visit = async (path) => {
    const content = await bytes(path);
    if (content === null) return;
    // Build tools import other build tools. Include those transitive implementation files, not their emitted dist.
    for (const match of content.toString().matchAll(/\b(?:from\s*|import\s*\(\s*|import\s*)(['"])(\.[^'"]+)\1/g)) {
      const target = resolve(dirname(path), match[2]);
      if (!inside(root, target))
        throw new RangeError('Build-tool dependency escapes the engine; keep relative imports inside the workspace');
      if (!paths.has(target)) {
        paths.add(target);
        await visit(target);
      }
    }
  };
  for (const path of [...paths]) await visit(path);
  paths.add(resolve(root, 'packages/shared/.directory'));
  for (const path of await walk(resolve(root, 'packages/shared'))) paths.add(path);
  return fingerprints(root, [...paths]);
}

async function workspace(root) {
  const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  const patterns = Array.isArray(manifest.workspaces) ? manifest.workspaces : manifest.workspaces?.packages;
  if (!Array.isArray(patterns))
    throw new TypeError('Engine workspaces are missing; declare package workspaces in package.json');
  const directories = [];
  for (const pattern of patterns) {
    if (pattern === 'packages/*')
      for (const item of await readdir(resolve(root, 'packages'), { withFileTypes: true })) {
        if (item.isDirectory() && (await bytes(resolve(root, 'packages', item.name, 'package.json'))))
          directories.push(item.name);
      }
    else if (/^packages\/[a-z][a-z0-9-]*$/.test(pattern)) directories.push(pattern.slice('packages/'.length));
  }
  const manifests = new Map();
  for (const name of [...new Set(directories)])
    manifests.set(name, JSON.parse(await readFile(resolve(root, 'packages', name, 'package.json'), 'utf8')));
  return manifests;
}

function closure(manifests, requested) {
  if (!Array.isArray(requested) || !requested.length)
    throw new RangeError('No consumer packages selected; pass --package=sky or another workspace package');
  const byName = new Map([...manifests].map(([name, m]) => [m.name, name]));
  const selected = new Map();
  const visit = (name) => {
    if (selected.has(name)) return;
    const manifest = manifests.get(name);
    if (!manifest) throw new RangeError(`Unknown engine package ${name}; select a declared package workspace`);
    selected.set(name, manifest);
    for (const dependency of Object.keys({
      ...manifest.dependencies,
      ...manifest.peerDependencies,
      ...manifest.devDependencies,
    })) {
      if (byName.has(dependency)) {
        if (byName.get(dependency) !== name) visit(byName.get(dependency));
      } else if (dependency.startsWith('@margoengine/'))
        throw new RangeError(`Missing engine dependency ${dependency}; register its package workspace before building`);
    }
  };
  const names = requested.map((value) => {
    if (typeof value !== 'string')
      throw new TypeError('Consumer package name is invalid; pass a workspace directory or public package name');
    const name = byName.get(value) ?? value;
    if (!/^[a-z][a-z0-9-]*$/.test(name))
      throw new RangeError(`Invalid consumer package ${value}; pass a package name such as sky`);
    visit(name);
    return name;
  });
  const ordered = new Map([...manifests].filter(([name]) => selected.has(name)));
  return { requested: [...new Set(names)], order: packageOrder(ordered), manifests: ordered, byName };
}

async function packageSource(root, name, manifest, common) {
  const directory = resolve(root, 'packages', name),
    paths = new Set([resolve(directory, 'package.json')]);
  for (const folder of ['src', 'scripts']) for (const path of await walk(resolve(directory, folder))) paths.add(path);
  const config = async (path) => {
    if (paths.has(path)) return;
    paths.add(path);
    const text = await bytes(path);
    if (text === null) return;
    const json = JSON.parse(text.toString());
    for (const parent of Array.isArray(json.extends) ? json.extends : [json.extends])
      if (typeof parent === 'string' && parent.startsWith('.')) {
        const target = resolve(dirname(path), parent.endsWith('.json') ? parent : parent + '.json');
        await config(target);
      }
  };
  await config(resolve(directory, 'tsconfig.json'));
  // Custom package builders may live at the package root rather than in scripts/.
  for (const match of (manifest.scripts?.build ?? '').matchAll(/(?:^|\s)([^\s'";]+\.(?:m?js|cjs))(?=\s|$)/g)) {
    const path = resolve(directory, match[1]);
    if (inside(root, path)) paths.add(path);
  }
  const files = await fingerprints(root, [...paths]);
  return { sourceHash: hashRecord({ ...common, ...files }), sourceFiles: files };
}

function declaredOutputs(directory, manifest) {
  const targets = new Set();
  const visit = (value) => {
    if (typeof value === 'string') {
      if (!/\.(?:[mc]?js|d\.[mc]?ts)$/.test(value)) return;
      const target = resolve(directory, value);
      if (!value.startsWith('./dist/') || !inside(resolve(directory, 'dist'), target) || value.includes('*'))
        throw new RangeError(
          `Package output target ${value} escapes dist or is not concrete; declare each JS/types entry inside ./dist/`,
        );
      targets.add(target);
    } else if (value && typeof value === 'object') for (const item of Object.values(value)) visit(item);
  };
  visit(manifest.exports);
  for (const field of ['main', 'module', 'types', 'typings']) visit(manifest[field]);
  if (!targets.size)
    throw new RangeError(`Package ${manifest.name} declares no JS/types outputs; add concrete public exports`);
  return targets;
}

async function packageOutput(root, name, manifest) {
  const directory = resolve(root, 'packages', name),
    required = declaredOutputs(directory, manifest);
  let source = [];
  try {
    source = await readdir(resolve(directory, 'src'));
  } catch (error) {
    if (!missing(error)) throw error;
  }
  for (const file of source.filter((file) => file.endsWith('.worker.ts')))
    required.add(resolve(directory, 'dist/workers', file.replace(/\.worker\.ts$/, '.js')));
  const files = await fingerprints(root, await walk(resolve(directory, 'dist'))),
    absent = [];
  for (const path of required) {
    const key = slash(relative(root, path)),
      content = await bytes(path);
    if (content === null || !content.length) absent.push(key);
  }
  return { outputs: files, outputHash: hashRecord(files), missing: absent };
}

function inputHash(source, manifest, records, byName) {
  const dependencies = {};
  for (const dependency of Object.keys({
    ...manifest.dependencies,
    ...manifest.peerDependencies,
    ...manifest.devDependencies,
  }).sort()) {
    const name = byName.get(dependency),
      record = name ? records[name] : null;
    if (record) dependencies[name] = { inputHash: record.inputHash, outputHash: record.outputHash };
  }
  return { inputHash: hashRecord({ sourceHash: source.sourceHash, dependencies }), dependencies };
}

async function runNode(root, script, args = []) {
  await new Promise((accept, reject) => {
    const child = spawn(process.execPath, [resolve(root, script), ...args], {
      cwd: root,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) =>
      code === 0
        ? accept()
        : reject(
            new Error(`Consumer build failed (${signal ?? code}) in ${script}; fix the reported engine build error`),
          ),
    );
  });
}

async function buildPackage(root, name, manifest) {
  const command = manifest.scripts?.build;
  if (command && !command.includes('build-optional.js')) {
    const match = /^node\s+([^\s]+\.(?:m?js|cjs))(?:\s+(.*))?$/.exec(command);
    if (!match)
      throw new TypeError(
        `Unsupported build command for ${name}; use a Node build script or run the full engine build`,
      );
    await runNode(root, relative(root, resolve(root, 'packages', name, match[1])), match[2]?.split(/\s+/) ?? []);
  } else await runNode(root, 'scripts/build-optional.js', [name]);
}

async function atomicJSON(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + `.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n');
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error) => {
      if (!missing(error)) throw error;
    });
  }
}

async function lock(root) {
  const path = resolve(root, '.cache/consumer-build.lock');
  await mkdir(dirname(path), { recursive: true });
  const started = Date.now();
  for (;;) {
    try {
      const file = await open(path, 'wx');
      await file.writeFile(JSON.stringify({ pid: process.pid }));
      await file.close();
      return () => unlink(path);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let alive = true;
      try {
        const owner = JSON.parse(await readFile(path, 'utf8'));
        if (Number.isInteger(owner.pid) && owner.pid > 0)
          try {
            process.kill(owner.pid, 0);
          } catch (error) {
            if (error.code === 'ESRCH') alive = false;
          }
      } catch (error) {
        if (missing(error)) continue;
        if (Date.now() - (await stat(path)).mtimeMs > 120_000) alive = false;
      }
      if (!alive) {
        await unlink(path).catch((error) => {
          if (!missing(error)) throw error;
        });
        continue;
      }
      if (Date.now() - started > 600_000)
        throw new Error('Another consumer build still owns the workspace; wait for it to finish and retry');
      await new Promise((accept) => setTimeout(accept, 100));
    }
  }
}

/**
 * Build a consumer's complete engine dependency closure, checking content rather than package versions or mtimes.
 * Successful source/output provenance is persisted under the engine's .cache; a failed build never attests outputs.
 */
export async function buildConsumer({ root = repository, packages, receiptPath } = {}) {
  root = resolve(root);
  const release = await lock(root);
  try {
    const manifests = await workspace(root),
      selection = closure(manifests, packages),
      common = await buildInputs(root);
    let previous;
    try {
      previous = JSON.parse(await readFile(resolve(root, '.cache/consumer-build.json'), 'utf8'));
    } catch (error) {
      if (!missing(error) && !(error instanceof SyntaxError)) throw error;
    }
    const records = previous?.format === FORMAT && previous?.version === VERSION ? { ...previous.packages } : {};
    const built = [],
      skipped = [];
    let fullBuild = false;
    for (const name of selection.order) {
      const manifest = manifests.get(name),
        source = await packageSource(root, name, manifest, common),
        output = await packageOutput(root, name, manifest);
      const inputs = inputHash(source, manifest, records, selection.byName),
        old = records[name];
      if (old?.inputHash === inputs.inputHash && old.outputHash === output.outputHash && !output.missing.length) {
        skipped.push(name);
        continue;
      }
      if (fullPipeline.has(name)) {
        const before = new Map();
        for (const [item, m] of manifests) before.set(item, await packageSource(root, item, m, common));
        await runNode(root, 'scripts/build-modern.js', ['--precompiled']);
        if (hashRecord(await buildInputs(root)) !== hashRecord(common))
          throw new Error('Engine build inputs changed while building; rerun the consumer build');
        for (const item of packageOrder(manifests)) {
          const m = manifests.get(item),
            next = await packageSource(root, item, m, common),
            result = await packageOutput(root, item, m);
          if (next.sourceHash !== before.get(item).sourceHash)
            throw new Error(`Engine source ${item} changed while building; rerun the consumer build`);
          if (result.missing.length)
            throw new Error(
              `Engine build is missing outputs: ${result.missing.join(', ')}; fix its public entry build`,
            );
          records[item] = {
            name: m.name,
            ...next,
            ...inputHash(next, m, records, selection.byName),
            outputHash: result.outputHash,
            outputs: result.outputs,
            builtAt: new Date().toISOString(),
          };
        }
        built.push(...packageOrder(manifests));
        skipped.length = 0;
        fullBuild = true;
        break;
      }
      await buildPackage(root, name, manifest);
      const next = await packageSource(root, name, manifest, common),
        result = await packageOutput(root, name, manifest);
      if (next.sourceHash !== source.sourceHash)
        throw new Error(`Engine source ${name} changed while building; rerun the consumer build`);
      if (result.missing.length)
        throw new Error(`Engine build is missing outputs: ${result.missing.join(', ')}; fix its public entry build`);
      records[name] = {
        name: manifest.name,
        ...next,
        ...inputs,
        outputHash: result.outputHash,
        outputs: result.outputs,
        builtAt: new Date().toISOString(),
      };
      built.push(name);
    }
    if (hashRecord(await buildInputs(root)) !== hashRecord(common))
      throw new Error('Engine build inputs changed while building; rerun the consumer build');
    const generatedAt = new Date().toISOString();
    await atomicJSON(resolve(root, '.cache/consumer-build.json'), {
      format: FORMAT,
      version: VERSION,
      generatedAt,
      buildInputs: common,
      packages: records,
    });
    const receipt = {
      format: FORMAT + '-receipt',
      version: VERSION,
      engineRoot: root,
      generatedAt,
      requested: selection.requested,
      order: selection.order,
      built,
      skipped,
      fullBuild,
      packages: Object.fromEntries(selection.order.map((name) => [name, records[name]])),
    };
    if (receiptPath) await atomicJSON(resolve(receiptPath), receipt);
    return receipt;
  } finally {
    await release();
  }
}

/** Parse the stable consumer CLI: repeat --package=NAME and optionally write --json=RECEIPT. */
export function parseConsumerArguments(args) {
  const packages = [];
  let receiptPath;
  for (const argument of args) {
    if (argument.startsWith('--package=')) packages.push(argument.slice('--package='.length));
    else if (argument.startsWith('--json=') && argument.length > '--json='.length)
      receiptPath = argument.slice('--json='.length);
    else throw new RangeError(`Unknown consumer argument ${argument}; use --package=NAME and --json=RECEIPT`);
  }
  return { packages, receiptPath };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await buildConsumer(parseConsumerArguments(process.argv.slice(2)));
    console.log(JSON.stringify({ built: result.built, skipped: result.skipped, fullBuild: result.fullBuild }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
