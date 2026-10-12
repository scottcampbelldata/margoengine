import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';

const npm=process.env.npm_execpath;assert.ok(npm,'Run through npm run modern:test:postfx:packages');
const archives=resolve('test-results/postfx-packages');await mkdir(archives,{recursive:true});
const fixture=await mkdtemp(resolve('test-results/postfx-consumer-'));
await writeFile(join(fixture,'package.json'),'{"private":true,"type":"module"}');
for(const name of ['core','dof','tonemap']){
  const [pack]=JSON.parse(execFileSync(process.execPath,[npm,'pack',resolve('packages',name),'--ignore-scripts','--json','--pack-destination',archives],{encoding:'utf8'}));
  const files=new Set(pack.files.map(file=>file.path));assert.ok(files.has('dist/index.js')&&files.has('dist/index.d.ts')&&files.has('LICENSE'));
  assert.ok(pack.files.every(file=>['package.json','README.md','LICENSE','NOTICE.md'].includes(file.path)||file.path.startsWith('dist/')));
  const target=join(fixture,'node_modules','@margoengine',name);await mkdir(target,{recursive:true});
  execFileSync('tar',['-xf',join(archives,pack.filename),'-C',target,'--strip-components','1']);
  const manifest=JSON.parse(await readFile(join(target,'package.json'),'utf8'));
  if(name!=='core'){assert.equal(manifest.peerDependencies['@margoengine/core'],'^1.0.0');assert.equal(manifest.dependencies,undefined);}
}
await writeFile(join(fixture,'consumer.ts'),`import {EngineKernel} from '@margoengine/core';
import {DOF} from '@margoengine/dof';
import {Tonemap,parseCube,type TonemapCurve} from '@margoengine/tonemap';
function use(engine:EngineKernel,curve:TonemapCurve,text:string){
  const dof=DOF.attach(engine,{focalDistance:5,focalLength:0.05,aperture:2.8});
  const grade=Tonemap.attach(engine,{curve,source:()=>dof.outputTexture});
  grade.setLUT(parseCube(text));dof.options.focalDistance=3;dof.enabled=false;
  grade.options.exposure=1;grade.options.contrast=0.8;grade.destroy();dof.destroy();
}
export {use};
`);
await writeFile(join(fixture,'tsconfig.json'),JSON.stringify({compilerOptions:{strict:true,target:'ES2022',module:'NodeNext',moduleResolution:'NodeNext',types:[],lib:['ES2022','DOM'],noEmit:true},include:['consumer.ts']}));
execFileSync(process.execPath,[resolve('node_modules/typescript/bin/tsc'),'-p',join(fixture,'tsconfig.json')],{stdio:'inherit'});
await writeFile(join(fixture,'runtime.js'),`import assert from 'node:assert/strict';import {DOF} from '@margoengine/dof';import {Tonemap,parseCube} from '@margoengine/tonemap';assert.equal(new DOF().name,'dof');assert.equal(new Tonemap().name,'tonemap');assert.throws(()=>parseCube('LUT_3D_SIZE 2'));`);
execFileSync(process.execPath,[join(fixture,'runtime.js')],{stdio:'inherit'});
console.log('Both packed optional packages import and compile in a strict consumer; core peer contract remains ^1.0.0.');
