export const camera=/* wgsl */`
struct Camera {
  eye:vec4f,
  facing:vec4f,
  horizontal:vec4f,
  vertical:vec4f,
  settings:vec4f,
}
@group(0) @binding(0) var<uniform> camera:Camera;
struct FullFrame {
  @builtin(position) coordinate:vec4f,
  @location(0) uv:vec2f,
}
@vertex fn fullscreen(@builtin(vertex_index) index:u32)->FullFrame {
  let cover=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));
  let p=cover[index];
  return FullFrame(vec4f(p,0,1),p*vec2f(.5,-.5)+.5);
}
fn ray(uv:vec2f)->vec3f {
  let q=vec2f(2*uv.x-1,1-2*uv.y);
  return normalize(camera.facing.xyz+camera.horizontal.xyz*q.x*camera.horizontal.w+
    camera.vertical.xyz*q.y*camera.vertical.w);
}
`;

export const backdrop=camera+/* wgsl */`
@fragment fn floorColor(input:FullFrame)->@location(0) vec4f {
  let direction=ray(input.uv);
  let fog=vec3f(.091,.123,.112);
  let vignette=1-.34*smoothstep(.13,.75,length((input.uv-.5)*vec2f(1.12,.92)));
  if(direction.y>=-.005){return vec4f(fog*vignette,1);}
  let world=camera.eye.xyz+direction*((-.493-camera.eye.y)/direction.y);
  let greenLamp=exp(-.112*dot(world.xz-vec2f(-2.5,-.65),world.xz-vec2f(-2.5,-.65)));
  let warmLamp=exp(-.102*dot(world.xz-vec2f(2.0,1.4),world.xz-vec2f(2.0,1.4)));
  let freckle=fract(sin(dot(floor(world.xz*128.0),vec2f(83.7,171.9)))*7563.17);
  let n=freckle*.008+.008*sin(world.x*2.2+world.z*2.6)*sin(world.z*3.1-world.x*4.7);
  let floor=vec3f(.115,.146,.125)+vec3f(.025,.078,.054)*greenLamp+
      vec3f(.11,.075,.037)*warmLamp+vec3f(n);
  let contact=max(abs(world.x-.12)-1.76,abs(world.z+.15)-1.14);
  let shadow=.30+.70*smoothstep(-.15,.55,contact);
  let haze=smoothstep(4.8,17.0,length(world.xz));
  return vec4f(mix(floor*shadow,fog,haze)*vignette,1);
}
`;

const surfaces=camera+/* wgsl */`
struct Sample {
  @builtin(position) clip:vec4f,
  @location(0) world:vec3f,
  @location(1) normal:vec3f,
  @location(2) pigment:vec3f,
  @location(3) uv:vec2f,
  @location(4) @interpolate(flat) kind:f32,
}
@vertex fn project(@location(0) point:vec3f,@location(1) normal:vec3f,@location(2) pigment:vec3f,
    @location(3) uv:vec2f,@location(4) kind:f32)->Sample {
  let d=point-camera.eye.xyz;
  return Sample(vec4f(dot(d,camera.horizontal.xyz)/camera.horizontal.w,dot(d,camera.vertical.xyz)/camera.vertical.w,
    .035,dot(d,camera.facing.xyz)),point,normal,pigment,uv,kind);
}
`;
const regular=/* wgsl */`
fn specimen(sample:Sample,n:vec3f,slope:f32)->vec3f {
  let key=normalize(vec3f(-.66,.92,.41));
  let observer=normalize(camera.eye.xyz-sample.world);
  let halfVector=normalize(key+observer);
  let crease=clamp(dot(n,key),0.0,1.0);
  let reflected=clamp(dot(n,halfVector),0.0,1.0);
  let fill=max(.0,dot(n,normalize(vec3f(.60,.26,-.69))));
  let warm=vec3f(1.045,.96,.80);
  let cool=vec3f(.59,.91,.87);
  if(sample.kind==1.0){
    let height=sample.uv.y;
    let ring=height*18.0;
    let edge=abs(fract(ring+.5)-.5);
    let width=max(.012,min(.19,slope));
    let contour=(1-smoothstep(width*.45,width*1.24,edge))*smoothstep(.020,.095,height);
    let taper=1-smoothstep(.15,.22,width);
    let salt=fract(sin(dot(floor(sample.world.xz*290),vec2f(73.2,19.1)))*5793.456);
    let ripple=sin(sample.world.z*98.0+sample.world.x*14.0+.48*sin(sample.world.x*19.0));
    let waterHighlight=pow(reflected,55.0)*(.09+.052*ripple);
    let terrain=sample.pigment*(.49+.50*crease)*warm+sample.pigment*cool*.17*fill;
    return terrain*(.95+.08*salt)+vec3f(.24,.21,.13)*contour*taper+
      vec3f(.18,.39,.36)*waterHighlight*(1.0-smoothstep(.011,.045,height));
  }
  let grain=sin(sample.world.x*781.4+sin(sample.world.y*175.9+sample.world.z*116.2));
  let body=sample.pigment*(.57+crease*.389)*warm+sample.pigment*cool*fill*.22;
  return body+sample.pigment*(pow(reflected,28.0)*.23+grain*.013);
}
`;
export const surface=(tile='')=>surfaces+regular+tile+/* wgsl */`
@fragment fn shade(sample:Sample)->@location(0) vec4f {
  let n=normalize(sample.normal);
  let slope=fwidth(sample.uv.y*18.0);
  `+(tile?'if(sample.kind==2.0){return vec4f(material(sample.uv),1);}' : '')+/* wgsl */`
  return vec4f(specimen(sample,n,slope),1);
}
`;

