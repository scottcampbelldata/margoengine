// Browser-side instrumentation, also exercised by the visible-frame regression.
export function installDemoLoadAudit(){
  const load=window.demoLoad={draws:0,submitted:0,firstFrame:0,ready:0};
  const textures=new WeakSet(),views=new WeakSet(),encoders=new WeakMap(),passes=new WeakMap(),commands=new WeakMap();
  const current=GPUCanvasContext.prototype.getCurrentTexture,view=GPUTexture.prototype.createView;
  GPUCanvasContext.prototype.getCurrentTexture=function(...args){const texture=current.apply(this,args);textures.add(texture);return texture;};
  GPUTexture.prototype.createView=function(...args){const result=view.apply(this,args);if(textures.has(this))views.add(result);return result;};
  const begin=GPUCommandEncoder.prototype.beginRenderPass,finish=GPUCommandEncoder.prototype.finish;
  GPUCommandEncoder.prototype.beginRenderPass=function(desc){
    const state=encoders.get(this)??{presented:new Set(),drawn:new Set()};encoders.set(this,state);
    const targets=Array.from(desc.colorAttachments).filter(Boolean);
    for(const a of targets)if(views.has(a.view)||views.has(a.resolveTarget))state.presented.add(a.view);
    const pass=begin.call(this,desc);passes.set(pass,{state,targets});return pass;
  };
  GPUCommandEncoder.prototype.finish=function(...args){const command=finish.apply(this,args);commands.set(command,encoders.get(this));return command;};
  for(const method of ['draw','drawIndexed','drawIndirect','drawIndexedIndirect']){
    const original=GPURenderPassEncoder.prototype[method];
    GPURenderPassEncoder.prototype[method]=function(...args){
      if(method.includes('Indirect')||args[0]>0&&(args[1]??1)>0){load.draws++;const pass=passes.get(this);if(pass)for(const target of pass.targets)pass.state.drawn.add(target.view);}
      return original.apply(this,args);
    };
  }
  const submit=GPUQueue.prototype.submit;
  GPUQueue.prototype.submit=function(...args){
    const result=submit.apply(this,args);
    // Texture mip generation and shadow-only commands are not a visible frame.
    if(!load.submitted&&Array.from(args[0]).some(command=>{const state=commands.get(command);return state&&[...state.presented].some(view=>state.drawn.has(view));})){
      load.submitted=performance.now();
      this.onSubmittedWorkDone().then(()=>requestAnimationFrame(()=>requestAnimationFrame(()=>{load.firstFrame=performance.now();})));
    }
    return result;
  };
  const ready=()=>{
    if(document.body?.dataset.ready==='true'||document.querySelector('#viewport')?.dataset.ready==='true'||window.sandbox||window.nightCitadel?.stats.frames>0)load.ready=performance.now();
    else requestAnimationFrame(ready);
  };
  requestAnimationFrame(ready);
}
