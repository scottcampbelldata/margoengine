import"./index-III9swn9.js";var e=`struct Studio {
  eye:vec4f,
  forward:vec4f,
  side:vec4f,
  vertical:vec4f,
  light:vec4f,
  lightRight:vec4f,
  lightUp:vec4f,
  settings:vec4f,
}
@group(0) @binding(0) var<uniform> studio:Studio;
@group(0) @binding(1) var shadowAtlas:texture_depth_2d;
struct Surface {
  @builtin(position) clip:vec4f,
  @location(0) world:vec3f,
  @location(1) normal:vec3f,
  @location(2) @interpolate(flat) material:f32,
  @location(3) bary:vec2f,
}
fn lightClip(p:vec3f)->vec3f {
  let center=p-vec3f(0,.18,0);
  return vec3f(dot(center,studio.lightRight.xyz)*1.04,dot(center,studio.lightUp.xyz)*1.04,
    .52-.47*dot(center,studio.light.xyz));
}
@vertex fn depthVertex(@location(0) p:vec3f)->@builtin(position) vec4f {
  return vec4f(lightClip(p),1);
}
@vertex fn vertex(@location(0) point:vec3f,@location(1) normal:vec3f,@location(2) material:f32,
  @location(3) bary:vec2f)->Surface {
  let d=point-studio.eye.xyz;
  return Surface(vec4f(dot(d,studio.side.xyz)/studio.side.w,dot(d,studio.vertical.xyz)/studio.vertical.w,
    .025,dot(d,studio.forward.xyz)),point,normal,material,bary);
}
fn shadow(p:vec3f,n:vec3f)->f32 {
  let cosine=dot(n,studio.light.xyz);
  let projected=lightClip(p+.00145*n);
  let outer=max(abs(projected.x),abs(projected.y));
  if(outer>.985||cosine<.035||projected.z<=0.0||projected.z>=.999){return 1;}
  let uv=projected.xy*vec2f(.5,-.5)+.5;
  let dimensions=vec2f(textureDimensions(shadowAtlas));
  let base=vec2i(uv*dimensions);
  let slope=vec2f(dot(n,studio.lightRight.xyz),-dot(n,studio.lightUp.xyz))*.94/
    (max(cosine,.16)*1.04);
  var lit=0.0;
  for(var y=-2;y<=2;y++){
    for(var x=-2;x<=2;x++){
      let tap=base+vec2i(x,y)*2;
      let v=textureLoad(shadowAtlas,tap,0);
      let offset=(vec2f(tap)+.5)/dimensions-uv;
      lit+=select(0.0,1.0,v>=.99995||projected.z+dot(slope,offset)-.00115<=v);
    }
  }
  let validity=1-smoothstep(.875,.985,outer);
  return 1-(1-lit/25.0)*.61*validity;
}
fn keySpecular(n:vec3f,l:vec3f,v:vec3f,width:f32)->f32 {
  return pow(max(dot(n,normalize(l+v)),0.0),width);
}
fn glaze(point:vec3f,n:vec3f,material:f32,v:vec3f,visibility:f32)->vec3f {
  let key=studio.light.xyz;
  let facing=max(0.0,dot(n,key));
  let cool=max(0.0,dot(n,normalize(vec3f(.73,.50,-.54))));
  let warm=max(0.0,dot(n,normalize(vec3f(.28,.38,.87))));
  let grazing=pow(1-max(dot(n,v),0.0),3.0);
  let coat=keySpecular(n,key,v,26.0)*.16+keySpecular(n,key,v,120.0)*.10;
  let marble=.004*sin(point.y*128.0+point.x*79.0+sin(point.z*99.9));
  let bone=vec3f(.86,.84,.755);
  let amber=vec3f(.77,.408,.177);
  let inset=vec3f(.59,.289,.156);
  let base=select(select(bone,amber,material>.32),inset,material>.62);
  let body=base*(.31+ .60*facing*visibility+ .27*cool+.15*warm+marble);
  let softFresnel=vec3f(.12,.163,.22)*grazing*.32;
  return (body+vec3f(1,.90,.78)*coat*visibility+softFresnel)*vec3f(1.025,1.00,.99);
}
@fragment fn fragment(f:Surface)->@location(0) vec4f {
  let n=normalize(f.normal);
  let v=normalize(studio.eye.xyz-f.world);
  let visibility=shadow(f.world,n);
  let bary=vec3f(f.bary,1-f.bary.x-f.bary.y);
  let width=max(fwidth(bary),vec3f(.0001));
  if(f.material==0.0){
    let radial=length(f.world.xz*vec2f(.9,1.27)+vec2f(.28,-.23));
    let vignette=exp(-2.25*radial*radial);
    let color=vec3f(.097,.127,.179)+vec3f(.101,.122,.154)*vignette;
    let grit=.003*sin(f.world.x*272.0+f.world.z*120.0)*sin(f.world.z*203.0);
    let show=f.world.xz-vec2f(.09,.03);
    let edge=max(abs(show.x)-.42,abs(show.y)-.36);
    let contact=.70+.30*smoothstep(-.01,.14,edge);
    return vec4f((color+vec3f(grit*exp(-radial*radial)))*visibility*contact,1);
  }
  if(f.material<.99){
    let aaa=smoothstep(width*.1,width*.88,bary);
    let edge=(1-min(aaa.x,min(aaa.y,aaa.z)))*studio.settings.x;
    let color=glaze(f.world,n,f.material,v,visibility);
    return vec4f(mix(color,vec3f(.107,.18,.245),edge*.58),1);
  }
  let l=studio.light.xyz;
  let ndl=max(dot(n,l),0.0);
  let satin=keySpecular(n,l,v,46.0);
  if(f.material>1.40){return vec4f(vec3f(.74,.56,.35)*(.54+.48*ndl)+satin*.1,1);}
  var base=vec3f(.076,.110,.152);
  if(f.material>1.18){base=vec3f(.459,.309,.203);}
  if(f.material>1.04&&f.material<1.18){base=vec3f(.18,.237,.306);}
  let machining=.007*sin(f.world.z*643.0+f.world.x*43.0)*sin(f.world.x*242.0);
  let color=base*(.65+.43*ndl*visibility)+vec3f(.28,.31,.36)*satin*.44+vec3f(machining);
  return vec4f(color,1);
}
\r
\r
`,t=9;function n(){let e=[],n=(e,t,n,r=1,i=0)=>[...e,...t,n,r,i],r=(t,n,r)=>e.push(...t,...n,...r),i=(e,t,i,a,o,s)=>{r(n(e,o,s),n(t,o,s),n(i,o,s)),r(n(e,o,s),n(i,o,s),n(a,o,s))},a=[0,1,0];i([-9,-.124,-9],[-9,-.124,9],[9,-.124,9],[9,-.124,-9],a,0);let o=e.length/t;function s(e){let t=e.map(([e,t,n,r])=>{let i=[];for(let a=0;a<4;a++)for(let o=0;o<=9;o++){let s=(a+o/9)*Math.PI/2,c=Math.cos(s),l=Math.sin(s),u=Math.sign(Math.cos((a+.5)*Math.PI/2))*(t-r),d=Math.sign(Math.sin((a+.5)*Math.PI/2))*(n-r);i.push([u+c*r,e,d+l*r,c,l])}return i});for(let i=0;i<t.length-1;i++){let a=t[i],o=t[i+1],s=e[i+1][0]-e[i][0],c=e[i][1]-e[i+1][1],l=Math.hypot(s,c),u=e[i+1][4],d=e=>n(e.slice(0,3),[e[3]*s/l,c/l,e[4]*s/l],u);for(let e=0;e<a.length;e++){let t=(e+1)%a.length;r(d(a[e]),d(o[e]),d(o[t])),r(d(a[e]),d(o[t]),d(a[t]))}}let i=t.at(-1),o=e.at(-1)[0],s=e.at(-1)[4];for(let e=0;e<i.length;e++)r(n([0,o,0],a,s),n(i[(e+1)%i.length].slice(0,3),a,s),n(i[e].slice(0,3),a,s))}s([[-.124,.455,.439,.057,1],[-.111,.486,.469,.07,1],[-.088,.491,.474,.074,1.05],[-.083,.488,.471,.072,1.25],[-.077,.485,.466,.069,1.25],[-.063,.479,.46,.066,1],[-.017,.479,.46,.066,1],[-.006,.463,.445,.06,1.05],[-.001,.454,.436,.059,1.12]]);for(let e=-14;e<=14;e++){let t=e*.021,n=[0,0,1],r=e%4==0,a=r?.012:.007;i([t-8e-4,-.05-a,.461],[t+8e-4,-.05-a,.461],[t+8e-4,-.05,.461],[t-8e-4,-.05,.461],n,r?1.54:1.44)}for(let e of[-.424,.424])for(let t of[-.388,.388]){let o=[e,.003,t],s=.01;for(let i=0;i<20;i++){let c=i*Math.PI/10,l=(i+1)*Math.PI/10,u=[e+s*Math.cos(c),.003,t+s*Math.sin(c)],d=[e+s*Math.cos(l),.003,t+s*Math.sin(l)];r(n(o,a,1.57),n(d,a,1.57),n(u,a,1.57))}i([e-.006,.0032,t-8e-4],[e-.006,.0032,t+8e-4],[e+.006,.0032,t+8e-4],[e+.006,.0032,t-8e-4],a,1)}return{vertices:new Float32Array(e),floorEnd:o}}var r=e=>e.map(t=>t/Math.hypot(...e)),i=([e,t,n],[r,i,a])=>[t*a-n*i,n*r-e*a,e*i-t*r],a=r([-.72,1,.55]),o=r([a[2],0,-a[0]]),s=i(a,o),c=n(),l=36,u=512,d=`depth24plus`,f=[{arrayStride:l,attributes:[{shaderLocation:0,offset:0,format:`float32x3`},{shaderLocation:1,offset:12,format:`float32x3`},{shaderLocation:2,offset:24,format:`float32`},{shaderLocation:3,offset:28,format:`float32x2`}]}],p=[{arrayStride:l,attributes:[f[0].attributes[0]]}];function m(){let t,n,l,m,h,g,_,v,y,b,x,S,C,w,T=34,E=0,D,O,k;function A(e){n=e,t=e.gpu,h=t.createBuffer({label:`lightwell settings`,size:128,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.UNIFORM}),g=t.createBuffer({label:`display plinth`,size:c.vertices.byteLength,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.VERTEX}),t.queue.writeBuffer(g,0,c.vertices),m=t.createTexture({label:`lightwell shadow map`,size:[u,u],format:d,usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.RENDER_ATTACHMENT}),y&&M(y)}function j(){l?.destroy(),m?.destroy(),h?.destroy(),g?.destroy(),_?.destroy(),l=m=h=g=_=b=x=S=C=void 0,w=D=O=v=void 0}function M(e){y=e;let n=e.byteLength;(!_||n>v)&&(_?.destroy(),v=Math.max(65536,2**Math.ceil(Math.log2(n))),_=t.createBuffer({label:`dual contour triangles`,size:v,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.VERTEX})),t.queue.writeBuffer(_,0,e)}function N(n){let r=t.createShaderModule({label:`Lightwell studio`,code:e});b=t.createRenderPipeline({label:`Lightwell main pass`,layout:`auto`,vertex:{module:r,entryPoint:`vertex`,buffers:f},fragment:{module:r,entryPoint:`fragment`,targets:[{format:n}]},primitive:{cullMode:`back`},depthStencil:{format:d,depthWriteEnabled:!0,depthCompare:`greater`}}),x=t.createRenderPipeline({label:`Lightwell depth pass`,layout:`auto`,vertex:{module:r,entryPoint:`depthVertex`,buffers:p},primitive:{cullMode:`back`},depthStencil:{format:d,depthWriteEnabled:!0,depthCompare:`less`}});let i={binding:0,resource:{buffer:h}};S=t.createBindGroup({layout:b.getBindGroupLayout(0),entries:[i,{binding:1,resource:m.createView()}]}),C=t.createBindGroup({layout:x.getBindGroupLayout(0),entries:[i]}),w=n}function P(e,t){let n=e/t,c=T*Math.PI/180,l=[Math.sin(c)*1.67,1.09,Math.cos(c)*1.67],u=.169-.057*Math.min(1,Math.max(0,(n-1.32)/.63)),d=r([-l[0],u-l[1],-l[2]]),f=r([-d[2],0,d[0]]),p=i(f,d),m=.353*Math.max(1,1.355/n);return new Float32Array([...l,1,...d,1,...f,m*n,...p,m,...a,1,...o,1,...s,1,E,e,t,0])}function F(e){if(!y)return;w!==e.format&&N(e.format);let r=n.canvas.width,i=n.canvas.height;if((D!==r||O!==i)&&(l?.destroy(),l=t.createTexture({label:`display depth`,size:[r,i],format:d,usage:GPUTextureUsage.RENDER_ATTACHMENT}),D=r,O=i),t.queue.writeBuffer(h,0,P(r,i)),k!==y){let t=e.encoder.beginRenderPass({colorAttachments:[],depthStencilAttachment:{view:m.createView(),depthClearValue:1,depthLoadOp:`clear`,depthStoreOp:`store`}});t.setPipeline(x),t.setBindGroup(0,C),t.setVertexBuffer(0,g),t.draw(c.vertices.length/9-c.floorEnd,1,c.floorEnd),t.setVertexBuffer(0,_),t.draw(y.length/9),t.end(),k=y}let a=e.encoder.beginRenderPass({colorAttachments:[{view:e.color,loadOp:`clear`,storeOp:`store`,clearValue:[.095,.125,.176,1]}],depthStencilAttachment:{view:l.createView(),depthClearValue:0,depthLoadOp:`clear`,depthStoreOp:`discard`}});a.setPipeline(b),a.setBindGroup(0,S),a.setVertexBuffer(0,g),a.draw(c.vertices.length/9),a.setVertexBuffer(0,_),a.draw(y.length/9),a.end()}return{name:`lightwell-studio`,setup:A,dispose:j,upload:M,onDeviceRestored(e){j(),k=void 0,A(e)},camera(e,t){T=e,E=+!!t},registerPasses(e){e.add({name:`render-lightwell`,order:1,execute:F})}}}var h={difference:`Remove the copper tool from the ivory casting to open a stepped lightwell.`,union:`Fuse the ivory casting with the copper tool. The exposed tool surfaces show what was added.`,intersection:`Keep the region shared by the casting and tool. It is the volume removed by Carve.`},g={difference:`Carve`,union:`Add`,intersection:`Overlap`},_=()=>new Promise(e=>requestAnimationFrame(e));async function v({engine:e,model:t,generate:n,canvas:r,notice:i,status:a,signal:o,size:s,fail:c}){let l=m();e.use(l);let u=e=>document.querySelector(`#`+e),d=[...document.querySelectorAll(`[name=operation]`)],f=u(`width`),p=u(`orbit`),v=u(`wire`),y=[f,p,v,...d],b=r.dataset,x=e.gpu.adapterInfo?.vendor===`margo-webgl2`;u(`route`).textContent=x?`Margo WebGL2`:`Margo WebGPU`,b.renderer=x?`compatibility`:`webgpu`;let S=`difference`,C={mode:`difference`,width:118,data:t},w=null,T=!1,E=!0;function D(){let{mode:e,width:t,data:n}=C,i=Number(p.value);b.mode=e,b.width=String(t),b.orbit=String(i),b.wire=String(v.checked),b.triangles=String(n.triangles),b.volume=String(n.volume),b.edgeSolves=String(n.edgeSolves),b.edgeUses=String(n.cellEdgeUses),b.residual=String(n.residual),u(`width-value`).value=t+` mm`,u(`orbit-value`).value=i+`°`,u(`operation`).textContent=g[e],u(`description`).textContent=h[e],u(`stats`).textContent=n.triangles.toLocaleString(`en-US`)+` triangles · 38³ sampling grid`,r.setAttribute(`aria-label`,g[e]+` composition of an ivory architectural lightwell cast from a signed distance field`)}async function O(){if(!T){T=!0;try{for(;w&&!o.aborted;){let t=w;if(w=null,t.mode!==C.mode||t.width!==C.width){let e=await n(t.mode,t.width);if(o.throwIfAborted(),w&&(w.mode!==t.mode||w.width!==t.width))continue;l.upload(e.vertices),C={...t,data:e}}if(l.camera(Number(p.value),v.checked),e.render(0),await e.gpu.queue.onSubmittedWorkDone(),await _(),o.aborted)return;D(),t.trusted&&(performance.mark(`sharp-input-rendered`),E&&(E=!1,performance.mark(`sharp-first-input`)))}}catch(e){o.aborted||c(e)}finally{T=!1}}}function k(e){w={mode:S,width:Number(f.value),trusted:e.isTrusted},O()}l.upload(t.vertices),e.render(0),await e.gpu.queue.onSubmittedWorkDone(),o.throwIfAborted(),D(),a.ready(e),i.hidden=!0,y.forEach(e=>e.disabled=!1),b.ready=`true`,performance.mark(`sharp-ready`),f.addEventListener(`input`,k,{signal:o}),p.addEventListener(`input`,k,{signal:o}),v.addEventListener(`change`,k,{signal:o});for(let e of d)e.addEventListener(`change`,t=>{e.checked&&(S=e.value,k(t))},{signal:o});let A=new ResizeObserver(()=>{!o.aborted&&s()&&(w||={mode:S,width:Number(f.value),trusted:!1},O())});A.observe(r),o.addEventListener(`abort`,()=>A.disconnect(),{once:!0})}export{v as show};