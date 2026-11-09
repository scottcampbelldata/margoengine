import { Engine } from '@margoengine/core';
import { AudioListener } from '@margoengine/audio';
import { AudioMusic } from '@margoengine/audio/music';

const assert = (ok, message) => { if (!ok) throw new Error(message); };
export async function runMusicTests() {
  const reports = [];
  for (const backend of ['webgpu', 'webgl2', 'webgl2-compat']) {
    const compat = backend === 'webgl2-compat' ? await import('@margoengine/webgl2-compat') : null;
    if (compat) await compat.install({force:true});
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    document.body.append(canvas);
    let engine;
    try {
      const fallback = backend === 'webgl2' ? (await import('@margoengine/webgl')).webglRenderer : undefined;
      engine = await Engine.create(canvas, {backend:backend === 'webgl2' ? 'webgl2' : 'webgpu', fallback});
      if (compat) {
        const {isCompatDevice} = await import('@margoengine/webgl2-compat/device');
        assert(isCompatDevice(engine.gpu), 'Expected compatibility device');
      } else assert(engine.backend === backend, `Expected ${backend}`);
      const gpuErrors = [];
      engine.gpu?.addEventListener('uncapturederror', event => gpuErrors.push(event.error.message));
      const context = new OfflineAudioContext(2, 72000, 48000);
      const listener = AudioListener.attach(engine, {context,autoResume:false,smoothing:0});
      const tone = hz => {
        const buffer = context.createBuffer(1,24000,48000);
        buffer.getChannelData(0).forEach((_,i,a) => { a[i] = 0.1 * Math.sin(2*Math.PI*hz*i/48000); });
        return buffer;
      };
      const music = new AudioMusic(listener,{a:tone(600),b:tone(900)},
        {idle:{a:0},combat:{a:0,b:0},quiet:{}}, {bpm:120,loopBeats:1,beatsPerBar:2,leadTime:0,fade:0});
      assert(music.start('idle',0) === 0, 'Start origin');
      const beat = music.transition('combat',{quantize:'beat',after:0.1});
      const bar = music.transition('quiet',{after:0.6});
      assert(beat === 0.5 && bar === 1, 'Beat/bar boundaries');
      engine.render();
      const pcm = await context.startRendering();
      let maxError = 0;
      for (let i = 0; i < pcm.length; i++) {
        const a = 0.1*Math.sin(2*Math.PI*600*i/48000);
        const b = 0.1*Math.sin(2*Math.PI*900*i/48000);
        const expected = i < 24000 ? a : i < 48000 ? a+b : 0;
        for (let channel = 0; channel < 2; channel++) {
          const value = pcm.getChannelData(channel)[i];
          assert(Number.isFinite(value), 'Finite PCM');
          maxError = Math.max(maxError,Math.abs(value-expected));
        }
      }
      // Float32 source and summation rounding only: unity routing, no panner or interpolation.
      assert(maxError < 5e-8, `Aligned layered/looped PCM: ${maxError}`);
      music.dispose();
      assert(gpuErrors.length === 0, `GPU errors ${gpuErrors}`);
      reports.push({backend,beat,bar,maxError,gpuErrors});
    } finally { engine?.dispose(); canvas.remove(); compat?.uninstall(); }
  }
  return {fixture:'Generated 600/900 Hz stems and game-state triggers, stand-ins',reports};
}
