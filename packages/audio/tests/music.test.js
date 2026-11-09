import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioListener } from '../dist/index.js';
import { AudioMusic } from '../dist/music.js';
import { FakeAudioContext } from './fake-web-audio.js';

function setup(options = {}) {
  const context = new FakeAudioContext({state:'running'});
  const listener = new AudioListener({context});
  const stems = {a:context.createBuffer(1, 96000, 48000), b:context.createBuffer(1, 96000, 48000)};
  const states = {idle:{a:0}, combat:{a:-6,b:0}};
  const music = new AudioMusic(listener, stems, states, options);
  return {context, listener, stems, states, music};
}
const fader = source => [...[...[...source.outputs][0].outputs][0].outputs][0];

test('stems share start and loop phase; beat/bar transitions use the audio clock and mixer automation', () => {
  const s = setup();
  assert.equal(s.music.start('idle', 1), 1);
  const [a,b] = s.context.bufferSources;
  for (const source of [a,b]) {
    assert.deepEqual(source.started, {when:1,offset:0,duration:undefined});
    assert.equal(source.loop, true);
    assert.equal(source.loopEnd, 2);
  }
  assert.equal(a.buffer, s.stems.a);
  assert.equal(fader(a).gain.value, 1);
  assert.equal(fader(b).gain.value, 0);
  s.context.currentTime = 1.1;
  assert.equal(s.music.transition('combat', {quantize:'beat'}), 1.5);
  assert.deepEqual(fader(b).gain.last(), ['target',1,1.5,0.005]);
  assert.equal(s.music.transition('idle'), 3);
  assert.equal(s.music.transition('combat', {after:3,fade:0}), 3);
  assert.deepEqual(fader(b).gain.last(), ['set',1,3]);
  assert.equal(s.music.transition('idle', {after:3.01}), 5);
  s.listener.dispose();
  assert.ok([a,b].every(source => source.stopped && source.outputs.size === 0));
  assert.throws(() => s.music.transition('idle'), e => e.code === 'disposed' && /errors#disposed/.test(e.message));
});

test('invalid requests preserve sounding sources and automation; states are copied; restart clears pending events', () => {
  const s = setup({leadTime:0});
  s.states.idle.a = -20;
  s.music.start('idle');
  const source = s.context.bufferSources[0], param = fader(source).gain;
  assert.equal(param.value, 1);
  const before = [...param.events];
  for (const action of [() => s.music.start('idle'), () => s.music.transition('missing'),
    () => s.music.transition('idle',{quantize:'bad'}), () => s.music.transition('idle',{after:NaN}),
    () => s.music.transition('idle',{fade:-1})]) assert.throws(action);
  assert.deepEqual(param.events, before);
  assert.equal(source.stopped, null);
  s.music.transition('combat',{after:10});
  s.music.stop();
  assert.equal(source.outputs.size,0);
  s.context.currentTime = 1;
  assert.equal(s.music.start('idle'),1);
  assert.deepEqual(param.events.slice(-2), [['cancel',1],['set',1,1]]);
  s.music.dispose(); s.music.dispose(); s.listener.dispose();
});

test('grid, buffer length and complete state validation happen before graph allocation', () => {
  const context = new FakeAudioContext(), listener = new AudioListener({context});
  const buffer = context.createBuffer(1,96000,48000);
  for (const options of [{bpm:0},{bpm:NaN},{bpm:Number.MIN_VALUE},{beatsPerBar:1.5},{loopBeats:0},{fade:-1},{leadTime:Infinity}])
    assert.throws(() => new AudioMusic(listener,{a:buffer},{idle:{}},options));
  for (const [stems,states] of [[{}, {idle:{}}],[{a:{duration:1}}, {idle:{}}], [{a:buffer},{}],
    [{a:buffer},{idle:{b:0}}],[{a:buffer},{idle:{a:NaN}}],[{a:buffer},{idle:{a:10000}}]])
    assert.throws(() => new AudioMusic(listener,stems,states));
  assert.equal(context.bufferSources.length,0);
  const music = new AudioMusic(listener,{a:buffer},{idle:{}});
  assert.throws(() => music.transition('idle'), e => e.code === 'state');
  assert.throws(() => music.start('idle', -1));
  listener.dispose();
});
