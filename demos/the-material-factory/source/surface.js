// A viewport-specific texture projection for the machined annulus and flat witness.
const useFrame='@group(0) @binding(0) var<uniform> frame:Frame;';
const surfaceLine='let n=normalize(i.normal)*select(-1.0,1.0,facing);let v=normalize(frame.eye.xyz-i.position);';
const brdfLine='let a=i.material.x*i.material.x;';
const decl=String.raw`
@group(0) @binding(35) var factorySampler:sampler;
@group(0) @binding(36) var factoryColor:texture_2d<f32>;
@group(0) @binding(37) var factoryNormal:texture_2d<f32>;
@group(0) @binding(38) var factoryRoughness:texture_2d<f32>;
@group(0) @binding(39) var factoryHeight:texture_2d<f32>;
@group(0) @binding(40) var<uniform> factoryDepth:vec4f;
`;
const mapped=String.raw`
  var n=normalize(i.normal)*select(-1.0,1.0,facing);
  let v=normalize(frame.eye.xyz-i.position);
  var factoryBase=i.color;
  var factoryRough=i.material.x;
  let sweep=i.position-vec3f(-0.166,0.696,0.034);
  let ring= i.color.r>0.99 && i.color.g<0.01 && i.color.b>0.99;
  let witness=i.color.r<0.01 && i.color.g>0.99 && i.color.b>0.99;
  let turn=atan2(sweep.y,sweep.x);
  let section=atan2(sweep.z-0.027,length(sweep.xy)-0.344);
  let ringUV=vec2f(turn/3.14159265,section/6.2831853);
  let flatUV=vec2f((i.position.x-0.497)/0.320,(i.position.z+0.043)/0.337);
  let uv=select(ringUV,flatUV,witness);
  let rawX=dpdx(uv);let rawY=dpdy(uv);
  let uvX=select(rawX-round(rawX),rawX,witness);
  let uvY=select(rawY-round(rawY),rawY,witness);
  if(ring||witness){
    let a0=select(vec3f(-sin(turn),cos(turn),0),vec3f(1,0,0),witness);
    let sideAxis=a0-n*dot(a0,n);
    let T=normalize(select(cross(vec3f(0,0,1),n),sideAxis,dot(sideAxis,sideAxis)>0.0001));
    let B=normalize(cross(n,T))*select(1.0,-1.0,witness);
    let relief=textureSampleGrad(factoryHeight,factorySampler,uv,uvX,uvY).r;
    let viewInPlane=vec2f(dot(v,T),dot(v,B));
    let depth=(relief-factoryDepth.y)*factoryDepth.x;
    let coord=uv+depth*viewInPlane/max(abs(dot(v,n)),0.45);
    factoryBase=textureSampleGrad(factoryColor,factorySampler,coord,uvX,uvY).rgb;
    let normal=textureSampleGrad(factoryNormal,factorySampler,coord,uvX,uvY).rgb*2.0-1.0;
    n=normalize(normal.x*T+normal.y*B+normal.z*n);
    factoryRough=max(0.045,textureSampleGrad(factoryRoughness,factorySampler,coord,uvX,uvY).g);
  }
`;

export function specimenSurface(engine){
  const device=engine.gpu,sampler=device.createSampler({addressModeU:'repeat',addressModeV:'repeat',
    magFilter:'linear',minFilter:'linear',mipmapFilter:'linear',maxAnisotropy:8});
  const knobs=device.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
  let bindings=[],prior,patched;
  const plugin={
    name:'factory:surface-projection',
    setup(){},
    registerPasses(graph){
      graph.add({name:plugin.name,order:-1,execute(c){
        if(c.backend!=='webgpu'||!bindings.length)return;
        if(c.shader!==prior){
          prior=c.shader;
          const at=prior.indexOf('@fragment fn fragment');
          if(at<0||!prior.includes(useFrame)||!prior.includes(surfaceLine)||!prior.includes(brdfLine))
            throw Error('The pinned core PBR shading hooks changed.');
          patched=prior.slice(0,at).replace(useFrame,useFrame+decl)
            +prior.slice(at).replaceAll('i.color','factoryBase').replace(brdfLine,'let a=factoryRough*factoryRough;').replace(surfaceLine,mapped);
        }
        c.shader=patched;
        c.bindings.push(...bindings);
      }});
    },
    set(set, depth, amplitude){
      device.queue.writeBuffer(knobs,0,new Float32Array([depth/amplitude,amplitude*.45,0,0]));
      bindings=[{binding:35,resource:sampler},...['albedo','normal','roughness','height'].map((key,i)=>
        ({binding:36+i,resource:set[key].createView()})),{binding:40,resource:{buffer:knobs}}];
    },
    dispose(){bindings=[];knobs.destroy();},
  };
  engine.use(plugin);
  return plugin;
}
