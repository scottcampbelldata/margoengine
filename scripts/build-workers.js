import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSync } from 'rolldown/utils';
import { build } from 'vite';

const decoderStub = fileURLToPath(new URL('./worker-decoder-stub.js', import.meta.url)),
  poolStub = fileURLToPath(new URL('./worker-pool-stub.js', import.meta.url)),
  emptyStub = fileURLToPath(new URL('./worker-empty-stub.js', import.meta.url)),
  packagesDir = fileURLToPath(new URL('../packages/', import.meta.url)),
  biomesSrc = fileURLToPath(new URL('../packages/biomes/src/', import.meta.url));

const aliases = [
  { find: /^@margoengine\/decoders$/, replacement: decoderStub },
  // A biome world worker never starts workers itself (its world has workers: false).
  { find: /^@margoengine\/biomes\/workers$/, replacement: poolStub },
  // Nor does it get a GPU device (its options name none), so it never loads the GPU kernels.
  { find: /^@margoengine\/biomes\/gpu$/, replacement: emptyStub },
  // Nor makes digests (no worker job asks for one) or default biomes (the page sends its world's biomes).
  { find: /^@margoengine\/biomes\/(digest|presets)$/, replacement: emptyStub },
  // Its other entries come from the sources, as its relative imports do: one copy of each module in the file
  // (and one object per hook), where the built entries would add a second copy of the shared modules.
  { find: /^@margoengine\/biomes\/([a-z0-9-]+)$/, replacement: `${biomesSrc}$1.ts` },
  // A file with Gaussian splats goes back to the page before anything reads them (gltf-pro's asyncCompression).
  { find: /^@margoengine\/splats(\/data)?$/, replacement: emptyStub },
];

// Optional parts of a worker: each is a classic script of its own, dist/workers/<worker>-<part>.js, that the worker
// runs with importScripts only when its world uses the part, from a URL the page sends with each replica's first
// message (the page resolves it with new URL(..., import.meta.url), as it does the worker, so the app's bundler copies
// the file). In the worker and its parts every import() of a part becomes a call of `self.<global>Part(name)`, the
// worker's loader. A part reads each module the worker also holds from `self.<global>Shared`, which the worker fills,
// so every module has one copy across the files (and every hook one object): the build fails on a part the worker
// imports statically or on a module two parts would both hold.
const WORKER_PARTS = [
  {
    dir: biomesSrc,
    worker: 'biomes.worker.ts',
    pkg: '@margoengine/biomes',
    global: 'MargoBiomes',
    parts: ['splines', 'erosion', 'graph', 'zones', 'multinoise'],
  },
];

/** A module id as both the builds and this script spell it: forward slashes, no query, lower-case drive letter. */
const norm = (id) =>
  id
    .split('?')[0]
    .replaceAll('\\', '/')
    .replace(/^[A-Z]:/, (d) => d.toLowerCase());

const config = (entry, outDir, fileName, name, plugins = [], write = true) => ({
  configFile: false,
  publicDir: false,
  logLevel: 'warn',
  plugins,
  resolve: { alias: aliases },
  build: {
    write,
    outDir,
    emptyOutDir: false,
    minify: true,
    target: 'es2022',
    lib: { entry, name, formats: ['iife'], fileName: () => fileName },
  },
});

/** The modules a build's chunk holds (virtual ones left out). */
function moduleIds(result) {
  const chunk = [result]
    .flat()
    .flatMap((r) => r.output)
    .find((c) => c.type === 'chunk');
  return new Set((chunk.moduleIds ?? Object.keys(chunk.modules)).filter((id) => !id.startsWith('\0')).map(norm));
}

// Parser workers: each src/<name>.worker.ts becomes a self-contained classic worker, dist/workers/<name>.js. A package
// starts it with new URL('./workers/<name>.js?no-inline', import.meta.url), which the app's bundler copies as an asset,
// so the worker's code is never part of the app's own bundle. Draco and KTX2 are not part of that script: an IIFE has no
// import.meta.url, and those codecs run on the thread that can see the decoder package's own assets.
export async function buildWorkers(root) {
  const src = resolve(root, 'src'),
    dist = resolve(root, 'dist'),
    outDir = resolve(dist, 'workers');
  if (!existsSync(src)) return;
  for (const file of (await readdir(src)).filter((file) => file.endsWith('.worker.ts'))) {
    const entry = resolve(src, file),
      fileName = file.replace(/\.worker\.ts$/, '.js'),
      spec = WORKER_PARTS.find((p) => norm(resolve(p.dir, p.worker)) === norm(entry));
    if (spec) await buildWithParts(spec, entry, outDir, fileName);
    else await build(config(entry, outDir, fileName, 'MargoWorker'));
  }
  // Inlining the decoder package also copied its worker here. Parser jobs never request that copy.
  await rm(resolve(dist, 'workers/decoder.worker.js'), { force: true });
  await restoreWorkerUrls(dist);
}

/** A worker with parts: the worker without them (to learn its modules, nothing written), each part, then the worker filling the modules the parts read. */
async function buildWithParts(spec, entry, outDir, fileName) {
  const calls = partCalls(spec),
    partFile = (name) => norm(resolve(spec.dir, `${name}.ts`)),
    inWorker = (ids, when) => {
      for (const name of spec.parts)
        if (ids.has(partFile(name)))
          throw new Error(`${fileName}: the ${name} part is in the worker ${when}; reach it only through import()`);
    };
  const core = moduleIds(await build(config(entry, outDir, fileName, 'MargoWorker', [calls], false)));
  inWorker(core, 'itself');
  const used = new Set(),
    owner = new Map();
  for (const name of spec.parts) {
    const out = fileName.replace(/\.js$/, `-${name}.js`),
      plugins = [calls, sharedImports(spec, core, used)],
      ids = moduleIds(await build(config(partFile(name), outDir, out, `${spec.global}Part_${name}`, plugins)));
    for (const id of ids) {
      if (owner.has(id))
        throw new Error(
          `${id} is in both the ${owner.get(id)} and ${name} parts of ${fileName}; import it in the worker`,
        );
      owner.set(id, name);
    }
  }
  const plugins = [calls, sharedRegistry(spec, entry, used)];
  inWorker(moduleIds(await build(config(entry, outDir, fileName, 'MargoWorker', plugins))), 'with its shared modules');
}

