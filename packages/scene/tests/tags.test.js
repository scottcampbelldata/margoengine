import assert from 'node:assert/strict';
import test from 'node:test';
import { Engine, TransformStore } from '@margoengine/core/extension';
import { tags, findByTag, matchesTags, queryTags, SceneEvents } from '../dist/tags.js';
import { cloneSubtree } from '../dist/clone.js';
import { children, parent, worldMatrix } from '../dist/index.js';
import { attach } from '../dist/graph.js';

const make = async () => new Engine({ width: 16, height: 16, clientWidth: 16, clientHeight: 16 },
  await TransformStore.create(16), { backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {} });

test('tags are unique, atomic, ordered, observable and use OR/AND queries', async () => {
  using e = await make();
  const a=e.createMesh(), b=e.createMesh(a), c=e.createMesh(a), set=tags(b), events=[];
  assert.equal(tags(b),set);
  for(const type of ['add','remove','change']) set.addEventListener(type, event=>events.push([event.type,event.tag,event.mesh]));
  assert.equal(set.add('enemy',['flying','enemy']),true);
  assert.equal(set.add('enemy'),false);
  assert.deepEqual(set.list(),['enemy','flying']); assert.equal(set.size,2);
  assert.equal(events.filter(e=>e[0]==='add').length,2);
  assert.equal(events.filter(e=>e[0]==='change').length,1);
  assert.equal(set.has('missing',['enemy','flying']),true);
  assert.equal(set.has(['enemy','missing']),false);
  assert.equal(set.has([]),false); assert.equal(set.has(),false);
  tags(c).add('friendly');
  assert.deepEqual(findByTag(a,['enemy','flying'],'friendly'),[b,c]);
  assert.throws(()=>set.add('new',5),TypeError);
  assert.equal(set.has('new'),false);
  const list=set.list(); list.length=0; assert.equal(set.size,2);
  assert.equal(set.remove('enemy','unknown'),true);
  set.clear(); assert.equal(set.size,0);
  const copy=cloneSubtree(a);
  assert.deepEqual(tags(children(copy)[1]).list(),['friendly']);
  tags(children(copy)[1]).add('copy'); assert.equal(tags(c).has('copy'),false);
  b.dispose(); assert.throws(()=>set.list(),/disposed/);
});

test('boolean tag expressions follow truth tables, precedence, quotes and bounded syntax', async () => {
  using e = await make();
  const rows=[];
  for(let i=0;i<8;i++) {
    const m=e.createMesh(); rows.push(m);
    for(let bit=0;bit<3;bit++) if(i & (1<<bit)) tags(m).add(['a','b','c'][bit]);
    assert.equal(matchesTags(m,'a || b && !c'),!!((i&1)||((i&2)&&!(i&4))));
    assert.equal(matchesTags(m,'!(a || b) && c'),!!(!(i&3)&&(i&4)));
  }
  assert.deepEqual(queryTags(e.scene,'a && (b || c)'),[rows[3],rows[5],rows[7]]);
  tags(rows[0]).add('space tag','!','a"b');
  assert.equal(matchesTags(rows[0],'"space tag" && "!" && \'a"b\''),true);
  assert.equal(matchesTags(rows[0],'"a\\"b"'),true);
  assert.equal(queryTags(e.scene,'').length,8);
  assert.equal(queryTags(e.scene,'true && !false').length,8);
  for(const input of ['a & b','a b','a ||','(a','a)', '"unterminated','()','!'.repeat(66)+'a'])
    assert.throws(()=>queryTags(e.scene,input), { name: /Error$/ });
  assert.throws(()=>queryTags(e.scene,'a'.repeat(16385)),RangeError);
});

test('attach/clone notifications see finished transforms and metadata; failed clone publishes nothing', async () => {
  using e=await make();
  const a=e.createMesh().setPosition([3,0,0]), b=e.createMesh().setPosition([-2,0,0]), c=e.createMesh(a).setPosition([1,0,0]);
  tags(c).add('ready'); c.name='ready';
  using observer=new SceneEvents(e);
  const before=worldMatrix(c), matrices=[];
  observer.on('added',event=>matrices.push(worldMatrix(event.mesh)),{mesh:c});
  attach(b,c);
  assert.deepEqual(matrices,[before]);
  const copies=[];
  observer.on('added',event=>{ if(event.mesh!==c) copies.push([event.mesh.name,tags(event.mesh).has('ready')]); });
  cloneSubtree(c);
  assert.deepEqual(copies,[['ready',true]]);
  const originalCreate=e.scene.createMesh.bind(e.scene);
  let creations=0;
  e.scene.createMesh=(...args)=>{if(++creations===2)throw new RangeError('allocation');return originalCreate(...args);};
  const count=e.meshes.size, events=[];
  for(const type of ['added','removed','disposed']) observer.on(type,event=>events.push(event));
  assert.throws(()=>cloneSubtree(b),/allocation/);
  assert.deepEqual(events,[]); assert.equal(e.meshes.size,count);
});

