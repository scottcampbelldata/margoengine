import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSync } from 'rolldown/utils';
import { Script } from 'node:vm';
import { build } from 'vite';
import { declareCoreRequirement } from '../scripts/core-requirements.mjs';

test('classic worker scripts keep Script syntax and CPU attachment helpers', () => {
  const source = `(function(){class Placement{static attach(world){return world}}
    const plugin={name:'cpu',setup(){}};self.result=Placement.attach(plugin.name);})();`;
  const result = declareCoreRequirement(source, '1.0.0', 'worker.js');
  assert.equal(result, source);
  const self = {};
  new Script(result).runInNewContext({ self });
  assert.equal(self.result, 'cpu');
});

test('unused object plugins keep their requirement declaration tree-shakable', async () => {
  const plugin = declareCoreRequirement("export const plugin={name:'unused',setup(){}};export const value=1;", '1.0.0');
  const result = await build({
    configFile: false, publicDir: false, logLevel: 'silent',
    plugins: [{
      name: 'guard-shake-fixture',
      resolveId(id) {
        if (id.startsWith('fixture/')) return '\0' + id;
        if (id === '@margoengine/core/extension') return { id, external: true, moduleSideEffects: false };
      },
      load(id) {
        if (id === '\0fixture/entry') return "export {value} from 'fixture/plugin';";
        if (id === '\0fixture/plugin') return plugin;
      },
    }],
    build: { write: false, target: 'es2022', rollupOptions: { input: 'fixture/entry', output: { format: 'es' } } },
  });
  assert.doesNotMatch([result].flat().flatMap(item => item.output).map(chunk => chunk.code ?? '').join('\n'), /margoengine|coreRequirement|unused/);
});

test('package declarations freeze the build version at runtime access, attach and direct plugin use', () => {
  const source = `import {engineRuntime as runtime} from '@margoengine/core/extension';
    export class Plugin {name='plugin'; setup(engine){runtime(engine);} static attach(engine){return engine.use(new Plugin());}}
    export const plugin={name:'object',setup(engine){runtime(engine)}};`;
  const result = declareCoreRequirement(source, '7.8.9');
  assert.match(result, /const runtime=\(engine,version="7\.8\.9",source=import\.meta\.url\)=>/);
  assert.match(result, /coreRequirement=__margoCoreRequirement\("7\.8\.9",import\.meta\.url\)/);
  assert.match(result, /attach\(engine\)\{__margoAssertCore\(engine,/);
  assert.match(result, /coreRequirement:\/\*@__PURE__\*\/__margoCoreRequirement\("7\.8\.9",import\.meta\.url\)/);
  assert.equal(parseSync('result.js', result).errors.length, 0);
  assert.equal(declareCoreRequirement(result, '7.8.9'), result, 'custom builds are not stamped twice');
});

test('pure modules and shadowed runtime bindings keep their calls', () => {
  const pure = 'export const add=(a,b)=>a+b;';
  assert.equal(declareCoreRequirement(pure, '1.0.0'), pure);
  const shadowed = `import {engineRuntime as runtime} from '@margoengine/core/extension';
    export function local(runtime){return runtime(1)}
    export function imported(engine){return runtime(engine)}`;
  const result = declareCoreRequirement(shadowed, '1.0.0');
  assert.match(result, /return runtime\(1\)/);
  assert.match(result, /return runtime\(engine\)/);
  assert.match(result, /version="1\.0\.0"/);
});

test('minified local buffer builders do not inherit an imported runtime binding', () => {
  const source = `import {engineRuntime as r} from '@margoengine/core/extension';
    export class Buffers {build(){const r=(data,usage)=>[data,usage];return r([1],2)}}
    export function actual(engine){return r(engine)}`;
  const result = declareCoreRequirement(source, '1.0.0');
  assert.match(result, /return r\(\[1\],2\)/);
  assert.match(result, /return r\(engine\)/);
});

test('bundled dependencies retain their own exact build version', () => {
  const source = `import {engineRuntime as r} from '@margoengine/core/extension';
    export function dependency(engine){return r(engine,'0.8.0',import.meta.url)}
    export class Plugin {coreRequirement={version:'0.8.0'};setup(engine){}}
    export function current(engine){return r(engine)}`;
  const result = declareCoreRequirement(source, '1.0.0');
  assert.match(result, /r\(engine,'0\.8\.0',import\.meta\.url\)/);
  assert.match(result, /version="1\.0\.0"/);
  assert.equal((result.match(/coreRequirement=/g) ?? []).length, 1);
});

test('emitted bindings freeze versions through callbacks and leave local hoisted functions alone', async () => {
  const helpers = `export function engineRuntime(engine,version,source){return {engine,version,source}}
    export function coreRequirement(version,source){return {version,source}}
    export function assertCore(engine,requirement){engine.checked=requirement;return engine}`;
  const url = (code) => 'data:text/javascript,' + encodeURIComponent(code);
  const source = `import {engineRuntime as r} from '@margoengine/core/extension';
    export const callback=r;
    export function current(engine){const alias=r;return alias(engine)}
    export function dependency(engine){return r(engine,\`0.8.0\`,'dependency')}
    export function local(){if(true){var r=(...values)=>values.length;}return r(1,2)}
    export class Plugin {name='plugin';setup(engine){}static attach(engine){return engine}}`;
  const transformed = declareCoreRequirement(source, '4.5.6')
    .replaceAll("'@margoengine/core/extension'", JSON.stringify(url(helpers)));
  const module = await import(url(transformed));
  for (const invoke of [module.callback, module.current]) {
    const result = invoke('engine');
    assert.equal(result.engine, 'engine');
    assert.equal(result.version, '4.5.6');
    assert.match(result.source, /^data:text\/javascript,/);
  }
  assert.equal(module.local(), 2);
  assert.equal(module.dependency('engine').version, '0.8.0');
  assert.equal(new module.Plugin().coreRequirement.version, '4.5.6');
  const engine = {};
  assert.equal(module.Plugin.attach(engine), engine);
  assert.equal(engine.checked.version, '4.5.6');
});
