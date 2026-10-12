import {defineConfig} from 'vite';
import {fileURLToPath} from 'node:url';

// Production checks public distributions; development survives package rebuilds.
export default defineConfig(({command})=>({resolve:command==='serve'?{alias:[
  {find:'@margoengine/core/extension',replacement:fileURLToPath(new URL('../../packages/core/src/extension.ts',import.meta.url))},
  {find:'@margoengine/core',replacement:fileURLToPath(new URL('../../packages/core/src/index.ts',import.meta.url))},
]}:undefined,server: {host: '127.0.0.1'}, build: {target: 'es2022'}}));
