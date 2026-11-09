import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioListener } from '../dist/index.js';
import { AudioReverbZones } from '../dist/zones.js';
import { FakeAudioContext, FakeNode } from './fake-web-audio.js';

function setup() {
  const context = new FakeAudioContext({state:'running'});
  const nodes = [];
  context.createConvolver = () => { const node = new FakeNode(context,'convolver');nodes.push(node);return node; };
  context.createBuffer = (channels,length,sampleRate) => {
    const data = Array.from({length:channels},()=>new Float32Array(length));
    return {numberOfChannels:channels,length,sampleRate,duration:length/sampleRate,getChannelData:i=>data[i]};
  };
  const listener = new AudioListener({context});
  const zones = [
    {name:'room',min:[-2,-2,-2],max:[2,2,2],reverb:{tailGain:0}},
    {name:'closet',min:[0,-1,-1],max:[1,1,1],priority:1,gain:0.5,reverb:{tailGain:0}},
  ];
  return {context,nodes,listener,zones};
}

test('inclusive bounds, priority and stable ties select wet sends without rebuilding convolution', () => {
  const s = setup();
  const controller = new AudioReverbZones(s.listener,s.zones,{fade:0.2});
  const sends = [...controller.input.outputs];
  assert.equal(controller.active,'closet');
  assert.deepEqual(sends[1].gain.last(),['target',0.5,0,0.05]);
  s.listener.setPose([-2,0,0],[0,0,-1]); s.listener.update();
  assert.equal(controller.active,'room');
  assert.deepEqual(sends[1].gain.last(),['target',0,0,0.05]);
  const count = sends[0].gain.events.length;
  s.listener.update(); assert.equal(sends[0].gain.events.length,count);
  s.zones[0].min[0] = 20;
  s.listener.setPose([2,0,0],[0,0,-1]); s.listener.update();
  assert.equal(controller.active,'room');
  s.listener.setPose([2.01,0,0],[0,0,-1]); s.listener.update();
  assert.equal(controller.active,null);
  assert.equal(s.nodes.length,2);
  assert.ok(s.nodes.every(node=>node.normalize===false));
  s.listener.dispose();
  assert.ok(s.nodes.every(node=>node.outputs.size===0));
  assert.ok(sends.every(node=>node.outputs.size===0));
  assert.equal(controller.input.outputs.size,0);
  assert.throws(()=>controller.update(), e=>e.code==='disposed' && /errors#disposed/.test(e.message));
  controller.dispose();
  const t = setup();t.zones[1].priority=0;
  const tied = new AudioReverbZones(t.listener,t.zones,{fade:0});
  assert.equal(tied.active,'room');
  t.listener.dispose();
});

test('invalid complete specs and sparse coordinates reject; delegated room failure releases earlier graphs', () => {
  const s = setup();
  for (const extra of [{name:''},{name:'room'},{min:[,0,0]},{max:[-4,0,0]},{gain:2},{priority:NaN}])
    assert.throws(()=>new AudioReverbZones(s.listener,[s.zones[0],{...s.zones[1],...extra}]));
  assert.equal(s.nodes.length,0);
  assert.throws(()=>new AudioReverbZones(s.listener,s.zones,{fade:NaN}));
  assert.throws(()=>new AudioReverbZones(s.listener,[s.zones[0],{...s.zones[1],reverb:{room:[0,1,1]}}]));
  assert.ok(s.nodes.every(node=>node.outputs.size===0));
  const empty = new AudioReverbZones(s.listener,[]);
  assert.equal(empty.active,null);
  s.listener.dispose();
});
