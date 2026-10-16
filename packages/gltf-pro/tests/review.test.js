import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {pbrShader} from '../src/shader.ts';
import {prepareMaterialExtension,materialExtensionShader,materialExtensionAmbientShader} from '../src/material-extension.ts';

test('named base lighting keeps all prior resources and optional lighting splice sites',async()=>{
  // Compare shader content independently of Git's Windows checkout line endings.
  const before=(await readFile(new URL('./fixtures/pbr-before-naming.wgsl',import.meta.url),'utf8')).replaceAll('\r\n','\n');
  assert.equal(createHash('sha256').update(before).digest('hex'),'1920d3bb180dbf0fa32fe4d373a3c03bdfccbdc834fb02a26fcb1b8dfeeffa5b');
  assert.match(pbrShader,/fn direct_light\(s:Surface,v:vec3f,l:vec3f\)->vec3f/);assert.match(pbrShader,/let direct=direct_light\(s,v,l\)/);
  assert.match(pbrShader,/fn hemisphere_ambient\(s:Surface\)->vec3f/);assert.match(pbrShader,/fn ambient\(s:Surface\)->vec3f \{\n  return hemisphere_ambient\(s\);\n\}/);
  assert.ok(pbrShader.includes('direct+ambient(s)'));assert.ok(pbrShader.includes('return vec4f(ambient(s),'));
  const resources=code=>code.match(/@group\([^\n]+/g);assert.deepEqual(resources(pbrShader),resources(before));
  assert.equal(/struct Frame \{[\s\S]*?\n\}/.exec(pbrShader)[0],/struct Frame \{[\s\S]*?\n\}/.exec(before)[0]);
  const extension={direct:'direct*=0.5;',ambient:'materialAmbient*=0.5;'};
  const code=materialExtensionAmbientShader(materialExtensionShader(pbrShader,extension),extension);
  assert.match(code,/var direct=direct_light\(s,v,l\)/);assert.match(code,/var materialAmbient=ambient\(s\)/);
});
test('raw material declarations reject binding ownership before allocating or modifying previous resources',()=>{
  let touched=0;const device={get limits(){touched++;throw new Error('Validation must happen first');}},previous={bytes:16,entries:[{binding:0}],groups:new Map(),uniform:{destroy(){assert.fail('Existing uniform must remain usable');}}};
  const declarations=['@group(2) @binding(0) var t:texture_2d<f32>;','@binding(4) var<uniform> t:vec4f;','@ group(3) var t:f32;','@\n binding(1) var t:f32;','// @group(3) is still a rejected raw string'];
  for(const value of declarations){const extension={declarations:value,factors:new Float32Array([1,1,1,1])};assert.throws(()=>prepareMaterialExtension(device,extension,previous),/cannot declare @group or @binding/);assert.throws(()=>materialExtensionShader(pbrShader,extension),/use factors and textures/);}
  assert.equal(touched,0);assert.equal(previous.bytes,16);assert.deepEqual(previous.entries,[{binding:0}]);
});
test('helper declarations remain valid while factors and textures generate the reserved group bindings',()=>{
  const declarations='fn materialGain(value:f32)->f32{return value*0.5;}';
  const extension={declarations,factors:new Float32Array([1,1,1,1]),textures:[{view:{},sampler:{}}]};
  const code=materialExtensionShader(pbrShader,extension);assert.ok(code.includes(declarations));assert.match(code,/@group\(3\) @binding\(0\) var<uniform> materialFactors/);assert.match(code,/@group\(3\) @binding\(1\) var materialTexture0/);assert.match(code,/@group\(3\) @binding\(2\) var materialSampler0/);
  assert.doesNotThrow(()=>materialExtensionShader(pbrShader,{}));
});
