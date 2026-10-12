import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
const npm=process.env.npm_execpath;assert.ok(npm,'Run through npm run modern:test:interop:packages');
const archives=resolve('test-results/interop-packages');await mkdir(archives,{recursive:true});
const fixture=await mkdtemp(resolve('test-results/interop-consumer-'));
const names=['core','geometry','gltf-pro','blender','loaders','exporters','ifc','xr','usdz'],dependencies={'web-ifc':'0.0.78'};
for(const name of names) {
  const [pack]=JSON.parse(execFileSync(process.execPath,[npm,'pack','--workspace',`@margoengine/${name}`,'--ignore-scripts','--pack-destination',archives,'--json'],{encoding:'utf8'}));
  const files=new Set(pack.files.map(file=>file.path));for(const file of ['dist/index.js','dist/index.d.ts','README.md','LICENSE'])assert.ok(files.has(file),`${name}: missing ${file}`);
  assert.ok(pack.files.every(file=>['package.json','README.md','LICENSE',...(name==='usdz'?['THIRD-PARTY-NOTICES.txt']:[]),...(name==='blender'?['FORMAT.md']:[])].includes(file.path)||file.path.startsWith('dist/')));
  if(name==='usdz')assert.ok(files.has('THIRD-PARTY-NOTICES.txt'));
  dependencies[`@margoengine/${name}`]=`file:${join(archives,pack.filename).replaceAll('\\','/')}`;
}
await writeFile(join(fixture,'package.json'),JSON.stringify({private:true,type:'module',dependencies}));
execFileSync(process.execPath,[npm,'install','--ignore-scripts','--no-audit','--no-fund'],{cwd:fixture,stdio:'inherit'});
await writeFile(join(fixture,'consumer.ts'),await readFile('tests/modern-interop-consumer.ts','utf8'));
for(const name of ['xr','ifc','usdz','blender']) {
  const markdown=await readFile(`packages/${name}/README.md`,'utf8'),code=/```ts\r?\n([\s\S]*?)```/.exec(markdown)[1];await writeFile(join(fixture,`${name}-readme.ts`),code);
}
await writeFile(join(fixture,'tsconfig.json'),JSON.stringify({compilerOptions:{strict:true,skipLibCheck:false,module:'NodeNext',moduleResolution:'NodeNext',target:'ES2022',lib:['ES2022','DOM'],types:[],noEmit:true},include:['*.ts']}));
execFileSync(process.execPath,[resolve('node_modules/typescript/bin/tsc'),'-p',join(fixture,'tsconfig.json')],{stdio:'inherit'});
execFileSync(process.execPath,[resolve('node_modules/typescript/bin/tsc'),'-p',join(fixture,'tsconfig.json'),'--module','ESNext','--moduleResolution','Bundler'],{stdio:'inherit'});
await writeFile(join(fixture,'imports.mjs'),`import {XR,XRManager,XRController,useXRSession} from '@margoengine/xr';import {parseIFC} from '@margoengine/ifc';import {parseUSDZ} from '@margoengine/loaders';import {exportUSDZ} from '@margoengine/exporters';import {parseUSDC,loadUSDZ,parseUSDZ as parsePBRUSDZ} from '@margoengine/usdz';import {decodeMargo,parseMargo,loadMargo} from '@margoengine/blender';if([XR.create,XRManager.create,XRController,useXRSession,parseIFC,parseUSDZ,exportUSDZ,parseUSDC,loadUSDZ,parsePBRUSDZ,decodeMargo,parseMargo,loadMargo].some(value=>typeof value!=='function'))throw new Error('Missing packaged export');console.log('Packed ESM imports and strict NodeNext/Bundler TypeScript/README checks passed');`);
execFileSync(process.execPath,[join(fixture,'imports.mjs')],{stdio:'inherit'});
