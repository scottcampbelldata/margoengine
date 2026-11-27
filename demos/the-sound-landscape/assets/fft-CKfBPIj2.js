import{a as e,g as t,n,r,v as i}from"./array-DbI848Wf-CdHXJFgJ.js";var a=`struct Pass { n: u32, l: u32, lines: u32, inverse: u32 }
@group(0) @binding(0) var<storage, read> reIn: array<f32>;
@group(0) @binding(1) var<storage, read> imIn: array<f32>;
@group(0) @binding(2) var<storage, read_write> reOut: array<f32>;
@group(0) @binding(3) var<storage, read_write> imOut: array<f32>;
@group(0) @binding(4) var<uniform> pass_: Pass;
@group(0) @binding(5) var<storage, read> twiddle: array<vec2f>;
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let t = (wid.x + wid.y * nwg.x) * 256u + lid;
  let half = pass_.n / 2u;
  if (t >= half * pass_.lines) { return; }
  let line = t / half;
  let j = t % half;
  let base = line * pass_.n;
  let k = j % pass_.l;

  var w = twiddle[k * (half / pass_.l)];
  if (pass_.inverse == 1u) { w.y = -w.y; }
  let a = vec2f(reIn[base + j], imIn[base + j]);
  let b0 = vec2f(reIn[base + j + half], imIn[base + j + half]);
  let b = vec2f(w.x * b0.x - w.y * b0.y, w.x * b0.y + w.y * b0.x);
  let dest = base + 2u * j - k;
  reOut[dest] = a.x + b.x;
  imOut[dest] = a.y + b.y;
  reOut[dest + pass_.l] = a.x - b.x;
  imOut[dest + pass_.l] = a.y - b.y;
}`,o=e=>e>0&&!(e&e-1);function s(e){if(!o(e)||e<2)throw t(`twiddleTable needs a power of two of at least 2, got ${e}`,`compute`);let n=e/2,r=new Float32Array(e);for(let t=0;t<n;t++){let n=2*Math.PI*t/e,i=4*t===e;r[2*t]=i?0:Math.cos(n),r[2*t+1]=i?-1:-Math.sin(n)}return r}var c=8,l=new WeakMap;function u(e,t){let n=l.get(e);n||l.set(e,n=new Map);let r=n.get(t);if(r&&!r.disposed?n.delete(t):r=e.array(s(t)),n.set(t,r),n.size>c){let[e,t]=n.entries().next().value;n.delete(e),t.dispose()}return r}function d(e,t,n,r,i,o){let s=t,c=n,l=[],d=e.program(a,void 0,`fft.stockham`),f=[],p=r*i,m=e.empty([p],`f32`),h=e.empty([p],`f32`),g=r>2?e.empty([p],`f32`):m,_=r>2?e.empty([p],`f32`):h;if(r===1)return e.submit([],[[t.buffer,t.offset*4,m.buffer,0,p*4],[n.buffer,n.offset*4,h.buffer,0,p*4]]),{re:m,im:h};let v=u(e,r),y=0;for(let t=1;t<r;t*=2){let[n,a]=y===0?[m,h]:[g,_];f.push({program:d,resources:{reIn:s,imIn:c,reOut:n,imOut:a,pass_:new Uint32Array([r,t,i,+!!o]),twiddle:v},workgroups:e.grid(Math.ceil(p/2/256))}),s=n,c=a,y^=1}if(e.submit(f),r>2)for(let e of s===m?[g,_]:[m,h])l.push(e);for(let e of l)e.dispose();return{re:s,im:c}}var f=(e,t,n,r)=>({re:e.mul(n).sub(t.mul(r)),im:e.mul(r).add(t.mul(n))});function p(e,t,n,r,i,a){let o=1;for(;o<2*r-1;)o*=2;let s=a?1:-1,c=new Float32Array(r),l=new Float32Array(r);for(let e=0;e<r;e++){let t=s*Math.PI*(e*e%(2*r))/r;c[e]=Math.cos(t),l[e]=Math.sin(t)}let u=new Float32Array(o),p=new Float32Array(o);for(let e=0;e<r;e++)u[e]=c[e],p[e]=-l[e],e&&(u[o-e]=c[e],p[o-e]=-l[e]);let m=e.array(c,{shape:[1,r]}),h=e.array(l,{shape:[1,r]}),g=e.array(u),_=e.array(p),v=d(e,g,_,o,1,!1),y=f(t.reshape(i,r),n.reshape(i,r),m,h),b=e.zeros([i,o]),x=e.zeros([i,o]),S=y.re.eval(),C=y.im.eval(),w=[];for(let e=0;e<i;e++)w.push([S.buffer,e*r*4,b.buffer,e*o*4,r*4]),w.push([C.buffer,e*r*4,x.buffer,e*o*4,r*4]);e.submit([],w);let T=d(e,b,x,o,i,!1),E=v.re.reshape(1,o),D=v.im.reshape(1,o),O=f(T.re.reshape(i,o),T.im.reshape(i,o),E,D),k=O.re.eval(),A=O.im.eval(),j=d(e,k,A,o,i,!0),M=f(j.re.reshape(i,o).slice(null,[0,r]),j.im.reshape(i,o).slice(null,[0,r]),m,h),N={re:M.re.mul(1/o).eval().transfer([i*r]),im:M.im.mul(1/o).eval().transfer([i*r])};for(let e of[m,h,g,_,v.re,v.im,b,x,S,C,T.re,T.im,k,A,j.re,j.im])e.dispose();return N}function m(a,s,c){let l=a instanceof e?a:a.re,u=a instanceof e?void 0:a.im;if(!(l instanceof e))throw i(`fft takes a real array or { re, im } arrays`,`compute`);if(u&&(u.ndim!==l.ndim||u.shape.some((e,t)=>e!==l.shape[t])))throw t(`fft re and im must have one shape`,`compute`);let f=l.context;if(f.check(),l.ndim===0)throw t(`fft needs at least one dimension`,`compute`);let m=n(s.axis??-1,l.ndim),h=l.shape[m],g=l.shape,_=[...g.keys()].filter(e=>e!==m).concat(m),v=_.map((e,t)=>_.indexOf(t)),y=e=>{let t=e instanceof r?e:e.eval(),n=t.transpose(..._).astype(`f32`).eval();return t!==e&&t.dispose(),n},b=y(l),x=u?y(u):f.zeros(b.shape),S=h?b.size/h:0,C;C=b.size===0?{re:f.zeros(b.shape),im:f.zeros(b.shape)}:o(h)?d(f,b.reshape(b.size),x.reshape(x.size),h,S,c):p(f,b,x,h,S,c),b.dispose(),x.dispose();let w=_.map(e=>g[e]),T=e=>{let t=e.reshape(...w).transpose(...v),n=(c?t.mul(1/h):t).eval();return e.dispose(),n};return{re:T(C.re),im:T(C.im)}}function h(e,t={}){return m(e,t,!1)}export{h as fft};