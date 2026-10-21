import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const api = await import('../scripts/build-consumer.mjs').catch((error) => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});

async function fixture(t, { core = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'margo-consumer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const names = core ? ['core', 'math', 'sky', 'unused'] : ['math', 'sky', 'unused'];
  const dependencies = {
    core: {},
    math: core ? { '@margoengine/core': '1.0.0' } : {},
    sky: { '@margoengine/math': '1.0.0' },
    unused: {},
  };
  await mkdir(join(root, 'scripts'), { recursive: true });
  await mkdir(join(root, 'packages/shared'), { recursive: true });
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ type: 'module', workspaces: names.map((name) => 'packages/' + name) }),
  );
  await writeFile(join(root, 'package-lock.json'), '{}');
  await writeFile(join(root, 'LICENSE'), 'MIT');
  await writeFile(join(root, 'packages/shared/kernel.ts'), 'export const shared=1;');
  for (const name of names) {
    await mkdir(join(root, 'packages', name, 'src'), { recursive: true });
    await writeFile(
      join(root, 'packages', name, 'package.json'),
      JSON.stringify({
        name: '@margoengine/' + name,
        version: '1.0.0',
        type: 'module',
        dependencies: dependencies[name],
        exports: {
          '.': { types: './dist/index.d.ts', import: './dist/index.js' },
          './extra': { types: './dist/extra.d.ts', import: './dist/extra.js' },
        },
      }),
    );
    await writeFile(join(root, 'packages', name, 'src/index.ts'), 'export const value=1;');
    await writeFile(join(root, 'packages', name, 'tsconfig.json'), '{}');
  }
  const builder = `import fs from 'node:fs/promises';
import path from 'node:path';
const root=process.cwd();
const all=JSON.parse(await fs.readFile('package.json','utf8')).workspaces.map(p=>p.slice('packages/'.length));
const names=process.argv[1].endsWith('build-modern.js')?all:[process.argv[2]];
for(const name of names){
 const packageRoot=path.join(root,'packages',name), manifest=JSON.parse(await fs.readFile(path.join(packageRoot,'package.json'),'utf8'));
 await fs.appendFile(path.join(root,'build.log'),name+'\\n');
 const source=await fs.readFile(path.join(packageRoot,'src/index.ts'),'utf8');
 for(const entry of Object.values(manifest.exports))for(const target of Object.values(entry)){
  await fs.mkdir(path.dirname(path.join(packageRoot,target)),{recursive:true});
  await fs.writeFile(path.join(packageRoot,target),target.endsWith('.d.ts')?'export declare const value:number;':source);
 }
 for(const file of await fs.readdir(path.join(packageRoot,'src'))){if(file.endsWith('.worker.ts')){
  await fs.mkdir(path.join(packageRoot,'dist/workers'),{recursive:true});
  await fs.writeFile(path.join(packageRoot,'dist/workers',file.replace('.worker.ts','.js')),'self.onmessage=()=>{};');
 }}
}
`;
  await writeFile(join(root, 'scripts/build-optional.js'), builder);
  await writeFile(join(root, 'scripts/build-modern.js'), builder);
  return root;
}

test('consumer API is available to editor build tools', () => {
  assert.equal(typeof api.buildConsumer, 'function');
});

test('consumer builds a dependency closure in order and skips unchanged content regardless of timestamps', async (t) => {
  const root = await fixture(t);
  const first = await api.buildConsumer({ root, packages: ['@margoengine/sky'] });
  assert.deepEqual(first.order, ['math', 'sky']);
  assert.deepEqual(first.built, ['math', 'sky']);
  assert.equal(first.packages.sky.name, '@margoengine/sky');
  assert.match(first.packages.sky.sourceHash, /^[a-f0-9]{64}$/);
  assert.match(first.packages.sky.outputHash, /^[a-f0-9]{64}$/);
  const second = await api.buildConsumer({ root, packages: ['sky'] });
  assert.deepEqual(second.built, []);
  assert.deepEqual(second.skipped, ['math', 'sky']);
  assert.equal(await readFile(join(root, 'build.log'), 'utf8'), 'math\nsky\n');
});

