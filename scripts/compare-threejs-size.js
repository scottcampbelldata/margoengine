// Reproducible size comparison: the smallest real lit-mesh app in Margo (core + stage) and in three.js (WebGL and
// WebGPU renderers), each minified and tree-shaken by the same Vite build, then gzipped.
// Run: npm run measure:threejs
import {build} from 'vite';
import {gzipSync} from 'node:zlib';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {measureCoreStage} from './measure-size.js';

const three = JSON.parse(await (await import('node:fs/promises')).readFile('node_modules/three/package.json', 'utf8')).version;
const apps = {
  'three.js WebGLRenderer': "import {WebGLRenderer,Scene,PerspectiveCamera,Mesh,BoxGeometry,MeshStandardMaterial,DirectionalLight} from 'three';const r=new WebGLRenderer({canvas:document.querySelector('canvas')}),s=new Scene(),c=new PerspectiveCamera();s.add(new Mesh(new BoxGeometry(),new MeshStandardMaterial()),new DirectionalLight());r.render(s,c);",
  'three.js WebGPURenderer': "import {WebGPURenderer,Scene,PerspectiveCamera,Mesh,BoxGeometry,MeshStandardMaterial,DirectionalLight} from 'three/webgpu';const r=new WebGPURenderer({canvas:document.querySelector('canvas')}),s=new Scene(),c=new PerspectiveCamera();s.add(new Mesh(new BoxGeometry(),new MeshStandardMaterial()),new DirectionalLight());r.renderAsync(s,c);",
};
// Inside the repository (test-results is git-ignored) so `three` resolves from node_modules.
await mkdir('test-results', {recursive: true});
const directory = await mkdtemp(join('test-results', 'margo-size-')), rows = [];
try {
  const margo = await measureCoreStage(); rows.push({app: 'Margo core + stage', raw: margo.raw, gzip: margo.gzip});
  for (const [app, code] of Object.entries(apps)) {
    const entry = join(directory, 'entry.js'); await writeFile(entry, code);
    const out = await build({configFile: false, publicDir: false, logLevel: 'silent', build: {write: false, minify: true, target: 'es2022', lib: {entry, formats: ['es']}}});
    const text = out[0].output.filter(item => item.type === 'chunk').map(item => item.code).join('\n');
    rows.push({app, raw: Buffer.byteLength(text), gzip: gzipSync(text).length});
  }
} finally {await rm(directory, {recursive: true, force: true});}
console.log(`three.js ${three}, minified and gzipped (bytes):`);
console.table(rows);
