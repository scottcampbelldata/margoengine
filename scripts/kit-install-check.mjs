// Packed-install correctness and byte counts. All engine packages come from this checkout's
// tarballs through a read-only local registry, never the unrelated public placeholder.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import { KIT_MEMBERS } from './umbrella.mjs';
import { readTarball, startRegistry } from './publish-rehearsal.mjs';
import { killTree, windowsCommandLine } from './gpu-lock.mjs';

const root = resolve(import.meta.dirname, '..');
export const RESULTS = join(root, 'test-results/kit-installs');
const json = (file) => JSON.parse(readFileSync(file, 'utf8'));
const bytesIn = (dir) => readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile()).reduce((sum, entry) => sum + statSync(join(entry.parentPath, entry.name)).size, 0);

export function run(command, args, { cwd = root, seconds = 300, env = process.env } = {}) {
  return new Promise((done, fail) => {
    const child = spawn(process.platform === 'win32' ? windowsCommandLine([command, ...args]) : command,
      process.platform === 'win32' ? [] : args,
      { cwd, env, shell: process.platform === 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, seconds * 1000);
    child.stdout.on('data', (data) => output += data);
    child.stderr.on('data', (data) => output += data);
    child.on('error', (error) => { clearTimeout(timer); fail(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (!timedOut && code === 0) done(output);
      else fail(new Error(`${command} ${args.join(' ')}: ${timedOut ? 'hard timeout' : `exit ${code}`}\n${output.slice(-6000)}`));
    });
  });
}

export function requiredClosure(names, packages) {
  const required = new Set();
  for (const name of names) required.add(name);
  for (const name of required) {
    const manifest = packages.get(name)?.manifest;
    assert.ok(manifest, `missing packed ${name}`);
    for (const dependency of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies }))
      if (packages.has(dependency)) required.add(dependency);
    for (const dependency of Object.keys(manifest.peerDependencies ?? {}))
      if (!manifest.peerDependenciesMeta?.[dependency]?.optional && packages.has(dependency)) required.add(dependency);
  }
  return [...required].sort();
}

export function installedEnginePackages(app) {
  const lock = json(join(app, 'package-lock.json'));
  return Object.entries(lock.packages).filter(([path]) => /(^|\/)node_modules\/(@margoengine\/[^/]+|margoengine)$/.test(path))
    .map(([path, value]) => ({ name: path.slice(path.lastIndexOf('node_modules/') + 13), value }));
}