test('same-version source edits rebuild that dependency and its consumer but not unrelated packages', async (t) => {
  const root = await fixture(t);
  const first = await api.buildConsumer({ root, packages: ['sky'] });
  await writeFile(join(root, 'packages/math/src/index.ts'), 'export const value=2;');
  const second = await api.buildConsumer({ root, packages: ['sky'] });
  assert.deepEqual(second.built, ['math', 'sky']);
  assert.notEqual(first.packages.math.sourceHash, second.packages.math.sourceHash);
  assert.notEqual(first.packages.sky.inputHash, second.packages.sky.inputHash);
  assert.equal(await readFile(join(root, 'packages/math/dist/index.js'), 'utf8'), 'export const value=2;');
});

test('every declared entry and type is required and tampered auxiliary output also rebuilds', async (t) => {
  const root = await fixture(t);
  await api.buildConsumer({ root, packages: ['sky'] });
  await rm(join(root, 'packages/sky/dist/extra.d.ts'));
  let result = await api.buildConsumer({ root, packages: ['sky'] });
  assert.deepEqual(result.built, ['sky']);
  await writeFile(join(root, 'packages/sky/dist/extra.js'), 'stale output');
  result = await api.buildConsumer({ root, packages: ['sky'] });
  assert.deepEqual(result.built, ['sky']);
  assert.equal(await readFile(join(root, 'packages/sky/dist/extra.js'), 'utf8'), 'export const value=1;');
});

test('shared source and build-tool changes invalidate the closure and missing workers are restored', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'packages/sky/src/generate.worker.ts'), 'self.onmessage=()=>{};');
  await api.buildConsumer({ root, packages: ['sky'] });
  await rm(join(root, 'packages/sky/dist/workers/generate.js'));
  let result = await api.buildConsumer({ root, packages: ['sky'] });
  assert.deepEqual(result.built, ['sky']);
  await writeFile(join(root, 'packages/shared/kernel.ts'), 'export const shared=2;');
  result = await api.buildConsumer({ root, packages: ['sky'] });
  assert.deepEqual(result.built, ['math', 'sky']);
  await writeFile(
    join(root, 'scripts/build-optional.js'),
    (await readFile(join(root, 'scripts/build-optional.js'), 'utf8')) + '\n// changed build contract\n',
  );
  result = await api.buildConsumer({ root, packages: ['sky'] });
  assert.deepEqual(result.built, ['math', 'sky']);
});

test('a dirty core runs one precompiled full build and records reusable provenance for every package', async (t) => {
  const root = await fixture(t, { core: true });
  let result = await api.buildConsumer({ root, packages: ['sky'] });
  assert.equal(result.fullBuild, true);
  assert.deepEqual(result.built, ['core', 'math', 'sky', 'unused']);
  result = await api.buildConsumer({ root, packages: ['unused'] });
  assert.deepEqual(result.built, []);
  await writeFile(join(root, 'packages/core/src/index.ts'), 'export const value=3;');
  result = await api.buildConsumer({ root, packages: ['sky'] });
  assert.equal(result.fullBuild, true);
  assert.deepEqual(result.built, ['core', 'math', 'sky', 'unused']);
});

test('a broken builder cannot attest missing types or overwrite an earlier receipt', async (t) => {
  const root = await fixture(t),
    receiptPath = join(root, 'receipt.json');
  await api.buildConsumer({ root, packages: ['sky'], receiptPath });
  const before = await readFile(receiptPath, 'utf8');
  await rm(join(root, 'packages/sky/dist/extra.d.ts'));
  await writeFile(join(root, 'scripts/build-optional.js'), '// deliberately emits no artifacts');
  await assert.rejects(api.buildConsumer({ root, packages: ['sky'], receiptPath }), /missing|output|entry/i);
  assert.equal(await readFile(receiptPath, 'utf8'), before);
});

test('unknown packages, cycles and escaped export targets fail before any build', async (t) => {
  const root = await fixture(t);
  await assert.rejects(api.buildConsumer({ root, packages: ['../sky'] }), /package/i);
  const manifest = JSON.parse(await readFile(join(root, 'packages/math/package.json'), 'utf8'));
  manifest.dependencies = { '@margoengine/sky': '1.0.0' };
  await writeFile(join(root, 'packages/math/package.json'), JSON.stringify(manifest));
  await assert.rejects(api.buildConsumer({ root, packages: ['sky'] }), /cycle/i);
  delete manifest.dependencies;
  manifest.exports['.'].types = '../outside.d.ts';
  await writeFile(join(root, 'packages/math/package.json'), JSON.stringify(manifest));
  await assert.rejects(api.buildConsumer({ root, packages: ['math'] }), /escape|inside|target/i);
});
