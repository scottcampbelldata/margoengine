import { Engine } from '@margoengine/core';
import { Input } from '@margoengine/input';
import { Ui, UiRenderer, uiActions, UI_ACTIONS } from '@margoengine/ui';
import { makeWorld } from './world.js';
import { createDive } from './game.js';

export async function openGame(canvas,{host,signal,fallback,fail,onAction,onRendered}){
  let engine,ui,renderer,input,world,game,metrics,observer;
  let raf=0,last=0,width=0,closed=false,first=false;
  let showFirst,stopFirst;
  const presented=new Promise((resolve,reject)=>{showFirst=resolve;stopFirst=reject;});
  // Startup errors can arrive before setup returns a device.
  void presented.catch(()=>{});

  function dispose(){
    if(closed)return;
    closed=true;
    cancelAnimationFrame(raf);
    observer?.disconnect();
    input?.dispose();
    renderer?.dispose();
    ui?.dispose();
    engine?.dispose();
    stopFirst(signal.reason);
  }
  signal.addEventListener('abort',dispose,{once:true});
  function sync(data){
    metrics=data;
    Object.assign(host.dataset,data);
    world.setScene(data.screen,data.station,width<710,data.rtl);
  }
  function fit(){
    const w=canvas.clientWidth,h=canvas.clientHeight;
    if(!w||!h)return;
    const ratio=Math.min(devicePixelRatio,2,1440/w);
    const pixelWidth=Math.max(1,Math.round(w*ratio)),pixelHeight=Math.max(1,Math.round(h*ratio));
    if(canvas.width!==pixelWidth)canvas.width=pixelWidth;
    if(canvas.height!==pixelHeight)canvas.height=pixelHeight;
    if(w!==width){
      width=w;
      const active=game?.data();
      if(active)world.setScene(active.screen,active.station,width<710,active.rtl);
      game?.resize();
    }
  }
  function draw(now){
    if(closed)return;
    try{
      input.update();
      if(input.state(UI_ACTIONS.cancel).pressed&&!ui.cancel('gamepad'))game.back();
      const dt=last===0?1/60:Math.max(0,Math.min(.065,(now-last)/1000));
      engine.render({delta:dt});
      last=now;
      if(host.dataset.mode!==ui.inputMode)host.dataset.mode=ui.inputMode;
      if(!first&&renderer.stats.glyphs>0&&renderer.stats.drawCalls>0){
        first=true;
        showFirst();
      }
      if(metrics?.screen==='play'&&renderer.stats.drawCalls>0)onRendered(engine);
      if(!document.hidden)raf=requestAnimationFrame(draw);
    }catch(error){fail(error);}
  }
  function visibility(){
    if(document.hidden){
      cancelAnimationFrame(raf);
      raf=0;
      last=0;
    }else if(!raf)raf=requestAnimationFrame(draw);
  }

  try{
    fit();
    engine=await Engine.create(canvas,{
      backend:fallback?'webgl2':'webgpu',fallback,exactSize:true,antialias:true,capacity:448,signal,
      startupTimeout:9500,camera:{near:.15,far:75}
    });
    engine.onError=fail;
    host.dataset.renderer=engine.backend;
    performance.mark('game-device');
    world=makeWorld(engine);
    ui=new Ui({direction:'ltr',ligatures:true,font:{family:'Arial, sans-serif',weight:600}});
    renderer=UiRenderer.attach(engine,ui,{input:{signal},mirror:{signal,label:'The Game Menu'}});
    input=new Input(uiActions(),{deadzone:.28});
    // Consume B once. Widget cancellation takes priority over backing out of the active screen.
    const released={value:0,down:false,pressed:false,released:false};
    ui.bindInput({state:name=>name===UI_ACTIONS.cancel?released:input.state(name)});
    await ui.ready;
    signal.throwIfAborted();
    game=createDive(ui,{width:()=>width,screenChanged:sync,onAction,signal});
    observer=new ResizeObserver(fit);
    observer.observe(canvas);
    document.addEventListener('visibilitychange',visibility,{signal});
    draw(performance.now());
    await presented;
    await new Promise(resolve=>requestAnimationFrame(resolve));
  }catch(error){
    dispose();
    throw error;
  }
}