export async function prepare() {
  mkdirSync(RESULTS, { recursive: true });
  const work = mkdtempSync(join(RESULTS, 'run-')), tarballs = join(work, 'tarballs');
  mkdirSync(tarballs);
  await run('npm', ['pack', '--workspace', 'packages', '--ignore-scripts', '--pack-destination', tarballs], { seconds: 300 });
  const packages = new Map();
  for (const file of readdirSync(tarballs).filter((name) => name.endsWith('.tgz'))) {
    const bytes = readFileSync(join(tarballs, file)), files = readTarball(bytes);
    const manifest = JSON.parse(files.get('package.json').toString());
    packages.set(manifest.name, { bytes, files, manifest });
  }
  const registry = await startRegistry(packages);
  const args = [`--registry=${registry.url}`, '--replace-registry-host=never', '--ignore-scripts', '--no-audit', '--no-fund'];
  const env = { ...process.env, npm_config_userconfig: join(work, 'no-npmrc'), npm_config_cache: join(work, 'cache') };
  const report = { version: packages.get('@margoengine/core').manifest.version, cases: [] };
  try {
    const cases = { core: ['@margoengine/core'], stage: ['@margoengine/stage'],
      ...Object.fromEntries(Object.keys(KIT_MEMBERS).map((kit) => [kit, [`@margoengine/${kit}`]])),
      together: ['@margoengine/game', '@margoengine/web', '@margoengine/viz'], all: ['margoengine'] };
    for (const [name, install] of Object.entries(cases)) {
      const app = join(work, name); mkdirSync(app);
      writeFileSync(join(app, 'package.json'), JSON.stringify({ name: `kit-${name}-check`, private: true, type: 'module' }));
      await run('npm', ['install', ...install, ...(name === 'react-kit' ? ['react@19.3.0', 'react-dom@19.3.0'] : []), ...args], { cwd: app, env });
      const installed = installedEnginePackages(app);
      assert.deepEqual(installed.map((p) => p.name).sort(), requiredClosure(install, packages), `${name}: install escaped its dependency closure`);
      for (const { name: dependency, value } of installed) {
        assert.equal(value.version, report.version, dependency);
        assert.ok(value.resolved.startsWith(registry.url), `${dependency}: not from our packed registry`);
      }
      assert.equal(new Set(installed.map((p) => p.name)).size, installed.length, `${name}: duplicate engine versions`);
      if (name === 'core') assert.deepEqual(installed.map((p) => p.name), ['@margoengine/core']);
      if (name === 'stage') assert.deepEqual(installed.map((p) => p.name).sort(), ['@margoengine/core', '@margoengine/stage']);
      const record = { name, packages: installed.length, installedBytes: bytesIn(join(app, 'node_modules')),
        packedBytes: installed.reduce((sum, p) => sum + packages.get(p.name).bytes.length, 0), app };
      // The assertion runs before tooling or compatibility is added, proving the base install is standalone.
      const source = name === 'core' ? '@margoengine/core' : name === 'stage' ? '@margoengine/stage' : name === 'all' ? 'margoengine' : name === 'together' ? '@margoengine/game' : `@margoengine/${name}`;
      const program = name === 'react-kit' ? `import {createElement as h} from 'react'; import {createRoot} from 'react-dom/client'; import {Canvas,Sphere} from '${source}'; const host=document.createElement('div'); host.style='width:128px;height:128px'; document.body.replaceChildren(host); createRoot(host).render(h(Canvas,{camera:{position:[0,0,5],target:[0,0,0]}},h(Sphere,{color:'#e8b04a'})));` : name === 'core'
        ? `import {Engine,box,PbrMaterial} from '${source}'; const engine=await Engine.create(document.querySelector('canvas'),{camera:{position:[0,0,5],target:[0,0,0]}}); const colors=['#ff0000','#00ff00','#0000ff','#ffff00','#ff00ff','#00ffff','#ff8000','#80ff00','#0080ff','#8000ff','#ff0080','#00ff80']; for(let i=0;i<colors.length;i++){const mesh=engine.createMesh().setGeometry(box()).setMaterial(new PbrMaterial({color:colors[i]})); mesh.position.set((i%4-1.5)*0.7,(Math.floor(i/4)-1)*0.7,0); mesh.scale.set(0.5,0.5,0.5);} engine.start(); window.kitEngine=engine;`
        : `import {createStage} from '${source}'; const stage=await createStage('canvas',{camera:{position:[0,0,5],target:[0,0,0]}}); stage.sphere({color:'#e8b04a'}); window.kitEngine=stage.engine;`;
      writeFileSync(join(app, 'main.js'), program);
      if (name === 'together') {
        const integration = `import assert from 'node:assert/strict';
import * as game from '@margoengine/game'; import * as web from '@margoengine/web'; import * as viz from '@margoengine/viz';
assert.equal(game.createStage,web.createStage); assert.equal(web.createStage,viz.createStage);
assert.equal(game.EnvironmentLighting,viz.EnvironmentLighting); assert.equal(web.Shadows,game.Shadows);
import {Engine} from '@margoengine/game/core'; import {Engine as WebEngine} from '@margoengine/web/core';
assert.equal(Engine,WebEngine);`;
        writeFileSync(join(app, 'integration.mjs'), integration);
        await run(process.execPath, ['integration.mjs'], { cwd: app, seconds: 60 });
        writeFileSync(join(app, 'main.js'), `import {EnvironmentLighting} from '@margoengine/web'; import {Lines,GridHelper} from '@margoengine/viz';\n${program}\nconst lines=new Lines(); window.kitEngine.use(lines); lines.add(new GridHelper({size:4,divisions:4})); await EnvironmentLighting.load(window.kitEngine,{width:16,height:8,data:new Float32Array(16*8*4).fill(1)});`);
      }
      writeFileSync(join(app, 'index.html'), '<!doctype html><title>Kit install</title><canvas width="128" height="128" style="width:128px;height:128px"></canvas><script type="module" src="/main.js"></script>');
      // A real app build resolves engine code exclusively inside this empty install. The build tool itself
      // runs from the checkout so it does not inflate the install-byte measurement.
      await build({ root: app, configFile: false, publicDir: false, logLevel: 'error', build: { target: 'es2022' } });
      if (name in KIT_MEMBERS) {
        // Build a second variant after recording the exact native install. The native dist is immutable.
        await run('npm', ['install', '@margoengine/webgl2-compat', ...args], { cwd: app, env });
        writeFileSync(join(app, 'main.js'), `import {install} from '@margoengine/webgl2-compat';\nconst installed=await install({force:true}); if(!installed.installed) throw new Error(installed.reason);\n${program}`);
        await build({ root: app, configFile: false, publicDir: false, logLevel: 'error', build: { target: 'es2022', outDir: 'dist-compat' } });
      }
      report.cases.push(record);
      console.log(`${name}: ${record.packages} engine packages, ${record.installedBytes} installed B, ${record.packedBytes} packed B`);
    }
    assert.deepEqual(registry.refused, []);
    writeFileSync(join(RESULTS, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  } finally { registry.close(); }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await prepare();
