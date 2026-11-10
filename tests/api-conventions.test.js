// API conventions every package class follows:
// - engine features (EnginePlugin classes, and classes whose constructor takes the engine) have `static attach(engine, ...)`;
// - a class with `destroy()` also has `dispose()` (`destroy` is the deprecated alias);
// - a class with `dispose()` also has `[Symbol.dispose]()` where the runtime defines `Symbol.dispose`;
// - a class with `static attach()` also has `dispose()`.
// Walks every exported class of every package's built entries (core and the stage facade are frozen and exempt), so new
// classes cannot drift.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// Not engine features although they have `setup()` or take the engine: never attached by users.
const NOT_FEATURES = new Map([['PBRModel', 'created by gltf-pro loadGLTF']]);

const isClass = (value) => typeof value === 'function' && /^class\b/.test(Function.prototype.toString.call(value));

function reportAttachProblems(text) {
  // A bundled declaration can keep an inherited factory in a local, unexported base.
  const classes = new Map(
    [...text.matchAll(/^(export )?(?:declare )?(?:abstract )?class (\w+)([^\n]*)\{\n([\s\S]*?)^\}/gm)].map(
      ([, exported, name, head, body]) => [name, { exported: Boolean(exported), base: head.match(/extends (\w+)/)?.[1], body }],
    ),
  );
  const hasAttach = (name, seen = new Set()) => {
    if (!classes.has(name) || seen.has(name)) return false;
    seen.add(name);
    const { body, base } = classes.get(name);
    return /^ {4}static (?:async )?attach[(<]/m.test(body) || hasAttach(base, seen);
  };
  return [...classes].filter(([name, { body, exported }]) => exported &&
    /^ {4}constructor\((?:engine|instance|source|readonly engine): (?:Camera \| )?EngineKernel\b/m.test(body) &&
    !NOT_FEATURES.has(name) && !hasAttach(name)).map(([name]) => name);
}

test('report audit follows local bases while still rejecting missing and cyclic factories', () => {
  const report = `declare abstract class LocalBase {
    static attach<T>(engine: EngineKernel): T;
}
declare class Intermediate extends LocalBase {
}
export class Inherited extends Intermediate {
    constructor(engine: EngineKernel);
}
declare class Empty {
}
export class Missing extends Empty {
    constructor(engine: EngineKernel);
}
declare class Loop extends Cyclic {
}
export class Cyclic extends Loop {
    constructor(engine: EngineKernel);
}
`;
  assert.deepEqual(reportAttachProblems(report), ['Missing', 'Cyclic']);
});

async function packageClasses() {
  const found = new Map();
  for (const dir of (await readdir('packages')).sort()) {
    // core and the stage are frozen for 1.0; margoengine re-exports the stage.
    if (dir === 'core' || dir === 'stage' || dir === 'margoengine' || dir === 'shared') continue;
    let manifest;
    try {
      manifest = JSON.parse(await readFile(`packages/${dir}/package.json`, 'utf8'));
    } catch {
      continue;
    }
    for (const [entry, target] of Object.entries(manifest.exports ?? {})) {
      // margoengine/<x> re-exports @margoengine/<x>, walked on its own.
      if (manifest.name === 'margoengine' && entry !== '.') continue;
      const file = typeof target === 'string' ? target : target.import;
      if (!file?.endsWith('.js')) continue;
      const module = await import(pathToFileURL(`packages/${dir}/${file}`).href);
      for (const [name, value] of Object.entries(module))
        if (isClass(value) && !found.has(value)) found.set(value, [`${manifest.name}${entry.slice(1)}`, name]);
    }
  }
  return found;
}

test('every package class follows the attach / dispose / Symbol.dispose conventions', async () => {
  const classes = await packageClasses();
  assert.ok(classes.size > 150, `expected the package classes, found ${classes.size}`);
  const names = new Set([...classes.values()].map(([, name]) => name));
  for (const name of ['TransparentCanvas', 'ColorOutput']) assert.ok(names.has(name), `${name} is walked`);
  const problems = [];
  for (const [Class, [entry, name]] of classes) {
    const proto = Class.prototype,
      label = `${entry} ${name}`;
    // destroy(entity) (ecs World) destroys an entity, not the object, so only an argument-less destroy() counts.
    if (typeof proto.destroy === 'function' && !proto.destroy.length && typeof proto.dispose !== 'function')
      problems.push(`${label}: destroy() without dispose()`);
    if (typeof proto.dispose === 'function' && typeof proto[Symbol.dispose] !== 'function')
      problems.push(`${label}: dispose() without [Symbol.dispose]()`);
    if (typeof proto.setup === 'function' && !NOT_FEATURES.has(name) && typeof Class.attach !== 'function')
      problems.push(`${label}: engine feature without static attach()`);
    // What attaches to an engine must be detachable.
    if (typeof Class.attach === 'function' && typeof proto.dispose !== 'function')
      problems.push(`${label}: static attach() without dispose()`);
    // An inherited attach must construct the subclass (`new this(...)`), not the base (GPUParticles extends VFX).
    if (
      typeof Class.attach === 'function' &&
      !Object.hasOwn(Class, 'attach') &&
      !/new this\b/.test(String(Class.attach))
    )
      problems.push(`${label}: inherits a base class attach() that builds the base class`);
  }
  assert.deepEqual(problems, []);
});

test('classes constructed from the engine have static attach (API reports)', async () => {
  const problems = [];
  for (const file of await readdir('api')) {
    if (file.startsWith('core') || file.startsWith('stage') || file.startsWith('margoengine')) continue;
    const text = (await readFile(`api/${file}`, 'utf8')).replaceAll('\r', '');
    for (const name of reportAttachProblems(text)) problems.push(`${file} ${name}`);
  }
  assert.deepEqual(problems, []);
});

test('[Symbol.dispose] calls dispose() and never adds an "undefined" key', async () => {
  const { Fog } = await import(pathToFileURL('packages/environment/dist/index.js').href);
  assert.equal(Object.getOwnPropertyNames(Object.getPrototypeOf(Fog.prototype)).includes('undefined'), false);
  const fog = new Fog();
  let disposed = 0;
  fog.dispose = () => {
    disposed++;
  };
  {
    using scoped = fog;
    assert.equal(scoped, fog);
  }
  assert.equal(disposed, 1);
});

test('deprecated aliases forward to the new names', async () => {
  const { Fog } = await import(pathToFileURL('packages/environment/dist/index.js').href);
  const { Shadows } = await import(pathToFileURL('packages/shadows/dist/index.js').href);
  const fog = new Fog(),
    model = { addLighting: () => () => {} };
  const remove = fog.applyTo(model);
  assert.equal(fog.add(model), remove, 'applyTo(model) and add(model) share one registration');
  const shadows = new Shadows();
  let disposed = 0;
  shadows.dispose = () => {
    disposed++;
  };
  shadows.destroy();
  assert.equal(disposed, 1);
});
