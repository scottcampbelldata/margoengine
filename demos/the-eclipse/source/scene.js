import { Camera } from '@margoengine/core';
import { autoEngine } from '@margoengine/webgl2-compat/auto';
import { Sky, twilightColor, twilightIlluminance } from '@margoengine/sky/base';
import { look } from '@margoengine/sky/look';
import { preetham } from '@margoengine/sky/preetham';
import { makeOptics } from './optics.js';
import { buildRiver } from './river.js';

export async function openScene(canvas, first, signal, forced, earlyCompatibility) {
  let state = first;
  let engine, sky, scope;
  let disposed=false, frameRunning=false, pending;
  const close = () => {
    disposed=true;
    engine?.dispose();
  };
  signal.addEventListener('abort',close,{once:true});
  const yaw=Math.PI*.76;
  const rotate=([x,y,z])=>[x*Math.cos(yaw)+z*Math.sin(yaw),y,-x*Math.sin(yaw)+z*Math.cos(yaw)];
  const wide = new Camera({position:rotate([8,18,-91]),target:rotate([-18,117,420]),fov:48,near:1,far:2300});
  const lens = new Camera();
  const options = {
    timeScale:0, sunDirection:first.sun, turbidity:3.4,
    look: { sunDiscSize:.34, sunDiscIntensity:1.1, glowWidth:15, glowSunward:.16,
      gradient:[{elevation:-20,color:[.042,.065,.114]},{elevation:0,color:[.58,.227,.11]},
        {elevation:5,color:[.31,.146,.18]},{elevation:15,color:[.097,.12,.235]},
        {elevation:31,color:[.029,.055,.128]},{elevation:90,color:[.018,.031,.104]}] },
  };
  let box;
  let narrow = false;
  const layout = () => {
    narrow=matchMedia('(max-width:720px)').matches;
    const ratio = Math.min(1.5, devicePixelRatio);
    const width = Math.max(2, Math.round(canvas.clientWidth*ratio));
    const height = Math.max(2, Math.round(canvas.clientHeight*ratio));
    if (canvas.width!==width) canvas.width=width;
    if (canvas.height!==height) canvas.height=height;
    const fraction=Number.parseFloat(getComputedStyle(canvas.parentElement).getPropertyValue('--split'))/100;
    const split=narrow?Math.round(height*fraction):Math.round(width*fraction);
    box = narrow ? [[0,0,width,split],[0,split,width,height-split]]
      : [[0,0,split,height],[split,0,width-split,height]];
    wide.fov=narrow?38:48;
  };

  function draw(next) {
    signal.throwIfAborted();
    state=next;
    layout();
    const order = next.flux;
    const sunset = twilightColor(.070);
    const twilightFloor = twilightIlluminance(-.022)/140000;
    sky.options.sunDirection = next.sun;
    const night = (1-order)**18;
    const diffuse = .065 + .935*Math.pow(order,.71);
    sky.options.exposure = Math.log2(diffuse);
    sky.options.look.sunDiscIntensity = 1.1 * order;
    sky.options.look.gradientStrength = night;
    sky.options.look.gradientIntensity = 1.5;
    sky.options.look.glowStrength = twilightFloor * 160 * night;
    sky.options.look.glowColor = sunset.map((n,i) => Math.min(1,n * [.94,.55,.32][i] + [.06,0,0][i]));
    engine.lighting.direction.set([...next.sun, 2.55*order]);
    const ambient = .10 + .57*Math.pow(order,.62);
    engine.lighting.radiance.set([1,.92,.81,ambient]);
    engine.lighting.ambient.set([.37 + .31*order,.53 + .24*order,.85]);
    engine.render({delta:0,views:[
      {id:'river',camera:wide,viewport:box[0],pixels:true,clear:{color:'#0c121f'}},
      {id:'observatory',camera:lens,viewport:box[1],pixels:true,scene:scope,clear:{color:'#090c14'}},
    ]});
  }

  const compat = forced || !navigator.gpu;
  const install = async () => {
    const done = earlyCompatibility ? await earlyCompatibility : undefined;
    if (done?.error) throw done.error;
    if (!done) await (await import('./compatibility.js')).installCompatibility(forced,signal);
  };
  if (compat) await install();
  try {
    engine = await autoEngine(canvas,async target => {
      if (!target.gpu) {
        const error = new Error('This rendering path needs a WebGPU-class Margo device.');
        error.code='unsupported';
        throw error;
      }
      engine=target;
      canvas=target.canvas;
      engine.onError = error => { pending = error; };
      sky=Sky.attach(engine,options,{preetham,look});
      buildRiver(engine,yaw);
      scope=engine.createScene('Solar close-up');
      scope.use(makeOptics(() => state));
      draw(first);
      await engine.gpu.queue.onSubmittedWorkDone();
      if (pending) throw pending;
    },{
      loadCompat:async()=>({install}), signal, backend:compat?'webgpu':undefined,
      capacity:1600, exactSize:true, antialias:true, startupTimeout:10000,
    });
  } catch (error) {
    close();
    throw error;
  }

  return {
    canvas,
    backend:engine.gpu.adapterInfo?.vendor==='margo-webgl2'?'webgl2':'webgpu',
    async render(next) {
      if (disposed || frameRunning) return;
      if (pending) throw pending;
      frameRunning=true;
      try {
        draw(next);
        await engine.gpu.queue.onSubmittedWorkDone();
        if (pending) throw pending;
      } finally { frameRunning=false; }
    },
    close,
  };
}
