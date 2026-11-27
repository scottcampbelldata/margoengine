const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["./preview-BPhlX00W.js","./errors-CKFZBSDN-DEIUX3Qy.js"])))=>i.map(i=>d[i]);
(function(){let e=document.createElement(`link`).relList;if(e&&e.supports&&e.supports(`modulepreload`))return;for(let e of document.querySelectorAll(`link[rel="modulepreload"]`))n(e);new MutationObserver(e=>{for(let t of e)if(t.type===`childList`)for(let e of t.addedNodes)e.tagName===`LINK`&&e.rel===`modulepreload`&&n(e)}).observe(document,{childList:!0,subtree:!0});function t(e){let t={};return e.integrity&&(t.integrity=e.integrity),e.referrerPolicy&&(t.referrerPolicy=e.referrerPolicy),t.credentials=e.crossOrigin===`use-credentials`?`include`:e.crossOrigin===`anonymous`?`omit`:`same-origin`,t}function n(e){if(e.ep)return;e.ep=!0;let n=t(e);fetch(e.href,n)}})();var e=new Float64Array(5);function t(t){let n=e,r=0,i=0,a=0,o=!1;for(let e=0;e<t;e++){let t=n[e]=Math.abs(n[e]);t>r?r=t:t!==t&&(o=!0)}if(r===1/0||o||!r)n[4]=r===1/0||!o?r:NaN;else{for(let e=0;e<t;e++){let t=n[e]/r,o=t*t-a,s=i+o;a=s-i-o,i=s}n[4]=i,n[4]=Math.sqrt(n[4])*r}}function n(n,r,i,a=0,o=0){let s=e;return s[0]=r,s[1]=i,s[2]=a,s[3]=o,t(n),s[4]}var r=(e,t)=>Object.assign(Error(t),{name:`MargoError`,code:e}),i=(e,t)=>`${e}; see https://margoengine.com/errors#${t}`,a=(e,t,n=e)=>r(e,i(t,n)),o=(e,t)=>TypeError(i(e,t)),s=(e,t)=>RangeError(i(e,t)),c=()=>{throw Object.assign(o(`Retained vector: use a transform setter`,`transform`),{code:`transform`})};function l(e){return!/^(Compile|Eval|Runtime)Error$/.test(e?.name)||!/wasm-unsafe-eval|content security policy|\bCSP\b|disallowed by embedder/i.test(e.message)?e:Object.assign(r(`failed`,`Wasm compilation blocked by CSP; add 'wasm-unsafe-eval' to script-src; see https://margoengine.com/llms/docs/csp.md`),{cause:e})}function u(){return globalThis[Symbol.for(`margoengine.layers`)]}function d(e){return u()?.maskOf(e)??1}var f=(e,t,n)=>!!e&&(e[0]!==0||e[1]!==0||e[2]!==t||e[3]!==n);function p(e,t,n){if(e!==void 0){if(!Array.isArray(e)||e.length!==4)throw s(`Invalid draw rectangle`,`views`);for(let t=0;t<4;t++)if(!Number.isSafeInteger(e[t])||e[t]<(t<2?0:1))throw s(`Invalid draw rectangle`,`views`);if(e[0]+e[2]>t||e[1]+e[3]>n)throw s(`Draw rectangle exceeds target`,`views`)}}function m(e,t){if(!Number.isInteger(e)||e<0||e>4294967295)throw RangeError(`${t} ${e} is not a 32-bit layer mask; pass an integer from 0 to 0xffffffff`);return e>>>0}var h=[.018,.023,.035,1],g=e=>/^#([\da-f]{3}){1,2}$/i.test(e)?parseInt((e[4]?e:e.replace(/\w/g,`$&$&`)).slice(1),16):-1,_=e=>(e/=255)>.04045?((e+.055)/1.055)**2.4:e/12.92,v=e=>e/255,y=/float$|srgb$/,b=h.map(e=>_(e*255));function x(e,t){let n=y.test(t)?_:v;if(typeof e!=`string`)return n===v?h:b;let r=g(e);if(r<0)throw RangeError(`Invalid color; use #rrggbb`);return[n(r>>16),n(r>>8&255),n(r&255),1]}var S=new WeakMap;function C(e,t){let n=S.get(e);if(!n){let t=e.createBindGroupLayout({entries:[{binding:0,visibility:2,buffer:{}}]});n={group:t,layout:e.createPipelineLayout({bindGroupLayouts:[t]}),groups:new Map},S.set(e,n)}let r=t.join(),i=n.groups.get(r);if(!i){let a=e.createBuffer({size:16,usage:72});if(e.queue.writeBuffer(a,0,new Float32Array(t)),i=e.createBindGroup({layout:n.group,entries:[{binding:0,resource:{buffer:a}}]}),i.b=a,n.groups.size>63){let[t,r]=n.groups.entries().next().value;n.groups.delete(t),e.queue.onSubmittedWorkDone().then(()=>r.b.destroy())}n.groups.set(r,i)}return[n.layout,i]}function w(e,t,n,{formats:r,values:i=[],depthFormat:a,writeDepth:o,samples:s=1,writeColor:c=!0,tint:l=h}){let u=[r,i,a,+!!o,s,+c].join(`|`),[d,f]=C(e,l),p=t.get(u);if(!p){let n=r.map((e,t)=>`@location(${t}) c${t}:vec4f`).join(`,`),l=e.createShaderModule({code:`@group(0) @binding(0) var<uniform> t:vec4f;
struct Out{${n}}
@vertex fn v(@builtin(vertex_index) i:u32)->@builtin(position) vec4f{return vec4f(f32(i&1u)*4-1,f32(i>>1u)*4-1,0,1);}
@fragment fn f()->Out{return Out(t${i.map(e=>`,vec4f(${e})`).join(``)});}`});p=e.createRenderPipeline({layout:d,vertex:{module:l,entryPoint:`v`},fragment:{module:l,entryPoint:`f`,targets:r.map((e,t)=>t?{format:e}:{format:e,writeMask:c?15:0})},...a?{depthStencil:{format:a,depthWriteEnabled:!!o,depthCompare:`always`}}:{},multisample:{count:s}}),t.set(u,p)}n.setPipeline(p),n.setBindGroup(0,f),n.draw(3)}function T(e,t,n){if(e.length!==t)throw o(`${n}: ${t} values`,`transform`);for(let r=0;r<t;r++){let t=e[r];if(typeof t!=`number`||!(Math.abs(t)<34028235677973366e22))throw s(`${n}: finite values`,`transform`)}}var ee=class{vertices;indices;bounds;constructor(e,t,n){let r=e.length/3;if(!Number.isInteger(r)||r>11184810||(r===0?n.length!==0:r<3||!n.length)||n.length%3)throw s(`Invalid geometry`,`geometry`);T(e,r*3,`Positions`),T(t,r*3,`Normals`);for(let e=0;e<n.length;e++)if(!Number.isInteger(n[e])||n[e]<0||n[e]>=r)throw s(`Invalid geometry`,`geometry`);this.vertices=new Float32Array(r*6);let i=[1/0,1/0,1/0],a=[-1/0,-1/0,-1/0];for(let n=0;n<r;n++)for(let r=0;r<3;r++)this.vertices[n*6+r]=e[n*3+r],this.vertices[n*6+3+r]=t[n*3+r],i[r]=Math.min(i[r],e[n*3+r]),a[r]=Math.max(a[r],e[n*3+r]);this.indices=Uint32Array.from(n);let o=this.bounds=new Float32Array(4),c=this.vertices;if(r)for(let e=0;e<3;e++)o[e]=(i[e]+a[e])/2;let l=0;for(let e=0;e<r;e++)l=Math.max(l,Math.hypot(c[e*6]-o[0],c[e*6+1]-o[1],c[e*6+2]-o[2]));o[3]=l,o[3]<l&&new Uint32Array(o.buffer)[3]++,T(o,4,`Bounds`)}};function te(e=1,t=1,n=1){let r=[e,t,n];if(T(r,3,`Box size`),Math.min(e,t,n)<=0)throw s(`Box size: positive`,`geometry`);let i=[],a=[],o=[];for(let e=0;e<3;e++)for(let t of[-1,1]){let n=i.length/3,s=(e+1)%3;for(let[n,o]of[[-1,-1],[1,-1],[1,1],[-1,1]])for(let c=0;c<3;c++)i.push((c===e?t:c===s?n:o)*r[c]/2),a.push(c===e?t:0);for(let e of t>0?[0,1,2,0,2,3]:[0,2,1,0,3,2])o.push(n+e)}return new ee(i,a,o)}var E=class{data=new Float32Array([0,0,0,1,.5,0,1,0]);constructor(e={}){this.set({...e,color:e.color??`#4f46e5`})}set({color:e=this.data.slice(0,3),roughness:t=this.data[4],metalness:n=this.data[5],doubleSided:r=!!this.data[6]}){let i=typeof e==`string`?g(e):0,a=typeof e==`string`?i<0?null:[16,8,0].map(e=>_(i>>e&255)):e;if(!a)throw o(`Invalid Color`,`material`);if(T(a,3,`Color`),[...a,t,n].some(e=>!Number.isFinite(e)||e<0||e>1))throw s(`Invalid material`,`material`);if(typeof r!=`boolean`)throw o(`Invalid material`,`material`);this.data.set([...a,1,Math.max(.045,t),n,+r])}},ne=`zVf/ixxHdq+qrv423T0zWu3aK68svS6tpNVqBfpBHMIY1IW1soSdnBObYPA6J53tHFc7tm/GG18uspgJiLBh9YMR+4N+OHBrLr8lkB8OFsIYzj/eX5CfHRBGPyiw51NAIdts9Kq6Z3p6RnIECkRip9579XnvVVd9XvVrcu2zjykhhJ5yr9Iu7V61ut18uJFr5Crtkqusa35o16r5lFmEE2I7tkXJAfdnrvPxRx9/2vkVI8H6R51PPmr95MNrG9eINdQ6n/6C8DDX/qp17WefEbuWq5989EvizObKZ7/65IOfdD7duLbx808/IW4RYOPnH6wTr/Yvq/6ObQVdep3eYAlLgMkLb0QEyBLzhI9DU7jSbgFVSnhnCBGWpJciwhKwVnkCnqSvEA0nwjJwLu+wlgIqnQ0lvyVK2BlhBCzg0sI4oibZhtI63QCqco0CH4o4ZmuMZH/BCMUfhj+WqGd/lr0tAp6ADfUsYCQAWzaVcIYZ3NYoIpfOmGaPaazI/eREIU/AGSUCJaJhooWWWSb+CUebamPx/THN+uFsFk8gKrI5MlTgSK6y9w2e6SOBmjpDSHbYEnWw5VklOC5Iu9s8AV64kzNkFgIIO2B1wO5I8non1sdDwB2tc5kR0XiNkN7v3osoNL4Wttzf399324JLuo6ydQVsSS4Luw1c9nq9PfdSp5DeyCW+jr+P3CtgtzvQAPe3VzsRgwY09qjgv12LGHDwcd2rEQMCHJikqknkPm0LJtmliAEDqxNbIQ3AktalBg60vRpRIECh0aQRDSRrBOCBJZlCxlnBPxzkM1/43cYNep0lhoEvmDPB5zr1taQb+Ai/RDq/YKj5YunBlyuAF0dsxOnTE9OGvHMF4MgEgG2Il0oRjk4A7PLGw8S0U56OJ6bd8rSYXF559ccmpv2y9+LY9JGBsMHuw9GBsMDqpwADwYH3U4gHwgGnnwr3Isn/XYtILu9eAAvcr4T7G+0mAuDg/kZ7Ci8VPvjpXRAD4fd3xJHsINg4ayMyBA4Oam5fOKmoQS0FRB3NgIKN/jUM3RfRXVGHupmEDBiE4NzFJaVwbCCc/o6IM6RK9k80Cwkh++W/LMnC/X1Cyn/Zn44Wj88sfPBS4YGX3gUMJ7KDWK59wXG5fWGn+GypnjuGq6tBlJsWB8Lq74hFXBYH+y4+eApoOv6sa8r+nmZvl/fVhyDV8e7qgCfGjktfzQswhxUVz7EuMFPCPIE5SV6P5yXFQlqAl4DtUUEUAsW83CdtcQhvd6oJ8XvaUkDwkhYEr+llRvD8jwxE0Acid3MLR1p4/RSI7FFjspEgtX6azQKR93KcC9rtYa46YHxu5j4+oIMwWzL2L9ul4kwWE0OSM1lMcyIEQOT9PFzQBw+IfJSrJvZmHjsEsxgL+VrrA0fWRf0UbGRJ/QfzamaZxEM6QYAH3MC0xwei2U8hhBMDcaCfDish3REnNF1ODcQMZl0eiIM66+mBmNUr/NKsMN0Rp/CJXJjpgwMI8sEgtoeIZVxFgAhPI8IccWeIOD3k1b9OpRa4jzcCHIh0/LrekwBNnjaF8MNbIYZHoNluQQMfrKmf6oAO6KLJ0SZfm54ecHG0t08vi4hQbnt+GDUPzM7NHzr8cvY2TyRpBJrUMP+NJJc78TwcklQF8SGgkm+Iw5rJD0hLKUHwYmPjlbLMuDhZNXliqWoKxcrXYq54+ZHRy28OX35zbSR//vIjw5cfGX/5zbU7EQGGNQSDPpzE0jk26KewhBVzAqXTg1S4OzED63FRGZ7qnT2Ow/IgFc5OfBKwBnEyNpOLOJwapMLeiZckVnwCK6/hLr83vDIIgSNbWGRHtwYiSAG2BngFP76nwPrpgrBGsJH44YKej7ewgMTWQNRSOLY1EJG+eYD/dEFwvAtz3OLWQNTh+NZANFI4sTUQzQncKIsPYQr1/90CArz9G9OTehClMJmo/xWsDPpgw9Lgrn73gAMnczEFF1ghf5UKa0esfB3PgQUrgw9XIwJzkqp4LoASCaDEkQ6UOITgwt7JX6T63qT5vflrqjQfrB8xAkTeeqwSI+6RofhgJN6hCk6f1+ImVXDCiI+IgmNGvE8UgBFvUgXHjfiQKBBGvEcUHDXiNlWwbMQvqYJTRuxRBYtG3CUKYiN+SxQcQREfYRP788O4/gdEwdyPhpnZKMfJkd8Sii/BggKq4JDs0Q4cgvmFVwiRNH45gJeD7yLLu05v0G71Kti9IHhsYxcnb+G+MRm2zEdBiOUaaB6v8QSCQc6Lby/0s9lhmN78mYvv/Hf8XxfwRrHAykJjOJQUY/ZHmm3TKfbvafYHahgIVvYfNPueCqsIPJ8UI/p/T4Wd7VIYTp9LijH7IwV7ErCaFOMTAH+eFON0QO+9pBifAPggKcbpgEQlxfiENbSTYpwOuPrXSTE+IcXfJsU4HZB2k2IsANkuje0AQrx6//8cL3/K8fJJwPjxTgGMH+8koHK8UwDjxzsJqBzvlDWMH+8koHK8U1KMH+8koHK8PD9eHgDDjx2m6zpsKQU2HriXH/h7/Hqxxt0LxU1gT3CgOPuCC//XHHCewgFnEjDOgSmAcQ5MAiocmAIY58AkoMKBKWsY58AkoMKBKSnGOTAJqHDAMRwIhJVFnl8LwqjeKEbhAAcLOzlmcdtxi1G42fdUH9HQZTjlYUIf7Kl+tok3kYfreOhZy3Yp9pn6ZaV7QgVMgQ+17A8Uu85iYralJxxNYtBZ9SfeMJJViTRvHHABw0iBq7++SHCK0i4QnqAWCmoETxKgewEJZK/3DZHkFUKC3MML/pPRWpclQOTfFU3jF1cioqFn8EXaxk5U/htpyXklPF1eMu19Q5RwgUi3JWwlqGx+DlTu71ttSV5Xgl8ggr7BE+BA1xMiu5ciGgDjifaUBBguB2yegCsJ2FojcqmVR3ZiSy+JbQhf8nVBZfhjnoADVLLPJVWiJvdMS8wl21CxBU7MgMfUSoAhP3q/K/9lASPAZFPFDI9iXdCIBMChppflgK+0p6U7puvYdViSK2EBfT0iQSDv4KIpthXbvW8IYMskv0TJRukWSi5Kmyh5KN1ED3wWVHpDdzTHVgBWcIxSvevY+FE8iaZgP47MKQID2mRB8M8LFr8x0+XX9XzssgToakRYYlCu7lyEs8RI+avBWWK8onsVPazozYo+W9HnK/rhig4VfbGiL1X0lYp+tqKfq+jnK/qrFT2p6Bcr+uWK/mZFf6uiv1PR363oa6g//rr6myvIH1dS1Qh0NcUHWAKuZjXbiOvgyju0FfvmqOIQXGltxE04gD4bKp7RBxk7VsIS8OCAOkM0ITyYQVHUzGnXJG1r9vtKBNijYodqQYDtsP62/MuIggORKjMBrCd8OnRwzTXJSiHvj0I+GAtZf6aQvBRydxTy4VjI5jOF9EohH41C7o2FDHXj/ixhm6WwPToMe5NWwt57trDQXtWePl5Qm0XcGn595XGJiXv/KXEjUor8JxjYMwSrS67iOvjyrIp9CGWo4hCaaGxChEMErsYKD68tQ7aoxD3kYi2npiRxU5LY19Tzc755SD6/xMOCeE0l8J6sKdEoSGdBo6AigwAHDhz42oIeGf5fWxA48vfNWOi6KVpbEBbK7y/g6wu8go/1UqYHo0z3n2OmnKZRKdPDUabd55gpZ6/h5yjb3ijbo+eYrTnMdq+c7SYdZsup/lyywTDb/XK2W6Nsm88x2/n2qq4dF/wmCwq65zVQw4qoFfWRV4QLPpaCr0sBL1y7peKDksSevqAPSgKubjtc6bSs4fWLHRN4kjSJ3KdtyS5FVlAtq01m6uj3eV1t0paus5u0pe98F+94V+6RVhzAARXPgitXWnEDXNTm9Gqwa3nBXP8zuCi9gjklXtTtWWk1HhxESVqXeAINmFHCgRAHPy8/7AsdyRX4eWkag4eG+yVDiIYHJUMTDbslwywaHpYM82h4VDIcRsNeyQBoMLQyhkU03CwZltCwWTKsoOFWyXAWDV+WDOfQsF0ynEfDnZLhVTT8emgIYEZBTe9NaVOaaHVKm1I3htGmRMYw2hQPZpXu1AJ4ETx4Qe989zPZo23pfq7tAdIrKFiWcy7nYw1bzBqEMlmPQ2jg0BgjT5C3cEiAz0UTGwWkhKeJIJy8pYvxHaJphdEcwywkuqPJhZkcwy8V160E6hlhRMwDzXzWzL6jEGnDIW2Yzb6j2T0Koba9pG3zCELhcHZPT9ZwMvt3Khay17J/pGBiEYSZKDyPYvy9wj/M/Y1bJ/eDkd/imN9S4bcy1e/syO/cmN/5wu/VqX7JyO/imN/lwu/NqX5vjfzeGfN7t/BbG/cTjnkheuYbChzz1sLzHVq4sbCRxTMWq7DUkSXImaa5w5rmDtPU8ZBIHjQlXRdNJMzjc/6iLTxwL+UfB4Lq20P+oi0KEmA7QDU1wFEYhRrKaC3U2mauRYZwjjYarmEHwBKIlhm5hZ88yywE31zcdJmRbaiZ65suM759G0LUbNS87du3saOhy+wwaHBzGzRudvs2aMj89u3bYL1vQCsGBDlosQAtlUGvGtDZHHSuAJ0vg940oCQHXSxAl8ugNQN6Kwe9U4DeNaBV8+nnFafi48772MWaEua4dXldmwIG94o+EYIes5Jgz4+XxayeD/4H`,re=new WeakMap;function ie(e,t){let n=re.get(e);if(!n?.handle)throw a(`disposed`,`Transforms disposed`);n.api.kernel_sync_rotation(n.handle,t)}var D,ae=0,oe=1,se=2,ce=3,le=4,ue=5,de=6,fe=7,pe=8,me=9,he=10,ge=11,_e=27,ve=35,ye=38,be=24,xe=0,Se=1,Ce=2,we=3,Te=6,Ee=class e{f;static async create(t=1024){D??=(async()=>{let e=Uint8Array.from(atob(ne),e=>e.charCodeAt(0));return WebAssembly.compile(await new Response(new Blob([e]).stream().pipeThrough(new DecompressionStream(`deflate-raw`))).arrayBuffer())})().catch(e=>{throw D=void 0,e});try{let n=await WebAssembly.instantiate(await D);return new e(n.exports,t)}catch(e){throw l(e)}}constructor(e,t){this.f=e,re.set(this,{handle:0,api:e}),this.g(t)}g(e){if(!Number.isSafeInteger(e)||e<1||e>1<<23)throw s(`Capacity: 1..8388608`,`limits`);let t=this.f,n=t.kernel_new(e);if(!n)throw a(`failed`,`Transform allocation`,`limits`);let r=t.kernel_data(n),i=t.kernel_flags(n),o=t.memory.buffer,c=(t,n=e)=>new Float32Array(o,r+t*4,n),l=t=>new Uint8Array(o,i+t*e,e);this.e=n;let u=re.get(this);u&&(u.handle=n),Object.assign(this,{capacity:e,transforms:{x:c(ae*e),y:c(oe*e),z:c(se*e),qx:c(ce*e),qy:c(le*e),qz:c(ue*e),qw:c(de*e),sx:c(fe*e),sy:c(pe*e),sz:c(me*e)},parents:c(he*e),matrices:c(ge*e,16*e),bounds:c(_e*e,4*e),planes:c(ve*e,be),rotations:c(ve*e+be,3*e),limits:c(ye*e+be,12*e),active:l(xe),visible:l(Se),constrained:l(Ce),hidden:l(we),changed:l(Te)})}grow(e){if(!(e>this.capacity))throw s(`Capacity`,`limits`);let t=()=>Object.values({...this.transforms,...this}).filter(ArrayBuffer.isView),n=t().map(e=>e.slice()),r=this.capacity;this.f.kernel_drop(this.e);try{this.g(e)}catch(e){throw this.g(r),e}finally{t().forEach((e,t)=>e.set(n[t]))}}tick(e=!0){if(!this.e)throw a(`disposed`,`Transforms disposed`);let t=this.f.kernel_tick(this.e,+e);if(t)throw t>this.capacity?s(`Invalid frustum`,`camera`):s(`Invalid transform/bounds: ${t-1}`,`transform`)}dispose(){let e=re.get(this);e&&(e.handle=0),this.e&&=(this.f.kernel_drop(this.e),0)}},De=new Float64Array(1),Oe=new Float32Array(16),ke=new Float32Array(24),Ae=class{fov;near;far;position;target;up=[0,1,0];project;matrix=new Float32Array(16);planes=new Float32Array(24);e;g=new Float64Array(16);f=new Float64Array(16);constructor({fov:e=60,position:t=[0,2,5],target:n=[0,0,0],near:r=.1,far:i=1e3}={}){this.fov=e,this.position=t,this.target=n,this.near=r,this.far=i}update(e,t){if(T(this.position,3,`Camera position`),T(this.target,3,`Camera target`),!Number.isFinite(e)||!Number.isFinite(this.fov)||!Number.isFinite(this.near)||!Number.isFinite(this.far)||e<=0||this.fov<=0||this.fov>=180||this.near<=0||this.far<=this.near)throw s(`Invalid projection`,`camera`);let r=this.position[0]-this.target[0],i=this.position[1]-this.target[1],a=this.position[2]-this.target[2],o=n(3,r,i,a);if(!o)throw s(`Camera at target`,`camera`);r/=o,i/=o,a/=o;let c=this.up,l=c[1]*a-c[2]*i,u=c[2]*r-c[0]*a,d=c[0]*i-c[1]*r,f=n(3,l,u,d);if(!f)throw s(`Vertical camera`,`camera`);l/=f,u/=f,d/=f;let p=i*d-a*u,m=a*l-r*d,h=r*u-i*l,g=this.position,_=this.g;_[0]=l,_[1]=p,_[2]=r,_[4]=u,_[5]=m,_[6]=i,_[8]=d,_[9]=h,_[10]=a,_[12]=-l*g[0]-u*g[1]-d*g[2],_[13]=-p*g[0]-m*g[1]-h*g[2],_[14]=-r*g[0]-i*g[1]-a*g[2],_[15]=1;let v=1/Math.tan(this.fov*Math.PI/360),y=this.near-this.far,b=this.f;b.fill(0),this.project?this.project(b,e,t):(b[0]=v/e,b[5]=v,b[10]=t?-this.near/y:(this.far+this.near)/y,b[11]=-1,b[14]=t?-this.far*this.near/y:2*this.far*this.near/y);let x=Oe;for(let e=0;e<4;e++)for(let t=0;t<4;t++)x[e*4+t]=b[t]*_[e*4]+b[4+t]*_[e*4+1]+b[8+t]*_[e*4+2]+b[12+t]*_[e*4+3];T(x,16,`Camera matrix`);for(let e=0;e<6;e++){let n=e>>1,r=e%2==0?1:-1,i=0;for(let a=0;a<4;a++){let o=e===4&&t?x[a*4+2]:x[a*4+3]+r*x[a*4+n];ke[e*4+a]=o,a<3&&(i+=o*o)}De[0]=i;let a=Math.sqrt(De[0]);if(!a)throw s(`Invalid frustum`,`camera`);for(let t=0;t<4;t++)ke[e*4+t]/=a}this.matrix.set(x),this.planes.set(ke)}fitToBoundingBox(e,t,{aspect:n=1,duration:r=.3,padding:i=1.1}={}){if(T(e,3,`Bounds`),T(t,3,`Bounds`),e.some((e,n)=>e>t[n])||![n,r,i,this.fov,this.near,this.far].every(Number.isFinite)||n<=0||r<0||i<1||this.fov<=0||this.fov>=180||this.near<=0||this.far<=this.near)throw s(`Invalid fit`,`camera`);let a=e.map((e,n)=>(e+t[n])/2),o=Math.hypot(...t.map((t,n)=>(t-e[n])/2)),c=Math.atan(Math.tan(this.fov*Math.PI/360)*Math.min(1,n)),l=Math.max(o/Math.sin(c),o+this.near)*i,u=this.position.map((e,t)=>e-this.target[t]),d=Math.hypot(...u);if(!d||l+o>=this.far)throw s(`Bounds exceed far: raise camera.far`,`camera`);let f=a.map((e,t)=>e+u[t]/d*l);this.e={position:f,target:a,elapsed:0,duration:r,from:this.position,fromTarget:this.target},this.advance(0)}advance(e){if(!this.e)return;let t=this.e,n=t.duration?Math.min(1,(t.elapsed+=e)/t.duration):1,r=n*n*(3-2*n);this.position=t.from.map((e,n)=>e+(t.position[n]-e)*r),this.target=t.fromTarget.map((e,n)=>e+(t.target[n]-e)*r),n===1&&(this.e=void 0)}cancelFit(){this.e=void 0}},je=/Mobi|Android/;function Me(e){return e?.exact||(globalThis.margoLow||je.test(globalThis.navigator?.userAgent)?1:4)}var Ne=`
struct Frame { camera:mat4x4f,eye:vec4f,light:vec4f,radiance:vec4f,ambient:vec4f }
@group(0) @binding(0) var<uniform> frame:Frame;
override C=false;
fn pbrNeutral(input:vec3f)->vec3f {let x=min(input.r,min(input.g,input.b));let offset=select(0.04,x-6.25*x*x,x<0.08);var v=input-offset;let peak=max(v.r,max(v.g,v.b));if(peak<0.76){return v;}let newPeak=1.0-0.24*0.24/(peak+0.24-0.76);v*=newPeak/peak;return mix(v,vec3f(newPeak),1.0-1.0/(0.15*(peak-newPeak)+1.0));}
struct Input { @location(0) position:vec3f,@location(1) normal:vec3f,@location(2) m0:vec4f,@location(3) m1:vec4f,@location(4) m2:vec4f,@location(5) m3:vec4f,@location(6) color:vec4f,@location(7) factors:vec4f }
struct Output { @builtin(position) @invariant clip:vec4f,@location(0) position:vec3f,@location(1) normal:vec3f,@location(2) color:vec3f,@location(3) material:vec4f }
@vertex fn vertex(i:Input)->Output {
let model=mat4x4f(i.m0,i.m1,i.m2,i.m3);let p=model*vec4f(i.position,1);
var o:Output;o.clip=frame.camera*p;o.position=p.xyz;
o.normal=mat3x3f(cross(i.m1.xyz,i.m2.xyz),cross(i.m2.xyz,i.m0.xyz),cross(i.m0.xyz,i.m1.xyz))*i.normal*select(-1.0,1.0,dot(i.m0.xyz,cross(i.m1.xyz,i.m2.xyz))>=0.0);o.normal=select(vec3f(0,1,0),o.normal,dot(o.normal,o.normal)>0.0);
o.color=i.color.rgb;o.material=vec4f(i.factors.xyz,select(-1.0,1.0,dot(i.m0.xyz,cross(i.m1.xyz,i.m2.xyz))>=0.0));return o;
}
@fragment fn fragment(i:Output,@builtin(front_facing) front:bool)->@location(0) vec4f {
let facing=front==(i.material.w>0.0);if(!C&&!facing&&i.material.z<0.5){discard;}
let n=normalize(i.normal)*select(-1.0,1.0,facing);let v=normalize(frame.eye.xyz-i.position);let l=frame.light.xyz;let h=(v+l)/max(length(v+l),0.0001);
let nl=clamp(dot(n,l),0.0,1.0);let nv=clamp(dot(n,v),0.0001,1.0);let nh=clamp(dot(n,h),0.0,1.0);let vh=clamp(dot(v,h),0.0,1.0);
let a=i.material.x*i.material.x;let a2=a*a;let k=cross(n,h);let q=max(dot(k,k),step(nh,0.0))+a2*nh*nh;let d=a2/(3.14159265*q*q);
let g=2.0*nl*nv/max(nl*sqrt(a2+(1.0-a2)*nv*nv)+nv*sqrt(a2+(1.0-a2)*nl*nl),1e-30);
let f0=mix(vec3f(0.04),i.color,i.material.y);let w=1.0-pow(1.0-vh,5.0);let f=1.0-(1.0-f0)*w;
let direct=(0.96*w*(1.0-i.material.y)*i.color/3.14159265+d*g*f/max(4.0*nl*nv,0.0001))*nl;
let linear=direct*frame.radiance.xyz*frame.light.w+i.color*(1.0-i.material.y)*frame.radiance.w*frame.ambient.rgb;
let mapped=pbrNeutral(max(linear,vec3f(0)));return vec4f(select(mapped*12.92,1.055*pow(mapped,vec3f(1.0/2.4))-0.055,mapped>=vec3f(0.0031308)),1);
}`,Pe={},Fe=e=>(e.count||e.redirect)&&!e.claimed;function Ie(e,t,n,r,i,a){if(!r&&!i)return`none`;if(!f(e,t,n))return`attachment`;if(a)throw o(`Partial-view clear: draw extra attachments with clear: false`,`views`);return`draw`}var Le=(e,t,n,r,i,a)=>{r*=24,i=i*24>a?a:i*24,i>r&&e.writeBuffer(t,r*4,n,r,i-r)};function Re(e,t,n,r){let{rows:i,instances:a}=n,o=n.count*24;if(r||!i||!(n.dirty>=0))Le(e,t,a,0,o,o),i?.fill(0);else if(n.dirty){let n=i.h??=new Uint16Array(i.buffer,i.byteOffset,i.length*2);for(let r=0,i=0,s=0;r<=n.length;r++){let c=n[r];if(r===n.length)Le(e,t,a,i,s,o);else if(c)for(n[r]=0;c;){let n=31-Math.clz32(c&-c),l=~(c>>n),u=n+31-Math.clz32(l&-l),d=r*16+n;d!==s&&(Le(e,t,a,i,s,o),i=d),s=r*16+u,c=c>>u<<u}}}n.dirty=0}var ze=(e,t,{signal:n,startupWarning:r=8e3,startupTimeout:i},o)=>new Promise((s,c)=>{let l=1,u=()=>{clearTimeout(p),clearTimeout(m),n?.removeEventListener(`abort`,f)},d=e=>{l=0,u(),c(e)},f=()=>d(n.reason),p=setTimeout(console.warn,r,`Margo: still waiting for ${t} after ${r/1e3} s; see https://margoengine.com/errors#timeout`),m=setTimeout(d,i??3e4,a(`timeout`,`WebGPU ${t} never settled`));n?.aborted?f():n?.addEventListener(`abort`,f),e.then(e=>{u(),l?s(e):o?.(e)},d)}),Be=class e{o;e;x;p;z;f;H;set onLost(e){this.e.lost.then(t=>{this.h||e(this.memory??a(`failed`,`GPU lost: ${t.message}`,`gpu-lost`),!!this.memory)})}get target(){return{format:this.p,depthFormat:this.f.depthStencil.format,samples:this.f.multisample.count}}get gpu(){return this.e}backend=`webgpu`;g=new Float32Array(32);v=[];k;l;r=!1;cleared=!1;depthView;keepDepth=!1;u;resolvePass;I=[];B=[];q;D;y=!1;G=new Map;w=[];t=0;s;memory;i=!1;j=new Map;n=[];E=new WeakMap;m;A;C;h=!1;static async create(t,n=[],r=Me(),i={},o=!0){let s=navigator.gpu,c=i.powerPreference,l=s&&await ze(s.requestAdapter(c?{powerPreference:c}:/Win/.test(navigator.userAgent)?{}:{powerPreference:`high-performance`}),`requestAdapter`,i);if(!l)throw a(`unsupported`,`WebGPU adapter unavailable`,`webgpu`);let u=l.limits,d=await ze(l.requestDevice({requiredLimits:{maxTextureArrayLayers:u?.maxTextureArrayLayers,maxBufferSize:u?.maxBufferSize,maxStorageBufferBindingSize:u?.maxStorageBufferBindingSize},requiredFeatures:[`depth32float-stencil8`,...n].filter(e=>l.features.has(e))}),`requestDevice`,i,e=>e.destroy());try{let n=navigator.gpu.getPreferredCanvasFormat(),s=d.createShaderModule({code:Ne}),c={layout:`auto`,vertex:{module:s,entryPoint:`vertex`,buffers:[{arrayStride:24,attributes:[{shaderLocation:0,offset:0,format:`float32x3`},{shaderLocation:1,offset:12,format:`float32x3`}]},{arrayStride:96,stepMode:`instance`,attributes:Array.from({length:6},(e,t)=>({shaderLocation:t+2,offset:t*16,format:`float32x4`}))}]},fragment:{module:s,entryPoint:`fragment`,targets:[{format:n}]},depthStencil:{format:d.features.has(`depth32float-stencil8`)?`depth32float-stencil8`:`depth32float`,depthWriteEnabled:!0,depthCompare:`greater-equal`},multisample:{count:r}},l=`createRenderPipelineAsync`,u=await ze(d.createRenderPipelineAsync(c),l,i),f=await ze(d.createRenderPipelineAsync({...c,primitive:{cullMode:`back`},fragment:{...c.fragment,constants:{C:1}}}),l,i),p=t.getContext(`webgpu`);if(!p)throw a(`unsupported`,`No WebGPU canvas`,`webgpu`);let m=new e(t,d,p,n,u,c,f);return o&&m.configure(),m}catch(e){throw d.destroy(),e}}constructor(e,t,n,r,i,o,s){this.o=e,this.e=t,this.x=n,this.p=r,this.z=i,this.f=o,this.H=s,this.m=t.createBuffer({size:128,usage:72}),this.A=t.createBindGroup({layout:i.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.m}}]}),this.C=t.createBindGroup({layout:s.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.m}}]}),t.lost.then(()=>this.i=!0),t.addEventListener(`uncapturederror`,({error:e})=>{this.memory||(e instanceof GPUOutOfMemoryError?(this.memory=a(`failed`,`GPU out of memory: ${e.message}`,`gpu-lost`),this.i=!0,t.destroy()):this.s=a(`failed`,e.message,`gpu-lost`))})}configure(){this.x.configure({device:this.e,format:this.p})}add(e,t){let n=[];try{let r=(e,t)=>{if(e.byteLength>this.e.limits.maxBufferSize)throw s(`GPU buffer limit`,`limits`);let r=this.e.createBuffer({size:e.byteLength,usage:t|8});return n.push(r),this.e.queue.writeBuffer(r,0,e),r},i=r(e.vertices,160),a=r(e.indices,144);if(t*96>this.e.limits.maxBufferSize)throw s(`GPU buffer limit`,`limits`);let o=this.e.createBuffer({size:t*96,usage:168});n.push(o),this.remove(e),this.j.set(e,{vertex:i,index:a,instance:o,frame:-1})}catch(e){for(let e of n)e.destroy();throw e}}remove(e){let t=this.j.get(e);t&&(t.vertex.destroy(),t.index.destroy(),t.instance.destroy(),t.indirect?.destroy(),this.j.delete(e))}geometryBuffers(e){let t=this.j.get(e);if(this.h||this.i||!t)throw a(`state`,`Geometry unavailable`,`device-restore`);return t}render(e,t,n,r,i,a){if(!(this.i||this.h))try{this.J(e,t,n,r,i,a)}catch(e){throw this.s=void 0,e}}J(e,t,n,r,i,a){if(this.s)throw this.s;let s=a?.target,{width:c,height:l}=s?.color??this.o,u=s?.color.format.replace(`-srgb`,``)??this.p,d=this.F(+!!s,c,l,u),f=this.f.multisample.count,m=s?.depth;if(s&&(s.color.sampleCount>1||m&&(m.width!==c||m.height!==l)))throw o(`Invalid view target: use 1-sample colour`,`views`);if(m&&(m.sampleCount!==f||m.format!==this.f.depthStencil.format))throw o(`Invalid view depth: use the scene depth format and samples, or omit depth`,`views`);this.g.set(e.matrix),this.g.set(e.position,16),this.g.set(t.direction,20);let g=Math.hypot(this.g[20],this.g[21],this.g[22]);for(let e=20;e<23;e++)this.g[e]/=g;this.g.set(t.radiance,24),this.g.fill(1,28,31),t.ambient&&this.g.set(t.ambient,28),this.e.queue.writeBuffer(this.m,0,this.g),this.q?.settle();let _=!!a&&a.index+1!==a.count;this.y=_;let v=this.e.createCommandEncoder();this.t++;let y=this.I;for(let e=0;e<n.length;e++)y[e]=n[e];y.length=n.length,this.l=s?.color.createView({format:u})??this.x.getCurrentTexture().createView(),this.k=d.length>1?d[0]:void 0;let b=this.k??this.l,S=m?m.createView():d.at(-1);this.r=(r.revision>0||_)&&!!this.k,this.keepDepth=!!m,this.depthView=S;let C=this.q??={backend:`webgpu`,draw:(e=Pe)=>{let t=this.q,n=t.view?.viewport,r=e.viewport===void 0?n:e.viewport,i=e.scissor===void 0?e.viewport===void 0?t.view?.scissor??n:void 0:e.scissor;p(r,t.width,t.height),p(i,t.width,t.height);let a=e.pipeline??this.z,o=e.bindings??t.bindings;if(!e.pipeline&&(t.shader!==Ne||t.format!==this.p||t.descriptor!==this.f)){let e=t.descriptor.multisample?.count+t.format+t.descriptor.depthStencil?.format;a=this.variant(t.shader,e,e=>({...t.descriptor,vertex:{...this.f.vertex,module:e},fragment:{...this.f.fragment,module:e,targets:[{format:t.format}]}}))}let s=this.A;if(a!==this.z||o.length){let e=this.E.get(a),t=!e||e.bindings.length!==o.length;for(let n=0;!t&&n<o.length;n++){let r=o[n],i=e.bindings[n],a=r.resource,s=i.resource;t=r.binding!==i.binding||(a.buffer?a.buffer!==s.buffer||a.offset!==s.offset||a.size!==s.size:a!==s)}if(t||!e){let t=this.e.createBindGroup({layout:a.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.m}},...o]});e={bindings:o.map(({binding:e,resource:t})=>({binding:e,resource:t.buffer?{...t}:t})),group:t},this.E.set(a,e)}s=e.group}let c=t.view?.clear?.color,l=typeof c==`string`,u=e.clear??(c===!1?!1:l||!t.view?.index),d=e.clearDepth??t.view?.clear?.depth??e.clear??!0,f=x(l?c:void 0,t.color!==this.k&&t.color!==this.l&&t.format),m=Ie(t.view?r??i:void 0,t.width,t.height,!!u,!!d,e.colorAttachments?.length??0),g=this.u??={colorAttachments:[{view:t.color,clearValue:h,loadOp:`clear`,storeOp:`store`}],depthStencilAttachment:{view:t.depth,depthClearValue:0,depthLoadOp:`clear`,depthStoreOp:`store`}},_=g.colorAttachments,v=_[0],b=g.depthStencilAttachment;v.view=t.color,v.loadOp=m===`attachment`&&u?`clear`:`load`,m===`attachment`&&u&&(v.clearValue=f),b.view=t.depth,b.depthLoadOp=m===`attachment`&&d?`clear`:`load`,v.resolveTarget=t.color===this.k&&!this.r?this.l:void 0,v.storeOp=v.resolveTarget?`discard`:`store`,b.depthStoreOp=this.keepDepth?`store`:v.storeOp,_.length=1,e.colorAttachments&&_.push(...e.colorAttachments);let S=t.descriptor.depthStencil.format.includes(`stencil`);if(b.stencilClearValue=S?e.stencilClear??0:void 0,b.stencilLoadOp=S?m===`draw`?`load`:u||e.stencilClear!==void 0?`clear`:`load`:void 0,b.stencilStoreOp=S?b.depthStoreOp:void 0,t.only&&t.draw===this.D){if(t.joins&&m===`attachment`&&!y.some(Fe)){this.cleared=!0;return}t.attach(v,b,!0)}let C=t.encoder.beginRenderPass(g);r&&C.setViewport(...r,0,1),i&&C.setScissorRect(...i),m===`draw`&&w(this.e,this.G,C,{formats:[t.format],depthFormat:t.descriptor.depthStencil.format,writeDepth:!!d,samples:t.descriptor.multisample?.count,writeColor:!!u,tint:f});let T;for(let n=0;n<y.length;n++){let r=y[n];if(Fe(r)){let n=a===this.z&&!o.length&&!r.mask?this.H:a;n!==T&&(T=n,C.setPipeline(n),C.setBindGroup(0,n===a?s:this.C));let i=this.j.get(r.geometry);i.frame!==this.t&&this.upload(r,i,this.t);let c=r.redirect;C.setVertexBuffer(0,i.vertex),C.setVertexBuffer(1,c?.instances??i.instance),C.setIndexBuffer(i.index,`uint32`),c?C.drawIndexedIndirect(c.args,0):e.indirect??t.indirect?(i.indirect??=this.e.createBuffer({size:20,usage:264}),i.command??=new Uint32Array([r.geometry.indices.length,0,0,0,0]),i.command[1]!==r.count&&(i.command[1]=r.count,this.e.queue.writeBuffer(i.indirect,0,i.command)),C.drawIndexedIndirect(i.indirect,0)):C.drawIndexed(r.geometry.indices.length,r.count)}}C.end()},attach:(e,t,n)=>{if(this.cleared){let n=this.u.colorAttachments[0],r=this.u.depthStencilAttachment;this.cleared=!1,e.loadOp=n.loadOp,e.clearValue=n.clearValue,t.depthLoadOp=r.depthLoadOp,t.depthClearValue=r.depthClearValue,r.stencilLoadOp&&(t.stencilReadOnly=void 0,t.stencilLoadOp=r.stencilLoadOp,t.stencilClearValue=r.stencilClearValue,t.stencilStoreOp=`store`)}n&&this.q.last&&this.r&&!this.y&&e.view===this.k&&t.view===this.depthView&&(e.resolveTarget=this.l,e.storeOp=`discard`,t.depthStoreOp=this.keepDepth?`store`:`discard`,t.stencilStoreOp&&=t.depthStoreOp,this.r=!1)},settle:()=>{this.cleared&&(this.cleared=!1,this.q.encoder.beginRenderPass(this.u).end())}};for(C.batches=y,C.draw=this.D??=C.draw,C.descriptor=this.f,C.device=this.e,C.encoder=v,C.color=b,C.depth=S,C.camera=e,C.view=a&&{id:a.id,camera:e,viewport:a.rect,scissor:a.scissor,index:a.index,count:a.count,clear:a.clear,layers:a.layers,target:a.target},C.width=c,C.height=l,C.delta=i,C.format=u,C.shader=Ne,C.bindings=this.w,C.indirect=!1;this.w.length;)this.w.pop();if(r.execute(C),!this.i&&!this.h){if(this.r&&!this.y){let e=this.resolvePass??={colorAttachments:[{view:b,loadOp:`load`,storeOp:`store`}],depthStencilAttachment:{view:S,depthLoadOp:`load`,stencilReadOnly:!0}},t=e.colorAttachments[0];t.view=b,t.resolveTarget=this.l,t.storeOp=_?`store`:`discard`,e.depthStencilAttachment.view=S,e.depthStencilAttachment.depthStoreOp=_||m?`store`:`discard`,v.beginRenderPass(e).end()}this.B[0]=v.finish(),this.e.queue.submit(this.B)}}F(e,t,n,r){let i=this.v[e];if(!i||i.width!==t||i.height!==n||i.format!==r){for(let e of i?.textures??[])e.destroy();i=this.v[e]={width:t,height:n,format:r,textures:[],views:[]};for(let e of[r,this.f.depthStencil.format].slice(this.f.multisample.count===4?0:1)){let r=this.e.createTexture({size:[t,n],sampleCount:this.f.multisample.count,format:e,usage:16});i.textures.push(r),i.views.push(r.createView())}}return i.views}upload(e,t,n){Re(this.e.queue,t.instance,e,t.frame<0),t.frame=n}variant(e,t,n){for(let n=0;n<this.n.length;n++)if(this.n[n][0]===e&&this.n[n][1]===t)return this.n[n][2];if(this.n.length>=64)throw s(`Shader limit: 64`,`limits`);let r=this.e.createRenderPipeline(n(this.e.createShaderModule({code:e})));return this.n.push([e,t,r]),r}async pick(e,t,n,r,i,a,o){if(this.i||this.h)return null;let s,c,l,u;try{let d=this.e;s=d.createTexture({size:[1,1],format:`r32uint`,usage:17}),c=d.createTexture({size:[1,1],format:`depth32float`,usage:16}),l=d.createBuffer({size:4,usage:9});let f=e.matrix.slice(),p=o?.[0]??this.o.width,m=o?.[1]??this.o.height,h=2*(Math.floor(i)+.5)/p-1,g=1-2*(Math.floor(a)+.5)/m;for(let t=0;t<4;t++)f[t*4]=(e.matrix[t*4]-h*e.matrix[t*4+3])*p,f[t*4+1]=(e.matrix[t*4+1]-g*e.matrix[t*4+3])*m;let _=new Float32Array(32);_.set(f),_.set(e.position,16),_.set(t.direction,20),_.set(t.radiance,24),_.fill(1,28,31),t.ambient&&_.set(t.ambient,28),u=d.createBuffer({size:128,usage:72}),d.queue.writeBuffer(u,0,_);let v=d.createCommandEncoder(),y={backend:`webgpu`,device:d,encoder:v,color:s.createView(),depth:c.createView(),camera:e,width:this.o.width,height:this.o.height,delta:0,format:this.p,shader:Ne,bindings:[],indirect:!1,descriptor:this.f,draw:()=>{}};r.prepare(y);let b=y.shader.replace(`@location(3) material:vec4f`,`@location(3) material:vec4f,@location(4) @interpolate(flat) id:u32`).replace(`o.color=i.color.rgb`,`o.id=u32(i.factors.w)+1u;o.color=i.color.rgb`).replace(`->@location(0) vec4f {`,`->@location(0) u32 {`).replace(/let n=normalize\(i.normal\)[\s\S]*$/,`return i.id;
}`),x=this.variant(b,``,e=>({...this.f,multisample:{count:1},vertex:{...this.f.vertex,module:e},fragment:{module:e,entryPoint:`fragment`,targets:[{format:`r32uint`}]},depthStencil:{format:`depth32float`,depthWriteEnabled:!0,depthCompare:`greater-equal`}})),S=d.createBindGroup({layout:x.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:u}},...y.bindings]}),C=v.beginRenderPass({colorAttachments:[{view:s.createView(),clearValue:[0,0,0,0],loadOp:`clear`,storeOp:`store`}],depthStencilAttachment:{view:c.createView(),depthClearValue:0,depthLoadOp:`clear`,depthStoreOp:`store`}});C.setPipeline(x),C.setBindGroup(0,S);for(let e of n)if(e.count){let t=this.j.get(e.geometry);this.upload(e,t,this.t-1),C.setVertexBuffer(0,t.vertex),C.setVertexBuffer(1,t.instance),C.setIndexBuffer(t.index,`uint32`),C.drawIndexed(e.geometry.indices.length,e.count)}if(C.end(),this.i||this.h||(v.copyTextureToBuffer({texture:s},{buffer:l},[1,1]),d.queue.submit([v.finish()]),!await l.mapAsync(1).then(()=>1,e=>{if(this.i||this.h)return 0;throw e})))return null;let w=new Uint32Array(l.getMappedRange())[0];return l.unmap(),w===0?null:w-1}finally{u?.destroy(),s?.destroy(),c?.destroy(),l?.destroy()}}dispose(e=!0){if(!this.h){this.h=!0;for(let e of this.j.keys())this.remove(e);for(let e of this.v)for(let t of e?.textures??[])t.destroy();this.m.destroy(),e&&this.x.unconfigure(),this.e.destroy()}}},Ve=class{revision=0;e=[{name:`main`,order:0,joins:!0,execute:e=>{e.only=!0,e.draw(),e.only=!1}}];g;f=!1;idle(){if(this.f)throw a(`state`,`Graph executing`,`reentrancy`)}add(e){if(this.idle(),!e.name||!Number.isFinite(e.order)||typeof e.execute!=`function`||this.e.some(t=>t.name===e.name))throw o(`Invalid pass`,`arguments`);let t={...e,owner:this.g,execute:t=>e.execute(t),prepare:t=>e.prepare?.(t)};return this.e.push(t),this.e.sort((e,t)=>e.order-t.order),this.revision++,()=>{this.idle(),this.e=this.e.filter(e=>e!==t),this.revision++}}withOwner(e,t){this.idle();let n=this.g;this.g=e;try{t()}finally{this.g=n}}removeOwner(e){this.idle(),this.e=this.e.filter(t=>t.owner!==e),this.revision++}execute(e){if(this.f)throw a(`state`,`Graph recursion`,`reentrancy`);this.f=!0;try{for(let t=0;t<this.e.length;t++)e.last=t+1===this.e.length&&this.e[t].joins,e.joins=this.e[t+1]?.joins,this.e[t].execute(e),e.backend===`webgpu`&&!e.joins&&e.settle?.()}finally{this.f=!1}}prepare(e){if(this.f)throw a(`state`,`Graph recursion`,`reentrancy`);this.f=!0;try{for(let t of this.e)t.prepare?.(e)}finally{this.f=!1}}},He=`1.0.0`,Ue={version:He,source:import.meta.url};function O(e=He,t=import.meta.url){return{version:e,source:t,runtime:Ue}}function We(e,t=O()){let n=e?.coreRequirement?.runtime;if(n&&(n.version!==t.version||n.version!==t.runtime.version||n!==t.runtime))throw a(`version`,`core ${n.version} ${n.source}; ${t.source} needs ${t.version}, got ${t.runtime.version} ${t.runtime.source}`);return e}var Ge=`Engine disposed`,Ke=`WebGPU required`,qe=[`x`,`y`,`z`],Je=[`sx`,`sy`,`sz`],k=new WeakMap,A=(e,t)=>{try{t()}catch(t){e.push(t)}},j=class{e;f;constructor(e,t){this.e=e,this.f=t}h(e){return this.e.check(),this.f===`rotation`?this.e.engine.store.rotations[this.e.id*3+e]:this.e.engine.store.transforms[(this.f===`scale`?Je:qe)[e]][this.e.id]}g(e){if(typeof e!=`number`||!(e<34028235677973366e22&&e>-34028235677973366e22))throw s(`Invalid transform`,`transform`)}i(e,t){this.e.check(),this.g(t),this.f===`rotation`?(this.e.engine.store.rotations[this.e.id*3+e]=t,this.e.syncRotation()):this.e.engine.store.transforms[(this.f===`scale`?Je:qe)[e]][this.e.id]=t}set(e,t,n){this.e.check(),this.g(e),this.g(t),this.g(n);let r=this.f===`scale`?Je:qe,i=this.e.engine.store.transforms,a=this.e.id;for(let o=0;o<3;o++){let s=o===0?e:o===1?t:n;this.f===`rotation`?this.e.engine.store.rotations[a*3+o]=s:i[r[o]][a]=s}return this.f===`rotation`&&this.e.syncRotation(),this}setAll(e){return this.set(e,e,e)}get x(){return this.h(0)}set x(e){this.i(0,e)}get y(){return this.h(1)}set y(e){this.i(1,e)}get z(){return this.h(2)}set z(e){this.i(2,e)}},Ye=(e,t,r,i)=>{let a=n(4,r[i],r[i+1],r[i+2],r[i+3]);if(!a)throw s(`Quaternion nonzero`,`transform`);let o=r[i]/a,c=r[i+1]/a,l=r[i+2]/a,u=r[i+3]/a,d=e.transforms,f=e.rotations,p=t*3;d.qx[t]=o,d.qy[t]=c,d.qz[t]=l,d.qw[t]=u;let m=2*(o*l+u*c),h=2*(u*l-o*c),g=1-2*(c*c+l*l);f[p+1]=Math.asin(m>1?1:m<-1?-1:m),h*h+g*g<36e-13?(f[p]=0,f[p+2]=2*Math.atan2(l,u)):(f[p]=Math.atan2(2*(u*o-c*l),1-2*(o*o+c*c)),f[p+2]=Math.atan2(h,g))},Xe=(e,t)=>+(e[t+22]>.5||e[t]*(e[t+5]*e[t+10]-e[t+6]*e[t+9])-e[t+4]*(e[t+1]*e[t+10]-e[t+2]*e[t+9])+e[t+8]*(e[t+1]*e[t+6]-e[t+2]*e[t+5])<0),Ze=(e,t)=>{let n=t/24,r=1<<(n&31),i=e.rows;e.dirty>=0&&!(i[n>>5]&r)&&(i[n>>5]|=r,e.dirty++)},Qe=e=>Object.assign(e,{matrix:e.engine.store.matrices.subarray(e.id*16,e.id*16+16)}),$e=class{engine;id;scene;name=``;geometry=null;e=new E;get material(){return this.e}set material(e){if(!(e instanceof E))throw o(`Invalid material`,`arguments`);this.e=e,this.engine.collected=-1}f=!0;get receiveShadow(){return this.f}set receiveShadow(e){if(typeof e!=`boolean`)throw o(`receiveShadow: boolean`,`arguments`);this.f=e,this.engine.collected=-1}constructor(e,t,n=e.scene){this.engine=e,this.id=t,this.scene=n;for(let e of[`position`,`rotation`,`scale`]){let t=new j(this,e);Object.defineProperty(this,e,{get:()=>t,set:c,enumerable:!0})}Qe(this)}get visible(){return this.check(),this.engine.store.hidden[this.id]===0}set visible(e){if(this.check(),typeof e!=`boolean`)throw o(`Visibility: boolean`,`arguments`);this.engine.store.hidden[this.id]=+!e}check(){if(this.engine.disposed||this.engine.meshes.get(this.id)!==this)throw a(`disposed`,`Mesh disposed`)}setPosition(e){return this.check(),T(e,3,`Position`),this.position.set(e[0],e[1],e[2]),this}setScale(e){return this.check(),T(e,3,`Scale`),this.scale.set(e[0],e[1],e[2]),this}setRotation(e){return this.check(),T(e,3,`Rotation`),this.rotation.set(e[0],e[1],e[2]),this}syncRotation(){ie(this.engine.store,this.id)}setQuaternion(e){return this.check(),T(e,4,`Quaternion`),Ye(this.engine.store,this.id,e,0),this}setParent(e){if(this.check(),e?.check(),e&&(e.engine!==this.engine||e.scene!==this.scene))throw o(`Foreign parent`,`hierarchy`);let t=0;for(let n=e?.id??-1;n!==-1;n=this.engine.store.parents[n]){if(n===this.id)throw o(`Hierarchy cycle`,`hierarchy`);if(++t>=64)throw s(`Parent depth: 64`,`hierarchy`)}let n=e=>{let t=0;for(let r of e?.kids??[])t=Math.max(t,1+n(this.engine.meshes.get(r)));return t};if(e&&t+n(this)>=64)throw s(`Parent depth: 64`,`hierarchy`);let r=this.engine.store.parents;return this.engine.meshes.get(r[this.id])?.kids?.delete(this.id),e&&(e.kids??=new Set).add(this.id),r[this.id]=e?.id??-1,this}setGeometry(e){if(this.check(),e!==null&&!(e instanceof ee))throw o(`Invalid geometry`,`arguments`);if(e===this.geometry)return this;e&&this.engine.retain(e);let t=this.geometry;this.geometry=e;let n=this.engine.store.bounds;return n.fill(0,this.id*4,this.id*4+4),e&&n.set(e.bounds,this.id*4),t&&this.engine.release(t),this.engine.collected=-1,this}setMaterial(e){return this.check(),this.material=e,this}dispose(){this.engine.meshes.get(this.id)===this&&this.engine.remove(this)}},et=class{engine;name;background;frameGraph=new Ve;plugins=new Map;meshes=new Map;stats={visible:0,drawCalls:0};lighting={direction:new Float32Array([3,5,4,3]),radiance:new Float32Array([1,1,1,.15]),ambient:new Float32Array([1,1,1])};constructor(e,t){this.engine=e,this.name=t}createMesh(e=null){return this.engine.createMesh(e,this)}use(e){return this.engine.use(e,this),this}removePlugin(e){this.engine.removePlugin(e,this)}dispose(){let e=this.engine,t=[];if(this===e.scene)throw o(`Default scene: dispose the engine instead`,`scene`);if(e.scenes.delete(this)){for(let n of this.plugins.keys())A(t,()=>e.removePlugin(n,this));for(let t of this.meshes.values())e.remove(t);if(t.length)throw t[0]}}},tt=class e{canvas;store;renderer;fallbackReason;coreRequirement=O();scene;scenes=new Set;meshes=new Map;camera;disposed=!1;onError=e=>{typeof reportError==`function`?reportError(e):console.error(e)};pace;maxDelta=.1;views;i=new Map;k=[];I=new WeakMap;C=0;Q=[];D=0;r=0;collected=-1;unshadowed=0;L;K=-1;w=[];F;l;t=new Set;p=null;o=0;s=!1;n=!1;T=!0;q={delta:null};j=!1;g;A=new AbortController;y=0;B=0;f;e=-1;v;x;J=new WeakMap;features;exact;fixed;power;get frameGraph(){return this.f.frameGraph}get lighting(){return this.f.lighting}get stats(){return this.f.stats}get plugins(){return this.f.plugins}static async create(t,n={}){if(!t||typeof t.getContext!=`function`)throw o(`Expected canvas`,`arguments`);let r=n.backend??`auto`;if(![`auto`,`webgpu`,`webgl2`].includes(r))throw o(`Unknown backend`,`arguments`);let i=n.exactSize,c=n.antialias??!i?void 0:1;if(Array.isArray(i)){if(i.length!==2||!i.every(e=>Number.isInteger(e)&&e>0&&e<=8192))throw s(`Invalid exactSize`,`pixel-exact`);[t.width,t.height]=i}let l=await Ee.create(n.capacity??1024),u,d=null;try{if(n.signal?.throwIfAborted(),r!==`webgl2`)try{u=await Be.create(t,n.features,c,n)}catch(e){if(r===`webgpu`||n.signal?.aborted)throw e;d=String(e)}u??=(n.fallback??(()=>{throw a(`unsupported`,r===`webgl2`?`webgl2 needs fallback: webglRenderer`:`WebGPU unavailable`,`webgpu`)}))(t);let o=new e(t,l,u,n.camera,d);return o.features=n.features,o.exact=c,o.fixed=i?1:void 0,o.power=n.powerPreference,o}catch(e){throw u?.dispose(),l.dispose(),e}}constructor(e,t,n,r,i){this.canvas=e,this.store=t,this.renderer=n,this.fallbackReason=i,this.camera=new Ae(r),this.scenes.add(this.scene=this.f=new et(this,`default`)),this.F=new Uint8Array(t.capacity),this.l=new Int32Array(t.capacity),this.V()}V(){let e=this.renderer,t=(n,r)=>{if(this.disposed||this.j||this.renderer!==e)return;let i=()=>t(n,r);if(this.g)return void this.g.then(i,i);r&&this.onError(n),this.B=0,++this.y<4?this.rebootDevice().catch(e=>this.disposed||this.onError(e)):this.y===4&&this.onError(a(`failed`,`GPU lost 4 times; reload the page`,`gpu-lost`))};e.onLost=t}rebootDevice(){return this.disposed||this.j?Promise.reject(a(`disposed`,Ge)):this.backend===`webgpu`?(this.g||=(async()=>{let e=this.renderer,t=await Be.create(this.canvas,this.features,this.exact,{powerPreference:this.power,signal:this.A.signal},!1);try{this.A.signal.throwIfAborted();for(let e of this.i.values())t.add(e.geometry,e.instances.length/24);t.configure()}catch(e){throw t.dispose(!1),e}this.renderer=t,this.V(),e.dispose(!1);let n=[];for(let e of this.scenes){let t=this.h(e);for(let t of e.plugins.values())A(n,()=>t.onDeviceRestored?.(this));this.h(t)}if(n.length)throw n[0]})().finally(()=>{this.g=void 0}),this.g):Promise.reject(a(`unsupported`,Ke,`webgpu`))}O(){return this.y&&++this.B>=120&&(this.y=this.B=0),!0}get backend(){return this.renderer.backend}get renderTarget(){return this.renderer.target??null}get gpu(){return this.renderer.gpu??null}geometryBuffers(e){if(this.disposed||this.j||this.g)throw a(`state`,`Geometry unavailable`,`device-restore`);return e.indices.length?this.renderer.geometryBuffers?.(e)??null:null}hasPlugin(e){return this.plugins.has(e)}h(e){let t=this.f;if(t!==e){for(let n of this.i.values()){let r=this.J.get(n);r||this.J.set(n,r=new WeakMap),r.set(t,[n.claimed,n.redirect]),[n.claimed,n.redirect]=r.get(e)??[]}this.f=e}return t}m(){if(this.disposed||this.j)throw a(`disposed`,Ge)}u(e){if(!this.scenes.has(e))throw o(`Unknown scene: use engine.createScene()`,`scene`)}use(e,t=this.f){this.m(),e.coreRequirement&&We(this,e.coreRequirement),this.u(t);let n=e.name,r=t.plugins;if(!n||r.has(n)||k.has(e)||typeof e.setup!=`function`)throw o(`Invalid plugin`,`arguments`);let i=this.h(t);try{t.frameGraph.withOwner(n,()=>{r.set(n,e);for(let[e,t]of[...r])t.late&&(r.delete(e),r.set(e,t));k.set(e,t);try{e.setup(this),e.registerPasses?.(t.frameGraph)}catch(i){t.frameGraph.removeOwner(n),r.delete(n),k.delete(e);try{e.dispose?.()}catch{}throw i}})}finally{this.h(i)}return this}removePlugin(e,t=this.f){let n=t.plugins.get(e);if(!n)return;t.frameGraph.removeOwner(e),t.plugins.delete(e),k.delete(n);let r=this.h(t);try{n.dispose?.()}finally{this.h(r)}}createScene(e=`scene`){this.m();let t=new et(this,e);return this.scenes.add(t),t}sceneOf(e){let t=k.get(e);return t?.engine===this?t:void 0}createMesh(e=null,t=this.f){if(this.m(),this.u(t),e?.check(),e&&(e.engine!==this||e.scene!==t))throw o(`Foreign parent`,`hierarchy`);let n=this.Q.pop()??this.D++;if(n>=this.store.capacity)try{let e=Math.min(n*2,1<<23),t=new Uint8Array(e),r=new Int32Array(e);this.store.grow(e),this.F=t,this.l=r,this.meshes.forEach(Qe)}catch(e){throw this.D=n,e}let r=this.store.transforms;for(let e of[`x`,`y`,`z`,`qx`,`qy`,`qz`])r[e][n]=0;for(let e of[`qw`,`sx`,`sy`,`sz`])r[e][n]=1;this.store.parents[n]=-1,this.store.constrained[n]=0,this.store.hidden[n]=0,this.store.rotations.fill(0,n*3,n*3+3);let i=new $e(this,n,t);this.meshes.set(n,i),t.meshes.set(n,i),i.born=this.r++,this.store.active[n]=1;try{return i.setParent(e)}catch(e){throw i.dispose(),e}}remove(e){let t=this.store.parents;if(e.check(),!this.j){for(let n of e.kids??[])t[n]=-1;e.setParent(null)}e.geometry&&this.release(e.geometry),this.meshes.delete(e.id),e.scene.meshes.delete(e.id),this.r++,this.store.active[e.id]=0,this.store.visible[e.id]=0,this.Q.push(e.id)}writePoses(e,t,n=e.length){this.m();let{transforms:r,active:i}=this.store;if(!(n>=0&&n<=e.length&&t.length>=n*7))throw s(`Invalid poses`,`transform`);for(let r=0,o=0;r<n;r++,o+=7){if(i[e[r]]!==1)throw a(`disposed`,`Mesh disposed`);for(let e=o;e<o+7;e++){let n=t[e];if(typeof n!=`number`||!(n<34028235677973366e22&&n>-34028235677973366e22))throw s(`Invalid transform: ${r}`,`transform`)}if(!(t[o+3]||t[o+4]||t[o+5]||t[o+6]))throw s(`Quaternion nonzero: ${r}`,`transform`)}for(let i=0,a=0;i<n;i++,a+=7){let n=e[i];r.x[n]=t[a],r.y[n]=t[a+1],r.z[n]=t[a+2],Ye(this.store,n,t,a+3)}}retain(e){if(!e.indices.length)return;let t=this.i.get(e)??{geometry:e,instances:new Float32Array,rows:new Uint32Array,count:0,references:0};if(t.references>=t.instances.length/24){let n=(t.references+1)*2,r=new Float32Array(n*24),i=new Uint32Array(n+31>>5);this.renderer.add(e,n),t.instances=r,t.rows=i,this.collected=-1}t.references++||(this.i.set(e,t),this.k.push(t))}release(e){if(!e.indices.length)return;let t=this.i.get(e);--t.references===0&&(this.renderer.remove(e),this.i.delete(e),this.k.splice(this.k.indexOf(t),1))}X=e=>{(this.e===-1||d(e)&this.e)&&(this.unshadowed+=+!e.receiveShadow,e.geometry?.indices.length&&this.store.visible[e.id]&&this.S(e))};S(e){if(this.I.get(e.material)!==this.C){let t=e.material.data;T(t,8,`Material`);for(let e=0;e<8;e++)if(t[e]<0||t[e]>1)throw s(`Invalid material`,`material`);if(t[3]!==1||t[4]<Math.fround(.045)||t[6]!==0&&t[6]!==1)throw s(`Invalid material`,`material`);this.I.set(e.material,this.C),this.w.push([e.material,...t])}let t=this.i.get(e.geometry),n=t.count++*24;this.l[e.id]=n,t.instances.set(e.matrix,n),t.instances.set(e.material.data,n+16),e.receiveShadow||(t.instances[n+22]+=.25),t.instances[n+23]=e.id,t.mask+=Xe(t.instances,n),Ze(t,n)}render({camera:e=this.camera,culling:t=!0,delta:n=0,views:r}={}){if(this.n)throw a(`state`,`Render recursion`,`reentrancy`);if(r)return this.Z(r,t,n);if(!(e instanceof Ae))throw o(`Invalid camera`,`arguments`);this.n=!0,this.v=void 0;let i=!1;try{this.G(t,n,e);let r=this.f.background,{width:i,height:a}=this.canvas;!this.g&&!this.disposed&&this.O()&&this.renderer.render(e,this.lighting,this.k,this.frameGraph,n,r===void 0&&this.e===-1?void 0:{rect:[0,0,i,a],index:0,count:1,id:`0`,clear:r===void 0?void 0:{color:r??!1},layers:this.e===-1?void 0:this.e})}catch(e){throw i=!0,e}finally{try{e!==this.camera&&!this.disposed&&!this.j&&(this.camera.update(this.canvas.width/this.canvas.height,this.backend===`webgpu`),this.store.planes.set(this.camera.planes),this.store.tick(this.T),this.e=this.H(this.camera),this.M())}catch(e){if(!i)throw e}finally{this.n=!1}}}Z(e,t,n){if(!Array.isArray(e)||!e.length)throw o(`Invalid views`,`views`);this.n=!0;let r=new Set,i=new Set,a=[],s=e=>e?.target?.color??this.canvas,c=new Map,l=new Map;for(let t of e)c.set(s(t),(c.get(s(t))??0)+1);let u=[...c.keys()],d=e.map((e,t)=>t).sort((t,n)=>u.indexOf(s(e[t]))-u.indexOf(s(e[n])));try{this.E();for(let u of d){let d=e[u];if(!(d?.camera instanceof Ae)||!d.viewport)throw o(`Invalid view: pass {camera, viewport}`,`views`);let f={...d,viewport:[...d.viewport],scissor:d.scissor&&[...d.scissor]},p=f.scene??this.scene,m=f.target?.color,h=m?[m.width,m.height]:[this.canvas.width,this.canvas.height],g=this.z(f.viewport,f.pixels,h),_=!i.has(p);if(this.u(p),this.h(p),this.G(t,r.has(f.camera)?0:n,f.camera,g,_,n,f.layers),this.disposed)break;r.add(f.camera),i.add(p),!this.g&&(u||this.O())&&this.renderer.render(f.camera,this.lighting,this.k,this.frameGraph,_?n:0,{rect:g,scissor:f.scissor&&this.z(f.scissor,f.pixels,h),layers:this.e===-1?void 0:this.e,index:l.get(s(f))??0,count:c.get(s(f)),id:f.id??String(u),clear:f.clear??(p.background===void 0?void 0:{color:p.background??!1}),target:f.target}),l.set(s(f),(l.get(s(f))??0)+1),m||a.push(f)}}finally{this.n=!1,this.v=a,this.h(this.scene)}}z(e,t,[n,r],i){let a=t?[...e]:[Math.round(e[0]*n),Math.round(e[1]*r),Math.round((e[0]+e[2])*n)-Math.round(e[0]*n),Math.round((e[1]+e[3])*r)-Math.round(e[1]*r)];return i||p(a,n,r),a}G(e,t,n=this.camera,r,i=!0,a=t,o){if(this.m(),!Number.isFinite(a)||a<0||a>1)throw s(`Invalid delta`,`arguments`);if(this.N=a,i&&this.plugins.forEach(this.Y),this.disposed)return;r||this.E(),n.advance(t),n.update(r?r[2]/r[3]:this.canvas.width/this.canvas.height,this.backend===`webgpu`),this.e=this.H(n,o),this.store.planes.set(n.planes),this.store.tick(e);let{direction:c,radiance:l,ambient:u}=this.lighting;T(c,4,`Light`),T(l,4,`Radiance`),T(u,3,`Ambient`);let d=!(c[0]||c[1]||c[2])||c[3]<0;for(let e=0;e<4;e++)d||=l[e]<0||e<3&&u[e]<0;if(d)throw s(`Invalid lighting`,`lighting`);if(this.M(),this.n){let{stats:e}=this,t=this.k;e.visible=e.drawCalls=0;for(let n=0;n<t.length;n++)e.visible+=t[n].count,(t[n].count||t[n].redirect)&&!t[n].claimed&&e.drawCalls++}n===this.camera&&(this.T=e)}H(e,t){return(t===void 0?u()?.cameras.get(e)??-1:m(t,`View layers`))|0}E(){if(this.fixed)return;let e=Math.min(globalThis.devicePixelRatio??1,globalThis.margoLow||2,4/Me(this)),t=Math.round(this.canvas.clientWidth*e)||this.canvas.width,n=Math.round(this.canvas.clientHeight*e)||this.canvas.height,r=Math.min(1,(this.gpu?.limits.maxTextureDimension2D??4096)/Math.max(t,n)),i=Math.max(1,Math.round(t*r)),a=Math.max(1,Math.round(n*r));this.canvas.width!==i&&(this.canvas.width=i),this.canvas.height!==a&&(this.canvas.height=a)}M(){let{visible:e,changed:t}=this.store,n=this.F,r=this.f,i=this.e,a=this.collected!==this.r||this.L!==r||this.K!==i||i!==-1&&!!u()?.source;for(let e=0;!a&&e<this.w.length;e++)for(let t=0,n=this.w[e];!a&&t<8;t++)a=n[0].data[t]!==n[t+1];if(a){this.collected=-1;for(let e of this.k)e.count=e.mask=0,e.dirty=-1;this.unshadowed=0,this.C++,this.w.length=0,this.l.fill(-1),r.meshes.forEach(this.X),this.collected=this.r,this.L=r,this.K=i,n.set(e),t.fill(0)}else{for(let a=0;a<this.D;a++)if(e[a]!==n[a]){let o=this.meshes.get(a),s=this.l[a];if(o?.geometry?.indices.length&&o.scene===r&&(i===-1||d(o)&i)&&+(s>=0)!==e[a]){if(s<0)this.S(o),t[a]=0;else{let e=this.i.get(o.geometry),t=--e.count*24,n=e.instances;e.mask-=Xe(n,s),s!==t&&(n.copyWithin(s,t,t+24),this.l[n[s+23]]=s,Ze(e,s)),this.l[a]=-1}}n[a]=e[a]}for(let e=t.indexOf(1);e>=0;e=t.indexOf(1,e+1)){t[e]=0;let n=this.l[e];if(n>=0){let t=this.meshes.get(e),r=this.i.get(t.geometry);r.mask-=Xe(r.instances,n),r.instances.set(t.matrix,n),r.mask+=Xe(r.instances,n),Ze(r,n)}}}}pick(e,t,n){let r=n&&{...n},i=this.x??(this.n?Promise.resolve():void 0),a,o=this.x=new Promise(e=>a=e),s=i?i.then(()=>this.disposed||this.j?null:this.R(e,t,r)):this.R(e,t,r),c=()=>{this.x===o&&(this.x=void 0),a()};return s.then(c,c),s}async R(e,t,n){if(![e,t].every(Number.isFinite))throw s(`Invalid pick`,`views`);if(this.m(),this.backend!==`webgpu`)throw a(`unsupported`,Ke,`webgpu`);let r=this.canvas.clientWidth||this.canvas.width,i=this.canvas.clientHeight||this.canvas.height;if(e<0||t<0||e>=r||t>=i||this.g)return null;this.E();let c=this.renderer,l=this.r,u=[this.canvas.width,this.canvas.height],f=e*u[0]/r,p=t*u[1]/i,m=e=>!e||f>=e[0]&&p>=e[1]&&f<e[0]+e[2]&&p<e[1]+e[3],h=(e,t)=>({...e,viewport:this.z(e.viewport,e.pixels,u,t),scissor:e.scissor&&this.z(e.scissor,e.pixels,u,t),pixels:!0}),g=n&&h(n);if(!n&&this.v){for(let e of this.v){let t=h(e,!0);m(t.viewport)&&m(t.scissor)&&(g=t)}if(!g)return null}if(g&&!(m(g.viewport)&&m(g.scissor)))return null;let _=g?.scene??this.scene,v=g?.camera??this.camera,y=g?.viewport;if(this.u(_),!(v instanceof Ae))throw o(`Invalid camera`,`arguments`);let b=this.h(_),x;try{this.G(!0,0,v,y,!0,0,g?.layers),g&&(g.layers=this.e===-1?void 0:this.e);let n=[...this.plugins.values()].find(e=>e.onPick);x=n?n.onPick(e,t,g):c.pick(v,this.lighting,this.k,this.frameGraph,f-(y?.[0]??0),p-(y?.[1]??0),y&&[y[2],y[3]]).then(e=>this.meshes.get(e??-1)??null)}finally{this.h(b)}let S=this.e,C=await x;return this.renderer===c&&(!C||this.meshes.get(C.id)===C&&C.born<l&&C.scene===_&&(S===-1||d(C)&S))?C:null}onFrame(e){return this.t.add(e),()=>{this.t.delete(e)}}start({culling:e}={}){this.m(),this.q.culling=e,!this.s&&(this.s=!0,this.o=0,globalThis.document?.addEventListener(`visibilitychange`,this.U),this.p=requestAnimationFrame(this.P))}U=()=>{this.o=0};N=0;Y=e=>e.onPreUpdate?.(this.N);W=e=>e(this,this.q.delta);P=e=>{if(this.p=null,this.s){if(!this.pace||this.pace(e)){let t=(e-this.o)/1e3,n=this.maxDelta,r=this.o?t!==t||t<n?t:n:0;this.o=e;try{this.q.delta=r,this.t.forEach(this.W),this.q.views=this.views?.length?this.views:void 0,this.disposed||this.render(this.q)}catch(e){this.stop(),this.onError(e);return}}this.s&&(this.p??=requestAnimationFrame(this.P))}};stop(){this.s=!1,this.p!==null&&cancelAnimationFrame(this.p),this.p=null,this.o=0,globalThis.document?.removeEventListener(`visibilitychange`,this.U)}dispose(){if(this.disposed||this.j)return;this.j=!0,this.stop(),this.A.abort(a(`disposed`,Ge));let e=[];for(let t of this.scenes)for(let n of t.plugins.keys())A(e,()=>this.removePlugin(n,t));for(let t of this.meshes.values())A(e,()=>t.dispose());if(this.t.clear(),A(e,()=>this.renderer.dispose()),A(e,()=>this.store.dispose()),this.disposed=!0,e.length)throw e[0]}};if(Symbol.dispose)for(let e of[tt,$e,et])e.prototype[Symbol.dispose]=e.prototype.dispose;var nt=(e,t=He,n=import.meta.url)=>(We(e,O(t,n)),e),rt=`modulepreload`,M=function(e,t){return new URL(e,t).href},N={},P=function(e){return e.pathname.endsWith(`.css`)},F=function(e,t,n){if(t in e)return e[t];let r=n();if(!r){e[t]=void 0;return}let i=r.then(()=>{e[t]=void 0},n=>{throw e[t]=void 0,n});return e[t]=i,i},it=function(e,t,n){let r=Promise.resolve();if(t&&t.length>0){let e,i=document.querySelector(`meta[property=csp-nonce]`),a=i?.nonce||i?.getAttribute(`nonce`);function o(e){return Promise.all(e.map(e=>Promise.resolve(e).then(e=>({status:`fulfilled`,value:e}),e=>({status:`rejected`,reason:e}))))}function s(e){return import.meta.resolve?new URL(import.meta.resolve(e)):new URL(e,import.meta.url)}r=o(t.map(t=>{t=M(t,n);let r=s(t),i=P(r);return F(N,r.href,()=>{if(e===void 0){e={all:new Set,styles:new Set};let t=document.getElementsByTagName(`link`);for(let n=t.length-1;n>=0;n--){let r=t[n];e.all.add(r.href),r.rel===`stylesheet`&&e.styles.add(r.href)}}if((i?e.styles:e.all).has(r.href))return;let t=document.createElement(`link`);if(t.rel=i?`stylesheet`:rt,i||(t.as=`script`),t.crossOrigin=``,t.href=r.href,a&&t.setAttribute(`nonce`,a),document.head.appendChild(t),i)return new Promise((e,n)=>{t.addEventListener(`load`,e),t.addEventListener(`error`,()=>n(Error(`Unable to preload CSS for ${r}`)))})})}).filter(e=>e!==void 0))}function i(e){let t=new Event(`vite:preloadError`,{cancelable:!0});if(t.payload=e,window.dispatchEvent(t),!t.defaultPrevented)throw e}return r.then(t=>{for(let e of t||[])e.status===`rejected`&&i(e.reason);return e().catch(i)})},I={shadows:{resolution:1024,filter:`pcf`},ssao:{samples:16},ssr:{enabled:!1,steps:32},volumetric:{grid:[80,45,32]},localShadows:{resolution:256},vfx:{capacity:1e5}},L={high:{},light:I,phone:{...I,shadows:{...I.shadows,cascades:2},ssao:{enabled:!1},volumetric:{enabled:!1},scatter:{lodFade:0}}},R=`margoQualityLowered`,at=`margoQuality`,ot=`held`,st=`timestamp-query`;function ct(e){let t=e.requestDevice;function n(e={}){return t.call(this,this.features.has(st)?{...e,requiredFeatures:new Set([...e.requiredFeatures??[],st])}:e)}return e.requestDevice=n,()=>{e.requestDevice===n&&(e.requestDevice=t)}}var lt,ut=()=>{try{return globalThis.localStorage}catch{return}},dt=()=>{try{return globalThis.sessionStorage}catch{return}};function ft({search:e=globalThis.location?.search,page:t=globalThis.location?.pathname,storage:n=ut(),session:r=dt(),userAgent:i=globalThis.navigator?.userAgent??``}={}){let a=new URLSearchParams(e),o=a.get(`quality`)??void 0,s=t?`${at}:${t}`:at,c,l=!1;try{c=n?.getItem(s)??void 0}catch{}try{l=!!r?.getItem(R)}catch{}let u=o===`high`||o===`low`?o:void 0,d=u??c,f=l&&!u&&c===`high`,p=/Mobi|Android|iPhone/.test(i)?`phone`:d===`high`&&!f?`high`:`light`;p===`high`?delete globalThis.margoLow:globalThis.margoLow=p===`phone`?1:Math.min(2,Math.max(1,Number(a.get(`scale`))||1)),globalThis.margoPreset=L[p];let m=u??(f?`power`:void 0);return lt?.(),lt=p===`light`&&!m&&c!==ot&&typeof GPUAdapter<`u`?ct(GPUAdapter.prototype):void 0,p}var pt=`
struct Varyings {
  @builtin(position) position: vec4f,
  @location(0) ndc: vec2f,
}
@group(0) @binding(0) var backdrop: texture_2d<f32>;
@group(0) @binding(1) var sampleBackdrop: sampler;
@group(0) @binding(2) var<uniform> projection: vec4f;
@vertex fn vertex(@builtin(vertex_index) vertexIndex: u32) -> Varyings {
  let corners = array(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  let xy = corners[vertexIndex];
  return Varyings(vec4f(xy, 0, 1), xy);
}
@fragment fn fragment(input: Varyings) -> @location(0) vec4f {
  let uv = vec2f(.5) + input.ndc * projection.xy;
  return vec4f(textureSample(backdrop, sampleBackdrop, uv).rgb, 1);
}
`,mt=1.1,ht=class{name=`marsh-sky-backdrop`;constructor(e){this.bitmap=e,this.projection=new Float32Array(4)}setup(e){this.engine=e;let t=e.gpu,{width:n,height:r}=this.bitmap;this.texture=t.createTexture({size:{width:n,height:r},format:`rgba8unorm`,usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST|GPUTextureUsage.RENDER_ATTACHMENT}),t.queue.copyExternalImageToTexture({source:this.bitmap},{texture:this.texture},{width:n,height:r}),this.uniform=t.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),this.sampler=t.createSampler({minFilter:`linear`,magFilter:`linear`}),this.module=t.createShaderModule({code:pt})}registerPasses(e){e.add({name:this.name,order:2,execute:e=>{e.backend===`webgpu`&&this.draw(e)}})}draw(e){let{device:t,format:n,descriptor:r,camera:i}=e,a=r.depthStencil.format,o=r.multisample?.count??1,s=n+`:`+a+`:`+o;this.target!==s&&(this.pipeline=t.createRenderPipeline({layout:`auto`,vertex:{module:this.module,entryPoint:`vertex`},fragment:{module:this.module,entryPoint:`fragment`,targets:[{format:n}]},depthStencil:{format:a,depthCompare:`greater-equal`,depthWriteEnabled:!1},multisample:{count:o}}),this.group=t.createBindGroup({layout:this.pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:this.texture.createView()},{binding:1,resource:this.sampler},{binding:2,resource:{buffer:this.uniform}}]}),this.target=s);let c=this.engine.canvas,l=.5*Math.tan(i.fov*Math.PI/360)/mt;this.projection[0]=l*c.width/c.height,this.projection[1]=-l,t.queue.writeBuffer(this.uniform,0,this.projection);let u=e.encoder.beginRenderPass({colorAttachments:[{view:e.color,loadOp:`load`,storeOp:`store`}],depthStencilAttachment:{view:e.depth,depthReadOnly:!0,stencilReadOnly:!0}});u.setPipeline(this.pipeline),u.setBindGroup(0,this.group),u.draw(3),u.end()}release(){this.texture?.destroy(),this.uniform?.destroy(),this.target=void 0,this.group=this.pipeline=this.sampler=this.module=this.texture=this.uniform=void 0}onDeviceRestored(e){this.release(),this.setup(e)}dispose(){this.release(),this.bitmap.close()}};function gt(e){return e?.view?.viewport}function _t(e,t){let n=gt(t);if(!n)return;e.setViewport(n[0],n[1],n[2],n[3],0,1);let r=t.view.scissor??n;e.setScissorRect(r[0],r[1],r[2],r[3])}function vt(e){return e?.adapterInfo?.vendor===`margo-webgl2`?`webgl2`:`native`}var yt=class extends Error{constructor(e,t){super(t),this.name=`MargoError`,this.code=e}static[Symbol.hasInstance](e){return e instanceof Error&&e.name===`MargoError`}};function bt(e,t){if(e.backend===`webgl2`||!e.gpu)throw new yt(`unsupported`,`${t} needs WebGPU; see https://margoengine.com/errors#webgpu`)}var xt=e=>e<=.04045?e/12.92:((e+.055)/1.055)**2.4,St=e=>e<0?-xt(-e):xt(e);function Ct(e){let[t,n,r,i,a,o,s,c,l]=e,u=a*l-o*c,d=o*s-i*l,f=i*c-a*s,p=t*u+n*d+r*f;return[u,r*c-n*l,n*o-r*a,d,t*l-r*s,r*i-t*o,f,n*s-t*c,t*a-n*i].map(e=>e/p)}var wt=(e,t)=>e.map((n,r)=>{let i=r-r%3,a=r%3;return e[i]*t[a]+e[i+1]*t[3+a]+e[i+2]*t[6+a]});function Tt(e,t,n,r){let[i,a,o,s]=[e,t,n,r].map(e=>[e[0]/e[1],1,(1-e[0]-e[1])/e[1]]),c=[i[0],a[0],o[0],i[1],a[1],o[1],i[2],a[2],o[2]],l=Ct(c),u=[0,1,2].map(e=>l[e*3]*s[0]+l[e*3+1]*s[1]+l[e*3+2]*s[2]);return c.map((e,t)=>e*u[t%3])}var Et=[.3127,.329],Dt=Object.freeze(wt(Ct(Tt([.64,.33],[.3,.6],[.15,.06],Et)),Tt([.68,.32],[.265,.69],[.15,.06],Et)));function Ot(e,t,n,r){let i=t[0],a=t[1],o=t[2];n[r]=e[0]*i+e[1]*a+e[2]*o,n[r+1]=e[3]*i+e[4]*a+e[5]*o,n[r+2]=e[6]*i+e[7]*a+e[8]*o}function kt(e,t,n,r,i,a){let o=r===`srgb`||r===`display-p3`?[St(e),St(t),St(n)]:[e,t,n];r===`display-p3`||r===`display-p3-linear`?Ot(Dt,o,i,a):(i[a]=o[0],i[a+1]=o[1],i[a+2]=o[2])}var At=[`srgb`,`srgb-linear`,`display-p3`,`display-p3-linear`];function jt(e){let t=/^color\(\s*([a-z0-9-]+)\s+([^)]*)\)$/i.exec(e.trim());if(!t)return null;let n=t[1].toLowerCase(),r=t[2].split(`/`)[0].trim().split(/[\s,]+/);if(!At.includes(n))throw TypeError(`Color space '${t[1]}' is unknown; use srgb, srgb-linear, display-p3 or display-p3-linear`);let i=r.map(e=>e.endsWith(`%`)?parseFloat(e)/100:Number(e));if(i.length!==3||!i.every(Number.isFinite))throw TypeError(`Color '${e}' needs three numbers: color(${n} r g b)`);return{rgb:i,space:n}}function Mt(e){let t=/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(e)?.[1];return t?(t.length<4?t.replace(/./g,`$&$&`):t).padEnd(8,`f`).match(/../g).map(e=>parseInt(e,16)/255):void 0}function Nt(e,t=[0,0,0],n=0){let r;if(typeof e==`number`){if(!Number.isInteger(e)||e<0||e>16777215)throw RangeError(`Numeric colors must be 0x000000..0xffffff`);r=[e>>16&255,e>>8&255,e&255].map(e=>xt(e/255))}else if(typeof e==`string`&&/^\s*color\(/i.test(e)){let{rgb:t,space:n}=jt(e);r=[0,0,0],kt(t[0],t[1],t[2],n,r,0)}else if(typeof e==`string`){let t=Mt(e);if(!t)throw TypeError(`Color strings must be #rrggbb or #rgb`);r=t.slice(0,3).map(xt)}else if(e&&typeof e==`object`&&e.length===3){if(r=[e[0],e[1],e[2]],r.some(e=>typeof e!=`number`||!Number.isFinite(e)||e<0))throw RangeError(`Linear RGB colors must be finite and non-negative`)}else throw TypeError(`Expected a color`);return t[n]=r[0],t[n+1]=r[1],t[n+2]=r[2],t}var Pt=e=>{let t=Math.imul(e^e>>>15,e|1);return t^=t+Math.imul(t^t>>>7,t|61),((t^t>>>14)>>>0)/4294967296},Ft=1831565813;function It(e=0){let t=e|0;return()=>Pt(t=t+Ft|0)}var Lt=(e,t=`1.0.0`,n=import.meta.url)=>nt(e,t,n),z=`
struct Boid {
  pos: vec4f,
  vel: vec4f,
}
struct Sim {

  counts: vec4u,

  boundsCenter: vec4f,

  boundsHalf: vec4f,

  radii: vec4f,

  weights: vec4f,

  speeds: vec4f,

  limits: vec4f,

  anim: vec4f,

  entities: vec4u,

  debug: vec4u,

  attractors: array<vec4f, 32>,

  predators: array<vec4f, 32>,

  obstacles: array<vec4f, 64>,
}
@group(0) @binding(0) var<uniform> sim: Sim;

fn hashCell(c: vec3i) -> u32 {
  return ((bitcast<u32>(c.x) * 73856093u) ^ (bitcast<u32>(c.y) * 19349663u) ^ (bitcast<u32>(c.z) * 83492791u)) & sim.counts.z;
}
fn cellOf(p: vec3f) -> vec3i {
  return vec3i(floor(p * sim.radii.w));
}
`,Rt=z+`
@group(0) @binding(1) var<storage, read_write> grid: array<u32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x < sim.counts.y) {
    grid[id.x] = 0u;
  }
}
`,zt=z+`
@group(0) @binding(1) var<storage, read> boids: array<Boid>;
@group(0) @binding(2) var<storage, read_write> grid: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read_write> keys: array<u32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  let n = sim.counts.x;
  if (i >= n) { return; }
  let b = hashCell(cellOf(boids[i].pos.xyz));
  keys[i] = b;
  keys[n + i] = atomicAdd(&grid[b], 1u);
}
`,Bt=z+`
@group(0) @binding(1) var<storage, read_write> grid: array<u32>;
var<workgroup> temp: array<u32, 256>;
@compute @workgroup_size(256)
fn main(@builtin(local_invocation_id) lid: vec3u, @builtin(workgroup_id) wg: vec3u) {
  let g = sim.counts.y;
  let tid = lid.x;
  let gid = wg.x * 256u + tid;
  temp[tid] = select(0u, grid[gid], gid < g);

  var offset = 1u;
  for (var d = 128u; d > 0u; d = d >> 1u) {
    workgroupBarrier();
    if (tid < d) {
      let ai = offset * (2u * tid + 1u) - 1u;
      let bi = offset * (2u * tid + 2u) - 1u;
      temp[bi] = temp[bi] + temp[ai];
    }
    offset = offset << 1u;
  }
  workgroupBarrier();
  if (tid == 0u) {
    grid[2u * g + wg.x] = temp[255u];
    temp[255u] = 0u;
  }

  for (var d = 1u; d < 256u; d = d << 1u) {
    offset = offset >> 1u;
    workgroupBarrier();
    if (tid < d) {
      let ai = offset * (2u * tid + 1u) - 1u;
      let bi = offset * (2u * tid + 2u) - 1u;
      let t = temp[ai];
      temp[ai] = temp[bi];
      temp[bi] = temp[bi] + t;
    }
  }
  workgroupBarrier();
  if (gid < g) {
    grid[g + gid] = temp[tid];
  }
}
`,Vt=z+`
@group(0) @binding(1) var<storage, read_write> grid: array<u32>;
var<workgroup> temp: array<u32, 256>;
@compute @workgroup_size(256)
fn main(@builtin(local_invocation_id) lid: vec3u) {
  let g = sim.counts.y;
  let tid = lid.x;
  let blocks = g >> 8u;
  temp[tid] = select(0u, grid[2u * g + tid], tid < blocks);
  var offset = 1u;
  for (var d = 128u; d > 0u; d = d >> 1u) {
    workgroupBarrier();
    if (tid < d) {
      let ai = offset * (2u * tid + 1u) - 1u;
      let bi = offset * (2u * tid + 2u) - 1u;
      temp[bi] = temp[bi] + temp[ai];
    }
    offset = offset << 1u;
  }
  workgroupBarrier();
  if (tid == 0u) {
    temp[255u] = 0u;
  }
  for (var d = 1u; d < 256u; d = d << 1u) {
    offset = offset >> 1u;
    workgroupBarrier();
    if (tid < d) {
      let ai = offset * (2u * tid + 1u) - 1u;
      let bi = offset * (2u * tid + 2u) - 1u;
      let t = temp[ai];
      temp[ai] = temp[bi];
      temp[bi] = temp[bi] + t;
    }
  }
  workgroupBarrier();
  if (tid < blocks) {
    grid[2u * g + 256u + tid] = temp[tid];
  }
}
`,Ht=z+`
@group(0) @binding(1) var<storage, read_write> grid: array<u32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let g = sim.counts.y;
  if (id.x < g) {
    grid[g + id.x] = grid[g + id.x] + grid[2u * g + 256u + (id.x >> 8u)];
  }
}
`,Ut=z+`
@group(0) @binding(1) var<storage, read> grid: array<u32>;
@group(0) @binding(2) var<storage, read_write> keys: array<u32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  let n = sim.counts.x;
  if (i >= n) { return; }
  keys[2u * n + grid[sim.counts.y + keys[i]] + keys[n + i]] = i;
}
`,Wt=z+`
@group(0) @binding(1) var<storage, read> boids: array<Boid>;
@group(0) @binding(2) var<storage, read> grid: array<u32>;
@group(0) @binding(3) var<storage, read_write> keys: array<u32>;
@group(0) @binding(4) var<storage, read_write> sorted: array<Boid>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  let n = sim.counts.x;
  if (i >= n) { return; }
  let b = keys[i];
  let start = grid[sim.counts.y + b];
  let m = grid[b];
  var rank = 0u;
  for (var k = 0u; k < m; k = k + 1u) {
    if (keys[2u * n + start + k] < i) { rank = rank + 1u; }
  }
  sorted[start + rank] = boids[i];
  keys[3u * n + start + rank] = i;
}
`,Gt=z+`
@group(0) @binding(1) var<storage, read> boidsIn: array<Boid>;
@group(0) @binding(2) var<storage, read> sorted: array<Boid>;
@group(0) @binding(3) var<storage, read> keys: array<u32>;
@group(0) @binding(4) var<storage, read> grid: array<u32>;
@group(0) @binding(5) var<storage, read_write> boidsOut: array<Boid>;
@group(0) @binding(6) var<storage, read_write> debugOut: array<vec4f, 8>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  let n = sim.counts.x;
  if (i >= n) { return; }
  let me = boidsIn[i];
  let myPos = me.pos.xyz;
  let myVel = me.vel.xyz;
  let h = sim.limits.x;
  let spd = length(myVel);
  let fwd = select(vec3f(0.0, 0.0, 1.0), myVel / max(spd, 1e-5), spd > 1e-5);
  let neighR2 = sim.radii.x * sim.radii.x;
  let sepR = sim.radii.y;
  let cosHalfVision = sim.radii.z;
  let maxN = sim.counts.w;
  let cellCap = maxN * 2u;
  let g = sim.counts.y;
  let c = cellOf(myPos);

  var sepSum = vec3f(0.0);
  var sepCount = 0u;
  var aliSum = vec3f(0.0);
  var cohSum = vec3f(0.0);
  var neighCount = 0u;
  var seen: array<u32, 27>;
  var nSeen = 0u;
  var done = false;

  for (var dz = -1; dz <= 1 && !done; dz = dz + 1) {
    for (var dy = -1; dy <= 1 && !done; dy = dy + 1) {
      for (var dx = -1; dx <= 1 && !done; dx = dx + 1) {
        let b = hashCell(c + vec3i(dx, dy, dz));

        var dup = false;
        for (var s = 0u; s < nSeen; s = s + 1u) {
          if (seen[s] == b) { dup = true; }
        }
        if (dup) { continue; }
        seen[nSeen] = b;
        nSeen = nSeen + 1u;
        let start = grid[g + b];
        let cnt = min(grid[b], cellCap);
        for (var k = 0u; k < cnt; k = k + 1u) {
          let j = keys[3u * n + start + k];
          if (j == i) { continue; }
          let other = sorted[start + k];
          let diff = other.pos.xyz - myPos;
          let d2 = dot(diff, diff);
          if (d2 <= 1e-8 || d2 > neighR2) { continue; }
          let d = sqrt(d2);
          let dir = diff / d;
          let dotFwd = dot(dir, fwd);

          if (d < sepR && (dotFwd >= cosHalfVision || d < sepR * 0.5)) {
            sepSum = sepSum - dir * ((sepR - d) / (sepR * max(d, 0.05)));
            sepCount = sepCount + 1u;
          }
          if (dotFwd >= cosHalfVision) {
            aliSum = aliSum + other.vel.xyz;
            cohSum = cohSum + other.pos.xyz;
            neighCount = neighCount + 1u;
            if (neighCount >= maxN) {
              done = true;
              break;
            }
          }
        }
      }
    }
  }

  let minSpeed = sim.speeds.x;
  let maxSpeed = sim.speeds.y;
  let maxForce = sim.speeds.z;
  let maxTurn = sim.speeds.w;


  var sf = vec3f(0.0);
  if (sepCount > 0u && sim.weights.x > 0.0) {
    let sl = length(sepSum);
    if (sl > 1e-5) { sf = (sepSum * (maxSpeed / sl) - myVel) * sim.weights.x; }
  }
  var af = vec3f(0.0);
  var cf = vec3f(0.0);
  if (neighCount > 0u) {
    if (sim.weights.y > 0.0) {
      let al = length(aliSum);
      if (al > 1e-5) { af = (aliSum * (maxSpeed / al) - myVel) * sim.weights.y; }
    }
    if (sim.weights.z > 0.0) {
      let toCenter = cohSum / f32(neighCount) - myPos;
      let cl = length(toCenter);
      if (cl > 1e-5) { cf = (toCenter * (maxSpeed / cl) - myVel) * sim.weights.z; }
    }
  }

  var attF = vec3f(0.0);
  for (var a = 0u; a < sim.entities.x; a = a + 1u) {
    let ap = sim.attractors[2u * a];
    let ar = sim.attractors[2u * a + 1u].x;
    if (ap.w <= 0.0) { continue; }
    let toA = ap.xyz - myPos;
    let d = length(toA);
    if (d > 1e-4 && (ar <= 0.0 || d < ar)) {
      let falloff = select(1.0, 1.0 - d / ar, ar > 0.0);
      attF = attF + (toA * (maxSpeed / d) - myVel) * (ap.w * falloff);
    }
  }


  var predF = vec3f(0.0);
  var fleeing = false;
  for (var q = 0u; q < sim.entities.y; q = q + 1u) {
    let pp = sim.predators[2u * q];
    let ps = sim.predators[2u * q + 1u].x;
    if (ps <= 0.0) { continue; }
    let away = myPos - pp.xyz;
    let d = length(away);
    if (d < pp.w && d > 1e-5) {
      let u = 1.0 - d / pp.w;
      predF = predF + away * ((ps * (1.0 + 2.0 * u * u)) / d);
      fleeing = true;
    }
  }

  var obsF = vec3f(0.0);
  var dodging = false;
  let margin = max(sim.limits.y, 0.001);
  let obsMargin = max(margin * 0.6, sepR);
  for (var o = 0u; o < sim.entities.z; o = o + 1u) {
    let op = sim.obstacles[2u * o];
    let os = sim.obstacles[2u * o + 1u].x;
    let avoidR = op.w + obsMargin;
    let away = myPos - op.xyz;
    let d = length(away);
    if (d < avoidR && d > 1e-5) {
      let t = 1.0 - d / avoidR;
      obsF = obsF + away * ((os * t * t * maxForce) / d);
      dodging = true;
    }
  }


  var bndF = vec3f(0.0);
  let bndScale = sim.weights.w * maxForce;
  let bCenter = sim.boundsCenter.xyz;
  let bHalf = sim.boundsHalf.xyz;
  let bRad = sim.boundsHalf.w;
  let rel = myPos - bCenter;
  if (sim.boundsCenter.w > 0.5) {
    let d = length(rel);
    let inner = max(0.0, bRad - margin);
    if (d > inner && d > 1e-5) {
      let t = min(2.0, (d - inner) / margin);
      bndF = -rel * ((t * t * bndScale) / d);
    }
  } else {
    let inner = max(vec3f(0.0), bHalf - vec3f(margin));
    for (var k = 0; k < 3; k = k + 1) {
      if (rel[k] > inner[k]) {
        let t = min(2.0, (rel[k] - inner[k]) / margin);
        bndF[k] = -(t * t) * bndScale;
      } else if (rel[k] < -inner[k]) {
        let t = min(2.0, (-inner[k] - rel[k]) / margin);
        bndF[k] = t * t * bndScale;
      }
    }
  }


  var acc = sf + af + cf + attF + bndF;
  let baseLen = length(acc);
  if (baseLen > maxForce) { acc = acc * (maxForce / baseLen); }
  acc = acc + predF + obsF;
  let totalCap = select(maxForce, maxForce * 2.5, fleeing || dodging);
  let totalLen = length(acc);
  if (totalLen > totalCap) { acc = acc * (totalCap / totalLen); }


  let aPar = dot(acc, fwd);
  var lat = acc - fwd * aPar;
  let latLen = length(lat);
  let turnCap = select(maxTurn, maxTurn * 2.0, fleeing || dodging);
  if (latLen > turnCap) { lat = lat * (turnCap / latLen); }
  acc = fwd * aPar + lat;


  var nv = myVel + acc * h;
  var nSpd = length(nv);
  let hiSpd = select(maxSpeed, maxSpeed * 1.35, fleeing);
  if (nSpd < 1e-5) {
    nv = fwd * minSpeed;
    nSpd = minSpeed;
  } else if (nSpd < minSpeed || nSpd > hiSpd) {
    let goal = select(hiSpd, minSpeed, nSpd < minSpeed);
    nv = nv * (goal / nSpd);
    nSpd = goal;
  }
  var np = myPos + nv * h;


  let boidRad = sim.limits.z * 0.35;
  for (var o = 0u; o < sim.entities.z; o = o + 1u) {
    let op = sim.obstacles[2u * o];
    let diff = np - op.xyz;
    let d = length(diff);
    let minD = op.w + boidRad;
    if (d < minD) {
      let nrm = select(vec3f(0.0, 1.0, 0.0), diff / max(d, 1e-5), d > 1e-5);
      np = op.xyz + nrm * minD;
      let vn = dot(nv, nrm);
      if (vn < 0.0) { nv = nv - nrm * (1.5 * vn); }
    }
  }


  if (sim.boundsCenter.w > 0.5) {
    let r = np - bCenter;
    let d = length(r);
    if (d > bRad) {
      let nrm = r / d;
      np = bCenter + nrm * bRad;
      let vn = dot(nv, nrm);
      if (vn > 0.0) { nv = nv - nrm * (1.5 * vn); }
    }
  } else {
    let hi = bCenter + bHalf;
    let lo = bCenter - bHalf;
    for (var k = 0; k < 3; k = k + 1) {
      if (np[k] > hi[k]) {
        np[k] = hi[k];
        if (nv[k] > 0.0) { nv[k] = -nv[k] * 0.6; }
      } else if (np[k] < lo[k]) {
        np[k] = lo[k];
        if (nv[k] < 0.0) { nv[k] = -nv[k] * 0.6; }
      }
    }
  }


  let newFwd = nv / max(length(nv), 1e-5);
  var right2 = vec2f(newFwd.z, -newFwd.x);
  let rLen = length(right2);
  right2 = select(vec2f(1.0, 0.0), right2 / rLen, rLen > 1e-4);
  let latDotRight = lat.x * right2.x + lat.z * right2.y;
  let targetBank = clamp(-latDotRight * sim.anim.x * sim.anim.z * 0.12, -1.1, 1.1);
  let newBank = me.vel.w + (targetBank - me.vel.w) * min(1.0, h * 6.0);
  let sRatio = clamp((nSpd - minSpeed) / max(maxSpeed - minSpeed, 1e-3), 0.0, 1.0);
  let twoPi = 6.283185307;
  let rawPhase = me.pos.w + h * sim.anim.y * (0.75 + 0.55 * sRatio) * twoPi;
  let newPhase = rawPhase - floor(rawPhase / twoPi) * twoPi;

  boidsOut[i] = Boid(vec4f(np, newPhase), vec4f(nv, newBank));


  if (sim.debug.x != 0u && i == sim.debug.y) {
    debugOut[0] = vec4f(np, newBank);
    debugOut[1] = vec4f(nv, f32(neighCount));
    debugOut[2] = vec4f(sf, f32(sepCount));
    debugOut[3] = vec4f(af, 0.0);
    debugOut[4] = vec4f(cf, 0.0);
    debugOut[5] = vec4f(predF, 0.0);
    debugOut[6] = vec4f(vec3f(c), sim.limits.w);
    debugOut[7] = vec4f(0.0, 0.0, 0.0, 1.0);
  }
}
`,Kt=`
struct Boid {
  pos: vec4f,
  vel: vec4f,
}
struct RenderUniform {
  camera: mat4x4f,

