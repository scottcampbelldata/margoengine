const waterLight=`
@group(0) @binding(23) var<uniform> sea:vec4f;
fn backscatter(world:vec3f,eye:vec3f,t:f32)->vec3f{
  let r=normalize(world-eye);
  let lift=clamp(.44+1.7*r.y,0.,1.);
  let pool=pow(max(0.,dot(r,normalize(vec3f(-.57,.44,-.81)))),7.);
  let coord=r.x+.37*r.y;
  let ray1=pow(max(0.,1.-abs((coord+.34)*12.0)),3.);
  let ray2=pow(max(0.,1.-abs((coord+.17)*13.2)),4.);
  let ray3=pow(max(0.,1.-abs((coord+.051)*15.0)),3.);
  let lace=(ray1*.41+ray2*.44+ray3*.15)*lift*.21*(.88+.12*sin(t*.7+coord*19.));
  return mix(vec3f(.012,.065,.092),vec3f(.038,.236,.265),lift)+vec3f(.084,.28,.25)*pool+vec3f(.27,.63,.67)*lace;
}
fn underwater(world:vec3f,base:vec3f,color:vec3f,normal:vec3f,eye:vec3f)->vec3f{
  let t=sea.x;let stream=sea.y;let x=world.x;let z=world.z;
  if(dot(world,world)>1090.){return backscatter(world,eye,t);}
  let a=sin((1.38*x+.17*z)*2.84+sin(z*2.03-1.29*t)*.71+t*.65);
  let b=sin((1.34*z-.31*x)*2.73+sin(x*1.43+2.73+t*.86)*.62-t*.47);
  let convergence=pow(max(0.,1.-abs(a+.51*b)),8.)*.31+pow(max(0.,1.-abs(b-.43*a)),10.)*.19;
  let light=convergence*(.37+.63*max(normal.y,0.))*max(0.,1.-.073*max(0.,world.y));
  let tint=vec3f(.93,.91,.77)*light;
  let sandGrain=.91+.057*sin(x*22.+z*11.)*sin(z*33.-x*13.)+.037*sin(x*54.+z*44.)*sin(z*52.);
  let bedNoise=.91+.07*sin(5.1*x+3.7*z+world.y*4.0)*sin(4.8*z+7.4*world.y);
  let surface=base*mix(bedNoise,sandGrain,smoothstep(.58,.91,normal.y));
  let local=surface*vec3f(.89,1.03,1.03)+tint*color;
  let dist=length(eye-world);
  let shade=1.-exp(-dist*.031);
  let volume=vec3f(.023,.145,.169)*(1.+.19*stream);
  return mix(local,volume,shade);
}
`;
export function lightSheet(engine){
  const gpu=engine.gpu;
  const buffer=gpu.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
  const values=new Float32Array(4),binding={binding:23,resource:{buffer}},variants=new Map();
  const remove=engine.scene.frameGraph.add({name:'underwater sunlight and visibility',order:-2,execute(c){
    if(c.backend!=='webgpu')return;
    let shader=variants.get(c.shader);
    if(!shader){
      shader=waterLight+c.shader.replace(/let linear=([^;]+);/,'let linear=underwater(i.position,$1,i.color,n,frame.eye.xyz);');
      variants.set(c.shader,shader);
    }
    gpu.queue.writeBuffer(buffer,0,values);
    c.shader=shader;c.bindings.push(binding);
  }});
  return {set(time,current){values[0]=time;values[1]=current;},dispose(){remove();buffer.destroy();}};
}
