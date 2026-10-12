import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
const names=['core','gltf-pro','animation','shadows','clustered','vfx','animator','taa','splats','terrain'],npm=process.env.npm_execpath;
assert.ok(npm,'Run through npm run modern:test:game:packages');
const archives=resolve('test-results/game-packages');await mkdir(archives,{recursive:true});
const dependencies={};
for(const name of [...names,'geometry']){
  const scoped='@margoengine/'+name;
  const [pack]=JSON.parse(execFileSync(process.execPath,[npm,'pack','--workspace',scoped,'--ignore-scripts','--pack-destination',archives,'--json'],{encoding:'utf8'}));
  const files=new Set(pack.files.map(f=>f.path));assert.ok(files.has('README.md')&&files.has('LICENSE')&&files.has('dist/index.js')&&files.has('dist/index.d.ts'));dependencies[scoped]='file:'+join(archives,pack.filename).replaceAll('\\','/');
}
const fixture=await mkdtemp(resolve('test-results/game-consumer-'));await writeFile(join(fixture,'package.json'),JSON.stringify({private:true,type:'module',dependencies}));
execFileSync(process.execPath,[npm,'install','--offline','--ignore-scripts','--no-audit','--no-fund'],{cwd:fixture,stdio:'inherit'});
for(const name of names.slice(3)){
  const markdown=await readFile('packages/'+name+'/README.md','utf8');for(const [index,[,code]] of [...markdown.matchAll(/```ts\r?\n([\s\S]*?)```/g)].entries())await writeFile(join(fixture,`${name}-${index}.ts`),code);
}
await writeFile(join(fixture,'integration.ts'),`import {EngineKernel} from '@margoengine/core';
import {loadGLTF} from '@margoengine/gltf-pro';
import {Animation} from '@margoengine/animation';
import {Shadows} from '@margoengine/shadows';
import {Clustered} from '@margoengine/clustered';
import {Terrain} from '@margoengine/terrain';
import {Animator} from '@margoengine/animator';
import {TAA} from '@margoengine/taa';
import {Splats} from '@margoengine/splats';
async function integrate(engine:EngineKernel,terrain:Terrain){const model=await loadGLTF(engine,'/hero.glb');const animation=Animation.attach(model);Animator.attach(animation,{states:{idle:animation.clips[0].name},initial:'idle'});const shadows=Shadows.attach(engine),lights=Clustered.attach(engine),taa=TAA.attach(engine);shadows.add(model);shadows.add(terrain,{static:true});lights.add(model);lights.add(terrain);taa.add(model);Splats.attach(engine,{positions:new Float32Array([0,0,0]),covariances:new Float32Array([1,0,0,1,0,1]),colors:new Float32Array([1,1,1,1])});}
`);
await writeFile(join(fixture,'tsconfig.json'),JSON.stringify({compilerOptions:{strict:true,target:'ES2022',module:'NodeNext',moduleResolution:'NodeNext',types:[],lib:['ES2022','DOM'],noEmit:true},include:['*.ts']}));
execFileSync(process.execPath,[resolve('node_modules/typescript/bin/tsc'),'-p',join(fixture,'tsconfig.json')],{stdio:'inherit'});
console.log('Eleven packed packages, seven standalone README examples and PBR/terrain integration compiled.');
