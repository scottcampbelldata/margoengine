import{n as e,r as t}from"./index-CCzimiyJ.js";var n=`
@group(0) @binding(0) var weave:texture_2d<f32>;
const inks=array<vec3f,5>(${e.map(({rgb:e})=>`vec3f(`+e.map(e=>(e/255).toFixed(7)).join(`,`)+`)`).join(`,`)});
struct Cover {
  @builtin(position) screen:vec4f,
  @location(0) uv:vec2f,
}
@vertex fn vertex(@builtin(vertex_index) index:u32)->Cover {
  let triangle=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));
  let p=triangle[index];
  return Cover(vec4f(p,0,1),p*vec2f(.5,-.5)+.5);
}
fn tint(p:vec2f)->vec3f {
  let size=vec2i(textureDimensions(weave));
  let at=clamp(vec2i(floor(p*vec2f(size))),vec2i(0),size-1);
  let color=u32(round(textureLoad(weave,at,0).r*255.0));
  return inks[min(color,4u)];
}

@fragment fn fragment(input:Cover)->@location(0) vec4f {
  let uv=input.uv;
  let margin=vec2f(.033,.041);
  let q=(uv-margin)/(1-2*margin);
  let count=vec2f(textureDimensions(weave));
  let weaveIndex=q*count;
  let p=weaveIndex*3.0;
  let stitched=fract(p);
  let over=(i32(floor(p.x))+i32(floor(p.y)))%2==0;
  let warp=pow(max(.0,sin(stitched.x*3.1415927)),.55);
  let weft=pow(max(.0,sin(stitched.y*3.1415927)),.55);
  let crossLift=select(weft,warp,over);
  let under=select(warp,weft,over);
  let spacing=fract(weaveIndex);
  let edges=min(min(spacing.x,spacing.y),min(1-spacing.x,1-spacing.y));
  let depth=min(min(q.x,q.y),min(1-q.x,1-q.y));
  let px=fwidth(p.x)+fwidth(p.y);
  let visible=1.0-smoothstep(.87,2.31,px);
  let pulse=1.0+visible*((crossLift-.75)*.105+(under-.67)*.036);
  let overlap=.95+.05*smoothstep(.014,.15,edges);
  let key=1.083-.149*uv.x-.103*uv.y;
  let surface=tint(q)*pulse*overlap*key;
  let pile=tint(vec2f(q.x,select(0.0,1.0,q.y>.5)))*
    (.75+.17*warp)*key;
  let fringe=all(vec2f(q.x,1-q.x)>vec2f(0.0))&&
    depth<0.0&&depth>-.035*(.80+.19*sin(floor(p.x)*13.7))&&stitched.x>0.27;
  let backing=vec3f(.226,.218,.194)*(.82+.19*(1-uv.y));
  if(fringe){return vec4f(pile,1);}
  let shadow=1.0-(1.0-smoothstep(0,.013,abs(depth)))*.29;
  let border=select(backing*shadow,surface,depth>=0.0);
  return vec4f(clamp(border,vec3f(0),vec3f(1)),1);
}
`;function r(e){let t=e,r,i,a,o,s;function c(){r.queue.writeTexture({texture:i},t,{bytesPerRow:48,rowsPerImage:36},[48,36])}function l(){i?.destroy(),i=a=o=s=void 0}function u(e){r=e.gpu,i=r.createTexture({size:[48,36],format:`r8unorm`,usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST}),c()}function d(e){if(!a||s!==e.format){let t=r.createShaderModule({code:n});s=e.format,a=r.createRenderPipeline({layout:`auto`,vertex:{module:t,entryPoint:`vertex`},fragment:{module:t,entryPoint:`fragment`,targets:[{format:s}]}}),o=r.createBindGroup({layout:a.getBindGroupLayout(0),entries:[{binding:0,resource:i.createView()}]})}let t=e.encoder.beginRenderPass({colorAttachments:[{view:e.color,loadOp:`clear`,storeOp:`store`}]});t.setPipeline(a),t.setBindGroup(0,o),t.draw(3),t.end()}return{name:`swatch-cloth`,setup:u,onDeviceRestored(e){l(),u(e)},dispose:l,set(e){t=e,c()},registerPasses(e){e.add({name:`draw-woven-field`,order:1,execute:d})}}}var i=()=>new Promise(e=>requestAnimationFrame(e)),a=(e,t,n)=>Math.min(n,Math.max(t,e)),o=e=>{let t=2166136261;for(let n of e)t=Math.imul(t^n,16777619);return(t>>>0).toString(16).padStart(8,`0`)};function s(e,t){return t*12+e}function c(e){return[e%12,Math.floor(e/12)]}function l(e,t,n){let[r,i]=c(e),[a,o]=c(t),l=Math.abs(a-r),u=-Math.abs(o-i),d=r<a?1:-1,f=i<o?1:-1,p=l+u;for(;;){if(n(s(r,i)),r===a&&i===o)return;let e=2*p;e>=u&&(p+=u,r+=d),e<=l&&(p+=l,i+=f)}}async function u({engine:n,opening:u,seed:d,solve:f,canvas:p,notice:m,status:h,size:g,signal:_,fail:v}){let y=document.querySelector(`#sample`),b=document.querySelector(`#palette`),x=document.querySelector(`#preset`),S=document.querySelector(`#seed`),C=document.querySelector(`#next`),w=document.querySelector(`#detail`),T=document.querySelector(`#route`),E=p.dataset,D=n.gpu.adapterInfo?.vendor===`margo-webgl2`,O=r(u.cells),k=d,A=2,j=0,M=null,N=null,P=!1,F=null,I=!1,L=!0,R=0,z=0,B=[],V=[],H=document.createElement(`option`);H.value=`drawn`,H.textContent=`Drawn sample`,H.disabled=!0,H.hidden=!0,x.append(H),T.textContent=D?`Margo WebGL2`:`Margo WebGPU`,E.renderer=D?`compatibility`:`webgpu`;function U(t){let n=B[t],r=e[k[t]],[i,a]=c(t);n.style.setProperty(`--ink`,r.color),n.dataset.color=String(k[t]),n.setAttribute(`aria-label`,`Row `+(a+1)+`, column `+(i+1)+`, `+r.name)}for(let e=0;e<12;e++){let t=document.createElement(`div`);t.className=`sample-row`,t.role=`row`;for(let n=0;n<12;n++){let r=s(n,e),i=document.createElement(`button`);i.type=`button`,i.role=`gridcell`,i.className=`pixel`,i.tabIndex=r===0?0:-1,i.dataset.index=String(r),i.disabled=!0,B.push(i),U(r),t.append(i)}y.append(t)}e.forEach(({name:e,color:t},n)=>{let r=document.createElement(`label`),i=document.createElement(`input`);i.name=`ink`,i.type=`radio`,i.checked=n===A,i.disabled=!0,i.style.setProperty(`--ink`,t),i.setAttribute(`aria-label`,e),r.title=e,r.append(i),b.append(r),V.push(i),i.addEventListener(`change`,()=>{i.checked&&(A=n)},{signal:_})}),n.use(O);function W(e){k[e]!==A&&(k[e]=A,U(e),P=!0)}function G(e,t){E.seed=String(e.seed),E.patterns=String(e.patterns),E.backtracks=String(e.backtracks),E.result=o(e.cells),E.sample=o(t),E.woven=`48x36`,E.generation=String(++z),delete E.contradiction,w.textContent=`48 × 36 cells · `+e.patterns+` neighbourhoods · seed `+e.seed}function K(){let e=a(Math.trunc(Number(S.value)||1),1,999999999);return S.value=String(e),e}async function q(){if(!(I||!F||_.aborted)){I=!0;try{for(;F&&!_.aborted;){let e=F;F=null,w.textContent=`Growing the field from seed `+e.seed+`…`;let t=await f(e.data,e.seed);if(_.aborted)return;if(!F){if(t.error)E.contradiction=`true`,w.textContent=`This sample hit the search limit. Try another seed or change the swatch.`;else{if(O.set(t.cells),n.render(0),await n.gpu.queue.onSubmittedWorkDone(),_.aborted)return;if(G(t,e.data),e.trusted){if(await i(),_.aborted)return;performance.mark(`pattern-input-rendered`),L&&(L=!1,performance.mark(`pattern-first-input`))}}}}}catch(e){v(e)}finally{I=!1}}}function J(e){F={data:k.slice(),seed:K(),trusted:e},q()}function Y(e){M=null,N=null,P&&(P=!1,H.hidden=!1,x.value=`drawn`,J(e.isTrusted))}function X(e){let t=y.getBoundingClientRect(),n=Math.floor((e.clientX-t.left)/t.width*12),r=Math.floor((e.clientY-t.top)/t.height*12);return n<0||r<0||n>=12||r>=12?null:s(n,r)}function Z(e,t){B[j].tabIndex=-1,B[e].tabIndex=0,j=e,t&&B[e].focus({preventScroll:!0})}y.addEventListener(`pointerdown`,e=>{if(!E.ready||e.button!==0||M!==null)return;let t=X(e);t!==null&&(e.preventDefault(),M=e.pointerId,N=t,Z(t,!1),y.setPointerCapture(M),W(t))},{signal:_}),y.addEventListener(`pointermove`,e=>{if(e.pointerId!==M)return;let t=X(e);t===null?N=null:(N===null?W(t):l(N,t,W),N=t)},{signal:_});for(let e of[`pointerup`,`pointercancel`,`lostpointercapture`])y.addEventListener(e,e=>{e.pointerId===M&&Y(e)},{signal:_});y.addEventListener(`click`,e=>{E.ready&&M===null&&e.detail===0&&e.target.matches(`.pixel`)&&(W(Number(e.target.dataset.index)),Y(e))},{signal:_}),y.addEventListener(`keydown`,e=>{if(!E.ready||M!==null||!e.target.matches(`.pixel`))return;let t={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[e.key];if(!t)return;e.preventDefault();let[n,r]=c(Number(e.target.dataset.index));Z(s(a(n+t[0],0,11),a(r+t[1],0,11)),!0)},{signal:_}),x.addEventListener(`change`,e=>{if(x.value!==`drawn`){k=t(x.value),H.hidden=!0;for(let e=0;e<B.length;e++)U(e);J(e.isTrusted)}},{signal:_}),C.addEventListener(`click`,e=>{S.value=String(K()%999999999+1),J(e.isTrusted)},{signal:_}),S.addEventListener(`change`,e=>J(e.isTrusted),{signal:_}),S.addEventListener(`keydown`,e=>{e.key===`Enter`&&(e.preventDefault(),S.blur())},{signal:_});let Q=new ResizeObserver(()=>{g()&&!R&&(R=requestAnimationFrame(()=>{R=0,_.aborted||n.render(0)}))});if(Q.observe(p),_.addEventListener(`abort`,()=>{Q.disconnect(),cancelAnimationFrame(R)},{once:!0}),n.render(0),await n.gpu.queue.onSubmittedWorkDone(),_.throwIfAborted(),G(u,k),await i(),h.ready()){m.hidden=!0;for(let e of[x,S,C,...B,...V])e.disabled=!1;performance.mark(`pattern-ready`)}}export{u as show};