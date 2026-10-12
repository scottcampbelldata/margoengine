import {execFileSync} from 'node:child_process';
import {copyFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {build} from 'vite';
const root=fileURLToPath(new URL('..',import.meta.url)),repository=resolve(root,'../..');
await copyFile(resolve(repository,'LICENSE'),resolve(root,'LICENSE'));
await build({root,configFile:false,publicDir:false,logLevel:'warn',build:{outDir:resolve(root,'dist'),emptyOutDir:true,target:'es2022',lib:{entry:resolve(root,'src/index.ts'),formats:['es'],fileName:'index'},rollupOptions:{external:['@margoengine/core','@margoengine/core/extension']}}});
execFileSync(process.execPath,[resolve(repository,'node_modules/typescript/bin/tsc'),'-p',resolve(root,'tsconfig.json')],{stdio:'inherit'});
