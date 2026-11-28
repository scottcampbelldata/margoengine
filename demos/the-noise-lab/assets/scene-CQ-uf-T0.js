const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["./tile-BYZuyUSW.js","./rolldown-runtime-DK3Fl9T5.js","./index-DSKh6had.js","./index-DEaLh4En.css"])))=>i.map(i=>d[i]);
import{t as e}from"./rolldown-runtime-DK3Fl9T5.js";import{t}from"./index-DSKh6had.js";function n({octaves:e=5,lacunarity:t=2,gain:n=.5,frequency:r=1}){if(!Number.isInteger(e)||e<1||e>16||![t,n,r].every(Number.isFinite))throw RangeError(`Invalid fractal options; pass integer octaves from 1 to 16 and finite lacunarity, gain and frequency`);return[e,t,n,r]}var r=(Math.sqrt(3)-1)/2,i=(3-Math.sqrt(3))/6,a=1/3,o=1/6,s=(Math.sqrt(5)-1)/4,c=(5-Math.sqrt(5))/20,l=[0,0,70,76,62],u=[1,-1,1,-1,1,-1,1,-1,0,0,0,0],d=[1,1,-1,-1,0,0,0,0,1,-1,1,-1],f=[0,0,0,0,1,1,-1,-1,1,1,-1,-1],p=e=>e*e*e*(e*(e*6-15)+10);function m(e,t,n,r){let i=Math.imul(e,374761393)^Math.imul(t,668265263)^Math.imul(n,1442695041)^r;return i=Math.imul(i^i>>>13,1274126177),(i^i>>>16)>>>0}var h=new Int8Array([1,1,0,-1,1,0,1,-1,0,-1,-1,0,1,0,1,-1,0,1,1,0,-1,-1,0,-1,0,1,1,0,-1,1,0,1,-1,0,-1,-1,1,1,0,0,-1,1,-1,1,0,0,-1,-1]);function g(e,t,n,r){let i=(e&15)*3;return h[i]*t+h[i+1]*n+h[i+2]*r}var _=(e,t,n=0,r=0)=>{if(!(Math.abs(e)<=1e7&&Math.abs(t)<=1e7&&Math.abs(n)<=1e7&&Math.abs(r)<=1e7))throw RangeError(`Noise coordinates exceed finite bounds; keep every coordinate within 10,000,000 of zero.`)};function v(e){if(!Number.isSafeInteger(e))throw RangeError(`Invalid noise seed; pass a safe integer.`);let t=e>>>0||1,n=Uint8Array.from({length:512},(e,t)=>t&255);for(let e=255;e>0;e--){t^=t<<13,t^=t>>>17,t^=t<<5;let r=Math.floor((t>>>0)/4294967296*(e+1)),i=n[e];n[e]=n[r],n[r]=i}return n.copyWithin(256,0,256),n}function y(e,t,n){let r=.5-t*t-n*n;if(r<=0)return 0;r*=r;let i=e&7,a=i<4?(i&1?-t:t)+(i&2?-n:n):i<6?i&1?-t:t:i&1?-n:n;return r*r*a}function b(e,t,n,r,i){let a=.5-n*n-r*r-i*i;return a<=0?0:(a*=a,a*a*(e[t*3]*n+e[t*3+1]*r+e[t*3+2]*i))}function x(e,t,n,r,i){let a=.5-t*t-n*n-r*r-i*i;if(a<=0)return 0;a*=a;let o=e&31,s=o>>3,c=o&4?-1:1,l=o&2?-1:1,u=o&1?-1:1;return a*a*(s===0?c*n+l*r+u*i:s===1?c*t+l*r+u*i:s===2?c*t+l*n+u*i:c*t+l*n+u*r)}var S=class{constructor(e=1){this.seed=e;let t=this.perm=v(e);this.gradients3=Float64Array.from({length:1536},(e,n)=>[u,d,f][n%3][t[Math.floor(n/3)]%12])}simplex2(e,t){_(e,t);let n=this.perm,a=(e+t)*r,o=Math.floor(e+a),s=Math.floor(t+a),c=(o+s)*i,u=e-o+c,d=t-s+c,f=+(u>d),p=1-f,m=o&255,h=s&255;return l[2]*(y(n[m+n[h]],u,d)+y(n[m+f+n[h+p]],u-f+i,d-p+i)+y(n[m+1+n[h+1]],u-1+2*i,d-1+2*i))}simplex(e,t,n){_(e,t,n);let r=this.perm,i=this.gradients3,s=(e+t+n)*a,c=Math.floor(e+s),u=Math.floor(t+s),d=Math.floor(n+s),f=(c+u+d)*o,p=e-c+f,m=t-u+f,h=n-d+f,g=c&255,v=u&255,y=d&255,x=0,S=0,C=0;p>m?x++:S++,p>h?x++:C++,m>h?S++:C++;let w=+(x>=2),T=+(S>=2),E=+(C>=2),D=+(x>=1),O=+(S>=1),k=+(C>=1);return l[3]*(b(i,g+r[v+r[y]],p,m,h)+b(i,g+w+r[v+T+r[y+E]],p-w+o,m-T+o,h-E+o)+b(i,g+D+r[v+O+r[y+k]],p-D+2*o,m-O+2*o,h-k+2*o)+b(i,g+1+r[v+1+r[y+1]],p-1+3*o,m-1+3*o,h-1+3*o))}simplex4(e,t,n,r){_(e,t,n,r);let i=this.perm,a=(e+t+n+r)*s,o=Math.floor(e+a),u=Math.floor(t+a),d=Math.floor(n+a),f=Math.floor(r+a),p=(o+u+d+f)*c,m=e-o+p,h=t-u+p,g=n-d+p,v=r-f+p,y=o&255,b=u&255,S=d&255,C=f&255,w=0,T=0,E=0,D=0;m>h?w++:T++,m>g?w++:E++,m>v?w++:D++,h>g?T++:E++,h>v?T++:D++,g>v?E++:D++;let O=0;for(let e=0;e<5;e++){let t=+(w>=4-e),n=+(T>=4-e),r=+(E>=4-e),a=+(D>=4-e);O+=x(i[y+t+i[b+n+i[S+r+i[C+a]]]],m-t+e*c,h-n+e*c,g-r+e*c,v-a+e*c)}return l[4]*O}perlin(e,t,n){_(e,t,n);let r=Math.floor(e),i=Math.floor(t),a=Math.floor(n);e-=r,t-=i,n-=a;let o=p(e),s=p(t),c=p(n),l=0;for(let u=0;u<2;u++)for(let d=0;d<2;d++)for(let f=0;f<2;f++)l+=g(m(r+u,i+d,a+f,this.seed),e-u,t-d,n-f)*(u?o:1-o)*(d?s:1-s)*(f?c:1-c);return l}worley(e,t,n){_(e,t,n);let r=Math.floor(e),i=Math.floor(t),a=Math.floor(n),o=1/0;for(let s=1;s<=2;s++)for(let c=-s;c<=s;c++)for(let l=-s;l<=s;l++)for(let u=-s;u<=s;u++){if(s===2&&Math.abs(c)<2&&Math.abs(l)<2&&Math.abs(u)<2)continue;let d=r+c,f=i+l,p=a+u,h=e<d?d-e:e>=d+1?e-(d+1):0,g=t<f?f-t:t>=f+1?t-(f+1):0,_=n<p?p-n:n>=p+1?n-(p+1):0;if(h*h+g*g+_*_>=o)continue;let v=d+m(d,f,p,this.seed)/4294967296-e,y=f+m(d,f,p,this.seed^2654435769)/4294967296-t,b=p+m(d,f,p,this.seed^2246822507)/4294967296-n;o=Math.min(o,v*v+y*y+b*b)}return Math.sqrt(o)}},C=n;function w(e,t={}){let[n,r,i,a]=C(t);return(t,o,s=0,c=0)=>{let l=0,u=0,d=1,f=a;for(let a=0;a<n;a++)l+=d*e(t*f,o*f,s*f,c*f),u+=d,d*=i,f*=r;return l/u}}var T=new S(413),E=w((e,t)=>T.simplex2(e,t),{octaves:5,gain:.52}),D=w((e,t,n)=>T.simplex(e,t,n),{octaves:4,gain:.53}),O=(e,t,n)=>Math.min(n,Math.max(t,e)),k=(e,t,n)=>{let r=O((n-e)/(t-e),0,1);return r*r*(3-2*r)},A=[1.58,1.03],j=[48,30,40];function M(e,t,n,r){let i=1-k(.3,.94,Math.hypot(e*.94,t*.99)),a=.33+.65*E(e*n*1.13+5.3,t*n*.81-3.35),o=1-Math.abs(T.simplex2(e*n*.68-9.2,t*n*.68+9.7)),s=(a*1.29+.29*o*o)*i-.117;return k(.001,.12,s)*s*(.42+r*.99)}function N(e,t,n,r){let i=r*1.1,a=D(e*i+.95,t*i*.77+5.1,n*i-7.02),o=1-Math.abs(T.simplex(e*i*.71-4.7,t*i*.62+1.97,n*i*.81+2.18)),s=Math.exp(-3.3*((e+.32)**2+(t+.24)**2*1.21+n*n*.59)),c=Math.exp(-3.5*((e-.38)**2+(t-.13)**2*.97+(n+.19)**2*.61)),l=Math.max(s,c*.96),u=(1-k(.73,1,Math.abs(e)))*(1-k(.73,1,Math.abs(t)))*(1-k(.76,1,Math.abs(n)));return k(.18,.87,.6*a+.48*o+l*.94-.3)*u}function P(e){let[t,n,r]=j,i=new Uint8Array(t*n*r),a=0;for(let o=0;o<r;o++)for(let s=0;s<n;s++)for(let c=0;c<t;c++){let l=Math.round(255*N(c/(t-1)*2-1,s/(n-1)*2-1,o/(r-1)*2-1,e));i[(o*n+s)*t+c]=l,a+=l}return{atlas:i,total:a}}function F(e,t,n,r){let i=Math.PI*2,a=n*.192,o=(e+r)*i,s=(t+r*.33)*i,c=Math.cos(o)*a,l=Math.sin(o)*a,u=Math.cos(s)*a,d=Math.sin(s)*a;return T.simplex4(c,l,u,d)*.67+T.simplex4(2*c,2*l,2*u,2*d)*.24+T.simplex4(4*c,4*l,4*u,4*d)*.09}var I=`
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
`,ee=I+`
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
`,L=I+`
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
`,R=`
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
`,z=(e=``)=>L+R+e+`
@fragment fn shade(sample:Sample)->@location(0) vec4f {
  let n=normalize(sample.normal);
  let slope=fwidth(sample.uv.y*18.0);
  `+(e?`if(sample.kind==2.0){return vec4f(material(sample.uv),1);}`:``)+`
  return vec4f(specimen(sample,n,slope),1);
}
`,te=I+`
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
`,B=[.58,.37,.21],V=[.075,.415,.4],H=[.105,.142,.133],ne=[.265,.223,.165],U=[.036,.065,.055],W=[.71,.79,.61],G=(e,t,n)=>e.map((e,r)=>e+(t[r]-e)*n),K=([e,t,n])=>{let r=Math.hypot(e,t,n);return[e/r,t/r,n/r]},q=52;function re(e,t,n){let r=[],i=(e,t,n,r=0,i=0,a=0)=>[...e,...t,...n,r,i,a],a=(e,t,n)=>r.push(...e,...t,...n),o=(e,t,n,r)=>{a(e,t,n),a(e,n,r)};function s(e,t,n,r,a,s,c){let l=[[e-r,t-a,n-s],[e+r,t-a,n-s],[e+r,t+a,n-s],[e-r,t+a,n-s],[e-r,t-a,n+s],[e+r,t-a,n+s],[e+r,t+a,n+s],[e-r,t+a,n+s]];for(let[e,t,n,r,a,s,u]of[[4,5,6,7,0,0,1],[1,0,3,2,0,0,-1],[0,4,7,3,-1,0,0],[5,1,2,6,1,0,0],[7,6,2,3,0,1,0],[0,1,5,4,0,-1,0]]){let d=e=>i(l[e],[a,s,u],c);o(d(e),d(t),d(n),d(r))}}function c(e){let t=e.map(([e,t,n,r,i])=>{let a=[];for(let o=0;o<4;o++)for(let s=0;s<=8;s++){let c=(o+s/8)*Math.PI/2,l=Math.cos(c),u=Math.sin(c),d=Math.sign(Math.cos((o+.5)*Math.PI/2))*(e-r)+l*r,f=Math.sign(Math.sin((o+.5)*Math.PI/2))*(n-r)+u*r;a.push({p:[d,t,f],n:[l,u],c:i})}return a});for(let n=0;n<t.length-1;n++){let r=t[n],a=t[n+1],s=K([e[n+1][1]-e[n][1],e[n][0]-e[n+1][0],0]),c=e=>i(e.p,[e.n[0]*s[0],s[1],e.n[1]*s[0]],e.c);for(let e=0;e<r.length;e++){let t=(e+1)%r.length;o(c(r[e]),c(r[t]),c(a[t]),c(a[e]))}}let n=t.at(-1),r=i([0,e.at(-1)[1],0],[0,1,0],e.at(-1)[4]),s=e=>i(e.p,[0,1,0],e.c);for(let e=0;e<n.length;e++)a(r,s(n[e]),s(n[(e+1)%n.length]))}c([[1.76,-.405,1.2,.135,H],[1.84,-.348,1.26,.172,B],[1.82,-.32,1.24,.17,B],[1.77,-.3,1.19,.135,H],[1.755,-.076,1.158,.13,H],[1.72,-.045,1.135,.12,B],[1.72,-.027,1.131,.118,B],[1.69,-.007,1.105,.112,ne]]),s(0,-.166,1.194,.54,.065,.013,B),s(0,-.163,1.211,.518,.048,.004,U);for(let e=0;e<25;e++){let t=e%4==0;s((e-12)*.039,-.163-(t?0:.011),1.217,.0023,t?.029:.018,.002,G(B,W,t?.7:.28))}for(let t of[-1.465,1.465])s(t,-.17,1.187,.115,.041,.015,H),s(t,-.17,1.205,.044,.017,.008,e===`terrain`?V:B);for(let e of[-1.55,1.55])for(let t of[-.895,.895])s(e,-.435,t,.125,.048,.102,U);let l=0,u=0;if(e===`terrain`){let[e,r]=A,a=Array.from({length:2809},(a,o)=>{let s=o%53/q*2-1,c=Math.floor(o/53)/q*2-1,u=M(s,c,t,n);l=Math.max(l,u);let d=.002,f=(M(s+d,c,t,n)-M(s-d,c,t,n))/(2*d*e),p=(M(s,c+d,t,n)-M(s,c-d,t,n))/(2*d*r),m=G(G([.077,.296,.273],[.145,.59,.476],k(1.13,.16,Math.hypot(s*.87,c*.87))),G(G([.81,.64,.38],[.54,.47,.3],k(.018,.107,u)),G([.52,.37,.23],[.9,.82,.57],k(.15,.64,u)),k(.07,.19,u)),k(.008,.045,u));return i([s*e,.034+u,c*r],K([-f,1,-p]),m,s,u,1)});for(let e=0;e<q;e++)for(let t=0;t<q;t++){let n=e*53+t,r=n+53;o(a[n],a[r],a[r+1],a[n+1]),u+=2}for(let[e,t,n,r]of[[0,-1.035,1.6,.014],[0,1.035,1.6,.014],[-1.596,0,.014,1.02],[1.596,0,.014,1.02]])s(e,.02,t,n,.017,r,B)}else if(e===`cloud`){s(0,.021,0,1.35,.021,1.031,U);for(let e of[-1.29,1.29])for(let t of[-.99,.99])s(e,.092,t,.038,.046,.04,B),s(e,.174,t,.013,.047,.012,B);for(let e=-8;e<=8;e++)s(e*.141,.044,1.019,.0025,.002,.009,e%4==0?W:B)}else{s(0,.065,0,1.56,.075,.97,B),o(...[[-1.51,-.92],[1.51,-.92],[1.51,.92],[-1.51,.92]].map(([e,t],n)=>i([e,.142,t],[0,1,0],W,n===0||n===3?0:1,n<2?0:1,2)));for(let e of[-1.542,1.542])for(let t of[-.95,.95])s(e,.143,t,.029,.01,.024,W)}return{data:new Float32Array(r),range:l,triangles:u}}var J=[3.78,3.23,5.18],ie=[0,.28,0].map((e,t)=>e-J[t]),Y=e=>e.map(t=>t/Math.hypot(...e)),X=Y(ie),Z=Y([-X[2],0,X[0]]),ae=[Z[1]*X[2]-Z[2]*X[1],Z[2]*X[0]-Z[0]*X[2],Z[0]*X[1]-Z[1]*X[0]],Q=48,$=`depth24plus`,oe=[{shaderLocation:0,offset:0,format:`float32x3`},{shaderLocation:1,offset:12,format:`float32x3`},{shaderLocation:2,offset:24,format:`float32x3`},{shaderLocation:3,offset:36,format:`float32x2`},{shaderLocation:4,offset:44,format:`float32`}],se={format:$,depthWriteEnabled:!0,depthCompare:`greater`},ce={color:{srcFactor:`one`,dstFactor:`one-minus-src-alpha`,operation:`add`},alpha:{srcFactor:`one`,dstFactor:`one-minus-src-alpha`,operation:`add`}};function le(e){let n,r,i,a,o,s,c,l,u,d,f,p,m,h,g,_,v,y,b,x,S,C,w,T,E,D,O=2.4,k=.65;function A(e){n=e,r=n.gpu,i=r.createBuffer({label:`specimen camera`,size:80,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),a=r.createBuffer({label:`sculpted terrain and chassis`,size:Q*20500,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST})}function M(){b?.dispose(),a?.destroy(),i?.destroy(),o?.destroy(),v?.destroy(),b=x=a=i=o=v=y=void 0,u=d=f=p=m=h=g=_=void 0,l=s=c=w=T=E=void 0}function N(t){M(),A(t),D===`tile`?B(D,O,k).then(()=>{e.aborted||n.render(0)}).catch(t=>{e.aborted||n.onError?.(t)}):R(D,O,k)}function F(e,t){return r.createShaderModule({code:e,label:t})}function I(e,t,{mesh:n=!1,blend:i}={}){let a=F(e,t),o={label:`Noise Lab `+t,layout:`auto`,vertex:{module:a,entryPoint:n?`project`:`fullscreen`,buffers:n?[{arrayStride:Q,attributes:oe}]:[]},fragment:{module:a,entryPoint:t,targets:[{format:l,blend:i}]}};return n&&(o.depthStencil=se),r.createRenderPipeline(o)}function L(e,t=[]){let n=[{binding:0,resource:{buffer:i}}];return t.forEach((e,t)=>n.push({binding:1+t,resource:e})),r.createBindGroup({layout:e.getBindGroupLayout(0),entries:n})}function R(e,t,n){D=e,O=t,k=n;let i=e===`terrain`?e+`/`+t+`/`+n:e;if(E!==i&&(T=re(e,t,n),r.queue.writeBuffer(a,0,T.data),E=i),e===`cloud`&&w?.frequency!==t){let[e,n,i]=j;v||(v=r.createTexture({size:[e,n*i],format:`r8unorm`,usage:GPUTextureUsage.COPY_DST|GPUTextureUsage.TEXTURE_BINDING}),y=r.createSampler({minFilter:`linear`,magFilter:`linear`}));let{atlas:a,total:o}=P(t);r.queue.writeTexture({texture:v},a,{bytesPerRow:e,rowsPerImage:n*i},[e,n*i]),w={frequency:t,total:o}}return{relief:T.range,triangles:T.triangles,cloudSum:w?.total}}async function B(n,i,a){if(n===`tile`&&!b){C??=t(()=>import(`./tile-BYZuyUSW.js`).then(e=>e.t),__vite__mapDeps([0,1,2,3]),import.meta.url);let{bakeTile:n,tileShader:i}=await C;e.throwIfAborted();let a=S??=i(),o=r,s=await n(o,e);if(e.aborted||o!==r)throw s.dispose(),e.throwIfAborted(),Error(`The Margo device changed during the tile bake.`);b=s,S=a,x=r.createSampler({addressModeU:`repeat`,addressModeV:`repeat`,minFilter:`linear`,magFilter:`linear`})}return R(n,i,a)}function V(e){if(!T||D===`tile`&&!b)return;let t=n.canvas.width,C=n.canvas.height,w=t/C,E=.276*Math.max(1,1.4/w),A=new Float32Array([...J,1,...X,1,...Z,E*w,...ae,E,O,k,t,C]);r.queue.writeBuffer(i,0,A),l!==e.format&&(l=e.format,u=I(ee,`floorColor`),d=I(z(),`shade`,{mesh:!0}),m=L(u),h=L(d),f=p=g=_=void 0),(t!==s||C!==c)&&(o?.destroy(),o=r.createTexture({size:[t,C],format:$,usage:GPUTextureUsage.RENDER_ATTACHMENT}),s=t,c=C);let j=[{view:e.color,loadOp:`clear`,storeOp:`store`,clearValue:[.085,.115,.108,1]}],M={view:o.createView(),depthLoadOp:`clear`,depthStoreOp:`discard`,depthClearValue:0},N=e.encoder.beginRenderPass({colorAttachments:j});N.setPipeline(u),N.setBindGroup(0,m),N.draw(3),N.end(),j[0].loadOp=`load`;let P=d,F=h;D===`tile`&&(p||(p=I(z(S),`shade`,{mesh:!0}),_=L(p,[b.texture.createView(),x])),P=p,F=_);let R=e.encoder.beginRenderPass({colorAttachments:j,depthStencilAttachment:M});if(R.setPipeline(P),R.setBindGroup(0,F),R.setVertexBuffer(0,a),R.draw(T.data.length/(Q/4)),R.end(),D===`cloud`){f||(f=I(te,`chamber`,{blend:ce}),g=L(f,[v.createView(),y]));let t=e.encoder.beginRenderPass({colorAttachments:j});t.setPipeline(f),t.setBindGroup(0,g),t.draw(3),t.end()}}return{name:`noise-specimens`,setup:A,onDeviceRestored:N,dispose:M,set:R,prepare:B,registerPasses(e){e.add({name:`display-noise-specimens`,order:1,execute:V})}}}var ue=e({show:()=>pe}),de={terrain:{head:`Height field`,equation:`N(x, y)`,detail:`Relief`,range:[15,95],alt:`Procedural island on a bronze display plinth`,caption:`Height from two coordinates. The bright contour lines follow equal elevation.`},cloud:{head:`Density volume`,equation:`N(x, y, z)`,detail:`Slice height`,range:[0,100],alt:`Procedural cloud in a display chamber with a green horizontal density section`,caption:`Density from three coordinates. Move the green plane to cut a horizontal section through the plume.`},tile:{head:`Periodic material`,equation:`N(x, y, z, w)`,detail:`Tile phase`,range:[0,100],alt:`Two rows of three repeating four-dimensional noise tiles in a bronze frame`,caption:`Two circular coordinate pairs make a seamless texture. All six copies move together when you change phase.`}},fe=()=>new Promise(e=>requestAnimationFrame(e));async function pe({engine:e,canvas:t,notice:n,status:r,size:i,signal:a,fail:o}){let s=le(a);e.use(s);let c=e=>document.querySelector(e),l=t.dataset,u=c(`#route`),d=c(`#frequency`),f=c(`#detail`),p=[...document.querySelectorAll(`[name=mode]`)],m=[d,f,...p],h=e.gpu.adapterInfo?.vendor===`margo-webgl2`;u.textContent=h?`Margo WebGL2`:`Margo WebGPU`,l.renderer=h?`compatibility`:`webgpu`;let g=`terrain`,_=!0,v=null,y=!1,b=!1,x={terrain:65,cloud:46,tile:0};function S(e,n,r,i){let a=de[e];if(t.setAttribute(`aria-label`,a.alt),c(`#specimen`).textContent=a.head,c(`#coordinates`).textContent=a.equation,c(`#description`).textContent=a.caption,c(`#detail-label`).textContent=a.detail,c(`#frequency-value`).value=n.toFixed(1)+`×`,c(`#detail-value`).value=Math.round(r*100)+`%`,l.mode=e,l.frequency=n.toFixed(1),l.detail=r.toFixed(2),l.elevation=i.relief.toFixed(6),l.triangles=String(i.triangles),e===`cloud`&&(l.density=String(i.cloudSum)),e===`tile`){let e=Math.max(...[.135,.317,.502,.661,.812].flatMap(e=>[Math.abs(F(0,e,n,r)-F(1,e,n,r)),Math.abs(F(e,0,n,r)-F(e,1,n,r))]));l.seamDelta=String(e),l.woodBake=`128x128`}}async function C(){if(!y){y=!0;try{for(;v&&!a.aborted;){let t=v;v=null;let{mode:n,scale:r,amount:i,trusted:o}=t,c=n===`tile`?await s.prepare(n,r,i):s.set(n,r,i);if(a.throwIfAborted(),e.render(0),await e.gpu.queue.onSubmittedWorkDone(),await fe(),a.aborted)return;S(n,r,i,c),o&&(performance.mark(`noise-input-rendered`),_&&(_=!1,performance.mark(`noise-first-input`)))}b&&!a.aborted&&(b=!1,e.render(0))}catch(e){a.aborted||o(e)}finally{y=!1}}}function w(e){v={mode:g,scale:Number(d.value),amount:x[g]/100,trusted:e.isTrusted},C()}let T=s.set(`terrain`,2.4,.65);performance.mark(`noise-data`),e.render(0),await e.gpu.queue.onSubmittedWorkDone(),a.throwIfAborted(),r.ready(e),n.hidden=!0,S(`terrain`,2.4,.65,T),m.forEach(e=>e.disabled=!1),l.ready=`true`,performance.mark(`noise-ready`),d.addEventListener(`input`,w,{signal:a}),f.addEventListener(`input`,e=>{x[g]=Number(f.value),w(e)},{signal:a});for(let e of p)e.addEventListener(`change`,t=>{if(!e.checked)return;g=e.value;let[n,r]=de[g].range;f.min=String(n),f.max=String(r),f.value=String(x[g]),w(t)},{signal:a});let E=new ResizeObserver(()=>{!a.aborted&&i()&&(y?b=!0:e.render(0))});E.observe(t),a.addEventListener(`abort`,()=>E.disconnect(),{once:!0})}export{pe as show,ue as t};