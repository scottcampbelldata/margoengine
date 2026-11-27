import{n as e,t}from"./version-DZ3BcJze.js";import{n}from"./extension-BytumP3S.js";import{a as r,c as i,i as a,o,r as s,s as c,t as l}from"./pass-Ds4X-3Cx-RvEACC2X.js";import{n as u,t as d}from"./color-CMZXT1qw-Zyib9BIW.js";import{o as f}from"./mat4-Dl2hqlTt.js";import{t as p}from"./errors-DkwPZuAq.js";import{t as m}from"./validate-ChuY9rdH.js";import{t as h}from"./preload-helper-CRzLMJPS.js";var g=(e,t)=>Object.assign(Error(t),{name:`MargoError`,code:e});(globalThis[Symbol.for(`margoengine.frame-resources`)]??={devices:new WeakMap}).devices;function _(e){return e?.adapterInfo?.vendor===`margo-webgl2`?`webgl2`:`native`}function v(e){return _(e)===`native`&&e?.features?.has(`core-features-and-limits`)===!1}function y(e,t){return _(e)===`webgl2`?t():void 0}var b=`@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {return vec4f(array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3))[i],0,1);}`,x=Symbol.for(`margoengine.optional.msaa`);b+``;function S(e){let t=e[x];return t?.color===e.color&&t.depth===e.depth?t:void 0}function C(e,t){return t>1&&v(e)?Array.from({length:t},(e,t)=>t):[null]}function ee(e,t=new Float32Array(3)){if(!Number.isFinite(e)||t.length!==3)throw RangeError(`Invalid sun clock; pass finite hours and an out array of 3 elements.`);let n=(e%24-6)*Math.PI/12;return t[0]=Math.cos(n),t[1]=Math.sin(n),t[2]=0,t}var w=Math.SQRT1_2,T={new:{phase:-1,waning:!1},waxingCrescent:{phase:-w,waning:!1},firstQuarter:{phase:0,waning:!1},waxingGibbous:{phase:w,waning:!1},full:{phase:1,waning:!1},waningGibbous:{phase:w,waning:!0},lastQuarter:{phase:0,waning:!0},waningCrescent:{phase:-w,waning:!0},half:{phase:0,waning:!1},quarter:{phase:0,waning:!1}},te=e=>{let t=typeof e==`string`&&Object.hasOwn(T,e)?T[e]:void 0;if(!t&&!(typeof e==`number`&&Number.isFinite(Math.fround(e))))throw RangeError(`Invalid moon phase ${String(e)}; give a number from -1 to 1 or one of ${Object.keys(T).join(`, `)}.`);return t};function E(e){return te(e)?.phase??Math.max(-1,Math.min(1,e))}function ne(e){return te(e)?.waning??!1}var D=.172,[O,re]=u(4943.405869870266),ie=.25,ae=[0,0,0];function oe(e,t,n=D,r={illuminance:0,color:[0,0,0],intensity:0}){let i=Math.hypot(t[0],t[1],t[2]);if(!(e>=-1&&e<=1)||!(i>0&&Number.isFinite(i))||!(n>=0&&n<=2))throw RangeError(`Invalid moonlight; give a phase from -1 to 1, a finite non-zero direction and an extinction from 0 to 2 magnitudes per airmass.`);let a=Math.acos(e)*180/Math.PI,o=10**(-.4*(3.84+.026*a+4e-9*a**4))*10.7639,s=t[1]/i,c=s>0?o*10**(-.4*n*ce(s)):0,l=k(c,r.color);return r.illuminance=c,r.intensity=c/(.2126*l[0]+.7152*l[1]+.0722*l[2]),r}function k(e,t=[0,0,0],n){if(!(e>=0&&Number.isFinite(e)))throw RangeError(`Invalid moonlight illuminance; give a finite number of lux, 0 or more.`);let r=O,i=re;if(n){let[e,t,a]=[n[0],n[1],n[2]],o=.4124*e+.3576*t+.1805*a,s=.2126*e+.7152*t+.0722*a,c=o+s+.0193*e+.1192*t+.9505*a;if(!(c>0&&Number.isFinite(c)))throw RangeError(`Invalid moonlight source colour; give non-negative linear RGB, not black.`);r=o/c,i=s/c}let a=Math.max(0,Math.min(1,(Math.log10(e/Math.PI)+2)/2.6)),o=a*a*(3-2*a),s=d((1-o)*ie+o*r,(1-o)*ie+o*i,ae);for(let e=0;e<3;e++)t[e]=s[e];return t}function se(e){if(!(e>=0&&e<=1))throw RangeError(`Invalid cloud cover; give a fraction of the sky from 0 to 1.`);return 1-.75*e**3.4}function ce(e){return 1/Math.sqrt(1-.96*(1-e*e))}var A=384400/356375,le=.5,ue=10**(-.4*(12.74-2.8)),de=[.005802,.013558,.0331],fe=[65e-5,.001881,85e-6],pe=1/(Math.sin(5*Math.PI/180)+.50572*11.07995**-1.6364),me=12,j,he=()=>{if(j)return j;let e=0;for(let t=.5;t<700;t++)e+=2*Math.max(0,1-Math.abs(me+t*t/12720-25)/15);let t=Math.exp(-12/8)*Math.sqrt(2*Math.PI*6360*8);return j={low:de.map((e,t)=>Math.exp(-(e*8+fe[t]*15)*pe)),limb:de.map((n,r)=>Math.exp(-(n*t+fe[r]*e)))}};function ge(e=1,t,n=1,r=D){let i=1,a=1,o;if(e===`bright`)i=A*A,a=A;else if(e===`dim`)i=le;else if(typeof e==`number`&&e>=0&&Number.isFinite(e))i=e;else throw RangeError(`Invalid moon brightness ${String(e)}; give a number of 0 or more, 'bright' or 'dim'.`);let s=i/(a*a);if(t===`blood`)o=he().limb,i*=ue,s*=ue;else if(t===`reddened`){o=he().low;let e=Math.min(1,10**(-.4*r*(pe-ce(Math.max(0,Math.min(1,n))))));i*=e,s*=e}else if(typeof t==`string`)throw RangeError(`Invalid moon color ${t}; give linear RGB, 'blood' or 'reddened'.`);let c=s**(1/3),l=o??[1,1,1],u=.2126*l[0]+.7152*l[1]+.0722*l[2],f;if(o){let e=d(O,re,[0,0,0]);f=[e[0]*o[0],e[1]*o[1],e[2]*o[2]]}return{light:i,size:a,disc:[c*l[0]/u,c*l[1]/u,c*l[2]/u],source:f}}var _e=133775*Math.exp(-.21);function ve(e){if(!Number.isFinite(e))throw RangeError(`Invalid sun elevation; give finite radians.`);let t=Math.max(-Math.PI/2,Math.min(Math.PI/2,e)),n=Math.sin(t),r=753.66156,i=Math.cos(Math.asin(r*Math.cos(t)/754.66156)),a=r*(i-n)+i;return 3866.0975*Math.exp(-.042*a)*(1+(t*180/Math.PI+90)*n/57.29578)}var M=[.005802,.013558,.0331],ye=[65e-5,.001881,85e-6],N=6360,P=e=>Math.max(0,1-Math.abs(e-25)/15),F=NaN,be=6*Math.PI/180,I=[0,0,0],L=[0,0,0];function xe(e,t=[0,0,0]){if(!Number.isFinite(e))throw RangeError(`Invalid sun depression; give finite radians.`);let n=Math.max(0,Math.min(be,e));if(n!==F){let e=Math.sin(n);L.fill(0);let t=0;for(let r=.5;r<100;r++){let i=N+r;if(t+=P(r-.5),i*Math.cos(n)<N)continue;let a=0,o=0;for(let t=2;t<2400;t+=4){let n=Math.sqrt(i*i+t*t-2*i*t*e)-N;if(n>100)break;a+=Math.exp(-n/8)*4,o+=P(n)*4}let s=8*(1-Math.exp(-r/8));for(let e=0;e<3;e++)L[e]+=M[e]*Math.exp(-r/8-M[e]*(a+s)-ye[e]*(o+t))}let r=Math.max(L[0],L[1],L[2])||1;for(let e=0;e<3;e++)I[e]=L[e]/r;F=n}return t[0]=I[0],t[1]=I[1],t[2]=I[2],t}function Se(e,t,n=[0,0,0]){return k(t,n,xe(e,n))}var Ce=`
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
`,Te=`
@group(0) @binding(1) var output:texture_storage_2d<rgba16float,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
 if(any(id.xy>=vec2u(128,32))){return;}let u=f32(id.x)/127.0*2.0-1.0;let mu=u*abs(u);let r=R+100.0*pow(f32(id.y)/31.0,2.0)+0.001;
 var result=vec3f(0);if(!ground(r,mu)){let step=boundary(r,mu)/64.0;var optical=vec3f(0);for(var i=0u;i<64u;i++){let d=(f32(i)+0.5)*step;optical+=extinction(sqrt(r*r+d*d+2.0*r*mu*d))*step;}result=exp(-optical);}
 textureStore(output,vec2i(id.xy),vec4f(result,1));
}`,Ee=[.005802,.013558,.0331],R=new Float64Array(6);function z(e,t,n,r=!1){let i=(-e*t+Math.sqrt(Math.max(0,e*e*(t*t-1)+41731600)))/64,a=0,o=0,s=0;for(let n=0;n<64;n++){let c=(n+.5)*i,l=Math.max(0,Math.sqrt(e*e+c*c+2*e*t*c)-6360);a+=Math.exp(-l/8)*i,o+=Math.exp(-l/1.2)*i,r&&(s+=Math.max(0,1-Math.abs(l-25)/15)*i)}R[n]=a,R[n+1]=o,r&&(R[4+n/2]=s)}var De=[65e-5,.001881,85e-6];function B(e,t,n,r=new Float32Array(3),i){if(!Number.isFinite(e)||!Number.isFinite(t)||!Number.isFinite(n)||r.length!==3)throw RangeError(`Invalid sunlight: pass finite mu, altitude and turbidity and a 3-element output`);if(i)return Oe(e,t,n,r,i);let a=6360+Math.min(99.9,Math.max(.001,t)),o=-Math.sqrt(Math.max(0,1-(6360/a)**2)),s=Math.max(0,Math.min(1,(e-o+.014)/.028)),c=s*s*(3-2*s),l=.003996*Math.max(.25,(n-1)*.5)/.9;z(a,Math.min(1,Math.max(e,o+1e-4)),0),z(a,1,2);for(let e=0;e<3;e++)r[e]=c?c*Math.exp(-(Ee[e]*(R[0]-R[2])+l*(R[1]-R[3]))):0;return r}function Oe(e,t,n,r,i){let a=6360+Math.min(99.9,Math.max(.001,t)),o=-Math.sqrt(Math.max(0,1-(6360/a)**2)),s=Math.max(0,Math.min(1,(e-o+.014)/.028)),c=s*s*(3-2*s),l=.003996*Math.max(.25,(n-1)*.5)/.9;z(a,Math.min(1,Math.max(e,o+1e-4)),0,!0),z(a,1,2,!0);for(let e=0;e<3;e++)r[e]=c?c*Math.exp(-(i[e]*(R[0]-R[2])+l*i[8]*(R[1]-R[3])+De[e]*i[3]*(R[4]-R[5]))):0;return r}function ke(e,t,n){let r=6360+Math.min(99.9,Math.max(.001,e)),i=.003996*Math.max(.25,(t-1)*.5)/.9,a=[.2126,.7152,.0722];z(r,1,2,!!n);let o=0;for(let e=0;e<3;e++)o+=a[e]*Math.exp(-(n?n[e]*R[2]+i*n[8]*R[3]+De[e]*n[3]*R[5]:Ee[e]*R[2]+i*R[3]));return o}var Ae=`fn pbrNeutral(input:vec3f)->vec3f {let x=min(input.r,min(input.g,input.b));let offset=select(0.04,x-6.25*x*x,x<0.08);var v=input-offset;let peak=max(v.r,max(v.g,v.b));if(peak<0.76){return v;}let newPeak=1.0-0.24*0.24/(peak+0.24-0.76);v*=newPeak/peak;return mix(v,vec3f(newPeak),1.0-1.0/(0.15*(peak-newPeak)+1.0));}
fn toDisplay(c:vec3f)->vec3f {let x=pbrNeutral(max(c,vec3f(0)));return select(x*12.92,1.055*pow(x,vec3f(1.0/2.4))-0.055,x>=vec3f(0.0031308));}
`,je=e=>typeof e==`string`&&e.endsWith(`float`),Me=(e,t=`0.1.0`,r=import.meta.url)=>n(e,t,r),Ne=`fn dither(p:vec2f)->f32{
 var x=(u32(p.x)*0x9e3779b9u)^(u32(p.y)*0x85ebca6bu);x=(x^(x>>16u))*0x7feb352du;x=(x^(x>>15u))*0x846ca68bu;x^=x>>16u;
 return f32(x&0xffffu)/65536.0+f32(x>>16u)/65536.0-1.0;
}`,Pe=`
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
`,Fe=4*Math.PI*.55,Ie=76;function Le(e){let t=Math.min(1,Math.max(0,(e-.8)/.2));return t*t*(3-2*t)}var V=e=>.2126*e[0]+.7152*e[1]+.0722*e[2],Re=[.25,.45,.75],H=[-.3,.22,-1],ze=[.4,.7,.5],Be={day:[.04,.04,.04],night:[.01,.015,.03]};function U(e,t,n,r=!1){let[i,a]=Ve(e,t,n);return r&&e.look?[e.look.extend(i,!1),e.look.extend(a,!0)]:[i,a]}function Ve(e,t,n){let r=e.bruneton,i=n&&e.night,a=!!e.preetham&&t!==`bruneton`,o=t===`bruneton`&&r,c=Ce+(r?.phase??``)+we+(r?.tail??``);return[c,s+c+(e.clouds?.wgsl??`
fn cloudSky(color:vec3f,backdrop:vec3f,ray:vec3f,angularFootprint:f32)->vec3f {return color;}
`)+Pe+`
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
${Ae}




${Ne}
@fragment fn fragment(i:Vertex)->@location(0) vec4f {
 let p=frame.inverse*vec4f(i.uv.x*2.0-1.0,1.0-i.uv.y*2.0,0.000001,1);let w=normalize(p.xyz/p.w-frame.eye.xyz);let s=frame.sun.xyz;
 let footprint=max(length(dpdx(w)),length(dpdy(w)));let sky=skyRadiance(w,footprint);var color=sky;
 let sun=celestialProfile(w,s,SUN_RADIUS,footprint);
 color+=(sun.x*60.0+sun.y*0.8)*trans(transmission,R+clamp(frame.eye.w,0.001,99.9),s.y)*(1.0-frame.sun.w);
 color+=frame.moonColor.rgb*frame.moon.w*moonRadiance(w,frame.moon.xyz,footprint)*f32(frame.sunlight.w<0.5);
 color=cloudSky(color,sky,w,footprint);color*=exp2(frame.settings.y);if(frame.settings.w<0.5&&frame.sunlight.w<0.5){color=toDisplay(color);color+=dither(i.position.xy)*min(vec3f(1.0/255.0),min(color,1.0-color));}return vec4f(color,1);
}`]}var He=class{coreRequirement=e(`0.1.0`,import.meta.url);get airControls(){return!!this.features.look}look(e){let t=this.lookKey,n=this.moon[1];return this.disc&&t[0]===e.brightness&&t[1]===e.color&&t[2]===n&&t[3]===e.extinction||(this.disc=ge(e.brightness,e.color,n,e.extinction),t[0]=e.brightness,t[1]=e.color,t[2]=n,t[3]=e.extinction),this.disc}get cloudLayer(){let e=this.options.clouds,t=this.features.clouds?.field;if(e&&t)return{field:t,coverage:e.coverage??.45,drift:this.cloudTime,height:e.height??1500}}get coverageTexture(){return this.cover?.[1]}get reflectionTexture(){return this.reflectionRequested=!0,this.reflection?.texture}get nightFactor(){return this.values[23]}constructor(e={},t={}){this.options=e,this.features=t,this.presentation=l(),this.attachment=this.presentation.colorAttachments[0],this.depthAttachment=this.presentation.depthStencilAttachment,this.name=`sky`,this.environmentLayer=void 0,this.environmentLightLayer=void 0,this.lightScale=0,this.deck=void 0,this.entries=[],this.format=``,this.computedT=NaN,this.scatteringT=NaN,this.scatteringA=new Float64Array(3),this.albedo=new Float32Array(4),this.values=new Float32Array(64),this.extra=new Float32Array(Ie),this.zenithSun=0,this.air=new Float32Array(9),this.computedAir=new Float32Array(9).fill(NaN),this.seconds=0,this.inverse=this.values.subarray(0,16),this.scratch=new Float64Array(52),this.sunColor=new Float32Array(3),this.sun=new Float32Array(3),this.moon=Float32Array.from(H,e=>e/Math.hypot(...H)),this.moonlit={illuminance:0,color:[0,0,0],intensity:0},this.lookKey=[],this.aboveColor=[0,0,0],this.belowColor=[0,0,0],this.disposed=!1,this.cloudTime=0,this.reflectionRequested=!1,this.owned=[],this.targets=new Map,this.lights=[{direction:new Float32Array([1,0,0,0]),radiance:new Float32Array(3)},{direction:new Float32Array([...this.moon,0]),radiance:new Float32Array(3)}],this.moonUnderClouds={direction:new Float32Array([...this.moon,0]),radiance:new Float32Array(3)},this.twilightLight={direction:new Float32Array([0,1,0,0]),radiance:new Float32Array([1,1,1])},this.twilightColor=[1,1,1],this.startHours=e.hours,this.model=e.model,this.stylized=!!e.night,this.extended=!!(e.look||e.atmosphere)&&!!t.look,[this.atmosphere,this.code]=U(t,this.model,this.stylized,this.extended),this.validate()}add(e){if(this.disposed)throw g(`disposed`,`Sky is disposed; create a new Sky`);if(!e||typeof e.addLighting!=`function`)throw TypeError(`Sky lighting target needs addLighting; pass a native PBR model or VoxelRenderer`);let t=this.targets.get(e);if(!t){let n=e.addLighting(this);t=()=>{this.targets.get(e)===t&&(this.targets.delete(e),n())},this.targets.set(e,t)}return t}pbr(e){return this.ambient()?this.lit?.pbr(e):void 0}bindings(){return this.ambient()?this.lit?.bindings()??[]:[]}ambient(){let e=this.options;return e.lighting?.ambient?e.lighting.ambient:e.environment?Be:void 0}validate(){let e=this.options,t=this.features,n=e.model??`preetham`;if(e.sunDirection!==void 0&&(!Array.isArray(e.sunDirection)||e.sunDirection.length!==3||e.sunDirection.some(e=>!Number.isFinite(Math.fround(e)))||!(Math.hypot(...e.sunDirection)>0)))throw RangeError(`Sky sun direction needs three finite components and nonzero length`);if(e.model!==void 0&&e.model!==`preetham`&&e.model!==`bruneton`||!Number.isFinite(e.hours??12)||!Number.isFinite(e.timeScale??1/3600)||Math.abs(e.timeScale??1/3600)>24||!Number.isFinite(e.turbidity??2)||(e.turbidity??2)<1||(e.turbidity??2)>10||!Number.isFinite(e.exposure??0)||Math.abs(e.exposure??0)>16)throw RangeError(`Invalid sky options; keep timeScale within ±24, turbidity from 1 to 10, exposure within ±16 and hours finite, and use model "preetham" or "bruneton".`);if((e.model!==void 0||t.preetham||t.bruneton)&&!t[n])throw TypeError(`Sky model '${n}' needs ${n} from @margoengine/sky/${n}`);let r=e.groundAlbedo;if(r!==void 0){let e=typeof r==`number`?[r]:r;if(!Array.isArray(e)||typeof r!=`number`&&e.length!==3||e.some(e=>!(typeof e==`number`&&e>=0&&e<=1)))throw RangeError(`Invalid sky groundAlbedo; use a number from 0 to 1 or three of them (linear RGB)`);if(!t.bruneton)throw TypeError(`Sky groundAlbedo needs bruneton from @margoengine/sky/bruneton`)}if(e.coverage!==void 0&&typeof e.coverage!=`boolean`)throw RangeError(`Sky coverage must be true or false; pass a boolean`);if(e.environment!==void 0&&typeof e.environment!=`boolean`)throw RangeError(`Sky environment must be true or false; pass a boolean`);if(e.environment&&!t.lighting)throw TypeError(`Sky environment needs lighting from @margoengine/sky/lighting`);if(e.look!==void 0||e.atmosphere!==void 0){if(!t.look)throw TypeError(`Sky look and atmosphere need look from @margoengine/sky/look`);t.look.validate(e)}for(let n of[`clouds`,`fog`,`night`,`lighting`]){let r=e[n],i=t[n];if(r!==void 0){if(!i)throw TypeError(`Sky ${n} needs ${n} from @margoengine/sky/${n}`);i.validate(r)}}}static attach(n,r={},i={}){t(n,e(`0.1.0`,import.meta.url));let a=Me(n);if(a.plugins.has(`sky`))throw g(`attached`,`This scene already has a Sky; change sky.options on that one, or dispose() it first`);let o=new this(r,i);return a.use(o),o}setup(e){if(this.disposed||!e.gpu)throw new p(this.disposed?`disposed`:`unsupported`,`Sky requires WebGPU; attach a new Sky to a WebGPU engine; see https://margoengine.com/errors#webgpu`);this.engine=e;let t=e.gpu,n=this.features,r=this.bindUniform(t);this.transmission=t.createTexture({size:[128,32],format:`rgba16float`,usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.STORAGE_BINDING});let i=this.transmission.createView();this.tables=n.bruneton?.create(t,r,i,this.owned,this.extend()),this.entries=this.skyEntries(r),this.pipeline=a(t,this.atmosphere+Te),this.group=o(t,this.pipeline,[r,i]),this.reflection=n.reflection?.create(t,this.code,this.entries,this.owned),this.lit=n.lighting?.create(t,this.code,this.entries,this.owned)}registerPasses(e){this.features.lighting&&e.add({name:`sky:lighting`,order:-6,execute:e=>{e.backend===`webgpu`&&this.options.lighting?.ambient&&(this.prepare(e),this.lit.pass(e,this.environmentLightLayer??this.environmentLayer))}}),this.features.lighting&&e.add({name:`sky:environment`,order:-.5,execute:e=>{e.backend!==`webgpu`||e.shader.includes(`let margoAmbient=`)||(this.options.lighting?.ambient?this.lit.patch(e):this.options.environment&&(this.prepare(e),this.lit.pass(e,this.environmentLightLayer??this.environmentLayer),this.lit.patch(e)))}}),e.add({name:`sky:atmosphere`,order:2,execute:e=>{e.backend===`webgpu`&&this.draw(e)}}),this.features.reflection&&e.add({name:`sky:environment-layer`,order:3.5,execute:e=>{e.backend===`webgpu`&&this.environmentLayer&&this.reflectionRequested&&this.reflection?.run(e,this.environmentLayer)}}),this.features.fog&&e.add({name:`sky:fog`,order:5,execute:e=>{e.backend===`webgpu`&&this.options.fog&&(this.fogPass??=this.features.fog.create(this.code)).draw(e,this.options.fog,this.entries)}})}get time(){return this.seconds}resetTime(){this.cloudTime=0,this.seconds=0,this.options.hours=this.startHours}advanceTime(e){if(this.validate(),!Number.isFinite(e)||e<0)throw RangeError(`Invalid sky delta; pass a finite delta of 0 or more seconds.`);this.cloudTime+=e*(this.options.clouds?.speed??8),this.seconds+=e,this.options.hours=(((this.options.hours??12)+e*(this.options.timeScale??1/3600))%24+24)%24}onPreUpdate(e){if(this.advanceTime(e),this.options.sunDirection){let e=Math.hypot(...this.options.sunDirection);for(let t=0;t<3;t++)this.sun[t]=this.options.sunDirection[t]/e}else ee(this.options.hours??12,this.sun);let t=this.options.lighting,n=Math.max(0,Math.min(1,(this.sun[1]+.12)/.2)),r=1-n*n*(3-2*n);if(r<1&&!this.features.preetham&&!this.features.bruneton)throw RangeError(`Daylight needs a day model: preetham or bruneton from @margoengine/sky`);let i=this.options.night?.moonDirection??(this.options.night?ze:H),a=Math.hypot(i[0],i[1],i[2]);for(let e=0;e<3;e++)this.moon[e]=i[e]/a;let o=Math.max(0,Math.min(1,-this.sun[1]/.12)),s=o*o*(3-2*o),c=t?.moon?oe(this.options.night?E(this.options.night.moonPhase??.85):1,this.moon,t.moon.extinction,this.moonlit):void 0,l=t?.moon?this.look(t.moon):void 0,u=l?.light??1,d=typeof t?.moon?.color==`object`?t.moon.color:void 0,f=d??(c?k(c.illuminance*u,this.aboveColor,l.source):Re),p=t?.moon?(t.moon.intensity??c.illuminance/(V(f)||1))*u:0;this.disc=l;let m=t?.moon?.cloudCover??(this.options.clouds?this.options.clouds.coverage??.45:0),h=p*V(f)*(this.deck?this.deck(this.moon[1]):se(m)),g=d??(t?.moon?k(h,this.belowColor,l.source):Re);this.values[23]=r,this.values.set(this.moon,28),this.values[31]=p*s,this.values.set(f,32);let _=Math.max(.001,(this.engine?.camera.position[1]??0)/1e3),v=this.options.atmosphere,y=B(this.sun[1],_,this.options.turbidity??2,this.sunColor,v&&this.features.look?this.features.look.air(this.options,this.air):void 0);if(v)for(let e=0;e<3;e++)y[e]*=(v.sunColor?.[e]??1)*(v.sunIntensity??1);let b=Math.max(y[0],y[1],y[2]);this.values.set(y,60),this.lights[0].direction.set(this.sun);let x=this.features.clouds&&this.options.clouds?this.options.clouds.coverage??.45:0;this.lights[0].direction[3]=t?(t.intensity??1)*b*(this.deck?this.deck(this.sun[1]):1)*(1-Le(x)):0;for(let e=0;e<3;e++)this.lights[0].radiance[e]=(t?.color?.[e]??1)*(b>0?y[e]/b:1);this.lights[1].direction.set(this.moon),this.lights[1].direction[3]=this.values[31],this.lights[1].radiance.set(f),this.moonUnderClouds.direction.set(this.moon),this.moonUnderClouds.direction[3]=h/(V(g)||1)*s,this.moonUnderClouds.radiance.set(g);let S=t&&t.twilight!==!1?t.twilight??{}:void 0,C=this.twilightLight.direction;if(C[3]=0,S&&r>0){let e=r*ve(Math.asin(this.sun[1]))*(S.brightness??1)*se(S.cloudCover??(this.options.clouds?this.options.clouds.coverage??.45:0)),n=S.color??Se(-Math.asin(this.sun[1]),e,this.twilightColor),i=Math.hypot(this.sun[0],this.sun[2])/Math.SQRT1_2;C[0]=i>0?this.sun[0]/i:0,C[1]=i>0?Math.SQRT1_2:1,C[2]=i>0?this.sun[2]/i:0,C[3]=e/_e*(t.intensity??1)/C[1]/(V(n)||1),this.twilightLight.radiance.set(n)}let w=this.options.model===`bruneton`?20*ke(_,this.options.turbidity??2,v&&this.features.look?this.air:void 0):Fe;this.zenithSun=w,this.lightScale=w>0?(t?t.intensity??1:this.engine?.lighting?.direction[3]??0)/w:0,this.lit&&(t||this.options.environment)&&this.lit.update(this.engine.lighting,this,t,this.ambient(),r,this.lightScale)}prepare(e){this.validate();let t=!!(this.options.look||this.options.atmosphere);if((this.options.model!==this.model||!!this.options.night!==this.stylized||t!==this.extended)&&this.recode(),!f(e.camera.matrix,this.inverse,this.scratch))throw new p(`state`,`Invalid sky camera; give the camera a finite, invertible projection`);this.values.set(e.camera.position,16),this.values[19]=Math.max(.001,e.camera.position[1]/1e3),this.values.set(this.sun,20),this.values[24]=+(this.options.model===`bruneton`),this.values[25]=this.options.exposure??0,this.values[26]=this.options.turbidity??2,this.values[36]=this.options.clouds?this.options.clouds.coverage??.45:0,this.values[37]=this.cloudTime,this.values[38]=this.options.clouds?.height??1500;let n=this.options.model===`bruneton`?20*ke(this.values[19],this.options.turbidity??2,this.options.atmosphere&&this.features.look?this.air:void 0)/Fe:1;this.values[35]=this.options.clouds?n/(1+(this.options.clouds.depth??20)*.075):0,this.values[27]=+je(e.format);let i=this.options.night;if(this.values[63]=+!!i,i){this.features.night.write(this.values,i,this.seconds);let e=this.disc;if(e){for(let t=0;t<3;t++)this.values[52+t]*=e.disc[t];let t=Math.min(1.57,(i.moonSize??.038)*e.size);this.values[51]=Math.cos(t),this.values[55]=Math.sin(t)}}this.extended&&this.features.look.air(this.options,this.air),this.options.model===`bruneton`&&(this.values[39]=this.extended?this.air[7]:.8),e.device.queue.writeBuffer(this.uniform,0,this.values);let a=!1;if(this.extended){this.features.look.write(this.extra,this.options,this.air,this.zenithSun),e.device.queue.writeBuffer(this.uniform,256,this.extra);for(let e=0;e<9;e++)a||=this.air[e]!==this.computedAir[e];this.computedAir.set(this.air)}let o=this.options.turbidity??2;(this.computedT!==o||a)&&r(e,this.pipeline,this.group,16,4);let s=this.options.groundAlbedo??0,c=this.albedo;c[3]=0;for(let e=0;e<3;e++)c[e]=typeof s==`number`?s:s[e],c[e]!==this.scatteringA[e]&&(c[3]=1);if(this.options.model===`bruneton`&&(this.scatteringT!==o||c[3]||a)){this.tables.run(e,c),this.scatteringT=o;for(let e=0;e<3;e++)this.scatteringA[e]=c[e]}this.computedT=o}recode(){this.model=this.options.model,this.stylized=!!this.options.night;let e=!!(this.options.look||this.options.atmosphere)&&!!this.features.look;if(e!==this.extended){if(this.extended=e,this.atmosphere=U(this.features,this.model,this.stylized,e)[0],this.engine?.gpu&&this.uniform){let e=this.bindUniform(this.engine.gpu);this.pipeline=a(this.engine.gpu,this.atmosphere+Te),this.group=o(this.engine.gpu,this.pipeline,[e,this.transmission.createView()]),this.tables?.recode?.(this.extend(),e)}this.computedT=this.scatteringT=NaN,this.computedAir.fill(NaN)}this.code=U(this.features,this.model,this.stylized,e)[1],this.uniform&&(this.entries=this.skyEntries({buffer:this.uniform})),this.format=``,this.fogPass?.release(),this.fogPass=void 0,this.reflection?.recode(this.code,this.entries),this.lit?.recode(this.code,this.entries)}bindUniform(e){let t=this.extended?this.wide:this.plain;return t||(t=e.createBuffer({size:this.extended?560:256,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),this.extended?this.wide=t:this.plain=t),this.uniform=t,{buffer:t}}extend(){let e=this.features.look;return this.extended&&e?t=>e.extend(t,!1):void 0}skyEntries(e){return[{binding:0,resource:e},...this.tables&&this.model===`bruneton`?[{binding:1,resource:this.tables.view}]:[]]}draw(e){this.prepare(e),this.reflectionRequested&&this.reflection?.run(e);let t=e.format+`:`+e.descriptor.multisample?.count+`:`+e.descriptor.depthStencil.format;if(this.format!==t){let n=e.device.createShaderModule({code:this.code});this.render=e.device.createRenderPipeline({layout:`auto`,vertex:{module:n,entryPoint:`vertex`},fragment:{module:n,entryPoint:`fragment`,targets:[{format:e.format}]},multisample:e.descriptor.multisample,depthStencil:{format:e.descriptor.depthStencil.format,depthCompare:`greater-equal`,depthWriteEnabled:!1}}),this.bind=e.device.createBindGroup({layout:this.render.getBindGroupLayout(0),entries:[...this.entries,{binding:2,resource:this.transmission.createView()}]}),this.format=t}this.attachment.view=e.color,this.depthAttachment.view=e.depth;let n=e.encoder.beginRenderPass(this.presentation);n.setPipeline(this.render),n.setBindGroup(0,this.bind),c(n,e),n.draw(3),n.end(),this.options.coverage?e.view?.target||this.drawCoverage(e):this.dropCoverage()}drawCoverage(e){let t=e.device,n=e.descriptor.multisample?.count??1,r=e.descriptor.depthStencil.format,a=[e.width,e.height],o=a+`:`+n+`:`+r;if(this.cover?.[0]!==o){this.dropCoverage();let i=t.createTexture({size:a,format:`r8unorm`,usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_SRC}),c=n>1?t.createTexture({size:a,format:`r8unorm`,sampleCount:n,usage:GPUTextureUsage.RENDER_ATTACHMENT}):void 0,l=t.createShaderModule({code:s+`@fragment fn fragment()->@location(0) vec4f{return vec4f(1);}`});this.cover=[o,i,i.createView(),t.createRenderPipeline({layout:`auto`,vertex:{module:l,entryPoint:`vertex`},fragment:{module:l,entryPoint:`fragment`,targets:[{format:`r8unorm`}]},multisample:e.descriptor.multisample,depthStencil:{format:r,depthCompare:`greater-equal`,depthWriteEnabled:!1}}),c?.createView(),c]}let[,,l,u,d]=this.cover,f=e.encoder.beginRenderPass({colorAttachments:[{view:d??l,resolveTarget:d&&l,loadOp:i(e),clearValue:[0,0,0,0],storeOp:`store`}],depthStencilAttachment:{view:e.depth,depthReadOnly:!0,stencilReadOnly:!0}});f.setPipeline(u),c(f,e),f.draw(3),f.end()}dropCoverage(){this.cover?.[1].destroy(),this.cover?.[5]?.destroy(),this.cover=void 0}release(){this.dropCoverage(),this.plain?.destroy(),this.wide?.destroy(),this.fogPass?.release(),this.transmission?.destroy();for(let e of this.owned)e.destroy();this.owned=[],this.uniform=this.plain=this.wide=this.transmission=void 0,this.lit=this.fogPass=this.tables=this.reflection=void 0,this.pipeline=this.group=this.render=this.bind=void 0,this.entries=[],this.format=``,this.computedT=this.scatteringT=NaN}onDeviceRestored(e){this.release(),this.setup(e)}dispose(){if(!this.disposed){this.disposed=!0;for(let e of[...this.targets.values()])e();this.engine?.sceneOf(this)?.removePlugin(this.name),this.release(),this.engine=void 0}}[Symbol.dispose??Symbol()](){this.dispose()}},Ue={wgsl:`fn perez(theta:f32,gamma:f32,a:f32,b:f32,c:f32,d:f32,e:f32)->f32{return (1.0+a*exp(b/max(0.01,cos(theta))))*(1.0+c*exp(d*gamma)+e*cos(gamma)*cos(gamma));}
fn preetham(w:vec3f,s:vec3f)->vec3f {
 let t=max(2.0,frame.settings.z);let theta=acos(clamp(w.y,0.01,1.0));let gamma=acos(clamp(dot(w,s),-1.0,1.0));let z=acos(clamp(s.y,0.01,1.0));let z2=z*z;let z3=z2*z;
 let yz=max(0.001,(4.0453*t-4.9710)*tan((4.0/9.0-t/120.0)*(3.14159265-2.0*z))-0.2155*t+2.4192);
 let xz=(0.00166*z3-0.00375*z2+0.00209*z)*t*t+(-0.02903*z3+0.06377*z2-0.03202*z+0.00394)*t+0.11693*z3-0.21196*z2+0.06052*z+0.25886;
 let zz=(0.00275*z3-0.00610*z2+0.00317*z)*t*t+(-0.04214*z3+0.08970*z2-0.04153*z+0.00516)*t+0.15346*z3-0.26756*z2+0.06670*z+0.26688;
 let y=yz*perez(theta,gamma,0.1787*t-1.4630,-0.3554*t+0.4275,-0.0227*t+5.3251,0.1206*t-2.5771,-0.0670*t+0.3703)/perez(0.0,z,0.1787*t-1.4630,-0.3554*t+0.4275,-0.0227*t+5.3251,0.1206*t-2.5771,-0.0670*t+0.3703)*0.05;
 let x=xz*perez(theta,gamma,-0.0193*t-0.2592,-0.0665*t+0.0008,-0.0004*t+0.2125,-0.0641*t-0.8989,-0.0033*t+0.0452)/perez(0.0,z,-0.0193*t-0.2592,-0.0665*t+0.0008,-0.0004*t+0.2125,-0.0641*t-0.8989,-0.0033*t+0.0452);
 let chroma=max(-3.0*x*x+2.87*x-0.275,zz*perez(theta,gamma,-0.0167*t-0.2608,-0.0950*t+0.0092,-0.0079*t+0.2102,-0.0441*t-1.6537,-0.0109*t+0.0529)/perez(0.0,z,-0.0167*t-0.2608,-0.0950*t+0.0092,-0.0079*t+0.2102,-0.0441*t-1.6537,-0.0109*t+0.0529));
 let xyz=vec3f(x*y/max(chroma,0.001),y,(1.0-x-chroma)*y/max(chroma,0.001));
 return max(vec3f(0),mat3x3f(vec3f(3.2406,-0.9689,0.0557),vec3f(-1.5372,1.8758,-0.2040),vec3f(-0.4986,0.0415,1.0570))*xyz)*smoothstep(-0.2,0.05,s.y);
}
`},W=`fn phaseR(nu:f32)->f32{return 0.0596831037*(1.0+nu*nu);}
fn phaseM(nu:f32)->f32 {let g=0.8;return 0.1193662073*(1.0-g*g)*(1.0+nu*nu)/((2.0+g*g)*pow(max(0.01,1.0+g*g-2.0*g*nu),1.5));}
`,G=`fn coordinates(pixel:vec2u)->vec4f {let nu=f32(pixel.x%8u)/7.0*2.0-1.0;let mus=f32(pixel.x/8u)/15.0*2.0-1.0;let v=f32(pixel.y%32u)/31.0*2.0-1.0;return vec4f(R+100.0*pow(f32(pixel.y/32u)/7.0,2.0)+0.001,v*abs(v),mus,nu);}
fn lookup(t:texture_2d<f32>,r:f32,mu:f32,mus:f32,nu:f32)->vec3f {
 let p=clamp(vec4f((nu+1.0)*3.5,(mus+1.0)*7.5,(sign(mu)*sqrt(abs(mu))+1.0)*15.5,sqrt(clamp((r-R)/100.0,0.0,1.0))*7.0),vec4f(0),vec4f(7,15,31,7));
 let low=vec4i(floor(p));let f=fract(p);var result=vec3f(0);
 for(var i=0u;i<16u;i++){let bits=vec4i(vec4u(i&1u,(i>>1u)&1u,(i>>2u)&1u,(i>>3u)&1u));let q=min(low+bits,vec4i(7,15,31,7));let weight=select(vec4f(1)-f,f,bits==vec4i(1));result+=textureLoad(t,vec2i(q.y*8+q.x,q.w*32+q.z),0).rgb*weight.x*weight.y*weight.z*weight.w;}return result;
}
fn directions(c:vec4f)->mat2x3f{
 let w=vec3f(sqrt(max(0.0,1.0-c.y*c.y)),c.y,0);let sx=clamp((c.w-c.y*c.z)/max(w.x,0.00001),-sqrt(max(0.0,1.0-c.z*c.z)),sqrt(max(0.0,1.0-c.z*c.z)));
 return mat2x3f(w,vec3f(sx,c.z,sqrt(max(0.0,1.0-c.z*c.z-sx*sx))));
}`,K=Ce+W+we+G,We=G.slice(G.indexOf(`fn lookup(`),G.indexOf(`fn directions(`)).replace(`fn lookup(t:texture_2d<f32>,`,`fn lookupRow(t:texture_2d<f32>,row:i32,`).replace(`q.w*32+q.z`,`row+q.w*32+q.z`)+`fn singleIn(t:texture_2d<f32>,r:f32,mu:f32,mus:f32,nu:f32)->vec3f {return lookupRow(t,256,r,mu,mus,nu)*phaseR(nu)+lookupRow(t,512,r,mu,mus,nu)*phaseM(nu);}
`;function q(e,t){let n=e.slice(K.length);if(!e.startsWith(K)||!n.includes(t))throw g(`state`,`Sky bruneton: a table pass no longer contains ${t}; update firstOrder to match it`);return K+We+n.replace(t,t.replace(`lookup(`,`singleIn(`))}var Ge=K+`
@group(0) @binding(1) var transmission:texture_2d<f32>;
@group(0) @binding(2) var output:texture_storage_2d<rgba16float,write>;
@group(0) @binding(3) var total:texture_storage_2d<rgba16float,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
 if(any(id.xy>=vec2u(128,256))){return;}let c=coordinates(id.xy);let basis=directions(c);let w=basis[0];let sun=basis[1];
 let step=boundary(c.x,c.y)/32.0;var throughput=vec3f(1);var rayleigh=vec3f(0);var haze=vec3f(0);
 for(var i=0u;i<32u;i++){let p=vec3f(0,c.x,0)+w*((f32(i)+0.5)*step);let r=length(p);let rho=densities(r);let absorb=exp(-extinction(r)*step);
  let light=throughput*sqrt(absorb)*trans(transmission,r,dot(p/r,sun))*step*20.0;rayleigh+=light*BETA_R*rho.x;haze+=light*vec3f(mie()*rho.y);throughput*=absorb;
 }let q=vec2i(id.xy);textureStore(output,q+vec2i(0,256),vec4f(rayleigh,1));textureStore(output,q+vec2i(0,512),vec4f(haze,1));textureStore(total,q,vec4f(0,0,0,1));
}`,Ke=K+`
@group(0) @binding(1) var previous:texture_2d<f32>;
@group(0) @binding(2) var output:texture_storage_2d<rgba16float,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
 if(any(id.xy>=vec2u(128,256))){return;}let c=coordinates(id.xy);let basis=directions(c);let w=basis[0];let sun=basis[1];let rho=densities(c.x);var result=vec3f(0);
 for(var i=0u;i<32u;i++){let y=1.0-2.0*(f32(i)+0.5)/32.0;let angle=f32(i)*2.39996323;let radial=sqrt(1.0-y*y);let direction=vec3f(cos(angle)*radial,y,sin(angle)*radial);let nu=dot(w,direction);
  result+=lookup(previous,c.x,y,c.z,dot(direction,sun))*(BETA_R*rho.x*phaseR(nu)+vec3f(mie()*rho.y*phaseM(nu)))*(12.5663706/32.0);
 }textureStore(output,vec2i(id.xy),vec4f(result,1));
}`,qe=`lookup(previous,c.x,y,c.z,dot(direction,sun))`,Je=K+`
@group(0) @binding(1) var input:texture_2d<f32>;
@group(0) @binding(2) var output:texture_storage_2d<rgba16float,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
 if(any(id.xy>=vec2u(128,256))){return;}let c=coordinates(id.xy);let basis=directions(c);let w=basis[0];let sun=basis[1];let step=boundary(c.x,c.y)/32.0;var result=vec3f(0);var throughput=vec3f(1);
 for(var i=0u;i<32u;i++){let p=vec3f(0,c.x,0)+w*((f32(i)+0.5)*step);let r=length(p);let absorb=exp(-extinction(r)*step);
  result+=throughput*sqrt(absorb)*lookup(input,r,dot(p/r,w),dot(p/r,sun),dot(w,sun))*step;throughput*=absorb;
 }textureStore(output,vec2i(id.xy),vec4f(result,1));
}`,J=K+`
@group(0) @binding(1) var transmission:texture_2d<f32>;
@group(0) @binding(2) var radiance:texture_2d<f32>;
@group(0) @binding(3) var output:texture_storage_2d<rgba16float,write>;
@compute @workgroup_size(64) fn direct(@builtin(global_invocation_id) id:vec3u){
 if(id.x>=64u){return;}let mus=f32(id.x)/63.0*2.0-1.0;
 textureStore(output,vec2i(i32(id.x),0),vec4f(20.0*trans(transmission,R+0.001,mus)*max(mus,0.0),1));
}
@compute @workgroup_size(64) fn indirect(@builtin(global_invocation_id) id:vec3u){
 if(id.x>=64u){return;}let mus=f32(id.x)/63.0*2.0-1.0;let sun=vec3f(sqrt(max(0.0,1.0-mus*mus)),mus,0);var result=vec3f(0);
 for(var i=0u;i<32u;i++){let y=(f32(i)+0.5)/32.0;let angle=f32(i)*2.39996323;let radial=sqrt(1.0-y*y);let direction=vec3f(cos(angle)*radial,y,sin(angle)*radial);
  result+=lookup(radiance,R+0.001,y,mus,dot(direction,sun))*y*(6.2831853/32.0);
 }textureStore(output,vec2i(i32(id.x),0),vec4f(result,1));
}`,Ye=K+`
@group(0) @binding(1) var previous:texture_2d<f32>;
@group(0) @binding(2) var output:texture_storage_2d<rgba16float,write>;
@group(0) @binding(3) var transmission:texture_2d<f32>;
@group(0) @binding(4) var irradiance:texture_2d<f32>;
@group(0) @binding(5) var<uniform> albedo:vec4f;
fn groundIrradiance(mus:f32)->vec3f {let x=clamp((mus+1.0)*31.5,0.0,63.0);let i=i32(floor(x));let j=min(i+1,63);
 return mix(textureLoad(irradiance,vec2i(i,0),0).rgb,textureLoad(irradiance,vec2i(j,0),0).rgb,x-floor(x));}
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
 if(any(id.xy>=vec2u(128,256))){return;}let c=coordinates(id.xy);let basis=directions(c);let w=basis[0];let sun=basis[1];let rho=densities(c.x);var result=vec3f(0);
 for(var i=0u;i<32u;i++){let y=1.0-2.0*(f32(i)+0.5)/32.0;let angle=f32(i)*2.39996323;let radial=sqrt(1.0-y*y);let direction=vec3f(cos(angle)*radial,y,sin(angle)*radial);let nu=dot(w,direction);
  var light=lookup(previous,c.x,y,c.z,dot(direction,sun));
  if(ground(c.x,y)){let g=vec3f(0,c.x,0)+direction*boundary(c.x,y);let n=normalize(g);
   let path=min(trans(transmission,R,dot(n,-direction))/max(trans(transmission,c.x,-y),vec3f(1e-6)),vec3f(1));
   light+=albedo.rgb*0.3183098862*groundIrradiance(dot(n,sun))*path;}
  result+=light*(BETA_R*rho.x*phaseR(nu)+vec3f(mie()*rho.y*phaseM(nu)))*(12.5663706/32.0);
 }textureStore(output,vec2i(id.xy),vec4f(result,1));
}`,Xe=`
@group(0) @binding(0) var total:texture_2d<f32>;
@group(0) @binding(1) var delta:texture_2d<f32>;
@group(0) @binding(2) var output:texture_storage_2d<rgba16float,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){if(any(id.xy>=vec2u(128,256))){return;}let p=vec2i(id.xy);textureStore(output,p,textureLoad(total,p,0)+textureLoad(delta,p,0));}`,Ze={phase:W,tail:G,sky:We+W.slice(W.indexOf(`fn phaseM(`)).replace(`fn phaseM(`,`fn phaseSky(`).replace(`let g=0.8;`,`let g=frame.clouds.w;`)+`fn brunetonSky(t:texture_2d<f32>,r:f32,mu:f32,mus:f32,nu:f32)->vec3f {return lookup(t,r,mu,mus,nu)+lookupRow(t,256,r,mu,mus,nu)*phaseR(nu)+lookupRow(t,512,r,mu,mus,nu)*phaseSky(nu);}
`,create(e,t,n,i,s){let c=e=>s?s(e):e,l=t,u=Array.from({length:5},(t,n)=>{let r=e.createTexture({size:[128,n===3?768:256],format:`rgba16float`,usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.STORAGE_BINDING});return i.push(r),r}).map(e=>e.createView()),d,f,p,m,h,g=[],_=()=>{[d,f,p,m,h]=[c(Ge),c(Ke),c(q(Ke,qe)),c(Je),Xe].map(t=>a(e,t)),g.length=0,g.push(o(e,d,[l,n,u[3],u[2]]));for(let t=0;t<3;t++){let n=t%2,r=1-n;g.push(t?o(e,f,[l,u[n],u[4]]):o(e,p,[l,u[3],u[4]]),o(e,m,[l,u[4],u[r]]),o(e,h,[u[2+n],u[r],u[2+r]]))}};_();let v,y,b=new Float32Array(4),x=()=>{if(!y){let t=e.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});i.push(t);let n=e.createTexture({size:[64,1],format:`rgba16float`,usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.STORAGE_BINDING});i.push(n),y={buffer:t,e:n.createView()}}let{buffer:t,e:r}=y,s=a(e,c(J),`direct`),d=a(e,c(J),`indirect`),f=e.createBindGroupLayout({entries:[{binding:0,visibility:4,buffer:{type:`uniform`}},{binding:2,visibility:4,texture:{sampleType:`unfilterable-float`}},{binding:3,visibility:4,storageTexture:{access:`write-only`,format:`rgba16float`}}]}),p=e.createComputePipeline({layout:e.createPipelineLayout({bindGroupLayouts:[f]}),compute:{module:e.createShaderModule({code:c(q(J,`lookup(radiance,`))}),entryPoint:`indirect`}}),m=a(e,c(Ye)),h=a(e,c(q(Ye,qe))),g=(t,n)=>e.createBindGroup({layout:t.getBindGroupLayout(0),entries:n.map(([e,t])=>({binding:e,resource:t}))});v={buffer:t,passes:[[s,g(s,[[1,n],[3,r]]),h,o(e,h,[l,u[3],u[4],n,r,{buffer:t}])],[p,g(p,[[0,l],[2,u[3]],[3,r]]),m,o(e,m,[l,u[1],u[4],n,r,{buffer:t}])],[d,g(d,[[2,u[1]],[3,r]]),m,o(e,m,[l,u[0],u[4],n,r,{buffer:t}])]]}};return{view:u[3],recode(e,t){c=t=>e?e(t):t,l=t,_(),v=void 0},run(e,t){let n=!!t&&(t[0]>0||t[1]>0||t[2]>0);n&&(v||x(),b.set(t),e.device.queue.writeBuffer(v.buffer,0,b)),r(e,d,g[0],16,32);for(let t=0;t<3;t++){if(n){let[n,i,a,o]=v.passes[t];r(e,n,i,1),r(e,a,o,16,32)}else r(e,t?f:p,g[1+t*3],16,32);r(e,m,g[2+t*3],16,32),r(e,h,g[3+t*3],16,32)}}}}},Qe=`

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
`,$e=2.2,et=.12,tt=Math.sqrt(3/5)/2,nt=(()=>{let e=[];for(let[t,n]of[[.5-tt,5/18],[.5,8/18],[.5+tt,5/18]]){let r=Math.sqrt(1-t),i=Math.sqrt(t);for(let t=0;t<=4;t++){let a=t*Math.PI/4;e.push([i*Math.cos(a),r,i*Math.sin(a),n*(t===0||t===4?1:2)/8])}}return e})(),Y=e=>e.toFixed(7),rt=`
fn deckUnits()->f32 {
 if(frame.settings.x<0.5){return 1.0;}
 let r=R+clamp(frame.eye.w,0.001,99.9);let step=(TOP-r)/64.0;var optical=vec3f(0);
 for(var i=0u;i<64u;i++){optical+=extinction(r+(f32(i)+0.5)*step)*step;}
 return 20.0*dot(exp(-optical),vec3f(0.2126,0.7152,0.0722))/${Y(4*Math.PI*.55)};
}
fn clearSkyLevel()->vec3f {
 let s=frame.sun.xyz;let flat=length(s.xz);var a=vec2f(1,0);if(flat>0.0001){a=s.xz/flat;}
 var sum=vec3f(0);
${nt.map(([e,t,n,r])=>` sum+=${Y(r)}*daySky(vec3f(${Y(e)}*a.x-${Y(n)}*a.y,${Y(t)},${Y(e)}*a.y+${Y(n)}*a.x));`).join(`
`)}
 return sum;
}

fn overcastLight(day:f32)->vec3f {
 let T=max(frame.moonColor.w,0.0);if(T<=0.0){return vec3f(0);}
 return (frame.sunlight.rgb*(${$e.toFixed(6)}*max(frame.sun.y,0.0))+clearSkyLevel()*(day/deckUnits()))*T;
}
`,it={field:Qe,wgsl:`${Qe}
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

${rt}
fn cloudDeck(ray:vec3f,p:vec2f,footprint:f32,haze:f32)->vec3f {
 let T=max(frame.moonColor.w,0.0);
 let zenith=overcastLight(1.0-clamp(frame.sun.w,0.0,1.0))*${(9/7).toFixed(6)};
 let grade=(1.0+2.0*max(ray.y,0.0))/3.0;
 let shade=1.0+${et.toFixed(3)}*(2.0*cloudOctaves(p,footprint,0u,4u)-1.0)*haze;
 let moon=frame.moonColor.rgb*frame.moon.w*0.15*T;
 return (zenith*shade+moon)*grade+vec3f(0.006,0.01,0.02)*T;
}
`}`,validate(e){if(typeof e!=`object`||!e||!Number.isFinite(e.coverage??.45)||(e.coverage??.45)<0||(e.coverage??.45)>1||!Number.isFinite(e.speed??8)||Math.abs(e.speed??8)>100||!Number.isFinite(e.height??1500)||(e.height??1500)<100||(e.height??1500)>1e4||!Number.isFinite(e.depth??20)||(e.depth??20)<1||(e.depth??20)>200)throw RangeError(`Invalid sky clouds; keep coverage from 0 to 1, speed within ±100, height from 100 to 10000 and depth from 1 to 200.`)}},at=[6.4,7.6,9.6],ot={wgsl:`


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
`,validate(e){if(e){for(let t of[e.zenithColor,e.horizonColor,e.moonColor])if(t!==void 0&&(m(t,3,`Sky color`),t.some(e=>e<0)))throw RangeError(`Sky colors must be non-negative`);if(e.moonLitBySun!==void 0&&typeof e.moonLitBySun!=`boolean`)throw TypeError(`Sky night moonLitBySun must be true or false`);if(e.moonDirection!==void 0&&(m(e.moonDirection,3,`Moon direction`),!Math.hypot(...e.moonDirection)))throw RangeError(`Moon direction must be nonzero`);e.moonPhase!==void 0&&E(e.moonPhase);for(let t of[e.moonSize,e.glowIntensity,e.starIntensity,e.starTwinkleIntensity,e.hazeDensity])if(t!==void 0&&!Number.isFinite(Math.fround(t)))throw RangeError(`Sky parameters must be finite Float32 numbers`);if(e.moonSize!==void 0&&!(Math.fround(e.moonSize)>0&&Math.fround(e.moonSize)<Math.PI/2))throw RangeError(`Moon size must be between 0 and PI / 2`)}},write(e,t,n){let r=t.moonDirection??[.4,.7,.5],i=Math.hypot(r[0],r[1],r[2]),a=t.moonSize??.038;e.set(t.zenithColor??[.015,.025,.065],40),e[43]=Math.max(0,t.starTwinkleIntensity??1),e.set(t.horizonColor??[.08,.09,.15],44),e[47]=Math.max(0,t.hazeDensity??1);for(let t=0;t<3;t++)e[48+t]=r[t]/i;e[51]=Math.cos(a),e.set(t.moonColor??at,52),e[55]=Math.sin(a),e[56]=E(t.moonPhase??.85),e[57]=Math.max(0,t.glowIntensity??1.2),e[58]=Math.max(0,t.starIntensity??.8),e[59]=n,t.moonLitBySun?e[63]=2:t.moonPhase!==void 0&&ne(t.moonPhase)&&(e[63]=3)}},st=`
@group(0) @binding(3) var sceneDepth:texture_depth_2d;
@group(0) @binding(4) var<uniform> fog:array<vec4f,2>;
@fragment fn fogFragment(i:Vertex)->@location(0) vec4f {
 let d=textureLoad(sceneDepth,vec2i(i.position.xy),0);if(d<=0.0){discard;}
 let p=frame.inverse*vec4f(i.uv*vec2f(2,-2)+vec2f(-1,1),d,1);let world=p.xyz/p.w;let offset=world-frame.eye.xyz;
 let distance=length(offset);let optical=max(0.0,distance-fog[0].y)*fog[0].x*(1.0+max(-world.y,0.0)*fog[0].w);if(optical<=0.0){discard;}
 let opacity=1.0-exp(-select(optical*optical,optical,fog[0].z>0.5));


 let ray=offset/max(distance,0.0001);var color=fog[1].rgb;if(fog[1].w<0.5){color=skyRadiance(normalize(vec3f(ray.x,max(0.0001,ray.y),ray.z)),0.0);
 if(frame.moonColor.w>0.0&&frame.clouds.x>0.0){let under=(overcastLight(1.0)*(${(9/7).toFixed(6)}*(1.0+2.0*max(ray.y,0.0))/3.0)+vec3f(0.006,0.01,0.02)*frame.moonColor.w)*(1.0-clamp(frame.sun.w,0.0,1.0));color=mix(color,under,clamp(frame.clouds.x,0.0,1.0));}
 color=color*exp2(frame.settings.y);}
 if(frame.settings.w<0.5&&frame.sunlight.w<0.5){color=toDisplay(color);}return vec4f(color,opacity);
}`,ct={validate(e){if(e?.color&&m(e.color,3,`Fog color`),typeof e!=`object`||!e||e.depth!==void 0&&typeof e.depth!=`function`||e.falloff!==void 0&&e.falloff!==`exp`&&e.falloff!==`exp2`||!(Math.fround(e.height??0)>=0)||!Number.isFinite(Math.fround(e.height??0))||!Number.isFinite(Math.fround(e.density??.01))||(e.density??.01)<0||(e.density??.01)>1||!Number.isFinite(Math.fround(e.start??40))||(e.start??40)<0)throw RangeError(`Invalid sky fog; give an optional depth function, falloff "exp" or "exp2", height and start of 0 or more, and density from 0 to 1.`)},create(e){let t=e+(e.includes(`fn overcastLight(`)?``:rt)+st,n=new Float32Array(8),r={view:void 0,loadOp:`load`,storeOp:`store`},i={colorAttachments:[r]},a,o=[],s=[],l,u=``;return{draw(e,d,f){let p=S(e),m=d.depth?d.depth():p?.resolvedDepth;if(!m||(d.density??.01)===0)return;let h=e.descriptor.multisample?.count??1;if(!m.format.startsWith(`depth`)||m.dimension!==`2d`||m.depthOrArrayLayers!==1||m.width!==e.width||m.height!==e.height||!(m.usage&GPUTextureUsage.TEXTURE_BINDING)||m.sampleCount!==1&&m.sampleCount!==h)throw RangeError(`Sky fog requires matching sampleable scene depth`);let g=p?.samples===4&&p.resolvedDepth===m?p.depthSource:void 0,_=g?4:m.sampleCount,v=e.format+`:`+h+`:`+_;if(a??=e.device.createBuffer({size:32,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),u!==v&&(o=(_===1?[null]:C(e.device,h)).map(n=>{let r=_===1?t:n===null?t.replace(`sceneDepth:texture_depth_2d`,`sceneDepth:texture_depth_multisampled_2d`).replace(`fogFragment(i:Vertex)`,`fogFragment(i:Vertex,@builtin(sample_index) sample:u32)`).replace(`vec2i(i.position.xy),0`,`vec2i(i.position.xy),i32(sample)`):t.replace(`sceneDepth:texture_depth_2d`,`sceneDepth:texture_depth_multisampled_2d`).replace(`vec2i(i.position.xy),0`,`vec2i(i.position.xy),${n}`),i=e.device.createShaderModule({code:r});return e.device.createRenderPipeline({layout:`auto`,vertex:{module:i,entryPoint:`vertex`},fragment:{module:i,entryPoint:`fogFragment`,targets:[{format:e.format,blend:{color:{srcFactor:`src-alpha`,dstFactor:`one-minus-src-alpha`,operation:`add`},alpha:{srcFactor:`zero`,dstFactor:`one`,operation:`add`}}}]},multisample:n===null?e.descriptor.multisample:{count:h,mask:1<<n}})}),u=v,l=void 0),l!==(g??m)){let t=g??m.createView({aspect:`depth-only`});s=o.map(n=>e.device.createBindGroup({layout:n.getBindGroupLayout(0),entries:[...f,{binding:3,resource:t},{binding:4,resource:{buffer:a}}]})),l=g??m}n[0]=d.density??.01,n[1]=d.start??40,n[2]=+(d.falloff===`exp`),n[3]=d.height??0,n.set(d.color??[0,0,0],4),n[7]=+!!d.color,e.device.queue.writeBuffer(a,0,n),r.view=e.color;let y=e.encoder.beginRenderPass(i);c(y,e);for(let e=0;e<o.length;e++)y.setPipeline(o[e]),y.setBindGroup(0,s[e]),y.draw(3);y.end()},release(){a?.destroy()}}}},X=`


fn skyEnvironment(w:vec3f,footprint:f32)->vec3f {
 let ray=normalize(vec3f(w.x,max(0.001,w.y),w.z));var color=daySky(ray);
 color=mix(vec3f(0.015,0.018,0.012),color,smoothstep(-0.2,0.02,w.y));
 color=mix(color,nightSky(w,footprint),frame.sun.w);
 let sky=color;color+=frame.moonColor.rgb*frame.moon.w*moonRadiance(w,frame.moon.xyz,footprint)*f32(frame.sunlight.w<0.5);
 return cloudSky(color,sky,w,footprint)*exp2(frame.settings.y);
}

fn environmentDirection(uv:vec2f)->vec3f {
 let phi=(uv.x-0.5)*6.2831853;let theta=uv.y*3.14159265;return vec3f(sin(theta)*cos(phi),cos(theta),sin(theta)*sin(phi));
}
`,lt=`
@group(0) @binding(4) var environmentLayer:texture_2d<f32>;
fn layered(sky:vec3f,texel:vec2u)->vec3f {
 let layer=textureLoad(environmentLayer,vec2i(texel),0);return sky*(1.0-layer.a)+layer.rgb;
}
`,ut=`
@group(0) @binding(3) var reflectionMap:texture_storage_2d<rgba16float,write>;
@compute @workgroup_size(8,8) fn reflectSky(@builtin(global_invocation_id) id:vec3u){
 if(any(id.xy>=vec2u(64,32))){return;}

 textureStore(reflectionMap,vec2i(id.xy),vec4f(skyEnvironment(environmentDirection((vec2f(id.xy)+0.5)/vec2f(64,32)),0.1),1));
}`,dt=`${lt}
@group(0) @binding(3) var reflectionMap:texture_storage_2d<rgba16float,write>;
@compute @workgroup_size(8,8) fn reflectSky(@builtin(global_invocation_id) id:vec3u){
 if(any(id.xy>=vec2u(64,32))){return;}
 textureStore(reflectionMap,vec2i(id.xy),vec4f(layered(skyEnvironment(environmentDirection((vec2f(id.xy)+0.5)/vec2f(64,32)),0.1),id.xy),1));
}`,ft={create(e,t,n,r){let i={},o,s,c=()=>{if(o)return o;let t=e.createTexture({size:[64,32],format:`rgba16float`,usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.STORAGE_BINDING});return r.push(t),o={texture:t,...l(t)}},l=r=>{let i=a(e,t+X+ut,`reflectSky`);return{pipeline:i,group:e.createBindGroup({layout:i.getBindGroupLayout(0),entries:[...n,{binding:3,resource:r.createView()}]})}};return{get texture(){return c().texture},recode(e,r){t=e,n=r,o&&={texture:o.texture,...l(o.texture)},s=void 0},run(r,o){let{pipeline:l,group:u,texture:d}=c();o&&(s??={pipeline:a(e,t+`


fn skyEnvironment(w:vec3f,footprint:f32)->vec3f {
 let ray=normalize(vec3f(w.x,max(0.001,w.y),w.z));var color=daySky(ray);
 color=mix(vec3f(0.015,0.018,0.012),color,smoothstep(-0.2,0.02,w.y));
 color=mix(color,nightSky(w,footprint),frame.sun.w);
 let sky=color;color+=frame.moonColor.rgb*frame.moon.w*moonRadiance(w,frame.moon.xyz,footprint)*f32(frame.sunlight.w<0.5);
 return cloudSky(color,sky,w,footprint)*exp2(frame.settings.y);
}

fn environmentDirection(uv:vec2f)->vec3f {
 let phi=(uv.x-0.5)*6.2831853;let theta=uv.y*3.14159265;return vec3f(sin(theta)*cos(phi),cos(theta),sin(theta)*sin(phi));
}
`+dt,`reflectSky`)},s.layer!==o&&(s.group=e.createBindGroup({layout:s.pipeline.getBindGroupLayout(0),entries:[...n,{binding:3,resource:d.createView()},{binding:4,resource:o.createView()}]})),s.layer=o,l=s.pipeline,u=s.group);let f=r.encoder.beginComputePass(i);f.setPipeline(l),f.setBindGroup(0,u),f.dispatchWorkgroups(8,4),f.end()}}}},pt=`
@group(0) @binding(0) var level:texture_2d<f32>;
@group(0) @binding(1) var<storage,read_write> light:array<vec4f,11>;
var<workgroup> sums:array<array<vec3f,10>,64>;
@compute @workgroup_size(64) fn main(@builtin(local_invocation_index) t:u32){
 var c=array<vec3f,10>();
 let ground=light[10].w>0.0;
 for(var k=t;k<512u;k+=64u){
  let x=k%32u;let y=k/32u;let phi=((f32(x)+0.5)/32.0-0.5)*6.2831853;let theta=(f32(y)+0.5)/16.0*3.14159265;
  let w=vec3f(sin(theta)*cos(phi),cos(theta),sin(theta)*sin(phi));

  let l=select(textureLoad(level,vec2i(i32(x),i32(y)),0).rgb*sin(theta)*0.0385531,vec3f(0),ground&&w.y<0.0);
  c[0]+=l;c[1]+=l*w.y;c[2]+=l*w.z;c[3]+=l*w.x;c[4]+=l*(w.x*w.y);c[5]+=l*(w.y*w.z);c[6]+=l*(3.0*w.z*w.z-1.0);c[7]+=l*(w.x*w.z);c[8]+=l*(w.x*w.x-w.y*w.y);
  c[9]+=l*max(w.y,0.0);
 }
 sums[t]=c;
 for(var s=32u;s>0u;s=s>>1u){workgroupBarrier();if(t<s){for(var i=0u;i<10u;i++){sums[t][i]+=sums[t+s][i];}}}
 workgroupBarrier();
 var scale=array<f32,9>(0.0795775,0.1591549,0.1591549,0.1591549,0.2984155,0.2984155,0.0248680,0.2984155,0.0746039);
 let lg=select(vec3f(0),light[10].w*(sums[0][9]/3.14159265+light[10].rgb),ground);
 var add=array<vec3f,9>(lg*6.2831853,-lg*3.14159265,vec3f(0),vec3f(0),vec3f(0),vec3f(0),vec3f(0),vec3f(0),vec3f(0));
 if(t<9u){light[t]=vec4f((sums[0][t]+add[t])*scale[t],0);}
}`,mt=`
@group(0) @binding(3) var lightTarget:texture_storage_2d<rgba16float,write>;
@compute @workgroup_size(8,8) fn renderLight(@builtin(global_invocation_id) id:vec3u){
 if(any(id.xy>=vec2u(64,32))){return;}
 textureStore(lightTarget,vec2i(id.xy),vec4f(skyEnvironment(environmentDirection((vec2f(id.xy)+0.5)/vec2f(64,32)),0.1),1));
}`,ht=`${lt}
@group(0) @binding(3) var lightTarget:texture_storage_2d<rgba16float,write>;
@compute @workgroup_size(8,8) fn renderLight(@builtin(global_invocation_id) id:vec3u){
 if(any(id.xy>=vec2u(64,32))){return;}
 textureStore(lightTarget,vec2i(id.xy),vec4f(layered(skyEnvironment(environmentDirection((vec2f(id.xy)+0.5)/vec2f(64,32)),0.1),id.xy),1));
}`,gt=`
@group(0) @binding(0) var finer:texture_2d<f32>;
@group(0) @binding(1) var coarser:texture_storage_2d<rgba16float,write>;
@compute @workgroup_size(8,4) fn main(@builtin(global_invocation_id) id:vec3u){
 if(any(id.xy>=textureDimensions(coarser))){return;}let p=vec2i(id.xy)*2;
 textureStore(coarser,vec2i(id.xy),(textureLoad(finer,p,0)+textureLoad(finer,p+vec2i(1,0),0)+textureLoad(finer,p+vec2i(0,1),0)+textureLoad(finer,p+vec2i(1),0))*0.25);
}`,_t=`@group(0) @binding(8) var<uniform> skyLight:array<vec4f,10>;
@group(0) @binding(10) var skyLightMap:texture_2d<f32>;
@group(0) @binding(11) var skyLightSampler:sampler;


fn skyIrradiance(n:vec3f)->vec3f {
 return max((skyLight[0].rgb+skyLight[1].rgb*n.y+skyLight[2].rgb*n.z+skyLight[3].rgb*n.x+skyLight[4].rgb*(n.x*n.y)+skyLight[5].rgb*(n.y*n.z)+skyLight[6].rgb*(3.0*n.z*n.z-1.0)+skyLight[7].rgb*(n.x*n.z)+skyLight[8].rgb*(n.x*n.x-n.y*n.y))*skyLight[9].w,skyLight[9].rgb);
}


fn skyRadiance(r:vec3f,rough:f32)->vec3f {
 let uv=vec2f(atan2(r.z,r.x)/6.2831853+0.5,acos(clamp(r.y,-1.0,1.0))/3.14159265);
 return textureSampleLevel(skyLightMap,skyLightSampler,uv,rough*3.0).rgb*skyLight[9].w;
}


fn skyLighting(n:vec3f,v:vec3f,base:vec3f,metal:f32,roughness:f32,dielectricF0:vec3f,dielectricF90:f32)->vec3f {
 let rough=clamp(roughness,0.0,1.0);let nv=clamp(dot(n,v),0.0001,1.0);let r=reflect(-v,n);
 let k=rough*vec4f(-1.0,-0.0275,-0.572,0.022)+vec4f(1.0,0.0425,1.04,-0.04);
 let a=min(k.x*k.x,exp2(-9.28*nv))*k.x+k.y;let ab=vec2f(-1.04,1.04)*a+k.zw;
 let specular=mix(dielectricF0,base,metal)*ab.x+mix(dielectricF90,1.0,metal)*ab.y;
 let uv=vec2f(atan2(r.z,r.x)/6.2831853+0.5,acos(clamp(r.y,-1.0,1.0))/3.14159265);
 return (vec3f(1.0)-specular)*(1.0-metal)*base*skyIrradiance(n)+textureSampleLevel(skyLightMap,skyLightSampler,uv,rough*3.0).rgb*skyLight[9].w*specular;
}
`,vt={validate(e){if(typeof e!=`object`||!e||!Number.isFinite(Math.fround(e.intensity??1))||(e.intensity??1)<0||!Number.isFinite(Math.fround(e.minimum??0))||(e.minimum??0)<0||!((e.ground??.2)>=0&&(e.ground??.2)<=1))throw RangeError(`Invalid sky lighting options; set intensity and minimum to finite numbers of 0 or more and ground to an albedo from 0 to 1, or leave them out.`);if(e.moon!==void 0&&(typeof e.moon!=`object`||e.moon===null||!Number.isFinite(Math.fround(e.moon.intensity??0))||(e.moon.intensity??0)<0||!((e.moon.extinction??0)>=0&&(e.moon.extinction??0)<=2)||!(typeof e.moon.brightness==`string`?e.moon.brightness===`bright`||e.moon.brightness===`dim`:(e.moon.brightness??1)>=0&&(e.moon.brightness??1)<=1e4)||typeof e.moon.color==`string`&&e.moon.color!==`blood`&&e.moon.color!==`reddened`||!((e.moon.cloudCover??0)>=0&&(e.moon.cloudCover??0)<=1))||e.ambient!==void 0&&(typeof e.ambient!=`object`||e.ambient===null))throw RangeError(`Invalid sky night options; give moon and ambient as objects, with a finite moon intensity of 0 or more, a moon extinction from 0 to 2, a moon brightness from 0 to 10000 or 'bright' or 'dim', a moon color of linear RGB or 'blood' or 'reddened', and a moon cloudCover from 0 to 1.`);for(let t of[e.color,e.sunset,typeof e.moon?.color==`string`?void 0:e.moon?.color,e.ambient?.day,e.ambient?.night])if(t!==void 0&&(m(t,3,`Sky color`),t.some(e=>e<0)))throw RangeError(`Invalid sky color; use non-negative RGB components.`);let t=e.twilight;if(t!==void 0&&t!==!1&&(typeof t!=`object`||!t||!((t.brightness??1)>=0&&(t.brightness??1)<=1e4)||!((t.cloudCover??0)>=0&&(t.cloudCover??0)<=1)))throw RangeError(`Invalid sky twilight; give false or an object with a brightness from 0 to 10000 and a cloudCover from 0 to 1.`);if(t&&t.color!==void 0&&(m(t.color,3,`Sky twilight color`),t.color.some(e=>e<0)))throw RangeError(`Invalid sky color; use non-negative RGB components.`);if(e.ambient&&(!e.ambient.day||!e.ambient.night))throw RangeError(`Invalid sky ambient colors; give both ambient.day and ambient.night.`)},create(e,t,n,r){let i=new Float32Array(8),s={},c=[8,4,4,4,2,2,1,1,1,1],l=``,u=``,d=()=>{let i=e.createBuffer({size:176,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST}),s=e.createTexture({size:[64,32],format:`rgba16float`,mipLevelCount:4,usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.STORAGE_BINDING});r.push(i,s);let c=e=>s.createView({baseMipLevel:e,mipLevelCount:1}),l=a(e,t+X+mt,`renderLight`),u=c(0),d=a(e,gt),f=a(e,pt),p=[l,d,d,d,f],m=[e.createBindGroup({layout:l.getBindGroupLayout(0),entries:[...n,{binding:3,resource:u}]}),o(e,d,[u,c(1)]),o(e,d,[c(1),c(2)]),o(e,d,[c(2),c(3)]),o(e,f,[c(1),{buffer:i}])];return y(e,()=>h(()=>import(`./compat-m3-a1H1g-DYHnayGp.js`),[],import.meta.url))?.then(({projectRoute:t})=>{let n=a(e,t);p[4]=n,m[4]=o(e,n,[c(1),{buffer:i}])}),{buffer:i,top:u,pipelines:p,groups:m,bindings:[{binding:8,resource:{buffer:i,offset:0,size:160}},{binding:10,resource:s.createView()},{binding:11,resource:e.createSampler({addressModeU:`repeat`,addressModeV:`clamp-to-edge`,magFilter:`linear`,minFilter:`linear`,mipmapFilter:`linear`})}]}},f,m,g=new Map;return{pbr(e){if(!f)return;let t=g.get(e);return t||(t={declarations:_t.replaceAll(`@group(0)`,`@group(${e})`),ambient:`skyLighting(s.n,v,s.base.rgb,s.metal,s.roughness,s.f0,s.sw)*s.occlusion`},g.set(e,t)),t},bindings(){return f?.bindings??[]},recode(r,i){if(t=r,n=i,m=void 0,!f)return;let o=a(e,t+X+mt,`renderLight`);f.pipelines[0]=o,f.groups[0]=e.createBindGroup({layout:o.getBindGroupLayout(0),entries:[...n,{binding:3,resource:f.top}]})},update({direction:e,radiance:t},n,r,a,o,s){if(i[3]=s,a)for(let e=0;e<3;e++)i[e]=a.day[e]*(1-o)+a.night[e]*o;if(i[4]=i[5]=i[6]=0,i[7]=r?.ground??.2,!r)return;let c=n.lights[0],l=n.lights[1],u=n.twilightLight,d=n.moonUnderClouds,f=e=>.2126*e[0]+.7152*e[1]+.0722*e[2],p=c.direction,m=u.direction,h=p[3]*f(c.radiance),g=m[3]*f(u.radiance);if(r.moon&&l.direction[3]>p[3]&&d.direction[3]*f(d.radiance)>=g){for(let n=0;n<3;n++)e[n]=d.direction[n],t[n]=d.radiance[n];e[3]=Math.max(r.minimum??0,d.direction[3])}else if(m[3]===0){for(let n=0;n<3;n++)e[n]=p[n],t[n]=c.radiance[n];e[3]=Math.max(r.minimum??0,p[3])}else{let n=h*p[0]+g*m[0],i=h*p[1]+g*m[1],a=h*p[2]+g*m[2],o=Math.hypot(n,i,a),s=p[3]+m[3];for(let e=0;e<3;e++)t[e]=(p[3]*c.radiance[e]+m[3]*u.radiance[e])/s;e[0]=n/o,e[1]=i/o,e[2]=a/o,e[3]=Math.max(r.minimum??0,o/(f(t)||1))}a&&(t[3]=Math.max(i[0],i[1],i[2]));let _=Math.max(e[1],0)*e[3]/(Math.PI*(s||1));for(let e=0;e<3;e++)i[4+e]=t[e]*_},pass(r,o){let l=f??=d(),u=r.encoder.beginComputePass(s);o&&(m??={pipeline:a(e,t+`


fn skyEnvironment(w:vec3f,footprint:f32)->vec3f {
 let ray=normalize(vec3f(w.x,max(0.001,w.y),w.z));var color=daySky(ray);
 color=mix(vec3f(0.015,0.018,0.012),color,smoothstep(-0.2,0.02,w.y));
 color=mix(color,nightSky(w,footprint),frame.sun.w);
 let sky=color;color+=frame.moonColor.rgb*frame.moon.w*moonRadiance(w,frame.moon.xyz,footprint)*f32(frame.sunlight.w<0.5);
 return cloudSky(color,sky,w,footprint)*exp2(frame.settings.y);
}

fn environmentDirection(uv:vec2f)->vec3f {
 let phi=(uv.x-0.5)*6.2831853;let theta=uv.y*3.14159265;return vec3f(sin(theta)*cos(phi),cos(theta),sin(theta)*sin(phi));
}
`+ht,`renderLight`)},m.layer!==o&&(m.group=e.createBindGroup({layout:m.pipeline.getBindGroupLayout(0),entries:[...n,{binding:3,resource:l.top},{binding:4,resource:o.createView()}]})),m.layer=o);for(let e=0;e<5;e++)u.setPipeline(e===0&&m&&o?m.pipeline:l.pipelines[e]),u.setBindGroup(0,e===0&&m&&o?m.group:l.groups[e]),u.dispatchWorkgroups(c[e*2],c[e*2+1]);u.end(),r.device.queue.writeBuffer(l.buffer,144,i)},patch(e){if(f){if(l!==e.shader){let t=/let linear=([^;]+);/.exec(e.shader);if(!t||!(t[1].includes(`frame.radiance.w`)||t[1].includes(`margoSkyLight(`)))throw new p(`unsupported`,`Sky ambient requires the standard PBR shader; remove the plugin that replaced core's shader`);let n=`let margoAmbient=skyLighting(n,v,i.color,i.material.y,i.material.x,vec3f(0.04),1.0);let linear=${t[1].replace(`frame.radiance.w`,`0.0`)}+margoAmbient;`;l=e.shader,u=_t+e.shader.replace(t[0],()=>n)}e.shader=u,e.bindings.push(...f.bindings)}}}}},yt=[.005802/.0331,.013558/.0331,1],bt=`

fn lookTint(c:vec3f,tint:vec4f,weight:f32)->vec3f {
 let luma=vec3f(0.2126,0.7152,0.0722);let toward=tint.rgb*dot(c,luma)/max(dot(tint.rgb,luma),0.0001);
 return mix(c,toward,clamp(tint.w*weight,0.0,1.0));
}

fn lookSky(w:vec3f,c:vec3f)->vec3f {
 let e=clamp(w.y,-1.0,1.0);var o=c;
 o=lookTint(o,frame.lookZenith,max(e,0.0));
 o=lookTint(o,frame.lookHorizon,pow(1.0-abs(e),4.0));
 o=lookTint(o,frame.lookGround,clamp(-e*8.0,0.0,1.0));
 let n=i32(frame.lookShape.z);
 if(n>=2&&frame.lookShape.y>0.0){
  let a=degrees(asin(e));var g=frame.lookStops[0].rgb;
  for(var i=1;i<n;i++){let p=frame.lookStops[i-1];let q=frame.lookStops[i];if(a>p.w){g=mix(p.rgb,q.rgb,clamp((a-p.w)/max(q.w-p.w,0.001),0.0,1.0));}}
  o=mix(o,g,frame.lookShape.y);
 }
 let width=frame.lookGlow.w;let band=select(exp(e*4.0/width),exp(-e/width),e>=0.0);
 let h=w.xz;let sh=frame.sun.xz;
 let toward=select(1.0,0.5+0.5*dot(normalize(h),normalize(sh)),length(h)>0.0001&&length(sh)>0.0001);
 return o+frame.lookGlow.rgb*band*mix(1.0,toward,frame.lookShape.x);
}

fn daySky(direction:vec3f)->vec3f {return lookSky(direction,physicalDaySky(direction)*frame.air2.rgb+frame.air3.rgb);}
fn nightSky(w:vec3f,footprint:f32)->vec3f {return lookSky(w,physicalNightSky(w,footprint));}
`;function Z(e,t,n,r=!1){if(!(typeof t==`string`?e.includes(t):t.test(e))){if(r)return e;throw g(`state`,`Sky look: the sky shader no longer contains ${String(t)}; update extendSky in @margoengine/sky/look to match it`)}return e.replace(t,n)}function xt(e,t){let n=Z(e,`const BETA_R=vec3f(0.005802,0.013558,0.033100);`,``);return n=Z(n,/sunlight:vec4f\}/,`sunlight:vec4f,air0:vec4f,air1:vec4f,air2:vec4f,lookZenith:vec4f,lookHorizon:vec4f,lookGround:vec4f,lookGlow:vec4f,lookShape:vec4f,lookSun:vec4f,lookCloud:vec4f,lookStops:array<vec4f,8>,air3:vec4f}`),n=n.replace(/\bBETA_R\b/g,`betaR()`),n=Z(n,`fn mie()->f32{return 0.003996*max(0.25,(frame.settings.z-1.0)*0.5);}`,`fn betaR()->vec3f{return frame.air0.rgb;}
fn mie()->vec3f{return 0.003996*max(0.25,(frame.settings.z-1.0)*0.5)*frame.air1.rgb;}
fn mieExtinction()->f32{return 0.003996*max(0.25,(frame.settings.z-1.0)*0.5)*frame.air2.w/0.9;}
fn ozone(r:f32)->vec3f{return vec3f(0.00065,0.001881,0.000085)*frame.air0.w*max(0.0,1.0-abs(r-R-25.0)/15.0);}`),n=Z(n,`return betaR()*d.x+vec3f(mie()/0.9*d.y);`,`return betaR()*d.x+vec3f(mieExtinction()*d.y)+ozone(r);`),n=Z(n,`let g=0.8;`,`let g=frame.air1.w;`,!0),t?(n=Z(n,`fn daySky(direction:vec3f)->vec3f {`,`fn physicalDaySky(direction:vec3f)->vec3f {`),n=Z(n,`fn nightSky(w:vec3f,footprint:f32)->vec3f {`,`fn physicalNightSky(w:vec3f,footprint:f32)->vec3f {`),n=Z(n,`celestialProfile(w,s,SUN_RADIUS,footprint)`,`celestialProfile(w,s,SUN_RADIUS*frame.lookSun.w,max(footprint,2.0*SUN_RADIUS*frame.lookSun.w*frame.lookShape.w))`),n=Z(n,`*trans(transmission,R+clamp(frame.eye.w,0.001,99.9),s.y)*(1.0-frame.sun.w);`,`*trans(transmission,R+clamp(frame.eye.w,0.001,99.9),s.y)*(1.0-frame.sun.w)*frame.lookSun.rgb;`),n=Z(n,`let opacity=(1.0-exp(-thick*3.0/max(slant,0.25)))*haze;`,`let opacity=(1.0-exp(-thick*3.0*frame.lookCloud.w/max(slant,0.25)))*haze;`,!0),n=Z(n,`return mix(color,lit+moon+backdrop*(1.0-0.4*density)+vec3f(0.006,0.01,0.02),opacity);`,`return mix(color,(lit+moon+backdrop*(1.0-0.4*density)+vec3f(0.006,0.01,0.02))*frame.lookCloud.rgb,opacity);`,!0),n=Z(n,`return (zenith*shade+moon)*grade+vec3f(0.006,0.01,0.02)*T;`,`return ((zenith*shade+moon)*grade+vec3f(0.006,0.01,0.02)*T)*frame.lookCloud.rgb;`,!0),n+bt):n}var Q=(e,t,n)=>typeof e==`number`&&e>=t&&e<=n,St=(e,t)=>Array.isArray(e)&&e.length===3&&e.every(e=>Q(e,0,t)),Ct=[[`sunIntensity`,0,100],[`rayleigh`,0,20],[`mie`,0,50],[`mieAnisotropy`,-.95,.95],[`ozone`,0,20]],wt=[[`sunColor`,4],[`rayleighColor`,4],[`mieColor`,1],[`scatteredLight`,4]],Tt=[[`zenithStrength`,0,1],[`horizonStrength`,0,1],[`groundStrength`,0,1],[`gradientStrength`,0,1],[`gradientIntensity`,0,1e3],[`sunDiscSize`,.1,20],[`sunDiscIntensity`,0,100],[`sunDiscSoftness`,0,1],[`glowStrength`,0,100],[`glowWidth`,.5,90],[`glowSunward`,0,1],[`cloudDensity`,0,4]],Et=[[`zenithColor`,1],[`horizonColor`,1],[`groundColor`,1],[`sunDiscColor`,4],[`glowColor`,1],[`cloudColor`,4]];function Dt(e,t,n,r){if(e!==void 0){if(typeof e!=`object`||!e)throw RangeError(`Invalid sky ${t}; pass an object`);for(let[r,i,a]of n)if(e[r]!==void 0&&!Q(e[r],i,a))throw RangeError(`Invalid sky ${t}.${String(r)}; use a number from ${i} to ${a}`);for(let[n,i]of r)if(e[n]!==void 0&&!St(e[n],i))throw RangeError(`Invalid sky ${t}.${String(n)}; use three numbers from 0 to ${i} (linear RGB)`)}}var Ot=[{elevation:-90,color:[.3,.27,.24]},{elevation:0,color:[.85,.85,.9]},{elevation:90,color:[.25,.45,.9]}],$=(e,t,n,r=1)=>{e[t]=n[0]*r,e[t+1]=n[1]*r,e[t+2]=n[2]*r},kt={preetham:Ue,bruneton:Ze,clouds:it,night:ot,fog:ct,reflection:ft,lighting:vt,look:{extend:xt,validate(e){Dt(e.atmosphere,`atmosphere`,Ct,wt),Dt(e.look,`look`,Tt,Et);let t=e.look?.gradient;if(t!==void 0&&!(Array.isArray(t)&&t.length>=2&&t.length<=8&&t.every((e,n)=>typeof e==`object`&&!!e&&Q(e.elevation,-90,90)&&St(e.color,1)&&(n===0||e.elevation>t[n-1].elevation))))throw RangeError(`Invalid sky look.gradient; use 2 to 8 stops {elevation, color}, elevations -90 to 90 degrees rising, colours three numbers 0 to 1`)},air(e,t){let n=e.atmosphere??{},r=(n.rayleigh??1)*.0331;return $(t,0,n.rayleighColor??yt,r),t[3]=n.ozone??0,$(t,4,n.mieColor??[1,1,1],n.mie??1),t[7]=n.mieAnisotropy??.8,t[8]=n.mie??1,t},write(e,t,n,r=0){let i=t.atmosphere??{},a=t.look??{},o=i.sunColor??[1,1,1],s=i.sunIntensity??1;e.set(n.subarray(0,8),0),$(e,8,o,s),e[11]=n[8],$(e,12,a.zenithColor??[.25,.45,1]),e[15]=a.zenithStrength??0,$(e,16,a.horizonColor??[1,.8,.6]),e[19]=a.horizonStrength??0,$(e,20,a.groundColor??[.3,.25,.2]),e[23]=a.groundStrength??0,$(e,24,a.glowColor??[1,.45,.15],a.glowStrength??0),e[27]=Math.sin((a.glowWidth??8)*Math.PI/180);let c=a.gradient??Ot;e[28]=a.glowSunward??.5,e[29]=a.gradientStrength??0,e[30]=c.length,e[31]=a.sunDiscSoftness??0;let l=a.sunDiscColor??[1,1,1],u=a.sunDiscIntensity??1;for(let t=0;t<3;t++)e[32+t]=l[t]*u*o[t]*s;e[35]=a.sunDiscSize??1,$(e,36,a.cloudColor??[1,1,1]),e[39]=a.cloudDensity??1,e.fill(0,40),c.forEach((t,n)=>{$(e,40+4*n,t.color,a.gradientIntensity??1),e[43+4*n]=t.elevation}),$(e,72,i.scatteredLight??[0,0,0],s*r/Math.PI)}}},At=class extends He{constructor(e={}){super(e,kt)}static attach(n,r={}){return t(n,e(`0.1.0`,import.meta.url)),super.attach(n,r)}};export{S as a,B as i,Ae as n,je as r,At as t};