// WGSL corpus recorder (scripts/record-wgsl-corpus.mjs; data for @margoengine/webgl2-compat's translator tests). Every
// shader module a browser check creates is recorded once, with what the pipelines built from it declare: entry points,
// pipeline constants, the bind group layout (binding types) and the render state flags the WebGL2 layer must map.
//
// Two halves:
// - `wgslCorpusInit` is a page init script (serialised by Playwright, so self-contained). It wraps GPUDevice's
//   createShaderModule, createBindGroupLayout, createPipelineLayout and the four pipeline constructors, and sends each
//   record to the Node side through the `__margoWgslCorpus` binding.
// - `installCorpusHook()` patches Playwright's BrowserType so every browser any suite launches (through
//   scripts/browser.js, scripts/lib/browser.mjs or its own chromium.launch) gets the init script and the binding in
//   every context. scripts/support/wgsl-corpus-hook.mjs calls it from NODE_OPTIONS=--import when MARGO_WGSL_CORPUS
//   names the output folder; nothing here runs in a normal check.
// Each Node process writes one shard (<MARGO_WGSL_CORPUS>/shards/<pid>-<n>.json) when it exits; `mergeShards` folds
// them into the corpus. Shaders created inside workers are not seen (the init script runs in pages only).
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

/** Init script: wraps the GPUDevice methods above and sends `{t, ...}` records to `__margoWgslCorpus`. */
export function wgslCorpusInit() {
  if (typeof GPUDevice === 'undefined' || GPUDevice.prototype.createShaderModule.margoCorpus) return;
  const proto = GPUDevice.prototype,
    keys = new WeakMap(),
    groups = new WeakMap(),
    layouts = new WeakMap(),
    sent = new Set(),
    send = (record) => {
      // A record sent while the page closes is lost with the page; the merge counts only what arrived.
      globalThis.__margoWgslCorpus?.(record)?.catch?.(() => {});
    },
    hash = (s) => {
      let h = 0x811c9dc5;
      for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
      return (h >>> 0).toString(16).padStart(8, '0') + s.length.toString(16);
    },
    // Package directories on the call stack, innermost first: /packages/<name>/ (dev server, workspace) or
    // node_modules/@margoengine/<name>/ (packed tarballs).
    origin = () => {
      const out = [];
      for (const m of String(new Error().stack ?? '').matchAll(/\/(?:packages|@margoengine)\/([a-z0-9-]+)\//g))
        if (!out.includes(m[1])) out.push(m[1]);
      return out;
    },
    pick = (o, names) => {
      if (!o) return undefined;
      const r = {};
      for (const n of names) if (o[n] !== undefined) r[n] = o[n];
      return r;
    },
    entry = (e) => ({
      binding: e.binding,
      visibility: e.visibility,
      ...(e.buffer ? { buffer: { type: e.buffer.type ?? 'uniform', dynamic: !!e.buffer.hasDynamicOffset } } : {}),
      ...(e.sampler ? { sampler: { type: e.sampler.type ?? 'filtering' } } : {}),
      ...(e.texture
        ? {
            texture: {
              sampleType: e.texture.sampleType ?? 'float',
              viewDimension: e.texture.viewDimension ?? '2d',
              multisampled: !!e.texture.multisampled,
            },
          }
        : {}),
      ...(e.storageTexture
        ? {
            storageTexture: {
              access: e.storageTexture.access ?? 'write-only',
              format: e.storageTexture.format,
              viewDimension: e.storageTexture.viewDimension ?? '2d',
            },
          }
        : {}),
      ...(e.externalTexture ? { externalTexture: true } : {}),
    }),
    layoutOf = (layout) => (layout === 'auto' || layout === undefined ? 'auto' : (layouts.get(layout) ?? 'unrecorded')),
    stage = (s) =>
      s && {
        module: keys.get(s.module) ?? 'unrecorded',
        ...(s.entryPoint !== undefined ? { entryPoint: s.entryPoint } : {}),
        ...(s.constants && Object.keys(s.constants).length ? { constants: { ...s.constants } } : {}),
      },
    render = (d) => ({
      t: 'pipeline',
      kind: 'render',
      layout: layoutOf(d.layout),
      vertex: {
        ...stage(d.vertex),
        buffers: (d.vertex?.buffers ?? []).map((b) =>
          b
            ? {
                arrayStride: b.arrayStride,
                stepMode: b.stepMode ?? 'vertex',
                attributes: [...(b.attributes ?? [])].map((a) => pick(a, ['format', 'offset', 'shaderLocation'])),
              }
            : null,
        ),
      },
      ...(d.fragment
        ? {
            fragment: {
              ...stage(d.fragment),
              targets: [...(d.fragment.targets ?? [])].map((t) =>
                t ? { format: t.format, blend: !!t.blend, writeMask: t.writeMask ?? 15 } : null,
              ),
            },
          }
        : {}),
      primitive: pick(d.primitive ?? {}, ['topology', 'stripIndexFormat', 'frontFace', 'cullMode', 'unclippedDepth']),
      ...(d.depthStencil
        ? {
            depthStencil: {
              ...pick(d.depthStencil, ['format', 'depthWriteEnabled', 'depthCompare', 'depthBias', 'depthBiasClamp']),
              stencil: !!(d.depthStencil.stencilFront || d.depthStencil.stencilBack),
            },
          }
        : {}),
      ...(d.multisample ? { multisample: pick(d.multisample, ['count', 'alphaToCoverageEnabled']) } : {}),
    }),
    compute = (d) => ({ t: 'pipeline', kind: 'compute', layout: layoutOf(d.layout), compute: stage(d.compute) }),
    wrap = (name, after) => {
      const original = proto[name];
      if (typeof original !== 'function') return;
      proto[name] = function (descriptor, ...rest) {
        const result = original.call(this, descriptor, ...rest);
        after(descriptor, result);
        return result;
      };
    };
  const createShaderModule = proto.createShaderModule;
  proto.createShaderModule = function (descriptor) {
    const module = createShaderModule.call(this, descriptor),
      code = typeof descriptor?.code === 'string' ? descriptor.code : '',
      key = hash(code),
      label = String(descriptor?.label ?? '');
    keys.set(module, key);
    if (!sent.has(key)) {
      sent.add(key);
      send({ t: 'module', key, code, label, packages: origin(), page: location.pathname });
      module.getCompilationInfo().then((info) => {
        const errors = info.messages.filter((m) => m.type === 'error');
        send({ t: 'info', key, errors: errors.length, first: errors[0]?.message ?? null });
      });
    }
    return module;
  };
  proto.createShaderModule.margoCorpus = true;
  wrap('createBindGroupLayout', (d, layout) => groups.set(layout, [...(d?.entries ?? [])].map(entry)));
  wrap('createPipelineLayout', (d, layout) =>
    layouts.set(
      layout,
      [...(d?.bindGroupLayouts ?? [])].map((g) => (g ? (groups.get(g) ?? 'unrecorded') : null)),
    ),
  );
  wrap('createRenderPipeline', (d) => send(render(d)));
  wrap('createRenderPipelineAsync', (d) => send(render(d)));
  wrap('createComputePipeline', (d) => send(compute(d)));
  wrap('createComputePipelineAsync', (d) => send(compute(d)));
}

/** Records of one Node process, written to one shard file when it exits. */
function shardSink(dir) {
  const modules = new Map(),
    info = new Map(),
    pipelines = new Map();
  let written = false;
  const write = () => {
    if (written || (!modules.size && !pipelines.size)) return;
    written = true;
    mkdirSync(join(dir, 'shards'), { recursive: true });
    const file = join(dir, 'shards', `${process.pid}-${Date.now().toString(36)}.json`);
    writeFileSync(
      file,
      JSON.stringify({
        argv: process.argv.slice(1, 3),
        modules: [...modules.values()],
        info: [...info.values()],
        pipelines: [...pipelines.values()],
      }),
    );
  };
  process.on('exit', write);
  return {
    add(record, page) {
      if (!record || typeof record !== 'object') return;
      if (record.t === 'module') {
        const known = modules.get(record.key);
        if (known) {
          for (const p of record.packages) if (!known.packages.includes(p)) known.packages.push(p);
          if (known.pages.length < 8 && !known.pages.includes(page)) known.pages.push(page);
        } else modules.set(record.key, { ...record, pages: [page] });
      } else if (record.t === 'info') {
        const known = info.get(record.key);
        if (!known || record.errors < known.errors) info.set(record.key, record);
      } else if (record.t === 'pipeline') {
        const text = JSON.stringify(record);
        if (!pipelines.has(text)) pipelines.set(text, record);
      }
    },
  };
}

/**
 * Patches Playwright's BrowserType so every launched browser's contexts carry the init script and the binding. Records
 * go to a shard in `dir`. Safe to call once per process; a process that never loads Playwright pays one module load.
 */
export function installCorpusHook(dir) {
  const require = createRequire(resolve(import.meta.dirname, '..', '..', 'package.json'));
  let core;
  try {
    core = require('playwright-core');
  } catch {
    return false; // This process cannot load Playwright, so it launches no browser either.
  }
  const BrowserType = Object.getPrototypeOf(core.chromium);
  if (BrowserType.launch.margoCorpus) return true;
  const sink = shardSink(dir),
    prepared = new WeakSet();
  const prepare = async (context) => {
    if (prepared.has(context)) return context;
    prepared.add(context);
    await context.exposeBinding('__margoWgslCorpus', (source, record) => sink.add(record, safePath(source.page)));
    await context.addInitScript(wgslCorpusInit);
    return context;
  };
  const patchBrowser = (browser) => {
    const newContext = browser.newContext.bind(browser);
    browser.newContext = async (...args) => prepare(await newContext(...args));
    const newPage = browser.newPage.bind(browser);
    browser.newPage = async (...args) => {
      const page = await newPage(...args);
      await prepare(page.context());
      return page;
    };
    return browser;
  };
  for (const name of ['launch', 'connect', 'connectOverCDP']) {
    const original = BrowserType[name];
    if (typeof original !== 'function') continue;
    BrowserType[name] = async function (...args) {
      return patchBrowser(await original.apply(this, args));
    };
  }
  const persistent = BrowserType.launchPersistentContext;
  BrowserType.launchPersistentContext = async function (...args) {
    return prepare(await persistent.apply(this, args));
  };
  BrowserType.launch.margoCorpus = true;
  return true;
}

function safePath(page) {
  try {
    return new URL(page?.url() ?? 'about:blank').pathname;
  } catch {
    return 'unknown';
  }
}

/** Folds every shard in `<dir>/shards` into one map of modules (by key), keeping each module's pipelines. */
export function mergeShards(dir) {
  const modules = new Map();
  const files = readdirSync(join(dir, 'shards')).filter((f) => f.endsWith('.json'));
  const pipelinesByModule = new Map();
  for (const file of files) {
    const shard = JSON.parse(readFileSync(join(dir, 'shards', file), 'utf8'));
    for (const m of shard.modules) {
      const known = modules.get(m.key);
      if (!known) modules.set(m.key, { ...m, labels: m.label ? [m.label] : [], errors: undefined });
      else {
        for (const p of m.packages) if (!known.packages.includes(p)) known.packages.push(p);
        for (const p of m.pages) if (known.pages.length < 8 && !known.pages.includes(p)) known.pages.push(p);
        if (m.label && known.labels.length < 8 && !known.labels.includes(m.label)) known.labels.push(m.label);
      }
    }
    for (const i of shard.info) {
      const known = modules.get(i.key);
      if (known && (known.errors === undefined || i.errors < known.errors)) {
        known.errors = i.errors;
        known.firstError = i.first;
      }
    }
    for (const p of shard.pipelines)
      for (const s of [p.vertex, p.fragment, p.compute].filter(Boolean)) {
        const list = pipelinesByModule.get(s.module) ?? new Map();
        list.set(JSON.stringify(p), p);
        pipelinesByModule.set(s.module, list);
      }
  }
  for (const [key, list] of pipelinesByModule) {
    const known = modules.get(key);
    if (known) known.pipelines = [...list.values()];
  }
  return { shards: files.length, modules };
}
