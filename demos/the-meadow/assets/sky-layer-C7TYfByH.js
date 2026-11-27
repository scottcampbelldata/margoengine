var e=`

fn cloudHash(p:vec2i)->f32 {
 var v=bitcast<vec2u>(p)*1664525u+1013904223u;
 v.x+=v.y*1664525u;v.y+=v.x*1664525u;v^=v>>vec2u(16u);
 v.x+=v.y*1664525u;v.y+=v.x*1664525u;v^=v>>vec2u(16u);
 return f32(v.x)*2.3283064e-10;
}
fn cloudNoise(p:vec2f)->f32 {
 let cell=vec2i(floor(p));let f=fract(p);let u=f*f*(3.0-2.0*f);
 return mix(mix(cloudHash(cell),cloudHash(cell+vec2i(1,0)),u.x),mix(cloudHash(cell+vec2i(0,1)),cloudHash(cell+vec2i(1)),u.x),u.y);
}



fn cloudOctaves(p:vec2f,footprint:f32,first:u32,last:u32)->f32 {
 var q=p;var cells=footprint;var weight=1.0;var sum=0.0;var total=0.0;
 for(var octave=0u;octave<last;octave++){
  if(octave>=first){sum+=weight*mix(cloudNoise(q),0.5,smoothstep(0.35,1.0,cells));total+=weight;}
  q=mat2x2f(1.39741,1.60753,-1.60753,1.39741)*q+vec2f(-31.4,12.6);cells*=2.13;weight*=0.5;
 }
 return sum/max(total,0.000001);
}
`,t=2.2,n=.12,r=Math.sqrt(3/5)/2,i=(()=>{let e=[];for(let[t,n]of[[.5-r,5/18],[.5,8/18],[.5+r,5/18]]){let r=Math.sqrt(1-t),i=Math.sqrt(t);for(let t=0;t<=4;t++){let a=t*Math.PI/4;e.push([i*Math.cos(a),r,i*Math.sin(a),n*(t===0||t===4?1:2)/8])}}return e})(),a=e=>e.toFixed(7),o={field:e,wgsl:`${e}
fn cloudCover(shape:f32)->f32 {return clamp((shape-1.0+frame.clouds.x)/max(frame.clouds.x,0.001),0.0,1.0);}

fn cloudPhase(nu:f32)->f32 {return mix(0.9375/pow(1.0625+0.5*nu,1.5),0.64/pow(1.36-1.2*nu,1.5),0.6);}

fn cloudSky(color:vec3f,backdrop:vec3f,ray:vec3f,angularFootprint:f32)->vec3f {


 let r=R+clamp(frame.eye.y*0.001,0.001,99.9);let shell=R+frame.clouds.z*0.001;let mu=ray.y;
 if(frame.clouds.x<=0.0||r>=shell||(mu<0.0&&r*r*(mu*mu-1.0)+R*R>=0.0)){return color;}
 let t=-r*mu+sqrt(r*r*(mu*mu-1.0)+shell*shell);

 let haze=exp(-t/40.0);

 let slant=max((r*mu+t)/shell,0.03);
 let p=frame.eye.xz*0.001+ray.xz*t+normalize(vec2f(1,0.35))*frame.clouds.y*0.001;
 let footprint=angularFootprint*t/slant;
 var sheet=color;if(haze>=0.01){sheet=cloudSheet(color,backdrop,ray,p,footprint,slant,haze);}

 let deck=smoothstep(0.8,1.0,frame.clouds.x);if(deck<=0.0){return sheet;}
 return mix(sheet,cloudDeck(ray,p,footprint,haze),deck);
}

fn cloudSheet(color:vec3f,backdrop:vec3f,ray:vec3f,p:vec2f,footprint:f32,slant:f32,haze:f32)->vec3f {
 let cover=cloudCover(cloudOctaves(p,footprint,0u,2u));if(cover<=0.0){return color;}

 let erode=cloudOctaves(p,footprint,2u,4u)*0.35;let density=clamp((cover-erode)/(1.0-erode),0.0,1.0);
 if(density<=0.0){return color;}




 let thick=pow(density,5.0/3.0);
 let opacity=(1.0-exp(-thick*3.0/max(slant,0.25)))*haze;




 let s=frame.sun.xyz;let nu=dot(ray,s);var lit=vec3f(0);
 if(max(frame.sunlight.r,max(frame.sunlight.g,frame.sunlight.b))>0.0){
  let step=s.xz/max(s.y,0.1)*0.13;var depth=thick*2.5;
  for(var k=1;k<=3;k++){depth+=pow(cloudCover(cloudOctaves(p+step*f32(k),footprint,0u,2u)),5.0/3.0);}
  let tau=depth*1.2;let powder=mix(1.0-exp(-2.0*tau-0.3),1.0,0.5+0.5*nu);
  lit=frame.sunlight.rgb*1.6*(exp(-tau)*powder*cloudPhase(nu)+0.4*exp(-0.25*tau));
 }

 let moon=frame.moonColor.rgb*frame.moon.w*0.15*cloudPhase(dot(ray,frame.moon.xyz));
 return mix(color,lit+moon+backdrop*(1.0-0.4*density)+vec3f(0.006,0.01,0.02),opacity);
}
${`

${`
fn deckUnits()->f32 {
 if(frame.settings.x<0.5){return 1.0;}
 let r=R+clamp(frame.eye.w,0.001,99.9);let step=(TOP-r)/64.0;var optical=vec3f(0);
 for(var i=0u;i<64u;i++){optical+=extinction(r+(f32(i)+0.5)*step)*step;}
 return 20.0*dot(exp(-optical),vec3f(0.2126,0.7152,0.0722))/${a(4*Math.PI*.55)};
}
fn clearSkyLevel()->vec3f {
 let s=frame.sun.xyz;let flat=length(s.xz);var a=vec2f(1,0);if(flat>0.0001){a=s.xz/flat;}
 var sum=vec3f(0);
${i.map(([e,t,n,r])=>` sum+=${a(r)}*daySky(vec3f(${a(e)}*a.x-${a(n)}*a.y,${a(t)},${a(e)}*a.y+${a(n)}*a.x));`).join(`
`)}
 return sum;
}

fn overcastLight(day:f32)->vec3f {
 let T=max(frame.moonColor.w,0.0);if(T<=0.0){return vec3f(0);}
 return (frame.sunlight.rgb*(${t.toFixed(6)}*max(frame.sun.y,0.0))+clearSkyLevel()*(day/deckUnits()))*T;
}
`}
fn cloudDeck(ray:vec3f,p:vec2f,footprint:f32,haze:f32)->vec3f {
 let T=max(frame.moonColor.w,0.0);
 let zenith=overcastLight(1.0-clamp(frame.sun.w,0.0,1.0))*${(9/7).toFixed(6)};
 let grade=(1.0+2.0*max(ray.y,0.0))/3.0;
 let shade=1.0+${n.toFixed(3)}*(2.0*cloudOctaves(p,footprint,0u,4u)-1.0)*haze;
 let moon=frame.moonColor.rgb*frame.moon.w*0.15*T;
 return (zenith*shade+moon)*grade+vec3f(0.006,0.01,0.02)*T;
}
`}`,validate(e){if(typeof e!=`object`||!e||!Number.isFinite(e.coverage??.45)||(e.coverage??.45)<0||(e.coverage??.45)>1||!Number.isFinite(e.speed??8)||Math.abs(e.speed??8)>100||!Number.isFinite(e.height??1500)||(e.height??1500)<100||(e.height??1500)>1e4||!Number.isFinite(e.depth??20)||(e.depth??20)<1||(e.depth??20)>200)throw RangeError(`Invalid sky clouds; keep coverage from 0 to 1, speed within ±100, height from 100 to 10000 and depth from 1 to 200.`)}};export{o as cloudFeature};