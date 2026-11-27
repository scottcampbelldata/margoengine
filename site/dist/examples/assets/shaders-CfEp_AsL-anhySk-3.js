import{i as e}from"./mat4-Dl2hqlTt.js";import{t}from"./quaternion-DJu3sSdD.js";import{t as n}from"./quat-DEUogYg9.js";var r,i=class e{constructor(){this.elements=new Float64Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1])}set(e,t,n,r,i,a,o,s,c,l,u,d,f,p,m,h){let g=this.elements;return g[0]=e,g[4]=t,g[8]=n,g[12]=r,g[1]=i,g[5]=a,g[9]=o,g[13]=s,g[2]=c,g[6]=l,g[10]=u,g[14]=d,g[3]=f,g[7]=p,g[11]=m,g[15]=h,this}identity(){return this.set(1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1)}copy(e){return this.fromArray(e.elements)}clone(){return new e().copy(this)}multiply(e){return this.multiplyMatrices(this,e)}premultiply(e){return this.multiplyMatrices(e,this)}multiplyMatrices(e,t){let n=e.elements,i=t.elements,a=r??=new Float64Array(16);for(let e=0;e<4;e++){let t=i[e*4],r=i[e*4+1],o=i[e*4+2],s=i[e*4+3];for(let i=0;i<4;i++)a[e*4+i]=n[i]*t+n[4+i]*r+n[8+i]*o+n[12+i]*s}return this.elements.set(a),this}multiplyScalar(e){let t=this.elements;for(let n=0;n<16;n++)t[n]*=e;return this}determinant(){return this.invertInto(!1)}invert(){return this.invertInto(!0),this}invertInto(e){let t=this.elements,n=t[0],r=t[4],i=t[8],a=t[12],o=t[1],s=t[5],c=t[9],l=t[13],u=t[2],d=t[6],f=t[10],p=t[14],m=t[3],h=t[7],g=t[11],_=t[15],v=n*s-o*r,y=n*c-o*i,b=n*l-o*a,x=r*c-s*i,S=r*l-s*a,C=i*l-c*a,w=u*h-m*d,T=u*g-m*f,E=u*_-m*p,D=d*g-h*f,O=d*_-h*p,k=f*_-g*p,A=v*k-y*O+b*D+x*E-S*T+C*w;if(!e)return A;if(A===0)return t.fill(0),A;let j=1/A;return this.set((s*k-c*O+l*D)*j,(-r*k+i*O-a*D)*j,(h*C-g*S+_*x)*j,(-d*C+f*S-p*x)*j,(-o*k+c*E-l*T)*j,(n*k-i*E+a*T)*j,(-m*C+g*b-_*y)*j,(u*C-f*b+p*y)*j,(o*O-s*E+l*w)*j,(-n*O+r*E-a*w)*j,(m*S-h*b+_*v)*j,(-u*S+d*b-p*v)*j,(-o*D+s*T-c*w)*j,(n*D-r*T+i*w)*j,(-m*x+h*y-g*v)*j,(u*x-d*y+f*v)*j),A}transpose(){let e=this.elements;for(let t=0;t<4;t++)for(let n=t+1;n<4;n++){let r=e[n*4+t];e[n*4+t]=e[t*4+n],e[t*4+n]=r}return this}setPosition(e,t=0,n=0){let r=this.elements;return typeof e==`number`?(r[12]=e,r[13]=t,r[14]=n):(r[12]=e.x,r[13]=e.y,r[14]=e.z),this}makeTranslation(e,t,n){return this.set(1,0,0,e,0,1,0,t,0,0,1,n,0,0,0,1)}makeScale(e,t,n){return this.set(e,0,0,0,0,t,0,0,0,0,n,0,0,0,0,1)}makeRotationX(e){let t=Math.cos(e),n=Math.sin(e);return this.set(1,0,0,0,0,t,-n,0,0,n,t,0,0,0,0,1)}makeRotationY(e){let t=Math.cos(e),n=Math.sin(e);return this.set(t,0,n,0,0,1,0,0,-n,0,t,0,0,0,0,1)}makeRotationZ(e){let t=Math.cos(e),n=Math.sin(e);return this.set(t,-n,0,0,n,t,0,0,0,0,1,0,0,0,0,1)}makeRotationAxis(e,t){let n=Math.cos(t),r=Math.sin(t),i=1-n,{x:a,y:o,z:s}=e;return this.set(i*a*a+n,i*a*o-r*s,i*a*s+r*o,0,i*a*o+r*s,i*o*o+n,i*o*s-r*a,0,i*a*s-r*o,i*o*s+r*a,i*s*s+n,0,0,0,0,1)}makeRotationFromQuaternion(e){return this.composeComponents(0,0,0,e.x,e.y,e.z,e.w,1,1,1)}compose(e,t,n){return this.composeComponents(e.x,e.y,e.z,t.x,t.y,t.z,t.w,n.x,n.y,n.z)}composeComponents(e,t,n,r,i,a,o,s,c,l){let u=2*r*r,d=2*i*i,f=2*a*a,p=2*r*i,m=2*r*a,h=2*i*a,g=2*o*r,_=2*o*i,v=2*o*a;return this.set((1-d-f)*s,(p-v)*c,(m+_)*l,e,(p+v)*s,(1-u-f)*c,(h-g)*l,t,(m-_)*s,(h+g)*c,(1-u-d)*l,n,0,0,0,1)}decompose(e,t,n){let i=this.elements,a=r??=new Float64Array(16),o=Math.hypot(i[0],i[1],i[2]),s=Math.hypot(i[4],i[5],i[6]),c=Math.hypot(i[8],i[9],i[10]);this.determinant()<0&&(o=-o),e.x=i[12],e.y=i[13],e.z=i[14],n.x=o,n.y=s,n.z=c;for(let e=0;e<3;e++){let t=e===0?o:e===1?s:c;for(let n=0;n<3;n++)a[e*4+n]=t===0?0:i[e*4+n]/t;a[e*4+3]=0}return a[12]=a[13]=a[14]=0,a[15]=1,t.setFromRotationMatrix({elements:a}),this}lookAt(e,t,n){let r=this.elements,i=e.x-t.x,a=e.y-t.y,o=e.z-t.z,s=Math.hypot(i,a,o);s===0?(i=0,a=0,o=1):(i/=s,a/=s,o/=s);let c=n.y*o-n.z*a,l=n.z*i-n.x*o,u=n.x*a-n.y*i;if(c===0&&l===0&&u===0){let e=Math.abs(i),t=Math.abs(a),n=Math.abs(o);e<=t&&e<=n?(c=0,l=-o,u=a):t<=n?(c=o,l=0,u=-i):(c=-a,l=i,u=0)}let d=Math.hypot(c,l,u);return c/=d,l/=d,u/=d,r[0]=c,r[1]=l,r[2]=u,r[4]=a*u-o*l,r[5]=o*c-i*u,r[6]=i*l-a*c,r[8]=i,r[9]=a,r[10]=o,this}makePerspective(e,t,n,r,i,a,o=!0){let s=o?-a/(a-i):-(a+i)/(a-i),c=o?-a*i/(a-i):-2*a*i/(a-i);return this.set(2*i/(t-e),0,(t+e)/(t-e),0,0,2*i/(n-r),(n+r)/(n-r),0,0,0,s,c,0,0,-1,0)}makeOrthographic(e,t,n,r,i,a,o=!0){let s=1/(t-e),c=1/(n-r),l=1/(a-i);return this.set(2*s,0,0,-(t+e)*s,0,2*c,0,-(n+r)*c,0,0,o?-l:-2*l,o?-i*l:-(a+i)*l,0,0,0,1)}getMaxScaleOnAxis(){let e=this.elements;return Math.sqrt(Math.max(e[0]*e[0]+e[1]*e[1]+e[2]*e[2],e[4]*e[4]+e[5]*e[5]+e[6]*e[6],e[8]*e[8]+e[9]*e[9]+e[10]*e[10]))}equals(e,t=0){for(let n=0;n<16;n++)if(!(Math.abs(this.elements[n]-e.elements[n])<=t))return!1;return!0}fromArray(e,t=0){for(let n=0;n<16;n++)this.elements[n]=e[t+n];return this}toArray(e=[],t=0){for(let n=0;n<16;n++)e[t+n]=this.elements[n];return e}},a=`fn acesNarkowicz(c:vec3f)->vec3f{let x=0.6*c;return clamp(x*(2.51*x+0.03)/(x*(2.43*x+0.59)+0.14),vec3f(0.0),vec3f(1.0));}
`;function o(e,t=[0,0,0]){for(let n=0;n<3;n++){let r=.6*e[n];t[n]=Math.min(1,Math.max(0,r*(2.51*r+.03)/(r*(2.43*r+.59)+.14)))}return t}var s=.18,c=10,l=2.4,u=1.5,d=2.4,f=1e-10,p=.6,m=[.6274039,.32928304,.043313066,.069097289,.9195404,.011362316,.016391439,.088013308,.89559525],h=[.85662716,.095121245,.048251598,.13731897,.76124199,.10143904,.11189821,.076799415,.81130238],g=[1.1271006,-.11060664,-.016493931,-.14132975,1.1578237,-.016493931,-.14132975,-.11060664,1.2519364],_=[1.660491,-.58764114,-.072849863,-.12455047,1.1328999,-.0083494226,-.018150763,-.1005789,1.1187297],v=[.26270021,.67799807,.059301716],y=[.21263901,.71516868,.072192315],b=_.map((e,t)=>{let n=t-t%3,r=t%3;return _[n]*g[r]+_[n+1]*g[r+3]+_[n+2]*g[r+6]}),x=16.5,S=1/x,C=(c-Math.log2(s))/x,w=c/x,T=s**(1/d),E=(e,t)=>e*((e/t)**u-1)**(-1/u),D=E(l*.3939393939393939,1-T),O=E(l*w,T),k=e=>Number.isInteger(e)?e+`.0`:String(e),A=e=>`mat3x3f(${[0,1,2].map(t=>`vec3f(${k(e[t])},${k(e[t+3])},${k(e[t+6])})`).join(`,`)})`,j=e=>`vec3f(${e.map(k).join(`,`)})`,ee=`fn agxRail(c:vec3f,w:vec3f)->vec3f{let o=c+max(-min(c.x,min(c.y,c.z)),0.0);let y=max(dot(c,w),0.0);
let s=dot(o,w);return select(o,o*(y/s),s>y);}
fn agxHsv(c:vec3f)->vec3f{let m=max(c.x,max(c.y,c.z));let d=m-min(c.x,min(c.y,c.z));var h=0.0;
if(d>0.0){if(m==c.x){h=(c.y-c.z)/d;}else if(m==c.y){h=(c.z-c.x)/d+2.0;}else{h=(c.x-c.y)/d+4.0;}}
return vec3f(fract(h/6.0),select(0.0,d/m,m>0.0),m);}
fn agxRgb(c:vec3f)->vec3f{let k=(vec3f(5.0,3.0,1.0)+c.x*6.0)%6.0;return c.z-c.z*c.y*clamp(min(k,4.0-k),vec3f(0.0),vec3f(1.0));}
fn agxSide(t:vec3f,k:vec3f)->vec3f{let u=${k(l)}*t/k;return k*u/pow(1.0+pow(u,vec3f(${k(u)})),vec3f(${k(1/u)}));}
fn agx(c:vec3f)->vec3f{
let i=${A(h)}*agxRail(${A(m)}*c,${j(v)});
let x=clamp(log2(select(vec3f(${k(f)}),i,i>vec3f(${k(f)})))*${k(S)}+${k(C)},vec3f(0.0),vec3f(1.0));
let d=x-${k(w)};let y=${k(T)}+sign(d)*agxSide(abs(d),select(vec3f(${k(O)}),vec3f(${k(D)}),d>=vec3f(0.0)));
var f=agxHsv(pow(max(y,vec3f(0.0)),vec3f(${k(d)})));let p=agxHsv(i);
if(f.y>0.0&&p.y>0.0){let h=p.x-f.x;f.x=fract(f.x+${k(p)}*(h-floor(h+0.5)));}
return clamp(agxRail(${A(b)}*agxRgb(f),${j(y)}),vec3f(0.0),vec3f(1.0));}
`,M=0,N=0,P=0,F=0,I=0,te=0;function ne(e,t,n,r){M=e[0]*t+e[1]*n+e[2]*r,N=e[3]*t+e[4]*n+e[5]*r,P=e[6]*t+e[7]*n+e[8]*r}function re(e,t,n,r){let i=Math.max(-Math.min(e,t,n),0),a=Math.max(e*r[0]+t*r[1]+n*r[2],0);e+=i,t+=i,n+=i;let o=e*r[0]+t*r[1]+n*r[2],s=o>a?a/o:1;M=e*s,N=t*s,P=n*s}function ie(e,t,n){let r=Math.max(e,t,n),i=r-Math.min(e,t,n),a=0;i>0&&(a=(r===e?(t-n)/i:r===t?(n-e)/i+2:(e-t)/i+4)/6),F=a-Math.floor(a),I=r>0?i/r:0,te=r}var ae=e=>{let t=(e+F*6)%6;return te-te*I*Math.min(Math.max(Math.min(t,4-t),0),1)};function oe(e){let t=Math.min(Math.max(Math.log2(e>f?e:f)*S+C,0),1)-w,n=t>=0?D:O,r=l*Math.abs(t)/n;return Math.max(T+Math.sign(t)*n*r/(1+r**u)**(1/u),0)**d}function se(e,t=[0,0,0]){ne(m,e[0],e[1],e[2]),re(M,N,P,v),ne(h,M,N,P);let n=M,r=N,i=P;ie(oe(n),oe(r),oe(i));let a=F,o=I,s=te;if(ie(n,r,i),o>0&&I>0){let e=F-a;F=a+p*(e-Math.floor(e+.5)),F-=Math.floor(F)}else F=a;return I=o,te=s,ne(b,ae(5),ae(3),ae(1)),re(M,N,P,y),t[0]=Math.min(Math.max(M,0),1),t[1]=Math.min(Math.max(N,0),1),t[2]=Math.min(Math.max(P,0),1),t}var ce=e=>{let t=Math.min(e[0],e[1],e[2]),n=t<.08?t-6.25*t*t:.04,r=e.map(e=>e-n),i=Math.max(r[0],r[1],r[2]);if(i<.76)return r;let a=1-.0576/(i+.24-.76),o=1-1/(.15*(i-a)+1);return r.map(e=>e*a/i+(a-e*a/i)*o)},le=e=>e===`linear`?e=>e:e===`aces-narkowicz`?o:e===`agx`?se:ce,ue=(e,t)=>{let n=Math.min(1,Math.max(0,e));return Math.round(255*(t?n**(1/t):n<=.0031308?n*12.92:1.055*n**(1/2.4)-.055))};function de(e,t,n,r,i,a,o,s,c){let l=2**e.exposure,u=le(e.toneMapping),{gamma:d,vignette:f}=e,p=[0,0,0];for(let e=0;e<t*i;e++){let i=o?o[e]:1,m=i>0?l/i:0;if(f>0){let i=e%t+.5-t/2,a=r+Math.floor(e/t)+.5-n/2,o=f*Math.hypot(i,a)/(.2238*n);m/=(1+o*o)**2}for(let t=0;t<3;t++)p[t]=Math.max(0,a[e*3+t]*m);let h=u(p);for(let t=0;t<3;t++)c[e*s+t]=ue(h[t],d);s===4&&(c[e*4+3]=Math.round(255*Math.min(1,Math.max(0,i))))}}function fe(e,n=1e-5){if(!e||!(e.length>=16))throw TypeError(`decomposeAffine needs 16 column-major numbers, such as Matrix4.elements`);if(!(n>=0&&n<1/0))throw RangeError(`decomposeAffine tolerance ${n} is invalid; pass a finite number >= 0, e.g. 1e-5`);let r=new i().fromArray(e),a=r.elements,o={x:0,y:0,z:0},s={x:0,y:0,z:0},c=new t;r.decompose(o,c,s),c.normalize();let l=new i().compose(o,c,s).elements,u=0;for(let e=0;e<16;e++){let t=Math.abs(l[e]-a[e]);u=t===t&&t!==1/0?Math.max(u,t):1/0}let d=e=>[a[4*e],a[4*e+1],a[4*e+2]],f=(e,t)=>e[0]*t[0]+e[1]*t[1]+e[2]*t[2],p=(e,t,n)=>e.map((e,r)=>e-n*t[r]),m=e=>e.map(t=>t/Math.hypot(e[0],e[1],e[2])),h=d(0),g=d(1),_=d(2),v=m(h),y=f(v,g),b=p(g,v,y),x=m(b),S=f(v,_),C=f(x,_),w=p(p(_,v,S),x,C),T=Math.hypot(b[0],b[1],b[2]),E=Math.hypot(w[0],w[1],w[2]),D=h[0]*(g[1]*_[2]-g[2]*_[1])-h[1]*(g[0]*_[2]-g[2]*_[0])+h[2]*(g[0]*_[1]-g[1]*_[0]);return{translation:[o.x,o.y,o.z],rotation:c.toArray(),scale:[s.x,s.y,s.z],shear:[T>0?y/T:NaN,E>0?S/E:NaN,E>0?C/E:NaN],handedness:D>0?`right`:D<0?`left`:`degenerate`,projective:a[3]!==0||a[7]!==0||a[11]!==0||a[15]!==1,error:u,lossless:u<=n}}var pe=2**-15,me=1e-5,he=.9995,L=(e,t,n)=>{throw RangeError(`VoxelPathTracer ${e} motion interval ${t}; pass a ${n} that stays invertible, or motionInterpolation 'trs' for rotations`)},ge=[0,1,2,4,5,6,8,9,10],R=(e,t,n)=>e[0]*(t[1]*n[2]-t[2]*n[1])-t[0]*(e[1]*n[2]-e[2]*n[1])+n[0]*(e[1]*t[2]-e[2]*t[1]),_e=e=>Math.max(...ge.map(t=>Math.abs(e[t]))),ve=(e,t)=>[0,1,2].map(n=>[e[n]/t,e[4+n]/t,e[8+n]/t]),ye=e=>Float64Array.from([e[0],e[4],e[8],0,e[1],e[5],e[9],0,e[2],e[6],e[10],0,e[3],e[7],e[11],1]);function be(e,t,n,r){let i=Math.max(_e(e),_e(t));i>0||L(n,`is singular`,r);let a=ve(e,i),o=ve(t,i).map((e,t)=>e.map((e,n)=>e-a[t][n])),s=R(a[0],a[1],a[2]),c=R(o[0],a[1],a[2])+R(a[0],o[1],a[2])+R(a[0],a[1],o[2]),l=R(o[0],o[1],a[2])+R(o[0],a[1],o[2])+R(a[0],o[1],o[2]),u=R(o[0],o[1],o[2]),d=[0,1],f=3*u,p=2*l;if(f===0)p!==0&&d.push(-c/p);else{let e=p*p-4*f*c;e>=0&&d.push((-p+Math.sqrt(e))/(2*f),(-p-Math.sqrt(e))/(2*f))}let m=Math.sign(s);for(let e of d)e>=0&&e<=1&&!(m*(((u*e+l)*e+c)*e+s)>pe)&&L(n,`becomes singular between the two transforms`,r)}function xe(t,n,r){let i=_e(t),a=ye(t);i>0||L(n,`has a singular endpoint`,r);for(let e of ge)a[e]/=i;a[12]=a[13]=a[14]=0;let o=fe(a,me);(!o.lossless||o.shear.some(e=>!(Math.abs(e)<=me)))&&L(n,`has shear, which motionInterpolation 'trs' does not support`,r);let s=o.scale.map(e=>e*i),c=o.rotation.slice(),l=e([0,0,0],c,s,new Float64Array(16)),u=ye(t);for(let e of ge)Math.abs(l[e]-u[e])<=me*i||L(n,`is not a rotation and scale`,r);return{q:c,scale:s}}function Se(e,t,r,i,a,o=[0,0,0],s=`previousMatrix`){let c=new Float64Array([1/0,1/0,1/0,-1/0,-1/0,-1/0]),l;if(i===`trs`){let i=xe(e,a,s),u=xe(t,a,s);i.scale.some((e,t)=>Math.sign(e)!==Math.sign(u.scale[t]))&&L(a,`changes handedness`,s);let d=n(i.q,i.q,0,he),f=n(d,u.q,1,he),p=Math.max(0,Math.min(1,d.reduce((e,t,n)=>e+t*f[n],0))),m=Math.acos(p);l=new Float32Array(16),l.set(d,0),l.set(f,4),l.set(i.scale,8),l.set(u.scale,12),l[11]=m,l[15]=p>he?0:1/Math.sin(m),l.every(Number.isFinite)||L(a,`is out of Float32 range`,s);let h=Math.hypot(...r.map((e,t)=>Math.max(Math.abs(o[t]),Math.abs(o[t]+e))*Math.max(Math.abs(i.scale[t]),Math.abs(u.scale[t]))));for(let n=0;n<3;n++)c[n]=Math.min(e[n*4+3],t[n*4+3])-h,c[n+3]=Math.max(e[n*4+3],t[n*4+3])+h}else be(e,t,a,s);for(let n of[e,t])for(let e=0;e<8;e++)for(let t=0;t<3;t++){let i=t*4,a=n[i]*(o[0]+(e&1?r[0]:0))+n[i+1]*(o[1]+(e&2?r[1]:0))+n[i+2]*(o[2]+(e&4?r[2]:0))+n[i+3];c[t]=Math.min(c[t],a),c[t+3]=Math.max(c[t+3],a)}for(let e=0;e<3;e++){let t=2**-16*Math.max(1,Math.abs(c[e]),Math.abs(c[e+3]));c[e]-=t,c[e+3]+=t}return{payload:l,bounds:c}}function Ce(e,t,n){let r=Math.hypot(e[0],e[1],e[2]),i=[e[0]/r,e[1]/r,e[2]/r],a=t??(Math.abs(i[1])>.999?[0,0,1]:[0,1,0]),o=[a[1]*i[2]-a[2]*i[1],a[2]*i[0]-a[0]*i[2],a[0]*i[1]-a[1]*i[0]],s=Math.hypot(o[0],o[1],o[2]);if(!(s>1e-6*Math.hypot(a[0],a[1],a[2])))throw RangeError(`${n} up is parallel to its direction; pass another up vector`);let c=[o[0]/s,o[1]/s,o[2]/s];return{normal:i,right:c,up:[i[1]*c[2]-i[2]*c[1],i[2]*c[0]-i[0]*c[2],i[0]*c[1]-i[1]*c[0]]}}var z=1024,we=e=>[[.1787*e-1.463,-.3554*e+.4275,-.0227*e+5.3251,.1206*e-2.5771,-.067*e+.3703],[-.0193*e-.2592,-.0665*e+8e-4,-4e-4*e+.2125,-.0641*e-.8989,-.0033*e+.0452],[-.0167*e-.2608,-.095*e+.0092,-.0079*e+.2102,-.0441*e-1.6537,-.0109*e+.0529]],B=([e,t,n,r,i],a,o)=>(1+e*Math.exp(t/Math.max(Math.cos(a),1e-4)))*(1+n*Math.exp(r*o)+i*Math.cos(o)**2),Te=(e,t,n)=>{let r=[t*t*t,t*t,t,1],i=e=>n[e*4]*r[0]+n[e*4+1]*r[1]+n[e*4+2]*r[2]+n[e*4+3]*r[3];return e*e*i(0)+e*i(1)+i(2)},Ee=[.00166,-.00375,.00209,0,-.02903,.06377,-.03202,.00394,.11693,-.21196,.06052,.25886],De=[.00275,-.0061,.00317,0,-.04214,.0897,-.04153,.00516,.15346,-.26756,.0667,.26688];function Oe(e,t,n,r=!1){let i=Math.max(2,e),a=Math.acos(Math.min(1,Math.max(0,t[1]))),o=Math.hypot(t[0],t[2]),s=t[1]>=0?t:o>0?[t[0]/o,0,t[2]/o]:[0,1,0],[c,l,u]=we(i),d=(4/9-i/120)*(Math.PI-2*a),f=(4.0453*i-4.971)*Math.tan(d)-.2155*i+2.4192,p=Te(i,a,Ee),m=Te(i,a,De),h=B(c,0,a),g=B(l,0,a),_=B(u,0,a),v=new Float32Array(z*512*3);for(let e=0;e<512;e++){let t=Math.PI*(e+.5)/512;if(t>=Math.PI/2)break;let r=Math.sin(t),i=Math.cos(t);for(let a=0;a<z;a++){let o=((a+.5)/z-.5)*2*Math.PI,d=[r*Math.sin(o),i,-r*Math.cos(o)],y=Math.acos(Math.min(1,Math.max(-1,d[0]*s[0]+d[1]*s[1]+d[2]*s[2]))),b=f*B(c,t,y)/h,x=p*B(l,t,y)/g,S=Math.max(-3*x*x+2.87*x-.275,m*B(u,t,y)/_);if(!(b>0&&S>0))continue;let C=x*b/S,w=(1-x-S)*b/S,T=(e*z+a)*3;v[T]=Math.max(0,3.2406*C-1.5372*b-.4986*w)*n,v[T+1]=Math.max(0,-.9689*C+1.8758*b+.0415*w)*n,v[T+2]=Math.max(0,.0557*C-.204*b+1.057*w)*n}}if(r){let e=z*3,t=255*e;for(let n=256;n<512;n++)v.copyWithin(n*e,t,786432)}return v}var ke=.5876,Ae=.4861,je=.6563;function Me(e,t){return t>0?(e-1)/(t*(1/(Ae*Ae)-1/(je*je))):0}var Ne=[[[.362,442,.0624,.0374],[1.056,599.8,.0264,.0323],[-.065,501.1,.049,.0382]],[[.821,568.8,.0213,.0247],[.286,530.9,.0613,.0322]],[[1.217,437,.0845,.0278],[.681,459,.0385,.0725]]],Pe=e=>Ne.map(t=>t.reduce((t,[n,r,i,a])=>{let o=(e-r)*(e<r?i:a);return t+n*Math.exp(-.5*o*o)},0)),Fe=e=>e.map(([e,t,n,r])=>`${e}*cmfLobe(l,${U(t)},${n},${r})`).join(`+`),V=[3.2406,-1.5372,-.4986,-.9689,1.8758,.0415,.0557,-.204,1.057],Ie=e=>{let[t,n,r]=Pe(e);return[0,1,2].map(e=>V[e*3]*t+V[e*3+1]*n+V[e*3+2]*r)},Le=(()=>{let e=[0,0,0],t=.05;for(let n=380.025;n<780;n+=t){let r=Ie(n);for(let n=0;n<3;n++)e[n]+=r[n]*t}return e})(),Re=.25,H=550,U=e=>Number.isInteger(e)?`${e}.0`:`${e}`,ze=`
const LAMBDA_MIN=${U(380)};
const LAMBDA_MAX=${U(780)};
const LAMBDA_D=${ke};
fn cmfLobe(x:f32,mu:f32,k1:f32,k2:f32)->f32 {let t=(x-mu)*select(k2,k1,x<mu);return exp(-0.5*t*t);}
fn spectralRgb(l:f32)->vec3f {
 let x=${Fe(Ne[0])};
 let y=${Fe(Ne[1])};
 let z=${Fe(Ne[2])};
 let rgb=vec3f(${V[0]}*x+${V[1]}*y+${V[2]}*z,${V[3]}*x+${V[4]}*y+${V[5]}*z,${V[6]}*x+${V[7]}*y+${V[8]}*z);
 return rgb/vec3f(${Le.map(e=>e.toPrecision(9)).join(`,`)});
}
fn lambdaPdf(l:f32)->f32 {
 let ta=tanh((LAMBDA_MIN-${U(H)})/${U(56)});let tb=tanh((LAMBDA_MAX-${U(H)})/${U(56)});
 let t=tanh((l-${U(H)})/${U(56)});
 return ${Re}/(LAMBDA_MAX-LAMBDA_MIN)+0.75*(1.0-t*t)/(${U(56)}*(tb-ta));
}
// A wavelength for uniform numbers u (choice, position) and its density.
fn sampleLambda(u:vec2f)->vec2f {
 var l:f32;
 if(u.x<${Re}){l=mix(LAMBDA_MIN,LAMBDA_MAX,u.y);}
 else{
  let ta=tanh((LAMBDA_MIN-${U(H)})/${U(56)});let tb=tanh((LAMBDA_MAX-${U(H)})/${U(56)});
  l=clamp(${U(H)}+${U(56)}*atanh(clamp(mix(ta,tb,u.y),-0.999999,0.999999)),LAMBDA_MIN,LAMBDA_MAX);
 }
 return vec2f(l,lambdaPdf(l));
}
`,W=8,Be=2147483648,Ve=1073741824,He=65535,Ue=256,We=4096,Ge=2048,Ke=4096,qe=1024,Je=2048,Ye=8,Xe=2,Ze=16,Qe=.001,$e=.1,et=[`diffuse`,`plastic`,`metal`,`glass`,`emit`,`blend`,`media`],G=`VoxelPathTracer`,K=e=>typeof e==`object`&&!!e;function q(e,t,n,r,i){if(typeof e!=`number`||Number.isNaN(e))throw TypeError(`${G} ${t} must be a number; ${i}`);if(!(e>=n&&e<=r))throw RangeError(`${G} ${t} ${e} is outside ${n} to ${r}; ${i}`);return e}var J=(e,t,n,r,i,a)=>e===void 0?t:q(e,n,r,i,a);function Y(e,t,n,r){if(!Array.isArray(e)&&!ArrayBuffer.isView(e))throw TypeError(`${G} ${t} must be an array of 3 numbers; ${r}`);let i=e;if(i.length!==3||![0,1,2].every(e=>typeof i[e]==`number`))throw TypeError(`${G} ${t} must be an array of 3 numbers; ${r}`);let a=[i[0],i[1],i[2]];if(!a.every(Number.isFinite)||n&&a.some(e=>e<0))throw RangeError(`${G} ${t} [${a}] must be finite${n?` and 0 or more`:``}; ${r}`);return a}var tt=(e,t)=>{if(typeof e!=`string`||!e)throw TypeError(`${G} ${t} must be a non-empty string id`);return e},nt=(e,t)=>{if(!Array.isArray(e))throw TypeError(`${G} scene.${t} must be an array`);return e};function rt(e,t){if(!Array.isArray(e)&&!ArrayBuffer.isView(e)||e.length!==16)throw TypeError(`${G} ${t} must be 16 numbers (a column-major 4x4 matrix)`);let n=e;for(let e=0;e<16;e++)if(typeof n[e]!=`number`)throw TypeError(`${G} ${t} must be 16 numbers (a column-major 4x4 matrix)`);let r=n;for(let e=0;e<16;e++)if(!Number.isFinite(r[e]))throw RangeError(`${G} ${t}[${e}] ${r[e]} is not finite; pass finite numbers`);if(Math.abs(r[3])>1e-9||Math.abs(r[7])>1e-9||Math.abs(r[11])>1e-9||Math.abs(r[15]-1)>1e-9)throw RangeError(`${G} ${t} is not affine (its last row must be 0, 0, 0, 1); pass a model-to-world transform`);let i=new Float64Array(12);for(let e=0;e<3;e++)for(let t=0;t<4;t++)i[e*4+t]=r[t*4+e];let a=it(i),o=Math.max(...[0,1,2].map(e=>Math.hypot(i[e],i[4+e],i[8+e])));if(!(Math.abs(a)>1e-12*o*o*o)||!Number.isFinite(a))throw RangeError(`${G} ${t} is singular (determinant ${a}); pass an invertible transform`);return i}var it=e=>e[0]*(e[5]*e[10]-e[6]*e[9])-e[1]*(e[4]*e[10]-e[6]*e[8])+e[2]*(e[4]*e[9]-e[5]*e[8]);function at(e){let t=it(e),n=new Float64Array(12),r=[e[0],e[1],e[2]],i=[e[4],e[5],e[6]],a=[e[8],e[9],e[10]],o=(e,t)=>[e[1]*t[2]-e[2]*t[1],e[2]*t[0]-e[0]*t[2],e[0]*t[1]-e[1]*t[0]],s=o(i,a),c=o(a,r),l=o(r,i);for(let e=0;e<3;e++)n[e*4]=s[e]/t,n[e*4+1]=c[e]/t,n[e*4+2]=l[e]/t;for(let t=0;t<3;t++)n[t*4+3]=-(n[t*4]*e[3]+n[t*4+1]*e[7]+n[t*4+2]*e[11]);return n}function ot(e,t){return e.blocks===void 0?e.voxels instanceof Uint8Array&&e.voxels.length===t[0]*t[1]*t[2]:Array.isArray(e.blocks)&&e.voxels===void 0}function st(e,t,n){let r=Y(e.size,`${t}.size`,!0,`pass integer dimensions 1 to ${Ge}`);if(!r.every(e=>Number.isInteger(e)&&e>=1&&e<=Ge))throw RangeError(`${G} ${t}.size [${r}] must be integers 1 to ${Ge}; pass the model's voxel dimensions`);if(typeof e.revision!=`number`||!Number.isFinite(e.revision))throw TypeError(`${G} ${t}.revision must be a finite number; bump it when the voxels change`);let[i,a,o]=r,s=Math.ceil(i/W),c=Math.ceil(a/W),l=Math.ceil(o/W);if(s*c*l+4>n)throw RangeError(`${G} ${t} of ${i}x${a}x${o} needs a ${s*c*l*4}-byte brick grid; this device binds at most ${n*4}; split it into smaller models`);if(e.blocks!==void 0){if(e.voxels!==void 0)throw TypeError(`${G} ${t} has both voxels and blocks; pass one of them`);if(!Array.isArray(e.blocks))throw TypeError(`${G} ${t}.blocks must be an array of {origin, size, voxels}`);return ut(e,t,[i,a,o])}let u=e.voxels;if(!(u instanceof Uint8Array))throw TypeError(`${G} ${t}.voxels must be a Uint8Array of palette indices (or pass blocks)`);if(u.length!==i*a*o)throw TypeError(`${G} ${t}.voxels has ${u.length} entries; a ${i}x${a}x${o} model needs ${i*a*o} (index = x + sx * (z + sz * y))`);let d=lt(e.shapes,u.length,t),f=new Uint32Array(s*c*l),p=new Uint32Array(256),m=new Uint8Array(512),h=new Uint8Array(512),g=new Uint32Array(128*Math.min(f.length,64)),_=0;for(let e=0;e<c;e++)for(let t=0;t<l;t++)for(let n=0;n<s;n++){let r=n*W,c=e*W,v=t*W,y=Math.min(W,i-r),b=Math.min(W,a-c),x=Math.min(W,o-v),S=y<W||b<W||x<W;S&&(m.fill(0),h.fill(0));let C=-1,w=!S,T=!1;for(let e=0;e<b;e++)for(let t=0;t<x;t++){let n=r+i*(v+t+o*(c+e)),a=8*(t+8*e);for(let e=0;e<y;e++){let t=u[n+e],r=t&&d?d[n+e]%255:0;m[a+e]=t,h[a+e]=r,r&&(T=!0),p[t]++,C<0?C=t:t!==C&&(w=!1)}}T&&(w=!1);let E=n+s*(t+l*e);if(S&&C===0){let e=!0;for(let t=0;t<m.length&&e;t++)e=m[t]===0;if(e)continue}w?f[E]=C===0?0:(Be|C)>>>0:(g=ct(g,_+(T?2:1),f.length*2),new Uint8Array(g.buffer,_*128*4,512).set(m),f[E]=T?(Ve|++_)>>>0:++_,T&&new Uint8Array(g.buffer,_++*128*4,512).set(h))}return p[0]=0,{id:e.id,revision:e.revision,key:e.contentKey,size:[i,a,o],bricks:[s,c,l],grid:f,payload:g.slice(0,_*128),counts:p}}function ct(e,t,n){if(t*128<=e.length)return e;let r=new Uint32Array(Math.min(n,Math.max(t,e.length/128*2+1))*128);return r.set(e),r}function lt(e,t,n){if(e!==void 0){if(!(e instanceof Uint8Array))throw TypeError(`${G} ${n}.shapes must be a Uint8Array of octant masks (0 for whole cells)`);if(e.length!==t)throw TypeError(`${G} ${n}.shapes has ${e.length} entries; it needs one per cell (${t})`);return e}}function ut(e,t,n){let[r,i,a]=n,o=Math.ceil(r/W),s=Math.ceil(i/W),c=Math.ceil(a/W),l=new Map,u=new Map;for(let[s,d]of e.blocks.entries()){let e=`${t}.blocks[${s}]`;if(!K(d))throw TypeError(`${G} ${e} must be {origin, size, voxels}`);let f=Y(d.origin,`${e}.origin`,!0,`pass integer cell coordinates inside the model`),p=Y(d.size,`${e}.size`,!0,`pass integer dimensions of 1 or more`);if(!f.every(Number.isInteger)||!p.every(e=>Number.isInteger(e)&&e>=1))throw RangeError(`${G} ${e} origin and size must be whole numbers (size 1 or more)`);if(f.some((e,t)=>e+p[t]>n[t]))throw RangeError(`${G} ${e} spans [${f}] to [${f.map((e,t)=>e+p[t])}], outside the ${r}x${i}x${a} model; move or crop it`);let m=d.voxels;if(!(m instanceof Uint8Array))throw TypeError(`${G} ${e}.voxels must be a Uint8Array of palette indices`);if(m.length!==p[0]*p[1]*p[2])throw TypeError(`${G} ${e}.voxels has ${m.length} entries; a ${p[0]}x${p[1]}x${p[2]} block needs ${p[0]*p[1]*p[2]} (index = x + sx * (z + sz * y))`);let h=lt(d.shapes,m.length,e);for(let e=0;e<p[1];e++)for(let t=0;t<p[2];t++){let n=f[1]+e,r=f[2]+t,i=p[0]*(t+p[2]*e);for(let e=0;e<p[0];e++){let t=f[0]+e,a=(t>>3)+o*((r>>3)+c*(n>>3)),s=l.get(a);s||l.set(a,s=new Uint8Array(512));let d=(t&7)+8*((r&7)+8*(n&7)),p=h&&m[i+e]?h[i+e]%255:0;s[d]=m[i+e];let g=u.get(a);p&&!g&&u.set(a,g=new Uint8Array(512)),g&&(g[d]=p)}}}let d=new Uint32Array(o*s*c),f=new Uint32Array(256),p=[...l.keys()].sort((e,t)=>e-t),m=new Uint32Array(128*Math.min(p.length,64)),h=0;for(let e of p){let t=l.get(e),n=e%o,s=Math.floor(e/o)%c,g=Math.floor(e/(o*c)),_=n*8+8>r||g*8+8>i||s*8+8>a,v=u.get(e)?.some(Boolean)?u.get(e):void 0,y=t[0],b=!_&&!v;for(let e=0;e<t.length;e++)f[t[e]]++,t[e]!==y&&(b=!1);b?d[e]=y===0?0:(Be|y)>>>0:t.every(e=>e===0)||(m=ct(m,h+(v?2:1),p.length*2),new Uint8Array(m.buffer,h*128*4,512).set(t),d[e]=v?(1073741824|++h)>>>0:++h,v&&new Uint8Array(m.buffer,h++*128*4,512).set(v))}return f[0]=0,{id:e.id,revision:e.revision,key:e.contentKey,size:[r,i,a],bricks:[o,s,c],grid:d,payload:m.slice(0,h*128),counts:f}}function dt(e,t,n,r){if(t<0||n<0||r<0||t>=e.size[0]||n>=e.size[1]||r>=e.size[2])return 0;let[i,,a]=e.bricks,o=e.grid[(t>>3)+i*((r>>3)+a*(n>>3))];if(o===0)return 0;if(o>=2147483648)return o&255;let s=(t&7)+8*((r&7)+8*(n&7));return e.payload[((o&-1073741825)-1)*128+(s>>2)]>>>(s&3)*8&255}function ft(e,t,n,r){if(t<0||n<0||r<0||t>=e.size[0]||n>=e.size[1]||r>=e.size[2])return 0;let i=e.grid[(t>>3)+e.bricks[0]*((r>>3)+e.bricks[2]*(n>>3))];if(i>=2147483648||!(i&1073741824))return 0;let a=(t&7)+8*((r&7)+8*(n&7));return e.payload[(i&-1073741825)*128+(a>>2)]>>>(a&3)*8&255}var pt=(e,t,n)=>.2126*e+.7152*t+.0722*n;function mt(e){if(e===void 0)return[];let t=nt(e,`textures`);if(t.length>We)throw RangeError(`${G} scene.textures has ${t.length}; at most ${We} are supported`);return t.map((e,t)=>{let n=`scene.textures[${t}]`;if(!K(e))throw TypeError(`${G} ${n} must be an object {width, height, data}`);for(let t of[`width`,`height`]){if(typeof e[t]!=`number`||!Number.isInteger(e[t]))throw TypeError(`${G} ${n}.${t} must be an integer number of texels`);if(e[t]<1||e[t]>1024)throw RangeError(`${G} ${n}.${t} ${e[t]} is outside 1 to 1024; use a size from 1 to 1024`)}if(!(e.data instanceof Uint8Array||e.data instanceof Uint8ClampedArray))throw TypeError(`${G} ${n}.data must be a Uint8Array of RGBA bytes`);if(e.data.length!==e.width*e.height*4)throw TypeError(`${G} ${n}.data has ${e.data.length} bytes; pass width x height x 4 = ${e.width*e.height*4}`);let r=new Uint32Array(e.width*e.height);for(let t=0;t<r.length;t++)r[t]=(e.data[4*t]|e.data[4*t+1]<<8|e.data[4*t+2]<<16|e.data[4*t+3]<<24)>>>0;return{width:e.width,height:e.height,texels:r}})}function ht(e,t,n){if(!K(e))throw TypeError(`${G} ${t} must be an object {id, color, type}`);if(typeof e.id!=`number`||!Number.isInteger(e.id))throw TypeError(`${G} ${t}.id must be an integer palette index 1 to 255`);if(e.id<1||e.id>255)throw RangeError(`${G} ${t}.id ${e.id} is outside 1 to 255 (0 is empty); use an id from 1 to 255`);if(!et.includes(e.type))throw TypeError(`${G} ${t}.type ${String(e.type)} is unknown; pass one of ${et.join(`, `)}`);let r=Y(e.color,`${t}.color`,!0,`pass linear RGB, 0 or more`),i=e.emissionColor===void 0?r:Y(e.emissionColor,`${t}.emissionColor`,!0,`pass linear RGB, 0 or more`),a=e.type,o=(e,n,r)=>J(e,n,`${t}.${r}`,0,1,`pass 0 to 1`),s=o(e.roughness,a===`glass`?0:.2,`roughness`),c=o(e.metalness,+(a===`metal`),`metalness`),l=o(e.transmission,+(a===`glass`),`transmission`),u=o(e.specular,a===`diffuse`||a===`emit`?0:1,`specular`),d=J(e.emission,+(a===`emit`),`${t}.emission`,0,1e6,`pass 0 or more`),f=J(e.cameraEmission,d,`${t}.cameraEmission`,0,1e6,`pass 0 or more`),p=J(e.ior,1.5,`${t}.ior`,1,3,`pass 1 to 3 (glass is about 1.5)`),m=J(e.density,+(a===`media`),`${t}.density`,0,1e6,`pass 0 or more per world unit`),h=J(e.scatter,0,`${t}.scatter`,0,1e6,`pass 0 or more per world unit`),g=J(e.anisotropy,0,`${t}.anisotropy`,-.95,.95,`pass -0.95 to 0.95`),_=J(e.abbe,0,`${t}.abbe`,0,200,`pass 0 (no dispersion) or an Abbe number of 5 to 200`),v=J(e.cutout,0,`${t}.cutout`,0,1,`pass an alpha threshold 0 to 1 (0: none)`),y=e.metalColor===void 0?r:Y(e.metalColor,`${t}.metalColor`,!0,`pass linear RGB, each 0 to 1`);if(e.coat!==void 0&&e.coat!==`layered`&&e.coat!==`additive`)throw TypeError(`${G} ${t}.coat ${String(e.coat)} is unknown; pass 'layered' or 'additive'`);let b=(e,n)=>{if(e!==void 0&&typeof e!=`boolean`)throw TypeError(`${G} ${t}.${n} must be true or false`);return e===!0},x=e.tint===void 0||b(e.tint,`tint`),S=b(e.voxelwise,`voxelwise`),C=b(e.sunlit,`sunlit`),w=b(e.subsurface,`subsurface`),T=b(e.contactTransmission,`contactTransmission`),E=e.texture===void 0?void 0:typeof e.texture==`number`?[,,,,,,].fill(e.texture):e.texture;if(E!==void 0){if(!Array.isArray(E)||E.length!==6||!E.every(e=>typeof e==`number`&&Number.isInteger(e)))throw TypeError(`${G} ${t}.texture must be a texture index or six (+x, -x, +y, -y, +z, -z) into scene.textures`);for(let e of E)if(e<0||n!==void 0&&e>=n)throw RangeError(`${G} ${t}.texture ${e} is not an index into scene.textures; use an index below the texture count${n===void 0?``:` (${n})`}`)}if(_>0&&_<5)throw RangeError(`${G} ${t}.abbe ${_} is out of range; pass 0 (no dispersion) or 5 to 200`);return{id:e.id,color:r,type:a,roughness:s,metalness:c,emission:d,emissionColor:i,cameraEmission:f,sunlit:C,subsurface:w,voxelwise:S,contactTransmission:T,...E===void 0?{}:{texture:E},cutout:v,ior:p,transmission:l,density:m,specular:u,scatter:h,anisotropy:g,abbe:_,metalColor:y,coat:e.coat??`layered`,tint:x}}function gt(e,t,n,r){let i=ht(e,t,r),{type:a,color:o,emissionColor:s,roughness:c,metalness:l,transmission:u,specular:d,emission:f,ior:p,density:m,scatter:h,anisotropy:g,abbe:_,cutout:v,metalColor:y}=i,b=e.cameraEmission===void 0?-1:i.cameraEmission,x=i.texture,S=i.id*32,C=c*c,w=a===`media`,T=w?0:l,E=w?0:(1-l)*u,D=Ze;w&&(D|=1),E>0&&(D|=Xe),!w&&f>0&&pt(s[0],s[1],s[2])*f>0&&(D|=4),C<.001&&(D|=8),i.coat===`additive`&&(D|=32),i.tint||(D|=64),i.sunlit&&w&&!i.subsurface&&(D|=128),i.subsurface&&w&&(D|=Je);let O=i.subsurface&&w?_t(o):y;i.voxelwise&&E>0&&E<1&&(D|=256),i.contactTransmission&&E>0&&E<1&&(D|=512),v>0&&x!==void 0&&!w&&(D|=qe),n.set([Math.min(o[0],1),Math.min(o[1],1),Math.min(o[2],1),C,T,E,w?0:d,((p-1)/(p+1))**2,s[0]*f,s[1]*f,s[2]*f,p,m,h,g,D,E>0?Me(p,_):0,Math.min(O[0],1),Math.min(O[1],1),Math.min(O[2],1),b>=0&&!w?s[0]*b:0,b>=0&&!w?s[1]*b:0,b>=0&&!w?s[2]*b:0,+(b>=0&&!w),...(x??[,,,,,,].fill(-1)).map(e=>e+1),v,0],S)}function _t(e){let t=e=>{let t=Math.min(Math.max(e,0),1);return 1-Math.exp(t*(-5.09406+t*(2.61188-4.31805*t)))};return[t(e[0]),t(e[1]),t(e[2])]}function vt(e,t,n){let r=``,i=``;for(let n=1;n<256;n++){let a=t[n*32+15];e.counts[n]&&a&4&&(r+=`${n},`),a&3&&(i+=`${n},`)}if(!r)return;let a=`${r}|${i}`,o=n.emitters.get(e);if(o?.key===a)return o;let s=new Uint8Array(256),c=new Uint8Array(256);s[0]=1;for(let e=1;e<256;e++){let n=t[e*32+15];n&3&&(s[e]=1),n&4&&(c[e]=1)}let l=[],u=[],[d,f,p]=e.size,[m,h,g]=e.bricks,_=[[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];for(let t=0;t<h;t++)for(let n=0;n<g;n++)for(let r=0;r<m;r++){let i=e.grid[r+m*(n+g*t)];if(!(!i||i>=2147483648&&!c[i&255]))for(let i=t*8;i<Math.min(t*8+8,f);i++)for(let t=n*8;t<Math.min(n*8+8,p);t++)for(let n=r*8;n<Math.min(r*8+8,d);n++){let r=dt(e,n,i,t);if(!c[r])continue;let a=ft(e,n,i,t)||255;for(let o=0;o<6;o++){let c=_[o],d=n+c[0],f=i+c[1],p=t+c[2];if(a===255&&s[dt(e,d,f,p)]){l.push((n|i<<16)>>>0,(t|o<<16)>>>0),u.push(r);continue}let m=o>>1,h=1<<m,g=o&1?0:h,v=h^g,y=1<<(m+1)%3,b=1<<(m+2)%3,x=s[dt(e,d,f,p)]?0:ft(e,d,f,p)||255;for(let e=0;e<4;e++){let s=(e&1?y:0)|(e&2?b:0),c=(t|o<<16|1<<19|(e&3)<<21)>>>0;if(a>>(s|g)&1){if(x>>(s|v)&1)continue;l.push((n|i<<16)>>>0,c)}else if(a>>(s|v)&1)l.push((n|i<<16)>>>0,(c|1<<20)>>>0);else continue;u.push(r)}}}}let v={key:a,faces:Uint32Array.from(l),ids:Uint8Array.from(u)};return n.emitters.set(e,v),v}function yt(e){let t=t=>[e[t],e[4+t],e[8+t]],n=(e,t)=>Math.hypot(e[1]*t[2]-e[2]*t[1],e[2]*t[0]-e[0]*t[2],e[0]*t[1]-e[1]*t[0]),r=t(0),i=t(1),a=t(2);return[n(i,a),n(a,r),n(r,i)]}function bt(e,t,n){for(let r=0;r<8;r++){let i=[r&1?n[0]:0,r&2?n[1]:0,r&4?n[2]:0];for(let n=0;n<3;n++){let r=t[n*4]*i[0]+t[n*4+1]*i[1]+t[n*4+2]*i[2]+t[n*4+3];e[n]=Math.min(e[n],r),e[n+3]=Math.max(e[n+3],r)}}}function xt(e,t){let n=new Int32Array(t).map((e,t)=>t),r=[],i=new Float32Array(1),a=new Uint32Array(i.buffer),o=e=>(i[0]=e,a[0]);if(!t)return{nodes:new Uint32Array,order:n};let s=(t,n)=>(e[t*6+n]+e[t*6+n+3])/2,c=e=>{let t=e[3]-e[0],n=e[4]-e[1],r=e[5]-e[2];return t>0||n>0||r>0?2*(t*n+n*r+r*t):0},l=()=>[1/0,1/0,1/0,-1/0,-1/0,-1/0],u=(t,n)=>{for(let r=0;r<3;r++)t[r]=Math.min(t[r],e[n*6+r]),t[r+3]=Math.max(t[r+3],e[n*6+r+3])},d=[[0,0,t,0]];for(r.push(0,0,0,0,0,0,0,0);d.length;){let[e,t,i,a]=d.pop(),f=l();for(let e=t;e<i;e++)u(f,n[e]);let p=(t,n)=>{let i=e*8;r[i]=o(f[0]),r[i+1]=o(f[1]),r[i+2]=o(f[2]),r[i+3]=t,r[i+4]=o(f[3]),r[i+5]=o(f[4]),r[i+6]=o(f[5]),r[i+7]=n},m=i-t;if(m<=2){p(t,m);continue}let h=l();for(let e=t;e<i;e++)for(let t=0;t<3;t++){let r=s(n[e],t);h[t]=Math.min(h[t],r),h[t+3]=Math.max(h[t+3],r)}let g=0;for(let e=1;e<3;e++)h[e+3]-h[e]>h[g+3]-h[g]&&(g=e);let _=t+(m>>1),v=h[g+3]-h[g],y=()=>{let e=Array.from(n.subarray(t,i)).sort((e,t)=>s(e,g)-s(t,g));n.set(e,t)};if(v>0&&a<12){let e=1/0,r=-1,a=-1;for(let o=0;o<3;o++){let d=h[o],f=h[o+3]-d;if(!(f>0))continue;let p=Array.from({length:12},()=>({box:l(),n:0}));for(let e=t;e<i;e++){let t=Math.min(11,Math.floor((s(n[e],o)-d)/f*12));p[t].n++,u(p[t].box,n[e])}for(let t=1;t<12;t++){let n=l(),i=l(),s=0,u=0;for(let e=0;e<t;e++)if(p[e].n){s+=p[e].n;for(let t=0;t<3;t++)n[t]=Math.min(n[t],p[e].box[t]),n[t+3]=Math.max(n[t+3],p[e].box[t+3])}for(let e=t;e<12;e++)if(p[e].n){u+=p[e].n;for(let t=0;t<3;t++)i[t]=Math.min(i[t],p[e].box[t]),i[t+3]=Math.max(i[t+3],p[e].box[t+3])}if(!s||!u)continue;let d=s*c(n)+u*c(i);d<e&&(e=d,r=o,a=t)}}if(r>=0){g=r;let e=h[g],o=e+(h[g+3]-e)*a/12;for(y(),_=t;_<i&&s(n[_],g)<o;)_++;(_===t||_===i)&&(_=t+(m>>1))}else y()}else y();let b=r.length/8;r.push(0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0),p(b,0),d.push([b+1,_,i,a+1],[b,t,_,a+1])}return{nodes:Uint32Array.from(r),order:n}}function St(e,t){let n=`scene.environment.map`;if(!K(e))throw TypeError(`${G} ${n} must be {width, height, data}`);let r=q(e.width,`${n}.width`,1,8192,`pass the image width in texels`),i=q(e.height,`${n}.height`,1,4096,`pass the image height in texels`);if(!Number.isInteger(r)||!Number.isInteger(i))throw RangeError(`${G} ${n} size ${r}x${i} must be whole texels`);let a=e.data;if(!(a instanceof Float32Array))throw TypeError(`${G} ${n}.data must be a Float32Array of linear RGB(A)`);let o=a.length===r*i*3?3:a.length===r*i*4?4:0;if(!o)throw TypeError(`${G} ${n}.data has ${a.length} floats; pass width * height * 3 (RGB) or * 4 (RGBA)`);let s=J(e.intensity,1,`${n}.intensity`,0,1e6,`pass 0 or more`),c=J(e.rotation,0,`${n}.rotation`,-1e6,1e6,`pass radians`),l=t.environment;if(l&&l.width===r&&l.height===i){let e=l.source.length===a.length;for(let t=0;e&&t<a.length;t++)e=Object.is(l.source[t],a[t]);if(e)return{...l,intensity:s,rotation:c}}let u=new Float32Array(r*i*4),d=new Float32Array(i),f=new Float32Array(r*i),p=0;for(let e=0;e<i;e++){let t=Math.sin(Math.PI*(e+.5)/i),s=0;for(let i=0;i<r;i++){let c=e*r+i,l=a[c*o],d=a[c*o+1],p=a[c*o+2];if(!(l>=0&&d>=0&&p>=0&&l<1/0&&d<1/0&&p<1/0))throw RangeError(`${G} ${n}.data texel ${i},${e} is negative or not finite; pass linear radiance`);let m=pt(l,d,p)*t;u.set([l,d,p,m],c*4),s+=m,f[c]=s}for(let t=0;t<r;t++)f[e*r+t]=s>0?f[e*r+t]/s:(t+1)/r;p+=s,d[e]=p}for(let e=0;e<i;e++)d[e]=p>0?d[e]/p:(e+1)/i;return{source:a.slice(),width:r,height:i,intensity:s,rotation:c,texels:u,marginal:d,conditional:f,integral:p/(r*i)}}function Ct(e,t){let n=`scene.environment`;if(e!==void 0&&!K(e))throw TypeError(`${G} ${n} must be an object`);let r=e??{},i=(e,t)=>e===void 0?[1,1,1]:Y(e,`${n}.${t}`,!0,`pass linear RGB`),a=i(r.skyColor,`skyColor`),o=J(r.skyIntensity,1,`${n}.skyIntensity`,0,1e6,`pass 0 or more`),s=r.sunDirection===void 0?[.4,.8,.3]:Y(r.sunDirection,`${n}.sunDirection`,!1,`pass a direction toward the sun`),c=Math.hypot(...s);if(!(c>1e-12))throw RangeError(`${G} ${n}.sunDirection is zero; pass a direction toward the sun`);let l=i(r.sunColor,`sunColor`),u=J(r.sunIntensity,0,`${n}.sunIntensity`,0,1e6,`pass 0 (no sun) or more`),d=J(r.sunAngularSize,.0093,`${n}.sunAngularSize`,0,.5,`pass 0 to 0.5 radians`),f=r.groundColor===void 0?void 0:Y(r.groundColor,`${n}.groundColor`,!0,`pass linear RGB`),p=J(r.groundHeight,0,`${n}.groundHeight`,-1e9,1e9,`pass a finite height`),m=J(r.groundFade,0,`${n}.groundFade`,0,0xe8d4a51000,`pass 0 (no fade) or a distance`),h=J(r.groundFadeStart,0,`${n}.groundFadeStart`,0,0xe8d4a51000,`pass a distance`),g=r.background===void 0?void 0:Y(r.background,`${n}.background`,!0,`pass linear RGB, 0 or more, or leave it out`),_;if(r.fog!==void 0){if(!K(r.fog))throw TypeError(`${G} ${n}.fog must be {density, color?, anisotropy?}`);let e=J(r.fog.density,0,`${n}.fog.density`,0,1e6,`pass an extinction per unit above 0`),t=r.fog.color===void 0?[1,1,1]:Y(r.fog.color,`${n}.fog.color`,!0,`pass linear RGB 0 to 1`),i=J(r.fog.anisotropy,0,`${n}.fog.anisotropy`,-.95,.95,`pass -0.95 to 0.95`);e>0&&(_={density:e,color:[Math.min(t[0],1),Math.min(t[1],1),Math.min(t[2],1)],anisotropy:i,hemisphere:wt(i)})}if(r.sunVisible!==void 0&&typeof r.sunVisible!=`boolean`)throw TypeError(`${G} ${n}.sunVisible must be true or false`);if(r.fadeModels!==void 0&&typeof r.fadeModels!=`boolean`)throw TypeError(`${G} ${n}.fadeModels must be true or false`);let v=[s[0]/c,s[1]/c,s[2]/c],y=r.map===void 0?void 0:St(r.map,t),b;if(r.physicalSky!==void 0){if(r.map!==void 0)throw TypeError(`${G} ${n} has both map and physicalSky; pass one of them`);let e=r.physicalSky;if(!K(e))throw TypeError(`${G} ${n}.physicalSky must be {turbidity?, intensity?, horizonBelow?}`);if(e.horizonBelow!==void 0&&typeof e.horizonBelow!=`boolean`)throw TypeError(`${G} ${n}.physicalSky.horizonBelow must be true or false`);let i=J(e.turbidity,3,`${n}.physicalSky.turbidity`,1.7,10,`pass 1.7 (clear) to 10 (hazy)`),a=J(e.intensity,.1,`${n}.physicalSky.intensity`,0,1e6,`pass 0 or more`),o=e.horizonBelow===!0,s=`${i},${a},${v.join(`,`)},${o}`;b=t.sky?.key===s?t.sky:{key:s,data:Oe(i,v,a,o)},y=St({width:z,height:512,data:b.data},t)}return{sky:[a[0]*o,a[1]*o,a[2]*o],sunDirection:v,sun:[l[0]*u,l[1]*u,l[2]*u],sunAngularSize:d,ground:f&&[Math.min(f[0],1),Math.min(f[1],1),Math.min(f[2],1)],groundHeight:p,sunVisible:r.sunVisible!==!1,groundFade:m,groundFadeStart:h,fadeModels:r.fadeModels===!0,background:g,fog:_,map:y,skyCache:b}}function wt(e){let t=new Float32Array(16);for(let n=0;n<16;n++){let r=-1+2*n/15,i=[Math.sqrt(Math.max(0,1-r*r)),r,0],a=0;for(let t=0;t<48;t++){let n=(t+.5)/48,r=Math.sqrt(1-n*n);for(let t=0;t<96;t++){let o=(t+.5)/96*2*Math.PI,s=i[0]*r*Math.cos(o)+i[1]*n,c=1+e*e-2*e*s;a+=(1-e*e)/(4*Math.PI*c*Math.sqrt(c))}}t[n]=a*2*Math.PI/4608}return t}function Tt(e){if(e===void 0)return{lights:new Float32Array,count:0,power:0};let t=nt(e,`lights`);if(t.length>Ue)throw RangeError(`${G} scene.lights has ${t.length} lights; at most ${Ue} are supported`);let n=[],r=[];for(let[e,i]of t.entries()){let t=`scene.lights[${e}]`;if(!K(i))throw TypeError(`${G} ${t} must be {position, direction, width, height}`);let a=Y(i.position,`${t}.position`,!1,`pass a world point`),o=Y(i.direction,`${t}.direction`,!1,`pass the side the light faces`),s=q(i.width,`${t}.width`,0,1e9,`pass a size above 0`),c=q(i.height,`${t}.height`,0,1e9,`pass a size above 0`),l=i.up===void 0?void 0:Y(i.up,`${t}.up`,!1,`pass an up hint`),u=i.color===void 0?[1,1,1]:Y(i.color,`${t}.color`,!0,`pass linear RGB`),d=J(i.intensity,1,`${t}.intensity`,0,1e6,`pass 0 or more`);if(!(s>0&&c>0&&Math.hypot(o[0],o[1],o[2])>0))throw RangeError(`${G} ${t} has no area; pass width and height above 0 and a nonzero direction`);if(i.twoSided!==void 0&&typeof i.twoSided!=`boolean`)throw TypeError(`${G} ${t}.twoSided must be true or false`);if(i.visible!==void 0&&typeof i.visible!=`boolean`)throw TypeError(`${G} ${t}.visible must be true or false`);if(i.opaque!==void 0&&typeof i.opaque!=`boolean`)throw TypeError(`${G} ${t}.opaque must be true or false`);let{right:f,up:p}=Ce(o,l,`${G} ${t}`),m=f.map(e=>e*s),h=p.map(e=>e*c),g=a.map((e,t)=>e-m[t]/2-h[t]/2),_=i.opaque!==!1,v=s*c;if(i.visible===!1)continue;let y=[u[0]*d,u[1]*d,u[2]*d],b=pt(y[0],y[1],y[2])*v*(i.twoSided?2:1);(b>0||_)&&(r.push(b>0?b:0),n.push(g[0],g[1],g[2],0,m[0],m[1],m[2],+!!i.twoSided,h[0],h[1],h[2],v,...y),n.push(+!!_))}let i=r.reduce((e,t)=>e+t,0),a=0;for(let e=0;e<r.length;e++)a+=r[e],n[e*16+3]=e===r.length-1||!(i>0)?1:a/i;return{lights:Float32Array.from(n),count:r.length,power:i}}function Et(e){let t=t=>{let n=Math.hypot(e[t*4],e[t*4+1],e[t*4+2]);return[e[t*4]/n,e[t*4+1]/n,e[t*4+2]/n]},[n,r,i]=[t(0),t(1),t(2)],a=(e,t)=>Math.abs(e[0]*t[0]+e[1]*t[1]+e[2]*t[2]);return a(n,r)<1e-6&&a(r,i)<1e-6&&a(n,i)<1e-6}function Dt(e,t,n){let r=t.map((e,t)=>{let r=n[t],i=0;for(let t=1;t<256;t++){if(!e.counts[t])continue;let n=t*32,a=r[n+15];if(a&Xe){if(!(a&8)||r[n+5]<.999||r[n+16]>0||i)return 0;i=r[n+11]}}return i}),i=t.map((e,t)=>{let r=n[t];for(let t=1;t<256;t++){let n=t*32;if(e.counts[t]&&r[n+15]&8&&r[n+4]===1)return!0}return!1}),a=[],o=0,s=0;for(let[t,n]of e.entries()){let e=r[n.model];e&&!n.previous&&Et(n.toLocal)&&o<Ye&&(n.prism=!0,o++,a.push(t,e)),i[n.model]&&s<Ye&&(n.mirror=!0,s++,a.push(t,0))}return Float32Array.from(a)}function Ot(e,t,n){let r=new Float32Array(8192);for(let[i,a]of e.entries()){let e=`${t}[${i}]`;if(!K(a))throw TypeError(`${G} ${e} must be an object {id, color, type}`);if(typeof a.id!=`number`||!Number.isInteger(a.id))throw TypeError(`${G} ${e}.id must be an integer palette index 1 to 255`);if(a.id<1||a.id>255)throw RangeError(`${G} ${e}.id ${a.id} is outside 1 to 255 (0 is empty); use an id from 1 to 255`);if(r[a.id*32+15])throw TypeError(`${G} ${e}.id ${a.id} is used twice; give each palette index one material`);gt(a,e,r,n)}return r}function kt(e,t){let n=new Uint32Array(e.buffer,e.byteOffset,e.length),r=new Uint32Array(t.buffer,t.byteOffset,t.length);for(let e=0;e<n.length;e++)if(n[e]!==r[e])return!1;return!0}function At(e){let t=new Uint32Array(e.buffer,e.byteOffset,e.length),n=2166136261;for(let e=0;e<t.length;e++)n=Math.imul(n^t[e],16777619);return n>>>0}function jt(e,t,n,r=0){if(!K(e))throw TypeError(`${G} scene must be {revision, models, instances, materials}`);if(typeof e.revision!=`number`||!Number.isFinite(e.revision))throw TypeError(`${G} scene.revision must be a finite number`);let i=nt(e.models,`models`),a=nt(e.instances,`instances`),o=nt(e.materials,`materials`);if(a.length>He)throw RangeError(`${G} scene.instances has ${a.length}; at most ${He} are supported`);let s=mt(e.textures),c=[Ot(o,`scene.materials`,s.length)],l=new Map,u=new Map,d=[],f=[],p=new Map,m=new Map,h=new Map,g=0;for(let[e,r]of i.entries()){let i=`scene.models[${e}]`;if(!K(r))throw TypeError(`${G} ${i} must be {id, revision, size, voxels}`);let a=tt(r.id,`${i}.id`);if(p.has(a))throw TypeError(`${G} ${i}.id '${a}' is used twice; give every model its own id`);if(r.materials===void 0)d.push(0);else{let e=r.materials;if(!Array.isArray(e))throw TypeError(`${G} ${i}.materials must be an array of materials`);let t=u.get(e);if(t===void 0){let n=Ot(e,`${i}.materials`,s.length),r=At(n),a=l.get(r)?.find(e=>kt(c[e],n));if(a!==void 0)t=a;else{if(t=c.length,t>=Ke)throw RangeError(`${G} scene needs more than ${Ke} material tables; share tables between models`);c.push(n),l.set(r,[...l.get(r)??[],t])}u.set(e,t)}d.push(t)}let o=r.contentKey;if(o===null)throw TypeError(`${G} ${i}.contentKey is null; pass a key of the voxel contents, or leave it out`);let _=o===void 0?t.models.get(a)?.key===void 0?t.models.get(a):void 0:h.get(o)??t.keys?.get(o),v=r.size,y;_&&(o!==void 0||_.revision===r.revision)&&v?.length===3&&_.size.every((e,t)=>e===v[t])&&ot(r,_.size)?y=_:(y=st(r,i,n),g++),p.set(a,f.length),f.push(y),m.set(a,y),o!==void 0&&h.set(o,y)}let _=[],v=new Set,y=!1,b;for(let[e,t]of a.entries()){let n=`scene.instances[${e}]`;if(!K(t))throw TypeError(`${G} ${n} must be {id, modelId, matrix}`);let r=tt(t.id,`${n}.id`);if(v.has(r))throw TypeError(`${G} ${n}.id '${r}' is used twice; give every instance its own id`);v.add(r);let i=tt(t.modelId,`${n}.modelId`),a=p.get(i);if(a===void 0)throw TypeError(`${G} ${n}.modelId '${i}' names no model of this scene; add the model or fix the id`);let o=rt(t.matrix,`${n}.matrix`),s=t.previousMatrix===void 0?void 0:rt(t.previousMatrix,`${n}.previousMatrix`),c=t.motionInterpolation===void 0?`matrix`:t.motionInterpolation;if(c!==`matrix`&&c!==`trs`)throw TypeError(`${G} ${n}.motionInterpolation must be 'matrix' or 'trs'`);if(t.visible!==void 0&&typeof t.visible!=`boolean`)throw TypeError(`${G} ${n}.visible must be true or false`);if(t.visible===!1)continue;let l=new Float64Array([1/0,1/0,1/0,-1/0,-1/0,-1/0]),u=f[a].size,d;if(s)try{d=Se(s,o,u,c,n)}catch(e){b??=e}d?(l.set(d.bounds),y=!0):bt(l,o,u),_.push({id:r,source:e,model:a,toWorld:o,toLocal:at(o),previous:d&&s,motion:d?.payload,box:l,lightPick:0,prism:!1,mirror:!1})}let x=e=>c[d[e]];for(let[e,t]of p){let n=f[t],r=x(t),i=d[t]?`model '${e}'.materials has`:`scene.materials has`;for(let t=1;t<256;t++)if(n.counts[t]&&!r[t*32+15])throw TypeError(`${G} model '${e}' uses palette index ${t} (${n.counts[t]} voxels) but ${i} no material with id ${t}; add one`)}let S=Ct(e.environment,t),{lights:C,count:w,power:T}=Tt(e.lights),E=4;for(let e of new Set(f))E+=e.grid.length+e.payload.length;if(E>n)throw RangeError(`${G} scene needs ${E*4} bytes of voxel bricks; this device binds at most ${n*4}; use fewer or smaller models`);if(c.length*256*32>n)throw RangeError(`${G} scene's ${c.length} material tables need ${c.length*256*32*4} bytes; this device binds at most ${n*4}; share tables between models`);let D=new Float64Array(_.length*6);for(let[e,t]of _.entries())D.set(t.box,e*6);let{nodes:O,order:k}=xt(D,_.length),A=Array.from(k,e=>_[e]),j=f.map((e,n)=>{let r=x(n),i=vt(e,r,t);if(!i)return{faces:new Uint32Array,cdf:new Float32Array,total:0};let a=new Float32Array(i.ids.length),o=0;for(let e=0;e<i.ids.length;e++){let t=i.ids[e]*32+8;o+=pt(r[t],r[t+1],r[t+2])*(i.faces[e*2+1]>>>19&1?.25:1),a[e]=o}for(let e=0;e<a.length;e++)a[e]=e===a.length-1?1:a[e]/o;return{faces:i.faces,cdf:a,total:o}}),ee=[],M=[];for(let[e,t]of A.entries()){let n=j[t.model].total;if(!(n>0))continue;let[r,i,a]=yt(t.toWorld);ee.push(e),M.push(n*(r+i+a)/3)}let N=M.reduce((e,t)=>e+t,0),P=new Float32Array(M.length),F=0;for(let e=0;e<M.length;e++)F+=M[e],P[e]=e===M.length-1?1:F/N,A[ee[e]].lightPick=M[e]/N;return Pt({models:f,instances:A,nodes:O,textures:s,environment:S,emitters:j,emissiveInstances:{length:ee.length},lightCount:w,voxelWords:E,materials:{length:c.length*256*32}},n,r),t.models=m,t.keys=h,S.map&&(t.environment=S.map),S.skyCache&&(t.sky=S.skyCache),{revision:e.revision,models:f,modelIds:[...p.keys()],modelIndex:p,packedModels:g,reusedModels:f.length-g,instances:A,nodes:O,materials:Mt(c),modelTables:Uint32Array.from(d),environment:S,lights:C,lightCount:w,lightPower:T,emitters:j,emissiveInstances:Uint32Array.from(ee),emissiveCdf:P,moving:y,motionError:b,deflectors:Dt(A,f,f.map((e,t)=>x(t))),clearGlass:f.some((e,t)=>e.counts.some((e,n)=>{let r=n*32,i=x(t);return n>0&&e>0&&(i[r+15]&Xe)!==0&&!!(i[r+15]&8)&&i[r+5]>=.999&&i[r+16]===0})),focusing:f.some((e,t)=>e.counts.some((e,n)=>{let r=n*32,i=x(t);return n>0&&e>0&&(i[r+5]>0||i[r+3]<.1&&(i[r+4]>0||i[r+6]*i[r+7]>0))})),voxelWords:E,textures:s}}function Mt(e){if(e.length===1)return e[0];let t=new Float32Array(e.length*256*32);for(let[n,r]of e.entries())t.set(r,n*256*32);return t}function Nt(e){return 4+e.models.length*12+e.instances.reduce((e,t)=>e+40+(t.motion?16:0),0)+e.nodes.length+e.textures.reduce((e,t)=>e+4+t.texels.length,0)}function Pt(e,t,n=0){if(e.voxelWords>t)throw RangeError(`${G} scene needs ${e.voxelWords*4} bytes of voxel bricks; this device binds at most ${t*4}; use fewer or smaller models`);if(e.materials.length>t)throw RangeError(`${G} scene's material tables need ${e.materials.length*4} bytes; this device binds at most ${t*4}; share tables between models`);let r=e.environment.map,i=e.emitters.reduce((e,t)=>e+t.cdf.length,0),a=Nt(e)+n+4+32+e.emissiveInstances.length*2+i*3+e.lightCount*16+(r?r.height+r.width*r.height:0);if(r&&r.width*r.height*4>t)throw RangeError(`${G} scene.environment.map ${r.width}x${r.height} needs ${r.width*r.height*16} bytes; this device binds at most ${t*4}; pass a smaller map`);if(a>t)throw RangeError(`${G} scene's records, textures and light tables (${i} emissive voxel faces) need ${a*4} bytes and this device binds at most ${t*4}; use fewer emissive voxels, instances or textures`)}var Ft=1024,It=2048,Lt=4096,Rt=8192,zt=16384,Bt=new Float32Array(1),Vt=new Uint32Array(Bt.buffer),Ht=e=>(Bt[0]=e,Vt[0]);function Ut(e,t){let n=new Uint32Array(e.grid.length+e.payload.length),r=t+e.grid.length;for(let t=0;t<e.grid.length;t++){let i=e.grid[t];n[t]=i===0||i>=2147483648?i:r+((i&~Ve)-1)*128|i&Ve}return n.set(e.payload,e.grid.length),n}function Wt(e){let t=e.environment.map,n=Nt(e),r=n+4,i=r;r+=e.deflectors.length;let a=r;r+=e.emissiveInstances.length*2;let o=e.emitters.map(e=>{let t=r;return r+=e.cdf.length*3,{first:t,count:e.cdf.length,total:e.total}}),s=r;r+=e.lightCount*16;let c=r;r+=t?t.height:0;let l=r;r+=t?t.width*t.height:0;let u=new Uint32Array(r),d=new Float32Array(u.buffer);u[1]=n,u[n]=i,u[n+1]=e.deflectors.length/2;for(let t=0;t<e.deflectors.length;t+=2)u[i+t]=e.deflectors[t],d[i+t+1]=e.deflectors[t+1];for(let t=0;t<e.emissiveInstances.length;t++)u[a+t*2]=e.emissiveInstances[t],d[a+t*2+1]=e.emissiveCdf[t];for(let[t,n]of e.emitters.entries())for(let e=0;e<n.cdf.length;e++)u[o[t].first+e*3]=n.faces[e*2],u[o[t].first+e*3+1]=n.faces[e*2+1],d[o[t].first+e*3+2]=n.cdf[e];return d.set(e.lights,s),t&&(d.set(t.marginal,c),d.set(t.conditional,l)),{words:u,emissiveBase:a,areaBase:s,marginalBase:c,conditionalBase:l,emitters:o}}function Gt(e,t,n){let r=4+e.models.length*12,i=r+e.instances.length*40,a=e.nodes.length/8,o=i+e.nodes.length,s=o+e.instances.reduce((e,t)=>e+(t.motion?16:0),0),c=n.words,l=new Float32Array(c.buffer),u=o;c[0]=e.textures.length?s:0;let d=s+4*e.textures.length;for(let[t,n]of e.textures.entries())c.set([d,n.width,n.height,0],s+4*t),c.set(n.texels,d),d+=n.texels.length;for(let[r,i]of e.models.entries()){let a=4+r*12,o=n.emitters[r];c.set([i.size[0],i.size[1],i.size[2],t[r],i.bricks[0],i.bricks[1],i.bricks[2],e.modelTables[r]<<8],a),c[a+8]=o.first,c[a+9]=o.count,c[a+10]=Ht(o.total)}for(let[t,n]of e.instances.entries()){let e=r+t*40;l.set(n.toLocal,e),l.set(n.toWorld,e+12),l.set(n.previous??n.toWorld,e+24),c[e+36]=n.model,c[e+37]=+!!n.previous|(n.prism?2:0)|(n.mirror?4:0)|(n.motion?8:0),l[e+38]=n.lightPick,n.motion&&(c[e+39]=u,l.set(n.motion,u),u+=16)}return c.set(e.nodes,i),{words:c,modelBase:4,instanceBase:r,nodeBase:i,nodeCount:a}}var Kt=1<<20,qt=e=>e*4+16+(e+1)*16,Jt=Kt*qt(8);function Yt(e,t=Jt){return Math.max(1,Math.min(Kt,Math.floor(t/qt(e))))}var Xt=class{constructor(){this.budget=Jt/16}observe(e,t){if(!(e>0)||!(t>0))return;let n=e/t*50;this.budget=Math.max(Jt/4096,Math.min(Jt,this.budget*2,n))}};function Zt(e,t,n,r,i=1,a=Kt,o=a){let s=Math.min(t,i),c=Math.max(1,Math.min(r,Math.floor(a/(s*e)))),l=Math.min(t,Math.max(s,Math.floor(Math.min(o,a)/(e*c)/i)*i)),u=[];for(let e=0;e<r;e+=c)for(let i=0;i<t;i+=l)u.push({y0:i,rows:Math.min(l,t-i),s0:n+e,count:Math.min(c,r-e)});return u}function Qt(e,t){let n=e*16,r=t;for(;r;)[n,r]=[r,n%r];return t/n}var $t=`fn pbrNeutral(input:vec3f)->vec3f {let x=min(input.r,min(input.g,input.b));let offset=select(0.04,x-6.25*x*x,x<0.08);var v=input-offset;let peak=max(v.r,max(v.g,v.b));if(peak<0.76){return v;}let newPeak=1.0-0.24*0.24/(peak+0.24-0.76);v*=newPeak/peak;return mix(v,vec3f(newPeak),1.0-1.0/(0.15*(peak-newPeak)+1.0));}
fn toDisplay(c:vec3f)->vec3f {let x=pbrNeutral(max(c,vec3f(0)));return select(x*12.92,1.055*pow(x,vec3f(1.0/2.4))-0.055,x>=vec3f(0.0031308));}
`,X=Object.freeze({twoOverPi:[0,2734261102,1313084713,4230436817,4113882560,3680671129,1011060801,4266746795],halfPiFixed:3373259426,halfPi:[1.5707963705062866,-4.371138828673793e-8],quarterPi:[.7853981852531433,-2.1855694143368964e-8],pi:[3.1415927410125732,-8.742277657347586e-8],ln2:[.693145751953125,1428606765330187e-21],ln2Pair:[.6931471824645996,-1.9046542121259336e-9],log2e:[1.4426950216293335,1.925963033500011e-8],sin:[-.1666666716337204,.008333379402756691,-.00019853089179378003,2833021881087916e-21],cos:[.0416666679084301,-.0013888980029150844,2482202216924634e-20,-2.8881245839329495e-7],atan:[-.3333333432674408,.20000059902668,-.14286741614341736,.11114691942930222,-.09025663882493973,.06947030127048492,-.03550770878791809],asin:[.1666666716337204,.07499949634075165,.044659871608018875,.03011295571923256,.024605773389339447,.007497195154428482,.03466988354921341],sinh:[.1666666716337204,.00833326205611229,.00019874409190379083,20846018742304295e-22,6.411173671949655e-7,-2.0997923400045693e-7],cosh:[.0416666679084301,.0013888796092942357,2482521813362837e-20,2.506288865333772e-7,1.1460320692435744e-8],tanh:[-.3333333432674408,.1333339512348175,-.05398104339838028,.021990614011883736,-.009435489773750305,.004868379328399897,-.0023415694013237953],expm1:[.5,.1666666567325592,.04166649281978607,.008333546109497547,.0013932319125160575,.00019761594012379646],log:[.6666666269302368,.40000975131988525,.28498485684394836,.24286234378814697]}),Z=e=>{let t=String(e);for(let n=1;n<=9;n++){let r=e.toPrecision(n);if(Math.fround(Number(r))===e){t=r;break}}return/[.e]/.test(t)?t:`${t}.0`},Q=(e,t)=>{let n=Z(t[t.length-1]);for(let r=t.length-2;r>=0;r--)n=`(${e} * ${n} + ${Z(t[r])})`;return n},en=e=>`0x${e.toString(16)}u`,tn,nn=()=>tn??={pmBits:[[],`fn pmExponent(x: f32) -> u32 { return (bitcast<u32>(x) >> 23u) & 0xffu; }
fn pmNegative(x: f32) -> bool { return (bitcast<u32>(x) >> 31u) == 1u; }
fn pmIsNan(x: f32) -> bool { return (bitcast<u32>(x) & 0x7fffffffu) > 0x7f800000u; }
fn pmIsZero(x: f32) -> bool { return (bitcast<u32>(x) & 0x7fffffffu) == 0u; }
fn pmNan(x: f32) -> f32 { return bitcast<f32>(bitcast<u32>(x) | 0x7fc00000u); }
fn pmInfinity(negative: bool, x: f32) -> f32 { return bitcast<f32>((bitcast<u32>(x) & 0u) | select(0x7f800000u, 0xff800000u, negative)); }
fn pmWithSign(v: f32, x: f32) -> f32 { return select(v, -v, pmNegative(x)); }
fn pmSplit(v: f32) -> vec2f { let h = bitcast<f32>(bitcast<u32>(v) & 0xfffff000u); return vec2f(h, v - h); }
fn pmHide(v: f32) -> f32 {
 let b = bitcast<u32>(v);
 let e = (b >> 23u) & 0xffu;
 let m = i32((b & 0x7fffffu) | select(0x800000u, 0u, e == 0u));
 return ldexp(f32(select(m, -m, (b >> 31u) == 1u)), max(i32(e), 1) - 150);
}
fn pmFastTwoSum(a: f32, b: f32) -> vec2f { let s = a + b; return vec2f(s, pmHide(b - pmHide(pmHide(s) - a))); }
fn pmProductError(a: f32, b: f32, p: f32) -> f32 {
 let x = pmSplit(a); let y = pmSplit(b);
 return pmHide((((pmHide(x.x * y.x) - p) + pmHide(x.x * y.y)) + pmHide(x.y * y.x)) + pmHide(x.y * y.y));
}
const PM_PIO2_HI: f32 = ${Z(X.halfPi[0])};
const PM_PIO2_LO: f32 = ${Z(X.halfPi[1])};
const PM_PIO4_HI: f32 = ${Z(X.quarterPi[0])};
const PM_PIO4_LO: f32 = ${Z(X.quarterPi[1])};
const PM_PI_HI: f32 = ${Z(X.pi[0])};
const PM_PI_LO: f32 = ${Z(X.pi[1])};
const PM_LN2_HI: f32 = ${Z(X.ln2[0])};
const PM_LN2_LO: f32 = ${Z(X.ln2[1])};
const PM_LN2: f32 = ${Z(X.ln2Pair[0])};
const PM_LN2_TAIL: f32 = ${Z(X.ln2Pair[1])};
const PM_LOG2E: f32 = ${Z(X.log2e[0])};
const PM_LOG2E_LO: f32 = ${Z(X.log2e[1])};
`],preciseDiv:[[`pmBits`],`fn preciseDiv(a: f32, b: f32) -> f32 {
 let q = a / b;
 if (pmExponent(a) == 255u || pmExponent(b) == 255u || pmExponent(q) == 255u || pmExponent(q) == 0u) { return q; }
 let p = pmHide(q * b);
 let r = (a - p) - pmProductError(q, b, p);
 return q + pmHide(r / b);
}
`],preciseSqrt:[[`pmBits`],`fn pmSqrt2(a: f32) -> vec2f {
 let s = sqrt(a);
 if (a <= 0.0 || pmIsNan(a) || pmExponent(a) == 255u || pmExponent(s) == 0u) { return vec2f(s, 0.0); }
 let p = pmHide(s * s);
 let r = (a - p) - pmProductError(s, s, p);
 return pmFastTwoSum(s, r / (2.0 * s));
}
fn preciseSqrt(a: f32) -> f32 { return pmSqrt2(a).x; }
`],pmReduce:[[`pmBits`],`fn pmTwoOverPi(i: u32) -> u32 {
 switch i {
${X.twoOverPi.map((e,t)=>`    case ${t}u: { return ${en(e)}; }`).join(`
`)}
  default: { return 0u; }
 }
}
fn pmMul24x32(m: u32, v: u32) -> vec2u {
 let ml = m & 0xfffu; let mh = m >> 12u; let vl = v & 0xffffu; let vh = v >> 16u;
 let p0 = ml * vl; let p1 = ml * vh; let p2 = mh * vl; let p3 = mh * vh;
 var lo = p0;
 var hi = (p1 >> 16u) + (p2 >> 20u) + (p3 >> 4u);
 var t = lo + (p1 << 16u); hi = hi + select(0u, 1u, t < lo); lo = t;
 t = lo + (p2 << 12u); hi = hi + select(0u, 1u, t < lo); lo = t;
 t = lo + (p3 << 28u); hi = hi + select(0u, 1u, t < lo); lo = t;
 return vec2u(hi, lo);
}
fn pmMul32(a: u32, b: u32) -> vec2u {
 let al = a & 0xffffu; let ah = a >> 16u; let bl = b & 0xffffu; let bh = b >> 16u;
 let ll = al * bl; let lh = al * bh; let hl = ah * bl; let hh = ah * bh;
 let mid = (ll >> 16u) + (lh & 0xffffu) + (hl & 0xffffu);
 return vec2u(hh + (lh >> 16u) + (hl >> 16u) + (mid >> 16u), (ll & 0xffffu) | (mid << 16u));
}
struct PmReduced { hi: f32, lo: f32, q: u32 }
fn pmReduce(a: f32) -> PmReduced {
 let u = bitcast<u32>(a);
 let e = i32(u >> 23u) - 150;
 let m = (u & 0x7fffffu) | 0x800000u;
 let t = u32(e + 30);
 let w = t >> 5u; let s = t & 31u; let r = 32u - s;
 let A = pmTwoOverPi(w); let B = pmTwoOverPi(w + 1u); let C = pmTwoOverPi(w + 2u); let D = pmTwoOverPi(w + 3u);
 let v0 = select((A << s) | (B >> r), A, s == 0u);
 let v1 = select((B << s) | (C >> r), B, s == 0u);
 let v2 = select((C << s) | (D >> r), C, s == 0u);
 let P0 = pmMul24x32(m, v0); let P1 = pmMul24x32(m, v1); let P2 = pmMul24x32(m, v2);
 let p0 = P2.y;
 let p1 = P1.y + P2.x;
 let p2 = P0.y + P1.x + select(0u, 1u, p1 < P1.y);
 var q = p2 >> 30u;
 var hi = (p2 << 2u) | (p1 >> 30u);
 var lo = (p1 << 2u) | (p0 >> 30u);
 let neg = (hi >> 31u) == 1u;
 if (neg) { q = q + 1u; lo = ~lo + 1u; hi = ~hi + select(0u, 1u, lo == 0u); }
 let L = pmMul32(lo, ${X.halfPiFixed}u); let H = pmMul32(hi, ${X.halfPiFixed}u);
 let g1 = H.y + L.x;
 let g2 = H.x + select(0u, 1u, g1 < H.y);
 var n: u32; var top: u32; var low: u32;
 if (g2 != 0u) {
  n = countLeadingZeros(g2);
  top = select((g2 << n) | (g1 >> (32u - n)), g2, n == 0u);
  low = g1 << n;
 } else {
  let z = countLeadingZeros(g1);
  n = 32u + z;
  top = select(g1 << z, 0u, z == 32u);
  low = 0u;
 }
 let hi24 = top >> 8u;
 let next = ((top & 0xffu) << 16u) | (low >> 16u);
 let sign = select(1.0, -1.0, neg);
 return PmReduced(sign * ldexp(f32(hi24), -23 - i32(n)), sign * ldexp(f32(next), -47 - i32(n)), q & 3u);
}
`],pmTrig:[[`pmReduce`,`pmBits`],`fn pmSinK(h: f32, l: f32) -> f32 {
 let w = h * h;
 let p = ${Q(`w`,X.sin)};
 return h + pmHide(l * (1.0 - 0.5 * w) + (h * w) * p);
}
fn pmCosK(h: f32, l: f32) -> f32 {
 let w = pmHide(h * h); let hw = 0.5 * w; let t = pmFastTwoSum(1.0, -hw);
 let ew = pmProductError(h, h, w);
 let p = ${Q(`w`,X.cos)};
 return t.x + pmHide((t.y - 0.5 * ew) + ((w * w) * p - h * l));
}
fn pmReduceTrig(a: f32) -> PmReduced {
 if (a <= 0.78125) { return PmReduced(a, 0.0, 0u); }
 return pmReduce(a);
}
`],preciseSin:[[`pmTrig`],`fn preciseSin(x: f32) -> f32 {
 let a = abs(x);
 if (pmExponent(x) == 255u) { return pmNan(x); }
 if (a < 0.000244140625) { return x; }
 let r = pmReduceTrig(a);
 let s = pmSinK(r.hi, r.lo); let c = pmCosK(r.hi, r.lo);
 let v = select(select(select(-c, -s, r.q == 2u), c, r.q == 1u), s, r.q == 0u);
 return pmWithSign(v, x);
}
`],preciseCos:[[`pmTrig`],`fn preciseCos(x: f32) -> f32 {
 let a = abs(x);
 if (pmExponent(x) == 255u) { return pmNan(x); }
 if (a < 0.000244140625) { return 1.0; }
 let r = pmReduceTrig(a);
 let s = pmSinK(r.hi, r.lo); let c = pmCosK(r.hi, r.lo);
 return select(select(select(s, -c, r.q == 2u), -s, r.q == 1u), c, r.q == 0u);
}
`],preciseTan:[[`pmTrig`,`preciseDiv`],`fn preciseTan(x: f32) -> f32 {
 let a = abs(x);
 if (pmExponent(x) == 255u) { return pmNan(x); }
 if (a < 0.000244140625) { return x; }
 let r = pmReduceTrig(a);
 let s = pmSinK(r.hi, r.lo); let c = pmCosK(r.hi, r.lo);
 var v: f32;
 if ((r.q & 1u) == 0u) { v = preciseDiv(s, c); } else { v = -preciseDiv(c, s); }
 return pmWithSign(v, x);
}
`],pmAtanK:[[`pmBits`],`fn pmAtanK(u: f32) -> f32 {
 let w = u * u;
 let p = ${Q(`w`,X.atan)};
 return u + pmHide((u * w) * p);
}
`],preciseAtan:[[`pmAtanK`,`preciseDiv`],`fn preciseAtan(x: f32) -> f32 {
 let a = abs(x);
 if (pmIsNan(x)) { return x; }
 var r: f32;
 if (a <= 0.5) { r = pmAtanK(a); }
 else if (a <= 2.0) { r = PM_PIO4_HI + pmHide(pmAtanK(preciseDiv(a - 1.0, a + 1.0)) + PM_PIO4_LO); }
 else { r = PM_PIO2_HI + pmHide(PM_PIO2_LO - pmAtanK(preciseDiv(1.0, a))); }
 return pmWithSign(r, x);
}
`],preciseAtan2:[[`pmAtanK`,`preciseDiv`],`fn preciseAtan2(y: f32, x: f32) -> f32 {
 if (pmIsNan(x) || pmIsNan(y)) { return pmNan(x + y); }
 var ax = abs(x); var ay = abs(y);
 var t: f32;
 if (pmExponent(ax) == 255u && pmExponent(ay) == 255u) { t = PM_PIO4_HI; }
 else {
  if (ax > 4.253529586511731e37 || ay > 4.253529586511731e37) { ax = ax * 0.25; ay = ay * 0.25; }
  let big = max(ax, ay); let small = min(ax, ay);
  if (big == 0.0) { t = 0.0; }
  else if (small <= 0.5 * big) {
   let k = pmAtanK(preciseDiv(small, big));
   t = select(k, PM_PIO2_HI + pmHide(PM_PIO2_LO - k), ay > ax);
  } else { t = PM_PIO4_HI + pmHide(pmAtanK(preciseDiv(ay - ax, ay + ax)) + PM_PIO4_LO); }
 }
 if (pmNegative(x) && (!pmIsZero(x) || pmIsZero(y))) { t = PM_PI_HI + pmHide(PM_PI_LO - t); }
 return pmWithSign(t, y);
}
`],pmAsin:[[`preciseSqrt`,`pmBits`],`fn pmAsinK(x: f32) -> f32 {
 let w = x * x;
 let p = ${Q(`w`,X.asin)};
 return (x * w) * p;
}
fn pmAsinTail(a: f32) -> vec2f {
 let z = 0.5 * (1.0 - a);
 let s = pmSqrt2(z);
 return vec2f(2.0 * s.x, 2.0 * (s.y + pmAsinK(s.x)));
}
`],preciseAsin:[[`pmAsin`],`fn preciseAsin(x: f32) -> f32 {
 let a = abs(x);
 if (pmIsNan(x) || a > 1.0) { return pmNan(x); }
 if (a < 0.000244140625) { return x; }
 var r: f32;
 if (a < 0.5) { r = a + pmAsinK(a); }
 else { let t = pmAsinTail(a); r = PM_PIO2_HI - pmHide(t.x - pmHide(PM_PIO2_LO - t.y)); }
 return pmWithSign(r, x);
}
`],preciseAcos:[[`pmAsin`],`fn preciseAcos(x: f32) -> f32 {
 let a = abs(x);
 if (pmIsNan(x) || a > 1.0) { return pmNan(x); }
 if (a < 0.5) { return PM_PIO2_HI - pmHide(x - pmHide(PM_PIO2_LO - pmAsinK(x))); }
 let t = pmAsinTail(a);
 if (pmNegative(x)) { return PM_PI_HI - pmHide(t.x - pmHide(PM_PI_LO - t.y)); }
 return t.x + t.y;
}
`],pmExp:[[`pmBits`],`fn pmExpm1P(r: f32) -> f32 { return ${Q(`r`,X.expm1)}; }
fn pmExpm1K(r: f32) -> f32 { return r + pmHide((r * r) * pmExpm1P(r)); }
fn pmReduceLn2(x: f32) -> vec4f {
 let k = round(x * PM_LOG2E);
 let hi = pmHide(x - k * PM_LN2_HI);
 let lo = -k * PM_LN2_LO;
 return vec4f(k, hi + lo, hi, lo);
}
fn pmScale(v: f32, k: i32) -> f32 { let h = k / 2; return ldexp(pmHide(ldexp(v, k - h)), h); }
`],preciseExp:[[`pmExp`],`fn preciseExp(x: f32) -> f32 {
 if (pmIsNan(x)) { return x; }
 if (x > 88.72284) { return pmInfinity(false, x); }
 if (x < -103.97208) { return 0.0; }
 if (abs(x) < 2.9802322387695312e-8) { return 1.0 + x; }
 let k = pmReduceLn2(x);
 return pmScale(1.0 + pmHide(pmExpm1K(k.y)), i32(k.x));
}
`],preciseExp2:[[`pmExp`],`fn preciseExp2(x: f32) -> f32 {
 if (pmIsNan(x)) { return x; }
 if (x >= 128.0) { return pmInfinity(false, x); }
 if (x < -150.0) { return 0.0; }
 let k = round(x);
 return pmScale(1.0 + pmHide(pmExpm1K((x - k) * PM_LN2)), i32(k));
}
`],preciseExpm1:[[`preciseExp`],`fn preciseExpm1(x: f32) -> f32 {
 if (pmIsNan(x)) { return x; }
 if (x > 88.72284) { return pmInfinity(false, x); }
 let a = abs(x);
 if (a < 2.9802322387695312e-8) { return x; }
 if (a <= 0.3465735) { return pmExpm1K(x); }
 if (x < -17.0) { return preciseExp(x) - 1.0; }
 let k = pmReduceLn2(x);
 if (k.x > 24.0) { return preciseExp(x) - 1.0; }
 let T = (k.y * k.y) * pmExpm1P(k.y);
 let p = ldexp(1.0, i32(k.x));
 if (k.x > 0.0) { return pmHide((p - 1.0) + pmHide(p * k.z)) + pmHide(p * (k.w + T)); }
 return pmHide(p * (k.z + (k.w + T))) + (p - 1.0);
}
`],preciseSinh:[[`preciseExpm1`,`preciseDiv`],`fn preciseSinh(x: f32) -> f32 {
 let a = abs(x);
 if (pmIsNan(x)) { return x; }
 if (a < 0.000244140625) { return x; }
 var r: f32;
 if (a <= 1.0) { let w = a * a; r = a + pmHide((a * w) * ${Q(`w`,X.sinh)}); }
 else if (a > 88.72284) { let t = preciseExp(0.5 * a); r = pmHide(0.5 * t) * t; }
 else if (a > 9.0) { r = 0.5 * preciseExp(a); }
 else { let e = preciseExpm1(a); r = 0.5 * (e + preciseDiv(e, e + 1.0)); }
 return pmWithSign(r, x);
}
`],preciseCosh:[[`preciseExp`,`preciseDiv`],`fn preciseCosh(x: f32) -> f32 {
 let a = abs(x);
 if (pmIsNan(x)) { return x; }
 if (a < 0.000244140625) { return 1.0; }
 if (a <= 1.0) { let w = a * a; return 1.0 + pmHide((w * w) * ${Q(`w`,X.cosh)} + 0.5 * w); }
 if (a > 88.72284) { let t = preciseExp(0.5 * a); return pmHide(0.5 * t) * t; }
 let t = preciseExp(a);
 return 0.5 * (t + preciseDiv(1.0, t));
}
`],preciseTanh:[[`preciseExpm1`,`preciseDiv`],`fn preciseTanh(x: f32) -> f32 {
 let a = abs(x);
 if (pmIsNan(x)) { return x; }
 if (a < 0.000244140625) { return x; }
 if (a > 9.1) { return pmWithSign(1.0, x); }
 if (a <= 0.55) { let w = a * a; return pmWithSign(a + pmHide((a * w) * ${Q(`w`,X.tanh)}), x); }
 let e = preciseExpm1(2.0 * a);
 return pmWithSign(preciseDiv(e, e + 2.0), x);
}
`],pmLog:[[`preciseDiv`],`struct PmLogK { s: f32, R: f32, hfsq: f32, t: f32 }
fn pmLogK(f: f32) -> PmLogK {
 let s = preciseDiv(f, 2.0 + f);
 let z = s * s;
 let R = z * ${Q(`z`,X.log)};
 let hfsq = (0.5 * f) * f;
 return PmLogK(s, R, hfsq, s * (hfsq + R));
}
fn pmDecompose(x: f32) -> vec2f {
 var u = bitcast<u32>(x);
 var e = i32(u >> 23u) - 127;
 if (e == -127) { let z = countLeadingZeros(u) - 8u; u = u << z; e = -126 - i32(z); }
 var m = bitcast<f32>((u & 0x7fffffu) | 0x3f800000u);
 if (m > 1.4142135) { m = 0.5 * m; e = e + 1; }
 return vec2f(f32(e), m - 1.0);
}
fn pmLogSpecial(x: f32) -> u32 {
 if (pmIsNan(x) || (pmNegative(x) && !pmIsZero(x))) { return 1u; }
 if (pmIsZero(x)) { return 2u; }
 if (pmExponent(x) == 255u) { return 3u; }
 return 0u;
}
fn pmLogSpecialValue(kind: u32, x: f32) -> f32 {
 return select(select(x, pmInfinity(true, x), kind == 2u), pmNan(x), kind == 1u);
}
`],preciseLog:[[`pmLog`],`fn preciseLog(x: f32) -> f32 {
 let special = pmLogSpecial(x);
 if (special != 0u) { return pmLogSpecialValue(special, x); }
 let d = pmDecompose(x);
 let k = pmLogK(d.y);
 return d.x * PM_LN2_HI + pmHide(d.y - pmHide(k.hfsq - (k.t + d.x * PM_LN2_LO)));
}
`],preciseLog2:[[`pmLog`],`fn preciseLog2(x: f32) -> f32 {
 let special = pmLogSpecial(x);
 if (special != 0u) { return pmLogSpecialValue(special, x); }
 let d = pmDecompose(x);
 let k = pmLogK(d.y);
 let ah = pmHide(d.y * PM_LOG2E);
 let al = pmProductError(d.y, PM_LOG2E, ah);
 let tail = (al + d.y * PM_LOG2E_LO) - (k.hfsq - k.t) * PM_LOG2E;
 return pmHide(d.x + ah) + pmHide(tail);
}
`],preciseLog1p:[[`preciseLog`],`fn preciseLog1p(x: f32) -> f32 {
 if (pmIsNan(x) || x < -1.0) { return pmNan(x); }
 if (x == -1.0) { return pmInfinity(true, x); }
 if (pmExponent(x) == 255u) { return x; }
 let u = 1.0 + x;
 if (u == 1.0) { return x; }
 let c = select(pmFastTwoSum(x, 1.0).y, pmFastTwoSum(1.0, x).y, abs(x) <= 1.0);
 return preciseLog(u) + preciseDiv(c, u);
}
`],precisePow:[[`pmLog`,`pmExp`],`fn pmLog2Pair(x: f32) -> vec2f {
 let d = pmDecompose(x);
 let e = d.x; let f = d.y;
 let k = pmLogK(f);
 let q = pmHide(f * f);
 let hh = 0.5 * q;
 let hl = 0.5 * pmProductError(f, f, q);
 let d2 = pmFastTwoSum(2.0, f); let dh = d2.x; let dl = d2.y;
 let sd = pmHide(k.s * dh);
 let rho = pmHide(f - sd) - pmProductError(k.s, dh, sd);
 let sl = (rho - k.s * dl) / dh;
 let th = pmHide(k.s * hh);
 let z = pmHide(k.s * k.s);
 let zl = pmProductError(k.s, k.s, z) + (2.0 * k.s) * sl;
 let w = pmFastTwoSum(${Z(Math.fround(2/3))}, ${Z(Math.fround(2/3-Math.fround(2/3)))} + z * ${Q(`z`,[2/5,2/7,2/9,2/11,2/13,2/15].map(e=>Math.fround(e)))});
 let rh = pmHide(z * w.x);
 let rl = (pmProductError(z, w.x, rh) + z * w.y) + zl * w.x;
 let uh = pmHide(k.s * rh);
 let u = pmFastTwoSum(th, uh);
 let tl = (((pmProductError(k.s, hh, th) + k.s * hl) + sl * hh) + ((pmProductError(k.s, rh, uh) + k.s * rl) + sl * rh)) + u.y;
 let ah = pmHide(f * PM_LOG2E); let al = pmProductError(f, PM_LOG2E, ah);
 let bh = pmHide(hh * PM_LOG2E); let bl = pmProductError(hh, PM_LOG2E, bh);
 let ch = pmHide(u.x * PM_LOG2E); let cl = pmProductError(u.x, PM_LOG2E, ch);
 let s1 = pmFastTwoSum(e, ah); let s2 = pmFastTwoSum(s1.x, -bh); let s3 = pmFastTwoSum(s2.x, ch);
 let small = ((f - hh) + u.x) * PM_LOG2E_LO;
 let tail = (((s1.y + s2.y) + s3.y) + ((al - bl) + cl)) + ((tl - hl) * PM_LOG2E + small);
 return pmFastTwoSum(s3.x, tail);
}
fn pmIsOdd(y: f32) -> bool { return abs(y) < 16777216.0 && floor(y) == y && (i32(y) & 1) == 1; }
fn precisePow(x: f32, y: f32) -> f32 {
 if (pmIsNan(y)) { return y; }
 if (y == 0.0) { return 1.0; }
 if (pmIsNan(x)) { return x; }
 let ax = abs(x); let ay = abs(y);
 if (pmExponent(ay) == 255u) {
  if (ax == 1.0) { return pmNan(x); }
  return select(0.0, pmInfinity(false, x), (ax > 1.0) == (y > 0.0));
 }
 let negative = pmNegative(x) && pmIsOdd(y);
 if (pmExponent(ax) == 255u) { return select(select(0.0, -0.0, negative), pmInfinity(negative, x), y > 0.0); }
 if (pmIsZero(ax)) { return select(pmInfinity(negative, x), select(0.0, -0.0, negative), y > 0.0); }
 if (pmNegative(x) && floor(y) != y) { return pmNan(x); }
 let L = pmLog2Pair(ax);
 let ph = pmHide(y * L.x);
 let pl = pmProductError(y, L.x, ph) + y * L.y;
 if (ph > 128.0 || (ph == 128.0 && pl >= 0.0)) { return pmInfinity(negative, x); }
 if (ph < -151.0) { return select(0.0, -0.0, negative); }
 let k = round(ph);
 let f = (ph - k) + pl;
 let r = pmHide(f * PM_LN2);
 let rl = pmProductError(f, PM_LN2, r) + f * PM_LN2_TAIL;
 let v = pmScale(1.0 + pmHide(pmExpm1K(r) + rl), i32(k));
 return select(v, -v, negative);
}
`]},rn=Object.freeze([`preciseDiv`,`preciseSqrt`,`preciseSin`,`preciseCos`,`preciseTan`,`preciseAtan`,`preciseAtan2`,`preciseAsin`,`preciseAcos`,`preciseExp`,`preciseExp2`,`preciseExpm1`,`preciseSinh`,`preciseCosh`,`preciseTanh`,`preciseLog`,`preciseLog2`,`preciseLog1p`,`precisePow`]);function an(e){let t=[],n=new Set,r=e=>{if(n.has(e))return;let i=nn()[e];if(!i)throw RangeError(`Unknown precise maths function ${e}; use one of ${rn.join(`, `)}`);n.add(e);for(let e of i[0])r(e);t.push(i[1])};for(let t of e)r(t);return t.join(``)}var on=(e,t,n=`nh`,r=`a2`)=>`(max(dot(cross(${e},${t}),cross(${e},${t})),step(${n},0.0))+${r}*${n}*${n})`,sn=`
struct Frame {
 origins:array<vec4f,4>,
 eye:vec4f,
 forward:vec4f,
 right:vec4f,
 up:vec4f,
 image:vec4u,
 tile:vec4u,
 config:vec4u,
 scene:vec4u,
 lights:vec4u,
 env:vec4u,
 sky:vec4f,
 sun:vec4f,
 sunLight:vec4f,
 ground:vec4f,
 weights:vec4f,
 directions:array<vec4f,4>,
 // The camera at shutter open (camera motion blur): corner rays and lens frame as above.
 prevOrigins:array<vec4f,4>,
 prevDirections:array<vec4f,4>,
 prevEye:vec4f,
 prevForward:vec4f,
 prevRight:vec4f,
 prevUp:vec4f,
 // Projection mode (0 camera, 1 panorama, 2 fisheye), fisheye mapping (0 equidistant, 1 equisolid), distortion on.
 projection:vec4u,
 // Fisheye field of view (radians) and sin(fov / 4).
 lensFov:vec4f,
 // Brown-Conrady k1, k2, p1, p2.
 distortion:vec4f,
 // Scattering events allowed per path: diffuse, specular, scatter (0xffff: no cap); w: the ground fade's distance
 // scale (f32 bits; 0 none).
 limits:vec4u,
 // Uniform fog: extinction per unit, anisotropy, on (z > 0); colour; sky-glow share by view elevation (16 values).
 fog:vec4f,
 fogColor:vec4f,
 fogHemi:array<vec4f,4>,
 // Ground fade: x the camera distance where it starts, y 1 when it fades models too.
 groundFade:vec4f,
 // Background for camera rays leaving the scene (w > 0: on); edge bands (colour, width; width 0: off); grid lines
 // (colour, spacing; half width, mode 0 off, 1 ground, 2 ground and voxels).
 background:vec4f,
 edges:vec4f,
 grid:vec4f,
 grid2:vec4f,
}
`,$=e=>`${Math.round(e*2**32)%2**32}u`,cn=`
const PI=3.141592653589793;
const TAU=6.283185307179586;
const INV_PI=0.3183098861837907;
fn basis(n:vec3f)->mat3x3f {
 let s=select(-1.0,1.0,n.z>=0.0);let a=-1.0/(s+n.z);let b=n.x*n.y*a;
 return mat3x3f(vec3f(1.0+s*n.x*n.x*a,s*b,-s*n.x),vec3f(b,s+n.y*n.y*a,-n.y),n);
}
fn ggxD(a2:f32,n:vec3f,h:vec3f)->f32 {let nh=max(dot(n,h),0.0);let k=${on(`n`,`h`)};return a2/(PI*k*k);}
fn lambdaG(a2:f32,c:f32)->f32 {let c2=max(c*c,1e-8);return 0.5*(sqrt(1.0+a2*(1.0-c2)/c2)-1.0);}
fn fresnel(ci:f32,eta:f32)->f32 {
 let s2=eta*eta*max(0.0,1.0-ci*ci);
 if(s2>=1.0){return 1.0;}
 let ct=sqrt(1.0-s2);
 let rs=(eta*ci-ct)/(eta*ci+ct);let rp=(ci-eta*ct)/(ci+eta*ct);
 return 0.5*(rs*rs+rp*rp);
}
// A GGX microfacet normal sampled from the normals visible from wo (Heitz 2018), for uniform numbers u.
fn vndfU(wo:vec3f,alpha:f32,n:vec3f,u:vec2f)->vec3f {
 let tb=basis(n);let w=transpose(tb)*wo;
 let vh=normalize(vec3f(alpha*w.x,alpha*w.y,w.z));
 let l2=vh.x*vh.x+vh.y*vh.y;
 let t1=select(vec3f(1.0,0.0,0.0),vec3f(-vh.y,vh.x,0.0)*inverseSqrt(max(l2,1e-20)),l2>1e-12);
 let t2=cross(vh,t1);
 let r=sqrt(u.x);let p=TAU*u.y;
 let p1=r*cos(p);let s=0.5*(1.0+vh.z);let p2=(1.0-s)*sqrt(max(0.0,1.0-p1*p1))+s*r*sin(p);
 let m=p1*t1+p2*t2+sqrt(max(0.0,1.0-p1*p1-p2*p2))*vh;
 return tb*normalize(vec3f(alpha*m.x,alpha*m.y,max(1e-6,m.z)));
}
`,ln=2312,un=`${cn}
@group(0) @binding(0) var<storage,read_write> table:array<f32>;
const E_MU=32u;const E_R=32u;const G_MU=16u;const G_R=16u;const G_ETA=32u;
const E_AVG_BASE=1024u;const GLASS_BASE=1056u;const TABLE_SIZE=9248u;const SAMPLES=4096u;
fn seq(k:u32,a:u32)->f32 {return f32((k*a+0x80000000u)>>8u)*5.960464477539063e-8;}
fn muAt(i:u32,n:u32)->f32 {return max(f32(i)/f32(n-1u),0.002);}
fn roughAt(j:u32,n:u32)->f32 {return f32(j)/f32(n-1u);}
fn reflectWeight(mu:f32,alpha:f32,u:vec2f)->f32 {
 let a2=alpha*alpha;let n=vec3f(0.0,0.0,1.0);let wo=vec3f(sqrt(max(0.0,1.0-mu*mu)),0.0,mu);
 let lo=lambdaG(a2,mu);let wi=reflect(-wo,vndfU(wo,alpha,n,u));
 return select(0.0,(1.0+lo)/(1.0+lo+lambdaG(a2,wi.z)),wi.z>0.0);
}
fn albedoE(mu:f32,r:f32)->f32 {
 let alpha=max(r*r,1e-4);var sum=0.0;
 for(var k=0u;k<SAMPLES;k++){sum+=reflectWeight(mu,alpha,vec2f(seq(k,${$(.7548776662466927)}),seq(k,${$(.5698402909980532)})));}
 return sum/f32(SAMPLES);
}
fn averageE(r:f32)->f32 {
 let alpha=max(r*r,1e-4);var sum=0.0;let n=SAMPLES*16u;
 for(var k=0u;k<n;k++){
  let mu=max(sqrt(seq(k,${$(.8191725133961645)})),0.002);
  sum+=reflectWeight(mu,alpha,vec2f(seq(k,${$(.6710436067037893)}),seq(k,${$(.5497004779019703)})));
 }
 return sum/f32(n);
}
fn albedoGlass(mu:f32,r:f32,eta:f32)->f32 {
 let alpha=max(r*r,1e-4);let a2=alpha*alpha;let n=vec3f(0.0,0.0,1.0);let wo=vec3f(sqrt(max(0.0,1.0-mu*mu)),0.0,mu);
 let lo=lambdaG(a2,mu);var sum=0.0;
 for(var k=0u;k<SAMPLES;k++){
  let m=vndfU(wo,alpha,n,vec2f(seq(k,${$(.7548776662466927)}),seq(k,${$(.5698402909980532)})));
  let c=dot(wo,m);
  if(c<=0.0){continue;}
  let fr=fresnel(c,eta);
  let wr=reflect(-wo,m);
  if(wr.z>0.0){sum+=fr*(1.0+lo)/(1.0+lo+lambdaG(a2,wr.z));}
  if(fr<1.0){let wt=refract(-wo,m,eta);if(wt.z<0.0){sum+=(1.0-fr)*(1.0+lo)/(1.0+lo+lambdaG(a2,-wt.z));}}
 }
 return sum/f32(SAMPLES);
}
@compute @workgroup_size(64) fn tables(@builtin(global_invocation_id) g:vec3u) {
 let i=g.x;
 if(i<E_AVG_BASE){table[i]=albedoE(muAt(i%E_MU,E_MU),roughAt(i/E_MU,E_R));return;}
 if(i<GLASS_BASE){table[i]=averageE(roughAt(i-E_AVG_BASE,E_R));return;}
 if(i<TABLE_SIZE){
  let j=i-GLASS_BASE;
  let eta=exp((2.0*f32(j/(G_MU*G_R))/f32(G_ETA-1u)-1.0)*log(3.0));
  table[i]=albedoGlass(muAt(j%G_MU,G_MU),roughAt((j/G_MU)%G_R,G_R),eta);
 }
}
`,dn=`${sn}${cn}${ze}${an([`preciseSin`,`preciseCos`,`preciseAsin`,`preciseAtan`])}
const INF=3.0e38;
const NONE=0xffffffffu;
const GROUND=0xfffffffeu;
const AREA=0xfffffffdu;
const EPS=2e-3;
const MEDIA=1u;
const EMISSIVE=4u;
const SMOOTH=8u;
const DELTA=${Qe};
// GGX alpha below which a lobe is specular for caustics (scene.ts decides from it whether a scene has any).
const GLOSSY=${$e};
const SUN=1u;
const HAS_GROUND=2u;
const ENV=4u;
const MOTION=8u;
const JITTER=16u;
const CLAMP=32u;
const SPLIT=64u;
const AREA_NEE=128u;
const CAMERA_MOTION=256u;
const CLEAR_GLASS=512u;
const OPAQUE_SHADOWS=${Ft}u;
const SUN_DIFFUSE=${It}u;
const NO_SUN_MEDIA=${Lt}u;
const HIDE_SUN=${Rt}u;
const NO_COMPENSATION=${zt}u;
const ADDITIVE=32u;
const UNTINTED=64u;
const SUNLIT=128u;
const SUBSURFACE=${Je}u;
const WALK=256u;
const VOXELWISE=256u;
const CONTACT=512u;
const CUTOUT=${qe}u;
// march's want for a voxelwise volume: stop at the next voxel face whatever lies behind it.
const STEP=0xfffffffeu;
const MODEL=12u;
const INSTANCE=40u;
@group(0) @binding(0) var<uniform> f:Frame;
const MV=8u;
// Table 0 (scene.materials) in a uniform buffer: scenes without model tables read their materials there, faster than
// from storage (measured 5% of a frame of the material scene on an RTX A6000). Pipelines with TABLES (compiled when a
// scene has model tables) read every table from storage instead.
override TABLES:bool=false;
@group(0) @binding(1) var<uniform> table0:array<vec4f,2048>;
@group(0) @binding(2) var<storage,read> voxels:array<u32>;
// The scene records, then the lights (scene word 1 is where their header starts; every offset is absolute).
@group(0) @binding(3) var<storage,read> scene:array<u32>;
// Material tables, MV vec4f per entry, indexed by slot: the model's table << 8 | the palette index (0 stays empty).
@group(0) @binding(4) var<storage,read> materials:array<vec4f>;
// Vec4 i of the material tables (slot x MV + field): table 0 from the uniform copy.
fn mat(i:u32)->vec4f {if(TABLES){return materials[i];}return table0[i];}
@group(0) @binding(5) var<storage,read> envmap:array<vec4f>;
@group(0) @binding(6) var<storage,read_write> accum:array<vec4f>;
@group(0) @binding(7) var<storage,read_write> albedo:array<vec4f>;
@group(0) @binding(8) var<storage,read_write> normals:array<vec4f>;
@group(0) @binding(9) var<uniform> tables:array<vec4f,${ln}>;
@group(0) @binding(10) var<storage,read_write> caustics:array<vec4f>;
var<private> rng:u32;
var<private> motion:f32;
// Whether the path entered the medium it is in through a face toward the sun; and whether the shadow ray being cast
// passes only the cell it starts in (see extinction).
var<private> sunFace:bool;
var<private> sunCell:bool;

fn lum(c:vec3f)->f32 {return dot(c,vec3f(0.2126,0.7152,0.0722));}
fn hash(v:u32)->u32 {let s=v*747796405u+2891336453u;let w=((s>>((s>>28u)+4u))^s)*277803737u;return (w>>22u)^w;}
fn rand()->f32 {rng=rng*747796405u+2891336453u;let w=((rng>>((rng>>28u)+4u))^rng)*277803737u;return f32(((w>>22u)^w)>>8u)*5.960464477539063e-8;}
fn power2(a:f32,b:f32)->f32 {let a2=a*a;let b2=b*b;return select(1.0,a2/(a2+b2),a2+b2>0.0);}
fn fl(i:u32)->f32 {return bitcast<f32>(scene[i]);}
fn ll(i:u32)->f32 {return bitcast<f32>(scene[i]);}

// Affine transforms as three rows.
struct Xform {r0:vec4f,r1:vec4f,r2:vec4f}
fn rowAt(i:u32)->vec4f {return vec4f(fl(i),fl(i+1u),fl(i+2u),fl(i+3u));}
fn xpoint(m:Xform,p:vec3f)->vec3f {return vec3f(dot(m.r0.xyz,p)+m.r0.w,dot(m.r1.xyz,p)+m.r1.w,dot(m.r2.xyz,p)+m.r2.w);}
fn xdir(m:Xform,d:vec3f)->vec3f {return vec3f(dot(m.r0.xyz,d),dot(m.r1.xyz,d),dot(m.r2.xyz,d));}
fn rowOf(m:Xform,k:u32)->vec3f {return select(select(m.r2.xyz,m.r1.xyz,k==1u),m.r0.xyz,k==0u);}
fn colOf(m:Xform,k:u32)->vec3f {return vec3f(m.r0[k],m.r1[k],m.r2[k]);}
fn invertX(m:Xform)->Xform {
 // Normalize before the cross products so very large or small scales stay in Float32 range.
 let h=max(max(max(abs(m.r0.x),abs(m.r0.y)),max(abs(m.r0.z),abs(m.r1.x))),max(max(abs(m.r1.y),abs(m.r1.z)),max(max(abs(m.r2.x),abs(m.r2.y)),abs(m.r2.z))));
 let a=m.r0.xyz/h;let b=m.r1.xyz/h;let c=m.r2.xyz/h;
 let c0=cross(b,c);let c1=cross(c,a);let c2=cross(a,b);let k=(1.0/h)/dot(a,c0);
 let r0=vec3f(c0.x,c1.x,c2.x)*k;let r1=vec3f(c0.y,c1.y,c2.y)*k;let r2=vec3f(c0.z,c1.z,c2.z)*k;
 let t=vec3f(m.r0.w,m.r1.w,m.r2.w);
 return Xform(vec4f(r0,-dot(r0,t)),vec4f(r1,-dot(r1,t)),vec4f(r2,-dot(r2,t)));
}
// Canonical CPU quaternion convention: [x,y,z,w], shortest arc, normalized-linear only above dot 0.9995.
// Instance word 39 points at its 16-word TRS packet: q0, q1, scale0 + angle, scale1 + 1/sin(angle).
fn motionRotation(p:u32)->mat3x3f {
 let a=normalize(rowAt(p));let q=normalize(rowAt(p+4u));let angle=fl(p+11u);let inv=fl(p+15u);
 var v=a*(1.0-motion)+q*motion;
 if(inv>0.0){v=a*(sin((1.0-motion)*angle)*inv)+q*(sin(motion*angle)*inv);}
 v=normalize(v);let x=v.x;let y=v.y;let z=v.z;let w=v.w;
 return mat3x3f(vec3f(1.0-2.0*(y*y+z*z),2.0*(x*y+w*z),2.0*(x*z-w*y)),vec3f(2.0*(x*y-w*z),1.0-2.0*(x*x+z*z),2.0*(y*z+w*x)),vec3f(2.0*(x*z+w*y),2.0*(y*z-w*x),1.0-2.0*(x*x+y*y)));
}
fn motionScale(p:u32)->vec3f {return mix(vec3f(fl(p+8u),fl(p+9u),fl(p+10u)),vec3f(fl(p+12u),fl(p+13u),fl(p+14u)),motion);}
fn motionTranslation(b:u32)->vec3f {return mix(vec3f(fl(b+27u),fl(b+31u),fl(b+35u)),vec3f(fl(b+15u),fl(b+19u),fl(b+23u)),motion);}
// Instance transforms at this path's shutter time (motion 1 = matrix, 0 = previousMatrix).
fn blendX(b:u32)->Xform {
 let m=Xform(rowAt(b+12u),rowAt(b+16u),rowAt(b+20u));
 if((scene[b+37u]&1u)==0u||motion>=1.0){return m;}
 let q=Xform(rowAt(b+24u),rowAt(b+28u),rowAt(b+32u));
 if(motion<=0.0){return q;}
 return Xform(mix(q.r0,m.r0,motion),mix(q.r1,m.r1,motion),mix(q.r2,m.r2,motion));
}
fn worldX(i:u32)->Xform {
 let b=f.scene.y+i*INSTANCE;
 if((scene[b+37u]&9u)==9u&&motion>0.0&&motion<1.0){
  let p=scene[b+39u];let r=motionRotation(p);let s=motionScale(p);let t=motionTranslation(b);
  return Xform(vec4f(vec3f(r[0].x,r[1].x,r[2].x)*s,t.x),vec4f(vec3f(r[0].y,r[1].y,r[2].y)*s,t.y),vec4f(vec3f(r[0].z,r[1].z,r[2].z)*s,t.z));
 }
 return blendX(b);
}
fn localX(i:u32)->Xform {
 let b=f.scene.y+i*INSTANCE;
 if((scene[b+37u]&1u)==0u||motion>=1.0){return Xform(rowAt(b),rowAt(b+4u),rowAt(b+8u));}
 if((scene[b+37u]&8u)!=0u&&motion>0.0){
  let p=scene[b+39u];let r=motionRotation(p);let s=motionScale(p);let t=motionTranslation(b);
  let a=r[0]/s.x;let c=r[1]/s.y;let d=r[2]/s.z;
  return Xform(vec4f(a,-dot(a,t)),vec4f(c,-dot(c,t)),vec4f(d,-dot(d,t)));
 }
 return invertX(blendX(b));
}
struct InstX {world:Xform,local:Xform}
fn instX(i:u32)->InstX {
 let b=f.scene.y+i*INSTANCE;
 if((scene[b+37u]&9u)==9u&&motion>0.0&&motion<1.0){
  let p=scene[b+39u];let r=motionRotation(p);let s=motionScale(p);let t=motionTranslation(b);
  let a=r[0]/s.x;let c=r[1]/s.y;let d=r[2]/s.z;
  return InstX(Xform(vec4f(vec3f(r[0].x,r[1].x,r[2].x)*s,t.x),vec4f(vec3f(r[0].y,r[1].y,r[2].y)*s,t.y),vec4f(vec3f(r[0].z,r[1].z,r[2].z)*s,t.z)),Xform(vec4f(a,-dot(a,t)),vec4f(c,-dot(c,t)),vec4f(d,-dot(d,t))));
 }
 let w=blendX(b);
 if((scene[b+37u]&1u)==0u||motion>=1.0){return InstX(w,Xform(rowAt(b),rowAt(b+4u),rowAt(b+8u)));}
 return InstX(w,invertX(w));
}

struct Hit {t:f32,inst:u32,value:u32,axis:u32,sgn:f32,cell:vec3i}
fn safeInv(d:vec3f)->vec3f {
 let s=select(vec3f(-1e-12),vec3f(1e-12),d>=vec3f(0.0));
 return 1.0/select(d,s,abs(d)<vec3f(1e-12));
}
// Half-block shapes (TraceModel.shapes): a mixed brick's entry with bit 30 holds its cells' octant masks after its
// palette indices. shapeIn: the mask of cell k of brick entry (0: the whole cell). octWalk: where o + t d first reaches
// a half block of cell c that is filled (fill) or empty, from t0 (entered across axis a0, 3 inside) to t1, as (t, axis),
// t -1 when it does not (traverse.ts walks the same); octSpan: how far the ray runs through filled half blocks.
fn shapeIn(entry:u32,k:u32)->u32 {if((entry&0x40000000u)==0u){return 0u;}return (voxels[(entry&0x3fffffffu)+128u+(k>>2u)]>>((k&3u)*8u))&255u;}
fn octStart(o:vec3f,d:vec3f,c:vec3i,t0:f32,t1:f32,h:ptr<function,vec3u>,nx:ptr<function,vec3f>) {
 let p=o+d*(t0+min((t1-t0)*0.5,1e-4))-vec3f(c);
 *h=select(vec3u(0u),vec3u(1u),p>=vec3f(0.5));
 let toward=((d>vec3f(0.0))&(*h==vec3u(0u)))|((d<vec3f(0.0))&(*h==vec3u(1u)));
 *nx=select(vec3f(3e38),(vec3f(c)+0.5-o)*safeInv(d),toward);
}
fn octWalk(mask:u32,o:vec3f,d:vec3f,c:vec3i,t0:f32,t1:f32,a0:u32,fill:bool)->vec2f {
 var h:vec3u;var nx:vec3f;octStart(o,d,c,t0,t1,&h,&nx);
 var t=t0;var a=a0;
 for(var i=0u;i<4u;i++){
  if((((mask>>(h.x|(h.y<<1u)|(h.z<<2u)))&1u)!=0u)==fill){return vec2f(t,f32(a));}
  t=min(min(nx.x,nx.y),nx.z);
  if(!(t<t1)){break;}
  if(nx.x==t){a=0u;h.x^=1u;nx.x=3e38;}else if(nx.y==t){a=1u;h.y^=1u;nx.y=3e38;}else{a=2u;h.z^=1u;nx.z=3e38;}
 }
 return vec2f(-1.0,0.0);
}
fn octSpan(mask:u32,o:vec3f,d:vec3f,c:vec3i,t0:f32,t1:f32)->f32 {
 var h:vec3u;var nx:vec3f;octStart(o,d,c,t0,t1,&h,&nx);
 var t=t0;var span=0.0;
 for(var i=0u;i<4u;i++){
  let tn=min(min(min(nx.x,nx.y),nx.z),t1);
  if(((mask>>(h.x|(h.y<<1u)|(h.z<<2u)))&1u)!=0u){span+=max(tn-t,0.0);}
  if(tn>=t1){break;}
  if(nx.x==tn){h.x^=1u;nx.x=3e38;}else if(nx.y==tn){h.y^=1u;nx.y=3e38;}else{h.z^=1u;nx.z=3e38;}
  t=tn;
 }
 return span;
}
// The axis whose plane of cell c point l lies nearest (the face a ray crosses there).
fn planeAxis(l:vec3f,c:vec3i)->u32 {let e=min(abs(l-vec3f(c)),abs(l-vec3f(c+1)));return select(select(2u,1u,e.y<=e.z),0u,e.x<=e.y&&e.x<=e.z);}
// A cut-out shaped cell (palette v, mask sm) along o + t d from t0 to t1 (inside: the ray starts in it): where it stops
// on a texel that is not cut away, as (t, axis), t -1 when it passes. Each run through filled half blocks stops at the
// texel where it enters them, else at the one where it leaves them (an inner face), else goes on. KB-L5a-10.
fn shapeCut(v:u32,sm:u32,o:vec3f,d:vec3f,c:vec3i,t0:f32,t1:f32,inside:bool)->vec2f {
 let cut=mat(v*MV+7u).z;let up=d>=vec3f(0.0);
 var t=t0;var a=select(planeAxis(o+d*t0,c),3u,inside);
 for(var i=0u;i<select(6u,0u,sm==0u);i++){
  let fill=(i&1u)==0u;
  let r=octWalk(sm,o,d,c,t,t1,a,fill);
  if(fill&&r.x<0.0){break;}
  let tq=select(select(t1,r.x,r.x>=0.0),r.x,fill);
  let aq=select(select(planeAxis(o+d*t1,c),u32(r.y),r.x>=0.0),u32(r.y),fill);
  if((!fill||aq<3u)&&texelAt(v,aq*2u+select(0u,1u,up[aq]==fill),o+d*tq).a>=cut){return vec2f(tq,f32(aq));}
  if(!fill&&r.x<0.0){break;}
  t=tq;a=aq;
 }
 return vec2f(-1.0,0.0);
}
fn found(h:ptr<function,Hit>,t:f32,v:u32,a:u32,stp:vec3i,d:vec3f,c:vec3i)->bool {
 var axis=a;
 if(axis==3u){let q=abs(d);axis=select(select(2u,1u,q.y>=q.z),0u,q.x>=q.y&&q.x>=q.z);}
 (*h).t=t;(*h).value=v;(*h).axis=axis;(*h).sgn=-f32(stp[axis]);(*h).cell=c;
 return true;
}
// Two-level walk of model 'model' along o + t d (model space) for t in [tMin, tMax): the first boundary into a cell
// whose palette index is not 'want'; with want != 0 also the exit through the model's box (value 0). want == STEP:
// the first boundary after the cell the ray starts in, whatever its index (voxelwise volumes).
fn forwardCell(p:vec3f,d:vec3f)->vec3i {
 // A point exactly on a plane belongs to the cell ahead of the ray. A
 // negative grazing component may not move by one float in the query offset.
 return vec3i(select(floor(p),ceil(p)-vec3f(1.0),d<vec3f(0.0)));
}
fn march(model:u32,o:vec3f,d:vec3f,tMin:f32,tMax:f32,want:u32,h:ptr<function,Hit>)->bool {
 let mb=f.scene.x+model*MODEL;
 // The model's material table: hits carry slots (table << 8 | palette index), as want does.
 let base=scene[mb+7u];
 let sz=vec3i(i32(scene[mb]),i32(scene[mb+1u]),i32(scene[mb+2u]));
 let grid=scene[mb+3u];
 let nb=vec3i(i32(scene[mb+4u]),i32(scene[mb+5u]),i32(scene[mb+6u]));
 let inv=safeInv(d);
 let ta=-o*inv;let tb=(vec3f(sz)-o)*inv;let tn=min(ta,tb);let tf=max(ta,tb);
 let tEnter=max(max(tn.x,tn.y),max(tn.z,tMin));
 let boxExit=min(min(tf.x,tf.y),tf.z);
 let tExit=min(boxExit,tMax);
 if(!(tEnter<tExit)){return false;}
 var axis=3u;
 if(tEnter>tMin){axis=select(select(2u,1u,tEnter==tn.y),0u,tEnter==tn.x);}
 let pos=d>=vec3f(0.0);
 let stp=select(vec3i(-1),vec3i(1),pos);
 let up=select(vec3f(0.0),vec3f(1.0),pos);
 let ad=abs(inv);
 var bc=clamp(forwardCell((o+d*tEnter)*0.125,d),vec3i(0),nb-1);
 var bn=((vec3f(bc)+up)*8.0-o)*inv;
 var t=tEnter;
 let step=want==STEP;
 // In STEP mode the cell the ray starts in (inside the box) is passed over.
 var skip=step&&axis==3u;
 var inCell=false;var entry=0u;var tOut=0.0;var lo=vec3i(0);var hi=vec3i(0);
 var c=vec3i(0);var vn=vec3f(0.0);var vt=0.0;var va=0u;var uniform=false;
 loop {
  if(inCell){
   let l=vec3u(c-lo);let k=l.x+8u*(l.z+8u*l.y);
   let pv=select((voxels[(entry&0x3fffffffu)+(k>>2u)]>>((k&3u)*8u))&255u,entry&255u,uniform);
   let v=select(0u,base|pv,pv!=0u);
   let sm=select(0u,shapeIn(entry,k),pv!=0u&&!uniform&&!step);
   if(sm!=0u){
    // A shaped cell holds v in its filled half blocks and nothing elsewhere.
    let tc=min(min(vn.x,vn.y),vn.z);
    // A cut-out one stops only on texels not cut away.
    var r=vec2f(-1.0,0.0);
    if(v!=want&&cutMat(v)){r=shapeCut(v,sm,o,d,c,vt,tc,va==3u);}else{r=octWalk(sm,o,d,c,vt,tc,va,v!=want);}
    if(v==want){if(r.x>=0.0){return found(h,r.x,0u,u32(r.y),stp,d,c);}}
    else{
     if(want!=0u&&(r.x<0.0||r.x>vt)){return found(h,vt,0u,va,stp,d,c);}
     if(r.x>=0.0){return found(h,r.x,v,u32(r.y),stp,d,c);}
    }
   }
   else if(step){if(!skip){return found(h,vt,v,va,stp,d,c);}skip=false;}
   else if(v!=want){
    if(!cutMat(v)){return found(h,vt,v,va,stp,d,c);}
    let r=cutThrough(v,o,d,vt,va==3u,c,vn);
    if(r==0u){return found(h,vt,v,va,stp,d,c);}
    if(r==2u){
     let ax=select(select(2u,1u,vn.y<=vn.z),0u,vn.x<=vn.y&&vn.x<=vn.z);
     return found(h,min(min(vn.x,vn.y),vn.z),v,ax,stp,d,c);
    }
   }
   if(vn.x<vn.y&&vn.x<vn.z){va=0u;vt=vn.x;c.x+=stp.x;vn.x+=ad.x;}
   else if(vn.y<vn.z){va=1u;vt=vn.y;c.y+=stp.y;vn.y+=ad.y;}
   else{va=2u;vt=vn.z;c.z+=stp.z;vn.z+=ad.z;}
   if(!(vt>=tOut||any(c<lo)||any(c>hi))){continue;}
   inCell=false;
  } else {
   entry=voxels[grid+u32(bc.x+nb.x*(bc.z+nb.z*bc.y))];
   tOut=min(min(bn.x,bn.y),min(bn.z,tExit));
   lo=bc*8;hi=min(lo+8,sz)-1;
   let ue=select(0u,base|(entry&255u),entry!=0u);
   if(entry==0u||(entry>=0x80000000u&&!step&&!cutMat(ue))){
    let u=ue;
    if(step){if(!skip){return found(h,t,u,axis,stp,d,clamp(forwardCell(o+d*t,d),lo,hi));}skip=false;}
    else if(u!=want){return found(h,t,u,axis,stp,d,clamp(forwardCell(o+d*t,d),lo,hi));}
   } else {
    c=clamp(forwardCell(o+d*t,d),lo,hi);
    vn=(vec3f(c)+up-o)*inv;
    vt=t;va=axis;
    uniform=entry>=0x80000000u;
    inCell=true;continue;
   }
  }
  if(tOut>=tExit){break;}
  if(bn.x<bn.y&&bn.x<bn.z){axis=0u;t=bn.x;bc.x+=stp.x;bn.x+=ad.x*8.0;}
  else if(bn.y<bn.z){axis=1u;t=bn.y;bc.y+=stp.y;bn.y+=ad.y*8.0;}
  else{axis=2u;t=bn.z;bc.z+=stp.z;bn.z+=ad.z*8.0;}
  if(any(bc<vec3i(0))||any(bc>=nb)){break;}
 }
 if(want==0u||boxExit>=tMax){return false;}
 let ex=select(select(2u,1u,tf.y<=tf.z),0u,tf.x<=tf.y&&tf.x<=tf.z);
 return found(h,boxExit,0u,ex,stp,d,vec3i(floor(o+d*boxExit)));
}
// Extinction of a see-through cell for shadow rays, -1 when the cell blocks light (only media let it through; with
// opaque shadows none, except the sun-lit volume the shadow ray starts in, or only its start cell for a sun ray from a
// walk that entered the volume through a face turned from the sun: as in MagicaVoxel's subsurface, light reaches a
// point in it through that volume alone, mostly from its faces toward the light).
fn extinction(v:u32,own:bool)->f32 {
 let x=mat(v*MV+3u);let fl=u32(x.w);
 return select(-1.0,x.x,(fl&MEDIA)!=0u&&(fl&SUBSURFACE)==0u&&((f.config.z&OPAQUE_SHADOWS)==0u||((fl&SUNLIT)!=0u&&own)));
}
// Optical depth along a shadow ray through one model, -1 when blocked.
fn marchShadow(model:u32,o:vec3f,d:vec3f,tMax:f32)->f32 {
 let mb=f.scene.x+model*MODEL;
 let base=scene[mb+7u];
 let sz=vec3i(i32(scene[mb]),i32(scene[mb+1u]),i32(scene[mb+2u]));
 let grid=scene[mb+3u];
 let nb=vec3i(i32(scene[mb+4u]),i32(scene[mb+5u]),i32(scene[mb+6u]));
 let inv=safeInv(d);
 let ta=-o*inv;let tb=(vec3f(sz)-o)*inv;let tn=min(ta,tb);let tf=max(ta,tb);
 let tEnter=max(max(tn.x,tn.y),max(tn.z,0.0));
 let tExit=min(min(tf.x,tf.y),min(tf.z,tMax));
 if(!(tEnter<tExit)){return 0.0;}
 let pos=d>=vec3f(0.0);
 let stp=select(vec3i(-1),vec3i(1),pos);
 let up=select(vec3f(0.0),vec3f(1.0),pos);
 let ad=abs(inv);
 var bc=clamp(forwardCell((o+d*tEnter)*0.125,d),vec3i(0),nb-1);
 var bn=((vec3f(bc)+up)*8.0-o)*inv;
 var t=tEnter;var depth=0.0;
 // The cell the ray starts in (when it starts inside the model), and whether it is still in the volume it started in
 // (one material from the start cell on, no gap).
 var start=tEnter==0.0;var own=start;var vol=0u;
 var inCell=false;var entry=0u;var tOut=0.0;var lo=vec3i(0);var hi=vec3i(0);
 var c=vec3i(0);var vn=vec3f(0.0);var vt=0.0;var uniform=false;
 loop {
  if(inCell){
   let l=vec3u(c-lo);let k=l.x+8u*(l.z+8u*l.y);
   let pv=select((voxels[(entry&0x3fffffffu)+(k>>2u)]>>((k&3u)*8u))&255u,entry&255u,uniform);
   let v=select(0u,base|pv,pv!=0u);
   let next=min(min(vn.x,vn.y),min(vn.z,tOut));
   let sm=select(0u,shapeIn(entry,k),pv!=0u&&!uniform);
   // A shaped cell blocks or dims the ray only where it runs through its filled half blocks.
   if(sm!=0u){
    if(cutMat(v)){if(shapeCut(v,sm,o,d,c,vt,next,start&&vt==0.0).x>=0.0){return -1.0;}}
    else{let span=octSpan(sm,o,d,c,vt,next);if(span>0.0){let x=extinction(v,false);if(x<0.0){return -1.0;}depth+=x*span;}}
    own=false;
   }
   // A cut-out cell lets the shadow through where both its texels on the ray are cut away.
   else if(cutMat(v)){if(cutThrough(v,o,d,vt,start&&vt==0.0,c,vn)!=1u){return -1.0;}own=false;}
   else if(v!=0u){
    own=own&&(vol==0u||vol==v);vol=v;
    let x=extinction(v,own);if(x<0.0){return -1.0;}depth+=x*max(next-vt,0.0);
    own=own&&!sunCell;
   } else {own=false;}
   start=false;
   if(vn.x<vn.y&&vn.x<vn.z){vt=vn.x;c.x+=stp.x;vn.x+=ad.x;}
   else if(vn.y<vn.z){vt=vn.y;c.y+=stp.y;vn.y+=ad.y;}
   else{vt=vn.z;c.z+=stp.z;vn.z+=ad.z;}
   if(!(vt>=tOut||any(c<lo)||any(c>hi))){continue;}
   inCell=false;
  } else {
   entry=voxels[grid+u32(bc.x+nb.x*(bc.z+nb.z*bc.y))];
   tOut=min(min(bn.x,bn.y),min(bn.z,tExit));
   lo=bc*8;hi=min(lo+8,sz)-1;
   let ue=base|(entry&255u);
   if(entry>=0x80000000u&&!cutMat(ue)){
    // A uniform brick: one material over the whole span (when only the start cell passes light, its share first).
    own=own&&(vol==0u||vol==ue);vol=ue;
    var t1=t;
    if(own&&sunCell){
     let c0=vec3f(forwardCell(o+d*t,d));let cn=(c0+up-o)*inv;t1=min(min(min(cn.x,cn.y),cn.z),tOut);
     let k=extinction(ue,true);if(k<0.0){return -1.0;}depth+=k*(t1-t);own=false;
    }
    if(t1<tOut){let k=extinction(ue,own);if(k<0.0){return -1.0;}depth+=k*(tOut-t1);}
   } else if(entry==0u){own=false;}
   else {
    c=clamp(forwardCell(o+d*t,d),lo,hi);
    vn=(vec3f(c)+up-o)*inv;
    vt=t;
    uniform=entry>=0x80000000u;
    inCell=true;continue;
   }
  }
  start=false;
  if(tOut>=tExit){break;}
  if(bn.x<bn.y&&bn.x<bn.z){t=bn.x;bc.x+=stp.x;bn.x+=ad.x*8.0;}
  else if(bn.y<bn.z){t=bn.y;bc.y+=stp.y;bn.y+=ad.y*8.0;}
  else{t=bn.z;bc.z+=stp.z;bn.z+=ad.z*8.0;}
  if(any(bc<vec3i(0))||any(bc>=nb)){break;}
 }
 return depth;
}
// A surface of another instance that coincides with the current volume's own exit (glass resting on a floor model)
// wins the tie: the path meets the floor rather than leaving the glass into it.
fn traceInstance(i:u32,o:vec3f,d:vec3f,medium:u32,mInst:u32,h:ptr<function,Hit>) {
 let m=localX(i);
 var r:Hit;
 let own=i==mInst;
 let exitTie=!own&&(*h).inst==mInst&&(*h).value==0u;
 let tMax=select((*h).t,(*h).t*1.0001+1e-4,exitTie);
 var want=select(0u,medium,own);
 if(own&&medium!=0u&&(u32(mat(medium*MV+3u).w)&VOXELWISE)!=0u){want=STEP;}
 if(march(scene[f.scene.y+i*INSTANCE+36u],xpoint(m,o),xdir(m,d),0.0,tMax,want,&r)){
  if(exitTie){if(r.value!=0u||r.t<(*h).t){r.inst=i;*h=r;}return;}
  if(own&&r.value==0u&&(*h).inst!=NONE&&(*h).t<r.t*1.0001+1e-4){return;}
  r.inst=i;*h=r;
 }
}
fn opaqueArea(k:u32)->bool {return ll(f.lights.z+k*16u+15u)!=0.0;}
// Distance along o + t d (t > 0) to area light k's rectangle from either face, -1 when the ray misses it.
fn rectHit(k:u32,o:vec3f,d:vec3f)->f32 {
 let b=f.lights.z+k*16u;
 let c=vec3f(ll(b),ll(b+1u),ll(b+2u));let eu=vec3f(ll(b+4u),ll(b+5u),ll(b+6u));let ev=vec3f(ll(b+8u),ll(b+9u),ll(b+10u));
 let n=cross(eu,ev);let dn=dot(d,n);
 if(abs(dn)<1e-20){return -1.0;}
 let t=dot(c-o,n)/dn;
 if(t<=0.0){return -1.0;}
 let q=o+d*t-c;
 let uu=dot(eu,eu);let uv=dot(eu,ev);let vv=dot(ev,ev);let qu=dot(q,eu);let qv=dot(q,ev);let den=uu*vv-uv*uv;
 let s=(qu*vv-qv*uv)/den;let r=(qv*uu-qu*uv)/den;
 if(s<0.0||s>1.0||r<0.0||r>1.0){return -1.0;}
 return t;
}
// Closest boundary along a world ray: ground plane, area lights, then voxels through the hierarchy. In a volume
// (medium != 0) the volume's own instance is walked for the cell where the volume ends.
fn closest(o:vec3f,d:vec3f,medium:u32,mInst:u32)->Hit {
 var h:Hit;h.t=INF;h.inst=NONE;
 if((f.config.z&HAS_GROUND)!=0u&&abs(d.y)>1e-9){let t=(f.ground.w-o.y)/d.y;if(t>0.0){h.t=t;h.inst=GROUND;}}
 for(var k=0u;k<f.config.w;k++){
  // The back of a see-through one-sided light is not there; solid lights are hit from both faces.
  let b=f.lights.z+k*16u;
  if(ll(b+7u)==0.0&&!opaqueArea(k)&&dot(d,cross(vec3f(ll(b+4u),ll(b+5u),ll(b+6u)),vec3f(ll(b+8u),ll(b+9u),ll(b+10u))))>0.0){continue;}
  let t=rectHit(k,o,d);
  if(t<=0.0||t>=h.t){continue;}
  h.t=t;h.inst=AREA;h.value=k;
 }
 if(f.scene.w==0u){return h;}
 let inv=safeInv(d);
 var stack:array<u32,32>;var sp=0u;var node=0u;
 var i=0u;var end=0u;var pop=false;
 loop {
  if(i<end){traceInstance(i,o,d,medium,mInst,&h);i++;continue;}
  if(pop){pop=false;if(sp==0u){break;}sp--;node=stack[sp];}
  let b=f.scene.z+node*8u;
  let t0=(vec3f(fl(b),fl(b+1u),fl(b+2u))-o)*inv;let t1=(vec3f(fl(b+4u),fl(b+5u),fl(b+6u))-o)*inv;
  let tn=max(max(min(t0.x,t1.x),min(t0.y,t1.y)),max(min(t0.z,t1.z),0.0));
  let tf=min(min(max(t0.x,t1.x),max(t0.y,t1.y)),min(max(t0.z,t1.z),h.t));
  var down=false;
  if(tn<=tf){
   let count=scene[b+7u];let start=scene[b+3u];
   if(count>0u){i=start;end=start+count;}
   else{down=true;}
  }
  if(down){if(sp<32u){stack[sp]=scene[b+3u]+1u;sp++;}node=scene[b+3u];continue;}
  pop=true;
 }
 return h;
}
// A medium boundary changes coefficients without changing the physical ray.
// Offset only the intersection query to select its forward side, then restore
// that distance before integrating extinction, emission or free flight.
fn mediumClosest(o:vec3f,d:vec3f,medium:u32,mInst:u32,advance:bool)->Hit {
 var shift=0.0;
 if(advance){shift=max(1e-6,max(max(abs(o.x),abs(o.y)),abs(o.z))*4.76837158e-7)/length(d);}
 var h=closest(o+d*shift,d,medium,mInst);
 if(h.inst!=NONE){h.t+=shift;}
 return h;
}
// Transmittance toward a light: 0 when the ground or a non-medium voxel blocks it, else exp(-optical depth).
fn shadow(o:vec3f,d:vec3f,tMax:f32)->f32 {
 if((f.config.z&HAS_GROUND)!=0u&&abs(d.y)>1e-9){let t=(f.ground.w-o.y)/d.y;if(t>0.0&&t<tMax){return 0.0;}}
 // Solid area lights (a light sampled on its own rectangle ends just before it).
 for(var k=0u;k<f.config.w;k++){if(opaqueArea(k)){let t=rectHit(k,o,d);if(t>0.0&&t<tMax*(1.0-1e-4)){return 0.0;}}}
 if(f.scene.w==0u){return 1.0;}
 let inv=safeInv(d);
 var tau=0.0;
 var stack:array<u32,32>;var sp=0u;var node=0u;
 var i=0u;var end=0u;var pop=false;
 loop {
  if(i<end){
   let m=localX(i);
   let k=marchShadow(scene[f.scene.y+i*INSTANCE+36u],xpoint(m,o),xdir(m,d),tMax);
   if(k<0.0){return 0.0;}
   tau+=k;
   i++;continue;
  }
  if(pop){pop=false;if(sp==0u){break;}sp--;node=stack[sp];}
  let b=f.scene.z+node*8u;
  let t0=(vec3f(fl(b),fl(b+1u),fl(b+2u))-o)*inv;let t1=(vec3f(fl(b+4u),fl(b+5u),fl(b+6u))-o)*inv;
  let tn=max(max(min(t0.x,t1.x),min(t0.y,t1.y)),max(min(t0.z,t1.z),0.0));
  let tf=min(min(max(t0.x,t1.x),max(t0.y,t1.y)),min(max(t0.z,t1.z),tMax));
  var down=false;
  if(tn<=tf){
   let count=scene[b+7u];let start=scene[b+3u];
   if(count>0u){i=start;end=start+count;}
   else {down=true;}
  }
  if(down){if(sp<32u){stack[sp]=scene[b+3u]+1u;sp++;}node=scene[b+3u];continue;}
  pop=true;
 }
 return exp(-tau);
}
fn unitAxis(a:u32)->vec3i {return select(select(vec3i(0,0,1),vec3i(0,1,0),a==1u),vec3i(1,0,0),a==0u);}
// A filled cell of instance i's model (cells outside the model are empty).
fn filled(model:u32,c:vec3i)->bool {
 let mb=f.scene.x+model*MODEL;
 let sz=vec3i(i32(scene[mb]),i32(scene[mb+1u]),i32(scene[mb+2u]));
 if(any(c<vec3i(0))||any(c>=sz)){return false;}
 return voxelAt(model,c)!=0u;
}
// Whether model point l (hit h's point in its instance's model space) on the face of hit h lies within the edge band: within f.edges.w (voxels) of a face edge where
// the shape turns: the face ends there (outer corner) or meets a filled cell in front of the neighbour (inner corner).
fn edgeBand(h:Hit,lp:vec3f)->bool {
 let model=scene[f.scene.y+h.inst*INSTANCE+36u];
 let nrm=unitAxis(h.axis)*i32(h.sgn);
 let w=f.edges.w;
 for(var k=1u;k<3u;k++){
  let a=(h.axis+k)%3u;let e=unitAxis(a);
  let u=dot(lp-vec3f(h.cell),vec3f(e));
  for(var s=-1;s<=1;s+=2){
   let dist=select(u,1.0-u,s>0);
   if(dist>=w){continue;}
   let nb=h.cell+e*s;
   if(!filled(model,nb)||filled(model,nb+nrm)){return true;}
  }
 }
 return false;
}
// Whether world point p on a surface with normal n lies on a grid line (every f.grid.w units, f.grid2.x half width),
// along the two axes across the surface.
fn gridLine(p:vec3f,n:vec3f)->bool {
 let s=f.grid.w;let q=abs(p/s-round(p/s))*s;let a=abs(n);
 let k=select(select(2u,1u,a.y>=a.z),0u,a.x>=a.y&&a.x>=a.z);
 return (k!=0u&&q.x<f.grid2.x)||(k!=1u&&q.y<f.grid2.x)||(k!=2u&&q.z<f.grid2.x);
}
// Block textures (scene word 0: the table's start, 0 without; per texture its first texel word, width, height): the
// texel of palette v's face (0 +x, 1 -x, 2 +y, 3 -y, 4 +z, 5 -z) at model point l as linear colour and alpha, 1 where
// the material has none. Faces tile as in @margoengine/voxel's renderer: tops by x and z, sides with v running down.
fn texelAt(v:u32,face:u32,l:vec3f)->vec4f {
 let base=scene[0];
 if(base==0u){return vec4f(1.0);}
 let slot=mat(v*MV+6u+face/4u)[face%4u];
 if(slot<0.5){return vec4f(1.0);}
 var uv=vec2f(-l.x,-l.y);
 switch face {
  case 0u {uv=vec2f(-l.z,-l.y);}
  case 1u {uv=vec2f(l.z,-l.y);}
  case 2u {uv=l.xz;}
  case 3u {uv=vec2f(l.x,-l.z);}
  case 4u {uv=vec2f(l.x,-l.y);}
  default {}
 }
 let t=base+4u*(u32(slot)-1u);let w=scene[t+1u];let ht=scene[t+2u];let q=fract(uv);
 let c=unpack4x8unorm(scene[scene[t]+min(u32(q.y*f32(ht)),ht-1u)*w+min(u32(q.x*f32(w)),w-1u)]);
 return vec4f(select(c.rgb/12.92,pow((c.rgb+0.055)/1.055,vec3f(2.4)),c.rgb>vec3f(0.04045)),c.a);
}
// The face of cell c that model point l lies on, across axis a (the side nearer l).
fn faceOf(a:u32,l:vec3f,c:vec3i)->u32 {return a*2u+select(1u,0u,l[a]-f32(c[a])>0.5);}
// Hit h's texel at model point l (its face from where p lies on the cell, so a voxel's inner faces read their own).
fn faceTexel(h:Hit,l:vec3f)->vec4f {
 if(scene[0]==0u||h.inst>=AREA){return vec4f(1.0);}
 var face=faceOf(h.axis,l,h.cell);
 // A shaped cell's mid-cell face reads the face it turns toward.
 if(abs(l[h.axis]-f32(h.cell[h.axis])-0.5)<1e-3){face=h.axis*2u+select(1u,0u,h.sgn>0.0);}
 return texelAt(h.value,face,l);
}
fn cutMat(v:u32)->bool {return v!=0u&&(u32(mat(v*MV+3u).w)&CUTOUT)!=0u;}
// A ray (model space o + t d) through cut-out cell c of palette v, entering at t0 (inside: it starts in the cell), next
// boundaries vn: 0 when the texel where it enters is solid, 1 when that and the one where it leaves are both cut away
// (it goes on), 2 when only the one where it leaves is solid (the voxel's inner face).
fn cutThrough(v:u32,o:vec3f,d:vec3f,t0:f32,inside:bool,c:vec3i,vn:vec3f)->u32 {
 let cut=mat(v*MV+7u).z;
 if(!inside){
  // The face it enters by: the axis whose cell plane the entry point lies nearest.
  let l=o+d*t0;let e=min(abs(l-vec3f(c)),abs(l-vec3f(c+1)));
  let a=select(select(2u,1u,e.y<=e.z),0u,e.x<=e.y&&e.x<=e.z);
  if(texelAt(v,faceOf(a,l,c),l).a>=cut){return 0u;}
 }
 let t1=min(min(vn.x,vn.y),vn.z);let ax=select(select(2u,1u,vn.y<=vn.z),0u,vn.x<=vn.y&&vn.x<=vn.z);
 let l=o+d*t1;
 return select(1u,2u,texelAt(v,faceOf(ax,l,c),l).a>=cut);
}
fn lineMat(c:vec3f)->Mat {var m:Mat;m.color=c;m.metalColor=c;m.alpha=1.0;m.ior=1.5;return m;}
fn voxelAt(model:u32,c:vec3i)->u32 {
 let mb=f.scene.x+model*MODEL;
 let nb=vec3i(i32(scene[mb+4u]),i32(scene[mb+5u]),i32(scene[mb+6u]));
 let b=c>>vec3u(3u);
 let entry=voxels[scene[mb+3u]+u32(b.x+nb.x*(b.z+nb.z*b.y))];
 if(entry==0u){return 0u;}
 if(entry>=0x80000000u){return entry&255u;}
 let l=vec3u(c&vec3i(7));let k=l.x+8u*(l.z+8u*l.y);
 return (voxels[(entry&0x3fffffffu)+(k>>2u)]>>((k&3u)*8u))&255u;
}

// Camera rays: origins on the near plane and directions, computed in float64 on the CPU at the image's corners and
// interpolated (exact for perspective and orthographic projections, whose near plane and ray directions are affine in
// the pixel position); a thin lens moves the origin across the aperture and aims at the focus plane.
struct Ray {o:vec3f,d:vec3f}
fn pinhole(px:vec2f)->Ray {
 let uv=px/vec2f(f32(f.image.x),f32(f.image.y));
 var o=mix(mix(f.origins[0],f.origins[1],uv.x),mix(f.origins[2],f.origins[3],uv.x),uv.y).xyz;
 var d=mix(mix(f.directions[0],f.directions[1],uv.x),mix(f.directions[2],f.directions[3],uv.x),uv.y).xyz;
 if((f.config.z&CAMERA_MOTION)!=0u&&motion<1.0){
  // Camera motion blur: the corner rays interpolated between the shutter-open and shutter-close poses.
  let po=mix(mix(f.prevOrigins[0],f.prevOrigins[1],uv.x),mix(f.prevOrigins[2],f.prevOrigins[3],uv.x),uv.y).xyz;
  let pd=mix(mix(f.prevDirections[0],f.prevDirections[1],uv.x),mix(f.prevDirections[2],f.prevDirections[3],uv.x),uv.y).xyz;
  o=mix(po,o,motion);d=mix(pd,d,motion);
 }
 return Ray(o,normalize(d));
}
fn lensPoint()->vec2f {
 let u=vec2f(rand(),rand());
 let blades=f.right.w;
 if(blades<3.0){
  // Concentric disk mapping (Shirley and Chiu 1997).
  let p=2.0*u-1.0;
  if(p.x==0.0&&p.y==0.0){return vec2f(0.0);}
  var r:f32;var a:f32;
  if(abs(p.x)>abs(p.y)){r=p.x;a=PI*0.25*(p.y/p.x);}else{r=p.y;a=PI*0.5-PI*0.25*(p.x/p.y);}
  return r*vec2f(cos(a),sin(a));
 }
 let k=floor(rand()*blades);let a0=f.up.w+k*TAU/blades;let a1=a0+TAU/blades;
 var s=u;if(s.x+s.y>1.0){s=1.0-s;}
 return vec2f(cos(a0),sin(a0))*s.x+vec2f(cos(a1),sin(a1))*s.y;
}
// The undistorted pixel position seen at pixel position px (Brown-Conrady, inverted by fixed-point iteration), in
// units of half the image height from the centre, y up.
fn undistort(px:vec2f)->vec2f {
 let W=f32(f.image.x);let H=f32(f.image.y);
 let xd=vec2f(px.x-0.5*W,0.5*H-px.y)/(0.5*H);
 let k=f.distortion;
 var u=xd;
 for(var i=0;i<20;i++){
  let r2=dot(u,u);
  let radial=1.0+k.x*r2+k.y*r2*r2;
  let t=vec2f(2.0*k.z*u.x*u.y+k.w*(r2+2.0*u.x*u.x),k.z*(r2+2.0*u.y*u.y)+2.0*k.w*u.x*u.y);
  u=(xd-t)/radial;
 }
 return vec2f(u.x*0.5*H+0.5*W,0.5*H-u.y*0.5*H);
}
// Panorama and fisheye rays from the eye along the camera's axes (interpolated with camera motion); d = 0 outside a
// fisheye's circle (the stereographic mapping fills the frame). The angles go through the precise functions
// (packages/shared/precise-math.js), not the builtins: WGSL lets asin be 6.8e-5 off and sin and cos 2^-11, and a ray
// that far off can hit a different voxel than VoxelPathTracer.raycast on the CPU (an Intel Arc 140V drew fisheye
// depths 1.2e-3 off where the RTX A6000 is within 1e-6).
fn wideRay(px:vec2f)->Ray {
 var eye=f.eye.xyz;var fw=f.forward.xyz;var rt=f.right.xyz;var up=f.up.xyz;
 if((f.config.z&CAMERA_MOTION)!=0u&&motion<1.0){
  eye=mix(f.prevEye.xyz,eye,motion);fw=normalize(mix(f.prevForward.xyz,fw,motion));
  rt=normalize(mix(f.prevRight.xyz,rt,motion));up=normalize(mix(f.prevUp.xyz,up,motion));
 }
 let W=f32(f.image.x);let H=f32(f.image.y);
 if(f.projection.x==1u){
  // Fitted to the width (360 degrees across) or to the height (the same angle per pixel across as down).
  let phi=select((px.x/W-0.5)*TAU,(px.x-0.5*W)/H*PI,f.projection.w==1u);let el=(0.5-px.y/H)*PI;
  return Ray(eye,normalize(preciseCos(el)*(preciseSin(phi)*rt+preciseCos(phi)*fw)+preciseSin(el)*up));
 }
 let p=vec2f(px.x-0.5*W,0.5*H-px.y)/(0.5*H);
 let r=length(p);
 var th=r*0.5*f.lensFov.x;
 if(f.projection.y==1u){let s=r*f.lensFov.y;if(s>1.0){return Ray(eye,vec3f(0.0));}th=2.0*preciseAsin(s);}
 if(f.projection.y==2u){th=2.0*preciseAtan(r*f.lensFov.y);}
 else if(th>0.5*f.lensFov.x+1e-6){return Ray(eye,vec3f(0.0));}
 let a=select(vec2f(0.0),p/r,r>0.0);
 return Ray(eye,normalize(preciseCos(th)*fw+preciseSin(th)*(a.x*rt+a.y*up)));
}
// The ray through pixel position px without the lens: the projection's, distortion applied.
fn viewRay(px:vec2f)->Ray {
 if(f.projection.x!=0u){return wideRay(px);}
 return pinhole(select(px,undistort(px),f.projection.z!=0u));
}
fn cameraRay(px:vec2f)->Ray {
 var r=viewRay(px);
 if(f.forward.w>0.0&&f.projection.x==0u){
  var eye=f.eye;var fw=f.forward.xyz;var rt=f.right.xyz;var up=f.up.xyz;
  if((f.config.z&CAMERA_MOTION)!=0u&&motion<1.0){
   eye=mix(f.prevEye,f.eye,motion);fw=normalize(mix(f.prevForward.xyz,fw,motion));
   rt=normalize(mix(f.prevRight.xyz,rt,motion));up=normalize(mix(f.prevUp.xyz,up,motion));
  }
  let t=(eye.w-dot(r.o-eye.xyz,fw))/dot(r.d,fw);
  let focus=r.o+r.d*t;
  let l=lensPoint()*f.forward.w;
  r.o=r.o+rt*l.x+up*l.y;
  r.d=normalize(focus-r.o);
 }
 return r;
}

// Materials: 4 vec4 per palette index (scene.ts packMaterial).
// disp: Cauchy coefficient B (square micrometres; 0 without dispersion), ior the index at the d line.
struct Mat {color:vec3f,alpha:f32,metal:f32,glass:f32,spec:f32,f0:f32,emission:vec3f,ior:f32,density:f32,scatter:f32,g:f32,flags:u32,disp:f32,metalColor:vec3f,seen:vec4f}
fn material(id:u32)->Mat {
 let a=mat(id*MV);let b=mat(id*MV+1u);let c=mat(id*MV+2u);let e=mat(id*MV+3u);
 let x=mat(id*MV+4u);
 return Mat(a.xyz,a.w,b.x,b.y,b.z,b.w,c.xyz,c.w,e.x,e.y,e.z,u32(e.w),x.x,x.yzw,mat(id*MV+5u));
}
// Index of a dispersive material at wavelength l (nanometres).
fn iorAt(m:Mat,l:f32)->f32 {let x=l*0.001;return m.ior+m.disp*(1.0/(x*x)-1.0/(LAMBDA_D*LAMBDA_D));}
// Smooth glass without dispersion: what light sampling refracts through.
fn clearGlass(m:Mat)->bool {return (m.flags&SMOOTH)!=0u&&m.disp==0.0;}
// The path's wavelength, taken at its first dispersive interface (or fixed by the frame): the throughput is weighted
// by that wavelength's RGB weight over its density.
fn collapse(lambda:ptr<function,f32>,thr:ptr<function,vec3f>) {
 if(*lambda>0.0){return;}
 let w=sampleLambda(vec2f(rand(),rand()));
 *thr*=spectralRgb(w.x)/w.y;*lambda=w.x;
}
fn groundMat()->Mat {var m:Mat;m.color=f.ground.xyz;m.metalColor=f.ground.xyz;m.alpha=1.0;m.ior=1.5;return m;}
fn schlick3(f0:vec3f,c:f32)->vec3f {return f0+(1.0-f0)*pow(1.0-clamp(c,0.0,1.0),5.0);}
fn schlick1(f0:f32,c:f32)->f32 {return f0+(1.0-f0)*pow(1.0-clamp(c,0.0,1.0),5.0);}
fn cosineDir(n:vec3f)->vec3f {
 let u=vec2f(rand(),rand());let r=sqrt(u.x);let p=TAU*u.y;
 return basis(n)*vec3f(r*cos(p),r*sin(p),sqrt(max(0.0,1.0-u.x)));
}
fn vndf(wo:vec3f,alpha:f32,n:vec3f)->vec3f {return vndfU(wo,alpha,n,vec2f(rand(),rand()));}
// Albedo tables (TABLES): bilinear in (mu, roughness), trilinear with log(eta) for the dielectric.
fn tab(i:u32)->f32 {return tables[i>>2u][i&3u];}
fn tableE(mu:f32,r:f32)->f32 {
 let x=clamp(mu,0.0,1.0)*31.0;let y=clamp(r,0.0,1.0)*31.0;let x0=min(u32(x),30u);let y0=min(u32(y),30u);
 let fx=x-f32(x0);let fy=y-f32(y0);let i=x0+32u*y0;
 return mix(mix(tab(i),tab(i+1u),fx),mix(tab(i+32u),tab(i+33u),fx),fy);
}
fn tableEavg(r:f32)->f32 {let y=clamp(r,0.0,1.0)*31.0;let y0=min(u32(y),30u);return mix(tab(1024u+y0),tab(1025u+y0),y-f32(y0));}
fn tableGlass(mu:f32,r:f32,eta:f32)->f32 {
 let x=clamp(mu,0.0,1.0)*15.0;let y=clamp(r,0.0,1.0)*15.0;let z=clamp((log(eta)/log(3.0)+1.0)*0.5,0.0,1.0)*31.0;
 let x0=min(u32(x),14u);let y0=min(u32(y),14u);let z0=min(u32(z),30u);
 let fx=x-f32(x0);let fy=y-f32(y0);let fz=z-f32(z0);
 let i=1056u+x0+16u*(y0+16u*z0);
 let a=mix(mix(tab(i),tab(i+1u),fx),mix(tab(i+16u),tab(i+17u),fx),fy);
 let b=mix(mix(tab(i+256u),tab(i+257u),fx),mix(tab(i+272u),tab(i+273u),fx),fy);
 return mix(a,b,fz);
}
struct Eval {f:vec3f,pdf:f32}
// BSDF times cos(wi) over the lobes in mask (1 diffuse, 2 glossy: metal and coat), and the density of sampling wi
// over all of them; glass and perfectly specular lobes are not included. An additive coat leaves the diffuse base
// whole (MagicaVoxel) instead of taking its reflection out of it.
fn evalLobes(m:Mat,n:vec3f,wo:vec3f,wi:vec3f,mask:u32)->Eval {
 var e:Eval;
 let ci=dot(n,wi);let co=dot(n,wo);
 if(ci<=0.0||co<=0.0){return e;}
 let pb=max(0.0,1.0-m.metal-m.glass);
 let pc=m.spec*schlick1(m.f0,co);
 if((mask&1u)!=0u){e.f=pb*select(1.0-pc,1.0,(m.flags&ADDITIVE)!=0u)*m.color*(ci*INV_PI);}
 e.pdf=pb*(1.0-pc)*ci*INV_PI;
 if((m.flags&SMOOTH)==0u){
  let h=normalize(wo+wi);let nh=dot(n,h);let vh=max(dot(wo,h),0.0);let a2=m.alpha*m.alpha;
  let d=ggxD(a2,n,h);let lo=lambdaG(a2,co);let g2=1.0/(1.0+lo+lambdaG(a2,ci));
  let spec=d*g2/(4.0*co);
  let gloss=(mask&2u)!=0u;
  if(gloss){e.f+=(m.metal*schlick3(m.metalColor,vh)+pb*m.spec*schlick1(m.f0,vh))*spec;}
  var qms=0.0;
  if(m.metal>0.0){
   // Multiple scattering between the microfacets (Kulla and Conty): (1 - E(mu_o)) (1 - E(mu_i)) / (pi (1 - Eavg)),
   // scaled by Favg^2 Eavg / (1 - Favg (1 - Eavg)) with Favg the hemispherical average of Schlick's Fresnel.
   let rough=sqrt(m.alpha);let ea=tableEavg(rough);
   qms=clamp(1.0-tableE(co,rough),0.0,1.0);
   let fa=m.metalColor+(1.0-m.metalColor)/21.0;
   if(gloss&&(f.config.z&NO_COMPENSATION)==0u){e.f+=m.metal*fa*fa*ea/(1.0-fa*(1.0-ea))*qms*(1.0-tableE(ci,rough))/(PI*max(1.0-ea,1e-4))*ci;}
  }
  e.pdf+=(m.metal*(1.0-qms)+pb*pc)*d/((1.0+lo)*4.0*co)+m.metal*qms*ci*INV_PI;
 }
 return e;
}
fn evalSurface(m:Mat,n:vec3f,wo:vec3f,wi:vec3f)->Eval {return evalLobes(m,n,wo,wi,3u);}
// lobe: 0 cosine (diffuse, multiple scattering), 1 microfacet reflection, 2 perfect mirror, 3 dielectric.
struct Bounce {wi:vec3f,w:vec3f,pdf:f32,transmit:bool,ok:bool,lobe:u32}
fn guideWeight(s:Bounce,alpha:f32,n:vec3f,wo:vec3f,eta:f32,isSmooth:bool)->vec3f {
 if(isSmooth||s.lobe!=3u){return s.w;}
 let e=tableGlass(dot(n,wo),sqrt(alpha),eta);
 return vec3f(min(select(e/0.05,e,(f.config.z&NO_COMPENSATION)!=0u),1.0));
}
// Dielectric interface with relative index eta = n(incident side) / n(other side); smooth or GGX-rough. Rough
// interfaces divide by their directional albedo, so the energy masking and shadowing would lose comes back.
fn dielectric(alpha:f32,n:vec3f,wo:vec3f,eta:f32,isSmooth:bool)->Bounce {
 var s:Bounce;
 s.lobe=3u;
 var m=n;
 if(!isSmooth){m=vndf(wo,alpha,n);}
 let c=dot(wo,m);
 if(c<=0.0){return s;}
 if(rand()<fresnel(c,eta)){
  s.wi=reflect(-wo,m);
  if(dot(s.wi,n)<=0.0){return s;}
 } else {
  s.wi=refract(-wo,m,eta);
  s.transmit=true;
  if(dot(s.wi,n)>=0.0){return s;}
 }
 s.w=vec3f(1.0);
 if(!isSmooth){
  let a2=alpha*alpha;let co=dot(n,wo);let lo=lambdaG(a2,co);
  let norm=select(max(tableGlass(co,sqrt(alpha),eta),0.05),1.0,(f.config.z&NO_COMPENSATION)!=0u);
  s.w=vec3f((1.0+lo)/(1.0+lo+lambdaG(a2,abs(dot(n,s.wi))))/norm);
 }
 s.ok=true;
 return s;
}
// One lobe picked by its weight, then the estimator over all non-glass lobes (pdf 0: no light-sampling weight).
fn sampleSurface(m:Mat,n:vec3f,wo:vec3f,etaI:f32)->Bounce {
 var s:Bounce;
 var r=rand();
 if(r<m.glass){return dielectric(m.alpha,n,wo,etaI/m.ior,(m.flags&SMOOTH)!=0u);}
 let rest=max(1.0-m.glass,1e-6);
 r=(r-m.glass)/rest;
 let co=dot(n,wo);
 let pb=max(0.0,1.0-m.metal-m.glass);
 let pc=m.spec*schlick1(m.f0,co);
 let qm=m.metal/rest;let qc=pb*pc/rest;
 if((m.flags&SMOOTH)!=0u){
  if(r<qm){s.wi=reflect(-wo,n);s.w=schlick3(m.metalColor,co);s.ok=true;s.lobe=2u;return s;}
  if(r<qm+qc){s.wi=reflect(-wo,n);s.w=vec3f(1.0);s.ok=true;s.lobe=2u;return s;}
  s.wi=cosineDir(n);
 } else {
  let qms=select(0.0,clamp(1.0-tableE(co,sqrt(m.alpha)),0.0,1.0),m.metal>0.0);
  if(r<qm*(1.0-qms)+qc){s.wi=reflect(-wo,vndf(wo,m.alpha,n));s.lobe=1u;}
  else{s.wi=cosineDir(n);}
 }
 let e=evalSurface(m,n,wo,s.wi);
 if(e.pdf<=0.0){return s;}
 s.w=e.f/e.pdf;s.pdf=e.pdf;s.ok=true;
 return s;
}
// Interior of a volume: free-flight sampling coefficient, scattering weight, absorption, phase anisotropy.
// emit: radiance a medium adds per world unit (media only).
struct Medium {sigma:f32,albedo:vec3f,absorb:vec3f,g:f32,media:bool,emit:vec3f}
fn mediumOf(id:u32)->Medium {
 var r:Medium;
 if(id==0u){return r;}
 let m=material(id);
 r.g=m.g;
 if((m.flags&MEDIA)!=0u){r.sigma=m.density;r.albedo=select(m.color,m.metalColor,(m.flags&SUBSURFACE)!=0u);r.media=true;r.emit=m.emission;}
 else{r.sigma=m.scatter;r.albedo=vec3f(1.0);r.absorb=m.density*-log(max(m.color,vec3f(1e-4)));}
 return r;
}
fn hgPdf(c:f32,g:f32)->f32 {let d=1.0+g*g-2.0*g*c;return (1.0-g*g)/(4.0*PI*d*sqrt(max(d,1e-12)));}
fn sampleHg(d:vec3f,g:f32)->vec3f {
 let u=vec2f(rand(),rand());
 var c=1.0-2.0*u.x;
 if(abs(g)>=1e-3){let k=(1.0-g*g)/(1.0+g-2.0*g*u.x);c=(1.0+g*g-k*k)/(2.0*g);}
 let s=sqrt(max(0.0,1.0-c*c));let p=TAU*u.y;
 return basis(d)*vec3f(s*cos(p),s*sin(p),c);
}
fn evalAt(kind:u32,m:Mat,n:vec3f,wo:vec3f,wi:vec3f,mask:u32)->Eval {
 if(kind==1u){let p=hgPdf(dot(-wo,wi),m.g);return Eval(vec3f(p),p);}
 return evalLobes(m,n,wo,wi,mask);
}

// Lights.
fn envUV(d:vec3f)->vec2f {
 var u=atan2(d.x,-d.z)/TAU+0.5-f.weights.y/TAU;
 u=u-floor(u);
 return vec2f(u,acos(clamp(d.y,-1.0,1.0))/PI);
}
fn envTexel(uv:vec2f)->vec4f {
 let x=min(u32(uv.x*f32(f.env.x)),f.env.x-1u);let y=min(u32(uv.y*f32(f.env.y)),f.env.y-1u);
 return envmap[y*f.env.x+x];
}
// Radiance filtered bilinearly between texel centres (wrapping in azimuth); sampling densities stay per texel.
fn envSmooth(uv:vec2f)->vec3f {
 let w=f.env.x;let h=f.env.y;
 let px=uv.x*f32(w)-0.5;let py=clamp(uv.y*f32(h)-0.5,0.0,f32(h-1u));
 let fx=floor(px);let ax=px-fx;let y0=u32(py);let y1=min(y0+1u,h-1u);let ay=py-f32(y0);
 let x0=u32(i32(fx)+i32(w))%w;let x1=(x0+1u)%w;
 let a=mix(envmap[y0*w+x0].xyz,envmap[y0*w+x1].xyz,ax);
 let b=mix(envmap[y1*w+x0].xyz,envmap[y1*w+x1].xyz,ax);
 return mix(a,b,ay);
}
fn envPdf(d:vec3f,t:vec4f)->f32 {
 let s=sqrt(max(0.0,1.0-d.y*d.y));
 if(s<=1e-6||f.weights.x<=0.0){return 0.0;}
 return t.w/f.weights.x/(2.0*PI*PI*s);
}
// Radiance of the environment and sun disk in direction d, weighted against light sampling when the path was sampled
// with density bsdfPdf (0: no light sampling could have found it) through a chain of refractions with Jacobian j.
// camera: the ray has not scattered yet (the sun disk then shows unless hidden; scattered rays see it unless the sun
// lights diffuse lobes only, by light sampling alone).
fn environment(d:vec3f,bsdfPdf:f32,j:f32,camera:bool)->vec3f {
 var c=f.sky.xyz;
 if((f.config.z&ENV)!=0u){
  let uv=envUV(d);let t=envTexel(uv);
  c=envSmooth(uv)*f.sky.w;
  if(bsdfPdf>0.0){c*=power2(bsdfPdf,envPdf(d,t)/j);}
 }
 let seen=select((f.config.z&SUN_DIFFUSE)==0u,(f.config.z&HIDE_SUN)==0u,camera);
 if(seen&&(f.config.z&SUN)!=0u&&f.sunLight.w>0.0&&dot(d,f.sun.xyz)>=f.sun.w){
  c+=f.sunLight.xyz*select(1.0,power2(bsdfPdf,1.0/f.sunLight.w/j),bsdfPdf>0.0);
 }
 return c;
}
// The sky behind direction d (constant sky or environment map; no sun disk).
fn skyBehind(d:vec3f)->vec3f {
 if((f.config.z&ENV)==0u){return f.sky.xyz;}
 return envSmooth(envUV(d))*f.sky.w;
}
// Sky radiance at the horizon in d's azimuth (constant sky or environment map; no sun disk).
fn horizonSky(d:vec3f)->vec3f {
 if((f.config.z&ENV)==0u){return f.sky.xyz;}
 let h=vec3f(d.x,0.0,d.z);
 if(dot(h,h)<1e-12){return envSmooth(envUV(vec3f(0.0,0.0,-1.0)))*f.sky.w;}
 return envSmooth(envUV(normalize(h)))*f.sky.w;
}
// The glow of uniform fog seen along d: sky and sun light it scatters toward the viewer (no shadows).
fn fogHemiAt(u:f32)->f32 {
 let x=clamp((u+1.0)*7.5,0.0,15.0);let i=min(u32(x),14u);let fr=x-f32(i);
 return mix(f.fogHemi[i>>2u][i&3u],f.fogHemi[(i+1u)>>2u][(i+1u)&3u],fr);
}
fn fogGlow(d:vec3f)->vec3f {
 var l=horizonSky(vec3f(0.0,0.0,-1.0))*fogHemiAt(d.y);
 if((f.config.z&SUN)!=0u){
  let e=select(f.sunLight.xyz,f.sunLight.xyz*f.sunLight.w,f.sunLight.w>0.0);
  l+=e*hgPdf(dot(f.sun.xyz,d),f.fog.y);
 }
 return f.fogColor.xyz*l;
}
fn cone(axis:vec3f,cosMax:f32)->vec3f {
 let u=vec2f(rand(),rand());let c=1.0-u.x*(1.0-cosMax);let s=sqrt(max(0.0,1.0-c*c));let p=TAU*u.y;
 return basis(axis)*vec3f(s*cos(p),s*sin(p),c);
}
struct LightPoint {p:vec3f,n:vec3f,radiance:vec3f,pdfA:f32,twoSided:bool}
// An emissive voxel face: instance by its share of emitted power, face by its palette luminance, point uniform.
fn sampleEmitter()->LightPoint {
 var r:LightPoint;
 let u=rand();
 var lo=0u;var hi=f.lights.x-1u;
 while(lo<hi){let mid=(lo+hi)/2u;if(ll(f.lights.y+mid*2u+1u)<u){lo=mid+1u;}else{hi=mid;}}
 let inst=scene[f.lights.y+lo*2u];
 let ib=f.scene.y+inst*INSTANCE;
 let model=scene[ib+36u];let mb=f.scene.x+model*MODEL;
 let faces=scene[mb+8u];let count=scene[mb+9u];let total=fl(mb+10u);
 if(count==0u||total<=0.0){return r;}
 let u2=rand();
 lo=0u;hi=count-1u;
 while(lo<hi){let mid=(lo+hi)/2u;if(ll(faces+mid*3u+2u)<u2){lo=mid+1u;}else{hi=mid;}}
 // Three words per face: x | y << 16, z | face << 16 (a quarter face: bit 19, mid-cell 20, its halves 21-22),
 // cumulative probability (weighted by area, so the density below holds for quarters too).
 let c0=scene[faces+lo*3u];let c1=scene[faces+lo*3u+1u];
 let cell=vec3i(i32(c0&0xffffu),i32(c0>>16u),i32(c1&0xffffu));
 let face=(c1>>16u)&7u;let axis=face>>1u;let sg=select(-1.0,1.0,(face&1u)==0u);
 let a1=(axis+1u)%3u;let a2=(axis+2u)%3u;let quarter=((c1>>19u)&1u)!=0u;
 var lp=vec3f(cell)+vec3f(rand(),rand(),rand())*select(1.0,0.5,quarter);
 if(quarter){lp[a1]+=f32((c1>>21u)&1u)*0.5;lp[a2]+=f32((c1>>22u)&1u)*0.5;}
 lp[axis]=f32(cell[axis])+select(0.0,1.0,sg>0.0)-sg*0.5*f32((c1>>20u)&1u)+sg*EPS;
 let x=instX(inst);let w=x.world;let l=x.local;
 let area=length(cross(colOf(w,a1),colOf(w,a2)));
 let m=material(scene[mb+7u]|voxelAt(model,cell));
 r.p=xpoint(w,lp);
 r.n=sg*normalize(rowOf(l,axis));
 r.radiance=m.emission;
 r.pdfA=fl(ib+38u)*lum(m.emission)/total/area;
 return r;
}
fn sampleArea()->LightPoint {
 var r:LightPoint;
 let u=rand();
 var k=0u;
 for(;k+1u<f.config.w;k++){if(ll(f.lights.z+k*16u+3u)>=u){break;}}
 let b=f.lights.z+k*16u;
 let c=vec3f(ll(b),ll(b+1u),ll(b+2u));let eu=vec3f(ll(b+4u),ll(b+5u),ll(b+6u));let ev=vec3f(ll(b+8u),ll(b+9u),ll(b+10u));
 let pk=ll(b+3u)-select(0.0,ll(b-13u),k>0u);
 r.p=c+eu*rand()+ev*rand();
 r.n=normalize(cross(eu,ev));
 r.radiance=vec3f(ll(b+12u),ll(b+13u),ll(b+14u));
 r.pdfA=pk/ll(b+11u);
 r.twoSided=ll(b+7u)!=0.0;
 return r;
}
// Shadow rays toward distant lights through smooth glass and off mirrors are walked by the path loop itself (radiance,
// one closest-hit call for both): refraction with Fresnel transmission, entry tint, absorption and media, the product
// of the interfaces' solid-angle Jacobians dw(near) / dw(far), and the direction it finally leaves in. A vertex offers
// every candidate that needs such a walk with a selection weight and one is kept with probability weight / total
// (weighted reservoir sampling), its result scaled by total / weight: an unbiased estimate of their sum at the cost of
// one walk. light, lp: the light's radiance and density; f (BSDF value times light times total / weight) and pdf are
// filled in for the kept one.
struct Walk {total:f32,weight:f32,o:vec3f,d:vec3f,medium:u32,mInst:u32,s:vec3f,want:u32,light:vec3f,lp:f32,f:vec3f,pdf:f32}
fn offer(w:ptr<function,Walk>,weight:f32,o:vec3f,d0:vec3f,medium:u32,mInst:u32,s:vec3f,want:u32,light:vec3f,lp:f32) {
 (*w).total+=weight;
 if(rand()*(*w).total<weight){
  (*w).weight=weight;(*w).o=o;(*w).d=d0;(*w).medium=medium;(*w).mInst=mInst;(*w).s=s;(*w).want=want;(*w).light=light;
  (*w).lp=lp;
 }
}
fn prismAt(inst:u32)->bool {return (scene[f.scene.y+inst*INSTANCE+37u]&2u)!=0u;}
fn mirrorAt(inst:u32)->bool {return (scene[f.scene.y+inst*INSTANCE+37u]&4u)!=0u;}
fn isMirror(m:Mat)->bool {return m.metal>=1.0&&(m.flags&SMOOTH)!=0u;}
// Directions equal to float precision (refraction chains through axis faces reproduce them to about 1e-7); mirror
// candidates skip components smaller than SAME_C, whose flip would repeat a direction.
const SAME_C=1e-5;
// Selection weight of a candidate whose chain a box model makes unlikely (likely ones weigh 1).
const UNLIKELY=0.02;
fn same(a:vec3f,b:vec3f)->bool {let e=a-b;return dot(e,e)<SAME_C*SAME_C;}
fn rowSel(u0:vec3f,u1:vec3f,u2:vec3f,k:u32)->vec3f {return select(select(u2,u1,k==1u),u0,k==0u);}
fn comp(v:vec3f,k:u32)->f32 {return select(select(v.z,v.y,k==1u),v.x,k==0u);}
// Whether the ray o + t d (t > 0) meets the model box [0, sz] of an instance whose world-to-model transform is x.
// Where the ray o + t d (t > 0) meets the model box [0, sz] of an instance whose world-to-model transform is x: the
// axis of the face it enters through (0..2; 3 when it starts inside, 4 when it misses) and the distance to it.
fn boxEntry(x:Xform,sz:vec3f,o:vec3f,d:vec3f)->vec2f {
 let lo=xpoint(x,o);let inv=safeInv(xdir(x,d));
 let ta=-lo*inv;let tb=(sz-lo)*inv;let tn=min(ta,tb);let tf=max(ta,tb);
 let t0=max(max(tn.x,tn.y),tn.z);let t1=min(min(tf.x,tf.y),tf.z);
 if(!(t0<t1&&t1>0.0)){return vec2f(4.0,0.0);}
 if(t0<=0.0){return vec2f(3.0,0.0);}
 return vec2f(select(select(2.0,1.0,t0==tn.y),0.0,t0==tn.x),t0);
}
// The axis of the box face that a ray from inside (o, d) leaves through.
fn boxExit(x:Xform,sz:vec3f,o:vec3f,d:vec3f)->u32 {
 let lo=xpoint(x,o);let inv=safeInv(xdir(x,d));
 let tf=max(-lo*inv,(sz-lo)*inv);let t1=min(min(tf.x,tf.y),tf.z);
 return select(select(2u,1u,t1==tf.y),0u,t1==tf.x);
}
// Bits (1, 2, 4) of the axes along which v has a component that a mirror visibly flips.
fn flippable(v:vec3f,u0:vec3f,u1:vec3f,u2:vec3f)->u32 {
 return select(0u,1u,abs(dot(v,u0))>=SAME_C)|select(0u,2u,abs(dot(v,u1))>=SAME_C)|select(0u,4u,abs(dot(v,u2))>=SAME_C);
}
// v with the components along the unit axes u0, u1, u2 flipped where bits (1, 2, 4) are set.
fn flipped(v:vec3f,u0:vec3f,u1:vec3f,u2:vec3f,bits:u32)->vec3f {
 var r=v;
 if((bits&1u)!=0u){r-=2.0*dot(v,u0)*u0;}
 if((bits&2u)!=0u){r-=2.0*dot(v,u1)*u1;}
 if((bits&4u)!=0u){r-=2.0*dot(v,u2)*u2;}
 return r;
}
// Candidate directions d0 at a vertex for distant light leaving the glass in direction s (radiance light, density lp),
// offered for the shadow walk: want = NONE for chains that keep their direction after leaving the vertex's own glass,
// else the light-sampled instance that must turn it (exactly once); distinct candidates are distinct directions, so no
// chain is counted twice. Faces of a voxel instance have three orthogonal normals; mirrors (total internal
// reflection) flip components along them and refraction keeps the tangential component times the IOR ratio, so the
// directions that leave a light-sampled instance in s are: s mirrored along any axes (in and out through parallel
// faces) and, for IOR below sqrt 2, the per-axis magnitudes of Snell through two perpendicular faces with every sign. A
// mirror instance reflects s by each of its face orientations. The straight direction is direct()'s.
fn glassCandidates(kind:u32,m:Mat,n:vec3f,o:vec3f,medium:u32,mInst:u32,s:vec3f,light:vec3f,lp:f32,w:ptr<function,Walk>) {
 // Groups: inside glass the vertex's own instance (face k = j / 8, mirrors j % 8); outside, per light-sampled
 // instance, 7 mirrors and 6 x 8 perpendicular-face directions.
 let inGlass=medium!=0u&&(material(medium).flags&MEDIA)==0u;
 var ior=1.0;
 if(inGlass){let mm=material(medium);if(!clearGlass(mm)){return;}ior=mm.ior;}
 let gb=scene[scene[1]];
 let groups=select(1u+scene[scene[1]+1u],1u,inGlass);
 for(var g=select(1u,0u,inGlass);g<groups;g++){
  var inst=mInst;var eta=ior;var per=48u;var want=NONE;
  if(!inGlass){
   per=1u;
   if(g>0u){inst=scene[gb+g*2u-2u];eta=ll(gb+g*2u-1u);want=inst;per=select(select(55u,7u,eta*eta>=2.0),6u,eta==0.0);}
  }
  // The instance's frame (unit face normals) and box, read once per group (none for the straight direction).
  var u0=vec3f(1.0,0.0,0.0);var u1=vec3f(0.0,1.0,0.0);var u2=vec3f(0.0,0.0,1.0);
  var x:Xform;var sz=vec3f(0.0);
  if(inGlass||g>0u){
   x=localX(inst);u0=normalize(x.r0.xyz);u1=normalize(x.r1.xyz);u2=normalize(x.r2.xyz);
   let mb=f.scene.x+scene[f.scene.y+inst*INSTANCE+36u]*MODEL;
   sz=vec3f(f32(scene[mb]),f32(scene[mb+1u]),f32(scene[mb+2u]));
  }
  let c=vec3f(dot(s,u0),dot(s,u1),dot(s,u2));
  let mirrors=inGlass&&prismAt(inst);
  for(var j=0u;j<per;j++){
   var d0=s;var weight=1.0;
   if(inGlass){
    // Out through face k after mirrors b (never along k's own axis).
    let k=j>>3u;let b=j&7u;
    let nout=select(-1.0,1.0,(k&1u)==0u)*rowSel(u0,u1,u2,k>>1u);
    if(dot(nout,s)<=0.0||(b!=0u&&!mirrors)){continue;}
    let tin=refract(-s,nout,1.0/eta);
    if(dot(tin,tin)<0.5){continue;}
    if((b&~(flippable(tin,u0,u1,u2)&~(1u<<(k>>1u))))!=0u){continue;}
    d0=-flipped(tin,u0,u1,u2,b);
    // Selection weight: in a box, the ray first reaches face k (no mirror) or a mirroring face.
    let first=boxExit(x,sz,o,d0);
    // Equal-direction inverse Snell solutions are one proposal, even when
    // several exit normals produce it. The box exit picks its representative.
    if(b==0u&&same(d0,s)&&first!=(k>>1u)){continue;}
    if((b==0u&&first!=(k>>1u))||(b!=0u&&(b&(1u<<first))==0u)){weight=UNLIKELY;}
   } else if(g>0u){
    // The axes the walk should enter the instance's box through and, for glass, the first faces it should meet inside
    // (bits), for the selection weight.
    var axes=7u;var inner=0u;
    if(eta==0.0){
     // Reflected by a mirror face k toward the vertex.
     let nk=select(-1.0,1.0,(j&1u)==0u)*rowSel(u0,u1,u2,j>>1u);
     if(dot(nk,s)<=0.0){continue;}
     d0=reflect(s,nk);axes=1u<<(j>>1u);
    } else if(j<7u){
     // In and out through parallel faces with mirrors between: s mirrored (never along the entry axis, IOR >= sqrt 2).
     if(((j+1u)&~flippable(s,u0,u1,u2))!=0u){continue;}
     d0=flipped(s,u0,u1,u2,j+1u);axes=select(7u,7u&~(j+1u),eta*eta>=2.0);inner=j+1u;
    } else {
     // In through a face of axis a (vertex side), out through one of axis b: magnitudes per axis, then every sign.
     let pair=(j-7u)>>3u;let sg=(j-7u)&7u;
     let a=pair>>1u;let bb=(a+1u+(pair&1u))%3u;let cc=3u-a-bb;
     let tA=abs(comp(c,a))/eta;let dC=abs(comp(c,cc));let tC=dC/eta;
     let tB2=1.0-tA*tA-tC*tC;
     if(tB2<0.0){continue;}
     let dB=eta*sqrt(tB2);
     let dA2=1.0-dB*dB-dC*dC;
     if(dA2<0.0){continue;}
     // Selects, not dynamic indexing (which can push the vector to memory).
     let ax=vec3u(0u,1u,2u);
     let mag=select(vec3f(0.0),vec3f(sqrt(dA2)),ax==vec3u(a))+select(vec3f(0.0),vec3f(dB),ax==vec3u(bb))+select(vec3f(0.0),vec3f(dC),ax==vec3u(cc));
     let signs=select(0u,1u,mag.x>=SAME_C)|select(0u,2u,mag.y>=SAME_C)|select(0u,4u,mag.z>=SAME_C);
     if((sg&~signs)!=0u){continue;}
     let q=select(mag,-mag,vec3<bool>((sg&1u)!=0u,(sg&2u)!=0u,(sg&4u)!=0u));
     d0=q.x*u0+q.y*u1+q.z*u2;axes=1u<<a;inner=1u<<bb;
    }
    let be=boxEntry(x,sz,o,d0);let entry=u32(be.x);
    if(entry==4u){continue;}
    // Selection weight: unlikely chains (another entry face, which needs a non-convex model, or another first face
    // inside the box than the chain's) are rarely walked and weighted accordingly.
    if(entry<3u&&(axes&(1u<<entry))==0u){weight=UNLIKELY;}
    else if(entry<3u&&eta>0.0&&inner!=0u){
     let ue=rowSel(u0,u1,u2,entry);let ne=select(ue,-ue,dot(d0,ue)>0.0);
     let ti=refract(d0,ne,1.0/eta);
     if((inner&(1u<<boxExit(x,sz,o+d0*be.y,ti)))==0u){weight=UNLIKELY;}
    }
   }
   // A surface's own back side cannot see the light (the BSDF of the kept one is evaluated by direct()).
   if(kind==0u&&m.glass==0.0&&dot(n,d0)<=0.0){continue;}
   offer(w,weight,o,d0,medium,mInst,s,want,light,lp);
  }
 }
}
// Next-event estimation at a surface (kind 0, over the lobes in mask: 1 diffuse, 2 glossy) or a medium scattering
// point (kind 1): one sample of each light kind,
// all through one BSDF evaluation and one shadow ray (the shader stays small): 0 the sun, 1 an emissive face, 2 an
// area light, 3 the environment; 4 evaluates the BSDF for the glass walk kept among the candidates. Distant lights also
// through smooth glass (straight chains blocked by it and the candidates of glassCandidates are walked by the path
// loop); emissive voxels and area lights from outside glass only.
fn direct(kind:u32,m:Mat,n:vec3f,wo:vec3f,o:vec3f,medium:u32,mInst:u32,w:ptr<function,Walk>,mask:u32)->vec3f {
 var L=vec3f(0.0);
 let air=medium==0u||(material(medium).flags&MEDIA)!=0u;
 for(var q=0u;q<5u;q++){
  var wi=vec3f(0.0);var dist=INF;var radiance=vec3f(0.0);var lp=0.0;var far=false;
  // In uniform fog distant lights are out of reach (their light arrives through the fog's glow).
  let fogged=f.fog.z>0.0;
  if(q==0u){
   if(fogged||(f.config.z&SUN)==0u||(kind==1u&&(f.config.z&NO_SUN_MEDIA)!=0u&&(m.flags&SUNLIT)==0u)){continue;}
   wi=f.sun.xyz;
   if(f.sunLight.w>0.0){wi=cone(f.sun.xyz,f.sun.w);}
   radiance=f.sunLight.xyz;lp=select(0.0,1.0/f.sunLight.w,f.sunLight.w>0.0);far=true;
  } else if(q<3u){
   if(!air||(q==1u&&f.lights.x==0u)||(q==2u&&(f.config.z&AREA_NEE)==0u)){continue;}
   var ls:LightPoint;
   if(q==1u){ls=sampleEmitter();}else{ls=sampleArea();}
   if(ls.pdfA<=0.0){continue;}
   let v=ls.p-o;let d2=dot(v,v);dist=sqrt(d2);wi=v/dist;
   var cl=-dot(ls.n,wi);
   if(ls.twoSided){cl=abs(cl);}
   if(cl<=0.0){continue;}
   radiance=ls.radiance;lp=ls.pdfA*d2/cl;
  } else if(q==3u){
   if(fogged||(f.config.z&ENV)==0u){continue;}
   let ew=f.env.x;let eh=f.env.y;
   let u1=rand();
   var lo=0u;var hi=eh-1u;
   while(lo<hi){let mid=(lo+hi)/2u;if(ll(f.env.z+mid)<u1){lo=mid+1u;}else{hi=mid;}}
   let row=lo;let cb=f.env.w+row*ew;let u2=rand();
   lo=0u;hi=ew-1u;
   while(lo<hi){let mid=(lo+hi)/2u;if(ll(cb+mid)<u2){lo=mid+1u;}else{hi=mid;}}
   let uv=vec2f((f32(lo)+rand())/f32(ew),(f32(row)+rand())/f32(eh));
   let phi=(uv.x-0.5)*TAU+f.weights.y;let th=uv.y*PI;
   wi=vec3f(sin(th)*sin(phi),cos(th),-sin(th)*cos(phi));
   let t=envmap[row*ew+lo];
   lp=envPdf(wi,t);
   if(lp<=0.0){continue;}
   radiance=envSmooth(envUV(wi))*f.sky.w;far=true;
  } else {
   if((*w).total==0.0){continue;}
   wi=(*w).d;
  }
  // With the sun on diffuse lobes only, nothing else finds it: its light-sampled share is the whole estimate.
  let sunOnly=q==0u&&(f.config.z&SUN_DIFFUSE)!=0u;
  let lobes=select(mask,mask&1u,sunOnly);
  if(kind==0u&&lobes==0u){continue;}
  let e=evalAt(kind,m,n,wo,wi,lobes);
  if(q==4u){
   if(any(e.f>vec3f(0.0))){(*w).f=e.f*(*w).light*((*w).total/(*w).weight);(*w).pdf=e.pdf;}else{(*w).total=0.0;}
   continue;
  }
  // The straight direction (not from inside glass, where glassCandidates finds the ways out).
  if(any(e.f>vec3f(0.0))&&(air||!far)){
   sunCell=q==0u&&kind==1u&&(m.flags&SUNLIT)!=0u&&!sunFace;
   var v=shadow(o,wi,dist);
   sunCell=false;
   if(fogged&&!far){v*=exp(-f.fog.x*dist);}
   if(v>0.0){L+=e.f*radiance*v*select(1.0,select(power2(lp,e.pdf),1.0,sunOnly)/lp,lp>0.0);}
   else if(far&&!sunOnly&&(f.config.z&CLEAR_GLASS)!=0u){offer(w,1.0,o,wi,medium,mInst,wi,NONE,radiance,lp);}
  }
  if(far&&!sunOnly){glassCandidates(kind,m,n,o,medium,mInst,wi,radiance,lp,w);}
 }
 return L;
}
// Weight of an emissive face found by BSDF sampling against light sampling of the same face.
fn emitWeight(h:Hit,n:vec3f,d:vec3f,radiance:vec3f,lastPdf:f32)->f32 {
 if(lastPdf<=0.0){return 1.0;}
 let ib=f.scene.y+h.inst*INSTANCE;
 let pick=fl(ib+38u);
 let total=fl(f.scene.x+scene[ib+36u]*MODEL+10u);
 if(pick<=0.0||total<=0.0){return 1.0;}
 let w=worldX(h.inst);
 let area=length(cross(colOf(w,(h.axis+1u)%3u),colOf(w,(h.axis+2u)%3u)));
 let lp=pick*lum(radiance)/total/area*h.t*h.t/max(-dot(n,d),1e-6);
 return power2(lastPdf,lp);
}
fn areaHit(k:u32,d:vec3f,t:f32,lastPdf:f32)->vec3f {
 let b=f.lights.z+k*16u;
 let radiance=vec3f(ll(b+12u),ll(b+13u),ll(b+14u));
 let n=normalize(cross(vec3f(ll(b+4u),ll(b+5u),ll(b+6u)),vec3f(ll(b+8u),ll(b+9u),ll(b+10u))));
 // The back of a one-sided solid light is black.
 if(ll(b+7u)==0.0&&dot(d,n)>0.0){return vec3f(0.0);}
 if(lastPdf<=0.0){return radiance;}
 let pk=ll(b+3u)-select(0.0,ll(b-13u),k>0u);
 let lp=pk/ll(b+11u)*t*t/max(abs(dot(n,d)),1e-6);
 return radiance*power2(lastPdf,lp);
}
fn roulette(thr:ptr<function,vec3f>,bounces:u32)->bool {
 if(bounces<3u){return true;}
 let q=clamp(max(max((*thr).x,(*thr).y),(*thr).z),0.05,1.0);
 if(rand()>=q){return false;}
 *thr/=q;
 return true;
}

// caustic: the part of color that arrived after a diffuse-like vertex was followed by a specular or glossy one
// (light focused by glass and mirrors onto diffuse surfaces); the denoiser filters it separately and more widely.
// primary: 1 when the albedo and normal are the first hit's (0 when seen through glass or a mirror).
struct Path {color:vec3f,albedo:vec3f,normal:vec3f,inv:f32,caustic:vec3f,primary:f32}
fn radiance(px:vec2u)->Path {
 var res:Path;
 var jit=vec2f(0.5);
 if((f.config.z&JITTER)!=0u){jit=vec2f(rand(),rand());}
 motion=1.0;
 if((f.config.z&MOTION)!=0u){motion=1.0-f.weights.z*rand();}
 let ray=cameraRay(vec2f(px)+jit);
 if(dot(ray.d,ray.d)==0.0){res.albedo=vec3f(0.0);res.primary=1.0;return res;}
 var o=ray.o;var d=ray.d;
 var thr=vec3f(1.0);var L=vec3f(0.0);
 var medium=0u;var mInst=NONE;
 var mediaAdvance=false;var walkAdvance=false;
 var lastPdf=0.0;
 // Light PDFs use the distance from the last scattering vertex, including
 // non-scattering medium boundaries crossed since then, rather than the last segment.
 var lastVertex=o;
 var bounces=0u;
 // Events per kind for the caps in f.limits: diffuse, specular (low 16 bits of y), scatter (low 16 bits of z),
 // scattering in sun-lit media (subsurface, high 16 bits of z); reflections inside glass (high 16 bits of y: kept in
 // full up to that many, each one after continues with probability 1/2).
 var nd=0u;var ns=0u;var nm=0u;var nu=0u;var nir=0u;
 var feature=true;var tint=vec3f(1.0);var primary=true;
 var diffuse=false;var focused=false;var C=vec3f(0.0);
 // Distant-light MIS: density of the last vertex that sampled distant lights, Jacobian of the refractions since,
 // whether the chain is one light sampling also builds (smooth transmissions, mirrors inside light-sampled glass),
 // whether it has left the start vertex's own glass, and the crossings since that turned it (light sampling builds at
 // most one, by a light-sampled instance, and none when the vertex is inside glass).
 var sunPdf=0.0;var jChain=1.0;var chainOk=false;var chainSet=false;
 var glassStart=false;var deflections=0u;var deflectOk=true;var entryDir=vec3f(0.0);
 // Wavelength of the path (nanometres) once dispersive glass has been met, or fixed for the whole frame.
 var lambda=bitcast<f32>(f.lights.w);
 // The shadow walk a vertex left (pending), being walked (walking): ray, medium, transmittance, Jacobian, turns and
 // the instance of the last, whether the current glass was entered from air and in which direction; then its weight.
 var pending=false;var walking=false;var done=false;
 var wo=vec3f(0.0);var wd=vec3f(0.0);var wMedium=0u;var wInst=NONE;var wT=vec3f(1.0);var wJ=1.0;var wN=0u;var wG=NONE;
 var wEntered=false;var wIn=vec3f(0.0);var wSteps=0u;var wS=vec3f(0.0);var wWant=NONE;var wAdd=vec3f(0.0);
 var wLp=0.0;var wPdf=0.0;var wCaustic=false;
 res.albedo=vec3f(1.0);res.normal=-d;res.primary=1.0;
 let limit=f.config.x*4u+16u+(f.config.x+1u)*16u;
 for(var it=0u;it<limit;it++){
  if(pending){
   pending=false;walking=true;wT=vec3f(1.0);wJ=1.0;wN=0u;wG=NONE;wEntered=false;wIn=wd;wSteps=0u;
  }
  if(!walking&&done){break;}
  let h=mediumClosest(select(o,wo,walking),select(d,wd,walking),select(medium,wMedium,walking),select(mInst,wInst,walking),select(mediaAdvance,walkAdvance,walking));
  if(walking){walkAdvance=false;}else{mediaAdvance=false;}
  if(walking){
   // One step of the shadow walk.
   wSteps++;
   var stop=false;var ok=false;
   if(wMedium!=0u){let md=mediumOf(wMedium);wT*=exp(-(md.absorb+md.sigma)*min(h.t,1e30));}
   if(h.inst==NONE){stop=true;ok=same(wd,wS)&&select(wN==1u&&wG==wWant,wN==0u,wWant==NONE);}
   else if(h.inst==GROUND||wSteps>16u){stop=true;}
   else if(h.inst==AREA){if(opaqueArea(h.value)){stop=true;}else{wo=wo+wd*(h.t+1e-4*max(1.0,h.t));}}
   else {
    let wp=wo+wd*h.t;
    let wn=h.sgn*normalize(rowOf(localX(h.inst),h.axis));
    let woff=h.sgn*EPS*colOf(worldX(h.inst),h.axis);
    let wGlass=wMedium!=0u&&(material(wMedium).flags&MEDIA)==0u;
    let ci=-dot(wn,wd);
    if(h.value==0u){
     let ma=material(wMedium);
     if((ma.flags&MEDIA)!=0u){wMedium=0u;wInst=NONE;wo=wp;walkAdvance=true;}
     else if(!clearGlass(ma)){stop=true;}
     else {
      let fr=fresnel(ci,ma.ior);
      if(fr>=1.0){
       // Total internal reflection: part of the chain in light-sampled instances only (as on the path side).
       if(!prismAt(wInst)){stop=true;}else{wd=reflect(wd,wn);wo=wp+woff;}
      } else {
       let dt=refract(wd,wn,ma.ior);
       wT*=1.0-fr;wJ*=-dot(wn,dt)/(ma.ior*ma.ior*ci);
       if(wEntered&&!same(dt,wIn)){wN++;wG=wInst;}
       wEntered=false;wMedium=0u;wInst=NONE;wo=wp-woff;wd=dt;
      }
     }
    } else {
     let mb=material(h.value);
     // Glass to media or to other glass: left to path sampling (the path side ends its chain there too).
     if(wGlass||(mb.flags&SUBSURFACE)!=0u){stop=true;}
     else if((mb.flags&MEDIA)!=0u){wMedium=h.value;wInst=h.inst;wo=wp;walkAdvance=true;}
     else if(isMirror(mb)&&mirrorAt(h.inst)){wT*=schlick3(mb.metalColor,ci);wN++;wG=h.inst;wd=reflect(wd,wn);wo=wp+woff;}
     else if(mb.glass<0.999||!clearGlass(mb)){stop=true;}
     else {
      let eta=1.0/mb.ior;
      let fr=fresnel(ci,eta);
      let dt=refract(wd,wn,eta);
      wT*=select(mb.color,vec3f(1.0),(mb.flags&UNTINTED)!=0u)*(1.0-fr);wJ*=-dot(wn,dt)/(eta*eta*ci);
      wEntered=true;wIn=wd;wMedium=h.value;wInst=h.inst;wo=wp-woff;wd=dt;
     }
    }
   }
   if(stop){
    walking=false;
    if(ok&&any(wT>vec3f(0.0))){
     let add=wAdd*wT*wJ*select(1.0,power2(wLp/wJ,wPdf)/wLp,wLp>0.0);L+=add;if(wCaustic){C+=add;}
    }
   }
   continue;
  }
  if(primary){
   primary=false;
   // The first hit's distance along the pixel centre's ray to the plane of the face this sample hit (camera rays): the
   // denoiser places first hits on centre rays, where a jittered sample's own distance lies up to half a pixel off
   // along the surface, which moves its history every frame the camera moves.
   var tc=h.t;
   if(f.projection.x==0u&&f.projection.z==0u&&h.inst!=NONE&&h.inst!=AREA){
    var n=vec3f(0.0,1.0,0.0);
    if(h.inst!=GROUND){n=rowOf(localX(h.inst),h.axis);}
    let mo=motion;motion=1.0;let c=viewRay(vec2f(px)+0.5);motion=mo;
    let den=dot(n,c.d);
    if(abs(den)>1e-4*length(n)){let t2=dot(n,o+d*h.t-c.o)/den;if(abs(t2-h.t)<0.5*h.t){tc=t2;}}
   }
   res.inv=select(0.0,1.0/max(tc,1e-6),h.inst!=NONE);
  }
  // Uniform fog outside volumes: the segment fades toward the fog's glow (all of it for a ray leaving the scene).
  if(f.fog.z>0.0&&medium==0u){
   let dl=length(d);let tr=select(exp(-f.fog.x*h.t*dl),0.0,h.inst==NONE);
   let add=thr*fogGlow(d/dl)*(1.0-tr);L+=add;if(focused){C+=add;}
   thr*=tr;
   if(h.inst==NONE){break;}
  }
  // The vertex: a scattering point in a medium (kind 1) or a surface (kind 0); light sampling is called from one place
  // for both (the shader stays small).
  var scatter=false;var p=o+d*h.t;
  if(medium!=0u){
   let md=mediumOf(medium);
   var ts=INF;
   if(md.sigma>0.0){ts=-log(1.0-rand())/md.sigma;}
   // Emission along the segment by the track-length estimator: E[j min(ts, t)] = j (1 - e^(-sigma t)) / sigma.
   if(any(md.emit!=vec3f(0.0))){let add=thr*md.emit*min(ts,min(h.t,1e30));L+=add;if(focused){C+=add;}}
   if(md.sigma>0.0){
    if(ts<h.t){
     thr*=exp(-md.absorb*ts)*md.albedo;
     p=o+d*ts;
     if(feature){feature=false;res.albedo=tint*md.albedo;res.normal=-d;res.primary=select(0.0,1.0,bounces==0u);}
     // Sun-lit media: each diffuse event before takes 4 from the subsurface cap (MagicaVoxel's neighbours of subsurface
     // blocks under diffuse caps 2 and 4).
     let mf=material(medium).flags;
     if((mf&SUBSURFACE)!=0u){if(nu>=min(f.limits.z>>16u,WALK)){break;}nu++;}
     else{
      bounces++;
      if((mf&SUNLIT)!=0u){if(bounces>f.config.x||nu+4u*nd>=(f.limits.z>>16u)){break;}nu++;}
      else{if(bounces>f.config.x||nm>=(f.limits.z&0xffffu)){break;}nm++;}
     }
     scatter=true;
    }
   }
   if(!scatter){thr*=exp(-md.absorb*h.t);}
  }
  var n=vec3f(0.0);var off=vec3f(0.0);var m:Mat;var soft=true;var skinOut=false;
  if(scatter){m=material(medium);}
  else {
   if(h.inst==NONE){
    let kept=chainOk&&chainSet&&(deflections==0u||(deflections==1u&&deflectOk&&!glassStart));
    let bg=bounces==0u&&f.background.w>0.0;
    let add=thr*select(environment(d,select(0.0,sunPdf,kept),jChain,bounces==0u),f.background.xyz,bg);L+=add;if(focused){C+=add;}
    break;
   }
   if(h.inst==AREA){
    let add=thr*areaHit(h.value,d,distance(p,lastVertex),lastPdf);L+=add;if(focused){C+=add;}
    if(feature){feature=false;res.albedo=tint;res.normal=-d;res.primary=select(0.0,1.0,bounces==0u);}
    break;
   }
   // Seen by the camera, the ground (and models, when asked) at distance D fades into the sky behind it by
   // 1 - e^(-(D - start) / fade).
   let fade=bitcast<f32>(f.limits.w);
   if(bounces==0u&&fade>0.0&&f.fog.z==0.0&&(h.inst==GROUND||f.groundFade.y>0.0)){
    let w=1.0-exp(-max(0.0,h.t*length(d)-f.groundFade.x)/fade);
    let add=thr*w*skyBehind(d);L+=add;thr*=1.0-w;
   }
   if(h.inst==GROUND){
    // The plane coordinate is known exactly. An orthographic near plane can be thousands of units away: the
    // cancellation in o + d*t can leave p below ground by more than off, making its own outgoing rays hit it again.
    p.y=f.ground.w;
    n=vec3f(0.0,select(-1.0,1.0,d.y<0.0),0.0);
    off=n*max(1e-4,1e-6*length(p));
    m=groundMat();
    if(bounces==0u&&f.grid2.y>0.0&&gridLine(p,n)){m=lineMat(f.grid.xyz);}
   } else {
    let lx=localX(h.inst);let lp=xpoint(lx,p);
    n=h.sgn*normalize(rowOf(lx,h.axis));
    off=h.sgn*EPS*colOf(worldX(h.inst),h.axis);
    // Leaving a contact-transmitting blend into the air: the glass share over (1 - 0.4 metal) passes, the rest scatters
    // back inside off the blend's other lobes (a diffuse event). Without metal that is the glass share itself; with it,
    // MagicaVoxel lets more light out than the share its metal leaves (B boards: half metal, half glass over white).
    var inner=false;
    let other=h.value==0u||(material(h.value).flags&(MEDIA|SUBSURFACE))==MEDIA;
    skinOut=other&&medium!=0u&&(material(medium).flags&SUBSURFACE)!=0u;
    if(h.value==0u&&medium!=0u){let mc=material(medium);if((mc.flags&CONTACT)!=0u&&rand()>=mc.glass/max(1e-6,1.0-0.4*mc.metal)){inner=true;}}
    if(h.value==0u&&!inner&&!skinOut){
     // Leaving a volume into empty space: media end without a surface, glass refracts out or reflects back in.
     var mm=material(medium);
     if((mm.flags&MEDIA)!=0u){medium=0u;mInst=NONE;o=p;mediaAdvance=true;continue;}
     if(mm.disp>0.0){collapse(&lambda,&thr);mm.ior=iorAt(mm,lambda);}
     let sm=(mm.flags&SMOOTH)!=0u;
     let s=dielectric(mm.alpha,n,-d,mm.ior,sm);
     if(!s.ok){break;}
     focused=focused||diffuse;
     if(s.transmit&&clearGlass(mm)){
      jChain*=abs(dot(n,s.wi))/(mm.ior*mm.ior*dot(n,-d));
      if(!chainSet){chainSet=true;}
      else if(!same(s.wi,entryDir)){deflections++;deflectOk=deflectOk&&prismAt(mInst);}
     } else if(!(clearGlass(mm)&&prismAt(mInst)&&fresnel(dot(n,-d),mm.ior)>=1.0)){chainOk=false;}
     thr*=s.w;
     if(feature){tint*=guideWeight(s,mm.alpha,n,-d,mm.ior,sm);}
     if(s.transmit){medium=0u;mInst=NONE;o=p-off;}
     else{nir++;if(nir>(f.limits.y>>16u)&&rand()<0.5){break;}o=p+off;}
     d=s.wi;lastPdf=0.0;
     bounces++;
     if(bounces>f.config.x||ns>=(f.limits.y&0xffffu)){break;}
     ns++;
     if(!roulette(&thr,bounces)){break;}
     continue;
    }
    m=material(h.value);
    if(skinOut){
     m=lineMat(vec3f(1.0));n=-n;off=-off;d=reflect(d,n);
     medium=h.value;mInst=select(NONE,h.inst,h.value!=0u);
    }
    else if(inner){m=material(medium);m.glass=0.0;}
    else if((m.flags&MEDIA)!=0u){
     if(medium!=0u&&(material(medium).flags&MEDIA)==0u){chainOk=false;}
     sunFace=dot(n,f.sun.xyz)>0.0;
     if((m.flags&SUBSURFACE)!=0u&&(medium==0u||(material(medium).flags&SUBSURFACE)==0u)){
      if(nd>=f.limits.x||bounces>=f.config.x){break;}
      if(feature){feature=false;res.albedo=tint*m.color;res.normal=n;res.primary=select(0.0,1.0,bounces==0u);}
      nd++;bounces++;diffuse=true;
      medium=h.value;mInst=h.inst;o=p;d=cosineDir(-n);mediaAdvance=true;
      lastPdf=0.0;lastVertex=o;sunPdf=0.0;chainOk=false;
      continue;
     }
     medium=h.value;mInst=h.inst;o=p;mediaAdvance=true;continue;
    }
    if(!inner&&!skinOut){let tex=faceTexel(h,lp).rgb;m.color*=tex;m.metalColor*=tex;}
    // Edge bands and grid lines on what the camera sees (MagicaVoxel's display settings): the line colour, lit.
    if(bounces==0u&&medium==0u){
     if(f.edges.w>0.0&&edgeBand(h,lp)){m=lineMat(f.edges.xyz);}
     else if(f.grid2.y>1.5&&gridLine(p,n)){m=lineMat(f.grid.xyz);}
    }
   }
   if((m.flags&EMISSIVE)!=0u||m.seen.w>0.0){
    // Camera rays (nothing scattered yet) see the camera radiance when one is set.
    let e=select(m.emission,m.seen.xyz,bounces==0u&&m.seen.w>0.0);
    var lightHit=h;lightHit.t=distance(p,lastVertex);
    let add=thr*e*emitWeight(lightHit,n,d,m.emission,lastPdf);L+=add;if(focused){C+=add;}
   }
   let pb=max(0.0,1.0-m.metal-m.glass);
   soft=pb>1e-6||((m.flags&SMOOTH)==0u&&m.metal>0.0);
   if(feature&&(soft||bounces>=3u)){feature=false;res.albedo=tint*m.color;res.normal=n;res.primary=select(0.0,1.0,bounces==0u);}
  }
  // A surface vertex reached after maxBounces scattering events (bounces counts them) samples no light: it would be one
  // event too many, and only the light-sampled MIS share of that longer path, since the same limit cuts its BSDF share
  // below. A medium vertex checks its count where it scatters.
  // Light sampled at a glossy metal seen from a diffuse vertex is a caustic too (light focused by the metal).
  let skinIn=medium!=0u&&(material(medium).flags&SUBSURFACE)!=0u&&!skinOut;
  if(soft&&!skinIn&&(scatter||bounces<f.config.x)){
   var walk:Walk;
   let lobes=select(0u,1u,nd<f.limits.x)|select(0u,2u,ns<(f.limits.y&0xffffu));
   let add=thr*direct(select(0u,1u,scatter),m,n,-d,p+off,medium,mInst,&walk,lobes);L+=add;
   let caustic=focused||(diffuse&&!scatter&&m.metal>0.5&&m.alpha<GLOSSY);
   if(caustic){C+=add;}
   if(walk.total>0.0){
    // Walked from the next loop turn on; the path resumes after it.
    pending=true;wo=walk.o;wd=walk.d;wMedium=walk.medium;wInst=walk.mInst;wS=walk.s;wWant=walk.want;
    wAdd=thr*walk.f;wLp=walk.lp;wPdf=walk.pdf;wCaustic=caustic;
   }
  }
  if(scatter){
   let md=mediumOf(medium);
   diffuse=true;
   let wi=sampleHg(d,md.g);
   lastPdf=select(0.0,hgPdf(dot(d,wi),md.g),md.media&&!skinIn);
   lastVertex=p;
   sunPdf=hgPdf(dot(d,wi),md.g);jChain=1.0;chainOk=true;chainSet=md.media;
   if(skinIn){chainOk=false;}
   glassStart=!md.media;deflections=0u;deflectOk=true;
   o=p;d=wi;
   if(!roulette(&thr,bounces)){done=true;}
   continue;
  }
  let inAir=medium==0u||(material(medium).flags&MEDIA)!=0u;
  let wo=-d;
  var etaI=1.0;
  if(!inAir){var mi=material(medium);if(mi.disp>0.0){collapse(&lambda,&thr);mi.ior=iorAt(mi,lambda);}etaI=mi.ior;}
  if(m.disp>0.0&&m.glass>0.0){collapse(&lambda,&thr);m.ior=iorAt(m,lambda);}
  let s=sampleSurface(m,n,wo,etaI);
  if(!s.ok){done=true;continue;}
  // Straight through a voxel face inside a voxelwise volume: not a scattering event.
  let through=s.lobe==3u&&s.transmit&&!inAir&&medium==h.value&&(m.flags&VOXELWISE)!=0u;
  if(through){medium=h.value;mInst=h.inst;o=p-off;continue;}
  if(s.lobe==0u){if(nd>=f.limits.x){done=true;continue;}nd++;}
  else{if(ns>=(f.limits.y&0xffffu)){done=true;continue;}ns++;}
  if(s.lobe<=1u){
   // A new chain starts here; light sampling of distant lights ran unless the vertex is inside rough glass.
   let roughGlass=!inAir&&!clearGlass(material(medium));
   sunPdf=select(s.pdf,0.0,roughGlass);jChain=1.0;chainOk=true;chainSet=inAir;
   glassStart=!inAir;deflections=0u;deflectOk=true;
  } else if(s.lobe==3u&&s.transmit&&clearGlass(m)&&m.glass>=0.999&&inAir){
   // Into pure smooth glass from air or media (light sampling does not refract glass into glass or mixed voxels).
   jChain*=abs(dot(n,s.wi))*m.ior*m.ior/dot(n,wo);
   entryDir=d;
  } else if(s.lobe==2u&&isMirror(m)&&inAir&&h.inst!=GROUND&&mirrorAt(h.inst)){
   deflections++;
  } else {chainOk=false;}
  // Diffuse-like after this vertex: cosine lobes and rough microfacets; specular: mirrors, glass, glossy (alpha < 0.1).
  if(s.lobe==0u||(s.lobe==1u&&m.alpha>=GLOSSY)){diffuse=true;}else{focused=focused||diffuse;}
  thr*=s.w;
  if(s.transmit){
   if(h.inst==GROUND){done=true;continue;}
   medium=h.value;mInst=h.inst;o=p-off;if((m.flags&UNTINTED)==0u){thr*=m.color;}
  } else {o=p+off;}
  if(feature){tint*=guideWeight(s,m.alpha,n,wo,etaI/m.ior,(m.flags&SMOOTH)!=0u);}
  d=s.wi;lastPdf=select(0.0,s.pdf,inAir&&!skinIn);lastVertex=o;if(skinIn){chainOk=false;}
  bounces++;
  if(bounces>f.config.x||!roulette(&thr,bounces)){done=true;}
 }
 res.color=L;res.caustic=C;
 if((f.config.z&CLAMP)!=0u){let l=lum(res.color);if(l>f.weights.w){res.color*=f.weights.w/l;res.caustic*=f.weights.w/l;}}
 // Finite values only (dispersive paths may carry negative channel weights; their mean is right).
 if(!all(abs(res.color)<vec3f(1e30))||!all(abs(res.caustic)<vec3f(1e30))){res.color=vec3f(0.0);res.caustic=vec3f(0.0);}
 return res;
}

@compute @workgroup_size(8,8) fn trace(@builtin(global_invocation_id) gid:vec3u) {
 if(gid.x>=f.tile.x||gid.y>=f.tile.y){return;}
 let px=vec2u(gid.x+f.image.z,gid.y+f.image.w);
 let pixel=px.y*f.image.x+px.x;
 let slot=gid.y*f.tile.x+gid.x;
 var c=vec4f(0.0);var a=vec4f(0.0);var nn=vec4f(0.0);var cs=vec4f(0.0);
 let split=(f.config.z&SPLIT)!=0u;
 for(var s=0u;s<f.tile.w;s++){
  rng=hash((pixel*0x9e3779b1u)^hash(f.tile.z+s+hash(f.config.y)));
  let r=radiance(px);
  let l=select(lum(r.color),lum(r.color-r.caustic),split);let lc=lum(r.caustic);
  c+=vec4f(r.color,l*l);
  cs+=vec4f(r.caustic,lc*lc);
  a+=vec4f(r.albedo,r.inv);
  nn+=vec4f(r.normal,r.primary);
 }
 if(f.tile.z==0u){accum[slot]=c;albedo[slot]=a;normals[slot]=nn;if(split){caustics[slot]=cs;}}
 else{accum[slot]+=c;albedo[slot]+=a;normals[slot]+=nn;if(split){caustics[slot]+=cs;}}
}

// Preview while the full tracer compiles (a small kernel compiles in a fraction of the time): the first hit lit by the
// sky behind its normal and the sun (one shadow ray), misses showing the sky or the background; one sample, written
// over the image.
@compute @workgroup_size(8,8) fn preview(@builtin(global_invocation_id) gid:vec3u) {
 if(gid.x>=f.tile.x||gid.y>=f.tile.y){return;}
 motion=1.0;
 let ray=viewRay(vec2f(f32(gid.x+f.image.z)+0.5,f32(gid.y+f.image.w)+0.5));
 var c=vec3f(0.0);
 if(dot(ray.d,ray.d)>0.0){
  let h=closest(ray.o,ray.d,0u,NONE);
  if(h.inst==NONE){c=select(environment(ray.d,0.0,1.0,true),f.background.xyz,f.background.w>0.0);}
  else if(h.inst==AREA){c=areaHit(h.value,ray.d,h.t,0.0);}
  else {
   var p=ray.o+ray.d*h.t;
   var n=vec3f(0.0,1.0,0.0);var m:Mat;
   if(h.inst==GROUND){p.y=f.ground.w;m=groundMat();if(f.grid2.y>0.0&&gridLine(p,n)){m=lineMat(f.grid.xyz);}}
   else{
    let lx=localX(h.inst);let lp=xpoint(lx,p);
    n=normalize(h.sgn*rowOf(lx,h.axis));m=material(h.value);
    let tex=faceTexel(h,lp).rgb;m.color*=tex;m.metalColor*=tex;
    if(f.edges.w>0.0&&edgeBand(h,lp)){m=lineMat(f.edges.xyz);}else if(f.grid2.y>1.5&&gridLine(p,n)){m=lineMat(f.grid.xyz);}
   }
   if(dot(n,ray.d)>0.0){n=-n;}
   c=select(m.emission,m.seen.xyz,m.seen.w>0.0)+m.color*skyBehind(n);
   let ndl=dot(n,f.sun.xyz);
   if((f.config.z&SUN)!=0u&&ndl>0.0){
    let e=select(f.sunLight.xyz,f.sunLight.xyz*f.sunLight.w,f.sunLight.w>0.0);
    c+=m.color*e*ndl/PI*shadow(p+n*max(1e-3,1e-6*length(p)),f.sun.xyz,INF);
   }
   let fade=bitcast<f32>(f.limits.w);
   if((h.inst==GROUND||f.groundFade.y>0.0)&&fade>0.0&&f.fog.z==0.0){
    let w=1.0-exp(-max(0.0,h.t*length(ray.d)-f.groundFade.x)/fade);c=mix(c,skyBehind(ray.d),w);
   }
  }
 }
 accum[gid.y*f.tile.x+gid.x]=vec4f(c,0.0);
}

// Transparent captures: the share of the pixel's camera rays (8 x 8 strata, through the lens and the shutter) that hit
// the scene, into accum.w once the denoiser has read it. The host writes the 64 rays into f.tile.w: a loop bound the
// compiler cannot see stays a loop on ANGLE Direct3D 11, where fxc unrolls a constant 64 around closest() and spends
// more than 15 minutes compiling it (docs/known-bugs.md).
@compute @workgroup_size(8,8) fn coverage(@builtin(global_invocation_id) gid:vec3u) {
 if(gid.x>=f.tile.x||gid.y>=f.tile.y){return;}
 let px=vec2u(gid.x+f.image.z,gid.y+f.image.w);
 var hits=0u;
 for(var s=0u;s<f.tile.w;s++){
  rng=hash(((px.y*f.image.x+px.x)*0x9e3779b1u)^hash(s+hash(f.config.y)));
  motion=1.0;
  if((f.config.z&MOTION)!=0u){motion=1.0-f.weights.z*rand();}
  let ray=cameraRay(vec2f(px)+(vec2f(f32(s%8u),f32(s/8u))+vec2f(rand(),rand()))*0.125);
  if(dot(ray.d,ray.d)>0.0&&closest(ray.o,ray.d,0u,NONE).inst!=NONE){hits++;}
 }
 accum[gid.y*f.tile.x+gid.x].w=f32(hits)/f32(f.tile.w);
}

@compute @workgroup_size(8,8) fn ids(@builtin(global_invocation_id) gid:vec3u) {
 if(gid.x>=f.tile.x||gid.y>=f.tile.y){return;}
 motion=1.0;
 let ray=viewRay(vec2f(f32(gid.x+f.image.z)+0.5,f32(gid.y+f.image.w)+0.5));
 var h:Hit;h.inst=NONE;
 if(dot(ray.d,ray.d)>0.0){h=closest(ray.o,ray.d,0u,NONE);}
 var v=-1.0;
 if(h.inst==GROUND){v=-2.0;}else if(h.inst==AREA){v=-3.0;}else if(h.inst!=NONE){v=f32(h.inst+1u)*256.0+f32(h.value&255u);}
 normals[gid.y*f.tile.x+gid.x].w=v;
}
`,fn=`
struct Params {size:vec4u,sigma:vec4f,tile:vec4u,origins:array<vec4f,4>,directions:array<vec4f,4>,prev:mat4x4f,prevOrigins:array<vec4f,4>,prevDirections:array<vec4f,4>}
@group(0) @binding(0) var<uniform> p:Params;
@group(0) @binding(1) var<storage,read> accum:array<vec4f>;
@group(0) @binding(2) var<storage,read> albedo:array<vec4f>;
@group(0) @binding(3) var<storage,read> normals:array<vec4f>;
@group(0) @binding(4) var<storage,read> src:array<vec4f>;
@group(0) @binding(5) var<storage,read_write> dst:array<vec4f>;
@group(0) @binding(6) var<storage,read_write> guide:array<vec4f>;
@group(0) @binding(7) var<storage,read> caustics:array<vec4f>;
@group(0) @binding(8) var<storage,read_write> dst2:array<vec4f>;
// The viewport's history, as halves in two textures: H1 holds the demodulated estimate and sample weight of the last
// frame after a restart and its guide (the distance as f32 bits); H2 this frame's estimate and weight, then the
// previously displayed colour (prepare copies it from dst, where combine left it) and its weight in samples, at most 8,
// plus 16 x prepare's mask of the bilinear taps to read it from. prepare reads H1 (hin) and writes H2 (hout); combine
// reads H2 (hin) and writes H1 (hout). Other passes bind 1 x 1 stand-ins.
@group(0) @binding(9) var hin:texture_2d<u32>;
@group(0) @binding(10) var hout:texture_storage_2d<rgba32uint,write>;
fn lum(c:vec3f)->f32 {return dot(c,vec3f(0.2126,0.7152,0.0722));}
// pack2x16float rounded to the nearest half: some GPUs truncate toward zero (measured on an RTX A6000: every value
// lower), which history stored every frame compounds into a darker image (1% over 32 frames).
fn packHalves(v:vec2f)->u32 {
 let b=pack2x16float(v);
 let up=abs(v)-abs(unpack2x16float(b))>abs(unpack2x16float(b+0x00010001u))-abs(v);
 return b+select(0u,1u,up.x)+select(0u,0x10000u,up.y);
}
fn ycocg(c:vec3f)->vec3f {return vec3f(dot(c,vec3f(0.25,0.5,0.25)),dot(c,vec3f(0.5,0.0,-0.5)),dot(c,vec3f(-0.25,0.5,-0.25)));}
fn fromYcocg(c:vec3f)->vec3f {return vec3f(c.x+c.y-c.z,c.x+c.z,c.x-c.y-c.z);}
fn oct(n:vec3f)->vec2f {
 let a=n/(abs(n.x)+abs(n.y)+abs(n.z));
 if(a.z>=0.0){return a.xy;}
 return (1.0-abs(a.yx))*select(vec2f(-1.0),vec2f(1.0),a.xy>=vec2f(0.0));
}
fn unoct(e:vec2f)->vec3f {
 var n=vec3f(e,1.0-abs(e.x)-abs(e.y));
 let t=max(-n.z,0.0);
 n.x+=select(t,-t,n.x>=0.0);n.y+=select(t,-t,n.y>=0.0);
 return normalize(n);
}
// First-hit point at distance t along the camera ray through tile pixel position (x, y) (corner rays as the tracer's).
fn hitPoint(x:f32,y:f32,t:f32)->vec3f {
 let uv=(vec2f(f32(p.tile.x),f32(p.tile.y))+vec2f(x,y))/vec2f(f32(p.tile.z),f32(p.tile.w));
 let o=mix(mix(p.origins[0],p.origins[1],uv.x),mix(p.origins[2],p.origins[3],uv.x),uv.y).xyz;
 let d=mix(mix(p.directions[0],p.directions[1],uv.x),mix(p.directions[2],p.directions[3],uv.x),uv.y).xyz;
 return o+normalize(d)*t;
}
// The camera ray's direction through tile pixel position (x, y).
fn viewDir(x:f32,y:f32)->vec3f {
 let uv=(vec2f(f32(p.tile.x),f32(p.tile.y))+vec2f(x,y))/vec2f(f32(p.tile.z),f32(p.tile.w));
 return normalize(mix(mix(p.directions[0],p.directions[1],uv.x),mix(p.directions[2],p.directions[3],uv.x),uv.y).xyz);
}
// Where world point P (w 1; a direction with w 0) lay in the previous frame's image, in pixels; negative when behind it.
fn previousPixel(P:vec4f)->vec2f {
 let clip=p.prev*P;
 if(clip.w<=1e-6){return vec2f(-1.0);}
 return vec2f((clip.x/clip.w*0.5+0.5)*f32(p.size.x),(0.5-clip.y/clip.w*0.5)*f32(p.size.y));
}
// The same through the previous frame's corner rays.
fn prevHitPoint(x:f32,y:f32,t:f32)->vec3f {
 let uv=(vec2f(f32(p.tile.x),f32(p.tile.y))+vec2f(x,y))/vec2f(f32(p.tile.z),f32(p.tile.w));
 let o=mix(mix(p.prevOrigins[0],p.prevOrigins[1],uv.x),mix(p.prevOrigins[2],p.prevOrigins[3],uv.x),uv.y).xyz;
 let d=mix(mix(p.prevDirections[0],p.prevDirections[1],uv.x),mix(p.prevDirections[2],p.prevDirections[3],uv.x),uv.y).xyz;
 return o+normalize(d)*t;
}
fn albedoAt(i:u32)->vec3f {return max(albedo[i].xyz*p.sigma.w,vec3f(0.02));}
// Variance of a pixel's mean luminance (mean c, mean squared luminance m2); from the 3x3 neighbourhood while there are
// too few samples.
fn variance(i:u32,c:vec3f,m2:f32,caustic:bool,g:vec2u)->f32 {
 let k=p.sigma.w;let n=1.0/k;let l=lum(c);let w=p.size.x;let h=p.size.y;
 var v=max(0.0,m2-l*l)/max(n-1.0,1.0);
 if(n<4.0){
  var s1=0.0;var s2=0.0;
  for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){
   let q=u32(clamp(i32(g.y)+y,0,i32(h)-1))*w+u32(clamp(i32(g.x)+x,0,i32(w)-1));
   var lq=0.0;
   if(caustic||(p.size.w&2u)!=0u){lq=lum(caustics[q].xyz*k);}
   if(!caustic){lq=lum(accum[q].xyz*k)-lq;}
   s1+=lq;s2+=lq*lq;
  }}
  v=max(v,max(0.0,s2/9.0-(s1/9.0)*(s1/9.0)));
 }
 return v;
}
@compute @workgroup_size(8,8) fn prepare(@builtin(global_invocation_id) g:vec3u) {
 let w=p.size.x;let h=p.size.y;
 if(g.x>=w||g.y>=h){return;}
 let i=g.y*w+g.x;let k=p.sigma.w;let n=1.0/k;
 let split=(p.size.w&2u)!=0u;
 var cc=vec3f(0.0);
 if(split){cc=caustics[i].xyz*k;}
 let c=accum[i].xyz*k-cc;let a=albedoAt(i);
 let la=max(lum(a),0.02);
 var e=c/a;var ev=variance(i,c,accum[i].w*k,false,g.xy)/(la*la);
 if(split){dst2[i]=vec4f(cc/a,variance(i,cc,caustics[i].w*k,true,g.xy)/(la*la));}
 let nn=normals[i].xyz;let len=length(nn);
 let inv=albedo[i].w*k;
 let t=select(0.0,1.0/inv,inv>0.0);
 let x=f32(g.x)+0.5;let y=f32(g.y)+0.5;
 let foot=select(0.0,length(hitPoint(x+1.0,y,t)-hitPoint(x,y,t)),t>0.0);
 // Features seen through glass or a mirror (most samples): no plane test, the first hit's plane is not theirs.
 let through=normals[i].w*k<0.5;
 let nrm=select(vec3f(0.0,0.0,1.0),nn/len,len>1e-6);
 // Viewport history (flag 8; 16: it is valid): where the history saw the same surface (position within two footprints,
 // normals within about 25 degrees) its estimate counts as up to 32 samples (8 seen through glass or a mirror, whose
 // reflections move otherwise), fading out by 64 samples of the present (32 while the camera holds still). It is kept
 // from the last restart (flag 64), so while the camera holds still the samples it adds are not counted twice.
 if((p.size.w&8u)!=0u){
  var nh=0.0;var mask=0u;
  if((p.size.w&16u)!=0u){
   let P=hitPoint(x,y,t);let q=select(previousPixel(vec4f(viewDir(x,y),0.0)),previousPixel(vec4f(P,1.0)),t>0.0);
   if(t>0.0&&len>1e-6&&all(q>=vec2f(0.0))&&q.x<f32(w)&&q.y<f32(h)){
    let pg=textureLoad(hin,vec2u(q),0);let tp=bitcast<f32>(pg.w);
    let onSurface=length(prevHitPoint(floor(q.x)+0.5,floor(q.y)+0.5,tp)-P)<2.0*foot+1e-3*t;
    if(tp>0.0&&onSurface&&dot(unoct(unpack2x16float(pg.z)),nrm)>0.9){
     let h0=unpack2x16float(pg.x);let h1=unpack2x16float(pg.y);
     nh=h1.y*max(0.0,1.0-n/select(32.0,64.0,(p.size.w&64u)!=0u));
     // The variance of the blend, and the luminance stop's widening for few samples (atrous) as for n + nh of them.
     let wide=(1.0+2.0/sqrt(n+nh))/(1.0+2.0/sqrt(n));
     e=(e*n+vec3f(h0,h1.x)*nh)/(n+nh);ev*=n/(n+nh)*wide*wide;
    }
   }
   // The displayed colour's taps (combine reads them bilinearly around q) that saw no occluder in front of this
   // pixel's first hit (or of the sky): a tap that did shows what the camera's move uncovered here, which would ghost.
   let b=floor(q-0.5);
   for(var k=0u;k<4u;k++){
    let at=b+vec2f(f32(k&1u),f32(k>>1u));
    if(at.x<0.0||at.y<0.0||at.x>=f32(w)||at.y>=f32(h)){continue;}
    let tp=bitcast<f32>(textureLoad(hin,vec2u(at),0).w);
    let d=length(P-prevHitPoint(at.x+0.5,at.y+0.5,0.0));
    if(tp<=0.0||(t>0.0&&tp>0.98*d-2.0*foot)){mask|=1u<<k;}
   }
  }
  let shown=dst[i];
  textureStore(hout,g.xy,vec4u(packHalves(e.xy),packHalves(vec2f(e.z,min(select(32.0,8.0,through),n+nh))),
   packHalves(shown.xy),packHalves(vec2f(shown.z,clamp(shown.w,0.0,8.0)+16.0*f32(mask)))));
 }
 dst[i]=vec4f(e,ev);
 guide[i]=vec4f(oct(nrm),t,select(foot,-1.0,through||(p.size.w&4u)!=0u));
}
fn tap(x:i32)->f32 {return select(select(0.0625,0.25,abs(x)==1),0.375,x==0);}
@compute @workgroup_size(8,8) fn atrous(@builtin(global_invocation_id) g:vec3u) {
 let w=p.size.x;let h=p.size.y;
 if(g.x>=w||g.y>=h){return;}
 let i=g.y*w+g.x;let st=i32(p.size.z);
 let cp=src[i];let gp=guide[i];let np=unoct(gp.xy);
 let at=vec2i(g.xy);
 let pp=hitPoint(f32(g.x)+0.5,f32(g.y)+0.5,gp.z);
 var vsum=0.0;var vw=0.0;
 for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){
  let q=u32(clamp(at.y+y,0,i32(h)-1))*w+u32(clamp(at.x+x,0,i32(w)-1));
  let k=select(0.25,0.5,x==0)*select(0.25,0.5,y==0);vsum+=src[q].w*k;vw+=k;
 }}
 // Variance of the centre (3x3 prefiltered) plus each neighbour's: the variance of their difference.
 let vp=max(vsum/vw,0.0);
 let sl=p.sigma.x*(1.0+2.0*sqrt(p.sigma.w));
 let lp=lum(cp.xyz);
 let plane=p.sigma.z*gp.w+1e-6;
 var sum=vec3f(0.0);var vs=0.0;var ws=0.0;
 for(var y=-2;y<=2;y++){for(var x=-2;x<=2;x++){
  let qx=at.x+x*st;let qy=at.y+y*st;
  if(qx<0||qy<0||qx>=i32(w)||qy>=i32(h)){continue;}
  let q=u32(qy)*w+u32(qx);
  let cq=src[q];let gq=guide[q];
  var wg=select(0.0,1.0,(gp.z>0.0)==(gq.z>0.0)&&(gp.w<0.0)==(gq.w<0.0));
  if(gp.z>0.0&&gq.z>0.0&&gp.w>=0.0&&gq.w>=0.0){wg=exp(-abs(dot(np,hitPoint(f32(qx)+0.5,f32(qy)+0.5,gq.z)-pp))/plane);}
  let wn=pow(max(0.0,dot(np,unoct(gq.xy))),p.sigma.y);
  var wl=exp(-abs(lum(cq.xyz)-lp)/(sl*sqrt(vp+max(cq.w,0.0))+1e-6));
  // Wide levels (steps 4 and up, whose input is already smoothed): a neighbour several times brighter or darker is
  // another part of a steep gradient (a wall beside a light), not noise; averaging it in would flatten the peak. Not
  // in the caustic chain (flag 32), whose focused light is rare, strong samples that it must spread widely.
  if(st>=4&&(p.size.w&32u)==0u){let lr=log((lum(cq.xyz)+1e-3)/(lp+1e-3));wl*=exp(-lr*lr/(0.96*(1.0+4.0*sqrt(p.sigma.w))));}
  let wt=tap(x)*tap(y)*wn*wg*wl;
  sum+=cq.xyz*wt;vs+=cq.w*wt*wt;ws+=wt;
 }}
 var r=vec4f(sum/ws,vs/(ws*ws));
 // Last level: remodulated, with the variance of its luminance (combine weighs it against the raw mean's).
 if((p.size.w&1u)!=0u){let a=albedoAt(i);let la=max(lum(a),0.02);r=vec4f(r.xyz*a,r.w*la*la);}
 dst[i]=r;
}
// The filtered estimate of pixel q (both chains, remodulated) and the variance of its luminance.
fn filteredAt(q:u32,split:bool)->vec4f {var f=dst[q];if(split){f+=src[q];}return vec4f(f.xyz,max(f.w,0.0));}
// The raw mean of pixel q and the variance of its luminance (regular and caustic parts, as prepare estimates them).
fn rawAt(q:u32,split:bool,g:vec2u)->vec4f {
 let k=p.sigma.w;var cc=vec3f(0.0);var v=0.0;
 if(split){cc=caustics[q].xyz*k;v=variance(q,cc,caustics[q].w*k,true,g);}
 let r=accum[q].xyz*k;
 return vec4f(r,v+variance(q,r-cc,accum[q].w*k,false,g));
}
// Whether pixel i lies on an edge of the image's features: within one pixel of another surface (sky or geometry, a
// normal turned more than about 25 degrees, a first hit off its plane by more than two footprints), of a different
// albedo (a texture or material boundary) or of features seen through glass or a mirror on one side only.
fn edgeAt(i:u32,g:vec2u)->bool {
 let w=p.size.x;let h=p.size.y;let gp=guide[i];let np=unoct(gp.xy);let ap=albedoAt(i);
 let pp=hitPoint(f32(g.x)+0.5,f32(g.y)+0.5,gp.z);
 for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){
  let qx=clamp(i32(g.x)+x,0,i32(w)-1);let qy=clamp(i32(g.y)+y,0,i32(h)-1);
  let q=u32(qy)*w+u32(qx);let gq=guide[q];
  if((gp.z>0.0)!=(gq.z>0.0)||(gp.w<0.0)!=(gq.w<0.0)){return true;}
  if(dot(np,unoct(gq.xy))<0.9){return true;}
  if(gp.z>0.0&&gp.w>0.0&&abs(dot(np,hitPoint(f32(qx)+0.5,f32(qy)+0.5,gq.z)-pp))>2.0*gp.w){return true;}
  let aq=albedoAt(q);
  if(length(aq-ap)>0.1*max(lum(ap),lum(aq))+0.02){return true;}
 }}
 return false;
}
// Per pixel at an edge, from 16 samples on, the raw mean and the filtered estimate weighed by their expected squared
// errors. The raw mean's is its variance (at least its neighbourhood's: a pixel whose samples missed a rare bright path
// looks quieter than it is); the filtered estimate's is its own variance plus its squared bias, the difference from the
// raw mean that noise does not explain. Two estimates of that bias over the 3x3 neighbourhood, the larger counts: the
// square of the mean signed difference less its variance (a filter that darkens a bright stretch or lightens a dark one
// errs the same way at every pixel there, which shows even where the raw mean is noisy), and the mean squared
// difference beyond two to four times the variances (more with fewer samples; detail blurred across an edge errs both
// ways, which shows where the raw mean is clean). Where filtering added more error than it removed the raw mean takes
// over; elsewhere the filtered estimate stands. Selecting among filters by estimated error per pixel follows Rousselle
// et al. 2012, "Adaptive Rendering with Non-Local Means Filtering". Away from edges, and below 16 samples (whose
// variances cannot tell bias from noise), the filtered estimate stands: smooth shading is what filtering is for.
fn weighed(i:u32,g:vec2u,split:bool)->vec3f {
 if(p.sigma.w>1.0/16.0||!edgeAt(i,g)){return filteredAt(i,split).xyz;}
 let w=p.size.x;let h=p.size.y;
 var d1=0.0;var d2=0.0;var vr=0.0;var vf=0.0;var ws=0.0;var ww=0.0;
 for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){
  let qx=u32(clamp(i32(g.x)+x,0,i32(w)-1));let qy=u32(clamp(i32(g.y)+y,0,i32(h)-1));
  let q=qy*w+qx;let f=filteredAt(q,split);let r=rawAt(q,split,vec2u(qx,qy));
  let wq=select(0.5,1.0,x==0)*select(0.5,1.0,y==0);
  let dl=lum(f.xyz)-lum(r.xyz);d1+=dl*wq;d2+=dl*dl*wq;vr+=r.w*wq;vf+=f.w*wq;ws+=wq;ww+=wq*wq;
 }}
 d1/=ws;d2/=ws;vr/=ws;vf/=ws;
 let f=filteredAt(i,split);let r=rawAt(i,split,g);
 // The mean difference's variance is the pixels' over the kernel's effective count (ws^2 / sum of squared weights).
 // The squared difference must exceed the variances by more where they come from few samples (and are unsure).
 let ef=f.w+max(0.0,max(d1*d1-(vr+vf)*ww/(ws*ws),d2-(2.0+8.0*p.sigma.w)*(vr+vf)));
 let er=max(r.w,vr);
 // Clamped: WGSL division may be off by 2.5 ulp, which pushes a weight just above 1 and a black pixel below 0.
 return mix(f.xyz,r.xyz,clamp(ef/(ef+er+1e-20),0.0,1.0));
}
// The filtered caustics (src) added to the filtered rest (dst), both remodulated. The viewport (flag 8) blends that with
// its previous displayed colour, reprojected and bilinearly read, into dst2: the frames' jittered samples average into
// antialiased edges. Where all four taps saw an occluder in front of this pixel's surface (prepare's mask; the camera's
// move uncovered it) the history is dropped; otherwise only clear taps contribute, with normalized weights. After a restart
// (flag 64) the history is clamped to this frame's 3x3 neighbourhood (its mean and 1.25 standard deviations, in YCoCg),
// which limits what lags behind the move. The history counts as at most 8 samples against this frame's; while the
// camera holds still nothing moved, it is not clamped and fades out by 8 samples, whose jitter antialiases as well.
@compute @workgroup_size(8,8) fn combine(@builtin(global_invocation_id) g:vec3u) {
 let w=p.size.x;let h=p.size.y;
 if(g.x>=w||g.y>=h){return;}
 let i=g.y*w+g.x;
 // Flag 2: there is a caustic chain (src) to add.
 let split=(p.size.w&2u)!=0u;
 if((p.size.w&8u)==0u){
  dst2[i]=vec4f(weighed(i,g.xy,split),1.0);return;
 }
 let gi=guide[i];let n=1.0/p.sigma.w;
 // The denoiser's history for the next frame, from a restart or where there was none.
 let est=textureLoad(hin,g.xy,0);let mask=u32(unpack2x16float(est.w).y/16.0);
 if((p.size.w&64u)!=0u||(p.size.w&16u)==0u){
  textureStore(hout,g.xy,vec4u(est.x,est.y,pack2x16float(gi.xy),bitcast<u32>(gi.z)));
 }
 var c=weighed(i,g.xy,split);
 var nh=0.0;var hc=vec3f(0.0);
 if((p.size.w&16u)!=0u&&mask!=0u){
  let x=f32(g.x)+0.5;let y=f32(g.y)+0.5;
  let q=select(previousPixel(vec4f(viewDir(x,y),0.0)),previousPixel(vec4f(hitPoint(x,y,gi.z),1.0)),gi.z>0.0)-0.5;
  let b=floor(q);let fr=q-b;
  var s=vec4f(0.0);var sw=0.0;
  for(var k=0u;k<4u;k++){
   if((mask&(1u<<k))==0u){continue;}
   let at=b+vec2f(f32(k&1u),f32(k>>1u));
   if(at.x<0.0||at.y<0.0||at.x>=f32(w)||at.y>=f32(h)){continue;}
   let wk=select(1.0-fr.x,fr.x,(k&1u)!=0u)*select(1.0-fr.y,fr.y,(k>>1u)!=0u);
   let v=textureLoad(hin,vec2u(at),0);
   let b2=unpack2x16float(v.w);
   s+=vec4f(unpack2x16float(v.z),b2.x,b2.y-16.0*floor(b2.y/16.0))*wk;
   sw+=wk;
  }
  if(sw>0.01){
   hc=s.xyz/sw;
   if((p.size.w&64u)!=0u){
    var m1=vec3f(0.0);var m2=vec3f(0.0);
    for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){
     let o=u32(clamp(i32(g.y)+y,0,i32(h)-1))*w+u32(clamp(i32(g.x)+x,0,i32(w)-1));
     var cq=dst[o].xyz;
     if(split){cq+=src[o].xyz;}
     cq=ycocg(cq);m1+=cq;m2+=cq*cq;
    }}
    m1/=9.0;let sd=1.25*sqrt(max(m2/9.0-m1*m1,vec3f(0.0)));
    hc=fromYcocg(clamp(ycocg(hc),m1-sd,m1+sd));
   }
   nh=min(s.w/sw,8.0)*max(0.0,1.0-n/select(8.0,64.0,(p.size.w&64u)!=0u));
  }
 }
 dst2[i]=vec4f(min((c*n+hc*nh)/(n+nh),vec3f(65000.0)),n+nh);
}
`,pn=`${$t}
${ee}
struct View {matrix:mat4x4f,inverse:mat4x4f,size:vec4f,params:vec4f,encoding:vec4f}
@group(0) @binding(0) var<uniform> v:View;
@group(0) @binding(1) var<storage,read> color:array<vec4f>;
@group(0) @binding(2) var<storage,read> features:array<vec4f>;
struct VOut {@builtin(position) pos:vec4f}
@vertex fn vs(@builtin(vertex_index) i:u32)->VOut {
 let p=vec2f(f32((i<<1u)&2u),f32(i&2u));
 var o:VOut;o.pos=vec4f(p*2.0-1.0,0.0,1.0);return o;
}
struct FOut {@location(0) color:vec4f,@builtin(frag_depth) depth:f32}
fn srgb(c:vec3f)->vec3f {return select(c*12.92,1.055*pow(c,vec3f(1.0/2.4))-0.055,c>=vec3f(0.0031308));}
${a}// Display encoding: sRGB, or the power 1 / gamma when v.encoding.x is set.
fn encodeOut(c:vec3f)->vec3f {
 let x=clamp(c,vec3f(0.0),vec3f(1.0));
 return select(srgb(x),pow(x,vec3f(1.0/max(v.encoding.x,1.0))),v.encoding.x>0.0);
}
@fragment fn fs(i:VOut)->FOut {
 let p=i.pos.xy-v.encoding.zw;
 let tw=v.size.x;let th=v.size.y;let W=u32(tw);
 let q=p*vec2f(tw,th)/v.size.zw-0.5;
 let a=floor(q);let fr=q-a;
 let x0=u32(clamp(a.x,0.0,tw-1.0));let x1=u32(clamp(a.x+1.0,0.0,tw-1.0));
 let y0=u32(clamp(a.y,0.0,th-1.0));let y1=u32(clamp(a.y+1.0,0.0,th-1.0));
 var c=mix(mix(color[y0*W+x0].xyz,color[y0*W+x1].xyz,fr.x),mix(color[y1*W+x0].xyz,color[y1*W+x1].xyz,fr.x),fr.y)*v.params.x*v.params.y;
 // Vignette: 1 / (1 + t^2)^2, t = strength x distance from the centre / (0.2238 x height).
 if(v.encoding.y>0.0){let uv=p/v.size.zw-0.5;let t=v.encoding.y*length(vec2f(uv.x*v.size.z/v.size.w,uv.y))/0.2238;c/=(1.0+t*t)*(1.0+t*t);}
 var rgb=max(c,vec3f(0.0));
 let mode=u32(v.params.z);
 if((mode&1u)==0u){
  if((mode&2u)!=0u){rgb=encodeOut(rgb);}
  else if((mode&4u)!=0u){rgb=encodeOut(acesNarkowicz(rgb));}
  else if((mode&8u)!=0u){rgb=encodeOut(agx(rgb));}
  else if(v.encoding.x>0.0){rgb=encodeOut(pbrNeutral(rgb));}
  else{rgb=toDisplay(rgb);}
 }
 var o:FOut;
 o.color=vec4f(rgb,1.0);
 let nx=u32(clamp(floor(p.x*tw/v.size.z),0.0,tw-1.0));let ny=u32(clamp(floor(p.y*th/v.size.w),0.0,th-1.0));
 let inv=features[ny*W+nx].w*v.params.w;
 var z=0.0;
 if(inv>0.0){
  let ndc=vec2f(p.x/v.size.z*2.0-1.0,1.0-p.y/v.size.w*2.0);
  let a0=v.inverse*vec4f(ndc,1.0,1.0);let b0=v.inverse*vec4f(ndc,0.5,1.0);
  let pa=a0.xyz/a0.w;let pb=b0.xyz/b0.w;
  let clip=v.matrix*vec4f(pa+normalize(pb-pa)/inv,1.0);
  z=clamp(clip.z/clip.w,0.0,1.0);
 }
 o.depth=z;
 return o;
}
`;export{pn as C,ln as S,de as T,dn as _,Y as a,fn as b,qt as c,Pt as d,Ft as f,Yt as g,Ut as h,Xt as i,Zt as l,Gt as m,Ve as n,Wt as o,It as p,Lt as r,Rt as s,q as t,zt as u,un as v,sn as w,Qt as x,jt as y};