  eyeScale: vec4f,

  lightDirAmb: vec4f,

  primaryFlap: vec4f,

  accentMode: vec4f,

  lightColorEncode: vec4f,
}
@group(0) @binding(0) var<uniform> r: RenderUniform;
@group(0) @binding(1) var<storage, read> boids: array<Boid>;

@group(0) @binding(2) var<storage, read> meshCorners: array<vec4f>;
struct Out {
  @builtin(position) clip: vec4f,
  @location(0) normal: vec3f,
  @location(1) color: vec3f,
  @location(2) world: vec3f,
}

fn boidHash(v: u32) -> f32 {
  var x = v * 747796405u + 2891336453u;
  x = ((x >> ((x >> 28u) + 4u)) ^ x) * 277803737u;
  x = (x >> 22u) ^ x;
  return f32(x & 0xffffu) / 65535.0;
}
fn encodeSrgb(c: vec3f) -> vec3f {
  let k = max(c, vec3f(0.0));
  return select(1.055 * pow(k, vec3f(1.0 / 2.4)) - 0.055, k * 12.92, k <= vec3f(0.0031308));
}
@vertex
fn vertex(@builtin(vertex_index) corner: u32, @builtin(instance_index) instance: u32) -> Out {
  let b = boids[instance];
  let cPos = meshCorners[corner * 2u];
  let cNrm = meshCorners[corner * 2u + 1u];
  var lp = cPos.xyz;
  var ln = cNrm.xyz;
  let w = cPos.w;
  let phase = b.pos.w;
  let amp = r.primaryFlap.w;
  if (r.accentMode.w < 0.5) {

    let flap = sin(phase) * amp * w;
    lp.y = lp.y + flap * abs(lp.x);
    let tilt = flap * select(-1.0, 1.0, lp.x >= 0.0) * 0.45;
    ln = normalize(vec3f(ln.x - tilt, ln.y + 0.1, ln.z));
  } else {

    let wave = sin(phase + lp.z * 3.5) * amp * w;
    lp.x = lp.x + wave * 0.55;
    let twist = cos(phase + lp.z * 3.5) * amp * w * 0.35;
    ln = normalize(vec3f(ln.x, ln.y, ln.z - twist));
  }

  let spd = length(b.vel.xyz);
  let fwd = select(vec3f(0.0, 0.0, 1.0), b.vel.xyz / max(spd, 1e-5), spd > 1e-5);
  let upHint = select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(fwd.y) > 0.96);
  let right0 = normalize(cross(upHint, fwd));
  let up0 = cross(fwd, right0);
  let cb = cos(b.vel.w);
  let sb = sin(b.vel.w);
  let right = right0 * cb + up0 * sb;
  let up = -right0 * sb + up0 * cb;
  let world = b.pos.xyz + (right * lp.x + up * lp.y + fwd * lp.z) * r.eyeScale.w;
  var o: Out;
  o.clip = r.camera * vec4f(world, 1.0);
  o.normal = normalize(right * ln.x + up * ln.y + fwd * ln.z);
  o.color = mix(r.primaryFlap.rgb, r.accentMode.rgb, clamp(cNrm.w * 0.72 + boidHash(instance) * 0.28, 0.0, 1.0));
  o.world = world;
  return o;
}
@fragment
fn fragment(i: Out) -> @location(0) vec4f {

  let n = normalize(i.normal);
  let v = normalize(r.eyeScale.xyz - i.world);
  let ndl = max(dot(n, r.lightDirAmb.xyz), 0.0);
  let hemi = 0.5 + 0.5 * n.y;
  let amb = r.lightDirAmb.w;
  let rim = pow(1.0 - max(dot(n, v), 0.0), 2.5) * 0.22;
  let lit = amb * (0.65 + 0.35 * hemi) + (1.0 - amb) * ndl;
  let rgb = i.color * r.lightColorEncode.rgb * lit + r.accentMode.rgb * rim;
  return vec4f(select(rgb, encodeSrgb(rgb), r.lightColorEncode.w > 0.5), 1.0);
}
`,qt=`
struct DebugUniform {
  camera: mat4x4f,