test('lifecycle observes existing and new nodes, committed parent changes, disposal routes and root creation', async () => {
  using e = await make();
  const a=e.createMesh(), b=e.createMesh(a), events=[];
  const originalCreate=e.createMesh, originalParent=b.setParent;
  using observer = new SceneEvents(e);
  assert.throws(()=>new SceneEvents(e),/existing observer/);
  for(const type of ['added','removed','disposed']) observer.on(type,event=>{ assert.equal(Object.isFrozen(event),true); events.push(event); });
  const c=e.createMesh();
  assert.deepEqual(events.map(x=>[x.type,x.mesh,x.parent]),[['added',c,null]]);
  events.length=0;
  b.setParent(c); b.setParent(c);
  assert.deepEqual(events.map(x=>[x.type,x.mesh,x.parent]),[['removed',b,a],['added',b,c]]);
  assert.throws(()=>c.setParent(b),/cycle/); assert.equal(events.length,2);
  events.length=0;
  c.dispose(); c.dispose();
  assert.deepEqual(events.map(x=>[x.type,x.mesh,x.parent]),[['removed',b,c],['removed',c,null],['disposed',c,null]]);
  assert.equal(parent(b),null);
  events.length=0;
  const scene=e.createScene('other'), other=scene.createMesh(); events.length=0;
  scene.dispose();
  assert.deepEqual(events.map(x=>[x.type,x.mesh,x.scene]),[['removed',other,scene],['disposed',other,scene]]);
  observer.dispose(); observer.dispose();
  assert.equal(e.createMesh,originalCreate); assert.equal(b.setParent,originalParent);
  assert.throws(()=>observer.on('added',()=>{}),/disposed/);
  using again=new SceneEvents(e);
  const disposed=[]; again.on('disposed',x=>disposed.push(x.mesh));
  e.dispose(); assert.deepEqual(new Set(disposed),new Set([a,b]));
});

test('lifecycle once, abort, unsubscription, filters, reentrancy and listener errors', async () => {
  using e = await make();
  const a=e.createMesh(), b=e.createMesh(), c=e.createMesh();
  using observer=new SceneEvents(e);
  const controller=new AbortController(), seen=[], errors=[];
  e.onError=error=>errors.push(error);
  observer.on('added',event=>{seen.push('once'); event.mesh.setParent(null);},{once:true,mesh:c});
  const off=observer.on('added',()=>seen.push('off')); off();off();
  observer.on('added',()=>seen.push('aborted'),{signal:controller.signal});controller.abort();
  observer.on('added',()=>seen.push('already'),{signal:AbortSignal.abort()});
  observer.on('added',()=>{throw new Error('listener failure');},{mesh:c});
  observer.on('added',()=>seen.push('after'),{mesh:c});
  c.setParent(a);
  await Promise.resolve();
  assert.deepEqual(seen,['once','after']); assert.equal(errors.length,1); assert.equal(parent(c),null);
  c.setParent(b); await Promise.resolve(); assert.deepEqual(seen,['once','after','after']);
  let filtered=0;
  observer.on('disposed',()=>filtered++,{scene:e.scene});
  const other=e.createScene('other'); other.createMesh();other.dispose();assert.equal(filtered,0);
  c[Symbol.dispose](); assert.equal(filtered,1);
});

test('failed observer installation restores wrappers already installed', async () => {
  using e=await make();
  const a=e.createMesh(), b=e.createMesh(), original=a.setParent;
  Object.defineProperty(b,'setParent',{value:b.setParent,configurable:false});
  assert.throws(()=>new SceneEvents(e),TypeError);
  assert.equal(a.setParent,original);
  b.dispose();
  using observer=new SceneEvents(e);
  assert.ok(observer);
});
