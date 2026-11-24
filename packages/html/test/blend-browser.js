import { Engine, Camera, PbrMaterial, box } from '@margoengine/core';
import { HTMLBlend } from '@margoengine/html/blend';
import { webglRenderer } from '@margoengine/webgl2-compat/preview';
const assert=(ok,message)=>{if(!ok)throw new Error(message);};
const project=(engine,[x,y,z])=>{
  const m=engine.camera.matrix,w=m[3]*x+m[7]*y+m[11]*z+m[15];
  return [(m[0]*x+m[4]*y+m[8]*z+m[12])/w,(m[1]*x+m[5]*y+m[9]*z+m[13])/w];
};
export async function blendScenario(backend) {
  const old=document.getElementById('view'),canvas=document.createElement('canvas');
  canvas.id='view';old.replaceWith(canvas);
  const engine=await Engine.create(canvas,{backend,fallback:c=>webglRenderer(c,{transparent:true}),
    camera:{position:[0,0,6],target:[0,0,0],near:0.1,far:100}});
  const errors=[];
  engine.gpu?.addEventListener('uncapturederror',event=>errors.push(event.error.message));
  engine.gpu?.pushErrorScope('validation');
  engine.createMesh().setGeometry(box(8,6,.1)).setMaterial(new PbrMaterial({color:[.1,.5,.1]})).setPosition([0,0,-2]);
  const front=engine.createMesh().setGeometry(box(.4,.8,.3)).setMaterial(new PbrMaterial({color:[.9,.1,.1]})).setPosition([-.6,0,1]);
  const original=canvas.style.cssText,blend=HTMLBlend.attach(engine),panel=document.createElement('button');
  panel.style.cssText='width:200px;height:100px;background:rgb(0,160,255);border:0;padding:0';
  const object=blend.add3D(panel);
  const snapshot=document.createElement('canvas');
  snapshot.width=canvas.width;snapshot.height=canvas.height;
  const context=snapshot.getContext('2d',{willReadFrequently:true});
  const render=async()=>{
    engine.render();await engine.gpu?.queue.onSubmittedWorkDone();
    await new Promise(resolve=>requestAnimationFrame(resolve));
    engine.render();context.clearRect(0,0,snapshot.width,snapshot.height);context.drawImage(canvas,0,0);
  };
  const sample=world=>{
    const [x,y]=project(engine,world);
    return [...context.getImageData(Math.floor((x+1)*canvas.width/2),Math.floor((1-y)*canvas.height/2),1,1).data];
  };
  await render();
  const clear=sample([.5,0,0]),covered=sample([-.6,0,1.15]),outside=sample([1.5,0,0]);
  assert(clear.every(v=>v===0),`${backend} panel did not punch clear RGBA: ${clear}`);
  assert(covered[3]===255&&covered[0]>covered[1],`${backend} foreground did not hide the panel: ${covered}`);
  assert(outside[3]===255,`${backend} mask cleared outside panel: ${outside}`);
  const rect=canvas.getBoundingClientRect(),[x,y]=project(engine,[.5,0,0]);
  const hit=document.elementFromPoint(rect.left+(x+1)*rect.width/2,rect.top+(1-y)*rect.height/2);
  assert(hit===panel,`${backend} live panel cannot receive input: ${hit?.tagName}`);
  let presses=0;panel.addEventListener('click',()=>presses++);hit.click();assert(presses===1,'DOM click lost');
  front.setPosition([0,3,1]);await render();
  assert(sample([-.6,0,0])[3]===0,'Moving the occluder did not uncover the same panel pixel');
  object.visible=false;await render();assert(sample([.5,0,0])[3]===255,'Hidden panel kept punching a hole');
  object.visible=true;object.setPose([.5,0,0]);panel.style.width='300px';await render();
  assert(sample([1.6,0,0])[3]===0,'Moved/resized panel aperture did not follow');
  const customCamera=new Camera({position:[.6,0,6],target:[.6,0,0],near:.1,far:100});
  customCamera.update(canvas.width*.5/canvas.height,backend==='webgpu');
  const viewMeasurements=[];
  object.setPose([0,0,0]);panel.style.width='160px';
  for(const view of [
    {viewport:[.5,0,.5,1]},
    {viewport:[canvas.width*.25,canvas.height*.25,canvas.width*.5,canvas.height*.5],pixels:true},
    {viewport:[.5,0,.5,1],camera:customCamera},
  ]) {
    blend.view=view;
    object.visible=false;
    await render();
    const baseline=context.getImageData(0,0,snapshot.width,snapshot.height).data;
    object.visible=true;
    await render();
    const bounds=panel.getBoundingClientRect(),canvasBounds=canvas.getBoundingClientRect(),
      cx=bounds.left+bounds.width/2,cy=bounds.top+bounds.height/2,
      px=Math.floor((cx-canvasBounds.left)*canvas.width/canvasBounds.width),
      py=Math.floor((cy-canvasBounds.top)*canvas.height/canvasBounds.height),
      rgba=[...context.getImageData(px,py,1,1).data];
    assert(rgba.every(value=>value===0),`${backend} explicit view aperture missed its DOM center: ${px},${py}: ${rgba}`);
    const outsideX=Math.floor(view.pixels?view.viewport[0]:view.viewport[0]*canvas.width)-4,
      outsideY=Math.floor(canvas.height*.5),
      panelOutsideX=Math.floor((bounds.left-canvasBounds.left)*canvas.width/canvasBounds.width)-4;
    assert(baseline[(outsideY*canvas.width+outsideX)*4+3]===255,'View control pixel must lie on the opaque scene');
    assert(baseline[(py*canvas.width+panelOutsideX)*4+3]===255,'Panel control pixel must lie on the opaque scene');
    assert(context.getImageData(outsideX,outsideY,1,1).data[3]===255,
      `${backend} explicit view cleared outside its rectangle`);
    assert(context.getImageData(panelOutsideX,py,1,1).data[3]===255,
      `${backend} explicit view aperture extended beyond its DOM panel`);
    assert(document.elementFromPoint(cx,cy)===panel,`${backend} explicit view lost live DOM input`);
    viewMeasurements.push({viewport:view.viewport,pixels:!!view.pixels,customCamera:!!view.camera,center:[px,py],rgba});
  }
  if(backend==='webgl2') {
    const gl=canvas.getContext('webgl2'),viewport=gl.getParameter(gl.VIEWPORT),scissor=gl.getParameter(gl.SCISSOR_BOX),
      enabled=gl.isEnabled(gl.SCISSOR_TEST);
    try {
      for(const on of [false,true]) {
        gl.viewport(1,2,3,4);gl.scissor(5,6,7,8);
        on?gl.enable(gl.SCISSOR_TEST):gl.disable(gl.SCISSOR_TEST);
        blend.drawGL({backend:'webgl2',gl,width:canvas.width,height:canvas.height,camera:engine.camera});
        assert([...gl.getParameter(gl.VIEWPORT)].join()==='1,2,3,4','Blend leaked its GL viewport');
        assert([...gl.getParameter(gl.SCISSOR_BOX)].join()==='5,6,7,8','Blend leaked its GL scissor rectangle');
        assert(gl.isEnabled(gl.SCISSOR_TEST)===on,'Blend leaked its GL scissor enable state');
      }
    } finally {
      gl.viewport(...viewport);gl.scissor(...scissor);
      enabled?gl.enable(gl.SCISSOR_TEST):gl.disable(gl.SCISSOR_TEST);
    }
  }
  blend.view=null;
  object.setPose([.5,0,0]);panel.style.width='300px';
  object.remove();await render();assert(sample([.5,0,0])[3]===255,'Removed panel kept punching');
  blend.dispose();
  assert(canvas.style.cssText===original,'Disposal did not restore canvas styles');
  const error=await engine.gpu?.popErrorScope();if(error)errors.push(error.message);
  assert(errors.length===0,errors.join('; '));
  if(backend==='webgl2')assert(canvas.getContext('webgl2').getError()===0,'Blend left a GL error');
  engine.dispose();
  return {checks:[`${backend}: CSS3D aperture preserves foreground pixels, follows movement/size/visibility and explicit views, receives live input and restores ownership/state`],measurements:{clear,covered,outside,views:viewMeasurements}};
}
