import{a as e,c as t,d as n,f as r,h as i,i as a,l as o,m as s,n as c,o as l,p as u,r as d,s as f,t as p,u as m}from"./index-CupNV4bY.js";(globalThis[Symbol.for(`margoengine.frame-resources`)]??={devices:new WeakMap}).devices;var h=`@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {return vec4f(array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3))[i],0,1);}`,g=Symbol.for(`margoengine.optional.msaa`);h+``;function _(e){let t=e[g];return t?.color===e.color&&t.depth===e.depth?t:void 0}var v=(e,t)=>Object.assign(Error(t),{name:`MargoError`,code:e});function ee(e,t=new Float32Array(3)){if(!Number.isFinite(e)||t.length!==3)throw RangeError(`Invalid sun clock; pass finite hours and an out array of 3 elements.`);let n=(e%24-6)*Math.PI/12;return t[0]=Math.cos(n),t[1]=Math.sin(n),t[2]=0,t}var y=Math.SQRT1_2,b={new:{phase:-1,waning:!1},waxingCrescent:{phase:-y,waning:!1},firstQuarter:{phase:0,waning:!1},waxingGibbous:{phase:y,waning:!1},full:{phase:1,waning:!1},waningGibbous:{phase:y,waning:!0},lastQuarter:{phase:0,waning:!0},waningCrescent:{phase:-y,waning:!0},half:{phase:0,waning:!1},quarter:{phase:0,waning:!1}},x=e=>{let t=typeof e==`string`&&Object.hasOwn(b,e)?b[e]:void 0;if(!t&&!(typeof e==`number`&&Number.isFinite(Math.fround(e))))throw RangeError(`Invalid moon phase ${String(e)}; give a number from -1 to 1 or one of ${Object.keys(b).join(`, `)}.`);return t};function S(e){return x(e)?.phase??Math.max(-1,Math.min(1,e))}function C(e){return x(e)?.waning??!1}function w(e,t,n=0){let r=t??[0,0,0],i=e[0],a=e[1],o=e[2],s=Math.max(0,.2126*i+.7152*a+.0722*o),c=1;return i<0&&(c=Math.min(c,s/(s-i))),a<0&&(c=Math.min(c,s/(s-a))),o<0&&(c=Math.min(c,s/(s-o))),r[n]=Math.max(0,s+(i-s)*c),r[n+1]=Math.max(0,s+(a-s)*c),r[n+2]=Math.max(0,s+(o-s)*c),r}function T(e){if(typeof e!=`number`||!(e>=1667&&e<=25e3))throw RangeError(`Invalid blackbody temperature ${String(e)}; use 1667 to 25000 Kelvin.`);let t=e,n=t<=4e3?-266123900/t**3-234358.9/t**2+877.6956/t+.17991:-3025846900/t**3+2107037.9/t**2+222.6347/t+.24039;return[n,t<=2222?-1.1063814*n**3-1.3481102*n**2+2.18555832*n-.20219683:t<=4e3?-.9549476*n**3-1.37418593*n**2+2.09137015*n-.16748867:3.081758*n**3-5.8733867*n**2+3.75112997*n-.37001483]}function te(e,t,n,r=0){if(!(t>0&&e>=0&&e+t<=1))throw RangeError(`Invalid chromaticity (${String(e)}, ${String(t)}); use x of 0 or more, y above 0 and x + y up to 1.`);let i=e/t,a=(1-e-t)/t,o=w([3.2404542*i-1.5371385-.4985314*a,-.969266*i+1.8760108+.041556*a,.0556434*i-.2040259+1.0572252*a],n,r),s=Math.max(o[r],o[r+1],o[r+2]);for(let e=0;e<3;e++)o[r+e]/=s;return o}var ne=.172,[E,D]=T(4943.405869870266),re=.25,ie=[0,0,0];function ae(e,t,n=ne,r={illuminance:0,color:[0,0,0],intensity:0}){let i=Math.hypot(t[0],t[1],t[2]);if(!(e>=-1&&e<=1)||!(i>0&&Number.isFinite(i))||!(n>=0&&n<=2))throw RangeError(`Invalid moonlight; give a phase from -1 to 1, a finite non-zero direction and an extinction from 0 to 2 magnitudes per airmass.`);let a=Math.acos(e)*180/Math.PI,o=10**(-.4*(3.84+.026*a+4e-9*a**4))*10.7639,s=t[1]/i,c=s>0?o*10**(-.4*n*se(s)):0,l=O(c,r.color);return r.illuminance=c,r.intensity=c/(.2126*l[0]+.7152*l[1]+.0722*l[2]),r}function O(e,t=[0,0,0],n){if(!(e>=0&&Number.isFinite(e)))throw RangeError(`Invalid moonlight illuminance; give a finite number of lux, 0 or more.`);let r=E,i=D;if(n){let[e,t,a]=[n[0],n[1],n[2]],o=.4124*e+.3576*t+.1805*a,s=.2126*e+.7152*t+.0722*a,c=o+s+.0193*e+.1192*t+.9505*a;if(!(c>0&&Number.isFinite(c)))throw RangeError(`Invalid moonlight source colour; give non-negative linear RGB, not black.`);r=o/c,i=s/c}let a=Math.max(0,Math.min(1,(Math.log10(e/Math.PI)+2)/2.6)),o=a*a*(3-2*a),s=te((1-o)*re+o*r,(1-o)*re+o*i,ie);for(let e=0;e<3;e++)t[e]=s[e];return t}function oe(e){if(!(e>=0&&e<=1))throw RangeError(`Invalid cloud cover; give a fraction of the sky from 0 to 1.`);return 1-.75*e**3.4}function se(e){return 1/Math.sqrt(1-.96*(1-e*e))}var k=384400/356375,ce=.5,A=10**(-.4*(12.74-2.8)),le=[.005802,.013558,.0331],ue=[65e-5,.001881,85e-6],j=1/(Math.sin(5*Math.PI/180)+.50572*11.07995**-1.6364),de=12,M,fe=()=>{if(M)return M;let e=0;for(let t=.5;t<700;t++)e+=2*Math.max(0,1-Math.abs(de+t*t/12720-25)/15);let t=Math.exp(-12/8)*Math.sqrt(2*Math.PI*6360*8);return M={low:le.map((e,t)=>Math.exp(-(e*8+ue[t]*15)*j)),limb:le.map((n,r)=>Math.exp(-(n*t+ue[r]*e)))}};function pe(e=1,t,n=1,r=ne){let i=1,a=1,o;if(e===`bright`)i=k*k,a=k;else if(e===`dim`)i=ce;else if(typeof e==`number`&&e>=0&&Number.isFinite(e))i=e;else throw RangeError(`Invalid moon brightness ${String(e)}; give a number of 0 or more, 'bright' or 'dim'.`);let s=i/(a*a);if(t===`blood`)o=fe().limb,i*=A,s*=A;else if(t===`reddened`){o=fe().low;let e=Math.min(1,10**(-.4*r*(j-se(Math.max(0,Math.min(1,n))))));i*=e,s*=e}else if(typeof t==`string`)throw RangeError(`Invalid moon color ${t}; give linear RGB, 'blood' or 'reddened'.`);let c=s**(1/3),l=o??[1,1,1],u=.2126*l[0]+.7152*l[1]+.0722*l[2],d;if(o){let e=te(E,D,[0,0,0]);d=[e[0]*o[0],e[1]*o[1],e[2]*o[2]]}return{light:i,size:a,disc:[c*l[0]/u,c*l[1]/u,c*l[2]/u],source:d}}var me=133775*Math.exp(-.21);function he(e){if(!Number.isFinite(e))throw RangeError(`Invalid sun elevation; give finite radians.`);let t=Math.max(-Math.PI/2,Math.min(Math.PI/2,e)),n=Math.sin(t),r=753.66156,i=Math.cos(Math.asin(r*Math.cos(t)/754.66156)),a=r*(i-n)+i;return 3866.0975*Math.exp(-.042*a)*(1+(t*180/Math.PI+90)*n/57.29578)}var ge=[.005802,.013558,.0331],_e=[65e-5,.001881,85e-6],N=6360,ve=e=>Math.max(0,1-Math.abs(e-25)/15),ye=NaN,be=6*Math.PI/180,P=[0,0,0],F=[0,0,0];function xe(e,t=[0,0,0]){if(!Number.isFinite(e))throw RangeError(`Invalid sun depression; give finite radians.`);let n=Math.max(0,Math.min(be,e));if(n!==ye){let e=Math.sin(n);F.fill(0);let t=0;for(let r=.5;r<100;r++){let i=N+r;if(t+=ve(r-.5),i*Math.cos(n)<N)continue;let a=0,o=0;for(let t=2;t<2400;t+=4){let n=Math.sqrt(i*i+t*t-2*i*t*e)-N;if(n>100)break;a+=Math.exp(-n/8)*4,o+=ve(n)*4}let s=8*(1-Math.exp(-r/8));for(let e=0;e<3;e++)F[e]+=ge[e]*Math.exp(-r/8-ge[e]*(a+s)-_e[e]*(o+t))}let r=Math.max(F[0],F[1],F[2])||1;for(let e=0;e<3;e++)P[e]=F[e]/r;ye=n}return t[0]=P[0],t[1]=P[1],t[2]=P[2],t}function Se(e,t,n=[0,0,0]){return O(t,n,xe(e,n))}var Ce=`
const R=6360.0;const TOP=6460.0;const BETA_R=vec3f(0.005802,0.013558,0.033100);

struct Frame {inverse:mat4x4f,eye:vec4f,sun:vec4f,settings:vec4f,moon:vec4f,moonColor:vec4f,clouds:vec4f,nightZenith:vec4f,nightHorizon:vec4f,nightMoon:vec4f,nightMoonColor:vec4f,nightParams:vec4f,sunlight:vec4f}
@group(0) @binding(0) var<uniform> frame:Frame;
fn mie()->f32{return 0.003996*max(0.25,(frame.settings.z-1.0)*0.5);}
fn densities(r:f32)->vec2f{return exp(-max(0.0,r-R)/vec2f(8.0,1.2));}
fn extinction(r:f32)->vec3f{let d=densities(r);return BETA_R*d.x+vec3f(mie()/0.9*d.y);}
`,we=`fn ground(r:f32,mu:f32)->bool{return mu<0.0&&r*r*(mu*mu-1.0)+R*R>=0.0;}
fn boundary(r:f32,mu:f32)->f32{if(ground(r,mu)){return max(0.0,-r*mu-sqrt(max(0.0,r*r*(mu*mu-1.0)+R*R)));}return max(0.0,-r*mu+sqrt(max(0.0,r*r*(mu*mu-1.0)+TOP*TOP)));}
fn trans(t:texture_2d<f32>,r:f32,mu:f32)->vec3f {
 if(ground(r,mu)){return vec3f(0);}let uv=vec2f((sign(mu)*sqrt(abs(mu))+1.0)*0.5,sqrt(clamp((r-R)/100.0,0.0,1.0)));
 let p=uv*vec2f(127,31);let a=vec2i(floor(p));let f=fract(p);let b=min(a+1,vec2i(127,31));
 return mix(mix(textureLoad(t,a,0).rgb,textureLoad(t,vec2i(b.x,a.y),0).rgb,f.x),mix(textureLoad(t,vec2i(a.x,b.y),0).rgb,textureLoad(t,b,0).rgb,f.x),f.y);
}
`,I=`
@group(0) @binding(1) var output:texture_storage_2d<rgba16float,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
 if(any(id.xy>=vec2u(128,32))){return;}let u=f32(id.x)/127.0*2.0-1.0;let mu=u*abs(u);let r=R+100.0*pow(f32(id.y)/31.0,2.0)+0.001;
 var result=vec3f(0);if(!ground(r,mu)){let step=boundary(r,mu)/64.0;var optical=vec3f(0);for(var i=0u;i<64u;i++){let d=(f32(i)+0.5)*step;optical+=extinction(sqrt(r*r+d*d+2.0*r*mu*d))*step;}result=exp(-optical);}
 textureStore(output,vec2i(id.xy),vec4f(result,1));
}`,L=[.005802,.013558,.0331],R=new Float64Array(6);function z(e,t,n,r=!1){let i=(-e*t+Math.sqrt(Math.max(0,e*e*(t*t-1)+41731600)))/64,a=0,o=0,s=0;for(let n=0;n<64;n++){let c=(n+.5)*i,l=Math.max(0,Math.sqrt(e*e+c*c+2*e*t*c)-6360);a+=Math.exp(-l/8)*i,o+=Math.exp(-l/1.2)*i,r&&(s+=Math.max(0,1-Math.abs(l-25)/15)*i)}R[n]=a,R[n+1]=o,r&&(R[4+n/2]=s)}var B=[65e-5,.001881,85e-6];function V(e,t,n,r=new Float32Array(3),i){if(!Number.isFinite(e)||!Number.isFinite(t)||!Number.isFinite(n)||r.length!==3)throw RangeError(`Invalid sunlight: pass finite mu, altitude and turbidity and a 3-element output`);if(i)return Te(e,t,n,r,i);let a=6360+Math.min(99.9,Math.max(.001,t)),o=-Math.sqrt(Math.max(0,1-(6360/a)**2)),s=Math.max(0,Math.min(1,(e-o+.014)/.028)),c=s*s*(3-2*s),l=.003996*Math.max(.25,(n-1)*.5)/.9;z(a,Math.min(1,Math.max(e,o+1e-4)),0),z(a,1,2);for(let e=0;e<3;e++)r[e]=c?c*Math.exp(-(L[e]*(R[0]-R[2])+l*(R[1]-R[3]))):0;return r}function Te(e,t,n,r,i){let a=6360+Math.min(99.9,Math.max(.001,t)),o=-Math.sqrt(Math.max(0,1-(6360/a)**2)),s=Math.max(0,Math.min(1,(e-o+.014)/.028)),c=s*s*(3-2*s),l=.003996*Math.max(.25,(n-1)*.5)/.9;z(a,Math.min(1,Math.max(e,o+1e-4)),0,!0),z(a,1,2,!0);for(let e=0;e<3;e++)r[e]=c?c*Math.exp(-(i[e]*(R[0]-R[2])+l*i[8]*(R[1]-R[3])+B[e]*i[3]*(R[4]-R[5]))):0;return r}function H(e,t,n){let r=6360+Math.min(99.9,Math.max(.001,e)),i=.003996*Math.max(.25,(t-1)*.5)/.9,a=[.2126,.7152,.0722];z(r,1,2,!!n);let o=0;for(let e=0;e<3;e++)o+=a[e]*Math.exp(-(n?n[e]*R[2]+i*n[8]*R[3]+B[e]*n[3]*R[5]:L[e]*R[2]+i*R[3]));return o}var Ee=`fn pbrNeutral(input:vec3f)->vec3f {let x=min(input.r,min(input.g,input.b));let offset=select(0.04,x-6.25*x*x,x<0.08);var v=input-offset;let peak=max(v.r,max(v.g,v.b));if(peak<0.76){return v;}let newPeak=1.0-0.24*0.24/(peak+0.24-0.76);v*=newPeak/peak;return mix(v,vec3f(newPeak),1.0-1.0/(0.15*(peak-newPeak)+1.0));}
fn toDisplay(c:vec3f)->vec3f {let x=pbrNeutral(max(c,vec3f(0)));return select(x*12.92,1.055*pow(x,vec3f(1.0/2.4))-0.055,x>=vec3f(0.0031308));}
`,De=e=>typeof e==`string`&&e.endsWith(`float`);function Oe(e,t,n){if(!t||t.length<16||!e||e.length<16)return null;let r=n??new Float64Array(52);if(!(r instanceof Float64Array)||r.length<52||r.buffer===t.buffer||r.buffer===e.buffer)return null;for(let t=0;t<4;t++){let n=0;for(let i=0;i<8;i++){let a=i<4?e[i*4+t]:+(i-4===t);if(typeof a!=`number`||a-a!==0)return null;r[t*8+i]=a,i<4&&Math.abs(a)>n&&(n=Math.abs(a))}if(!n)return null;r[32+t]=n}for(let e=0;e<4;e++){let t=e;for(let n=e+1;n<4;n++)Math.abs(r[n*8+e])/r[32+n]>Math.abs(r[t*8+e])/r[32+t]&&(t=n);let n=r[t*8+e];if(n===0||n-n!==0)return null;for(let n=0;n<8;n++){let i=r[e*8+n];r[e*8+n]=r[t*8+n],r[t*8+n]=i}let i=r[32+e];r[32+e]=r[32+t],r[32+t]=i;let a=r[e*8+e];for(let t=0;t<8;t++)r[e*8+t]/=a;for(let t=0;t<4;t++)if(t!==e){let n=r[t*8+e];for(let i=0;i<8;i++)r[t*8+i]-=n*r[e*8+i]}}let i=t instanceof Float32Array;for(let e=0;e<16;e++){let t=r[e%4*8+(e>>2)+4];if(t-t!==0||i&&!(Math.abs(t)<34028235677973366e22))return null;r[36+e]=t}for(let e=0;e<16;e++)t[e]=r[36+e];return t}var ke=(e,t=`1.0.0`,n=import.meta.url)=>u(e,t,n),Ae=`fn dither(p:vec2f)->f32{
 var x=(u32(p.x)*0x9e3779b9u)^(u32(p.y)*0x85ebca6bu);x=(x^(x>>16u))*0x7feb352du;x=(x^(x>>15u))*0x846ca68bu;x^=x>>16u;
 return f32(x&0xffffu)/65536.0+f32(x>>16u)/65536.0-1.0;
}`,je=`
const SUN_RADIUS=0.014;const MOON_RADIUS=0.018;
fn celestialProfile(ray:vec3f,direction:vec3f,radius:f32,angularFootprint:f32)->vec2f {
 let angle=atan2(length(cross(ray,direction)),clamp(dot(ray,direction),-1.0,1.0));
 let edge=max(0.0002,angularFootprint*0.5);

 let disk=(1.0-smoothstep(radius-edge,radius+edge,angle))*min(1.0,radius*radius/(edge*edge));
 return vec2f(disk,exp(-angle*angle/(radius*radius*8.0)));
}
fn moonRadiance(ray:vec3f,direction:vec3f,angularFootprint:f32)->f32 {
 let moon=celestialProfile(ray,direction,MOON_RADIUS,angularFootprint);

 return moon.x*4.0+pow(moon.y,8.0)*0.025;
}
`,Me=4*Math.PI*.55,Ne=80;function Pe(e){let t=Math.min(1,Math.max(0,(e-.8)/.2));return t*t*(3-2*t)}var U=e=>.2126*e[0]+.7152*e[1]+.0722*e[2],Fe=[.25,.45,.75],W=[-.3,.22,-1],Ie=[.4,.7,.5],Le={day:[.04,.04,.04],night:[.01,.015,.03]};function G(e,t,n,r=!1){let[i,a]=Re(e,t,n);return r&&e.look?[e.look.extend(i,!1),e.look.extend(a,!0)]:[i,a]}function Re(e,t,n){let r=e.bruneton,i=n&&e.night,a=!!e.preetham&&t!==`bruneton`,o=t===`bruneton`&&r,s=Ce+(r?.phase??``)+we+(r?.tail??``);return[s,f+s+(e.clouds?.wgsl??`
fn cloudSky(color:vec3f,backdrop:vec3f,ray:vec3f,angularFootprint:f32)->vec3f {return color;}
`)+je+`
@group(0) @binding(1) var scattering:texture_2d<f32>;
@group(0) @binding(2) var transmission:texture_2d<f32>;
`+(o?o.sky:``)+(i?i.wgsl:``)+`
fn nightSky(w:vec3f,footprint:f32)->vec3f {
`+(i?` if(frame.sunlight.w>0.5){return stylizedNight(w,footprint);}
`:``)+` return mix(vec3f(0.012,0.019,0.038),vec3f(0.003,0.006,0.02),sqrt(max(0.0,w.y)));
}
`+(e.preetham?.wgsl??``)+`fn daySky(direction:vec3f)->vec3f {

 let w=normalize(vec3f(direction.x,max(0.01,direction.y),direction.z));
 let s=frame.sun.xyz;
 var color=vec3f(0);`+(a?`color=preetham(w,s);`:``)+(o?`let r=R+clamp(frame.eye.w,0.001,99.9);color=brunetonSky(scattering,r,w.y,s.y,dot(w,s));`:``)+`
 return color;
}
fn skyRadiance(w:vec3f,footprint:f32)->vec3f {if(frame.sun.w>=1.0){return nightSky(w,footprint);}return mix(daySky(w),nightSky(w,footprint),frame.sun.w);}
${Ee}




${Ae}
@fragment fn fragment(i:Vertex)->@location(0) vec4f {
 let p=frame.inverse*vec4f(i.uv.x*2.0-1.0,1.0-i.uv.y*2.0,0.000001,1);let w=normalize(p.xyz/p.w-frame.eye.xyz);let s=frame.sun.xyz;
 let footprint=max(length(dpdx(w)),length(dpdy(w)));let sky=skyRadiance(w,footprint);var color=sky;
 let sun=celestialProfile(w,s,SUN_RADIUS,footprint);
 color+=(sun.x*60.0+sun.y*0.8)*trans(transmission,R+clamp(frame.eye.w,0.001,99.9),s.y)*(1.0-frame.sun.w);
 color+=frame.moonColor.rgb*frame.moon.w*moonRadiance(w,frame.moon.xyz,footprint)*f32(frame.sunlight.w<0.5);
 color=cloudSky(color,sky,w,footprint);color*=exp2(frame.settings.y);if(frame.settings.w<0.5&&frame.sunlight.w<0.5){color=toDisplay(color);color+=dither(i.position.xy)*min(vec3f(1.0/255.0),min(color,1.0-color));}return vec4f(color,1);
}`]}var ze=class{coreRequirement=i(`1.0.0`,import.meta.url);get airControls(){return!!this.features.look}look(e){let t=this.lookKey,n=this.moon[1];return(!this.disc||t[0]!==e.brightness||t[1]!==e.color||t[2]!==n||t[3]!==e.extinction)&&(this.disc=pe(e.brightness,e.color,n,e.extinction),t[0]=e.brightness,t[1]=e.color,t[2]=n,t[3]=e.extinction),this.disc}get cloudLayer(){let e=this.options.clouds,t=this.features.clouds?.field;if(e&&t)return{field:t,coverage:e.coverage??.45,drift:this.cloudTime,height:e.height??1500}}get coverageTexture(){return this.cover?.[1]}get reflectionTexture(){return this.reflectionRequested=!0,this.reflection?.texture}get nightFactor(){return this.values[23]}constructor(e={},t={}){this.options=e,this.features=t,this.presentation=a(),this.attachment=this.presentation.colorAttachments[0],this.depthAttachment=this.presentation.depthStencilAttachment,this.name=`sky`,this.environmentLayer=void 0,this.environmentLightLayer=void 0,this.lightScale=0,this.deck=void 0,this.entries=[],this.format=``,this.computedT=NaN,this.scatteringT=NaN,this.scatteringA=new Float64Array(3),this.albedo=new Float32Array(4),this.values=new Float32Array(64),this.extra=new Float32Array(Ne),this.zenithSun=0,this.air=new Float32Array(9),this.computedAir=new Float32Array(9).fill(NaN),this.seconds=0,this.inverse=this.values.subarray(0,16),this.scratch=new Float64Array(52),this.sunColor=new Float32Array(3),this.sun=new Float32Array(3),this.moon=Float32Array.from(W,e=>e/Math.hypot(...W)),this.moonlit={illuminance:0,color:[0,0,0],intensity:0},this.lookKey=[],this.aboveColor=[0,0,0],this.belowColor=[0,0,0],this.disposed=!1,this.cloudTime=0,this.reflectionRequested=!1,this.owned=[],this.targets=new Map,this.lights=[{direction:new Float32Array([1,0,0,0]),radiance:new Float32Array(3)},{direction:new Float32Array([...this.moon,0]),radiance:new Float32Array(3)}],this.moonUnderClouds={direction:new Float32Array([...this.moon,0]),radiance:new Float32Array(3)},this.twilightLight={direction:new Float32Array([0,1,0,0]),radiance:new Float32Array([1,1,1])},this.twilightColor=[1,1,1],this.startHours=e.hours,this.model=e.model,this.stylized=!!e.night,this.extended=!!(e.look||e.atmosphere)&&!!t.look,[this.atmosphere,this.code]=G(t,this.model,this.stylized,this.extended),this.validate()}add(e){if(this.disposed)throw v(`disposed`,`Sky is disposed; create a new Sky`);if(!e||typeof e.addLighting!=`function`)throw TypeError(`Sky lighting target needs addLighting; pass a native PBR model or VoxelRenderer`);let t=this.targets.get(e);if(!t){let n=e.addLighting(this);t=()=>{this.targets.get(e)===t&&(this.targets.delete(e),n())},this.targets.set(e,t)}return t}async irradiance(e=[0,1,0],{signal:t}={}){if(!Array.isArray(e)||e.length!==3||e.some(e=>!Number.isFinite(e)))throw RangeError(`Sky irradiance needs a normal of three finite numbers`);let n=Math.hypot(...e);if(!(n>0))throw RangeError(`Sky irradiance needs a normal of nonzero length`);t?.throwIfAborted();let r=(this.ambient()?this.lit?.bindings().find(e=>e.binding===8):void 0)?.resource?.buffer,i=this.engine?.gpu;if(!r||!i)return;let a=i.createBuffer({size:160,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST}),o=i.createCommandEncoder(),s;try{o.copyBufferToBuffer(r,0,a,0,160),i.queue.submit([o.finish()]),await a.mapAsync(GPUMapMode.READ),s=new Float32Array(a.getMappedRange().slice(0))}finally{a.destroy()}t?.throwIfAborted();let[c,l,u]=e.map(e=>e/n),d=[1,l,u,c,c*l,l*u,3*u*u-1,c*u,c*c-l*l],f=[0,0,0];for(let e=0;e<3;e++){let t=0;for(let n=0;n<9;n++)t+=s[n*4+e]*d[n];f[e]=Math.max(t*s[39],s[36+e])}return f}pbr(e){return this.ambient()?this.lit?.pbr(e):void 0}bindings(){return this.ambient()?this.lit?.bindings()??[]:[]}shader(e,t){return e}finish(e,t){return this.ambient()?this.lit?.terrain(e,t)??e:e}ambient(){let e=this.options;return e.lighting?.ambient?e.lighting.ambient:e.environment?Le:void 0}validate(){let e=this.options,t=this.features,n=e.model??`preetham`;if(e.sunDirection!==void 0&&(!Array.isArray(e.sunDirection)||e.sunDirection.length!==3||e.sunDirection.some(e=>!Number.isFinite(Math.fround(e)))||!(Math.hypot(...e.sunDirection)>0)))throw RangeError(`Sky sun direction needs three finite components and nonzero length`);if(e.model!==void 0&&e.model!==`preetham`&&e.model!==`bruneton`||!Number.isFinite(e.hours??12)||!Number.isFinite(e.timeScale??1/3600)||Math.abs(e.timeScale??1/3600)>24||!Number.isFinite(e.turbidity??2)||(e.turbidity??2)<1||(e.turbidity??2)>10||!Number.isFinite(e.exposure??0)||Math.abs(e.exposure??0)>16)throw RangeError(`Invalid sky options; keep timeScale within ±24, turbidity from 1 to 10, exposure within ±16 and hours finite, and use model "preetham" or "bruneton".`);if((e.model!==void 0||t.preetham||t.bruneton)&&!t[n])throw TypeError(`Sky model '${n}' needs ${n} from @margoengine/sky/${n}`);let r=e.groundAlbedo;if(r!==void 0){let e=typeof r==`number`?[r]:r;if(!Array.isArray(e)||typeof r!=`number`&&e.length!==3||e.some(e=>!(typeof e==`number`&&e>=0&&e<=1)))throw RangeError(`Invalid sky groundAlbedo; use a number from 0 to 1 or three of them (linear RGB)`);if(!t.bruneton)throw TypeError(`Sky groundAlbedo needs bruneton from @margoengine/sky/bruneton`)}if(e.coverage!==void 0&&typeof e.coverage!=`boolean`)throw RangeError(`Sky coverage must be true or false; pass a boolean`);if(e.environment!==void 0&&typeof e.environment!=`boolean`)throw RangeError(`Sky environment must be true or false; pass a boolean`);if(e.environment&&!t.lighting)throw TypeError(`Sky environment needs lighting from @margoengine/sky/lighting`);if(e.look!==void 0||e.atmosphere!==void 0){if(!t.look)throw TypeError(`Sky look and atmosphere need look from @margoengine/sky/look`);t.look.validate(e)}for(let n of[`clouds`,`fog`,`night`,`lighting`]){let r=e[n],i=t[n];if(r!==void 0){if(!i)throw TypeError(`Sky ${n} needs ${n} from @margoengine/sky/${n}`);i.validate(r)}}}static attach(e,t={},n={}){s(e,i(`1.0.0`,import.meta.url));let r=ke(e);if(r.plugins.has(`sky`))throw v(`attached`,`This scene already has a Sky; change sky.options on that one, or dispose() it first`);let a=new this(t,n);return r.use(a),a}setup(e){if(this.disposed||!e.gpu)throw new d(this.disposed?`disposed`:`unsupported`,`Sky requires WebGPU; attach a new Sky to a WebGPU engine; see https://margoengine.com/errors#webgpu`);this.engine=e;let n=e.gpu,r=this.features,i=this.bindUniform(n);this.transmission=n.createTexture({size:[128,32],format:`rgba16float`,usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.STORAGE_BINDING});let a=this.transmission.createView();this.tables=r.bruneton?.create(n,i,a,this.owned,this.extend()),this.entries=this.skyEntries(i),this.pipeline=t(n,this.atmosphere+I),this.group=m(n,this.pipeline,[i,a]),this.reflection=r.reflection?.create(n,this.code,this.entries,this.owned),this.lit=r.lighting?.create(n,this.code,this.entries,this.owned)}registerPasses(e){this.features.lighting&&e.add({name:`sky:lighting`,order:-6,execute:e=>{e.backend===`webgpu`&&this.options.lighting?.ambient&&(this.prepare(e),this.lit.pass(e,this.environmentLightLayer??this.environmentLayer))}}),this.features.lighting&&e.add({name:`sky:environment`,order:-.5,execute:e=>{e.backend!==`webgpu`||e.shader.includes(`let margoAmbient=`)||(this.options.lighting?.ambient?this.lit.patch(e):this.options.environment&&(this.prepare(e),this.lit.pass(e,this.environmentLightLayer??this.environmentLayer),this.lit.patch(e)))}}),e.add({name:`sky:atmosphere`,order:2,execute:e=>{e.backend===`webgpu`&&this.draw(e)}}),this.features.reflection&&e.add({name:`sky:environment-layer`,order:3.5,execute:e=>{e.backend===`webgpu`&&this.environmentLayer&&this.reflectionRequested&&this.reflection?.run(e,this.environmentLayer)}}),this.features.fog&&e.add({name:`sky:fog`,order:5,execute:e=>{e.backend===`webgpu`&&this.options.fog&&(this.fogPass??=this.features.fog.create(this.code)).draw(e,this.options.fog,this.entries)}})}get time(){return this.seconds}resetTime(){this.cloudTime=0,this.seconds=0,this.options.hours=this.startHours}advanceTime(e){if(this.validate(),!Number.isFinite(e)||e<0)throw RangeError(`Invalid sky delta; pass a finite delta of 0 or more seconds.`);this.cloudTime+=e*(this.options.clouds?.speed??8),this.seconds+=e,this.options.hours=(((this.options.hours??12)+e*(this.options.timeScale??1/3600))%24+24)%24}onPreUpdate(e){if(this.advanceTime(e),this.options.sunDirection){let e=Math.hypot(...this.options.sunDirection);for(let t=0;t<3;t++)this.sun[t]=this.options.sunDirection[t]/e}else ee(this.options.hours??12,this.sun);let t=this.options.lighting,n=Math.max(0,Math.min(1,(this.sun[1]+.12)/.2)),r=1-n*n*(3-2*n);if(r<1&&!this.features.preetham&&!this.features.bruneton)throw RangeError(`Daylight needs a day model: preetham or bruneton from @margoengine/sky`);let i=this.options.night?.moonDirection??(this.options.night?Ie:W),a=Math.hypot(i[0],i[1],i[2]);for(let e=0;e<3;e++)this.moon[e]=i[e]/a;let o=Math.max(0,Math.min(1,-this.sun[1]/.12)),s=o*o*(3-2*o),c=t?.moon?ae(this.options.night?S(this.options.night.moonPhase??.85):1,this.moon,t.moon.extinction,this.moonlit):void 0,l=t?.moon?this.look(t.moon):void 0,u=l?.light??1,d=typeof t?.moon?.color==`object`?t.moon.color:void 0,f=d??(c?O(c.illuminance*u,this.aboveColor,l.source):Fe),p=t?.moon?(t.moon.intensity??c.illuminance/(U(f)||1))*u:0;this.disc=l;let m=t?.moon?.cloudCover??(this.options.clouds?this.options.clouds.coverage??.45:0),h=p*U(f)*(this.deck?this.deck(this.moon[1]):oe(m)),g=d??(t?.moon?O(h,this.belowColor,l.source):Fe);this.values[23]=r,this.values.set(this.moon,28),this.values[31]=p*s,this.values.set(f,32);let _=Math.max(.001,(this.engine?.camera.position[1]??0)/1e3),v=this.options.atmosphere,y=V(this.sun[1],_,this.options.turbidity??2,this.sunColor,v&&this.features.look?this.features.look.air(this.options,this.air):void 0);if(v)for(let e=0;e<3;e++)y[e]*=(v.sunColor?.[e]??1)*(v.sunIntensity??1);let b=Math.max(y[0],y[1],y[2]);this.values.set(y,60),this.lights[0].direction.set(this.sun);let x=this.features.clouds&&this.options.clouds?this.options.clouds.coverage??.45:0;this.lights[0].direction[3]=t?(t.intensity??1)*b*(this.deck?this.deck(this.sun[1]):1)*(1-Pe(x)):0;for(let e=0;e<3;e++)this.lights[0].radiance[e]=(t?.color?.[e]??1)*(b>0?y[e]/b:1);this.lights[1].direction.set(this.moon),this.lights[1].direction[3]=this.values[31],this.lights[1].radiance.set(f),this.moonUnderClouds.direction.set(this.moon),this.moonUnderClouds.direction[3]=h/(U(g)||1)*s,this.moonUnderClouds.radiance.set(g);let C=t&&t.twilight!==!1?t.twilight??{}:void 0,w=this.twilightLight.direction;if(w[3]=0,C&&r>0){let e=r*he(Math.asin(this.sun[1]))*(C.brightness??1)*oe(C.cloudCover??(this.options.clouds?this.options.clouds.coverage??.45:0)),n=C.color??Se(-Math.asin(this.sun[1]),e,this.twilightColor),i=Math.hypot(this.sun[0],this.sun[2])/Math.SQRT1_2;w[0]=i>0?this.sun[0]/i:0,w[1]=i>0?Math.SQRT1_2:1,w[2]=i>0?this.sun[2]/i:0,w[3]=e/me*(t.intensity??1)/w[1]/(U(n)||1),this.twilightLight.radiance.set(n)}let T=this.options.model===`bruneton`?20*H(_,this.options.turbidity??2,v&&this.features.look?this.air:void 0):Me;this.zenithSun=T,this.lightScale=T>0?(t?t.intensity??1:this.engine?.lighting?.direction[3]??0)/T:0,this.lit&&(t||this.options.environment)&&this.lit.update(this.engine.lighting,this,t,this.ambient(),r,this.lightScale)}prepare(e){this.validate();let t=!!(this.options.look||this.options.atmosphere);if((this.options.model!==this.model||!!this.options.night!==this.stylized||t!==this.extended)&&this.recode(),!Oe(e.camera.matrix,this.inverse,this.scratch))throw new d(`state`,`Invalid sky camera; give the camera a finite, invertible projection`);this.values.set(e.camera.position,16),this.values[19]=Math.max(.001,e.camera.position[1]/1e3),this.values.set(this.sun,20),this.values[24]=+(this.options.model===`bruneton`),this.values[25]=this.options.exposure??0,this.values[26]=this.options.turbidity??2,this.values[36]=this.options.clouds?this.options.clouds.coverage??.45:0,this.values[37]=this.cloudTime,this.values[38]=this.options.clouds?.height??1500;let n=this.options.model===`bruneton`?20*H(this.values[19],this.options.turbidity??2,this.options.atmosphere&&this.features.look?this.air:void 0)/Me:1;this.values[35]=this.options.clouds?n/(1+(this.options.clouds.depth??20)*.075):0,this.values[27]=+De(e.format);let r=this.options.night;if(this.values[63]=+!!r,r){this.features.night.write(this.values,r,this.seconds);let e=this.disc;if(e){for(let t=0;t<3;t++)this.values[52+t]*=e.disc[t];let t=Math.min(1.57,(r.moonSize??.038)*e.size);this.values[51]=Math.cos(t),this.values[55]=Math.sin(t)}}this.extended&&this.features.look.air(this.options,this.air),this.options.model===`bruneton`&&(this.values[39]=this.extended?this.air[7]:.8),e.device.queue.writeBuffer(this.uniform,0,this.values);let i=!1;if(this.extended){this.features.look.write(this.extra,this.options,this.air,this.zenithSun),e.device.queue.writeBuffer(this.uniform,256,this.extra);for(let e=0;e<9;e++)i||=this.air[e]!==this.computedAir[e];this.computedAir.set(this.air)}let a=this.options.turbidity??2;(this.computedT!==a||i)&&o(e,this.pipeline,this.group,16,4);let s=this.options.groundAlbedo??0,c=this.albedo;c[3]=0;for(let e=0;e<3;e++)c[e]=typeof s==`number`?s:s[e],c[e]!==this.scatteringA[e]&&(c[3]=1);if(this.options.model===`bruneton`&&(this.scatteringT!==a||c[3]||i)){this.tables.run(e,c),this.scatteringT=a;for(let e=0;e<3;e++)this.scatteringA[e]=c[e]}this.computedT=a}recode(){this.model=this.options.model,this.stylized=!!this.options.night;let e=!!(this.options.look||this.options.atmosphere)&&!!this.features.look;if(e!==this.extended){if(this.extended=e,this.atmosphere=G(this.features,this.model,this.stylized,e)[0],this.engine?.gpu&&this.uniform){let e=this.bindUniform(this.engine.gpu);this.pipeline=t(this.engine.gpu,this.atmosphere+I),this.group=m(this.engine.gpu,this.pipeline,[e,this.transmission.createView()]),this.tables?.recode?.(this.extend(),e)}this.computedT=this.scatteringT=NaN,this.computedAir.fill(NaN)}this.code=G(this.features,this.model,this.stylized,e)[1],this.uniform&&(this.entries=this.skyEntries({buffer:this.uniform})),this.format=``,this.fogPass?.release(),this.fogPass=void 0,this.reflection?.recode(this.code,this.entries),this.lit?.recode(this.code,this.entries)}bindUniform(e){let t=this.extended?this.wide:this.plain;return t||(t=e.createBuffer({size:this.extended?576:256,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),this.extended?this.wide=t:this.plain=t),this.uniform=t,{buffer:t}}extend(){let e=this.features.look;return this.extended&&e?t=>e.extend(t,!1):void 0}skyEntries(e){return[{binding:0,resource:e},...this.tables&&this.model===`bruneton`?[{binding:1,resource:this.tables.view}]:[]]}draw(e){this.prepare(e),this.reflectionRequested&&this.reflection?.run(e);let t=e.format+`:`+e.descriptor.multisample?.count+`:`+e.descriptor.depthStencil.format;if(this.format!==t){let n=e.device.createShaderModule({code:this.code});this.render=e.device.createRenderPipeline({layout:`auto`,vertex:{module:n,entryPoint:`vertex`},fragment:{module:n,entryPoint:`fragment`,targets:[{format:e.format}]},multisample:e.descriptor.multisample,depthStencil:{format:e.descriptor.depthStencil.format,depthCompare:`greater-equal`,depthWriteEnabled:!1}}),this.bind=e.device.createBindGroup({layout:this.render.getBindGroupLayout(0),entries:[...this.entries,{binding:2,resource:this.transmission.createView()}]}),this.format=t}this.attachment.view=e.color,this.depthAttachment.view=e.depth;let r=e.encoder.beginRenderPass(this.presentation);r.setPipeline(this.render),r.setBindGroup(0,this.bind),n(r,e),r.draw(3),r.end(),this.options.coverage?e.view?.target||this.drawCoverage(e):this.dropCoverage()}drawCoverage(e){let t=e.device,i=e.descriptor.multisample?.count??1,a=e.descriptor.depthStencil.format,o=[e.width,e.height],s=o+`:`+i+`:`+a;if(this.cover?.[0]!==s){this.dropCoverage();let n=t.createTexture({size:o,format:`r8unorm`,usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_SRC}),r=i>1?t.createTexture({size:o,format:`r8unorm`,sampleCount:i,usage:GPUTextureUsage.RENDER_ATTACHMENT}):void 0,c=t.createShaderModule({code:f+`@fragment fn fragment()->@location(0) vec4f{return vec4f(1);}`});this.cover=[s,n,n.createView(),t.createRenderPipeline({layout:`auto`,vertex:{module:c,entryPoint:`vertex`},fragment:{module:c,entryPoint:`fragment`,targets:[{format:`r8unorm`}]},multisample:e.descriptor.multisample,depthStencil:{format:a,depthCompare:`greater-equal`,depthWriteEnabled:!1}}),r?.createView(),r]}let[,,c,l,u]=this.cover,d=e.encoder.beginRenderPass({colorAttachments:[{view:u??c,resolveTarget:u&&c,loadOp:r(e),clearValue:[0,0,0,0],storeOp:`store`}],depthStencilAttachment:{view:e.depth,depthReadOnly:!0,stencilReadOnly:!0}});d.setPipeline(l),n(d,e),d.draw(3),d.end()}dropCoverage(){this.cover?.[1].destroy(),this.cover?.[5]?.destroy(),this.cover=void 0}release(){this.dropCoverage(),this.plain?.destroy(),this.wide?.destroy(),this.fogPass?.release(),this.transmission?.destroy();for(let e of this.owned)e.destroy();this.owned=[],this.uniform=this.plain=this.wide=this.transmission=void 0,this.lit=this.fogPass=this.tables=this.reflection=void 0,this.pipeline=this.group=this.render=this.bind=void 0,this.entries=[],this.format=``,this.computedT=this.scatteringT=NaN}onDeviceRestored(e){this.release(),this.setup(e)}dispose(){if(!this.disposed){this.disposed=!0;for(let e of[...this.targets.values()])e();this.engine?.sceneOf(this)?.removePlugin(this.name),this.release(),this.engine=void 0}}[Symbol.dispose??Symbol()](){this.dispose()}},Be=[6.4,7.6,9.6],Ve={wgsl:`


fn nightPcg(v:u32)->u32 {let s=v*747796405u+2891336453u;let w=((s>>((s>>28u)+4u))^s)*277803737u;return (w>>22u)^w;}
fn hash21(p:vec2f)->f32 {let c=bitcast<vec2u>(vec2i(p));return f32(nightPcg(c.x+nightPcg(c.y))>>8u)*5.9604645e-8;}
fn stylizedNight(r:vec3f,footprint:f32)->vec3f {
 let haze=frame.nightHorizon.w;let moon=frame.nightMoon;let params=frame.nightParams;
 let gradient=mix(frame.nightZenith.rgb,frame.nightHorizon.rgb,pow(1.0-clamp(r.y,0.0,1.0),2.5/max(haze,0.01))*min(haze,1.0));var color=gradient;

 if(footprint<=0.0){return color;}
 let cosine=clamp(dot(r,moon.xyz),-1.0,1.0);
 if(r.y>0.258819){

  let scale=434.0/(1.0+r.y);let cell=r.xz*scale;


  let radius=max(0.0003,footprint*0.7);let size=radius*scale;
  let energy=0.0003*0.0003/(radius*radius)*(1.0-smoothstep(0.35,0.5,size));

  let corner=floor(cell-0.5);var stars=0.0;
  for(var i=0u;i<4u;i++){
   let id=corner+vec2f(f32(i&1u),f32(i>>1u));let random=hash21(id);
   if(random>0.975){let twinkle=max(0.0,sin(params.w*2.0+fract(random*613.7)*6.2831853)*0.5*frame.nightZenith.w+0.5);
    stars+=(1.0-smoothstep(0.0,2.0*size,length(cell-id-0.5)))*random*twinkle;}
  }
  color+=vec3f(0.8,0.9,1.0)*stars*energy*params.z*smoothstep(0.258819,0.5,r.y)*(1.0-smoothstep(0.96,1.0,cosine));
 }
 var cover=0.0;
 if(cosine>0.0){
  var right=normalize(cross(moon.xyz,select(vec3f(0,1,0),vec3f(0,0,1),abs(moon.y)>0.99)));


  if(abs(frame.sunlight.w-2.0)<0.5){let s=frame.sun.xyz-moon.xyz*dot(frame.sun.xyz,moon.xyz);if(dot(s,s)>1e-8){right=normalize(s);}}
  if(frame.sunlight.w>2.5){right=-right;}
  let disc=vec2f(dot(r,right),dot(r,cross(right,moon.xyz)))/frame.nightMoonColor.w;let radius=dot(disc,disc);

  let limb=sqrt(max(0.0004,1.0-radius));let lit=disc.x*sqrt(max(0.0,1.0-params.x*params.x))+limb*params.x;

  let edge=max(0.01,0.5*footprint/frame.nightMoonColor.w);
  cover=(1.0-smoothstep(1.0-edge,1.0+edge,sqrt(radius)))*min(1.0,1.0/(edge*edge));
  let earthshine=0.02*(1.0-params.x);
  color=mix(color,gradient,cover)+frame.nightMoonColor.rgb*(0.8+0.2*limb)*(smoothstep(0.0,0.02,lit)+earthshine)*cover;
 }
 return color+frame.nightMoonColor.rgb*pow(max(cosine,0.0),32.0)*params.y*0.35;
}
`,validate(e){if(e){for(let t of[e.zenithColor,e.horizonColor,e.moonColor])if(t!==void 0&&(c(t,3,`Sky color`),t.some(e=>e<0)))throw RangeError(`Sky colors must be non-negative`);if(e.moonLitBySun!==void 0&&typeof e.moonLitBySun!=`boolean`)throw TypeError(`Sky night moonLitBySun must be true or false`);if(e.moonDirection!==void 0&&(c(e.moonDirection,3,`Moon direction`),!Math.hypot(...e.moonDirection)))throw RangeError(`Moon direction must be nonzero`);e.moonPhase!==void 0&&S(e.moonPhase);for(let t of[e.moonSize,e.glowIntensity,e.starIntensity,e.starTwinkleIntensity,e.hazeDensity])if(t!==void 0&&!Number.isFinite(Math.fround(t)))throw RangeError(`Sky parameters must be finite Float32 numbers`);if(e.moonSize!==void 0&&!(Math.fround(e.moonSize)>0&&Math.fround(e.moonSize)<Math.PI/2))throw RangeError(`Moon size must be between 0 and PI / 2`)}},write(e,t,n){let r=t.moonDirection??[.4,.7,.5],i=Math.hypot(r[0],r[1],r[2]),a=t.moonSize??.038;e.set(t.zenithColor??[.015,.025,.065],40),e[43]=Math.max(0,t.starTwinkleIntensity??1),e.set(t.horizonColor??[.08,.09,.15],44),e[47]=Math.max(0,t.hazeDensity??1);for(let t=0;t<3;t++)e[48+t]=r[t]/i;e[51]=Math.cos(a),e.set(t.moonColor??Be,52),e[55]=Math.sin(a),e[56]=S(t.moonPhase??.85),e[57]=Math.max(0,t.glowIntensity??1.2),e[58]=Math.max(0,t.starIntensity??.8),e[59]=n,t.moonLitBySun?e[63]=2:t.moonPhase!==void 0&&C(t.moonPhase)&&(e[63]=3)}};function He(e,t,n){let r=_(e),i=t?t():r?.resolvedDepth;if(!i)return;let a=e.descriptor.multisample?.count??1;if(!i.format.startsWith(`depth`)||i.dimension!==`2d`||i.depthOrArrayLayers!==1||i.width!==e.width||i.height!==e.height||!(i.usage&GPUTextureUsage.TEXTURE_BINDING)||i.sampleCount!==1&&i.sampleCount!==a)throw RangeError(`${n} requires sampleable scene depth matching the viewport; pass the scene's depth texture`);let o=r?.samples===4&&r.resolvedDepth===i?r.depthSource:void 0;return o?{resource:o,texture:o,samples:4}:{resource:i.createView({aspect:`depth-only`}),texture:i,samples:i.sampleCount}}function Ue(e,t){return t===1?`@group(0) @binding(${e}) var sceneDepth:texture_depth_2d;
fn sceneDepthAt(pixel:vec2i)->f32 {return textureLoad(sceneDepth,pixel,0);}
`:`@group(0) @binding(${e}) var sceneDepth:texture_depth_multisampled_2d;
fn sceneDepthAt(pixel:vec2i)->f32 {return textureLoad(sceneDepth,pixel,0);}
`}var We=(e,t=`1.0.0`,n=import.meta.url)=>u(e,t,n),Ge=636e4,K={coverage:.5,bottom:1500,top:4e3,density:.04,scale:14e3,evolution:3,steps:64,lightSteps:6,maxDistance:8e4,sunIntensity:.55,stepCap:150,groundAlbedo:.2},Ke=[.3,.6,.4],q=.17,qe=[[.22,.3,.45],[.015,.018,.012]],Je=`
fn cloudHash3(p:vec3u)->vec3f {
 var v=p*1664525u+1013904223u;
 v.x+=v.y*v.z;v.y+=v.z*v.x;v.z+=v.x*v.y;v^=v>>vec3u(16u);
 v.x+=v.y*v.z;v.y+=v.z*v.x;v.z+=v.x*v.y;
 return vec3f(v)*2.3283064e-10;
}
`,Ye=`${Je}
@group(0) @binding(0) var volume:texture_storage_3d<rgba8unorm,write>;
fn wrapCell(c:vec3i,period:i32)->vec3u {return vec3u(((c%period)+period)%period);}
fn worley(p:vec3f,period:i32)->f32 {
 let cell=vec3i(floor(p));let f=fract(p);var best=3.0;
 for(var z=-1;z<=1;z++){for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){
  let o=vec3i(x,y,z);let d=vec3f(o)+cloudHash3(wrapCell(cell+o,period))-f;best=min(best,dot(d,d));
 }}}
 return clamp(1.0-sqrt(best),0.0,1.0);
}
fn worleyFbm(p:vec3f,period:i32)->f32 {return worley(p,period)*0.625+worley(p*2.0,period*2)*0.25+worley(p*4.0,period*4)*0.125;}
fn gradientNoise(p:vec3f,period:i32)->f32 {
 let cell=vec3i(floor(p));let f=fract(p);let u=f*f*f*(f*(f*6.0-15.0)+10.0);var v=array<f32,8>();
 for(var i=0;i<8;i++){
  let o=vec3i(i&1,(i>>1)&1,(i>>2)&1);let g=normalize(cloudHash3(wrapCell(cell+o,period))*2.0-1.0+vec3f(0.0001));
  v[i]=dot(g,f-vec3f(o));
 }
 return mix(mix(mix(v[0],v[1],u.x),mix(v[2],v[3],u.x),u.y),mix(mix(v[4],v[5],u.x),mix(v[6],v[7],u.x),u.y),u.z);
}
fn perlinFbm(p:vec3f,period:i32)->f32 {
 var sum=0.0;var weight=0.5;var q=p;var n=period;
 for(var i=0;i<4;i++){sum+=gradientNoise(q,n)*weight;q*=2.0;n*=2;weight*=0.5;}
 return clamp(sum*1.1+0.5,0.0,1.0);
}
@compute @workgroup_size(4,4,4) fn shape(@builtin(global_invocation_id) id:vec3u){
 let size=textureDimensions(volume);if(any(id>=size)){return;}let p=(vec3f(id)+0.5)/vec3f(size);
 let w=worleyFbm(p*4.0,4);
 let perlinWorley=clamp((perlinFbm(p*4.0,4)-(w-1.0))/(2.0-w),0.0,1.0);
 textureStore(volume,vec3i(id),vec4f(perlinWorley,w,worleyFbm(p*8.0,8),worleyFbm(p*16.0,16)));
}
@compute @workgroup_size(4,4,4) fn erosion(@builtin(global_invocation_id) id:vec3u){
 let size=textureDimensions(volume);if(any(id>=size)){return;}let p=(vec3f(id)+0.5)/vec3f(size);
 textureStore(volume,vec3i(id),vec4f(worleyFbm(p*2.0,2),worleyFbm(p*4.0,4),worleyFbm(p*8.0,8),1));
}
`,Xe=`
struct Clouds {inverse:mat4x4f,eye:vec4f,sun:vec4f,sunColor:vec4f,layer:vec4f,shape:vec4f,wind:vec4f,flags:vec4f,moon:vec4f,moonColor:vec4f,flash:vec4f,flashColor:vec4f,look:vec4f,storm:array<vec4f,8>}
fn cloudRemap(x:f32,a:f32,b:f32)->f32 {return (x-a)/max(b-a,0.00001);}
fn cloudAltitude(c:Clouds,p:vec3f)->f32 {let R=c.eye.w;return (dot(p,p)+2.0*R*p.y)/(length(vec3f(p.x,p.y+R,p.z))+R);}
fn cloudBase(s:vec4f)->f32 {let low=s.g*0.625+s.b*0.25+s.a*0.125;return clamp((clamp(cloudRemap(s.r,low-1.0,1.0),0.0,1.0)-0.67)/0.21,0.0,1.0);}
//[storm-fns]
fn cloudDensityAt(c:Clouds,shape:texture_3d<f32>,detail:texture_3d<f32>,smp:sampler,p:vec3f,erode:bool)->f32 {
 let h=(cloudAltitude(c,p)-c.layer.x)/(c.layer.y-c.layer.x);if(h<=0.0||h>=1.0){return 0.0;}
//[storm-branch]
 let q=(p+vec3f(c.wind.x,c.wind.z,c.wind.y))*c.shape.x;
 let s=textureSampleLevel(shape,smp,q.xzy,0.0);
 let weather=textureSampleLevel(shape,smp,vec3f((p.xz+c.flags.zw)*c.shape.x*${q},0.37),0.0).g;
 let cover=clamp(c.layer.z*(1.0+2.5*(weather-0.48)),0.0,1.0);
 let low=s.g*0.625+s.b*0.25+s.a*0.125;
 let base=clamp((clamp(cloudRemap(s.r,low-1.0,1.0),0.0,1.0)-0.67)/0.21,0.0,1.0);
 let profile=smoothstep(0.0,0.12,h)*smoothstep(1.0,0.45,h);
 let cloud=clamp(cloudRemap(base*profile,1.0-cover,1.0),0.0,1.0)*cover;
 if(cloud<=0.0||!erode){return cloud;}
 let e=textureSampleLevel(detail,smp,((p+vec3f(c.wind.x,c.wind.z*2.0,c.wind.y)*1.5)*c.shape.y).xzy,0.0).rgb;
 let high=e.r*0.625+e.g*0.25+e.b*0.125;
 return clamp(cloudRemap(cloud,mix(high,1.0-high,clamp(h*4.0,0.0,1.0))*0.35*c.look.x,1.0),0.0,1.0);
}
fn cloudLightDepth(c:Clouds,shape:texture_3d<f32>,detail:texture_3d<f32>,smp:sampler,p:vec3f,l:vec3f,n:u32)->f32 {
 let reach=(c.layer.y-c.layer.x)*0.75/max(l.y,0.25);var od=0.0;var previous=0.0;
 for(var i=0u;i<n;i++){let f=(f32(i)+1.0)/f32(n);let t=reach*f*f;od+=cloudDensityAt(c,shape,detail,smp,p+l*(0.5*(t+previous)),false)*(t-previous);previous=t;}
 return od*c.layer.w;
}
`,Ze=`${Je}${Xe}
@group(0) @binding(0) var<uniform> clouds:Clouds;
@group(0) @binding(1) var shapeNoise:texture_3d<f32>;
@group(0) @binding(2) var erosionNoise:texture_3d<f32>;
@group(0) @binding(3) var noiseSampler:sampler;
@group(0) @binding(4) var skyLight:texture_2d<f32>;
fn cloudShell(d:vec3f,h:f32)->vec2f {
 let e=clouds.eye.xyz;let R=clouds.eye.w;let b=dot(e,d)+R*d.y;let k=dot(e,e)+2.0*R*(e.y-h)-h*h;let disc=b*b-k;
 if(disc<0.0){return vec2f(-1.0);}
 let q=-(b+select(-sqrt(disc),sqrt(disc),b>=0.0));if(abs(q)<1e-6){return vec2f(0.0);}
 let roots=vec2f(q,k/q);return vec2f(min(roots.x,roots.y),max(roots.x,roots.y));
}
fn cloudHG(nu:f32,g:f32)->f32 {return (1.0-g*g)/pow(max(1.0+g*g-2.0*g*nu,0.0001),1.5);}
fn cloudPhaseK(nu:f32,k:f32)->f32 {return mix(cloudHG(nu,0.8*k),cloudHG(nu,-0.3*k),0.3);}
fn cloudTwoStream(a:f32,b:f32,nu:f32,u:f32)->f32 {
 let t=2.0/(2.0+0.15*(a+b));
 return max(0.0,0.5*(t*(1.0+0.15*b)-u)+0.75*(t-u)*nu);
}
fn cloudScatter(a:f32,b:f32,nu:f32)->f32 {
 let forward=exp(-0.15*a);let back=exp(-a);
 return 0.7*cloudHG(nu,0.8)*forward+0.3*cloudHG(nu,-0.3)*back+4.0*cloudTwoStream(a,b,nu,0.7*forward+0.3*back);
}
fn cloudSkyScatter(above:vec3f,below:vec3f,a:f32,b:f32,nu:f32)->vec3f {
 let t=2.0/(2.0+0.15*(a+b));
 return max(vec3f(0),t*(0.5*(above*(1.0+0.15*b)+below*(1.0+0.15*a))+0.75*nu*(above-below)));
}
fn cloudColumn(p:vec3f,dir:vec3f,reach:f32,n:u32)->f32 {
 var od=0.0;for(var i=0u;i<n;i++){od+=cloudDensityAt(clouds,shapeNoise,erosionNoise,noiseSampler,p+dir*(reach*(f32(i)+0.5)/f32(n)),false);}
 return od*reach/f32(n)*clouds.layer.w;
}
fn cloudAirPath(h0:f32,h1:f32,t:f32)->f32 {
 let a=exp(-h0/8000.0);let dh=max(h1,0.0)-h0;if(abs(dh)<1.0){return t*a;}return t*8000.0*(a-exp(-max(h1,0.0)/8000.0))/dh;
}
fn cloudStepPower(L:f32,n:f32,cap:f32)->f32 {
 if(cap<=0.0||L<=cap*n){return 1.0;}
 let ln=log(n);var p=max(1.0,log(L/cap)/ln);
 for(var i=0;i<8;i++){p=max(1.0,log(L*(exp2(p)-1.0)/cap)/ln);}
 return p;
}
fn cloudSpan(d:vec3f)->vec2f {
 let bottom=clouds.layer.x;let top=clouds.layer.y;let altitude=cloudAltitude(clouds,clouds.eye.xyz);
 var start=0.0;var end=-1.0;
 if(altitude<bottom){
  let up=normalize(vec3f(clouds.eye.x,clouds.eye.y+clouds.eye.w,clouds.eye.z));
  if(dot(d,up)>0.0){start=cloudShell(d,bottom).y;end=cloudShell(d,top).y;}
 } else if(altitude<=top){
  let low=cloudShell(d,bottom);end=select(cloudShell(d,top).y,low.x,low.x>0.0);
 } else {
  let high=cloudShell(d,top);
  if(high.x>0.0){start=high.x;let low=cloudShell(d,bottom);end=select(high.y,low.x,low.x>0.0);}
 }
 return vec2f(start,min(end,start+clouds.shape.z));
}
struct CloudLight {light:vec3f,scene:vec3f,opacity:f32}
fn cloudMarch(d:vec3f,start:f32,end:f32,n:u32,jitter:f32,glow:f32)->CloudLight {
 let bottom=clouds.layer.x;let top=clouds.layer.y;
 let span=end-start;let nf=f32(n);let power=cloudStepPower(span,nf,clouds.moonColor.w);let s=clouds.sun.xyz;let nu=dot(d,s);
 let lit=max(clouds.sunColor.r,max(clouds.sunColor.g,clouds.sunColor.b))>0.0;
 let above=textureLoad(skyLight,vec2i(0,0),0).rgb;let below=textureLoad(skyLight,vec2i(1,0),0).rgb+clouds.look.w*above;
 let m=clouds.moon.xyz;let nuMoon=dot(d,m);let moonLit=clouds.moon.w>0.0&&max(clouds.moonColor.r,max(clouds.moonColor.g,clouds.moonColor.b))>0.0;
 let lightN=u32(clouds.wind.w);let columnN=max(1u,(lightN+1u)/2u);let eyeHeight=max(cloudAltitude(clouds,clouds.eye.xyz),0.0);

 let ground=clouds.sunColor.rgb*clouds.sun.w*4.0*clouds.look.w*max(s.y,0.0);
 var t=start+span*pow(jitter/nf,power);
 var transmittance=1.0;var light=vec3f(0);var scene=vec3f(0);var opacity=0.0;
 for(var k=0u;k<n;k++){
  let next=start+span*pow((f32(k)+1.0+jitter)/nf,power);let dt=next-t;
  let p=clouds.eye.xyz+d*t;let density=cloudDensityAt(clouds,shapeNoise,erosionNoise,noiseSampler,p,true);
  if(density>0.0){
   let sigma=density*clouds.layer.w;
   let altitude=cloudAltitude(clouds,p);let up=normalize(vec3f(p.x,p.y+clouds.eye.w,p.z));let nuUp=dot(d,up);

   let below0=cloudColumn(p,-up,max(altitude-bottom,0.0),columnN);
   var sun=vec3f(0);var aUp=-1.0;
   if(lit){
    let a=cloudLightDepth(clouds,shapeNoise,erosionNoise,noiseSampler,p,s,lightN);let slant=max(s.y,0.25);aUp=a*slant;
    sun=clouds.sunColor.rgb*clouds.sun.w*cloudScatter(a,below0/slant,nu)+cloudSkyScatter(vec3f(0),ground,aUp,below0,nuUp);
   }
   var moon=vec3f(0);
   if(moonLit){
    let od=cloudLightDepth(clouds,shapeNoise,erosionNoise,noiseSampler,p,m,lightN);let slant=max(m.y,0.25);
    if(aUp<0.0){aUp=od*slant;}
    moon=clouds.moonColor.rgb*clouds.moon.w*0.15*(cloudScatter(od,below0/slant,nuMoon)+0.5*(cloudHG(nuMoon,glow)-cloudPhaseK(nuMoon,1.0))*exp(-0.15*od));
   }
   if(aUp<0.0){aUp=cloudColumn(p,up,max(top-altitude,0.0),columnN);}
   let sky=cloudSkyScatter(above,below,aUp,below0,nuUp);
   var flash=vec3f(0);
   if(clouds.flash.w>0.0){
    let toward=clouds.flash.xyz-p;let r2=dot(toward,toward);var od=0.0;
    for(var f=1u;f<=3u;f++){od+=cloudDensityAt(clouds,shapeNoise,erosionNoise,noiseSampler,p+toward*(f32(f)*0.25),false);}
    od*=clouds.layer.w*sqrt(r2)*0.25;
    flash=clouds.flashColor.rgb*clouds.flash.w*(exp(-od)+0.5*exp(-0.3*od)+0.25*exp(-0.08*od))/(r2+clouds.flashColor.w*clouds.flashColor.w);
   }
   let step=exp(-sigma*dt);let haze=exp(-cloudAirPath(eyeHeight,altitude,t)/40000.0);let w=transmittance*(1.0-step)*haze;
   light+=w*(sun+sky+moon+flash);scene+=w*(sky+flash+clouds.look.y*sun+clouds.look.z*moon);opacity+=w;transmittance*=step;
   if(transmittance<0.01){break;}
  }
  t=next;
 }
 return CloudLight(light,scene,opacity);
}
`,Qe=e=>`${f}${Ze}${Ee}
${e}
@fragment fn fragment(i:Vertex)->@location(0) vec4f {
 let ndc=vec2f(i.uv.x*2.0-1.0,1.0-i.uv.y*2.0);let far=clouds.inverse*vec4f(ndc,0.000001,1);
 let d=normalize(far.xyz/far.w-clouds.eye.xyz);
 let span=cloudSpan(d);var end=span.y;
 ${e?`let z=sceneDepthAt(vec2i(i.position.xy));if(z>0.0){let w=clouds.inverse*vec4f(ndc,z,1);end=min(end,length(w.xyz/w.w-clouds.eye.xyz));}`:``}
 if(end<=span.x){discard;}
 let m=cloudMarch(d,span.x,end,u32(clouds.shape.w),fract(cloudHash3(vec3u(vec2u(i.position.xy),7u)).x+clouds.flags.y),0.95);
 if(m.opacity<=0.0){discard;}
 var color=m.light*clouds.sunColor.w;
 if(clouds.flags.x>0.5){color=toDisplay(color/m.opacity)*m.opacity;}
 return vec4f(color,m.opacity);
}
`,$e=`${Ze}
@group(0) @binding(5) var deck:texture_storage_2d<rgba16float,write>;
@group(0) @binding(6) var deckLight:texture_storage_2d<rgba16float,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
 if(any(id.xy>=vec2u(64,32))){return;}
 var light=vec3f(0);var scene=vec3f(0);var opacity=0.0;
 for(var r=0u;r<4u;r++){
  let uv=(vec2f(id.xy)+vec2f(f32(r&1u),f32(r>>1u))*0.5+0.25)/vec2f(64,32);
  let phi=(uv.x-0.5)*6.2831853;let theta=uv.y*3.14159265;
  let d=vec3f(sin(theta)*cos(phi),cos(theta),sin(theta)*sin(phi));
  let span=cloudSpan(d);
  if(span.y>span.x){let m=cloudMarch(d,span.x,span.y,32u,(f32(r)+0.5)*0.25,0.8);light+=m.light;scene+=m.scene;opacity+=m.opacity;}
 }
 let k=0.25*clouds.sunColor.w;
 textureStore(deck,vec2i(id.xy),vec4f(light*k,opacity*0.25));
 textureStore(deckLight,vec2i(id.xy),vec4f(scene*k,opacity*0.25));
}
`,et=`${Xe}
@group(0) @binding(0) var<uniform> clouds:Clouds;
@group(0) @binding(1) var map:texture_2d<f32>;
@group(0) @binding(2) var lightOut:texture_storage_2d<rgba32float,write>;
var<workgroup> sums:array<vec4f,128>;
@compute @workgroup_size(64) fn main(@builtin(local_invocation_index) x:u32){
 var above=vec4f(0);var side=vec4f(0);
 for(var y=0u;y<16u;y++){let theta=(f32(y)+0.5)/32.0*3.14159265;let w=cos(theta)*sin(theta);above+=vec4f(textureLoad(map,vec2u(x,y),0).rgb*w,w);
  side+=vec4f(textureLoad(map,vec2u(x,31u-y),0).rgb*w,w);}
 sums[x]=above;sums[64u+x]=side;workgroupBarrier();
 for(var s=32u;s>0u;s=s>>1u){if(x<s){sums[x]+=sums[x+s];sums[64u+x]+=sums[64u+x+s];}workgroupBarrier();}
 if(x==0u){let unexpose=1.0/clouds.sunColor.w;
  textureStore(lightOut,vec2i(0,0),vec4f(sums[0].rgb/sums[0].w*unexpose,1));textureStore(lightOut,vec2i(1,0),vec4f(sums[64].rgb/sums[64].w*unexpose,1));}
}
`,tt=class{constructor(e){this.filled=!1;let t=t=>e.createTexture({size:[t,t,t],dimension:`3d`,format:`rgba8unorm`,usage:GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.TEXTURE_BINDING});this.shape=t(64),this.erosion=t(32),this.sampler=e.createSampler({magFilter:`linear`,minFilter:`linear`,addressModeU:`repeat`,addressModeV:`repeat`,addressModeW:`repeat`})}fill(e,t){if(this.filled)return;let n=e.createShaderModule({code:Ye});for(let[r,i,a]of[[this.shape,`shape`,16],[this.erosion,`erosion`,8]]){let o=e.createComputePipeline({layout:`auto`,compute:{module:n,entryPoint:i}}),s=t.beginComputePass();s.setPipeline(o),s.setBindGroup(0,e.createBindGroup({layout:o.getBindGroupLayout(0),entries:[{binding:0,resource:r.createView()}]})),s.dispatchWorkgroups(a,a,a),s.end()}this.filled=!0}dispose(){this.shape.destroy(),this.erosion.destroy()}[Symbol.dispose??Symbol()](){this.dispose()}},nt={cloud:.5},rt={coverage:0,bottom:0,top:0,density:0},it={coverage:0,bottom:0,top:0,density:0};function J(e,t={coverage:0,bottom:0,top:0,density:0}){let n=e.type??(e.hurricane===void 0?void 0:`hurricane`),r=e.weather||n?l(e.weather??nt,rt,n):void 0;return t.coverage=e.coverage??r?.coverage??K.coverage,t.bottom=e.bottom??r?.bottom??K.bottom,t.top=e.top??r?.top??K.top,t.density=e.density??r?.density??K.density,t}var Y,at,X,Z=e=>e.hurricane!==void 0||e.type===`hurricane`;function ot(){return at??=p(()=>import(`./storm-field-BBINzcyw-CM5BpLRS.js`).then(e=>Y=e.stormField(q)),[],import.meta.url)}function st(e){if(X!==void 0)throw X;return!Y&&Z(e)&&ot().catch(e=>X=e??Error(`storm field failed to load`)),Y}var Q=(e,t)=>t?e.replace(`//[storm-fns]`,t.fns).replace(`//[storm-branch]`,t.branch):e;function ct(e,t,n,r=0){let i=t.scale??K.scale,a=J(t,it);e[19]=Ge,e[28]=a.bottom,e[29]=a.top,e[30]=a.coverage,e[31]=a.density,e[32]=1/i,e[33]=8/i,e[36]=n[0],e[37]=n[1],e[38]=n[2],e[42]=n[3]??0,e[43]=n[4]??0,e[60]=t.erosion??1,Y?Y.write(e,t,r,i):e.fill(0,64,96)}var $=(e,t,n)=>Number.isFinite(e)&&e>=t&&e<=n,lt=class t{coreRequirement=i(`1.0.0`,import.meta.url);constructor(t={}){this.options=t,this.name=`sky:volumetric-clouds`,this.key=``,this.disposed=!1,this.frames=0,this.extra=0,this.pending=!1,this.seconds=0,this.values=new Float32Array(96),this.scratch=new Float64Array(52),this.color=new Float32Array(3),this.ambientValues=new Float32Array(8),this.layer={coverage:0,bottom:0,top:0,density:0},this.deckOf=t=>{if(this.options.dimLight===!1)return 1;let n=J(this.options,this.layer),r=Y?.of(this.options);if(r){let e=this.engine?.camera.position??[0,0,0];n.coverage*=Math.min(1,Y.coverOver(r,e[0],e[2],this.seconds,n.top-n.bottom))}return e(n,t)},this.drift=new Float64Array(5),this.validate()}static attach(e,n={}){s(e,i(`1.0.0`,import.meta.url));let r=new t(n);return We(e).use(r),r}validate(){let e=this.options;if(typeof e!=`object`||!e)throw TypeError(`VolumetricClouds options must be an object`);if(e.sky!==void 0&&(typeof e.sky!=`object`||e.sky===null||!(e.sky.sun?.length>=3)))throw TypeError(`VolumetricClouds sky must be a Sky (with a sun direction); pass the sky that lights the clouds`);if(e.temporal!==void 0&&typeof e.temporal!=`boolean`&&e.temporal!==`auto`)throw TypeError(`VolumetricClouds temporal must be true, false or 'auto'`);if(e.dimLight!==void 0&&typeof e.dimLight!=`boolean`)throw TypeError(`VolumetricClouds dimLight must be true or false`);if((e.weather!==void 0||e.type!==void 0)&&l(e.weather??nt,void 0,e.type),e.hurricane!==void 0&&(typeof e.hurricane!=`object`||e.hurricane===null))throw TypeError(`VolumetricClouds hurricane must be a Hurricane or its options`);if(e.depth!==void 0&&typeof e.depth!=`function`)throw TypeError(`VolumetricClouds depth must be a function returning the scene depth texture`);if(e.sunDirection&&c(e.sunDirection,3,`VolumetricClouds sunDirection`),e.sunDirection&&!(Math.hypot(...e.sunDirection)>0))throw RangeError(`VolumetricClouds sunDirection needs a nonzero length`);if(e.wind&&c(e.wind,2,`VolumetricClouds wind`),e.ambient)for(let t of e.ambient)c(t,3,`VolumetricClouds ambient`);if(e.flash!==void 0){if(typeof e.flash!=`object`||e.flash===null)throw TypeError(`VolumetricClouds flash must be an object with a position and an intensity`);if(c(e.flash.position,3,`VolumetricClouds flash position`),e.flash.color&&c(e.flash.color,3,`VolumetricClouds flash color`),!$(e.flash.intensity,0,0xe8d4a51000)||e.flash.color&&e.flash.color.some(e=>e<0)||!$(e.flash.radius??200,1,1e5))throw RangeError(`Invalid VolumetricClouds flash; use an intensity of 0 to 1e12, a color of 0 or more and a radius of 1 to 100000`)}let{coverage:t,bottom:n,top:r,density:i}=J(e,this.layer);if(!$(t,0,1)||!$(n,100,2e4)||!$(r,n+1,2e4)||!$(i,1e-6,1)||!$(e.stepCap??K.stepCap,10,1e4)||!$(e.erosion??1,0,2)||!$(e.groundAlbedo??K.groundAlbedo,0,1)||!$(e.scale??K.scale,1e3,2e5)||!$(e.evolution??K.evolution,0,50)||!Number.isInteger(e.steps??K.steps)||!$(e.steps??K.steps,8,256)||!Number.isInteger(e.lightSteps??K.lightSteps)||!$(e.lightSteps??K.lightSteps,1,16)||!$(e.maxDistance??K.maxDistance,1e3,4e5)||!$(e.sunIntensity??K.sunIntensity,0,1e3))throw RangeError(`Invalid VolumetricClouds options; keep coverage 0 to 1, bottom 100 to 20000 below top (at most 20000), density above 0 to 1, scale 1000 to 200000, evolution 0 to 50, integer steps 8 to 256 and lightSteps 1 to 16, maxDistance 1000 to 400000, stepCap 10 to 10000, groundAlbedo 0 to 1 and sunIntensity 0 or more.`)}setup(e){if(this.disposed||!e.gpu)throw new d(this.disposed?`disposed`:`unsupported`,`VolumetricClouds requires WebGPU; attach new VolumetricClouds to a WebGPU engine; see https://margoengine.com/errors#webgpu`);this.engine=e,this.hookDeck();let t=e.gpu;this.uniform=t.createBuffer({size:this.values.byteLength,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),this.volumes=new tt(t),this.light=t.createTexture({size:[2,1],format:`rgba32float`,usage:GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});let n=()=>t.createTexture({size:[64,32],format:`rgba16float`,usage:GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.TEXTURE_BINDING});this.deck=n(),this.deckLight=n()}registerPasses(e){e.add({name:`sky:volumetric-clouds`,order:3,execute:e=>{e.backend===`webgpu`&&this.draw(e)}})}get ready(){return Z(this.options)?ot().then(e=>void e.of(this.options)):Promise.resolve()}get time(){return this.seconds}onPreUpdate(e){this.advanceTime(e)}resetTime(){this.seconds=0,this.frames=0,this.extra=0,this.pending=!1,this.drift.fill(0)}advanceTime(e){if(this.validate(),!Number.isFinite(e)||e<0)throw RangeError(`Invalid VolumetricClouds delta; pass a finite delta of 0 or more seconds.`);if(!(e>0)){this.pending=!0;return}this.hookDeck(),this.seconds+=e,this.frames=(this.frames+1)%1024,this.extra=0,this.pending=!1;let t=this.options.wind??[10,3],n=this.options.scale??K.scale,r=n/q;this.drift[0]=(this.drift[0]+t[0]*e)%n,this.drift[1]=(this.drift[1]+t[1]*e)%n,this.drift[2]=(this.drift[2]+(this.options.evolution??K.evolution)*e)%n,this.drift[3]=(this.drift[3]+t[0]*e)%r,this.drift[4]=(this.drift[4]+t[1]*e)%r}write(t){let n=this.options,r=this.values,i=n.sky;if(!Oe(t.camera.matrix,r.subarray(0,16),this.scratch))throw new d(`state`,`Invalid VolumetricClouds camera; give the camera a finite, invertible projection`);let a=J(n,this.layer),{bottom:o,top:s}=a,c=i?.sun??n.sunDirection??Ke,l=Math.hypot(c[0],c[1],c[2])||1;r.set(t.camera.position,16),ct(r,n,this.drift,this.seconds);for(let e=0;e<3;e++)r[20+e]=c[e]/l;r[23]=n.sunIntensity??K.sunIntensity,V(r[21],(o+s)/2e3,i?.options.turbidity??2,this.color),r.set(this.color,24),r[27]=2**(i?.options.exposure??0),r[34]=n.maxDistance??K.maxDistance,r[35]=n.steps??K.steps,r[39]=n.lightSteps??K.lightSteps,r[40]=+!De(t.format),this.pending&&(this.extra=(this.extra+1)%1024),this.pending=!1,r[41]=n.temporal===!0||n.temporal!==!1&&this.engine?.hasPlugin(`taa`)?(this.frames+this.extra+1023)%1024*.6180339887498949%1:0;let u=i?.lights?.[1];for(let e=0;e<4;e++)r[44+e]=u?u.direction[e]:0;for(let e=0;e<3;e++)r[48+e]=u?u.radiance[e]:0;r[51]=n.stepCap??K.stepCap;let f=n.flash;r.set(f?.position??[0,0,0],52),r[55]=f?.intensity??0,r.set(f?.color??[.75,.82,1],56),r[59]=f?.radius??200;let p=n.dimLight!==!1&&!!i,m=r[23],h=i?.lightScale??1,g=i?.options.lighting?i.options.lighting.intensity??1:0;return r[61]=p||!(m>0)||!(h>0)?0:g/h/(4*Math.PI*m),r[62]=p||!(h>0)?0:1/(4*Math.PI*.15)/h,r[63]=(n.groundAlbedo??K.groundAlbedo)*e(a,Math.max(r[21],.1)),t.device.queue.writeBuffer(this.uniform,0,r),r[30]>0}skyLight(e){let t=this.options.sky?.reflectionTexture;if(t){this.lightSource!==t&&(this.lightPipeline??=e.device.createComputePipeline({layout:`auto`,compute:{module:e.device.createShaderModule({code:Q(et,this.built)}),entryPoint:`main`}}),this.lightGroup=e.device.createBindGroup({layout:this.lightPipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.uniform}},{binding:1,resource:t.createView()},{binding:2,resource:this.light.createView()}]}),this.lightSource=t);let n=e.encoder.beginComputePass();n.setPipeline(this.lightPipeline),n.setBindGroup(0,this.lightGroup),n.dispatchWorkgroups(1),n.end();return}let[n,r]=this.options.ambient??qe,i=this.ambientValues;i.set(n,0),i.set(r,4),i[3]=i[7]=1,e.device.queue.writeTexture({texture:this.light},i,{bytesPerRow:32},[2,1])}environment(e){let t=this.options.sky;if(this.layered!==t&&this.unlayer(),!t||!(`environmentLayer`in t))return;this.deckGroup||=(this.deckPipeline??=e.device.createComputePipeline({layout:`auto`,compute:{module:e.device.createShaderModule({code:Q($e,this.built)}),entryPoint:`main`}}),e.device.createBindGroup({layout:this.deckPipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.uniform}},{binding:1,resource:this.volumes.shape.createView()},{binding:2,resource:this.volumes.erosion.createView()},{binding:3,resource:this.volumes.sampler},{binding:4,resource:this.light.createView()},{binding:5,resource:this.deck.createView()},{binding:6,resource:this.deckLight.createView()}]}));let n=e.encoder.beginComputePass();n.setPipeline(this.deckPipeline),n.setBindGroup(0,this.deckGroup),n.dispatchWorkgroups(8,4),n.end(),t.environmentLayer=this.deck,`environmentLightLayer`in t&&(t.environmentLightLayer=this.deckLight),this.layered=t}hookDeck(){let e=this.engine?this.options.sky:void 0;this.decked!==e&&(this.unhookDeck(),e&&(e.deck=this.deckOf),this.decked=e)}unhookDeck(){this.decked?.deck===this.deckOf&&(this.decked.deck=void 0),this.decked=void 0}unlayer(){this.layered&&this.layered.environmentLayer===this.deck&&(this.layered.environmentLayer=void 0),this.layered&&this.layered.environmentLightLayer===this.deckLight&&(this.layered.environmentLightLayer=void 0),this.layered=void 0}draw(e){if(!this.uniform)return;let t=st(this.options);if(Z(this.options)&&!t)return;if(t!==this.built&&(this.lightPipeline=this.lightGroup=this.deckPipeline=this.deckGroup=this.lightSource=void 0,this.key=``,this.built=t),this.hookDeck(),!this.write(e)){this.unlayer();return}this.volumes.fill(e.device,e.encoder),this.skyLight(e),this.environment(e);let r=He(e,this.options.depth,`VolumetricClouds`),i=e.descriptor.multisample?.count??1,a=`${e.format}:${i}:${r?.samples??0}:${e.descriptor.depthStencil?.format}`;if(this.key!==a){let t=e.device.createShaderModule({code:Q(Qe(r?Ue(5,r.samples):``),this.built)});this.pipeline=e.device.createRenderPipeline({layout:`auto`,vertex:{module:t,entryPoint:`vertex`},fragment:{module:t,entryPoint:`fragment`,targets:[{format:e.format,blend:{color:{srcFactor:`one`,dstFactor:`one-minus-src-alpha`,operation:`add`},alpha:{srcFactor:`zero`,dstFactor:`one`,operation:`add`}}}]},multisample:e.descriptor.multisample,...r?{}:{depthStencil:{format:e.descriptor.depthStencil.format,depthCompare:`greater-equal`,depthWriteEnabled:!1}}}),this.key=a,this.bound=void 0}this.bound!==(r?.texture??this.light)&&(this.bind=e.device.createBindGroup({layout:this.pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.uniform}},{binding:1,resource:this.volumes.shape.createView()},{binding:2,resource:this.volumes.erosion.createView()},{binding:3,resource:this.volumes.sampler},{binding:4,resource:this.light.createView()},...r?[{binding:5,resource:r.resource}]:[]]}),this.bound=r?.texture??this.light);let o=e.encoder.beginRenderPass({colorAttachments:[{view:e.color,loadOp:`load`,storeOp:`store`}],...r?{}:{depthStencilAttachment:{view:e.depth,depthReadOnly:!0,stencilReadOnly:!0}}});n(o,e),o.setPipeline(this.pipeline),o.setBindGroup(0,this.bind),o.draw(3),o.end()}release(){this.unlayer(),this.unhookDeck(),this.uniform?.destroy(),this.volumes?.dispose(),this.light?.destroy(),this.deck?.destroy(),this.deckLight?.destroy(),this.uniform=this.volumes=this.light=this.deck=this.deckLight=void 0,this.pipeline=this.bind=this.lightPipeline=this.lightGroup=this.deckPipeline=this.deckGroup=void 0,this.bound=this.lightSource=void 0,this.key=``}onDeviceRestored(e){this.release(),this.setup(e)}dispose(){this.disposed||(this.disposed=!0,this.engine?.sceneOf(this)?.removePlugin(this.name),this.release(),this.engine=void 0)}[Symbol.dispose??Symbol()](){this.dispose()}};function ut(e,t,n){return ze.attach(e,{hours:0,timeScale:0,night:{moonDirection:[-.52,.39,-.78],moonSize:.0075,moonPhase:.69,moonColor:[.43,.55,.75],glowIntensity:.37,zenithColor:[.008,.012,.027],horizonColor:[.061,.082,.151],hazeDensity:.9,starIntensity:.23,starTwinkleIntensity:0}},{night:Ve}),lt.attach(e,{type:`storm`,coverage:.78,bottom:t,top:3320,density:.022,hurricane:{center:[-9700,-14400],maxWindRadius:12700,eyeRadius:6800,eyewallWidth:5500,outerEyewall:18500,outerEyewallStrength:.45,moat:.28,shield:.31,canopy:.44,bands:4,bandWidth:5200,bandStart:18e3,bandRotation:.37,extent:65e3,swirl:0,pressureDrop:43},scale:6500,erosion:1.13,steps:86,lightSteps:5,maxDistance:16500,stepCap:94,groundAlbedo:.06,temporal:!1,wind:[0,0],evolution:0,sunDirection:[-.54,.33,-.77],sunIntensity:.018,ambient:[[.016,.027,.053],[.013,.021,.048]],flash:n}).ready}export{ut as buildStormField};