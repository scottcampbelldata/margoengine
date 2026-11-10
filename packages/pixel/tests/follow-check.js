import { EngineKernel } from '/packages/core/dist/index.js';
import { engineRuntime } from '/packages/core/dist/extension.js';
import { PixelCamera } from '/packages/pixel/dist/index.js';
import { PixelFollow } from '/packages/pixel/dist/follow.js';
const canvas = document.createElement('canvas'); document.body.append(canvas);
const instance = await EngineKernel.create(canvas, {backend:'webgpu',exactSize:[32,24]});
const engine = engineRuntime(instance); engine.scene.background = '#000000';
const errors = []; engine.gpu.addEventListener('uncapturederror', e=>errors.push(e.error.message));
const read = () => {
  const copy = document.createElement('canvas'); copy.width=32; copy.height=24;
  const ctx=copy.getContext('2d'); ctx.drawImage(canvas,0,0); return ctx.getImageData(0,0,32,24).data;
};
window.check = async () => {
  engine.gpu.pushErrorScope('validation');
  const camera = new PixelCamera({width:16,height:12});
  const rig = PixelFollow.attach(instance,{camera,target:{x:24,y:18}});
  const checks = [];
  const draw = (delta, expected) => {
    instance.render({delta}); const data=read();
    let wrong=0; for(let i=0;i<data.length;i+=4) for(let k=0;k<4;k++) if(Math.abs(data[i+k]-expected[k])>1) wrong++;
    checks.push(wrong);
  };
  rig.flash(1,[1,0,0]); draw(0.5,[128,0,0,255]);
  rig.resetEffects().fadeOut(1,[0,1,0]); draw(1,[0,255,0,255]);
  rig.fadeIn(1,[0,1,0]); draw(0.5,[0,128,0,255]);
  draw(0.5,[0,0,0,255]);
  // Separate per-view uniform state and viewport/scissor clipping.
  rig.flash(1,[0,0,1]);
  instance.render({delta:0.5, views:[{camera:instance.camera,viewport:[0,0,0.5,1],layers:1},
    {camera:instance.camera,viewport:[0.5,0,0.5,1],layers:2}]});
  const split=read(); let wrong=0;
  for(let y=0;y<24;y++) for(let x=0;x<32;x++) if(Math.abs(split[(y*32+x)*4+2]-(x<16?128:0))>1) wrong++;
  checks.push(wrong);
  const validation=(await engine.gpu.popErrorScope())?.message??null;
  const position=[camera.x,camera.y]; rig.dispose(); draw(0,[0,0,0,255]);
  instance.dispose(); return {checks,validation,errors,position};
}; window.ready=true;
