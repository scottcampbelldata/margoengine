import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const npm = process.env.npm_execpath ?? join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');

test('packed core rejects two install paths and stale package builds before any plugin work', { timeout: 120000 }, async (t) => {
  const parent = join(root, 'test-results');
  await mkdir(parent, { recursive: true });
  const scratch = await mkdtemp(join(parent, 'core-version-'));
  try {
    const pack = JSON.parse(execFileSync(process.execPath, [npm, 'pack', './packages/core', '--ignore-scripts', '--json', '--pack-destination', scratch], {
      cwd: root, encoding: 'utf8', timeout: 30000, windowsHide: true,
    }));
    const modules = [];
    for (const name of ['scoped', 'umbrella']) {
      const directory = join(scratch, name, 'node_modules/@margoengine/core');
      await mkdir(directory, { recursive: true });
      execFileSync('tar', ['-xf', pack[0].filename, '-C', relative(scratch, directory).split(sep).join('/'), '--strip-components=1'], { cwd: scratch, timeout: 30000, windowsHide: true });
      modules.push(await import(pathToFileURL(join(directory, 'dist/extension.js')).href));
    }
    const [a, b] = modules;
    const canvas = { width: 16, height: 16 };
    using engine = new a.Engine(canvas, await a.TransformStore.create(16), { backend: 'webgl2', dispose() {} });
    const version = a.CORE_VERSION ?? '1.0.0';
    const ownSource = engine.coreRequirement?.runtime.source ?? pathToFileURL(join(scratch, 'scoped/node_modules/@margoengine/core/dist/version.js')).href;
    const foreignSource = pathToFileURL(join(scratch, 'umbrella/node_modules/@margoengine/core/dist/version.js')).href;
    let setups = 0, registrations = 0, disposals = 0;
    const plugin = (module, expected, source) => ({
      name: 'guarded',
      coreRequirement: module.coreRequirement?.(expected, source) ?? { version: expected, source, runtime: { version, source: module === a ? ownSource : foreignSource } },
      setup() { setups++; },
      registerPasses() { registrations++; },
      dispose() { disposals++; },
    });
    function rejected(action, expected, source, resolvedSource) {
      assert.throws(action, (error) => {
        assert.equal(error.name, 'MargoError');
        assert.equal(error.code, 'version');
        for (const value of [version, expected, ownSource, source, resolvedSource, 'https://margoengine.com/errors#version'])
          assert.ok(error.message.includes(value), `missing ${value}: ${error.message}`);
        return true;
      });
      assert.equal(setups, 0);
      assert.equal(registrations, 0);
      assert.equal(disposals, 0);
      assert.equal(engine.plugins.size, 0);
    }
    const cases = [
      ['duplicate install at engine.use', () => engine.use(plugin(b, version, '@margoengine/foreign-plugin')), version, '@margoengine/foreign-plugin', foreignSource],
      ['duplicate install at runtime access', () => b.engineRuntime(engine), version, foreignSource, foreignSource],
      ['stale package build at engine.use', () => engine.use(plugin(a, '0.9.0', '@margoengine/stale-plugin')), '0.9.0', '@margoengine/stale-plugin', ownSource],
    ];
    for (const [name, action, expected, source, resolvedSource] of cases)
      await t.test(name, () => {
        try {
          rejected(action, expected, source, resolvedSource);
        } finally {
          // Keep the other negative cases independent when this test is run against the old, unguarded core.
          engine.removePlugin('guarded');
          setups = registrations = disposals = 0;
        }
      });
    const same = await import(pathToFileURL(join(scratch, 'scoped/node_modules/@margoengine/core/dist/extension.js')).href);
    assert.equal(same.Engine, a.Engine);
    assert.deepEqual(same.coreRequirement(), engine.coreRequirement);
    assert.equal(same.engineRuntime(engine), engine);
    engine.use(plugin(same, version, '@margoengine/matching-plugin'));
    assert.equal(setups, 1);
    assert.equal(registrations, 1);
    engine.removePlugin('guarded');
    assert.equal(disposals, 1);
    await t.test('two core copies bundled into one output URL retain distinct registries', async () => {
      const entry = join(scratch, 'entry.js');
      await writeFile(entry, `export * as a from './scoped/node_modules/@margoengine/core/dist/extension.js';
        export * as b from './umbrella/node_modules/@margoengine/core/dist/extension.js';`);
      const result = await build({
        configFile: false, publicDir: false, logLevel: 'silent',
        build: { write: false, target: 'es2022', lib: { entry, formats: ['es'] } },
      });
      const output = join(scratch, 'bundle.mjs');
      await writeFile(output, result[0].output.find(chunk => chunk.isEntry).code);
      const bundled = await import(pathToFileURL(output).href);
      using own = new bundled.a.Engine(canvas, await bundled.a.TransformStore.create(16), { backend: 'webgl2', dispose() {} });
      assert.equal(own.coreRequirement.runtime.source, bundled.b.coreRequirement().runtime.source);
      assert.equal(bundled.a.engineRuntime(own), own);
      assert.throws(() => bundled.b.engineRuntime(own), { name: 'MargoError', code: 'version' });
    });
  } finally {
    const within = relative(parent, resolve(scratch));
    assert.ok(within && !within.startsWith('..') && !isAbsolute(within));
    await rm(resolve(scratch), { recursive: true, force: true });
  }
});
