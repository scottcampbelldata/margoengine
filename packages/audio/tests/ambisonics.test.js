import test from 'node:test';import assert from 'node:assert/strict';
import {AudioListener} from '../dist/index.js';import {AmbisonicAudio} from '../dist/ambisonics.js';
import {FakeAudioContext,FakeNode} from './fake-web-audio.js';
import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';
function setup(){
 const context=new FakeAudioContext({state:'running'}),nodes=[];
 for(const [method,kind] of [['createChannelSplitter','splitter'],['createChannelMerger','merger']])
   context[method]=channels=>{const n=new FakeNode(context,kind);n.channels=channels;nodes.push(n);return n;};
 const listener=new AudioListener({context,smoothing:0});
 const buffer=context.createBuffer(4,48000,48000);
 return {context,nodes,listener,buffer};
}
const coefficients=s=>[...[...s.nodes[0].outputs]].map(n=>n.gain.value);
const near=(a,b)=>{assert.equal(a.length,b.length);a.forEach((v,i)=>assert.ok(Math.abs(v-b[i])<1e-12,`${i}: ${v} vs ${b[i]}`));};
test('ACN/SN3D matrix preserves W and maps front/left/up with listener and full quaternion rotations',()=>{
 const s=setup(),bed=new AmbisonicAudio(s.listener,s.buffer);
 near(coefficients(s),[.5,.25,0,Math.sqrt(3)/4,.5,-.25,0,Math.sqrt(3)/4]);
 bed.setRotation([0,Math.SQRT1_2,0,Math.SQRT1_2]);
 near(coefficients(s),[.5,-Math.sqrt(3)/4,0,.25,.5,-Math.sqrt(3)/4,0,-.25]);
 s.listener.setPose([100,40,-2],[-1,0,0]);s.listener.update();
 near(coefficients(s),[.5,.25,0,Math.sqrt(3)/4,.5,-.25,0,Math.sqrt(3)/4]);
 bed.setRotation([0,0,0,2]);s.listener.setPose([0,0,0],[0,1,0],[0,0,1]);s.listener.update();
 near(coefficients(s),[.5,.25,Math.sqrt(3)/4,0,.5,-.25,Math.sqrt(3)/4,0]);
 bed.setRotation([0,0,Math.SQRT1_2,Math.SQRT1_2]);
 near(coefficients(s),[.5,-Math.sqrt(3)/4,.25,0,.5,-Math.sqrt(3)/4,-.25,0]);
 s.listener.dispose();assert.ok(s.nodes.every(n=>n.outputs.size===0));
});
test('source lifecycle, scheduled stop, natural end and validation preserve live playback',()=>{
 const s=setup(),bed=new AmbisonicAudio(s.listener,s.buffer,{loop:false,volume:0.5});
 bed.play(1);const source=s.context.bufferSources[0];
 assert.equal(source.loop,false);assert.equal(source.started.when,1);assert.equal(bed.isPlaying,true);
 const before=coefficients(s);
 for(const action of [()=>bed.play(),()=>bed.volume=2,()=>bed.setRotation([0,0,0,0]),()=>bed.setRotation([,0,0,1])])assert.throws(action);
 near(coefficients(s),before);assert.equal(source.stopped,null);assert.equal(bed.volume,0.5);
 source.end();assert.equal(bed.isPlaying,false);assert.equal(source.outputs.size,0);
 bed.play();bed.stop();assert.equal(bed.isPlaying,false);
 bed.play();s.listener.dispose();assert.equal(bed.isPlaying,false);bed.dispose();
 assert.throws(()=>bed.play(),e=>e.code==='disposed'&&/errors#disposed/.test(e.message));
});
test('unsupported formats/channels and invalid settings fail before allocating a decoder',()=>{
 const s=setup();
 for(const options of [{format:'fuma'},{volume:NaN},{smoothing:-1},{loop:1}])assert.throws(()=>new AmbisonicAudio(s.listener,s.buffer,options));
 assert.throws(()=>new AmbisonicAudio(s.listener,s.context.createBuffer(9,48,48000)),e=>e.code==='unsupported');
 assert.equal(s.nodes.length,0);
 s.listener.setPose([0,0,0],[0,1,0],[0,1,0]);
 assert.throws(()=>new AmbisonicAudio(s.listener,s.buffer),e=>e.code==='state');
 assert.ok(s.nodes.every(n=>n.outputs.size===0));s.listener.dispose();
});
test('licensed external rain stimulus excerpt stays pinned with four discrete 24-bit channels',()=>{
 const base=new URL('./fixtures/',import.meta.url),record=JSON.parse(readFileSync(new URL('rain-foa.json',base)));
 const bytes=readFileSync(new URL(record.excerpt.file,base));
 assert.equal(createHash('sha256').update(bytes).digest('hex'),record.excerpt.sha256);
 assert.equal(bytes.length,record.excerpt.bytes);assert.equal(bytes.readUInt16LE(22),4);
 assert.equal(bytes.readUInt16LE(34),24);assert.equal(bytes.readUInt32LE(24),44100);
 assert.equal(record.license,'CC-BY-4.0');assert.match(record.source,/zenodo.org\/records\/10227483/);
});
