import {Engine} from '@margoengine/core';
import {webglRenderer,glProgram} from '@margoengine/webgl2-compat/preview';
import {size,starter,recipes} from './model.js';
import {triangleGL,displayGL} from './optics.js';
const stepGL=`#version 300 es
precision highp float;
precision highp int;
out vec4 nextState;
uniform sampler2D field;
uniform ivec2 dimensions;
uniform vec2 rates;
uniform vec3 ink;
vec2 sampleAt(ivec2 at,ivec2 offset){return texelFetch(field,(at+offset+dimensions)%dimensions,0).rg;}
void main(){
  ivec2 ij=ivec2(gl_FragCoord.xy);
  vec2 current=sampleAt(ij,ivec2(0));
  vec2 eastWest=sampleAt(ij,ivec2(-1,0))+sampleAt(ij,ivec2(1,0));
  vec2 northSouth=sampleAt(ij,ivec2(0,-1))+sampleAt(ij,ivec2(0,1));
  vec2 corners=sampleAt(ij,ivec2(-1,-1))+sampleAt(ij,ivec2(1,-1))+sampleAt(ij,ivec2(-1,1))+sampleAt(ij,ivec2(1,1));
  vec2 lap=(eastWest+northSouth)*.2+corners*.05-current;
  float flux=current.r*current.g*current.g;
  float u=current.r+.99*lap.r-flux+rates.x*(1.-current.r);
  float v=current.g+.495*lap.g+flux-(rates.x+rates.y)*current.g;
  float distanceToInk=distance(gl_FragCoord.xy/vec2(dimensions),ink.xy);
  float brush=(1.-smoothstep(.014,.049,distanceToInk))*ink.z;
  nextState=vec4(clamp(mix(u,.52,brush),0.,1.),clamp(mix(v,.43,brush),0.,1.),0.,1.);
}`;
function plate(gl){
  if(!gl.getExtension('EXT_color_buffer_float')&&!gl.getExtension('EXT_color_buffer_half_float'))throw Error('The reaction plate requires a renderable half-float texture.');
  gl.getExtension('OES_texture_float_linear');
  const pa=glProgram(gl,triangleGL,stepGL),view=glProgram(gl,triangleGL,displayGL),vao=gl.createVertexArray();
  const raster=[gl.createTexture(),gl.createTexture()],fb=[gl.createFramebuffer(),gl.createFramebuffer()];
  let current=0;
  for(const [i,texture] of raster.entries()){
    gl.bindTexture(gl.TEXTURE_2D,texture);
    gl.texStorage2D(gl.TEXTURE_2D,1,gl.RGBA16F,size,size);
    for(const option of [gl.TEXTURE_WRAP_S,gl.TEXTURE_WRAP_T])gl.texParameteri(gl.TEXTURE_2D,option,gl.REPEAT);
    for(const option of [gl.TEXTURE_MIN_FILTER,gl.TEXTURE_MAG_FILTER])gl.texParameteri(gl.TEXTURE_2D,option,gl.LINEAR);
    gl.bindFramebuffer(gl.FRAMEBUFFER,fb[i]);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,texture,0);
    if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw Error('The reaction texture could not be attached.');
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER,null);
  const lookup=(p,names)=>Object.fromEntries(names.map(name=>[name,gl.getUniformLocation(p,name)]));
  const q=lookup(pa,['field','dimensions','rates','ink']),r=lookup(view,['field','dimensions']);
  return {
    install(seed){
      current=0;gl.bindTexture(gl.TEXTURE_2D,raster[current]);
      gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,size,size,gl.RGBA,gl.HALF_FLOAT,seed);
    },
    render(width,height,recipe,ink,steps){
      gl.disable(gl.DEPTH_TEST);gl.disable(gl.BLEND);gl.disable(gl.CULL_FACE);
      gl.activeTexture(gl.TEXTURE0);gl.bindVertexArray(vao);
      gl.useProgram(pa);gl.viewport(0,0,size,size);gl.uniform1i(q.field,0);
      gl.uniform2i(q.dimensions,size,size);gl.uniform2f(q.rates,recipe.feed,recipe.kill);gl.uniform3fv(q.ink,ink);
      for(let k=0;k<steps;k++){
        gl.bindTexture(gl.TEXTURE_2D,raster[current]);
        current=1-current;gl.bindFramebuffer(gl.FRAMEBUFFER,fb[current]);gl.drawArrays(gl.TRIANGLES,0,3);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.viewport(0,0,width,height);
      gl.useProgram(view);gl.uniform1i(r.field,0);gl.uniform2f(r.dimensions,width/height,size);
      gl.bindTexture(gl.TEXTURE_2D,raster[current]);gl.drawArrays(gl.TRIANGLES,0,3);
      gl.bindVertexArray(null);gl.useProgram(null);
    },
    dispose(){
      for(const texture of raster)gl.deleteTexture(texture);
      for(const target of fb)gl.deleteFramebuffer(target);
      gl.deleteVertexArray(vao);gl.deleteProgram(pa);gl.deleteProgram(view);
    }
  };
}
export async function attachDirect(canvas,signal){
  const engine=await Engine.create(canvas,{backend:'webgl2',fallback:webglRenderer,exactSize:true,antialias:false,capacity:1,signal});
  let gl,renderer,seed,recipe,ink=[0,0,0],pending=0;
  const detach=engine.scene.frameGraph.add({name:'render reaction-diffusion plate',order:4,execute(context){
    if(context.backend!=='webgl2')return;
    gl=context.gl;renderer??=plate(gl);
    if(seed){renderer.install(seed);seed=undefined;}
    renderer.render(context.width,context.height,recipe,ink,pending);pending=0;
  }});
  return {
    backend:'webgl2',
    install(name){recipe=recipes[name];seed=starter(name);},
    brush(u,v,on){ink=[u,v,on?1:0];},
    draw(steps){
      pending=steps;engine.render({delta:0});
      const fence=gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE,0),until=performance.now()+1500;
      gl.flush();
      return new Promise((resolve,reject)=>{
        function awaitFence(){
          const state=gl.clientWaitSync(fence,0,0);
          if(state===gl.TIMEOUT_EXPIRED&&!signal.aborted&&performance.now()<until){setTimeout(awaitFence,4);return;}
          gl.deleteSync(fence);
          if(state===gl.WAIT_FAILED||state===gl.TIMEOUT_EXPIRED)reject(Error('The chemical plate frame did not complete.'));
          else resolve();
        }
        awaitFence();
      });
    },
    dispose(){detach();renderer?.dispose();engine.dispose();}
  };
}
