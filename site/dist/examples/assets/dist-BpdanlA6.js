const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["./compat-CkmQH9nh-c7PKoIVD.js","./errors-B1DmBK5g-D4PiU2SF.js"])))=>i.map(i=>d[i]);
import{n as e,t}from"./version-DZ3BcJze.js";import{n}from"./extension-BytumP3S.js";import{n as r}from"./errors-B1DmBK5g-D4PiU2SF.js";import{t as i}from"./errors-DkwPZuAq.js";import{t as a}from"./preload-helper-CRzLMJPS.js";function o(e,t){if(!e||e[3]||e[7]||e[11])return null;let n=n=>e[n]*t[0]+e[4+n]*t[1]+e[8+n]*t[2]+e[12+n],r=Math.hypot(e[2],e[6],e[10]),i=n(2);return{sx:Math.hypot(e[0],e[4],e[8]),sy:Math.hypot(e[1],e[5],e[9]),sz:r,ox:n(0),oy:n(1),near:(i-1)/r,far:i/r}}var s=(e,t=`0.1.0`,r=import.meta.url)=>n(e,t,r);function c(e){return e?.view?.viewport}function l(e){let t=c(e);return t?[t[2],t[3]]:[e.width,e.height]}function u(e,t){let n=c(t);if(!n)return;e.setViewport(n[0],n[1],n[2],n[3],0,1);let r=t.view.scissor??n;e.setScissorRect(r[0],r[1],r[2],r[3])}function d(e,t=`clear`){return e?.view?.index?`load`:t}var f=(globalThis[Symbol.for(`margoengine.frame-resources`)]??={devices:new WeakMap}).devices;function p(e){let t=f.get(e);return t||(f.set(e,t={frame:0,open:!1,lost:!1,views:new Set,drawing:0,retired:[],written:new WeakMap}),e.lost?.then?.(()=>{t.lost=!0;let e=t.retired;t.retired=[];for(let t of e)t.destroy()})),t}function m(e,t){if(!t)return;let n=p(e),r=[t,...n.written.get(t)?.extras??[]];if(n.written.delete(t),!n.lost&&n.open&&(n.views.size>1||n.drawing>0))n.retired.push(...r);else for(let e of r)e.destroy()}function h(e,t,n=`full`){let i={ldr:0,"half-float":1,full:2};if(!Object.hasOwn(i,n))throw TypeError(`minimum must be full, half-float or ldr`);let a=e?.adapter?.capabilities?.tier;if(a&&i[a]<i[n])throw r(`unsupported`,`${t} requires the ${n} compatibility tier; this device is ${a}`,`compatibility-layer`)}function g(e){return e?.adapterInfo?.vendor===`margo-webgl2`?`webgl2`:`native`}function _(e){return g(e)===`native`&&e?.features?.has(`core-features-and-limits`)===!1}function v(e,t){return g(e)===`webgl2`?t():void 0}var y=`@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {return vec4f(array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3))[i],0,1);}`,b=(e,t,n)=>e.createBindGroup({layout:t.getBindGroupLayout(0),entries:[{binding:0,resource:n}]}),x=Symbol.for(`margoengine.optional.msaa`),S=y+`
@group(0) @binding(0) var source:texture_depth_multisampled_2d;
@fragment fn fragment(@builtin(position) p:vec4f)->@builtin(frag_depth) f32 {
 let q=vec2i(p.xy);
 return max(max(textureLoad(source,q,0),textureLoad(source,q,1)),max(textureLoad(source,q,2),textureLoad(source,q,3)));
}`;function C(e,t,n,r,i,a=!1){let o=e=>S.replace(/return max[^;]+;/,`return textureLoad(source,q,${e});`),s=(n,r)=>{let a=e.createShaderModule({code:n}),o=e.createRenderPipeline({layout:`auto`,vertex:{module:a,entryPoint:`vertex`},fragment:{module:a,entryPoint:`fragment`,targets:[]},depthStencil:{format:i,depthWriteEnabled:!0,depthCompare:`always`},multisample:r});return{pipeline:o,group:b(e,o,t)}};return{draws:a?[s(o(0).replace(`_multisampled`,``),{count:r})]:r===4?_(e)?[0,1,2,3].map(e=>s(o(e),{count:r,mask:1<<e})):[s(o(`i32(sample)`).replace(`p:vec4f)`,`p:vec4f,@builtin(sample_index) sample:u32)`),{count:r})]:[s(S,{count:r})],descriptor:{colorAttachments:[],depthStencilAttachment:{view:n,depthLoadOp:`clear`,depthClearValue:0,depthStoreOp:`store`,stencilReadOnly:!0}}}}var w=class{constructor(e,t,n,r=4){if(r!==1&&r!==4)throw RangeError(`Scene samples must be 1 or 4`);this.samples=r,this.device=e,this.resolvedColor=t,this.resolvedDepth=n,this.textures=[],this.pipelines=new Map;try{if(r===1){this.color=t.createView(),this.depth=n.createView();return}for(let r of[t,n])this.textures.push(e.createTexture({size:[r.width,r.height],format:r.format,sampleCount:4,usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING}));this.color=this.textures[0].createView(),this.depth=this.textures[1].createView(),this.resolution={colorAttachments:[{view:this.color,resolveTarget:t.createView(),loadOp:`load`,storeOp:`store`}]},this.finalResolution={colorAttachments:[{...this.resolution.colorAttachments[0],storeOp:`discard`}],depthStencilAttachment:{view:this.depth,depthLoadOp:`load`,depthStoreOp:`discard`,stencilReadOnly:!0}},this.depthSource=this.textures[1].createView({aspect:`depth-only`}),this.resolvedDepthView=n.createView()}catch(e){throw this.dispose(),e}}begin(e){(this.viewContext??={}).view=e.view,Object.assign(this.original??={},{color:e.color,depth:e.depth,format:e.format,descriptor:e.descriptor,owner:T(e)}),e.color=this.color,e.depth=this.depth,e.format=this.resolvedColor.format,this.baseDescriptor!==e.descriptor&&(this.baseDescriptor=e.descriptor,this.descriptor={...e.descriptor,depthStencil:{...e.descriptor.depthStencil,format:this.resolvedDepth.format},multisample:{count:this.samples}}),e.descriptor=this.descriptor,e[x]=this,this.retired=!1}copyDepth(e,t,n,r=this.resolvedDepth.format){let i=this.pipelines.get(n);i||this.pipelines.set(n,i=new Map);let a=i.get(r);a||(this.depthSource??=this.resolvedDepth.createView({aspect:`depth-only`}),i.set(r,a=C(this.device,this.depthSource,t,n,r,this.samples===1))),a.descriptor.depthStencilAttachment.view=t,a.descriptor.depthStencilAttachment.depthLoadOp=this.viewContext?.view?`load`:`clear`;let o=e.beginRenderPass(a.descriptor);this.viewContext&&u(o,this.viewContext);let s=a.draws;for(let e=0;e<s.length;e++)o.setPipeline(s[e].pipeline),o.setBindGroup(0,s[e].group),o.draw(3);o.end()}resolve(e,t=!1,n=!0){if(this.samples!==1){if(n&&this.copyDepth(e,this.resolvedDepthView,1),t){let t=this.viewContext?.view?`store`:`discard`;this.finalResolution.colorAttachments[0].storeOp=t,this.finalResolution.depthStencilAttachment.depthStoreOp=t,this.original&&this.copyDepth(e,this.original.depth,this.original.descriptor.multisample?.count??1,this.original.descriptor.depthStencil.format),this.retired=!0}e.beginRenderPass(t?this.finalResolution:this.resolution).end()}}restore(e){let t=this.original;this.samples===1?(Object.assign(e,{color:t.color,depth:t.depth,format:t.format,descriptor:t.descriptor}),e[x]=t.owner):(this.retired||this.copyDepth(e.encoder,t.depth,t.descriptor.multisample?.count??1,t.descriptor.depthStencil.format),Object.assign(e,{color:t.color,depth:t.depth,format:t.format,descriptor:t.descriptor}),e[x]=t.owner)}present(e){this.resolve(e.encoder,!0),this.restore(e);let t=e.descriptor.multisample?.count??1;if(!this.presentation||this.presentationFormat!==e.format||this.presentationSamples!==t){let n=this.device.createShaderModule({code:y+`@group(0) @binding(0) var source:texture_2d<f32>;@fragment fn fragment(@builtin(position) p:vec4f)->@location(0) vec4f{return textureLoad(source,vec2i(p.xy),0);}`});this.presentation=this.device.createRenderPipeline({layout:`auto`,vertex:{module:n,entryPoint:`vertex`},fragment:{module:n,entryPoint:`fragment`,targets:[{format:e.format}]},multisample:e.descriptor.multisample}),this.presentationGroup=b(this.device,this.presentation,this.resolvedColor.createView()),this.presentationFormat=e.format,this.presentationSamples=t}let n=this.presentationPass??={colorAttachments:[{view:e.color,loadOp:`clear`,storeOp:`store`}]};n.colorAttachments[0].view=e.color,n.colorAttachments[0].loadOp=d(e,`clear`);let r=e.encoder.beginRenderPass(n);r.setPipeline(this.presentation),r.setBindGroup(0,this.presentationGroup),u(r,e),r.draw(3),r.end()}dispose(){for(let e of this.textures)m(this.device,e);this.textures=[],this.pipelines.clear()}};function T(e){let t=e[x];return t?.color===e.color&&t.depth===e.depth?t:void 0}function E(e,t,n){return e.createBindGroup({layout:t.getBindGroupLayout(0),entries:n.map((e,t)=>({binding:t,resource:e}))})}function D(e,t,n,r={}){let i=e.createShaderModule({code:t});return e.createRenderPipeline({layout:`auto`,vertex:{module:i,entryPoint:`vertex`},fragment:{module:i,entryPoint:`fragment`,targets:[{format:n}]},...r})}function O(e,t,n=`main`){return e.createComputePipeline({layout:`auto`,compute:{module:e.createShaderModule({code:t}),entryPoint:n}})}var k=`fn pbrNeutral(input:vec3f)->vec3f {let x=min(input.r,min(input.g,input.b));let offset=select(0.04,x-6.25*x*x,x<0.08);var v=input-offset;let peak=max(v.r,max(v.g,v.b));if(peak<0.76){return v;}let newPeak=1.0-0.24*0.24/(peak+0.24-0.76);v*=newPeak/peak;return mix(v,vec3f(newPeak),1.0-1.0/(0.15*(peak-newPeak)+1.0));}
fn toDisplay(c:vec3f)->vec3f {let x=pbrNeutral(max(c,vec3f(0)));return select(x*12.92,1.055*pow(x,vec3f(1.0/2.4))-0.055,x>=vec3f(0.0031308));}
`,A=/let mapped=pbrNeutral\([\s\S]*?return vec4f\([^\n]+\);/,j=e=>e.replace(A,`return vec4f(linear,1);`),M=e=>`${e} requires the standard core lighting shader; remove the plugin that replaced core's shader`,N=`struct Params {lens:vec4f,frame:vec4f,ortho:vec4f}
@group(0) @binding(0) var<uniform> p:Params;`,P=`var<workgroup> lanes:array<f32,64>;
var<workgroup> rows:array<f32,8>;
fn groupMax(v:f32,local:u32)->f32 {
  lanes[local]=v;workgroupBarrier();
  if(local<8u){var m=lanes[local*8u];for(var i=1u;i<8u;i++){m=max(m,lanes[local*8u+i]);}rows[local]=m;}
  workgroupBarrier();
  var m=rows[0];for(var i=1u;i<8u;i++){m=max(m,rows[i]);}return m;
}`,F=`${N}
@group(0) @binding(1) var depth:texture_depth_2d;
@group(0) @binding(2) var coc:texture_storage_2d<rg32float,write>;
@group(0) @binding(3) var tiles:texture_storage_2d<r32float,write>;
${P}
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u,@builtin(workgroup_id) tile:vec3u,@builtin(local_invocation_index) local:u32) {
  var near=0.0;
  if(all(id.xy<textureDimensions(coc))){
    let d=textureLoad(depth,vec2i(id.xy),0);
    let ortho=p.ortho.x>0.5;
    let z=select(p.frame.x*p.frame.y/(p.frame.x+d*(p.frame.y-p.frame.x)),mix(p.frame.y,p.frame.x,d),ortho);
    let radius=clamp(p.frame.z*select(1.0-p.lens.x/z,(z-p.lens.x)/p.lens.x,ortho),-p.lens.w,p.lens.w)*p.frame.w;
    textureStore(coc,vec2i(id.xy),vec4f(radius,z,0,0));near=-radius;
  }
  let m=groupMax(near,local);
  if(local==0u){textureStore(tiles,vec2i(tile.xy),vec4f(m,0,0,0));}
}`,I=e=>`var frontColor=vec3f(0);var frontWeight=0.0;var farTotal=farWeight;
  for(var i=0u;i<${e}u;i++){
    let farPixel=clamp(pixel+vec2i(round(spiral(i,${e}.0)*center.x)),vec2i(0),limit);
    let farCoC=textureLoad(coc,farPixel,0).xy;let farW=1.0;farTotal+=farW;
    if(farCoC.x>=0.0&&farCoC.y>=center.y-max(0.001,center.y*0.01)){farColor+=textureLoad(scene,farPixel,0).rgb;farWeight+=1.0;}
    else if(farCoC.x>0.5){
      let w=farW*covers(vec2f(farPixel-pixel),farCoC.x,pixel)*center.x*center.x/(farCoC.x*farCoC.x);
      frontColor+=textureLoad(scene,farPixel,0).rgb*w;frontWeight+=w;
    }
  }
  if(frontWeight>0.0){farColor=mix(farColor/farWeight,frontColor/frontWeight,min(frontWeight/farTotal,1.0));farWeight=1.0;}`,L=`@group(0) @binding(1) var scene:texture_2d<f32>;
@group(0) @binding(2) var coc:texture_2d<f32>;
fn spiral(i:u32,n:f32)->vec2f {
  let angle=f32(i)*2.39996323;
  return sqrt((f32(i)+0.5)/n)*vec2f(cos(angle),sin(angle));
}
fn covers(o:vec2f,radius:f32,pixel:vec2i)->f32 {return select(0.0,1.0,length(o)<=radius);}`,R=`${N}
${L}
@group(0) @binding(3) var coarse:texture_storage_2d<rgba16float,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u) {
  if(any(id.xy>=textureDimensions(coarse))){return;}
  let pixel=vec2i(id.xy)*2;let limit=vec2i(textureDimensions(coc))-1;let center=textureLoad(coc,pixel,0).xy;
  var farColor=textureLoad(scene,pixel,0).rgb;var farWeight=1.0;
  let wide=center.x>3.19&&p.frame.w!=0.0;
  if(wide){${I(64)}}
  textureStore(coarse,id.xy,vec4f(farColor/farWeight,select(0.0,center.y,wide)));
}`,z=`${N}
@group(0) @binding(1) var scene:texture_2d<f32>;
@group(0) @binding(2) var coc:texture_2d<f32>;
@group(0) @binding(3) var nearTaps:texture_storage_2d<rgba16float,write>;
@group(0) @binding(4) var nearShapes:texture_storage_2d<rgba16float,write>;
@group(0) @binding(5) var nearScene:texture_storage_2d<rgba16float,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u) {
  if(any(id.xy>=textureDimensions(nearTaps))||p.frame.w==0.0){return;}
  let at=vec2i(id.xy);let s=textureLoad(coc,at,0).xy;let color=textureLoad(scene,at,0).rgb;
  let g=select(0.0,1.0/max(s.x*s.x,1.0),s.x< -0.5);
  textureStore(nearTaps,at,vec4f(color*g,g));
  textureStore(nearShapes,at,vec4f(-s.x*g,s.y*g,0,0));
  textureStore(nearScene,at,vec4f(color,1));
}`,B=`@group(0) @binding(0) var tapsBelow:texture_2d<f32>;
@group(0) @binding(1) var shapesBelow:texture_2d<f32>;
@group(0) @binding(2) var sceneBelow:texture_2d<f32>;
@group(0) @binding(3) var nearTaps:texture_storage_2d<rgba16float,write>;
@group(0) @binding(4) var nearShapes:texture_storage_2d<rgba16float,write>;
@group(0) @binding(5) var nearScene:texture_storage_2d<rgba16float,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u) {
  if(any(id.xy>=textureDimensions(nearTaps))){return;}
  let last=vec2i(textureDimensions(tapsBelow))-1;var taps=vec4f(0);var shapes=vec4f(0);var plain=vec4f(0);
  for(var k=0;k<4;k++){
    let at=min(vec2i(id.xy)*2+vec2i(k%2,k/2),last);
    taps+=textureLoad(tapsBelow,at,0);shapes+=textureLoad(shapesBelow,at,0);plain+=textureLoad(sceneBelow,at,0);
  }
  textureStore(nearTaps,vec2i(id.xy),taps*0.25);
  textureStore(nearShapes,vec2i(id.xy),shapes*0.25);
  textureStore(nearScene,vec2i(id.xy),plain*0.25);
}`,V=(e,t)=>`var ${e}=textureSampleLevel(${t},filtered,at,low);if(blend>0.0){${e}=mix(${e},textureSampleLevel(${t},filtered,at,low+1.0),blend);}`,H=`${N}
${L}
@group(0) @binding(3) var result:texture_storage_2d<rgba16float,write>;
@group(0) @binding(4) var tiles:texture_2d<f32>;
@group(0) @binding(5) var coarse:texture_2d<f32>;
@group(0) @binding(6) var filtered:sampler;
@group(0) @binding(7) var nearTaps:texture_2d<f32>;
@group(0) @binding(8) var nearShapes:texture_2d<f32>;
@group(0) @binding(9) var nearScene:texture_2d<f32>;
${P}
fn disk(i:u32)->vec2f {return spiral(i,64.0);}
const tapArea=1.0;
fn nearLod(radius:f32)->f32 {return max(log2(radius*0.2215567*sqrt(tapArea)/1.7320508),0.0);}
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u,@builtin(workgroup_id) tile:vec3u,@builtin(local_invocation_index) local:u32) {
  let count=vec2i(textureDimensions(tiles));let footprint=1.5*exp2(min(ceil(nearLod(p.lens.w)),3.0));let reach=i32(ceil((p.lens.w+1.0+footprint)/8.0));let span=2*reach+1;
  var mine=0.0;
  for(var t=i32(local);t<span*span;t+=64){
    let o=vec2i(t%span,t/span)-reach;let at=vec2i(tile.xy)+o;
    if(all(at>=vec2i(0))&&all(at<count)){
      let m=textureLoad(tiles,at,0).x;let gap=vec2f(max(abs(o)*8-7,vec2i(0)));
      if(length(gap)<=m+1.0+footprint){mine=max(mine,m);}
    }
  }
  let nearMax=groupMax(mine,local);
  let size=textureDimensions(result);if(any(id.xy>=size)){return;}
  let pixel=vec2i(id.xy);let center=textureLoad(coc,pixel,0).xy;
  let sharp=textureLoad(scene,pixel,0);
  if(p.frame.w==0.0){textureStore(result,pixel,sharp);return;}
  var farColor=sharp.rgb;var farWeight=1.0;
  var nearColor=vec3f(0);var nearWeight=0.0;var backColor=vec3f(0);var backWeight=0.0;
  let limit=vec2i(size)-1;
  if(center.x>3.19){
    let q=pixel/2;let f=vec2f(pixel%2)*0.5;let last=vec2i(textureDimensions(coarse))-1;var up=vec4f(0);
    for(var k=0;k<4;k++){
      let o=vec2i(k%2,k/2);let w=mix(1.0-f.x,f.x,f32(o.x))*mix(1.0-f.y,f.y,f32(o.y));
      let s=textureLoad(coarse,min(q+o,last),0);
      if(w>0.0&&abs(s.w-center.y)<=0.05*center.y){up+=vec4f(s.rgb,1.0)*w;}
    }
    if(up.w>0.999){farColor=up.rgb;farWeight=up.w;}else{${I(64)}}
  }else if(center.x>2.26){${I(32)}}else if(center.x>0.5){${I(16)}}
  let reachTaps=select(0u,64u,nearMax>0.5);let R=min(p.lens.w,nearMax+1.0);let lod=min(nearLod(R),3.0);
  let low=floor(lod);let blend=lod-low;
  let nearSize=vec2f(textureDimensions(nearTaps));
  for(var i=0u;i<reachTaps;i++){
    let nearTap=disk(i)*R;let nearPixel=pixel+vec2i(round(nearTap));
    if(any(nearPixel<vec2i(0))||any(nearPixel>limit)){continue;}
    let at=(vec2f(pixel)+0.5+nearTap)/nearSize;${V(`source`,`nearTaps`)}
    var share=0.0;var tint=vec3f(0);
    if(source.w>0.0){
      ${V(`nearForm`,`nearShapes`)}let form=nearForm.xy/source.w;let radius=form.x;tint=source.rgb/source.w;
      if(form.y<=center.y+max(0.001,center.y*0.01)){
        share=min(source.w*max(radius*radius,1.0),1.0);
        let inside=clamp(radius-length(nearTap)+0.5,0.0,1.0);
        let weight=R*R*source.w*inside;
        nearColor+=tint*weight;nearWeight+=weight;
      }
    }
    if(center.x< -0.5&&share<1.0&&covers(nearTap,-center.x,pixel)>0.0){
      ${V(`behind`,`nearScene`)}backColor+=max(behind.rgb-tint*share,vec3f(0));backWeight+=1.0-share;
    }
  }
  if(center.x< -0.5){
    let weight=R*R/(center.x*center.x);nearColor+=sharp.rgb*weight;nearWeight+=weight;
    if(backWeight>0.0){farColor=backColor;farWeight=backWeight;}
  }
  let coverage=clamp(nearWeight/64.0,0.0,1.0);
  let color=mix(farColor/farWeight,nearColor/max(nearWeight,0.0001),coverage);
  textureStore(result,pixel,vec4f(color,sharp.a));
}`,U=`
@group(0) @binding(0) var scene:texture_2d<f32>;
@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
  let xy=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));return vec4f(xy[i],0,1);
}
${k}
@fragment fn fragment(@builtin(position) pos:vec4f)->@location(0) vec4f {
  let c=textureLoad(scene,vec2i(pos.xy),0);return vec4f(toDisplay(c.rgb),c.a);
}`,W=`@group(0) @binding(0) var scene:texture_2d<f32>;
@group(0) @binding(1) var coc:texture_2d<f32>;
@group(0) @binding(2) var halfScene:texture_storage_2d<rgba16float,write>;
@group(0) @binding(3) var halfCoc:texture_storage_2d<rg32float,write>;
@group(0) @binding(4) var tiles:texture_storage_2d<r32float,write>;
${P}
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u,@builtin(workgroup_id) tile:vec3u,@builtin(local_invocation_index) local:u32) {
  var near=0.0;
  if(all(id.xy<textureDimensions(halfCoc))){
    let last=vec2i(textureDimensions(coc))-1;var color=vec4f(0);var c=vec2f(0,3.4e38);
    for(var k=0;k<4;k++){
      let at=min(vec2i(id.xy)*2+vec2i(k%2,k/2),last);color+=textureLoad(scene,at,0);
      let s=textureLoad(coc,at,0).xy;if(s.y<c.y){c=s;}
    }
    textureStore(halfScene,vec2i(id.xy),color*0.25);textureStore(halfCoc,vec2i(id.xy),vec4f(c.x*0.5,c.y,0,0));near=-c.x*0.5;
  }
  let m=groupMax(near,local);
  if(local==0u){textureStore(tiles,vec2i(tile.xy),vec4f(m,0,0,0));}
}`,G=`@group(0) @binding(0) var scene:texture_2d<f32>;
@group(0) @binding(1) var coc:texture_2d<f32>;
@group(0) @binding(2) var blurred:texture_2d<f32>;
@group(0) @binding(3) var result:texture_storage_2d<rgba16float,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u) {
  if(any(id.xy>=textureDimensions(result))){return;}
  let pixel=vec2i(id.xy);let sharp=textureLoad(scene,pixel,0);
  let g=(vec2f(pixel)+0.5)*0.5-0.5;let q=vec2i(floor(g));let f=g-floor(g);let last=vec2i(textureDimensions(blurred))-1;
  let b=mix(mix(textureLoad(blurred,clamp(q,vec2i(0),last),0),textureLoad(blurred,clamp(q+vec2i(1,0),vec2i(0),last),0),f.x),
    mix(textureLoad(blurred,clamp(q+vec2i(0,1),vec2i(0),last),0),textureLoad(blurred,clamp(q+vec2i(1,1),vec2i(0),last),0),f.x),f.y);
  let w=max(smoothstep(0.5,1.5,abs(textureLoad(coc,pixel,0).x)),b.a);
  textureStore(result,pixel,vec4f(mix(sharp.rgb,b.rgb,w),sharp.a));
}`;function K(e){let t=e=>{let t=e.split(`f32(i)*2.39996323`);if(t.length<2)throw new i(`unsupported`,`DOF temporal needs the gather kernels of its own version`);return t.join(`(f32(i)*2.39996323+p.ortho.w)`)},n=`textureStore(result,pixel,vec4f(color,sharp.a));`,r=`if(p.frame.w==0.0){textureStore(result,pixel,sharp);return;}`;if(e.bokehShader.split(n).length!==2||e.bokehShader.split(r).length!==2)throw new i(`unsupported`,`DOF temporal needs the gather kernels of its own version`);return{...e,coarseShader:t(e.coarseShader),bokehShader:t(e.bokehShader).replace(n,`textureStore(result,pixel,vec4f(color,coverage));`).replace(r,`if(p.frame.w==0.0){textureStore(result,pixel,vec4f(sharp.rgb,0));return;}`)}}var q=class n{coreRequirement=e(`0.1.0`,import.meta.url);constructor(e={}){this.options=e,this.name=`dof`,this.nearViews=[],this.nearBase=[],this.nearLevels=[],this.waiting=!1,this.groups=[],this.values=new Float32Array(12),this.halfValues=new Float32Array(12),this.turn=0,this.shaders=new Map,this.attachment={view:void 0,loadOp:`clear`,storeOp:`store`},this.presentation={colorAttachments:[this.attachment]},this.disposed=!1,this.key=``,this.validate()}static attach(r,i={}){t(r,e(`0.1.0`,import.meta.url));let a=new n(i);return s(r).use(a),a}get depthTexture(){return this.host?this.host.depthTexture:this.depth}get outputTexture(){return this.paused?this.scene:this.output}get focalLength(){return this.values[1]||(this.options.focalLength??.05)}get enabled(){return this.options.enabled??!0}set enabled(e){if(typeof e!=`boolean`)throw TypeError(`DOF enabled must be boolean`);this.options.enabled=e}joinStack(e){if(this.engine||this.host||this.disposed)throw new i(`attached`,`DOF is already attached; create a new DOF`);return this.host=e,{kind:`hdr`,render:(e,t,n)=>this.stage(e,t,n)}}validate(){let e=this.options,t=e.filmGauge,n=t===void 0?e.focalLength??.05:0,r=e.focalDistance??5,i=e.aperture??2.8,a=e.maxRadius??16;if(!Number.isFinite(Math.fround(n))||t===void 0&&Math.fround(n)<=0||!Number.isFinite(Math.fround(r))||Math.fround(r)<=Math.fround(n)||!Number.isFinite(Math.fround(i))||Math.fround(i)<=0||!Number.isFinite(a)||a<1||a>32||e.enabled!==void 0&&typeof e.enabled!=`boolean`||e.temporal!==void 0&&typeof e.temporal!=`boolean`)throw RangeError(`Invalid DOF options; use focalLength > 0, focalDistance > focalLength, aperture > 0, maxRadius from 1 to 32 and a boolean enabled and temporal`);if(t!==void 0&&!(Number.isFinite(t)&&t>0)||e.sensorFit!==void 0&&![`auto`,`horizontal`,`vertical`].includes(e.sensorFit))throw RangeError(`Invalid DOF filmGauge or sensorFit; use millimetres > 0 and 'auto', 'horizontal' or 'vertical'`)}setup(e){if(this.disposed||!e.gpu)throw new i(this.disposed?`disposed`:`unsupported`,`DOF requires WebGPU and a live effect; attach a new DOF to a WebGPU engine; see https://margoengine.com/errors#webgpu`);if(h(e.gpu,`DOF HDR processing`,`half-float`),!this.host&&(e.hasPlugin(`ssao`)||e.hasPlugin(`bloom`)||e.hasPlugin(`post-processing`)||e.hasPlugin(`tonemap`)&&!e.hasPlugin(this.name)))throw new i(`state`,`DOF owns scene capture; attach it before Tonemap, without SSAO or PostProcessing`);this.engine=e,this.uniform=e.gpu.createBuffer({size:48,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});let t={cocShader:F,coarseShader:R,bokehShader:H,groupMax:P},n=this.options.lens?.shaders(t)??t,r=this.options.temporal===!0,o=r?K(n):n;r&&(this.halfUniform=e.gpu.createBuffer({size:48,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),this.halvePipeline=O(e.gpu,W),this.joinPipeline=O(e.gpu,G)),this.cocPipeline=e.gpu.createComputePipeline({layout:`auto`,compute:{module:e.gpu.createShaderModule({code:o.cocShader}),entryPoint:`main`}}),this.bokehPipeline=O(e.gpu,o.bokehShader),this.coarsePipeline=O(e.gpu,o.coarseShader),this.nearPipeline=O(e.gpu,z),this.nearDownPipeline=O(e.gpu,B),this.nearSampler=e.gpu.createSampler({magFilter:`linear`,minFilter:`linear`,mipmapFilter:`linear`});let s=this.uniform,c=v(e.gpu,()=>a(()=>import(`./compat-CkmQH9nh-c7PKoIVD.js`),__vite__mapDeps([0,1]),import.meta.url));this.waiting=!!c,c?.then(({dofCompatPipelines:t})=>{if(this.uniform!==s)return;this.waiting=!1;let n=t(e.gpu,o,r?W:void 0);({coc:this.cocPipeline,tiles:this.tilesPipeline,bokeh:this.bokehPipeline}=n),r&&(this.halvePipeline=n.halve),this.releaseTextures()},e=>{throw this.waiting=!1,e})}get paused(){return this.waiting&&!this.host}registerPasses(e){e.add({name:`dof:capture`,order:-55,execute:e=>{e.backend===`webgpu`&&this.capture(e)}}),!this.host&&(e.add({name:`dof:coc`,order:20,execute:e=>{e.backend===`webgpu`&&!this.paused&&this.circles(e)}}),e.add({name:`dof:bokeh`,order:21,execute:e=>{e.backend===`webgpu`&&!this.paused&&this.blur(e)}}),e.add({name:`dof:present`,order:30,execute:e=>{e.backend===`webgpu`&&this.present(e)}}))}lens(e,t,n){let r=this.options.sensorFit??`auto`;return e/(2e3*Math.tan(t*Math.PI/360)*(r===`horizontal`||r===`auto`&&n>=1?n:1))}capture(e){this.validate();let t=this.options,n=this.values,[r,a]=l(e);if(n[0]=t.focalDistance??5,n[1]=t.filmGauge===void 0?t.focalLength??.05:this.lens(t.filmGauge,e.camera.fov,r/a),!(Math.fround(n[0])>Math.fround(n[1])))throw RangeError(`DOF focalDistance must lie beyond the focal length the camera gives, ${n[1]}`);n[2]=t.aperture??2.8,n[3]=t.maxRadius??16,n[4]=e.camera.near,n[5]=e.camera.far,n[6]=n[1]*a/(4*n[2]*(n[0]-n[1])*Math.tan(e.camera.fov*Math.PI/360)),n[7]=+this.enabled,n[8]=0,n[11]=+(!!this.tilesPipeline&&(e.descriptor.multisample?.count??4)>1);let s=o(e.camera.matrix,e.camera.position);if(s&&(n[4]=s.near,n[5]=s.far,n[6]=n[1]*a*s.sy*n[0]/(4*n[2]*(n[0]-n[1])),n[8]=1),t.lens?.write(n,e.camera,r/a),!Number.isFinite(n[6]))throw RangeError(`DOF lens scale exceeds float32; use a larger aperture or a focalDistance further from focalLength`);if(!this.host){if(this.engine.hasPlugin(`ssao`)||this.engine.hasPlugin(`post-processing`)||this.engine.hasPlugin(`bloom`))throw new i(`state`,`DOF cannot share scene capture with another post effect; put both effects in one PostStack`);this.resize(e),this.originalColor=e.color,this.originalDepth=e.depth;let t=this.shaders.get(e.shader);if(t===void 0){if(t=j(e.shader),t===e.shader)throw new i(`unsupported`,M(`DOF`));this.shaders.set(e.shader,t)}e.shader=t,this.captureTarget.begin(e)}if(e.device.queue.writeBuffer(this.uniform,0,n),this.halfUniform){let t=this.halfValues;t.set(n),t[3]=n[3]/2,t[11]=this.turn++*2.39996323%(2*Math.PI),e.device.queue.writeBuffer(this.halfUniform,0,t)}}resize(e){let t=e.descriptor.depthStencil.format;if(this.presentPipeline&&this.scene?.width===e.width&&this.scene.height===e.height&&this.format===e.format&&this.depthFormat===t&&this.captureTarget?.samples===(e.descriptor.multisample?.count??4))return;this.releaseTextures(),this.format=e.format,this.depthFormat=t;let n=GPUTextureUsage.TEXTURE_BINDING;this.scene=e.device.createTexture({size:[e.width,e.height],format:`rgba16float`,usage:n|GPUTextureUsage.RENDER_ATTACHMENT}),this.depth=e.device.createTexture({size:[e.width,e.height],format:t,usage:n|GPUTextureUsage.RENDER_ATTACHMENT}),this.targets(e.device,e.width,e.height),this.captureTarget=new w(e.device,this.scene,this.depth,e.descriptor.multisample?.count??4),this.sceneView=this.scene.createView(),this.depthView=this.depth.createView();let r=this.cocView,i=this.outputView,a=this.tileView,o=this.coarseView,s=e.device.createShaderModule({code:U});this.presentPipeline=e.device.createRenderPipeline({layout:`auto`,vertex:{module:s,entryPoint:`vertex`},fragment:{module:s,entryPoint:`fragment`,targets:[{format:e.format}]},multisample:e.descriptor.multisample}),this.groups=[this.cocGroup(e.device,this.depth,!0),this.halfUniform?void 0:e.device.createBindGroup({layout:this.bokehPipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.uniform}},{binding:1,resource:this.sceneView},{binding:2,resource:r},{binding:3,resource:i},{binding:4,resource:a},{binding:5,resource:o},{binding:6,resource:this.nearSampler},...this.nearViews.map((e,t)=>({binding:7+t,resource:e}))]}),e.device.createBindGroup({layout:this.presentPipeline.getBindGroupLayout(0),entries:[{binding:0,resource:i}]}),this.halfUniform?void 0:E(e.device,this.coarsePipeline,[{buffer:this.uniform},this.sceneView,r,o])],this.halfUniform||(this.groups[8]=this.nearGroup(e.device,{buffer:this.uniform},this.sceneView,r)),this.halfUniform&&this.halfGroups(e.device,this.sceneView)}halfGroups(e,t){let n={buffer:this.halfUniform},r=this.halfScene.createView(),i=this.halfCoc.createView(),a=this.halfTiles.createView(),o=this.blurred.createView();this.groups[1]=E(e,this.bokehPipeline,[n,r,i,o,a,this.coarseView,this.nearSampler,...this.nearViews]),this.groups[3]=E(e,this.coarsePipeline,[n,r,i,this.coarseView]),this.groups[8]=this.nearGroup(e,n,r,i),this.groups[5]=E(e,this.halvePipeline,[t,this.cocView,r,i,...this.tilesPipeline?[]:[a]]),this.groups[6]=E(e,this.joinPipeline,[t,this.cocView,o,this.outputView]),this.tilesPipeline&&(this.groups[7]=E(e,this.tilesPipeline,[i,a]))}nearGroup(e,t,n,r){return E(e,this.nearPipeline,[t,n,r,...this.nearBase])}cocGroup(e,t,n=!1){return this.tilesPipeline?(this.tilesGroup=E(e,this.tilesPipeline,[this.cocView,this.tileView]),E(e,this.cocPipeline,[{buffer:this.uniform},t.createView({aspect:`depth-only`}),this.cocView])):n?e.createBindGroup({layout:this.cocPipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.uniform}},{binding:1,resource:t.createView({aspect:`depth-only`})},{binding:2,resource:this.cocView},{binding:3,resource:this.tileView}]}):E(e,this.cocPipeline,[{buffer:this.uniform},t.createView({aspect:`depth-only`}),this.cocView,this.tileView])}circles(e){this.dispatch(e,this.cocPipeline,this.groups[0]),this.tilesPipeline&&!this.halvePipeline&&this.dispatch(e,this.tilesPipeline,this.tilesGroup,64),this.halvePipeline&&this.dispatch(e,this.halvePipeline,this.groups[5],16),this.tilesPipeline&&this.halvePipeline&&this.dispatch(e,this.tilesPipeline,this.groups[7],128)}blur(e){let t=this.halvePipeline?2:1;this.dispatch(e,this.nearPipeline,this.groups[8],8*t),this.nearLevels.forEach((n,r)=>this.dispatch(e,this.nearDownPipeline,n,16*t<<r)),this.dispatch(e,this.coarsePipeline,this.groups[3],16*t),this.dispatch(e,this.bokehPipeline,this.groups[1],8*t),this.joinPipeline&&this.dispatch(e,this.joinPipeline,this.groups[6])}dispatch(e,t,n,r=8){t===this.cocPipeline&&this.captureTarget?.resolve(e.encoder,!0);let i=e.encoder.beginComputePass();i.setPipeline(t),i.setBindGroup(0,n),i.dispatchWorkgroups(Math.ceil(e.width/r),Math.ceil(e.height/r)),i.end()}present(e){let t=this.paused;t&&(this.captureTarget.resolve(e.encoder,!0),this.groups[4]??=E(e.device,this.presentPipeline,[this.sceneView])),this.attachment.view=this.originalColor,this.attachment.loadOp=d(e,`clear`);let n=e.encoder.beginRenderPass(this.presentation);n.setPipeline(this.presentPipeline),n.setBindGroup(0,this.groups[t?4:2]),u(n,e),n.draw(3),n.end(),this.captureTarget.restore(e)}stage(e,t,n){let r=e.device,i=this.host.depthTexture,a=n.format+n.multisample.count;if((this.coc?.width!==e.width||this.coc.height!==e.height)&&(this.releaseTextures(),this.targets(r,e.width,e.height)),this.sceneDepth!==i&&(this.sceneDepth=i,this.groups[0]=this.cocGroup(r,i)),this.input!==t&&this.halfUniform?(this.input=t,this.halfGroups(r,t)):this.input!==t&&(this.input=t,this.groups[1]=E(r,this.bokehPipeline,[{buffer:this.uniform},t,this.cocView,this.outputView,this.tileView,this.coarseView,this.nearSampler,...this.nearViews]),this.groups[3]=E(r,this.coarsePipeline,[{buffer:this.uniform},t,this.cocView,this.coarseView]),this.groups[8]=this.nearGroup(r,{buffer:this.uniform},t,this.cocView)),this.circles(e),this.blur(e),n.hdr)return this.outputView;this.key!==a&&(this.key=a,this.presentPipeline=D(r,U,n.format,{multisample:n.multisample}),this.groups[2]=E(r,this.presentPipeline,[this.outputView])),this.attachment.view=n.view,this.attachment.loadOp=d(e,`clear`);let o=e.encoder.beginRenderPass(this.presentation);o.setPipeline(this.presentPipeline),o.setBindGroup(0,this.groups[2]),u(o,e),o.draw(3),o.end()}targets(e,t,n){let r=GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.STORAGE_BINDING;this.coc=e.createTexture({size:[t,n],format:`rg32float`,usage:r}),this.output=e.createTexture({size:[t,n],format:`rgba16float`,usage:r|GPUTextureUsage.COPY_SRC}),this.tiles=e.createTexture({size:[Math.ceil(t/8),Math.ceil(n/8)],format:`r32float`,usage:r});let i=this.halfUniform?2:1,a=Math.ceil(t/i),o=Math.ceil(n/i);this.coarse=e.createTexture({size:[Math.ceil(a/2),Math.ceil(o/2)],format:`rgba16float`,usage:r}),this.halfUniform&&(this.halfScene=e.createTexture({size:[a,o],format:`rgba16float`,usage:r}),this.halfCoc=e.createTexture({size:[a,o],format:`rg32float`,usage:r}),this.halfTiles=e.createTexture({size:[Math.ceil(a/8),Math.ceil(o/8)],format:`r32float`,usage:r}),this.blurred=e.createTexture({size:[a,o],format:`rgba16float`,usage:r}));let s=Math.min(4,Math.floor(Math.log2(Math.max(a,o)))+1),c=()=>e.createTexture({size:[a,o],format:`rgba16float`,usage:r,mipLevelCount:s}),l=[this.nearTaps=c(),this.nearShapes=c(),this.nearScene=c()],u=e=>l.map(t=>t.createView({baseMipLevel:e,mipLevelCount:1}));this.nearViews=l.map(e=>e.createView()),this.nearBase=u(0);let d=this.nearBase;this.nearLevels=[];for(let t=1;t<s;t++){let n=u(t);this.nearLevels.push(E(e,this.nearDownPipeline,[...d,...n])),d=n}this.cocView=this.coc.createView(),this.outputView=this.output.createView(),this.tileView=this.tiles.createView(),this.coarseView=this.coarse.createView()}releaseTextures(){this.captureTarget?.dispose(),this.captureTarget=void 0,this.scene?.destroy(),this.depth?.destroy(),this.coc?.destroy(),this.output?.destroy(),this.tiles?.destroy(),this.coarse?.destroy(),this.halfScene?.destroy(),this.halfCoc?.destroy(),this.halfTiles?.destroy(),this.blurred?.destroy(),this.nearTaps?.destroy(),this.nearShapes?.destroy(),this.nearScene?.destroy(),this.nearTaps=this.nearShapes=this.nearScene=void 0,this.nearViews=this.nearBase=[],this.nearLevels=[],this.scene=this.depth=this.coc=this.output=this.tiles=this.coarse=void 0,this.halfScene=this.halfCoc=this.halfTiles=this.blurred=void 0,this.sceneView=this.depthView=void 0,this.groups=[],this.presentPipeline=void 0,this.input=this.sceneDepth=this.cocView=this.outputView=this.tileView=this.coarseView=void 0,this.key=``}release(){this.releaseTextures(),this.uniform?.destroy(),this.halfUniform?.destroy(),this.uniform=this.halfUniform=void 0,this.halvePipeline=this.joinPipeline=void 0,this.cocPipeline=this.bokehPipeline=this.coarsePipeline=this.tilesPipeline=void 0,this.nearPipeline=this.nearDownPipeline=void 0,this.nearSampler=void 0,this.originalColor=this.originalDepth=void 0,this.shaders.clear()}onDeviceRestored(e){if(!this.disposed){this.release();try{this.setup(e)}catch(e){throw this.dispose(),e}}}dispose(){this.disposed||(this.disposed=!0,this.engine?.sceneOf(this)?.removePlugin(this.name),this.release(),this.engine=void 0)}[Symbol.dispose??Symbol()](){this.dispose()}destroy(){this.dispose()}};export{q as t};