/** The key of a shared module: its path under packages/, without the extension. */
const sharedKey = (id) => norm(relative(packagesDir, id)).replace(/\.[jt]s$/, '');

/** Each import() of a part becomes a call of the worker's part loader (found in the syntax tree, never in a string). */
function partCalls(spec) {
  const names = new Set(spec.parts),
    dir = norm(spec.dir),
    bare = spec.pkg.replace(/[/.]/g, (c) => '\\' + c),
    pattern = new RegExp(String.raw`^(?:\./([a-z0-9-]+)\.js|${bare}/([a-z0-9-]+))$`);
  return {
    name: 'margo-worker-part-calls',
    transform(code, id) {
      if (!norm(id).startsWith(dir) || !code.includes('import(')) return null;
      const calls = [],
        visit = (node) => {
          if (!node || typeof node.type !== 'string') return;
          const m =
              node.type === 'ImportExpression' &&
              typeof node.source.value === 'string' &&
              pattern.exec(node.source.value),
            name = m && (m[1] ?? m[2]);
          if (names.has(name)) calls.push({ start: node.start, end: node.end, name });
          for (const value of Object.values(node))
            if (Array.isArray(value)) value.forEach(visit);
            else if (value && typeof value === 'object') visit(value);
        };
      visit(parseSync(norm(id).replace(/\.ts$/, '.js'), code).program);
      if (!calls.length) return null;
      let out = code;
      for (const c of calls.sort((a, b) => b.start - a.start)) {
        if (!/^import\s*\(/.test(code.slice(c.start, c.end))) throw new Error(`${id}: no import() at ${c.start}`);
        out = `${out.slice(0, c.start)}self.${spec.global}Part(${JSON.stringify(c.name)})${out.slice(c.end)}`;
      }
      return { code: out, map: null };
    },
  };
}

/** In a part's build: a module the worker holds resolves to the worker's copy, read from `self.<global>Shared`. */
function sharedImports(spec, core, used) {
  const prefix = '\0margo-shared:';
  return {
    name: 'margo-worker-shared-imports',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!importer || source.startsWith('\0')) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (!resolved || resolved.external || !core.has(norm(resolved.id))) return resolved;
      used.add(norm(resolved.id));
      return prefix + norm(resolved.id);
    },
    load(id) {
      if (!id.startsWith(prefix)) return null;
      const file = id.slice(prefix.length),
        names = valueExports(file).join(', ');
      return `const shared = self.${spec.global}Shared[${JSON.stringify(sharedKey(file))}];\nexport const { ${names} } = shared;\n`;
    },
  };
}

/** In the worker's build: its entry fills `self.<global>Shared` with the modules the parts read. */
function sharedRegistry(spec, entry, used) {
  const ids = [...used].sort(),
    from = dirname(entry);
  return {
    name: 'margo-worker-shared-registry',
    transform(code, id) {
      if (norm(id) !== norm(entry)) return null;
      const imports = ids.map((m, i) => {
          const path = norm(relative(from, m));
          return `import * as shared${i} from ${JSON.stringify(path.startsWith('.') ? path : './' + path)};`;
        }),
        table = ids.map((m, i) => `${JSON.stringify(sharedKey(m))}: shared${i}`);
      return {
        code: `${code}\n${imports.join('\n')}\nself.${spec.global}Shared = { ${table.join(', ')} };\n`,
        map: null,
      };
    },
  };
}

/** The names a module exports as values (a build has no types left to import). */
function valueExports(file) {
  const names = [],
    { program } = parseSync(file, readFileSync(file, 'utf8'));
  for (const node of program.body) {
    if (node.type === 'ExportAllDeclaration' && node.exportKind !== 'type')
      throw new Error(`${file}: a worker part cannot share an export *; name the exports`);
    if (node.type === 'ExportDefaultDeclaration')
      throw new Error(`${file}: a worker part cannot share a default export`);
    if (node.type !== 'ExportNamedDeclaration' || node.exportKind === 'type') continue;
    const d = node.declaration;
    if (d && !d.declare) {
      if (d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration' || d.type === 'TSEnumDeclaration')
        names.push(d.id.name);
      else if (d.type === 'VariableDeclaration')
        for (const v of d.declarations) {
          if (v.id.type !== 'Identifier') throw new Error(`${file}: a worker part cannot share a destructured export`);
          names.push(v.id.name);
        }
    }
    for (const s of node.specifiers ?? []) if (s.exportKind !== 'type') names.push(s.exported.name ?? s.exported.value);
  }
  return names;
}

// Drop the package-build ignore comment and restore import.meta.url. tsc may copy the comment back into dist.
export async function restoreWorkerUrls(dist) {
  if (!existsSync(dist)) return;
  for (const file of (await readdir(dist)).filter((file) => file.endsWith('.js'))) {
    const path = resolve(dist, file),
      code = await readFile(path, 'utf8'),
      fixed = code
        .replace(/\/\*\s*@vite-ignore\s*\*\/\s*/g, '')
        .replace(/(?:''|""|``)\s*\+\s*import\.meta\.url/g, 'import.meta.url');
    if (fixed !== code) await writeFile(path, fixed);
  }
}
