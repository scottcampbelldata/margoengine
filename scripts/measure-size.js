import {build} from 'vite';
import {gzipSync} from 'node:zlib';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {checkCoreBudget, CORE_STAGE_GZIP_LIMIT} from './core-budget.js';

export const compactOutput = {minify: {compress: {dropDebugger: true}, mangle: true, codegen: true}, comments: {annotation: true}};
export const external = ['@margoengine/core', '@margoengine/core/extension', '@margoengine/animation', '@margoengine/gltf-pro', '@margoengine/blender', '@margoengine/gltf', '@margoengine/machinery', '@margoengine/creative', '@margoengine/scenery', '@margoengine/environment', '@margoengine/controls', '@margoengine/shadows', '@margoengine/decoders', '@margoengine/decoders/meshopt', 'margoengine', 'react', 'react/jsx-runtime', '@margoengine/machinery/cad', '@margoengine/creative/particles', '@margoengine/creative/post', '@margoengine/scenery/sky'];

export async function measureCoreStage() {
  const output = await build({configFile: false, publicDir: false, logLevel: 'silent', build: {
    write: false, minify: true, target: 'es2022',
    lib: {entry: 'packages/margoengine/dist/index.js', formats: ['es']},
    rollupOptions: {external: external.filter(name => !name.startsWith('@margoengine/core')), output: compactOutput},
  }});
  const chunks = output[0].output.filter(item => item.type === 'chunk');
  const code = chunks.map(chunk => chunk.code).join('\n');
  const gzip = gzipSync(code).length;
  checkCoreBudget(gzip);
  return {raw: Buffer.byteLength(code), gzip, modules: chunks.flatMap(chunk => Object.keys(chunk.modules))};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const {raw, gzip} = await measureCoreStage();
  console.log(JSON.stringify({package: 'margoengine', raw, gzip, limit: CORE_STAGE_GZIP_LIMIT, baseline: 20_065, delta: gzip - 20_065}, null, 2));
}