  boundsCenterShape: vec4f,

  boundsHalfRad: vec4f,

  radiiVision: vec4f,

  flags: vec4f,

  velocity: vec4f,
}
@group(0) @binding(0) var<uniform> d: DebugUniform;
struct Out {
  @builtin(position) clip: vec4f,
  @location(0) color: vec3f,
}
fn encodeSrgb(c: vec3f) -> vec3f {
  let k = max(c, vec3f(0.0));
  return select(1.055 * pow(k, vec3f(1.0 / 2.4)) - 0.055, k * 12.92, k <= vec3f(0.0031308));
}
@fragment
fn fragment(i: Out) -> @location(0) vec4f {
  return vec4f(select(i.color, encodeSrgb(i.color), d.flags.w > 0.5), 1.0);
}
`,Jt=qt+`
struct Boid {
  pos: vec4f,
  vel: vec4f,
}
@group(0) @binding(1) var<storage, read> boids: array<Boid>;
@vertex
fn vertex(@builtin(vertex_index) vid: u32, @builtin(instance_index) instance: u32) -> Out {
  let b = boids[instance];
  let tip = b.pos.xyz + b.vel.xyz * d.velocity.x;
  let t = clamp(length(b.vel.xyz) / max(d.velocity.y, 1e-5), 0.0, 1.0);
  var o: Out;
  o.clip = d.camera * vec4f(select(b.pos.xyz, tip, vid == 1u), 1.0);
  o.color = mix(vec3f(0.2, 0.55, 1.0), vec3f(1.0, 0.25, 0.2), t);
  return o;
}
`,Yt=qt+`

