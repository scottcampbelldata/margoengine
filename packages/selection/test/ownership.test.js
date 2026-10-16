import test from 'node:test';
import assert from 'node:assert/strict';
import {Picking} from '../dist/index.js';
import {optionalGPU} from '../../../tests/support/optional-gpu.js';

test('forEngine borrows the successfully attached configured picker without allocation or ownership transfer',()=>{
  const h=optionalGPU(),other=optionalGPU(),picker=new Picking({capture:false});
  assert.equal(Picking.forEngine(h.engine),undefined);assert.equal(Picking.forEngine(other.engine),undefined);
  h.engine.use(picker);const counts={...h.counts};
  assert.equal(Picking.forEngine(h.engine),picker);assert.equal(Picking.forEngine(h.engine).options.capture,false);assert.deepEqual(h.counts,counts);
  assert.equal(Picking.forEngine(other.engine),undefined);picker.dispose();assert.equal(Picking.forEngine(h.engine),undefined);assert.ok(h.resources.every(resource=>resource.destroyed));h.cleanup();other.cleanup();
});

test('failed setup never publishes a partial picker and releases its allocations',()=>{
  const h=optionalGPU(),create=h.engine.gpu.createTexture;let textures=0;
  h.engine.gpu.createTexture=descriptor=>{if(++textures===2)throw new Error('Injected picker texture failure');return create(descriptor);};
  assert.throws(()=>h.engine.use(new Picking()),/Injected picker texture failure/);assert.equal(Picking.forEngine(h.engine),undefined);assert.equal(h.engine.hasPlugin('picking'),false);assert.ok(h.resources.every(resource=>resource.destroyed));h.cleanup();
});

test('lookup follows device restoration and removes failed restoration state until retry succeeds',()=>{
  const h=optionalGPU(),picker=Picking.attach(h.engine,{capture:false}),before=h.resources.slice();
  picker.onDeviceRestored(h.engine);assert.equal(Picking.forEngine(h.engine),picker);assert.ok(before.every(resource=>resource.destroyed));
  const create=h.engine.gpu.createTexture;h.engine.gpu.createTexture=()=>{throw new Error('Injected restore failure');};
  assert.throws(()=>picker.onDeviceRestored(h.engine),/Injected restore failure/);assert.equal(Picking.forEngine(h.engine),undefined);
  h.engine.gpu.createTexture=create;picker.onDeviceRestored(h.engine);assert.equal(Picking.forEngine(h.engine),picker);assert.equal(picker.options.capture,false);
  picker.dispose();assert.equal(Picking.forEngine(h.engine),undefined);assert.ok(h.resources.every(resource=>resource.destroyed));h.cleanup();
});

test('disposing an older setup cannot erase a newer picker lookup',()=>{
  const h=optionalGPU(),old=new Picking({capture:true}),current=new Picking({capture:false});
  // Custom plugin hosts may call setup directly. Identity, rather than a shared
  // plugin name, decides which registration an older owner's teardown releases.
  old.setup(h.engine);current.setup(h.engine);assert.equal(Picking.forEngine(h.engine),current);
  old.dispose();assert.equal(Picking.forEngine(h.engine),current);assert.equal(current.options.capture,false);
  current.dispose();assert.equal(Picking.forEngine(h.engine),undefined);assert.ok(h.resources.every(resource=>resource.destroyed));h.cleanup();
});
