import {colors,width,height} from './patterns.js';

const shades=colors.map(({rgb})=>'vec3f('+rgb.map(value=>(value/255).toFixed(7)).join(',')+')').join(',');
const shader=/* wgsl */`
@group(0) @binding(0) var weave:texture_2d<f32>;
const inks=array<vec3f,5>(${shades});
struct Cover {
  @builtin(position) screen:vec4f,
  @location(0) uv:vec2f,
}
@vertex fn vertex(@builtin(vertex_index) index:u32)->Cover {
  let triangle=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));
  let p=triangle[index];
  return Cover(vec4f(p,0,1),p*vec2f(.5,-.5)+.5);
}
fn tint(p:vec2f)->vec3f {
  let size=vec2i(textureDimensions(weave));
  let at=clamp(vec2i(floor(p*vec2f(size))),vec2i(0),size-1);
  let color=u32(round(textureLoad(weave,at,0).r*255.0));
  return inks[min(color,4u)];
}

@fragment fn fragment(input:Cover)->@location(0) vec4f {
  let uv=input.uv;
  let margin=vec2f(.033,.041);
  let q=(uv-margin)/(1-2*margin);
  let count=vec2f(textureDimensions(weave));
  let weaveIndex=q*count;
  let p=weaveIndex*3.0;
  let stitched=fract(p);
  let over=(i32(floor(p.x))+i32(floor(p.y)))%2==0;
  let warp=pow(max(.0,sin(stitched.x*3.1415927)),.55);
  let weft=pow(max(.0,sin(stitched.y*3.1415927)),.55);
  let crossLift=select(weft,warp,over);
  let under=select(warp,weft,over);
  let spacing=fract(weaveIndex);
  let edges=min(min(spacing.x,spacing.y),min(1-spacing.x,1-spacing.y));
  let depth=min(min(q.x,q.y),min(1-q.x,1-q.y));
  let px=fwidth(p.x)+fwidth(p.y);
  let visible=1.0-smoothstep(.87,2.31,px);
  let pulse=1.0+visible*((crossLift-.75)*.105+(under-.67)*.036);
  let overlap=.95+.05*smoothstep(.014,.15,edges);
  let key=1.083-.149*uv.x-.103*uv.y;
  let surface=tint(q)*pulse*overlap*key;
  let pile=tint(vec2f(q.x,select(0.0,1.0,q.y>.5)))*
    (.75+.17*warp)*key;
  let fringe=all(vec2f(q.x,1-q.x)>vec2f(0.0))&&
    depth<0.0&&depth>-.035*(.80+.19*sin(floor(p.x)*13.7))&&stitched.x>0.27;
  let backing=vec3f(.226,.218,.194)*(.82+.19*(1-uv.y));
  if(fringe){return vec4f(pile,1);}
  let shadow=1.0-(1.0-smoothstep(0,.013,abs(depth)))*.29;
  let border=select(backing*shadow,surface,depth>=0.0);
  return vec4f(clamp(border,vec3f(0),vec3f(1)),1);
}
`;

export function wovenView(initial){
  let data=initial,device,texture,pipeline,bindings,format;
  function upload(){
    device.queue.writeTexture({texture},data,{bytesPerRow:width,rowsPerImage:height},[width,height]);
  }
  function release(){
    texture?.destroy();
    texture=pipeline=bindings=format=undefined;
  }
  function setup(engine){
    device=engine.gpu;
    texture=device.createTexture({size:[width,height],format:'r8unorm',
      usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
    upload();
  }
  function draw(c){
    if(!pipeline||format!==c.format){
      const module=device.createShaderModule({code:shader});
      format=c.format;
      pipeline=device.createRenderPipeline({
        layout:'auto',vertex:{module,entryPoint:'vertex'},
        fragment:{module,entryPoint:'fragment',targets:[{format}]},
      });
      bindings=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[
        {binding:0,resource:texture.createView()},
      ]});
    }
    const pass=c.encoder.beginRenderPass({colorAttachments:[{view:c.color,loadOp:'clear',storeOp:'store'}]});
    pass.setPipeline(pipeline);pass.setBindGroup(0,bindings);pass.draw(3);pass.end();
  }
  return {
    name:'swatch-cloth',setup,
    onDeviceRestored(engine){release();setup(engine);},
    dispose:release,
    set(values){data=values;upload();},
    registerPasses(graph){graph.add({name:'draw-woven-field',order:1,execute:draw});},
  };
}
