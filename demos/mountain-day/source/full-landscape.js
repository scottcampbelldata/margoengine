import { Engine } from '@margoengine/core';
import { AerialPerspective } from '@margoengine/sky/aerial';
import { HillaireSky } from '@margoengine/sky/hillaire';
import { VolumetricClouds } from '@margoengine/sky/volumetric-clouds';
import { columns, loadHeight } from './relief.mjs';
import { conditions } from './day.mjs';
import { setDayView } from './view.js';
import { buildLandscape } from './landscape.js';
import { addNight, capturePresentation } from './presentation.js';

export async function buildFull(canvas, renderer, signal, phase) {
  const [heights] = await Promise.all([
    loadHeight(new URL('./silverpass.height',import.meta.url), columns, signal),
    renderer === 'webgl2' ? import('./compatibility.js').then(({installCompatibility}) => installCompatibility(signal)) : null,
  ]);
  phase('assets');
  signal.throwIfAborted();
  const engine = await Engine.create(canvas, {
    backend:'webgpu',signal,exactSize:true,antialias:false,startupTimeout:8500,
    camera:{near:20,far:84000,fov:38},
  });
  let present, stars, landscape;
  function dispose() {
    stars?.dispose();
    present?.dispose();
    landscape?.imposter.dispose();
    engine.dispose();
  }
  try {
    phase('device');
    present = capturePresentation(engine,canvas);
    const sky = HillaireSky.attach(engine,{timeScale:0,sunIlluminance:13,metersPerUnit:1});
    stars = addNight(engine);
    const clouds = VolumetricClouds.attach(engine,{
      sky, depth:present.depth, wind:[13,-2.8], evolution:3.7, steps:44, lightSteps:4,
      scale:12500, erosion:1.02, stepCap:95, temporal:false, maxDistance:31500, dimLight:false,
    });
    AerialPerspective.attach(engine,{sky,depth:present.depth,sunIlluminance:6.2,maxDistance:47000});
    landscape = buildLandscape(engine,heights);
    phase('attached');
    await clouds.ready;
    phase('clouds-ready');
    return {
      engine,dispose,
      async render(frame, firstFrame) {
        if (canvas.width !== frame.width) canvas.width = frame.width;
        if (canvas.height !== frame.height) canvas.height = frame.height;
        engine.camera.fov = frame.fov;
        const state = conditions(frame.second);
        const {sun,buildup} = state;
        sky.options.sunDirection = sun;
        sky.options.exposure = -.58;
        stars.set(state,frame.second);
        const options = clouds.options;
        options.coverage = state.clouds;
        options.bottom = 2650 + 420 * buildup;
        options.top = 3370 + 1940 * buildup;
        options.density = .022 + .02 * buildup;
        clouds.resetTime();
        clouds.advanceTime(frame.second * 13);
        setDayView(engine,state);
        present.render();
        if (firstFrame) phase('submitted');
        await engine.gpu.queue.onSubmittedWorkDone();
      },
    };
  } catch (error) {
    dispose();
    throw error;
  }
}