import {execFileSync} from 'node:child_process';
import {copyFile,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
const root=fileURLToPath(new URL('..',import.meta.url)),repository=resolve(root,'../..');
await rm(resolve(root,'dist'),{recursive:true,force:true});
await copyFile(resolve(repository,'LICENSE'),resolve(root,'LICENSE'));
execFileSync(process.execPath,[resolve(repository,'node_modules/typescript/bin/tsc'),'-p',resolve(root,'tsconfig.json')],{stdio:'inherit'});
