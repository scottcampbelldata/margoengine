import test from 'node:test';
import assert from 'node:assert/strict';
import {compactInternals} from '../scripts/compact-internals.js';
import {compactOutput} from '../scripts/measure-size.js';
import {minifySync} from 'rolldown/utils';
import {wgsl} from '../packages/core/dist/shaders.js';

test('library compaction preserves public members and foreign this bindings',()=>{
 const source='class Stage { private imports = 1; public value() { return this.imports; } }';
 const output=compactInternals(source,`class Stage {
 imports = 1;
 value() { return [this.imports, () => this.imports, function() { return this.imports; }, {run() { return this.imports; }}]; }
 }`);
 assert.ok(output.includes('a = 1'));
 assert.ok(output.includes('[this.a, () => this.a, function() { return this.imports; }, {run() { return this.imports; }}]'));
 assert.throws(()=>compactInternals(source,'class Stage { a = 2; imports = 1; }'),/collides/);
 assert.throws(()=>compactInternals(source,'class Stage { imports = 1; get() { return this["imports"]; } }'),/computed/);
 assert.throws(()=>compactInternals(source.replace('private','public'),'class Stage {}'),/Review Stage.imports/);
});

test('production compaction drops debugger and preserves public exports',()=>{
 const {code}=minifySync('smoke.js','export function publicName(longArgument) { debugger; return longArgument; }',{module:true,...compactOutput.minify});
 assert.doesNotMatch(code,/debugger|longArgument/);
 assert.match(code,/publicName/);
});

test('compacted WGSL preserves the optional shader injection boundaries',()=>{
 for(const token of ['o.clip=frame.camera*p','@location(3) material:vec4f','o.color=i.color.rgb;','let p=model*vec4f(i.position,1);','let facing=','frame.radiance.w','let n=normalize(i.normal)','@fragment fn fragment(i:Output,@builtin(front_facing) front:bool)->@location(0) vec4f','->@location(0) vec4f {'])assert.ok(wgsl.includes(token),token);
 for(const pattern of [/struct Frame \{[^}]+\}/,/struct Input \{[^}]+\}/,/struct Output \{[^}]+\}/,/@vertex fn vertex\([\s\S]*?(?=@fragment)/,/(@fragment fn fragment[^{]+\{)/,/let linear=([^;]+);/,/let mapped=linear\/[\s\S]*?return vec4f\([^\n]+\);/,/let direct=[\s\S]*return vec4f\([^\n]+\);/,/let v=normalize\(frame.eye.xyz-i.position\);[\s\S]*?let linear=[^;]+;/,/let n=normalize\(i.normal\)[\s\S]*$/])assert.match(wgsl,pattern);
});
