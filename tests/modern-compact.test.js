import test from 'node:test';
import assert from 'node:assert/strict';
import {compactInternals} from '../scripts/compact-internals.js';

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
