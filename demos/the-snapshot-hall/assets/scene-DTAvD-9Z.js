var e=Math.PI*2,t=e=>e.map(t=>t/Math.hypot(...e)),n=(e,t)=>Array.from({length:3},(n,r)=>r===e?t:0),r=(...e)=>[0,1,2].map(t=>e.reduce((e,n)=>e+n[t],0));function i(e){let t=[],n=[];function r(e,r){let i=t.length/6;e.forEach((e,n)=>t.push(...e,...Array.isArray(r[n])?r[n]:r));for(let t=1;t<e.length-1;t++)n.push(i,i+t,i+t+1)}return e(r),{data:t,indices:n}}function a(e){let a=.5-e;return i(i=>{for(let e=0;e<3;e++)for(let t of[-1,1]){let o=(e+1)%3,s=(e+2)%3;i([[-1,-1],[1,-1],[1,1],[-1,1]].map(([i,c])=>r(n(e,t*.5),n(o,i*a),n(s,c*a))),n(e,t))}if(e){for(let e=0;e<3;e++)for(let o of[-1,1])for(let s of[-1,1]){let c=(e+1)%3,l=(e+2)%3,u=(t,i,u)=>r(n(e,t*a),n(c,o*i),n(l,s*u));i([u(-1,.5,a),u(1,.5,a),u(1,a,.5),u(-1,a,.5)],t(r(n(c,o),n(l,s))))}for(let e of[-1,1])for(let n of[-1,1])for(let r of[-1,1])i([[e*.5,n*a,r*a],[e*a,n*.5,r*a],[e*a,n*a,r*.5]],t([e,n,r]))}})}function o(n=24,r=0){let a=e=>.5-.022*r*(1-Math.cos(e*12)),o=(e,t)=>[Math.cos(e)*a(e),t,Math.sin(e)*a(e)],s=e=>t([Math.cos(e),0,Math.sin(e)]);return i(t=>{for(let r=0;r<n;r++){let i=r*e/n,a=(r+1)*e/n,c=s(i),l=s(a);t([o(i,-.5),o(a,-.5),o(a,.5),o(i,.5)],[c,l,l,c]),t([[0,.5,0],o(i,.5),o(a,.5)],[0,1,0]),t([[0,-.5,0],o(a,-.5),o(i,-.5)],[0,-1,0])}})}function s(e=32){let t=(e,t,n)=>[t*Math.cos(e),t*Math.sin(e),n];return i(n=>{for(let r=0;r<e;r++){let i=r*Math.PI/e,a=(r+1)*Math.PI/e,o=[Math.cos(i),Math.sin(i),0],s=[Math.cos(a),Math.sin(a),0],c=.963;n([t(i,c,-.5),t(a,c,-.5),t(a,c,.5),t(i,c,.5)],[o.map(e=>-e),s.map(e=>-e),s.map(e=>-e),o.map(e=>-e)]),n([t(i,1,-.5),t(a,1,-.5),t(a,1,.5),t(i,1,.5)],[o,s,s,o]);for(let e of[-.5,.5])n([t(i,c,e),t(a,c,e),t(a,1,e),t(i,1,e)],[0,0,e*2])}for(let e of[0,Math.PI])n([t(e,.963,-.5),t(e,1,-.5),t(e,1,.5),t(e,.963,.5)],[0,-1,0])})}function c(t=40){let n=(e,t,n)=>[t*Math.cos(e),t*Math.sin(e),n];return i(r=>{for(let i=0;i<t;i++){let a=i*e/t,o=(i+1)*e/t,s=[Math.cos(a),Math.sin(a),0],c=[Math.cos(o),Math.sin(o),0];r([[0,0,.5],n(a,.5,.5),n(o,.5,.5)],[0,0,1]),r([n(a,.5,.5),n(o,.5,.5),n(o,.5,-.5),n(a,.5,-.5)],[s,c,c,s]),r([[0,0,-.5],n(o,.5,-.5),n(a,.5,-.5)],[0,0,-1])}})}var l={stone:a(0),edge:a(.038),pipe:o(22),post:o(60,1),arch:s(),disc:c()},u=Object.fromEntries(Object.keys(l).map(e=>[e,[]])),d=e=>[0,2,4].map(t=>parseInt(e.slice(t,t+2),16)/255),f=(e,t)=>e.map(e=>e*t),p={slate:d(`48494c`),silver:d(`5d5852`),warmstone:d(`73675d`),blue:d(`425762`),dark:d(`252226`),oak:d(`6c432e`),brown:d(`8d5436`),mahogany:d(`563333`),brass:d(`a17a43`),steel:d(`53676e`),white:d(`c8af85`),lamp:d(`ffce8d`),teal:d(`507582`),azure:d(`63a5ac`),ivory:d(`b9af86`),rug:d(`704d46`)};function m(e,t,n,r,i=0,a=0){u[e].push(...t,...n,Math.sin(a),Math.cos(a),i,...r)}var h=(e,t,n,r=0)=>m(`stone`,e,t,n,r),g=(e,t,n,r=0)=>m(`edge`,e,t,n,r),_=(e,t,n,r=1)=>m(`pipe`,e,t,n,r),v=(e,t,n,r=0)=>m(`arch`,e,t,n,r),y=(e,t,n,r=1)=>m(`disc`,e,t,n,r);function b(){h([0,-.147,-12.9],[10.8,.22,39.9],p.dark);for(let e=0;e<30;e++)for(let t=0;t<10;t++){let n=(t+e)%3;h([(t-4.5)*1.03,-.021,5.9-e*1.27],[1.014,.069,1.254],n===0?p.silver:n===1?p.slate:p.warmstone)}h([0,.021,-12.7],[2.33,.012,37],p.rug,6);for(let e of[-1.13,-1.05,1.05,1.13])h([e,.028,-12.7],[.018,.004,36.96],p.brass,1);for(let e=0;e<32;e++){let t=5.22-e*1.16;_([0,.029,t],[.184,.003,.184],f(p.brass,.79),1),g([0,.029,t],[1.92,.006,.016],f(p.brass,.72),1)}}function x(){for(let e of[-1,1])h([e*4.99,2.12,-12.4],[.37,4.64,39],p.dark),g([e*4.59,3.52,-12.4],[.98,.19,39],p.oak,2),g([e*4.63,3.78,-12.4],[.79,.112,39],p.brass,1),g([e*4.71,.182,-12.4],[.48,.31,39],p.mahogany,2);for(let e=0;e<=10;e++){let t=5.35-e*3.39;v([0,3.7,t-1.68],[4.91,3.17,3.405],f(p.blue,1-e%3*.06)),v([0,3.65,t],[4.94,3.18,.245],p.oak,2),v([0,3.58,t+.103],[4.88,3.16,.055],p.brass,1),v([0,3.59,t-.102],[4.88,3.16,.052],p.brass,1);let n=f(p.steel,.83+e%4*.06);for(let e=1;e<=3;e++)v([0,3.698,t-e*.847],[4.774,3.077,.034],n,1);for(let e=0;e<12;e++){let n=(e+.5)*Math.PI/12,r=4.79*Math.cos(n),i=3.69+3.065*Math.sin(n),a=[.011+.021*Math.abs(Math.cos(n)),.012+.021*Math.sin(n),3.16];h([r,i,t-1.724],a,f(p.steel,.93),1)}if(e===0||e===3||e===6||e===9){let e=t-1.28;_([0,5.84,e],[.041,1.61,.041],p.steel),_([0,5.081,e],[.42,.053,.42],p.brass),_([0,4.954,e],[.3,.203,.3],p.lamp,4),_([0,4.84,e],[.225,.029,.225],p.brass)}if(e!==10)for(let e of[-1,1]){let n=e*3.99;m(`post`,[n,1.83,t],[.22,3.38,.22],p.oak,2),_([n,.16,t],[.39,.3,.39],p.mahogany,2),_([n,.337,t],[.3,.048,.3],p.brass),_([n,3.5,t],[.41,.16,.39],p.mahogany,2),_([n,3.59,t],[.44,.064,.42],p.brass),g([e*3.7,3.1,t],[.2,.32,.25],p.mahogany,2),_([e*3.64,2.94,t],[.107,.39,.107],p.brass),_([e*3.59,3.015,t],[.168,.196,.172],p.lamp,4),_([e*3.596,3.124,t],[.196,.031,.195],p.brass),_([e*3.596,2.902,t],[.185,.035,.182],p.brass)}}}function S(){for(let e=0;e<10;e++){let t=3.655-e*3.39;for(let n of[-1,1]){g([n*4.27,1.713,t],[.68,3.22,2.925],p.mahogany,2),g([n*3.93,.245,t],[.234,.24,2.95],p.dark),g([n*3.95,3.323,t],[.26,.127,3.01],p.oak,2),g([n*3.81,3.335,t],[.031,.031,2.94],p.brass,1);for(let e of[-1,1])g([n*3.878,1.74,t+e*1.441],[.111,2.961,.106],p.mahogany,2),g([n*3.81,1.74,t+e*1.455],[.013,2.955,.014],p.brass,1);for(let r=0;r<9;r++){let i=.58+r*.305;for(let a=0;a<6;a++){let o=t+(a-2.5)*.452,s=.79+.19*((17*e+11*r+7*a+(n+1)*3)%9)/8,c=f((r*7+a+e)%6==0?p.brown:p.oak,s);g([n*3.868,i,o],[.135,.267,.407],c,2),g([n*3.79,i+.049,o],[.022,.066,.126],p.brass,1),h([n*3.776,i+.049,o],[.007,.041,.087],f(p.white,.91),3),g([n*3.768,i-.039,o],[.064,.023,.126],p.brass,1)}}for(let e=0;e<=3;e++)g([n*3.78,.442+e*.915,t],[.012,.014,2.775],p.brass,1)}}}function C(){h([0,3.5,-30.14],[10.4,7.19,.47],p.blue);for(let e of[-1,1]){g([e*2.58,2.75,-29.66],[.21,5.34,.279],p.mahogany,2),g([e*2.83,2.76,-29.62],[.048,5.28,.128],p.brass,1),g([e*3.45,2.57,-29.77],[.84,4.9,.14],p.slate);for(let t=0;t<5;t++)g([e*(3.17+t*.14),2.57,-29.64],[.021,4.798,.05],p.steel,1)}let e=2.83;y([0,e,-29.55],[3.9,3.9,.18],p.dark),y([0,e,-29.43],[3.7,3.7,.18],p.brass,1),y([0,e,-29.326],[3.575,3.575,.122],p.steel,1),y([0,e,-29.258],[3.425,3.425,.106],p.teal,5),y([0,e,-29.194],[2.892,2.892,.084],p.azure,5),y([0,e,-29.144],[1.618,1.618,.063],p.steel,1),y([0,e,-29.106],[.818,.818,.057],p.white,4);for(let t=0;t<12;t++){let n=t*Math.PI/6,r=Math.cos(n),i=Math.sin(n);y([1.23*r,e+1.23*i,-29.096],[.219,.219,.058],p.brass,1),y([1.23*r,e+1.23*i,-29.06],[.139,.139,.035],p.lamp,4),y([1.535*r,e+1.535*i,-29.161],[.073,.073,.054],p.ivory,4)}g([0,.245,-29.18],[3.67,.17,1.03],p.brown,2);for(let e=0;e<4;e++)g([0,.07+e*.077,-28.77-e*.19],[4.02-e*.14,.075,.38],p.steel)}function w(){for(let e of Object.values(u))e.length=0;b(),x(),S(),C();let e=[],t=[],n=[],r=[];for(let[i,{data:a,indices:o}]of Object.entries(l)){let s=t.length,c=e.length/6,l=n.length/12,d=u[i];e.push(...a);for(let e of o)t.push(c+e);for(let e of d)n.push(e);let f=d.length/12;r.push({first:s,length:o.length,start:l,count:f})}return{vertices:new Float32Array(e),indices:new Uint32Array(t),instances:new Float32Array(n),ranges:r,parts:n.length/12,triangles:r.reduce((e,{length:t,count:n})=>e+t*n/3,0)}}var T=`struct HallCamera {
  eye:vec4f,
  direction:vec4f,
  right:vec4f,
  vertical:vec4f,
}
@group(0) @binding(0) var<uniform> camera:HallCamera;
struct Surface {
  @builtin(position) clip:vec4f,
  @location(0) point:vec3f,
  @location(1) n:vec3f,
  @location(2) albedo:vec3f,
  @location(3) @interpolate(flat) kind:f32,
  @location(4) detail:vec3f,
}
fn turn(p:vec3f,angle:vec3f)->vec3f {
  return vec3f(p.x*angle.y+p.z*angle.x,p.y,p.z*angle.y-p.x*angle.x);
}
@vertex fn vertex(@location(0) local:vec3f,@location(1) normal:vec3f,
    @location(2) offset:vec3f,@location(3) scale:vec3f,@location(4) flags:vec3f,
    @location(5) base:vec3f)->Surface {
  let world=turn(local*scale,flags)+offset;
  let n=normalize(turn(normal/scale,flags));
  let q=world-camera.eye.xyz;
  let clip=vec4f(dot(q,camera.right.xyz)/camera.right.w,dot(q,camera.vertical.xyz)/camera.vertical.w,
    .105,dot(q,camera.direction.xyz));
  return Surface(clip,world,n,base,flags.z,local);
}
fn wick(p:vec3f,n:vec3f,eye:vec3f,position:vec3f,metal:f32)->vec2f {
  let delta=position-p;
  let d2=dot(delta,delta);
  let toward=delta*inverseSqrt(max(.005,d2));
  let diffuse=max(0.0,dot(n,toward));
  let halfVector=normalize(toward+eye);
  let reflection=pow(max(0.0,dot(n,halfVector)),mix(28,62,metal));
  let falloff=1.0/(.82+d2*.47);
  return vec2f(diffuse,reflection)*falloff;
}
fn grain(p:vec3f)->f32 {
  let phase=p.y*97+17*sin(p.z*2.84+p.x*4.41);
  return sin(phase+sin(p.y*31.03+p.z*1.82)*1.71)*.023;
}
@fragment fn surface(f:Surface)->@location(0) vec4f {
  let p=f.point;
  let n=normalize(f.n);
  let towardEye=normalize(camera.eye.xyz-p);
  let finish=f.kind;
  let metal=select(0.0,1.0,finish==1.0);
  let beam=round((5.35-p.z)/3.39);
  let lampZ=5.35-clamp(beam,0.0,9.0)*3.39;
  let a=wick(p,n,towardEye,vec3f(-3.575,3.04,lampZ),metal);
  let b=wick(p,n,towardEye,vec3f(3.575,3.04,lampZ),metal);
  let c=wick(p,n,towardEye,vec3f(0,2.92,-28.91),metal);
  let close=wick(p,n,towardEye,vec3f(-.70,4.2,5.85),metal);
  let overheadZ=4.07-clamp(round((4.07-p.z)/10.17),0.0,3.0)*10.17;
  let overhead=wick(p,n,towardEye,vec3f(0,4.953,overheadZ),metal);
  let amber=a+b;
  let crown=smoothstep(2.7,5.55,p.y);
  let seam=.026*sin(p.y*5.8+p.x*4.7)*sin(p.z*8.9+p.x*2.4);
  let key=.29+.23*max(0.0,dot(n,normalize(vec3f(.31,.80,.53))));
  let low=mix(vec3f(.66,.74,.91),vec3f(.49,.63,.89),crown)*(key+.16);
  let cabinetCorner=.75+.25*smoothstep(.28,.67,p.y);
  let shade=(low+vec3f(1.11,.63,.37)*amber.x*.73+vec3f(.27,.68,.87)*c.x*.64+
      vec3f(1.04,.78,.51)*(close.x*.47+overhead.x*1.58))*cabinetCorner;
  var texture=1.0+seam;
  if(finish==2.0){texture+=grain(p)+grain(p*3.13)*.21;}
  if(finish==3.0){
    let ruled=1-smoothstep(.025,.062,abs(fract((f.detail.y+.36)*7.0+.45)-.5));
    let inner=1-smoothstep(.26,.43,abs(f.detail.z));
    texture-=ruled*inner*.22;
  }
  if(finish==6.0){
    let dia=length(fract(p.xz*vec2f(3.42,3.82))-.5);
    texture+=.055*sin(dia*46.7)-.08*smoothstep(.31,.47,abs(p.x)*.41);
  }
  let bright=vec3f(1,.70,.42)*(amber.y+close.y*.55+overhead.y*.43)*(.07+metal*.28)+
      vec3f(.47,.82,1)*c.y*.24;
  let ambientGlint=metal*vec3f(.21,.23,.25)*(.31+pow(1-max(dot(towardEye,n),0.0),2.5)*.53);
  var color=f.albedo*shade*texture+bright+ambientGlint;
  if(finish==4.0){
    let edge=pow(max(0.0,dot(n,towardEye)),.58);
    color=f.albedo*(.83+edge*.25)+vec3f(.16,.075,.018)*edge;
  }
  if(finish==5.0){
    let shape=length(f.detail.xy);
    let etched=(.87+.13*sin(f.detail.x*124.0)*sin(f.detail.y*118.0));
    color=f.albedo*(1.08+.13*sin(shape*77.0))*etched+vec3f(.032,.077,.085);
  }
  let range=length(p-camera.eye.xyz);
  let far=smoothstep(17.0,39.0,range)*.39;
  return vec4f(mix(max(vec3f(0),color),vec3f(.125,.163,.189),far),1);
}\r
\r
`,E=e=>e.map(t=>t/Math.hypot(...e)),D=([e,t,n],[r,i,a])=>[t*a-n*i,n*r-e*a,e*i-t*r],O=`depth24plus`,k=[{arrayStride:24,attributes:[{shaderLocation:0,offset:0,format:`float32x3`},{shaderLocation:1,offset:12,format:`float32x3`}]},{arrayStride:48,stepMode:`instance`,attributes:[{shaderLocation:2,offset:0,format:`float32x3`},{shaderLocation:3,offset:12,format:`float32x3`},{shaderLocation:4,offset:24,format:`float32x3`},{shaderLocation:5,offset:36,format:`float32x3`}]}];function A(e,t){let n=e*.01,r=[.39+n*.92,1.83+n*.08,6.48-n*12.9],i=E([-.24*n-.075,2.96-r[1],-(23+r[2])]),a=E([-i[2],0,i[0]]),o=D(a,i),s=.448*Math.max(1,1.39/t);return new Float32Array([...r,1,...i,1,...a,s*t,...o,s])}function j(e){let t,n,r,i,a,o,s,c,l,u,d,f=0,p=0,m,h,g=`snapshot`,_=0,v={};function y(e,n,r){let i=t.createBuffer({label:e,size:n.byteLength,usage:r|GPUBufferUsage.COPY_DST});return t.queue.writeBuffer(i,0,n),i}function b(s){n=s,t=n.gpu,r=y(`Archive shapes`,e.vertices,GPUBufferUsage.VERTEX),i=y(`Archive shape index groups`,e.indices,GPUBufferUsage.INDEX),a=y(`Archive part transforms`,e.instances,GPUBufferUsage.VERTEX),o=t.createBuffer({label:`Archive camera`,size:64,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST})}function x(){r?.destroy(),i?.destroy(),a?.destroy(),o?.destroy(),s?.destroy(),d=s=c=l=u=m=h=void 0}function S(e){let n=t.createShaderModule({label:`Hall materials`,code:T});l=t.createRenderPipeline({label:`Static archive`,layout:`auto`,vertex:{module:n,entryPoint:`vertex`,buffers:k},fragment:{module:n,entryPoint:`surface`,targets:[{format:e}]},depthStencil:{format:O,depthWriteEnabled:!0,depthCompare:`greater`}}),u=t.createBindGroup({layout:l.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:o}}]}),d=void 0,c=e}function C(e){e.setPipeline(l),e.setBindGroup(0,u),e.setVertexBuffer(0,r),e.setVertexBuffer(1,a),e.setIndexBuffer(i,`uint32`)}function w(t,n){C(t);let r=0;for(let{first:i,length:a,start:o,count:s}of e.ranges)if(n)t.drawIndexed(a,s,i,0,o),r++;else for(let e=0;e<s;e++)t.drawIndexed(a,1,i,0,o+e),r++;return r}function E(){let e=t.createRenderBundleEncoder({label:`Archive snapshot`,colorFormats:[c],depthStencilFormat:O});f=w(e,!1),d=e.finish(),p++}function D(e){c!==e.format&&S(e.format);let r=n.canvas.width,i=n.canvas.height;(m!==r||h!==i)&&(s?.destroy(),s=t.createTexture({size:[r,i],format:O,usage:GPUTextureUsage.RENDER_ATTACHMENT}),m=r,h=i),t.queue.writeBuffer(o,0,A(_,r/i)),g===`snapshot`&&!d&&E();let a=e.encoder.beginRenderPass({colorAttachments:[{view:e.color,loadOp:`clear`,storeOp:`store`,clearValue:[.049,.067,.086,1]}],depthStencilAttachment:{view:s.createView(),depthClearValue:0,depthLoadOp:`clear`,depthStoreOp:`discard`}}),l=performance.now(),u=1;g===`snapshot`?a.executeBundles([d]):u=w(a,g===`batch`);let y=performance.now()-l;a.end(),v={calls:u,milliseconds:y,recordCount:p,draws:f}}return{name:`static-archive`,setup:b,dispose:x,onDeviceRestored(e){x(),b(e)},configure(e,t){g=e,_=t},stats:()=>v,registerPasses(e){e.add({name:`archive-view`,order:1,execute:D})}}}var M=()=>new Promise(e=>requestAnimationFrame(e)),N={snapshot:`Replay one recorded GPU bundle. The hall’s parts keep their original draw commands.`,direct:`Encode a separate draw for every part, using the same meshes and camera.`,batch:`Draw each shape group as one indexed instanced batch.`};async function P({engine:e,canvas:t,notice:n,status:r,signal:i,size:a,fail:o}){let s=e=>document.querySelector(`#`+e),c=[...document.querySelectorAll(`[name=mode]`)],l=s(`position`),u=t.dataset,d=e.gpu.adapterInfo?.vendor===`margo-webgl2`,f=w(),p=j(f);e.use(p),performance.mark(`snapshot-geometry`);let m=new Intl.NumberFormat(`en-US`);u.renderer=d?`compatibility`:`webgpu`,u.parts=String(f.parts),u.triangles=String(f.triangles),u.batches=String(f.ranges.length),s(`parts`).textContent=m.format(f.parts),s(`route`).textContent=d?`Margo WebGL2`:`Margo WebGPU`,s(`runtime`).textContent=d?`Compatibility replays this list as WebGL2 draws.`:`The GPU pass executes the recorded list.`;let h=`snapshot`,g=!0,_=!1,v=null;function y(e,t){let n=p.stats();u.mode=e,u.position=String(t),u.calls=String(n.calls),u.recording=String(n.recordCount),u.recordedDraws=String(n.draws),u.encodeTime=String(n.milliseconds),s(`commands`).textContent=m.format(n.calls),s(`encoding`).textContent=n.milliseconds===0?`Under timer`:n.milliseconds.toFixed(2)+` ms`,s(`description`).textContent=N[e],s(`movement`).value=(t*.129).toFixed(1)+` m`,s(`runtime`).hidden=e!==`snapshot`}async function b(){if(!_){_=!0;try{for(;v&&!i.aborted;){let{frameMode:t,position:n,trusted:r}=v;if(v=null,p.configure(t,n),e.render(0),await e.gpu.queue.onSubmittedWorkDone(),await M(),i.aborted)return;y(t,n),r&&(performance.mark(`snapshot-input-rendered`),g&&(g=!1,performance.mark(`snapshot-first-input`)))}}catch(e){i.aborted||o(e)}finally{_=!1}}}function x(e){v={frameMode:h,position:Number(l.value),trusted:e?.isTrusted??!1},b()}e.render(0),await e.gpu.queue.onSubmittedWorkDone(),i.throwIfAborted(),y(h,0),r.ready(e),n.hidden=!0,l.disabled=!1,c.forEach(e=>e.disabled=!1),u.ready=`true`,performance.mark(`snapshot-ready`),l.addEventListener(`input`,x,{signal:i});for(let e of c)e.addEventListener(`change`,t=>{e.checked&&(h=e.value,x(t))},{signal:i});let S=new ResizeObserver(()=>{!i.aborted&&a()&&x()});S.observe(t),i.addEventListener(`abort`,()=>S.disconnect(),{once:!0})}export{P as show};