import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Tonemap,parseCube} from '../dist/index.js';
import {DOF} from '../../dof/dist/index.js';
import {gpuHarness} from '../../../tests/support/postfx-gpu.js';

function cube(){let text='TITLE "Identity"\nLUT_3D_SIZE 33\nDOMAIN_MIN -1 0 0\nDOMAIN_MAX 1 1 1\n';
  for(let b=0;b<33;b++)for(let g=0;g<33;g++)for(let r=0;r<33;r++)text+=`${r/32} ${g/32} ${b/32}\n`;return text;
}
const text=cube();
test('.cube parser honors red-fastest order, domains, comments, scientific notation and exact counts',()=>{
  const lut=parseCube('\uFEFF# comment\r\n'+text.replace('TITLE "Identity"','TITLE "Identity # LUT" # title comment').replace('0 0 0','0e0 +0.0 .0 # sample'));
  assert.ok(lut.data instanceof Float32Array);assert.equal(lut.data.length,33**3*4);assert.deepEqual([...lut.domainMin],[-1,0,0]);
  assert.equal(lut.data[4],1/32);assert.equal(lut.data[33*4+1],1/32);assert.equal(lut.data[33*33*4+2],1/32);assert.deepEqual([...lut.data.slice(-4)],[1,1,1,1]);
  for(const invalid of [text.replace('33','32'),text+'0 0 0\n',text.replace('0 0 0','NaN 0 0'),text.replace('0 0 0','0x10 0 0'),text.replace('0 0 0','1e50 0 0'),
    text.replace('DOMAIN_MAX 1 1 1','DOMAIN_MAX -1 1 1'),text.replace('DOMAIN_MIN -1 0 0','DOMAIN_MIN -1 0 0\nDOMAIN_MIN 0 0 0'),text.replace('LUT_3D_SIZE 33','LUT_1D_SIZE 33'),text.slice(0,text.lastIndexOf('1 1 1\n')),text.replace('LUT_3D_SIZE 33','LUT_3D_SIZE 33\nLUT_3D_SIZE 33')])assert.throws(()=>parseCube(invalid));
});

test('Tonemap validates color controls and the standalone color space',()=>{
  for(const options of [{curve:'bad'},{exposure:NaN},{exposure:17},{contrast:-1},{contrast:5},{source:3},{inputColorSpace:'acescg'},{inputColorSpace:'srgb'}])assert.throws(()=>new Tonemap(options));
  assert.throws(()=>new Tonemap().setup({gpu:null}),/WebGPU/);
});

test('Tonemap reuses resources, snapshots LUT data and releases/restores all owned resources',()=>{
  const h=gpuHarness(),effect=Tonemap.attach(h.engine,{curve:'neutral'}),lut=parseCube(text);effect.setLUT(lut);lut.data[0]=NaN;
  h.frame();assert.equal(h.writes[2],2);assert.equal(h.writes[3],1);assert.equal(h.writes[4],-1);assert.equal(h.context.color,h.originalColor);
  const before={...h.counts},descriptor=h.context.presentation;for(let i=0;i<40;i++)h.frame();
  for(const key of ['buffers','textures','views','groups','uploads'])assert.equal(h.counts[key],before[key]);assert.equal(h.context.presentation,descriptor);
  effect.options.exposure=2;effect.options.contrast=1.5;effect.options.curve='acescg';h.frame();assert.equal(h.writes[0],2);assert.equal(h.writes[1],1.5);assert.equal(h.writes[2],1);
  effect.onDeviceRestored(h.engine);h.frame();assert.equal(h.writes[3],1);effect.setLUT(null);h.frame();assert.equal(h.writes[3],0);
  effect.destroy();effect.destroy();assert.ok(h.resources.every(r=>r.destroyed));assert.equal(h.engine.hasPlugin('tonemap'),false);assert.throws(()=>effect.setLUT(null),/disposed/);
});

test('DOF HDR chaining works on resize/restoration and rejects missing or invalid source textures',()=>{
  const h=gpuHarness(),dof=DOF.attach(h.engine);assert.throws(()=>Tonemap.attach(h.engine),/HDR source/);
  const grade=Tonemap.attach(h.engine,{source:()=>dof.outputTexture});h.frame();assert.equal(h.counts.compute,3);assert.equal(h.context.color,h.originalColor);
  h.context.width=256;h.frame();assert.equal(dof.outputTexture.width,256);
  dof.onDeviceRestored(h.engine);grade.onDeviceRestored(h.engine);h.frame();grade.destroy();dof.destroy();assert.ok(h.resources.every(r=>r.destroyed));
  const missing=gpuHarness(),invalid=Tonemap.attach(missing.engine,{source:()=>undefined});assert.throws(missing.frame,/HDR texture/);invalid.destroy();
  const wrong=gpuHarness(),texture=wrong.engine.gpu.createTexture({size:[128,96],format:'rgba8unorm',usage:4});const bad=Tonemap.attach(wrong.engine,{source:()=>texture});assert.throws(wrong.frame,/HDR texture/);bad.destroy();texture.destroy();
});

test('optional manifests preserve the frozen core peer contract and tree shaking',()=>{
  for(const name of ['dof','tonemap']){const pkg=JSON.parse(readFileSync(new URL(`../../${name}/package.json`,import.meta.url),'utf8'));
    assert.deepEqual(pkg.peerDependencies,{'@margoengine/core':`^${pkg.version}`});assert.equal(pkg.dependencies,undefined);assert.equal(pkg.sideEffects,false);
    const code=readFileSync(new URL(`../../${name}/dist/index.js`,import.meta.url),'utf8');assert.match(code,/@margoengine\/core\/extension/);assert.doesNotMatch(code,/wasmBase64|class TransformStore/);
  }
});