export const volume=camera+/* wgsl */`
@group(0) @binding(1) var fogAtlas:texture_2d<f32>;
@group(0) @binding(2) var fogSampler:sampler;
const center=vec3f(0,.78,0);
const extent=vec3f(1.28,.651,.99);
fn density(p:vec3f)->f32 {
  let q=clamp(p*.5+.5,vec3f(0),vec3f(1));
  let z=q.z*39.0;
  let lo=floor(z);
  let hi=min(lo+1.0,39.0);
  let xy=vec2f((q.x*47.0+.5)/48.0,q.y*29.0+.5);
  let a=textureSampleLevel(fogAtlas,fogSampler,vec2f(xy.x,(xy.y+30.0*lo)/1200.0),0).r;
  let b=textureSampleLevel(fogAtlas,fogSampler,vec2f(xy.x,(xy.y+30.0*hi)/1200.0),0).r;
  return mix(a,b,fract(z));
}
@fragment fn chamber(input:FullFrame)->@location(0) vec4f {
  let o=camera.eye.xyz-center;
  let d=ray(input.uv);
  let r=sign(d)/max(abs(d),vec3f(0.00004));
  let a=(-extent-o)*r;
  let b=(extent-o)*r;
  let low=min(a,b);
  let high=max(a,b);
  let entry=max(max(low.x,low.y),low.z);
  let exit=min(min(high.x,high.y),high.z);
  if(exit<entry){return vec4f(0);}
  let gap=(exit-entry)/32.0;
  var sum=vec3f(0);
  var trans=1.0;
  let sun=vec3f(-.44,.75,.30);
  let slice=camera.settings.y*1.57-.78;
  for(var j=0;j<32;j++){
    let p=(o+d*(entry+(f32(j)+.5)*gap))/extent;
    let value=density(p);
    let fog=max(0.0,value-.045);
    let amount=1-exp(-fog*gap*8.1);
    let occlusion=density(p+sun*.19);
    let diffuse=clamp(1.02-.82*occlusion+(value-occlusion)*.76,.30,1.15);
    let shade=mix(vec3f(.267,.422,.418),vec3f(.99,.924,.759),diffuse);
    sum+=trans*shade*amount;
    trans*=1-amount;
  }
  if(abs(d.y)>.00005){
    let distance=(slice*extent.y-o.y)/d.y;
    if(distance>entry&&distance<exit){
      let onPlane=(o+d*distance)/extent;
      let field=density(onPlane);
      let contour=abs(fract(field*9.0+.5)-.5);
      let border=1.0-smoothstep(.016,.037,1.0-max(abs(onPlane.x),abs(onPlane.z)));
      let scan=max(border*.65,(1-smoothstep(.014,.083,contour))*smoothstep(.15,.60,field))*.28;
      sum+=scan*vec3f(.52,1,.72)*(.37+.63*trans);
      trans*=1-scan*.38;
    }
  }
  return vec4f(sum,1-trans);
}
`;
