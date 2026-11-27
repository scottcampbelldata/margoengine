import{n as e}from"./extension-BytumP3S.js";import{n as t,t as n}from"./version-DZ3BcJze.js";import{a as r,i}from"./gpu-BzO0Ib4x-DYuWDWVd.js";import{o as a}from"./dist-mjUC1sVg.js";import{r as o}from"./dist-BVTbCh_i.js";var s=(t,n=`0.1.0`,r=import.meta.url)=>e(t,n,r),c={height:.6,heightVariance:.4,width:.04,blades:8,radius:.15,lean:.35,round:.3,segments:[5,3,1]};function l(e={}){if(!e||typeof e!=`object`)throw i(`GrassScatter grass must be a shape object such as { height: 0.6, blades: 8 }; omit it for the defaults`,`scatter`);let t={...c,...e},{height:n,heightVariance:a,width:o,blades:s,radius:l,lean:u,round:d,segments:f}=t,p=(e,t,n)=>Number.isFinite(e)&&e>=t&&e<=n;if(!(p(n,1e-4,1e4)&&p(o,1e-5,1e3)&&p(l,0,1e4))||!p(a,0,.95)||!p(u,0,.95)||!p(d,0,1)||!Number.isInteger(s)||!p(s,1,64)||!Array.isArray(f)||f.length!==3||!f.every((e,t)=>Number.isInteger(e)&&p(e,1,16)&&(!t||e<=f[t-1])))throw r(`GrassScatter grass needs height 0.0001-10000, width 0.00001-1000, radius 0-10000, heightVariance, lean 0-0.95, round 0-1, blades an integer 1-64 and three non-increasing integer segments 1-16`,`scatter`);return t}var u=e=>e.radius+e.lean*e.height+e.width/2;function d(e={}){let t=l(e),n=u(t);return t.segments.map(e=>{let r=[],i=[],o=[];for(let i=0;i<t.blades;i++){let a=(t.blades>1?i/(t.blades-1)*2-1:0)*n,s=r.length/3;for(let i=0;i<=e;i++)for(let o of[-1,1])r.push(o*n,i/e*t.height,t.blades>1?a:o*n);for(let t=0;t<e;t++){let e=s+t*2;o.push(e,e+1,e+3,e,e+3,e+2)}}for(let e=0;e<r.length;e+=3)i.push(0,0,1);return new a(r,i,o)})}var f=e=>Number.isInteger(e)?`${e}.0`:`${e}`;function p(e,t={}){let n=l(t),r=u(n),a=e.includes(`var<private> scatterCover`),o=e.includes(`const scatterSplit`),s=`fn scatterPose(p:vec3f,n:vec3f,position:vec4f,`;if(e.split(s).length!==2)throw i(`grassPoseCode takes a scatter vertex stage`,`scatter`);return e.replace(s,`fn scatterPoseBase(p:vec3f,n:vec3f,position:vec4f,`)+`
struct GrassVertex {p:vec3f,n:vec3f}
fn grassHash(value:u32)->f32 {var x=value;x=(x^(x>>16u))*0x7feb352du;x=(x^(x>>15u))*0x846ca68bu;x=x^(x>>16u);return f32(x)/4294967296.0;}
fn grassVertex(p:vec3f,position:vec4f,wide:f32,pix:f32,view:vec3f)->GrassVertex {
 let side=p.x/${f(r)};let along=p.y/${f(n.height)};let k=u32(round((p.z/${f(r)}+1.0)*0.5*${f(n.blades-1)}));
 let seed=(bitcast<u32>(position.x)*0x9e3779b9u)^(bitcast<u32>(position.z)*0x85ebca6bu)^((k+1u)*0xc2b2ae35u);
 let a=grassHash(seed)*6.2831853;let d=${f(n.radius)}*sqrt(grassHash(seed^0x68e31da4u));
 let heading=grassHash(seed^0xb5297a4du)*6.2831853;let dir=vec3f(cos(heading),0.0,sin(heading));let right=vec3f(-dir.z,0.0,dir.x);
 let foot=1.5*pix;let w=${f(n.width)};let face=sqrt(max(1.0-dot(view,right)*dot(view,right),0.0));let seen=max(face,0.25);let wp=w*face;
${a||o?` let grow=1.0;let t=along;
`:` var keep=select(select(wp*wp/(wp*wp+foot*foot),wp/(2.0*foot),wp<foot),1.0,foot<=0.0);
 keep=select(keep,0.0,face<0.25&&wp<foot);
 let t=along;
 let band=max(min(0.05,2.0*min(keep,1.0-keep)),1e-6);
 let grow=select(clamp((keep-grassHash(seed^0x2c1b3c6du))/band+0.5,0.0,1.0),1.0,keep>=1.0);
 if(grow<=0.0){return GrassVertex(vec3f(0.0),vec3f(0.0,1.0,0.0));}
`} let height=grow*${f(n.height)}*(1.0-${f(n.heightVariance)}*grassHash(seed^0x1b56c4e9u));
 let lean=${f(n.lean)}*(0.25+0.75*grassHash(seed^0x7f4a7c15u));
 // Root (0,0,0), control point straight above at the blade's height, tip leaning along dir at the same length.
 let ctrl=vec3f(0.0,height,0.0);let tip=vec3f(0.0,height*sqrt(1.0-lean*lean),0.0)+dir*(height*lean);
 let spine=2.0*t*(1.0-t)*ctrl+t*t*tip;let tangent=2.0*(1.0-t)*ctrl+2.0*t*(tip-ctrl);
 let root=vec3f(cos(a)*d,0.0,sin(a)*d);
 let wt=w*(1.0-t);${a||o?` var perp=cross(tangent,view);perp=select(right,perp/length(perp),dot(perp,perp)>1e-12);
 perp=select(perp,-perp,dot(perp,right)<0.0);let rp=dot(right,perp);let h=0.5*wt*rp/max(pix,1e-30);
 let far=clamp((8.0-height/max(pix,1e-30))/4.0,0.0,1.0);let fr=select(1.0,2.0,far>0.0);
${a?` let across=select(right*(side*0.5*wt),right*(side*0.5*wt)+perp*(side*fr*pix),pix>0.0);
 scatterCover=select(vec4f(0.0,65536.0,0.0,0.5),vec4f(side*(h+fr),h,far,grassHash(seed^0x3c6ef372u)),pix>0.0);
`:` let across=right*(side*select(0.5*wt,max(h-fr,0.0)*pix/max(rp,1e-3),pix>0.0));
`}`:` let drawn=max(wt,foot/seen);let across=right*(side*0.5*drawn);
`} let at=vec3f((root.x+spine.x)/wide,spine.y,(root.z+spine.z)/wide)+vec3f(across.x,across.y*wide,across.z);
 let normal=normalize(cross(right,tangent));
 return GrassVertex(at,normalize(normal+right*(side*${f(n.round)})));
}
fn scatterPose(p:vec3f,n:vec3f,position:vec4f,rotation:vec4f,ground:vec4f,blade:vec4f,eye:vec3f,wind:vec4f,pixel:f32,sway:vec4f)->ScatterPose {
 let d=distance(position.xyz,eye);let wide=1.0+d*blade.y;let c=cos(rotation.x);let s=sin(rotation.x);
 let look=(position.xyz-eye)/max(d,1e-6);let view=vec3f(c*look.x-s*look.z,look.y,s*look.x+c*look.z);
 let g=grassVertex(p,position,wide,d*pixel/(wide*position.w),view);
 return scatterPoseBase(g.p,g.n,position,rotation,ground,blade,eye,wind,pixel,sway);
}
`}var m=class e extends o{constructor(e={}){if(!e||typeof e!=`object`)throw i(`GrassScatter takes an options object; omit it for the defaults`,`scatter`);let{grass:t,...n}=e,r=l(t);super(d(r),{color:[.18,.42,.08],blades:{},...n}),this.grass=Object.freeze({...r,segments:Object.freeze([...r.segments])})}static attach(r,o){if(n(r,t(`0.1.0`,import.meta.url)),o instanceof a||Array.isArray(o))throw i(`GrassScatter builds its own blades; call GrassScatter.attach(engine, options) without meshes`,`scatter`);let c=new e(o);return s(r).use(c),c}coverRing(e){return e>0?`cover`:`split`}poseCode(e,t,n){return p(super.poseCode(e,t,n),this.grass)}};export{m as t};