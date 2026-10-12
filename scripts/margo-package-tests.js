import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir,mkdtemp,readFile,writeFile,copyFile,readdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
const requested=["input","ecs","fsm","navmesh","cinematic","splines","transitions","toon","water","sky","selection","wfc","procedural","road","scatter","html","video","net","stats","inspector","navigation","tween","fbx","usdz-export","bvh","lines","environment","geometry","loaders","exporters","decoders","text","controls","gizmo","points","audio","physics","terrain"];
const npm=process.env.npm_execpath;assert.ok(npm,'Run through npm run test:modules:packages');
const archives=resolve('test-results/margo-packages');await mkdir(archives,{recursive:true});
const fixture=await mkdtemp(resolve('test-results/margo-consumer-'));await writeFile(join(fixture,'package.json'),'{"private":true,"type":"module"}');
const packed=[];
for(const name of await readdir('packages')){
 let manifest;try{manifest=JSON.parse(await readFile(join('packages',name,'package.json'),'utf8'));}catch(error){if(error.code==='ENOENT')continue;throw error;}
 const [pack]=JSON.parse(execFileSync(process.execPath,[npm,'pack',resolve('packages',name),'--ignore-scripts','--json','--pack-destination',archives],{encoding:'utf8'}));
 const files=new Set(pack.files.map(file=>file.path));assert.ok(files.has('dist/index.js')&&files.has('dist/index.d.ts')&&files.has('LICENSE'),name+' missing distribution files');
 const target=join(fixture,'node_modules',...manifest.name.split('/'));await mkdir(target,{recursive:true});execFileSync('tar',['-xf',join(archives,pack.filename),'-C',target,'--strip-components','1']);
 assert.equal(manifest.name,name==='margoengine'?name:'@margoengine/'+name);assert.equal(manifest.sideEffects,false);
 for(const entry of Object.values(manifest.exports))for(const path of Object.values(entry))assert.ok(files.has(path.slice(2)),manifest.name+' missing packed export '+path);
 packed.push(manifest.name);
 if(requested.includes(name))assert.equal(manifest.peerDependencies['@margoengine/core'],name==='terrain'?'0.1.0':'^0.1.0 || ^1.0.0');
}
await copyFile('tests/margo-module-consumer.ts',join(fixture,'consumer.ts'));
for(const [module,moduleResolution] of [['ESNext','Bundler'],['NodeNext','NodeNext']]){
 await writeFile(join(fixture,'tsconfig.json'),JSON.stringify({compilerOptions:{strict:true,target:'ES2022',module,moduleResolution,types:[],lib:['ES2022','DOM'],noEmit:true},include:['consumer.ts']}));
 execFileSync(process.execPath,[resolve('node_modules/typescript/bin/tsc'),'-p',join(fixture,'tsconfig.json')],{stdio:'inherit'});
}
await writeFile(join(fixture,'runtime.js'),packed.map(name=>'await import('+JSON.stringify(name)+');').join('\n'));
execFileSync(process.execPath,[join(fixture,'runtime.js')],{stdio:'inherit'});
console.log('All '+packed.length+' packages contain their exports and import without browser globals; public module consumers compile in strict Bundler and NodeNext.');