@group(0) @binding(1) var<storage, read> debugBuf: array<vec4f, 8>;

fn boxEdgeVertex(edgeIdx: u32, endBit: u32, center: vec3f, size: vec3f) -> vec3f {
  var a = vec3f(0.0);
  var b = vec3f(0.0);
  switch (edgeIdx) {
    case 0u: { a = vec3f(-1.0, -1.0, -1.0); b = vec3f(1.0, -1.0, -1.0); }
    case 1u: { a = vec3f(1.0, -1.0, -1.0); b = vec3f(1.0, -1.0, 1.0); }
    case 2u: { a = vec3f(1.0, -1.0, 1.0); b = vec3f(-1.0, -1.0, 1.0); }
    case 3u: { a = vec3f(-1.0, -1.0, 1.0); b = vec3f(-1.0, -1.0, -1.0); }
    case 4u: { a = vec3f(-1.0, 1.0, -1.0); b = vec3f(1.0, 1.0, -1.0); }
    case 5u: { a = vec3f(1.0, 1.0, -1.0); b = vec3f(1.0, 1.0, 1.0); }
    case 6u: { a = vec3f(1.0, 1.0, 1.0); b = vec3f(-1.0, 1.0, 1.0); }
    case 7u: { a = vec3f(-1.0, 1.0, 1.0); b = vec3f(-1.0, 1.0, -1.0); }
    case 8u: { a = vec3f(-1.0, -1.0, -1.0); b = vec3f(-1.0, 1.0, -1.0); }
    case 9u: { a = vec3f(1.0, -1.0, -1.0); b = vec3f(1.0, 1.0, -1.0); }
    case 10u: { a = vec3f(1.0, -1.0, 1.0); b = vec3f(1.0, 1.0, 1.0); }
    default: { a = vec3f(-1.0, -1.0, 1.0); b = vec3f(-1.0, 1.0, 1.0); }
  }
  return center + select(a, b, endBit == 1u) * size;
}
@vertex
fn vertex(@builtin(vertex_index) vid: u32) -> Out {
  let seg = vid >> 1u;
  let endBit = vid & 1u;
  var o: Out;

  o.clip = vec4f(2.0, 2.0, 2.0, 1.0);
  o.color = vec3f(1.0);
  let showGrid = d.flags.x > 0.5;
  let showPerc = d.flags.y > 0.5;
  let showVecs = d.flags.z > 0.5;
  let twoPi = 6.283185307;
  let bPos = debugBuf[0].xyz;
  let bVel = debugBuf[1].xyz;
  let hasBoid = debugBuf[7].w > 0.5;
  let spd = length(bVel);
  let fwd = select(vec3f(0.0, 0.0, 1.0), bVel / max(spd, 1e-5), spd > 1e-5);
  let upHint = select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(fwd.y) > 0.96);
  let right = normalize(cross(upHint, fwd));
  let up = cross(fwd, right);
  var world = vec3f(0.0);
  var col = vec3f(0.35, 0.75, 1.0);
  var shown = false;

  if (seg < 12u) {

    if (showGrid && d.boundsCenterShape.w < 0.5) {
      world = boxEdgeVertex(seg, endBit, d.boundsCenterShape.xyz, d.boundsHalfRad.xyz);
      col = vec3f(0.35, 0.78, 1.0);
      shown = true;
    }
  } else if (seg < 108u) {

    if (showGrid && d.boundsCenterShape.w > 0.5) {
      let local = seg - 12u;
      let ring = local / 32u;
      let ang = f32(local % 32u + endBit) * (twoPi / 32.0);
      var dir = vec3f(cos(ang), 0.0, sin(ang));
      if (ring == 1u) { dir = vec3f(cos(ang), sin(ang), 0.0); }
      else if (ring == 2u) { dir = vec3f(0.0, cos(ang), sin(ang)); }
      world = d.boundsCenterShape.xyz + dir * d.boundsHalfRad.w;
      col = vec3f(0.35, 0.78, 1.0);
      shown = true;
    }
  } else if (seg < 132u) {

    if (showGrid && hasBoid) {
      let cell = debugBuf[6];
      let cellCenter = (cell.xyz + vec3f(0.5)) * cell.w;
      let inner = seg < 120u;
      world = boxEdgeVertex(select(seg - 120u, seg - 108u, inner), endBit, cellCenter, vec3f(cell.w * select(1.5, 0.5, inner)));
      col = select(vec3f(0.95, 0.62, 0.18), vec3f(1.0, 0.92, 0.25), inner);
      shown = true;
    }
  } else if (seg < 180u) {

    if (showPerc && hasBoid) {
      let local = seg - 132u;
      let ang = f32(local % 24u + endBit) * (twoPi / 24.0);
      let axisA = select(right, up, local / 24u == 1u);
      world = bPos + (fwd * cos(ang) + axisA * sin(ang)) * d.radiiVision.y;
      col = vec3f(1.0, 0.32, 0.35);
      shown = true;
    }
  } else if (seg < 228u) {

    if (showPerc && hasBoid) {
      let local = seg - 180u;
      let halfAng = d.radiiVision.z;
      let t0 = -halfAng + f32(local % 24u + endBit) * (2.0 * halfAng / 24.0);
      let axisA = select(right, up, local / 24u == 1u);
      world = bPos + (fwd * cos(t0) + axisA * sin(t0)) * d.radiiVision.x;
      col = vec3f(0.22, 0.92, 0.85);
      shown = true;
    }
  } else if (seg < 252u) {

    if (showPerc && hasBoid) {
      let halfAng = d.radiiVision.z;
      let phi = f32(seg - 228u + endBit) * (twoPi / 24.0);
      world = bPos + fwd * (cos(halfAng) * d.radiiVision.x) + (right * cos(phi) + up * sin(phi)) * (sin(halfAng) * d.radiiVision.x);
      col = vec3f(0.22, 0.92, 0.85);
      shown = true;
    }
  } else if (seg < 256u) {

    if (showPerc && hasBoid && d.radiiVision.z < 3.09) {
      let halfAng = d.radiiVision.z;
      let phi = f32(seg - 252u) * 1.5707963;
      let tip = bPos + fwd * (cos(halfAng) * d.radiiVision.x) + (right * cos(phi) + up * sin(phi)) * (sin(halfAng) * d.radiiVision.x);
      world = select(bPos, tip, endBit == 1u);
      col = vec3f(0.22, 0.92, 0.85);
      shown = true;
    }
  } else if (seg < 259u) {

    if ((showVecs || showPerc) && hasBoid) {
      let span = max(d.radiiVision.y * 0.3, 0.35);
      var axis = vec3f(span, 0.0, 0.0);
      if (seg == 257u) { axis = vec3f(0.0, span, 0.0); }
      else if (seg == 258u) { axis = vec3f(0.0, 0.0, span); }
      world = select(bPos - axis, bPos + axis, endBit == 1u);
      col = vec3f(1.0);
      shown = true;
    }
  } else if (seg < 274u) {


    if (showVecs && hasBoid) {
      let local = seg - 259u;
      let vecIdx = local / 3u;
      let part = local % 3u;
      var vecVal = debugBuf[2u + min(vecIdx, 4u) - 1u].xyz * 0.18;
      col = vec3f(1.0, 0.55, 0.15);
      if (vecIdx == 0u) { vecVal = bVel * 0.25; col = vec3f(1.0); }
      else if (vecIdx == 1u) { col = vec3f(1.0, 0.28, 0.35); }
      else if (vecIdx == 2u) { col = vec3f(0.22, 0.88, 1.0); }
      else if (vecIdx == 3u) { col = vec3f(0.28, 0.95, 0.45); }
      let vLen = length(vecVal);
      if (vLen > 0.02) {
        let len = min(vLen, max(d.radiiVision.x * 1.4, 3.0));
        let vDir = vecVal / vLen;
        let tip = bPos + vDir * len;
        let sideHint = select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(vDir.y) > 0.92);
        let side = normalize(cross(sideHint, vDir));
        let headLen = min(len * 0.25, 0.4);
        if (part == 0u) {
          world = select(bPos, tip, endBit == 1u);
        } else {
          let s = select(-1.0, 1.0, part == 1u);
          world = select(tip, tip - vDir * headLen + side * (headLen * 0.5 * s), endBit == 1u);
        }
        shown = true;
      }
    }
  }
  if (shown) {
    o.clip = d.camera * vec4f(world, 1.0);
    o.color = col;
  }
  return o;
}
`,Xt=262144,Zt=16384,Qt=.05,B=Object.freeze({count:4096,seed:1337,preset:`bird`,boundsMargin:3,boundsStrength:6,separation:1.8,alignment:1.1,cohesion:1,neighborRadius:2.6,separationRadius:1.1,visionAngle:Math.PI*1.5,maxNeighbors:24,minSpeed:4,maxSpeed:10,maxForce:14,maxTurnAccel:12,scale:.42,bankStrength:.55,flapAmplitude:.45,ambient:.38});function V(e){return new yt(`unsupported`,`${e} See https://margoengine.com/errors#flocking`)}function $t(e){return e>32768?65536:e>12288?32768:16384}function en(e,t,n,r){let i=Math.imul(e|0,73856093),a=Math.imul(t|0,19349663),o=Math.imul(n|0,83492791);return(i^a^o)>>>0&r}var H=(e,t,n,r,i=1/0)=>{let a=e===void 0?t:e;if(typeof a!=`number`||!Number.isFinite(a)||a<r||a>i)throw V(`Flock ${n} is ${String(a)}; pass a finite number from ${r} to ${i}.`);return a},tn=(e,t,n,r,i)=>{let a=e===void 0?t:e;if(typeof a!=`number`||!Number.isInteger(a)||a<r||a>i)throw V(`Flock ${n} is ${String(a)}; pass a whole number from ${r} to ${i}.`);return a},nn=(e,t)=>{let n=e;if(!n||n.length!==3||![0,1,2].every(e=>typeof n[e]==`number`&&Number.isFinite(n[e])))throw V(`Flock ${t} must be three finite numbers [x, y, z].`);return n},rn=(e,t)=>{let n=new Float32Array(3);try{Nt(e,n,0)}catch(e){throw V(`Flock ${t} is not a colour (${e.message}); pass a hex string or linear [r, g, b].`)}return[n[0],n[1],n[2]]},an=(e,t,n)=>{let r=e??[];if(!Array.isArray(r)||r.length>t)throw V(`Flock ${n} must be an array of at most ${t} items; pass fewer.`);return r.forEach((e,t)=>{if(!e||typeof e!=`object`)throw V(`Flock ${n}[${t}] must be an object with a position.`)}),r};function U(e={},t){if(typeof e!=`object`||!e)throw V(`GPUFlock options must be an object; pass {} or a GPUFlockOptions literal.`);let n=t??tn(e.count,B.count,`count`,1,262144),r=tn(e.seed,B.seed,`seed`,-2147483648,2147483647),i=e.preset??B.preset;if(i!==`bird`&&i!==`fish`)throw V(`Flock preset is ${String(i)}; pass 'bird' or 'fish'.`);let a=e.bounds??{shape:`box`,halfSize:[18,10,18]};if(!a||typeof a!=`object`||a.shape!==`box`&&a.shape!==`sphere`)throw V(`Flock bounds must have shape 'box' or 'sphere'; pass { shape: 'box', halfSize: [18, 10, 18] }.`);let o=nn(a.center??[0,0,0],`bounds.center`),s,c;if(a.shape===`box`){let e=nn(a.halfSize,`bounds.halfSize`);if(!(e[0]>0&&e[1]>0&&e[2]>0))throw V(`Flock bounds.halfSize components must be above 0; pass positive half-extents.`);s=[e[0],e[1],e[2]],c=Math.hypot(e[0],e[1],e[2])}else c=H(a.radius,18,`bounds.radius`,.001),s=[c,c,c];let l=H(e.neighborRadius,B.neighborRadius,`neighborRadius`,.01),u=H(e.separationRadius,B.separationRadius,`separationRadius`,.005),d=H(e.visionAngle,B.visionAngle,`visionAngle`,.05,Math.PI*2),f=tn(e.maxNeighbors,B.maxNeighbors,`maxNeighbors`,1,128),p=H(e.minSpeed,B.minSpeed,`minSpeed`,.01),m=H(e.maxSpeed,B.maxSpeed,`maxSpeed`,p),h=H(e.maxForce,B.maxForce,`maxForce`,.01),g=H(e.maxTurnAccel,B.maxTurnAccel,`maxTurnAccel`,.01),_=an(e.attractors,16,`attractors`);_.forEach((e,t)=>{nn(e.position,`attractors[${t}].position`),H(e.strength,2.5,`attractors[${t}].strength`,0),H(e.radius,0,`attractors[${t}].radius`,0)});let v=an(e.predators,16,`predators`);v.forEach((e,t)=>{nn(e.position,`predators[${t}].position`),H(e.radius,6,`predators[${t}].radius`,.01),H(e.strength,12,`predators[${t}].strength`,0)});let y=an(e.obstacles,32,`obstacles`);y.forEach((e,t)=>{nn(e.position,`obstacles[${t}].position`),H(e.radius,NaN,`obstacles[${t}].radius`,.01),H(e.strength,8,`obstacles[${t}].strength`,0)});let b=nn(e.lightDirection??[.45,1,.35],`lightDirection`),x=Math.hypot(b[0],b[1],b[2]);if(!(x>1e-6))throw V(`Flock lightDirection must not be zero; pass e.g. [0.45, 1, 0.35].`);let S=e.debug??{};if(typeof S!=`object`||!S)throw V(`Flock debug must be an object; pass { enabled, velocities?, grid?, perception?, vectors? }.`);let C=tn(S.selectedIndex,0,`debug.selectedIndex`,0,Math.max(0,n-1));return{count:n,seed:r,preset:i,boundsShape:+(a.shape===`sphere`),boundsCenter:[o[0],o[1],o[2]],boundsHalf:s,boundsRadius:c,boundsMargin:H(e.boundsMargin,B.boundsMargin,`boundsMargin`,0),boundsStrength:H(e.boundsStrength,B.boundsStrength,`boundsStrength`,0),separation:H(e.separation,B.separation,`separation`,0),alignment:H(e.alignment,B.alignment,`alignment`,0),cohesion:H(e.cohesion,B.cohesion,`cohesion`,0),neighborRadius:l,separationRadius:u,visionAngle:d,cosHalfVision:Math.cos(d*.5),maxNeighbors:f,minSpeed:p,maxSpeed:m,maxForce:h,maxTurnAccel:g,scale:H(e.scale,B.scale,`scale`,.001),bankStrength:H(e.bankStrength,B.bankStrength,`bankStrength`,0),flapFrequency:H(e.flapFrequency,i===`bird`?5.5:7,`flapFrequency`,0),flapAmplitude:H(e.flapAmplitude,B.flapAmplitude,`flapAmplitude`,0),color:rn(e.color??(i===`bird`?`#e8eef8`:`#38c6e8`),`color`),accentColor:rn(e.accentColor??(i===`bird`?`#4c7cc2`:`#f0a83c`),`accentColor`),lightDirection:[b[0]/x,b[1]/x,b[2]/x],lightColor:rn(e.lightColor??[1,1,1],`lightColor`),ambient:H(e.ambient,B.ambient,`ambient`,0,1),paused:!!(e.paused??!1),attractors:_,predators:v,obstacles:y,debug:{enabled:!!(S.enabled??!1),velocities:!!(S.velocities??!0),grid:!!(S.grid??!0),perception:!!(S.perception??!0),vectors:!!(S.vectors??!0),selectedIndex:C}}}function on(){let e=new Float32Array([0,.04,.95,0,.16,.25,0,-.1,.2,0,.02,-.55,-.42,.08,.12,-1,.02,-.18,.42,.08,.12,1,.02,-.18,-.28,.07,-.92,.28,.07,-.92,-.16,.01,-.25,.16,.01,-.25]),t=new Float32Array([0,0,0,0,.45,1,.45,1,.18,.18,.15,.15]);return{positions:e,indices:new Uint32Array([0,4,1,0,1,6,0,2,4,0,6,2,1,10,3,1,3,11,2,3,10,2,11,3,1,4,10,4,5,10,2,10,4,4,10,5,1,11,6,6,11,7,2,6,11,6,7,11,3,8,9,3,9,8]),weights:t}}function sn(){let e=new Float32Array([0,0,.92,0,.24,.25,0,-.2,.22,-.22,.02,.22,.22,.02,.22,0,.12,-.35,0,-.1,-.35,0,.36,-.12,0,.32,-.95,0,-.28,-.95,0,.02,-.68,-.46,-.08,.02,.46,-.08,.02]),t=new Float32Array([0,.12,.12,.12,.12,.55,.55,.38,1,1,.8,.22,.22]);return{positions:e,indices:new Uint32Array([0,3,1,0,1,4,0,2,3,0,4,2,1,3,5,1,5,4,2,5,3,2,4,5,3,6,5,4,5,6,2,6,3,2,4,6,1,7,5,1,5,7,5,8,10,5,10,8,6,10,9,6,9,10,5,10,6,5,6,10,3,11,2,3,2,11,4,2,12,4,12,2]),weights:t}}var cn=(e,t)=>{for(let n=0;n<e.length;n++)if(typeof e[n]!=`number`||!Number.isFinite(e[n]))throw V(`Flock geometry ${t}[${n}] is not finite; pass finite numbers.`)};function ln(e){let t=e.vertices;if(!t||typeof t.length!=`number`||t.length%6!=0)throw V(`Flock geometry vertices must hold six floats a vertex (x, y, z, nx, ny, nz).`);let n=t.length/6,r=new Float32Array(n*3),i=new Float32Array(n*3);for(let e=0;e<n;e++)for(let n=0;n<3;n++)r[e*3+n]=t[e*6+n],i[e*3+n]=t[e*6+3+n];return{positions:r,normals:i,indices:e.indices}}function un(e,t){if(!e||typeof e!=`object`)throw V(`Flock geometry must be an object; pass { positions, indices? } or a glTF mesh geometry.`);let n=`vertices`in e?ln(e):e,r=n.positions;if(!r||typeof r.length!=`number`||r.length<9||r.length%3!=0)throw V(`Flock geometry positions must be xyz triples with at least one triangle.`);cn(r,`positions`);let i=r.length/3,a=n.indices,o=a?a.length:i;if(o<3||o%3!=0||o/3>16384)throw V(`Flock geometry must have 1 to ${Zt} whole triangles.`);if(a)for(let e=0;e<a.length;e++){let t=a[e];if(!Number.isInteger(t)||t<0||t>=i)throw V(`Flock geometry indices[${e}] is ${String(t)}; pass integers from 0 to ${i-1}.`)}let s=n.normals;if(s!==void 0){if(typeof s.length!=`number`||s.length!==r.length)throw V(`Flock geometry normals must match the positions in length.`);cn(s,`normals`)}let c=n.weights;if(c!==void 0){if(typeof c.length!=`number`||c.length!==i)throw V(`Flock geometry weights must hold one number a vertex.`);for(let e=0;e<c.length;e++)if(typeof c[e]!=`number`||!(c[e]>=0&&c[e]<=1))throw V(`Flock geometry weights[${e}] must be from 0 to 1.`)}let l=0;for(let e=0;e<i;e++)l=Math.max(l,Math.hypot(r[e*3],r[e*3+1],r[e*3+2]));if(!(l>1e-6))throw V(`Flock geometry positions all sit at the origin; pass a mesh with a size.`);let u=new Float32Array(o*8),d=[0,0,0];for(let e=0;e<o;e+=3){d[0]=a?a[e]:e,d[1]=a?a[e+1]:e+1,d[2]=a?a[e+2]:e+2;let[n,i,o]=d,f=r[i*3]-r[n*3],p=r[i*3+1]-r[n*3+1],m=r[i*3+2]-r[n*3+2],h=r[o*3]-r[n*3],g=r[o*3+1]-r[n*3+1],_=r[o*3+2]-r[n*3+2],v=p*_-m*g,y=m*h-f*_,b=f*g-p*h,x=Math.hypot(v,y,b)||1;v/=x,y/=x,b/=x;for(let n=0;n<3;n++){let i=d[n],a=r[i*3]/l,o=r[i*3+1]/l,f=r[i*3+2]/l,p=v,m=y,h=b;if(s){let e=Math.hypot(s[i*3],s[i*3+1],s[i*3+2])||1;p=s[i*3]/e,m=s[i*3+1]/e,h=s[i*3+2]/e}let g=c?c[i]:t===`bird`?Math.min(1,Math.abs(a)):Math.min(1,Math.max(0,(.5-f)*.7)),_=t===`bird`?Math.min(1,Math.abs(a)*.9+Math.max(0,-f)*.25):Math.min(1,Math.max(0,o*1.4+.35)),x=(e+n)*8;u[x]=a,u[x+1]=o,u[x+2]=f,u[x+3]=g,u[x+4]=p,u[x+5]=m,u[x+6]=h,u[x+7]=_}}return{corners:u,vertexCount:o}}function dn(e={}){let t=U(e),n=It(t.seed),r=new Float32Array(t.count*8),i=$t(t.count),a=.72,o=(t.minSpeed+t.maxSpeed)*.5;for(let e=0;e<t.count;e++){let i,s,c;if(t.boundsShape===1){let e=n(),r=n()*2-1,o=Math.sqrt(Math.max(0,1-r*r)),l=n()*Math.PI*2,u=t.boundsRadius*a*Math.cbrt(e);i=t.boundsCenter[0]+u*o*Math.cos(l),s=t.boundsCenter[1]+u*r,c=t.boundsCenter[2]+u*o*Math.sin(l)}else i=t.boundsCenter[0]+(n()*2-1)*t.boundsHalf[0]*a,s=t.boundsCenter[1]+(n()*2-1)*t.boundsHalf[1]*a,c=t.boundsCenter[2]+(n()*2-1)*t.boundsHalf[2]*a;let l=(n()*2-1)*.4,u=Math.sqrt(Math.max(0,1-l*l)),d=n()*Math.PI*2,f=o*(.85+n()*.3),p=e*8;r[p]=i,r[p+1]=s,r[p+2]=c,r[p+3]=n()*Math.PI*2,r[p+4]=Math.cos(d)*u*f,r[p+5]=l*f,r[p+6]=Math.sin(d)*u*f,r[p+7]=0}return{count:t.count,boids:r,debugData:new Float32Array(32),scratch:{next:new Float32Array(t.count*8),cellCounts:new Uint32Array(i),cellOffsets:new Uint32Array(i),cellCursor:new Uint32Array(i),boidCell:new Uint32Array(t.count),sortedIdx:new Uint32Array(t.count),seen:new Uint32Array(27),gridCells:i}}}function fn(e){if(typeof e!=`number`||!Number.isFinite(e)||e<0||e>1)throw V(`Flock step dt is ${String(e)}; pass seconds from 0 to 1, and call step again for more.`);return e===0?0:Math.ceil(e/Qt-1e-9)}function pn(e,t,n){let r=fn(n);if(!r)return 0;let i=U(t,e.count);for(let t=0;t<r;t++)mn(e,i,n/r);return r}function mn(e,t,n){let{count:r,boids:i,debugData:a,scratch:o}=e,{next:s,cellCounts:c,cellOffsets:l,cellCursor:u,boidCell:d,sortedIdx:f,seen:p,gridCells:m}=o,h=m-1,g=Math.max(t.neighborRadius,t.separationRadius,.25),_=Math.fround(1/g),v=e=>Math.floor(Math.fround(Math.fround(e)*_)),y=t.neighborRadius*t.neighborRadius,b=t.separationRadius,x=t.maxNeighbors*2;c.fill(0);for(let e=0;e<r;e++){let t=e*8,n=en(v(i[t]),v(i[t+1]),v(i[t+2]),h);d[e]=n,c[n]++}let S=0;for(let e=0;e<m;e++)l[e]=S,u[e]=S,S+=c[e];for(let e=0;e<r;e++)f[u[d[e]]++]=e;let[C,w,T]=t.boundsCenter,[ee,te,E]=t.boundsHalf,ne=Math.max(t.boundsMargin,.001),re=Math.PI*2,ie=t.preset===`fish`?.25:1;for(let e=0;e<r;e++){let r=e*8,o=i[r],u=i[r+1],d=i[r+2],m=i[r+3],_=i[r+4],S=i[r+5],D=i[r+6],ae=i[r+7],oe=Math.hypot(_,S,D),se=oe>1e-5?_/oe:0,ce=oe>1e-5?S/oe:0,le=oe>1e-5?D/oe:1,ue=v(o),de=v(u),fe=v(d),pe=0,me=0,he=0,ge=0,_e=0,ve=0,ye=0,be=0,xe=0,Se=0,Ce=0,we=0;outer:for(let n=-1;n<=1;n++)for(let r=-1;r<=1;r++)for(let a=-1;a<=1;a++){let s=en(ue+a,de+r,fe+n,h),m=!1;for(let e=0;e<we;e++)p[e]===s&&(m=!0);if(m)continue;p[we++]=s;let g=l[s],_=Math.min(c[s],x);for(let n=0;n<_;n++){let r=f[g+n];if(r===e)continue;let a=r*8,s=i[a]-o,c=i[a+1]-u,l=i[a+2]-d,p=s*s+c*c+l*l;if(p<=1e-8||p>y)continue;let m=Math.sqrt(p),h=s/m,_=c/m,v=l/m,x=h*se+_*ce+v*le;if(m<b&&(x>=t.cosHalfVision||m<b*.5)){let e=(b-m)/(b*Math.max(m,.05));pe-=h*e,me-=_*e,he-=v*e,ge++}if(x>=t.cosHalfVision&&(_e+=i[a+4],ve+=i[a+5],ye+=i[a+6],be+=i[a],xe+=i[a+1],Se+=i[a+2],++Ce>=t.maxNeighbors))break outer}}let Te=0,Ee=0,De=0;if(ge>0&&t.separation>0){let e=Math.hypot(pe,me,he);if(e>1e-5){let n=t.maxSpeed/e;Te=(pe*n-_)*t.separation,Ee=(me*n-S)*t.separation,De=(he*n-D)*t.separation}}let Oe=0,ke=0,Ae=0,je=0,Me=0,Ne=0;if(Ce>0){if(t.alignment>0){let e=Math.hypot(_e,ve,ye);if(e>1e-5){let n=t.maxSpeed/e;Oe=(_e*n-_)*t.alignment,ke=(ve*n-S)*t.alignment,Ae=(ye*n-D)*t.alignment}}if(t.cohesion>0){let e=be/Ce-o,n=xe/Ce-u,r=Se/Ce-d,i=Math.hypot(e,n,r);if(i>1e-5){let a=t.maxSpeed/i;je=(e*a-_)*t.cohesion,Me=(n*a-S)*t.cohesion,Ne=(r*a-D)*t.cohesion}}}let Pe=0,Fe=0,Ie=0;for(let e of t.attractors){let n=e.strength??2.5;if(n<=0)continue;let r=e.radius??0,i=e.position[0]-o,a=e.position[1]-u,s=e.position[2]-d,c=Math.hypot(i,a,s);if(c>1e-4&&(r<=0||c<r)){let e=r>0?1-c/r:1,o=t.maxSpeed/c;Pe+=(i*o-_)*n*e,Fe+=(a*o-S)*n*e,Ie+=(s*o-D)*n*e}}let Le=0,Re=0,ze=0,Be=!1;for(let e of t.predators){let t=e.strength??12,n=e.radius??6;if(t<=0)continue;let r=o-e.position[0],i=u-e.position[1],a=d-e.position[2],s=Math.hypot(r,i,a);if(s<n&&s>1e-5){let e=1-s/n,o=t*(1+2*e*e)/s;Le+=r*o,Re+=i*o,ze+=a*o,Be=!0}}let Ve=0,He=0,Ue=0,O=!1,We=Math.max(ne*.6,b);for(let e of t.obstacles){let n=e.strength??8,r=e.radius+We,i=o-e.position[0],a=u-e.position[1],s=d-e.position[2],c=Math.hypot(i,a,s);if(c<r&&c>1e-5){let e=1-c/r,o=n*e*e*t.maxForce/c;Ve+=i*o,He+=a*o,Ue+=s*o,O=!0}}let Ge=0,Ke=0,qe=0,Je=t.boundsStrength*t.maxForce;if(t.boundsShape===1){let e=o-C,n=u-w,r=d-T,i=Math.hypot(e,n,r),a=Math.max(0,t.boundsRadius-ne);if(i>a&&i>1e-5){let t=Math.min(2,(i-a)/ne),o=t*t*Je/i;Ge=-e*o,Ke=-n*o,qe=-r*o}}else{let e=(e,t)=>{let n=Math.max(0,t-ne);return e>n?-(Math.min(2,(e-n)/ne)**2)*Je:e<-n?Math.min(2,(-n-e)/ne)**2*Je:0};Ge=e(o-C,ee),Ke=e(u-w,te),qe=e(d-T,E)}let k=Te+Oe+je+Pe+Ge,A=Ee+ke+Me+Fe+Ke,j=De+Ae+Ne+Ie+qe,Ye=Math.hypot(k,A,j);if(Ye>t.maxForce){let e=t.maxForce/Ye;k*=e,A*=e,j*=e}k+=Le+Ve,A+=Re+He,j+=ze+Ue;let Xe=Be||O?t.maxForce*2.5:t.maxForce,Ze=Math.hypot(k,A,j);if(Ze>Xe){let e=Xe/Ze;k*=e,A*=e,j*=e}let Qe=k*se+A*ce+j*le,$e=k-se*Qe,et=A-ce*Qe,tt=j-le*Qe,nt=Math.hypot($e,et,tt),rt=Be||O?t.maxTurnAccel*2:t.maxTurnAccel;if(nt>rt){let e=rt/nt;$e*=e,et*=e,tt*=e}k=se*Qe+$e,A=ce*Qe+et,j=le*Qe+tt;let M=_+k*n,N=S+A*n,P=D+j*n,F=Math.hypot(M,N,P),it=Be?t.maxSpeed*1.35:t.maxSpeed;if(F<1e-5)M=se*t.minSpeed,N=ce*t.minSpeed,P=le*t.minSpeed,F=t.minSpeed;else if(F<t.minSpeed||F>it){let e=F<t.minSpeed?t.minSpeed:it,n=e/F;M*=n,N*=n,P*=n,F=e}let I=o+M*n,L=u+N*n,R=d+P*n;for(let e of t.obstacles){let n=I-e.position[0],r=L-e.position[1],i=R-e.position[2],a=Math.hypot(n,r,i),o=e.radius+t.scale*.35;if(a<o){let t=a>1e-5?n/a:0,s=a>1e-5?r/a:1,c=a>1e-5?i/a:0;I=e.position[0]+t*o,L=e.position[1]+s*o,R=e.position[2]+c*o;let l=M*t+N*s+P*c;l<0&&(M-=1.5*l*t,N-=1.5*l*s,P-=1.5*l*c)}}if(t.boundsShape===1){let e=I-C,n=L-w,r=R-T,i=Math.hypot(e,n,r);if(i>t.boundsRadius){let a=e/i,o=n/i,s=r/i;I=C+a*t.boundsRadius,L=w+o*t.boundsRadius,R=T+s*t.boundsRadius;let c=M*a+N*o+P*s;c>0&&(M-=1.5*c*a,N-=1.5*c*o,P-=1.5*c*s)}}else I>C+ee?(I=C+ee,M>0&&(M=-M*.6)):I<C-ee&&(I=C-ee,M<0&&(M=-M*.6)),L>w+te?(L=w+te,N>0&&(N=-N*.6)):L<w-te&&(L=w-te,N<0&&(N=-N*.6)),R>T+E?(R=T+E,P>0&&(P=-P*.6)):R<T-E&&(R=T-E,P<0&&(P=-P*.6));let at=1/Math.max(Math.hypot(M,N,P),1e-5),ot=M*at,st=P*at,ct=-ot,lt=Math.hypot(st,ct);lt>1e-4?(st/=lt,ct/=lt):(st=1,ct=0);let ut=$e*st+tt*ct,dt=ae+(Math.max(-1.1,Math.min(1.1,-ut*t.bankStrength*ie*.12))-ae)*Math.min(1,n*6),ft=Math.max(0,Math.min(1,(F-t.minSpeed)/Math.max(t.maxSpeed-t.minSpeed,.001))),pt=m+n*t.flapFrequency*(.75+.55*ft)*re,mt=pt-Math.floor(pt/re)*re;s[r]=I,s[r+1]=L,s[r+2]=R,s[r+3]=mt,s[r+4]=M,s[r+5]=N,s[r+6]=P,s[r+7]=dt,e===t.debug.selectedIndex&&(a.set([I,L,R,dt,M,N,P,Ce,Te,Ee,De,ge],0),a.set([Oe,ke,Ae,0,je,Me,Ne,0,Le,Re,ze,0,ue,de,fe,g,0,0,0,1],12))}i.set(s)}var hn=(e,t)=>un(e??(t===`fish`?sn():on()),t),gn=.25,_n=0,vn=class e{coreRequirement=O(`1.0.0`,import.meta.url);constructor(e={}){this.disposed=!1,this.compat=!1,this.ping=0,this.meshVertexCount=0,this.meshDirty=!0,this.needsInit=!0,this.cpuDirty=!1,this.clocked=!1,this.ticked=!1,this.pendingDelta=0,this.owned=[],this.states=[],this.renderPipelines=new Map,this.debugPipelines=new Map,this.simData=new ArrayBuffer(2208),this.simU32=new Uint32Array(this.simData),this.simF32=new Float32Array(this.simData),this.renderData=new Float32Array(36),this.debugUniformData=new Float32Array(40),this.colorAttachment={view:void 0,loadOp:`load`,storeOp:`store`},this.depthAttachment={view:void 0,depthLoadOp:`load`,depthStoreOp:`store`},this.renderPassDesc={colorAttachments:[this.colorAttachment],depthStencilAttachment:this.depthAttachment},this.debugDepthAttachment={view:void 0,depthReadOnly:!0},this.debugPassDesc={colorAttachments:[this.colorAttachment],depthStencilAttachment:this.debugDepthAttachment};let t=U(e);this.options={...e,count:t.count,debug:{...t.debug}},this.count=t.count,this.gridCells=$t(this.count),this.mesh=hn(this.options.geometry,t.preset),this.name=`vfx:flocking:${++_n}`,this.stats={count:this.count,backend:`webgpu`,drawCalls:0,gridCells:this.gridCells,steps:0,debugEnabled:t.debug.enabled}}static attach(t,n={}){We(t,O(`1.0.0`,import.meta.url));let r=new e(n);return Lt(t).use(r),r}assertAlive(e){if(this.disposed)throw new yt(`disposed`,`GPUFlock.${e} cannot run after dispose(); attach a new GPUFlock; see https://margoengine.com/errors#disposed`)}setDebug(e){if(this.assertAlive(`setDebug`),!e||typeof e!=`object`)throw V(`GPUFlock.setDebug takes an object; pass { enabled, velocities?, grid?, perception?, vectors? }.`);let t={...this.options.debug,...e};this.stats.debugEnabled=U({...this.options,debug:t},this.count).debug.enabled,this.options.debug=t}getDebug(){return{...U(this.options,this.count).debug}}setPreset(e,t){if(this.assertAlive(`setPreset`),e!==`bird`&&e!==`fish`)throw V(`GPUFlock.setPreset takes 'bird' or 'fish', not ${String(e)}.`);let n=hn(t===void 0?this.options.geometry:t,e);this.options.preset=e,t!==void 0&&(this.options.geometry=t),this.mesh=n,this.meshDirty=!0}setAttractors(e){this.assertAlive(`setAttractors`),U({...this.options,attractors:e},this.count),this.options.attractors=e}setPredators(e){this.assertAlive(`setPredators`),U({...this.options,predators:e},this.count),this.options.predators=e}setObstacles(e){this.assertAlive(`setObstacles`),U({...this.options,obstacles:e},this.count),this.options.obstacles=e}reset(e){this.assertAlive(`reset`),U({...this.options,seed:e??this.options.seed},this.count),e!==void 0&&(this.options.seed=e),this.pending=void 0,this.needsInit=!0,this.stats.steps=0}step(e){this.assertAlive(`step`);let t=fn(e),n=this.device;if(!n)throw new yt(`state`,`GPUFlock.step needs the flock attached; call GPUFlock.attach(engine) first.`);if(!t)return;let r=U(this.options,this.count);if(this.ensureResources(n,r),this.compat){this.stats.steps+=pn(this.cpuState,this.options,e),this.cpuDirty=!0;return}let i=n.createCommandEncoder();this.encodeSteps(i,n,r,e,t),n.queue.submit([i.finish()])}async snapshot(){this.assertAlive(`snapshot`);let e=this.device;if(!e)throw new yt(`state`,`GPUFlock.snapshot needs the flock attached; call GPUFlock.attach(engine) first.`);let t=U(this.options,this.count);this.ensureResources(e,t);let n=this.stats.steps;if(this.compat)return{count:this.count,steps:n,boids:this.cpuState.boids.slice()};let r=this.count*8*4,i=e.createBuffer({size:r,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});try{let t=e.createCommandEncoder();return t.copyBufferToBuffer(this.states[this.ping],0,i,0,r),e.queue.submit([t.finish()]),await i.mapAsync(GPUMapMode.READ),{count:this.count,steps:n,boids:new Float32Array(i.getMappedRange().slice(0))}}finally{i.destroy()}}restore(e){if(this.assertAlive(`restore`),!e||e.count!==this.count||!(e.boids instanceof Float32Array)||e.boids.length!==this.count*8||!Number.isSafeInteger(e.steps)||e.steps<0)throw V(`GPUFlock.restore takes a snapshot of a flock of ${this.count} boids, from flock.snapshot().`);for(let t=0;t<e.boids.length;t++)if(!Number.isFinite(e.boids[t]))throw V(`GPUFlock.restore: snapshot value ${t} is not finite.`);this.pending=e.boids.slice(),this.needsInit=!0,this.stats.steps=e.steps}setup(e){bt(e,`GPUFlock`);let t=e.gpu,n=Math.floor(Math.min(t.limits.maxStorageBufferBindingSize,t.limits.maxBufferSize)/32),r=t.limits.maxComputeWorkgroupsPerDimension*256,i=Math.min(Xt,n,r);if(this.count>i)throw new yt(`unsupported`,`GPUFlock count ${this.count} is more than this device holds (${i}); pass a smaller count; see https://margoengine.com/errors#unsupported`);this.engine=e,this.device=t,this.compat=vt(t)===`webgl2`,this.stats.backend=this.compat?`webgl2-compat`:`webgpu`}registerPasses(e){e.add({name:this.name+`:simulate`,order:-8,execute:e=>e.backend===`webgpu`&&this.simulate(e)}),e.add({name:this.name+`:draw`,order:2,execute:e=>e.backend===`webgpu`&&this.draw(e)}),e.add({name:this.name+`:debug`,order:8,execute:e=>e.backend===`webgpu`&&this.drawDebug(e)})}onPreUpdate(e){this.disposed||(this.pendingDelta=e,this.clocked=!0,this.ticked=!0)}buffer(e,t,n){let r=e.createBuffer({size:t,usage:n});return this.owned.push(r),r}ensureResources(e,t){if(!this.renderUniform){let t=this.count,n=this.gridCells,r=t*8*4,i=GPUBufferUsage.STORAGE,a=i|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC;if(this.states=[this.buffer(e,r,a)],this.debugBuf=this.buffer(e,128,i|GPUBufferUsage.COPY_DST),this.renderUniform=this.buffer(e,this.renderData.byteLength,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST),this.debugUniform=this.buffer(e,this.debugUniformData.byteLength,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST),!this.compat){this.states.push(this.buffer(e,r,a));let o=this.simUniform=this.buffer(e,this.simData.byteLength,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST),s=this.buffer(e,(2*n+512)*4,i),c=this.buffer(e,4*t*4,i),l=this.buffer(e,r,i),[u,d]=this.states,f=t=>e.createComputePipeline({layout:`auto`,compute:{module:e.createShaderModule({code:t}),entryPoint:`main`}}),p=(t,n)=>[t,e.createBindGroup({layout:t.getBindGroupLayout(0),entries:n.map((e,t)=>({binding:t,resource:{buffer:e}}))})],m=f(zt),h=f(Wt),g=f(Gt);this.compute={clear:p(f(Rt),[o,s]),count:[p(m,[o,u,s,c]),p(m,[o,d,s,c])],scanBlocks:p(f(Bt),[o,s]),scanSums:p(f(Vt),[o,s]),addOffsets:p(f(Ht),[o,s]),scatter:p(f(Ut),[o,s,c]),rank:[p(h,[o,u,s,c,l]),p(h,[o,d,s,c,l])],step:[p(g,[o,u,l,c,s,d,this.debugBuf]),p(g,[o,d,l,c,s,u,this.debugBuf])]}}this.needsInit=!0,this.meshDirty=!0}if(this.meshDirty){let{corners:t,vertexCount:n}=this.mesh;this.meshBuf&&(this.meshBuf.destroy(),this.owned.splice(this.owned.indexOf(this.meshBuf),1)),this.meshBuf=this.buffer(e,t.byteLength,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST),e.queue.writeBuffer(this.meshBuf,0,t),this.meshVertexCount=n,this.meshDirty=!1,this.renderPipelines.clear()}if(this.needsInit){let n=dn(this.options);this.pending&&n.boids.set(this.pending),this.pending=void 0,e.queue.writeBuffer(this.states[0],0,n.boids),this.cpuState=this.compat?n:void 0,this.cpuDirty=!1;let r=t.debug.selectedIndex*8,i=Math.max(t.neighborRadius,t.separationRadius,.25),a=new Float32Array(32);a.set(n.boids.subarray(r,r+8),0),a[7]=0;for(let e=0;e<3;e++)a[24+e]=Math.floor(a[e]/i);a[27]=i,a[31]=1,e.queue.writeBuffer(this.debugBuf,0,a),this.ping=0,this.needsInit=!1}}writeSimUniforms(e,t,n){let r=this.simU32,i=this.simF32,a=Math.max(t.neighborRadius,t.separationRadius,.25);r.set([t.count,this.gridCells,this.gridCells-1,t.maxNeighbors],0),i.set([...t.boundsCenter,t.boundsShape,...t.boundsHalf,t.boundsRadius],4),i.set([t.neighborRadius,t.separationRadius,t.cosHalfVision,1/a],12),i.set([t.separation,t.alignment,t.cohesion,t.boundsStrength],16),i.set([t.minSpeed,t.maxSpeed,t.maxForce,t.maxTurnAccel],20),i.set([n,t.boundsMargin,t.scale,a],24),i.set([t.bankStrength,t.flapFrequency,t.preset===`fish`?.25:1,0],28),r.set([t.attractors.length,t.predators.length,t.obstacles.length,0],32),r.set([+!!t.debug.enabled,t.debug.selectedIndex,0,0],36),t.attractors.forEach((e,t)=>i.set([...e.position,e.strength??2.5,e.radius??0],40+t*8)),t.predators.forEach((e,t)=>i.set([...e.position,e.radius??6,e.strength??12],168+t*8)),t.obstacles.forEach((e,t)=>i.set([...e.position,e.radius,e.strength??8],296+t*8)),e.queue.writeBuffer(this.simUniform,0,this.simData)}encodeSteps(e,t,n,r,i){let a=this.compute;this.writeSimUniforms(t,n,r/i);let o=Math.ceil(this.count/256),s=this.gridCells>>8,c=e.beginComputePass(),l=([e,t],n)=>{c.setPipeline(e),c.setBindGroup(0,t),c.dispatchWorkgroups(n)};for(let e=0;e<i;e++){let e=this.ping;l(a.clear,s),l(a.count[e],o),l(a.scanBlocks,s),l(a.scanSums,1),l(a.addOffsets,s),l(a.scatter,o),l(a.rank[e],o),l(a.step[e],o),this.ping=1-e}c.end(),this.stats.steps+=i}simulate(e){if(this.disposed)return;let t=U(this.options,this.count);this.stats.debugEnabled=t.debug.enabled,this.ensureResources(e.device,t);let n=0;t.paused||(this.clocked?this.ticked&&(n=this.pendingDelta):n=e.delta),this.ticked=!1,n=Math.min(Math.max(n,0),gn);let r=Number.isFinite(n)?fn(n):0;this.compat?(r&&(this.stats.steps+=pn(this.cpuState,this.options,n),this.cpuDirty=!0),this.cpuDirty&&=(e.device.queue.writeBuffer(this.states[0],0,this.cpuState.boids),e.device.queue.writeBuffer(this.debugBuf,0,this.cpuState.debugData),!1)):r&&this.encodeSteps(e.encoder,e.device,t,n,r)}draw(e){if(this.disposed)return;let t=U(this.options,this.count);this.ensureResources(e.device,t);let n=!e.format.includes(`float`)&&!e.format.endsWith(`-srgb`),r=this.renderData;r.set(e.camera.matrix,0),r.set([...e.camera.position,t.scale],16),r.set([...t.lightDirection,t.ambient],20),r.set([...t.color,t.flapAmplitude],24),r.set([...t.accentColor,+(t.preset===`fish`)],28),r.set([...t.lightColor,+!!n],32),e.device.queue.writeBuffer(this.renderUniform,0,r);let i=e.descriptor.depthStencil.format,a=`${e.format}:${i}:${e.descriptor.multisample?.count??1}`,o=this.renderPipelines.get(a);if(!o){this.renderModule??=e.device.createShaderModule({code:Kt});let t=e.device.createRenderPipeline({layout:`auto`,vertex:{module:this.renderModule,entryPoint:`vertex`},fragment:{module:this.renderModule,entryPoint:`fragment`,targets:[{format:e.format}]},primitive:{topology:`triangle-list`,cullMode:`none`},multisample:e.descriptor.multisample,depthStencil:{format:i,depthWriteEnabled:!0,depthCompare:`greater`}}),n=n=>e.device.createBindGroup({layout:t.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.renderUniform}},{binding:1,resource:{buffer:n}},{binding:2,resource:{buffer:this.meshBuf}}]}),r=n(this.states[0]);o=[t,r,this.states[1]?n(this.states[1]):r],this.renderPipelines.set(a,o)}this.colorAttachment.view=e.color,this.depthAttachment.view=e.depth;let s=i.includes(`stencil`);this.depthAttachment.stencilLoadOp=s?`load`:void 0,this.depthAttachment.stencilStoreOp=s?`store`:void 0;let c=e.encoder.beginRenderPass(this.renderPassDesc);_t(c,e),c.setPipeline(o[0]),c.setBindGroup(0,this.ping===0?o[1]:o[2]),c.draw(this.meshVertexCount,this.count),c.end(),this.stats.drawCalls=1,this.engine&&this.engine.stats.drawCalls++}drawDebug(e){if(this.disposed||!this.debugBuf)return;let t=U(this.options,this.count),n=t.debug,r=n.grid||n.perception||n.vectors;if(!n.enabled||!(n.velocities||r))return;let i=!e.format.includes(`float`)&&!e.format.endsWith(`-srgb`),a=this.debugUniformData;a.set(e.camera.matrix,0),a.set([...t.boundsCenter,t.boundsShape,...t.boundsHalf,t.boundsRadius],16),a.set([t.neighborRadius,t.separationRadius,t.visionAngle*.5,0],24),a.set([+!!n.grid,+!!n.perception,+!!n.vectors,+!!i],28),a.set([.15,t.maxSpeed,0,0],32),e.device.queue.writeBuffer(this.debugUniform,0,a);let o=e.descriptor.depthStencil.format,s=`${e.format}:${o}:${e.descriptor.multisample?.count??1}`,c=this.debugPipelines.get(s);if(!c){let t=t=>e.device.createRenderPipeline({layout:`auto`,vertex:{module:t,entryPoint:`vertex`},fragment:{module:t,entryPoint:`fragment`,targets:[{format:e.format}]},primitive:{topology:`line-list`},multisample:e.descriptor.multisample,depthStencil:{format:o,depthWriteEnabled:!1,depthCompare:`greater-equal`}});this.debugModule??=e.device.createShaderModule({code:Yt}),this.velocityModule??=e.device.createShaderModule({code:Jt});let n=t(this.debugModule),r=t(this.velocityModule),i=(t,n)=>e.device.createBindGroup({layout:t.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.debugUniform}},{binding:1,resource:{buffer:n}}]}),a=i(r,this.states[0]);c=[n,i(n,this.debugBuf),r,a,this.states[1]?i(r,this.states[1]):a],this.debugPipelines.set(s,c)}this.colorAttachment.view=e.color,this.debugDepthAttachment.view=e.depth,this.debugDepthAttachment.stencilReadOnly=o.includes(`stencil`)?!0:void 0;let l=e.encoder.beginRenderPass(this.debugPassDesc);_t(l,e),n.velocities&&(l.setPipeline(c[2]),l.setBindGroup(0,this.ping===0?c[3]:c[4]),l.draw(2,this.count),this.stats.drawCalls++,this.engine&&this.engine.stats.drawCalls++),r&&(l.setPipeline(c[0]),l.setBindGroup(0,c[1]),l.draw(548),this.stats.drawCalls++,this.engine&&this.engine.stats.drawCalls++),l.end()}release(){for(let e of this.owned)e.destroy();this.owned=[],this.states=[],this.meshBuf=this.simUniform=this.debugBuf=this.renderUniform=this.debugUniform=void 0,this.compute=void 0,this.renderModule=this.debugModule=this.velocityModule=void 0,this.renderPipelines.clear(),this.debugPipelines.clear(),this.meshDirty=!0,this.needsInit=!0}onDeviceRestored(e){this.release(),this.stats.steps=0,this.setup(e)}dispose(){this.disposed||(this.disposed=!0,this.engine?.sceneOf(this)?.removePlugin(this.name),this.release(),this.cpuState=void 0,this.engine=void 0,this.device=void 0)}[Symbol.dispose??Symbol()](){this.dispose()}},yn=tt,bn=async()=>{let{gpu:e}=globalThis.navigator;return!!e&&await e.requestAdapter().catch(()=>null)!=null},xn=async(e,t)=>{try{return await t(e),e}catch(t){throw e.dispose(),t}},Sn=async(e,t,{loadCompat:n,...r}={})=>{let i=r.backend===`webgl2`||r.backend!==`webgpu`&&!await bn()?(await it(async()=>{let{webglRenderer:e}=await import(`./preview-BPhlX00W.js`);return{webglRenderer:e}},__vite__mapDeps([0,1]),import.meta.url)).webglRenderer:void 0,a;try{let n=await yn.create(e,{...r,fallback:i});return a=n.backend,await xn(n,t)}catch(e){if(!n||a!==`webgl2`||e.code!==`unsupported`)throw e}r.signal?.throwIfAborted(),await(await n()).install();let o=e.cloneNode(!1);return e.replaceWith(o),xn(await yn.create(o,{...r,backend:`webgpu`}),t)},Cn=e=>e instanceof Error?e.message:String(e);function wn(e,t,n){let r=!1,i=(e,t)=>{e&&t!==void 0&&(e.textContent=t)};return{get failed(){return r},ready(n,a=`true`){return!r&&(i(t,n),e.dataset.ready=a,!0)},pending(n){r||(i(t,n),delete e.dataset.ready)},error(a){let o=Cn(a);r||i(n??t,o),r=!0,delete e.dataset.ready,e.dataset.error=e.dataset.error??o}}}var Tn=16384,En=[0,11.4,0],Dn=551524,On={count:Tn,seed:Dn,preset:`bird`,bounds:{shape:`box`,center:En,halfSize:[30,10.4,12.2]},boundsMargin:3.4,boundsStrength:8.1,neighborRadius:2.05,separationRadius:.68,visionAngle:5.08,maxNeighbors:16,separation:1.7,alignment:1.84,cohesion:1.22,minSpeed:4.5,maxSpeed:9,maxForce:15,maxTurnAccel:12,bankStrength:.72,flapAmplitude:.47,flapFrequency:7.6};function kn(e){let t=e*.27;return[{position:[10.5*Math.cos(t),En[1]+2.2*Math.sin(t),4.2*Math.sin(t)],strength:1.6,radius:22},{position:[-9*Math.cos(t*.88),En[1]-.5*Math.sin(t),-3.5*Math.sin(t)],strength:1.4,radius:22},{position:En,strength:.8,radius:0}]}function An(e){let t=e>>>0;return()=>(t=Math.imul(t,1664525)+1013904223>>>0,t/4294967296)}function jn(e){let t=An(e),n=new Float32Array(Tn*8),r=()=>t()+t()+t()-1.5;for(let e=0;e<Tn;e++){let i=t()*Math.PI*2,a=e<8683.52?-1:1,o=Math.sin(i),s=Math.cos(i),c=Math.sin(i*2)*3.3,l=e*8;n[l]=18*s+r()*3.4,n[l+1]=En[1]+c+o*2.7+a*1.5+r()*3.3,n[l+2]=7*o+r()*4.1,n[l+3]=t()*Math.PI*2;let u=[-18*o,6.6*Math.cos(i*2)+2.7*s,7*s],d=(5.1+t()*3.7)/Math.hypot(...u);for(let e=0;e<3;e++)n[l+4+e]=u[e]*d}return{count:Tn,steps:0,boids:n}}function Mn(){let e=[],t=[],n=[],r=[];function i(i,a,o,s=0,c=0,l=0){let u=a[0]-i[0],d=a[1]-i[1],f=a[2]-i[2],p=o[0]-i[0],m=o[1]-i[1],h=o[2]-i[2],g=[d*h-f*m,f*p-u*h,u*m-d*p],_=Math.hypot(...g),v=n.length;e.push(...i,...a,...o);for(let e=0;e<3;e++)t.push(...g.map(e=>e/_));n.push(v,v+1,v+2),r.push(s,c,l)}let a=[0,.1,.5],o=[0,-.12,.2],s=[0,.13,-.18],c=[0,.02,-.6];for(let e of[-1,1]){let t=[e*.14,.018,.18],n=[e*.085,.02,-.28],r=[e*.53,.033,.1],l=[e,0,-.24],u=[e*.72,-.016,-.3],d=[e*.3,-.025,-.19],f=(t,n,r,a=0,o=0,s=0)=>{e>0?i(t,n,r,a,o,s):i(t,r,n,a,s,o)};f(t,a,s),f(t,s,n),f(o,t,n),f(o,n,c),f(t,r,d,0,.58,.26),f(r,u,d,.58,.76,.26),f(r,l,u,.58,1,.76),f(n,c,[e*.16,0,-.55])}return{positions:new Float32Array(e),normals:new Float32Array(t),weights:new Float32Array(r),indices:new Uint32Array(n)}}var Nn=-11.5,Pn=(e,t=.84)=>new E({color:e,roughness:t,metalness:0}),W=()=>({points:[],normals:[],indices:[]});function Fn(e,t,n,r,i=[0,1,0]){let a=e.points.length/3;e.points.push(...t,...n,...r),e.normals.push(...i,...i,...i),e.indices.push(a,a+1,a+2)}function In(e,t,n,r,i,a,o){let s=Math.cos(a)*r/2,c=Math.sin(a)*r/2,l=-Math.sin(a)*i/2,u=Math.cos(a)*i/2,d=[t-s-l,o,n-c-u],f=[t-s+l,o,n-c+u],p=[t+s+l,o,n+c+u],m=[t+s-l,o,n+c-u];Fn(e,d,f,p),Fn(e,d,p,m)}function Ln(e,t,n,r){let i=new ee(t.points,t.normals,t.indices);e.createMesh().setGeometry(i).setMaterial(Pn(n,r))}var G=(e,t,n,r,i)=>({x:e,z:t,l:n,w:r,a:i}),Rn=[G(-42,18,45,9,.21),G(35,3,52,8,-.13),G(-36,-21,53,11,-.08),G(29,-35,40,10,.11),G(3,-52,89,8,-.04),G(-65,-66,52,18,.05),G(35,-85,102,10,-.08),G(-43,-105,98,15,.03)];function zn(e){let t=An(433819),n=W();In(n,0,-167,1400,1100,0,Nn),Ln(e,n,`#6b606d`,.48);let r=[W(),W(),W(),W()];for(let e=0;e<970;e++){let e=45-137*t()**1.46,n=150*(t()-.5);In(r[1-Math.min(1,Math.abs(n+18)/35)>.67&&t()>.5?3:Math.floor(t()*3)],n,e,.35+2.7*t(),.07+.23*t(),(.5-t())*.17,-11.494)}let i=[`#85808a`,`#7b7081`,`#a78e93`,`#cb958b`];for(let[t,n]of r.entries())Ln(e,n,i[t],.46);let a=W(),o=[W(),W(),W()];for(let e of Rn){let n=[],r=Math.cos(e.a),i=Math.sin(e.a),s=(t,n,a)=>[e.x+t*r-n*i,a,e.z+t*i+n*r];for(let r=0;r<27;r++){let i=r*2*Math.PI/27,a=.84+t()*.22;n.push(s(Math.cos(i)*e.l*.5*a,Math.sin(i)*e.w*.5*a,-11.32))}let c=[e.x,-10.88,e.z];for(let e=0;e<n.length;e++)Fn(a,c,n[(e+1)%n.length],n[e]);for(let n=0;n<160;n++){let r=e.l*(t()-.5)*.94,i=n%2*2-1,[a,c,l]=s(r,i*e.w*(.26+t()*.19),-11.28),u=.28+t()*.86,d=(t()-.25)*.47,f=o[Math.floor(t()*o.length)],p=.018+t()*.019,m=[a+d*.3,c+u*.61,l+.04],h=[a+d,c+u,l+.06];Fn(f,[a-p,c,l],[a+p,c,l],m,[0,.25,1]),Fn(f,[m[0]-p*.72,m[1],m[2]],[m[0]+p*.72,m[1],m[2]],h,[0,.25,1]);let g=[m[0]+i*.17,m[1]+.21,m[2]-.025];Fn(f,m,[m[0]+i*.04,m[1]+.08,m[2]+.012],g,[0,.25,1])}}Ln(e,a,`#403b45`,.94);let s=[`#504744`,`#62554f`,`#73584c`];for(let[t,n]of o.entries())Ln(e,n,s[t],.9);let c=te(.19,3.2,.18),l=Pn(`#4b3c42`);for(let[n,r]of[[-27,7],[-24,0],[-21,-7],[-18,-14],[-15,-21],[-12,-28]])e.createMesh().setGeometry(c).setMaterial(l).setPosition([n,-10.71+t()*.24,r])}var K=document.querySelector(`#view`),Bn=document.querySelector(`#status`),Vn=document.querySelector(`#help`),Hn=wn(K,Bn,document.querySelector(`#error-reason`)),Un=document.querySelector(`#disturb`),Wn=document.querySelector(`#pause`),Gn=document.querySelector(`#reset`),Kn=document.querySelector(`#disturbance`),qn=[Un,Wn,Gn],Jn=new AbortController,{signal:q}=Jn,Yn=new URLSearchParams(location.search).get(`backend`)===`webgl2`,Xn=[-.28,.045,-.958],Zn=2.9,Qn=4.6,$n=59,er=9.5;ft();var J,Y,tr,nr,rr,ir=0,ar=!1,X=!1,or,Z,sr=0,cr=0,Q,lr=!1,ur=!1,dr,fr=0,pr=0,mr=0,hr=``;function gr(e){if(!(q.aborted||Hn.failed)){Hn.error(e),Bn.hidden=!1,Bn.querySelector(`strong`).textContent=`The flock could not be opened.`,Vn.hidden=!1;for(let e of qn)e.disabled=!0;nr!==void 0&&cancelAnimationFrame(nr)}}function _r(){pr=K.clientWidth,mr=K.clientHeight;let e=Math.max(1,Math.min(1.4,devicePixelRatio)),t=Math.max(1,Math.round(pr*e)),n=Math.max(1,Math.round(mr*e));K.width!==t&&(K.width=t),K.height!==n&&(K.height=n),J.camera.fov=2*Math.atan(Math.max(.39,.515*n/t))*180/Math.PI}function vr(){Z=void 0,Kn.hidden=!0,Q||Y.setPredators([])}function yr(e,t){if(!Y||Hn.failed)return;let n=Math.tan(J.camera.fov*Math.PI/360),r=Math.hypot($n,1.6999999999999997),i=1.6999999999999997/r,a=$n/r,o=(2*e/pr-1)*n*pr/mr,s=(1-2*t/mr)*n,c=$n/(a-i*s),l={position:[o*c,Zn+(i+a*s)*c,0],radius:er,strength:36};Z={influence:l,expiry:performance.now()+1050},Q||Y.setPredators([l]),sr++,Kn.style.left=e+`px`,Kn.style.top=t+`px`,Kn.hidden=!1,X&&wr()}function br(e){let t=K.getBoundingClientRect();yr(e.clientX-t.left,e.clientY-t.top)}function $(){nr===void 0&&!Hn.failed&&(nr=requestAnimationFrame(Sr))}function xr(){let e=Y.stats,t=[e.steps,Z?`true`:`false`,X,cr].join(`;`);t!==hr&&(hr=t,Object.assign(K.dataset,{steps:e.steps,disturbing:String(!!Z),paused:String(X),input:cr}))}function Sr(e){if(nr=void 0,q.aborted||document.hidden||Hn.failed)return;if(ar){$();return}if(Z&&cr===sr&&e>=Z.expiry&&vr(),Q&&!X&&ur&&!lr){let e=.046;ir+=e,lr=!0,Q.postMessage({generation:fr,record:Z?sr:0,delta:e,time:ir,predator:Z?.influence})}let t=X?0:Math.min(.046,Math.max(0,rr===void 0?1/60:(e-rr)/1e3));rr=e;let n=0;Q?dr&&!X&&(Y.restore(dr),n=dr.record,dr=void 0):t>0&&(ir+=t,Y.setAttractors(kn(ir)),n=Z?sr:0);try{J.render({delta:t}),xr(),ar=!0,J.gpu.queue.onSubmittedWorkDone().then(()=>{ar=!1,!q.aborted&&(n>cr&&(cr=n,performance.getEntriesByName(`murmuration-first-disturbance`).length||performance.mark(`murmuration-first-disturbance`),xr()),!X&&(!Q||dr)&&$())}).catch(gr)}catch(e){gr(e);return}!X&&!Q&&$()}function Cr(){Q=new Worker(new URL(new URL(`flight-worker-C0q7lH6n.js`,import.meta.url).href,``+import.meta.url),{type:`module`}),Q.addEventListener(`error`,e=>gr(e.error??Error(`The flock worker could not start.`)),{signal:q}),Q.addEventListener(`message`,e=>{e.data.ready?ur=!0:(lr=!1,e.data.generation===fr&&(dr=e.data)),Y&&J&&!X&&$()},{signal:q})}function wr(){X=!X,Y.options.paused=!!Q||X,Wn.setAttribute(`aria-pressed`,String(X)),Wn.textContent=X?`Resume`:`Pause`,rr=void 0,xr(),$()}function Tr(){K.addEventListener(`pointerdown`,e=>{e.isPrimary&&(or=e.pointerId,K.setPointerCapture(or),br(e))},{signal:q}),K.addEventListener(`pointermove`,e=>{(e.pointerId===or||e.pointerType===`mouse`&&!X)&&br(e)},{signal:q});for(let e of[`pointerup`,`pointercancel`,`lostpointercapture`])K.addEventListener(e,e=>{e.pointerId===or&&(or=void 0)},{signal:q});Un.addEventListener(`click`,()=>yr(pr*.52,mr*.38),{signal:q}),Wn.addEventListener(`click`,wr,{signal:q}),Gn.addEventListener(`click`,()=>{vr(),Y.restore(jn(Dn)),Q&&(fr++,dr=void 0,Q.postMessage({reset:!0})),ir=0,$()},{signal:q}),document.addEventListener(`visibilitychange`,()=>{rr=void 0,document.hidden||$()},{signal:q}),tr=new ResizeObserver(()=>{_r(),$()}),tr.observe(K)}function Er(e){return createImageBitmap(e,{premultiplyAlpha:`none`,colorSpaceConversion:`none`})}async function Dr(){let e=await fetch(new URL(new URL(`marsh-sky-sF1NxFok.webp`,import.meta.url).href,``+import.meta.url),{signal:q});if(!e.ok)throw Error(`The marsh sky could not be loaded.`);let t=await e.blob();return{blob:t,bitmap:await Er(t)}}async function Or(){let e=Dr().catch(e=>({error:e})),t=Yn||!navigator.gpu,n=t?it(()=>import(`./dist-BML1wtsD.js`).then(e=>({module:e}),e=>({error:e})),[],import.meta.url):void 0,i=async()=>{let e=await n;if(e?.error)throw e.error;let t=e?.module??await it(()=>import(`./dist-BML1wtsD.js`),[],import.meta.url);return{install:()=>t.install({force:Yn,signal:q})}};t&&(Cr(),await(await i()).install()),J=await Sn(K,async t=>{if(!t.gpu)throw r(`unsupported`,`The flock requires the Margo GPU frame graph`,`flocking`);J=t,K=t.canvas,Hn=wn(K,Bn,document.querySelector(`#error-reason`)),_r(),t.lighting.direction.set([...Xn,1.08]),t.lighting.radiance.set([1,.63,.53,.28]),t.lighting.ambient.set([.38,.33,.43]);let n=await e;if(n.error)throw n.error;t.scene.use(new ht(n.bitmap.width?n.bitmap:await Er(n.blob))),zn(t);let i=t.gpu.adapterInfo?.vendor===`margo-webgl2`;Y=vn.attach(t,{...On,geometry:Mn(),paused:i,color:`#362a37`,accentColor:`#593f49`,ambient:.61,lightDirection:Xn,lightColor:`#f4a78b`,scale:.207}),Y.restore(jn(Dn)),t.render({delta:0}),await t.gpu.queue.onSubmittedWorkDone()},{loadCompat:i,backend:t?`webgpu`:void 0,signal:q,exactSize:!0,antialias:!1,capacity:96,startupTimeout:8500,camera:{position:[0,Zn,$n],target:[0,Qn,0],near:.15,far:1150,fov:52}}),q.throwIfAborted(),J.onError=gr,Y.stats.backend===`webgl2-compat`&&!Q&&Cr(),K.dataset.renderer=Y.stats.backend,K.dataset.birds=String(Y.count),K.dataset.sky=`margo-baked-dusk`;for(let e of qn)e.disabled=!1;Bn.hidden=!0,xr(),Hn.ready(),performance.mark(`margo-first-usable-frame`),Tr(),$()}window.addEventListener(`pagehide`,e=>{e.persisted||(Jn.abort(),tr?.disconnect(),nr!==void 0&&cancelAnimationFrame(nr),Q?.terminate(),Y?.dispose(),J?.dispose())}),Or().catch(gr);export{it as n,yt as t};