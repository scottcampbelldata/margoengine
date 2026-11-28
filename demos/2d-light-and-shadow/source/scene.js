import {LayerCompositor} from '@margoengine/pixel';
import {SoftLighting2D} from '@margoengine/lighting2d/soft';
import {chamber, lamp} from './art.js';
import {height, occluders, stations, width} from './layout.js';

const descriptions = {
  hard:'A point source casts sharp edges behind the limestone ribs.',
  soft:'A wide flame softens shadow edges behind the limestone ribs.',
  cookie:'A textured shutter projects narrow bands through the chamber.',
  bounce:'Warm light reflects off limestone into areas the lamp cannot see directly.',
};
const lampOptions = {radius:268, height:115, color:'#ffd690', intensity:2.85, falloff:1.45};
const element = id => document.getElementById(id);
const clamp = (n,a,b) => Math.max(a,Math.min(b,n));
const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));

async function lightingType(mode) {
  if (mode === 'soft') return {type: SoftLighting2D, light:{sourceRadius:14, samples:12}};
  if (mode === 'hard') {
    const {Lighting2D} = await import('@margoengine/lighting2d');
    return {type:Lighting2D, light:{}};
  }
  const {CookieLighting2D, createWindowCookie} = await import('@margoengine/lighting2d/cookie');
  return {type:CookieLighting2D, light:{
    cookie:createWindowCookie(64,64,7), cookieScale:[418,368], cookieRotation:-.36, cookieMode:'multiply',
  }};
}

export async function show(engine, canvas, loading, signal, fail) {
  const compositor = LayerCompositor.attach(engine, {camera:{width,height,zoom:1}});
  const picture = compositor.addLayer();
  const shade = compositor.addLayer({z:1,blend:'multiply'});
  const torch = compositor.addLayer({z:2});
  const marker = document.createElement('canvas');
  marker.width = width;
  marker.height = height;
  const ctx = marker.getContext('2d', {willReadFrequently:true});
  const rock = chamber();
  picture.write(rock);
  const data = canvas.dataset;
  let station = 0, position = stations[0], mode = 'soft';
  let rendered = 0, pending = null, busy = false, firstInput = false;
  let worker, lighting, light, attached, giRaster;
  const giCanvas = document.createElement('canvas');
  giCanvas.width = width;
  giCanvas.height = height;
  const giContext = giCanvas.getContext('2d', {willReadFrequently:true});
  signal.addEventListener('abort',() => worker?.terminate(),{once:true});

  function computeBounce(point) {
    worker ??= new Worker(new URL('./radiance-worker.js',import.meta.url),{type:'module'});
    return new Promise((resolve,reject) => {
      const remove = () => {
        worker.removeEventListener('message', response);
        worker.removeEventListener('error', error);
        signal.removeEventListener('abort', dispose);
      };
      const response = ({data}) => {
        remove();
        if (data.error) reject(new Error(data.error)); else resolve(data);
      };
      const error = event => {remove();reject(new Error(event.message));};
      const dispose = () => {remove();reject(signal.reason);};
      worker.addEventListener('message',response,{once:true});
      worker.addEventListener('error',error,{once:true});
      signal.addEventListener('abort',dispose,{once:true});
      worker.postMessage(point);
    });
  }
  async function runLighting(state) {
    if (state.mode === 'bounce') {
      if (lighting) lighting.dispose();
      lighting = light = attached = undefined;
      const field = await computeBounce({x:state.x,y:state.y});
      if (pending) return false;
      giRaster ??= document.createElement('canvas');
      giRaster.width = field.width;
      giRaster.height = field.height;
      giRaster.getContext('2d').putImageData(new ImageData(field.rgba,field.width,field.height),0,0);
      const spacing = width / (field.width-1);
      giContext.drawImage(giRaster,-spacing/2,-spacing/2,width+spacing,height+spacing);
      shade.write(giContext.getImageData(0,0,width,height));
      data.indirect = field.indirect.toFixed(6);
      return true;
    }
    if (attached !== state.mode) {
      const {type, light: settings} = await lightingType(state.mode);
      if (pending) return false;
      lighting?.dispose();
      lighting = type.attach(engine,{
        target:shade.target, camera:shade.camera, ambient:'#597073', occluders,
      });
      light = lighting.addLight({...lampOptions,...settings});
      lighting.addLight({x:665,y:263,radius:442,height:185,color:'#a2d9ca',intensity:.55,falloff:1.6,shadows:false});
      attached = state.mode;
    }
    light.x = state.x;
    light.y = state.y;
    delete data.indirect;
    return true;
  }
  async function flush() {
    busy = true;
    try {
      while (pending && !signal.aborted) {
        const state = pending;
        pending = null;
        await nextFrame();
        signal.throwIfAborted();
        if (!await runLighting(state)) continue;
        signal.throwIfAborted();
        torch.write(lamp(ctx,state.x,state.y));
        engine.render({delta:0});
        await engine.gpu.queue.onSubmittedWorkDone();
        await nextFrame();
        signal.throwIfAborted();
        data.frame = String(++rendered);
        data.x = state.x.toFixed(2);
        data.y = state.y.toFixed(2);
        data.mode = state.mode;
        data.station = state.name;
        if (state.trusted && !firstInput) {
          firstInput = true;
          performance.mark('margo-first-input-rendered');
        }
        if (data.ready !== 'true') {
          data.ready = 'true';
          element('controls').disabled = false;
          loading.hidden = true;
          performance.mark('margo-first-usable-frame');
        }
      }
    } catch (error) {fail(error);}
    finally {busy = false;}
  }
  function refresh(trusted = false) {
    pending = {...position, mode, trusted:trusted || !!pending?.trusted};
    element('station').textContent = position.name;
    element('description').textContent = descriptions[mode];
    for (const id of Object.keys(descriptions)) element(id).setAttribute('aria-pressed',String(mode === id));
    if (!busy) void flush();
  }
  element('next').addEventListener('click',event => {
    station = (station + 1) % stations.length;
    position = stations[station];
    refresh(event.isTrusted);
  },{signal});
  element('reset').addEventListener('click',event => {
    station = 0;
    position = stations[0];
    mode = 'soft';
    refresh(event.isTrusted);
  },{signal});
  for (const id of Object.keys(descriptions)) element(id).addEventListener('click',event => {
    if (mode === id) return;
    mode = id;
    refresh(event.isTrusted);
  },{signal});
  function drag(event) {
    const box = canvas.getBoundingClientRect();
    position = {name:'Free survey',x:clamp((event.clientX-box.left)/box.width*width,25,width-25),
      y:clamp((event.clientY-box.top)/box.height*height,92, height-49)};
    refresh(event.isTrusted);
  }
  canvas.addEventListener('pointerdown',event => {
    if (data.ready !== 'true') return;
    canvas.setPointerCapture(event.pointerId);
    drag(event);
  },{signal});
  canvas.addEventListener('pointermove',event => {
    if (canvas.hasPointerCapture(event.pointerId)) drag(event);
  },{signal});
  refresh();
}
