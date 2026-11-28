const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["./preview-B_-I75Oo.js","./errors-CKFZBSDN-DEIUX3Qy.js","./compatibility-ECKI6euk.js","./index-DfC3fFct.js","./index-DSVGC18Q.css"])))=>i.map(i=>d[i]);
import{a as e,i as t,n,r,t as i}from"./index-DfC3fFct.js";var a=`fn acesNarkowicz(c:vec3f)->vec3f{let x=0.6*c;return clamp(x*(2.51*x+0.03)/(x*(2.43*x+0.59)+0.14),vec3f(0.0),vec3f(1.0));}
`;function o(e,t=[0,0,0]){for(let n=0;n<3;n++){let r=.6*e[n];t[n]=Math.min(1,Math.max(0,r*(2.51*r+.03)/(r*(2.43*r+.59)+.14)))}return t}var s=.18,c=10,l=2.4,u=1.5,d=2.4,f=1e-10,p=.6,m=[.6274039,.32928304,.043313066,.069097289,.9195404,.011362316,.016391439,.088013308,.89559525],h=[.85662716,.095121245,.048251598,.13731897,.76124199,.10143904,.11189821,.076799415,.81130238],g=[1.1271006,-.11060664,-.016493931,-.14132975,1.1578237,-.016493931,-.14132975,-.11060664,1.2519364],_=[1.660491,-.58764114,-.072849863,-.12455047,1.1328999,-.0083494226,-.018150763,-.1005789,1.1187297],v=[.26270021,.67799807,.059301716],y=[.21263901,.71516868,.072192315],b=_.map((e,t)=>{let n=t-t%3,r=t%3;return _[n]*g[r]+_[n+1]*g[r+3]+_[n+2]*g[r+6]}),x=16.5,S=1/x,C=(c-Math.log2(s))/x,w=c/x,T=s**(1/d),E=(e,t)=>e*((e/t)**u-1)**(-1/u),D=E(l*.3939393939393939,1-T),O=E(l*w,T),k=e=>Number.isInteger(e)?e+`.0`:String(e),A=e=>`mat3x3f(${[0,1,2].map(t=>`vec3f(${k(e[t])},${k(e[t+3])},${k(e[t+6])})`).join(`,`)})`,j=e=>`vec3f(${e.map(k).join(`,`)})`,M=`fn agxRail(c:vec3f,w:vec3f)->vec3f{let o=c+max(-min(c.x,min(c.y,c.z)),0.0);let y=max(dot(c,w),0.0);
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
`,N=0,P=0,F=0,I=0,ee=0,te=0;function ne(e,t,n,r){N=e[0]*t+e[1]*n+e[2]*r,P=e[3]*t+e[4]*n+e[5]*r,F=e[6]*t+e[7]*n+e[8]*r}function re(e,t,n,r){let i=Math.max(-Math.min(e,t,n),0),a=Math.max(e*r[0]+t*r[1]+n*r[2],0);e+=i,t+=i,n+=i;let o=e*r[0]+t*r[1]+n*r[2],s=o>a?a/o:1;N=e*s,P=t*s,F=n*s}function ie(e,t,n){let r=Math.max(e,t,n),i=r-Math.min(e,t,n),a=0;i>0&&(a=(r===e?(t-n)/i:r===t?(n-e)/i+2:(e-t)/i+4)/6),I=a-Math.floor(a),ee=r>0?i/r:0,te=r}var ae=e=>{let t=(e+I*6)%6;return te-te*ee*Math.min(Math.max(Math.min(t,4-t),0),1)};function oe(e){let t=Math.min(Math.max(Math.log2(e>f?e:f)*S+C,0),1)-w,n=t>=0?D:O,r=l*Math.abs(t)/n;return Math.max(T+Math.sign(t)*n*r/(1+r**u)**(1/u),0)**d}function se(e,t=[0,0,0]){ne(m,e[0],e[1],e[2]),re(N,P,F,v),ne(h,N,P,F);let n=N,r=P,i=F;ie(oe(n),oe(r),oe(i));let a=I,o=ee,s=te;if(ie(n,r,i),o>0&&ee>0){let e=I-a;I=a+p*(e-Math.floor(e+.5)),I-=Math.floor(I)}else I=a;return ee=o,te=s,ne(b,ae(5),ae(3),ae(1)),re(N,P,F,y),t[0]=Math.min(Math.max(N,0),1),t[1]=Math.min(Math.max(P,0),1),t[2]=Math.min(Math.max(F,0),1),t}var ce=e=>{let t=Math.min(e[0],e[1],e[2]),n=t<.08?t-6.25*t*t:.04,r=e.map(e=>e-n),i=Math.max(r[0],r[1],r[2]);if(i<.76)return r;let a=1-.0576/(i+.24-.76),o=1-1/(.15*(i-a)+1);return r.map(e=>e*a/i+(a-e*a/i)*o)},le=e=>e===`linear`?e=>e:e===`aces-narkowicz`?o:e===`agx`?se:ce,ue=(e,t)=>{let n=Math.min(1,Math.max(0,e));return Math.round(255*(t?n**(1/t):n<=.0031308?n*12.92:1.055*n**(1/2.4)-.055))};function de(e,t,n,r,i,a,o,s,c){let l=2**e.exposure,u=le(e.toneMapping),{gamma:d,vignette:f}=e,p=[0,0,0];for(let e=0;e<t*i;e++){let i=o?o[e]:1,m=i>0?l/i:0;if(f>0){let i=e%t+.5-t/2,a=r+Math.floor(e/t)+.5-n/2,o=f*Math.hypot(i,a)/(.2238*n);m/=(1+o*o)**2}for(let t=0;t<3;t++)p[t]=Math.max(0,a[e*3+t]*m);let h=u(p);for(let t=0;t<3;t++)c[e*s+t]=ue(h[t],d);s===4&&(c[e*4+3]=Math.round(255*Math.min(1,Math.max(0,i))))}}function fe(e,t=new Float64Array(16)){let n=e[0],r=e[1],i=e[2],a=e[3],o=e[4],s=e[5],c=e[6],l=e[7],u=e[8],d=e[9],f=e[10],p=e[11],m=e[12],h=e[13],g=e[14],_=e[15],v=n*s-r*o,y=n*c-i*o,b=n*l-a*o,x=r*c-i*s,S=r*l-a*s,C=i*l-a*c,w=u*h-d*m,T=u*g-f*m,E=u*_-p*m,D=d*g-f*h,O=d*_-p*h,k=f*_-p*g,A=v*k-y*O+b*D+x*E-S*T+C*w;if(!A||!Number.isFinite(A))return null;let j=1/A;return t[0]=(s*k-c*O+l*D)*j,t[1]=(i*O-r*k-a*D)*j,t[2]=(h*C-g*S+_*x)*j,t[3]=(f*S-d*C-p*x)*j,t[4]=(c*E-o*k-l*T)*j,t[5]=(n*k-i*E+a*T)*j,t[6]=(g*b-m*C-_*y)*j,t[7]=(u*C-f*b+p*y)*j,t[8]=(o*O-s*E+l*w)*j,t[9]=(r*E-n*O-a*w)*j,t[10]=(m*S-h*b+_*v)*j,t[11]=(d*b-u*S-p*v)*j,t[12]=(s*T-o*D-c*w)*j,t[13]=(n*D-r*T+i*w)*j,t[14]=(h*y-m*x-g*v)*j,t[15]=(u*x-d*y+f*v)*j,t}function pe(e,t,n,r){let i=t[0],a=t[1],o=t[2],s=t[3];return r.set([(1-2*(a*a+o*o))*n[0],2*(i*a+s*o)*n[0],2*(i*o-s*a)*n[0],0,2*(i*a-s*o)*n[1],(1-2*(i*i+o*o))*n[1],2*(a*o+s*i)*n[1],0,2*(i*o+s*a)*n[2],2*(a*o-s*i)*n[2],(1-2*(i*i+a*a))*n[2],0,e[0],e[1],e[2],1]),r}function L(e,t,n,r,i,a){let o=e.length===9?3:4,s=e[0]/t,c=e[1]/t,l=e[2]/t,u=e[o]/n,d=e[o+1]/n,f=e[o+2]/n,p=e[2*o]/r,m=e[2*o+1]/r,h=e[2*o+2]/r,g=s+d+h;if(g>0){let e=Math.sqrt(1+g),t=.5/e;return a(i,(f-m)*t,(p-l)*t,(c-u)*t,e/2)}if(s>d&&s>h){let e=Math.sqrt(1+s-d-h),t=.5/e;return a(i,e/2,(u+c)*t,(p+l)*t,(f-m)*t)}if(d>h){let e=Math.sqrt(1+d-s-h),t=.5/e;return a(i,(u+c)*t,e/2,(m+f)*t,(p-l)*t)}let _=Math.sqrt(1+h-s-d),v=.5/_;return a(i,(p+l)*v,(m+f)*v,_/2,(c-u)*v)}function me(e,t,n,r,i,a){let o=Math.sqrt(e*e+t*t+n*n+r*r);if(!(o>2**-511&&o<1/0)){let i=Math.max(Math.abs(e),Math.abs(t),Math.abs(n),Math.abs(r));i>0&&i<1/0&&(e/=i,t/=i,n/=i,r/=i,o=Math.sqrt(e*e+t*t+n*n+r*r))}return o||=1,a(i,e/o,t/o,n/o,r/o)}var he=(e,t,n,r,i,a)=>a(i,-e,-t,-n,r);function ge(e,t,n,r,i,a){let o=Math.sin(r/2);return a(i,e*o,t*o,n*o,Math.cos(r/2))}var _e=(e,t,n,r,i)=>e.set(t,n,r,i),ve=class e{constructor(e=0,t=0,n=0,r=1){this.x=e,this.y=t,this.z=n,this.w=r}set(e,t,n,r){return this.x=e,this.y=t,this.z=n,this.w=r,this}identity(){return this.set(0,0,0,1)}copy(e){return this.set(e.x,e.y,e.z,e.w)}clone(){return new e(this.x,this.y,this.z,this.w)}setFromAxisAngle(e,t){return ge(e.x,e.y,e.z,t,this,_e)}setFromEuler(e){let t=e.x/2,n=e.y/2,r=e.z/2,i=Math.sin(t),a=Math.cos(t),o=Math.sin(n),s=Math.cos(n),c=Math.sin(r),l=Math.cos(r),u=i*s,d=a*o,f=a*s,p=i*o,m=u*l,h=d*c,g=d*l,_=u*c,v=f*c,y=p*l,b=f*l,x=p*c;switch(e.order){case`XYZ`:return this.set(m+h,g-_,v+y,b-x);case`YXZ`:return this.set(m+h,g-_,v-y,b+x);case`ZXY`:return this.set(m-h,g+_,v+y,b-x);case`ZYX`:return this.set(m-h,g+_,v-y,b+x);case`YZX`:return this.set(m+h,g+_,v-y,b-x);case`XZY`:return this.set(m-h,g-_,v+y,b+x)}throw RangeError(`Invalid Euler order ${e.order}; use XYZ, XZY, YXZ, YZX, ZXY or ZYX`)}setFromRotationMatrix(e){return L(e.elements,1,1,1,this,_e)}setFromUnitVectors(e,t){let{x:n,y:r,z:i}=e,{x:a,y:o,z:s}=t,c=1+n*a+r*o+i*s;if(c<1e-8){let e=Math.abs(n),t=Math.abs(r),a=Math.abs(i);return e<=t&&e<=a?this.set(0,i,-r,0):t<=a?this.set(-i,0,n,0):this.set(r,-n,0,0),this.normalize()}return this.set(r*s-i*o,i*a-n*s,n*o-r*a,c).normalize()}multiply(e){return this.multiplyComponents(this.x,this.y,this.z,this.w,e.x,e.y,e.z,e.w)}premultiply(e){return this.multiplyComponents(e.x,e.y,e.z,e.w,this.x,this.y,this.z,this.w)}multiplyQuaternions(e,t){return this.multiplyComponents(e.x,e.y,e.z,e.w,t.x,t.y,t.z,t.w)}multiplyComponents(e,t,n,r,i,a,o,s){return this.set(e*s+r*i+t*o-n*a,t*s+r*a+n*i-e*o,n*s+r*o+e*a-t*i,r*s-e*i-t*a-n*o)}conjugate(){return he(this.x,this.y,this.z,this.w,this,_e)}invert(){let e=this.lengthSq()||1;return this.set(-this.x/e,-this.y/e,-this.z/e,this.w/e)}dot(e){return this.x*e.x+this.y*e.y+this.z*e.z+this.w*e.w}lengthSq(){return this.dot(this)}length(){return Math.sqrt(this.lengthSq())}normalize(){let{x:e,y:t,z:n,w:r}=this,i=this.length();return i===i&&(i||e||t||n||r)?me(e,t,n,r,this,_e):this.identity()}angleTo(e){let{x:t,y:n,z:r,w:i}=this,a=i*e.x-e.w*t-(n*e.z-r*e.y),o=i*e.y-e.w*n-(r*e.x-t*e.z),s=i*e.z-e.w*r-(t*e.y-n*e.x);return 2*Math.atan2(Math.hypot(a,o,s),Math.abs(this.dot(e)))}rotateTowards(e,t){let n=this.angleTo(e);return n===0?this.copy(e):this.slerp(e,Math.min(1,t/n))}slerp(e,t){if(t===0)return this;if(t===1)return this.copy(e);let{x:n,y:r,z:i,w:a}=this,o=this.dot(e),s=e.x,c=e.y,l=e.z,u=e.w;if(o<0&&(o=-o,s=-s,c=-c,l=-l,u=-u),o>=1)return this;let d=1-o*o;if(d<=2**-52)return this.set(n+(s-n)*t,r+(c-r)*t,i+(l-i)*t,a+(u-a)*t).normalize();let f=Math.sqrt(d),p=Math.atan2(f,o),m=Math.sin((1-t)*p)/f,h=Math.sin(t*p)/f;return this.set(n*m+s*h,r*m+c*h,i*m+l*h,a*m+u*h)}slerpQuaternions(e,t,n){return this.copy(e).slerp(t,n)}equals(e,t=0){return Math.abs(this.x-e.x)<=t&&Math.abs(this.y-e.y)<=t&&Math.abs(this.z-e.z)<=t&&Math.abs(this.w-e.w)<=t}fromArray(e,t=0){return this.set(e[t],e[t+1],e[t+2],e[t+3])}toArray(e=[],t=0){return e[t]=this.x,e[t+1]=this.y,e[t+2]=this.z,e[t+3]=this.w,e}},ye,be=class e{constructor(){this.elements=new Float64Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1])}set(e,t,n,r,i,a,o,s,c,l,u,d,f,p,m,h){let g=this.elements;return g[0]=e,g[4]=t,g[8]=n,g[12]=r,g[1]=i,g[5]=a,g[9]=o,g[13]=s,g[2]=c,g[6]=l,g[10]=u,g[14]=d,g[3]=f,g[7]=p,g[11]=m,g[15]=h,this}identity(){return this.set(1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1)}copy(e){return this.fromArray(e.elements)}clone(){return new e().copy(this)}multiply(e){return this.multiplyMatrices(this,e)}premultiply(e){return this.multiplyMatrices(e,this)}multiplyMatrices(e,t){let n=e.elements,r=t.elements,i=ye??=new Float64Array(16);for(let e=0;e<4;e++){let t=r[e*4],a=r[e*4+1],o=r[e*4+2],s=r[e*4+3];for(let r=0;r<4;r++)i[e*4+r]=n[r]*t+n[4+r]*a+n[8+r]*o+n[12+r]*s}return this.elements.set(i),this}multiplyScalar(e){let t=this.elements;for(let n=0;n<16;n++)t[n]*=e;return this}determinant(){return this.invertInto(!1)}invert(){return this.invertInto(!0),this}invertInto(e){let t=this.elements,n=t[0],r=t[4],i=t[8],a=t[12],o=t[1],s=t[5],c=t[9],l=t[13],u=t[2],d=t[6],f=t[10],p=t[14],m=t[3],h=t[7],g=t[11],_=t[15],v=n*s-o*r,y=n*c-o*i,b=n*l-o*a,x=r*c-s*i,S=r*l-s*a,C=i*l-c*a,w=u*h-m*d,T=u*g-m*f,E=u*_-m*p,D=d*g-h*f,O=d*_-h*p,k=f*_-g*p,A=v*k-y*O+b*D+x*E-S*T+C*w;if(!e)return A;if(A===0)return t.fill(0),A;let j=1/A;return this.set((s*k-c*O+l*D)*j,(-r*k+i*O-a*D)*j,(h*C-g*S+_*x)*j,(-d*C+f*S-p*x)*j,(-o*k+c*E-l*T)*j,(n*k-i*E+a*T)*j,(-m*C+g*b-_*y)*j,(u*C-f*b+p*y)*j,(o*O-s*E+l*w)*j,(-n*O+r*E-a*w)*j,(m*S-h*b+_*v)*j,(-u*S+d*b-p*v)*j,(-o*D+s*T-c*w)*j,(n*D-r*T+i*w)*j,(-m*x+h*y-g*v)*j,(u*x-d*y+f*v)*j),A}transpose(){let e=this.elements;for(let t=0;t<4;t++)for(let n=t+1;n<4;n++){let r=e[n*4+t];e[n*4+t]=e[t*4+n],e[t*4+n]=r}return this}setPosition(e,t=0,n=0){let r=this.elements;return typeof e==`number`?(r[12]=e,r[13]=t,r[14]=n):(r[12]=e.x,r[13]=e.y,r[14]=e.z),this}makeTranslation(e,t,n){return this.set(1,0,0,e,0,1,0,t,0,0,1,n,0,0,0,1)}makeScale(e,t,n){return this.set(e,0,0,0,0,t,0,0,0,0,n,0,0,0,0,1)}makeRotationX(e){let t=Math.cos(e),n=Math.sin(e);return this.set(1,0,0,0,0,t,-n,0,0,n,t,0,0,0,0,1)}makeRotationY(e){let t=Math.cos(e),n=Math.sin(e);return this.set(t,0,n,0,0,1,0,0,-n,0,t,0,0,0,0,1)}makeRotationZ(e){let t=Math.cos(e),n=Math.sin(e);return this.set(t,-n,0,0,n,t,0,0,0,0,1,0,0,0,0,1)}makeRotationAxis(e,t){let n=Math.cos(t),r=Math.sin(t),i=1-n,{x:a,y:o,z:s}=e;return this.set(i*a*a+n,i*a*o-r*s,i*a*s+r*o,0,i*a*o+r*s,i*o*o+n,i*o*s-r*a,0,i*a*s-r*o,i*o*s+r*a,i*s*s+n,0,0,0,0,1)}makeRotationFromQuaternion(e){return this.composeComponents(0,0,0,e.x,e.y,e.z,e.w,1,1,1)}compose(e,t,n){return this.composeComponents(e.x,e.y,e.z,t.x,t.y,t.z,t.w,n.x,n.y,n.z)}composeComponents(e,t,n,r,i,a,o,s,c,l){let u=2*r*r,d=2*i*i,f=2*a*a,p=2*r*i,m=2*r*a,h=2*i*a,g=2*o*r,_=2*o*i,v=2*o*a;return this.set((1-d-f)*s,(p-v)*c,(m+_)*l,e,(p+v)*s,(1-u-f)*c,(h-g)*l,t,(m-_)*s,(h+g)*c,(1-u-d)*l,n,0,0,0,1)}decompose(e,t,n){let r=this.elements,i=ye??=new Float64Array(16),a=Math.hypot(r[0],r[1],r[2]),o=Math.hypot(r[4],r[5],r[6]),s=Math.hypot(r[8],r[9],r[10]);this.determinant()<0&&(a=-a),e.x=r[12],e.y=r[13],e.z=r[14],n.x=a,n.y=o,n.z=s;for(let e=0;e<3;e++){let t=e===0?a:e===1?o:s;for(let n=0;n<3;n++)i[e*4+n]=t===0?0:r[e*4+n]/t;i[e*4+3]=0}return i[12]=i[13]=i[14]=0,i[15]=1,t.setFromRotationMatrix({elements:i}),this}lookAt(e,t,n){let r=this.elements,i=e.x-t.x,a=e.y-t.y,o=e.z-t.z,s=Math.hypot(i,a,o);s===0?(i=0,a=0,o=1):(i/=s,a/=s,o/=s);let c=n.y*o-n.z*a,l=n.z*i-n.x*o,u=n.x*a-n.y*i;if(c===0&&l===0&&u===0){let e=Math.abs(i),t=Math.abs(a),n=Math.abs(o);e<=t&&e<=n?(c=0,l=-o,u=a):t<=n?(c=o,l=0,u=-i):(c=-a,l=i,u=0)}let d=Math.hypot(c,l,u);return c/=d,l/=d,u/=d,r[0]=c,r[1]=l,r[2]=u,r[4]=a*u-o*l,r[5]=o*c-i*u,r[6]=i*l-a*c,r[8]=i,r[9]=a,r[10]=o,this}makePerspective(e,t,n,r,i,a,o=!0){let s=o?-a/(a-i):-(a+i)/(a-i),c=o?-a*i/(a-i):-2*a*i/(a-i);return this.set(2*i/(t-e),0,(t+e)/(t-e),0,0,2*i/(n-r),(n+r)/(n-r),0,0,0,s,c,0,0,-1,0)}makeOrthographic(e,t,n,r,i,a,o=!0){let s=1/(t-e),c=1/(n-r),l=1/(a-i);return this.set(2*s,0,0,-(t+e)*s,0,2*c,0,-(n+r)*c,0,0,o?-l:-2*l,o?-i*l:-(a+i)*l,0,0,0,1)}getMaxScaleOnAxis(){let e=this.elements;return Math.sqrt(Math.max(e[0]*e[0]+e[1]*e[1]+e[2]*e[2],e[4]*e[4]+e[5]*e[5]+e[6]*e[6],e[8]*e[8]+e[9]*e[9]+e[10]*e[10]))}equals(e,t=0){for(let n=0;n<16;n++)if(!(Math.abs(this.elements[n]-e.elements[n])<=t))return!1;return!0}fromArray(e,t=0){for(let n=0;n<16;n++)this.elements[n]=e[t+n];return this}toArray(e=[],t=0){for(let n=0;n<16;n++)e[t+n]=this.elements[n];return e}};function xe(e,t=1e-5){if(!e||!(e.length>=16))throw TypeError(`decomposeAffine needs 16 column-major numbers, such as Matrix4.elements`);if(!(t>=0&&t<1/0))throw RangeError(`decomposeAffine tolerance ${t} is invalid; pass a finite number >= 0, e.g. 1e-5`);let n=new be().fromArray(e),r=n.elements,i={x:0,y:0,z:0},a={x:0,y:0,z:0},o=new ve;n.decompose(i,o,a),o.normalize();let s=new be().compose(i,o,a).elements,c=0;for(let e=0;e<16;e++){let t=Math.abs(s[e]-r[e]);c=t===t&&t!==1/0?Math.max(c,t):1/0}let l=e=>[r[4*e],r[4*e+1],r[4*e+2]],u=(e,t)=>e[0]*t[0]+e[1]*t[1]+e[2]*t[2],d=(e,t,n)=>e.map((e,r)=>e-n*t[r]),f=e=>e.map(t=>t/Math.hypot(e[0],e[1],e[2])),p=l(0),m=l(1),h=l(2),g=f(p),_=u(g,m),v=d(m,g,_),y=f(v),b=u(g,h),x=u(y,h),S=d(d(h,g,b),y,x),C=Math.hypot(v[0],v[1],v[2]),w=Math.hypot(S[0],S[1],S[2]),T=p[0]*(m[1]*h[2]-m[2]*h[1])-p[1]*(m[0]*h[2]-m[2]*h[0])+p[2]*(m[0]*h[1]-m[1]*h[0]);return{translation:[i.x,i.y,i.z],rotation:o.toArray(),scale:[a.x,a.y,a.z],shear:[C>0?_/C:NaN,w>0?b/w:NaN,w>0?x/w:NaN],handedness:T>0?`right`:T<0?`left`:`degenerate`,projective:r[3]!==0||r[7]!==0||r[11]!==0||r[15]!==1,error:c,lossless:c<=t}}function Se(e,t,n,r){if(!(r>=0&&r<1))throw RangeError(`Quaternion linearAbove ${r} is invalid; pass a dot from 0 to below 1, e.g. 0.9995`);let i=e[0]*t[0]+e[1]*t[1]+e[2]*t[2]+e[3]*t[3],a=1;i<0&&(a=-1,i=-i),i=Math.min(1,i);let o=[0,0,0,0];if(i>r)for(let r=0;r<4;r++)o[r]=e[r]+(t[r]*a-e[r])*n;else{let r=Math.acos(i),s=Math.sin(r),c=Math.sin((1-n)*r)/s,l=Math.sin(n*r)/s;for(let n=0;n<4;n++)o[n]=e[n]*c+t[n]*a*l}let s=Math.hypot(o[0],o[1],o[2],o[3]);for(let e=0;e<4;e++)o[e]/=s;return o}var Ce=2**-15,we=1e-5,Te=.9995,Ee=(e,t,n)=>{throw RangeError(`VoxelPathTracer ${e} motion interval ${t}; pass a ${n} that stays invertible, or motionInterpolation 'trs' for rotations`)},De=[0,1,2,4,5,6,8,9,10],Oe=(e,t,n)=>e[0]*(t[1]*n[2]-t[2]*n[1])-t[0]*(e[1]*n[2]-e[2]*n[1])+n[0]*(e[1]*t[2]-e[2]*t[1]),ke=e=>Math.max(...De.map(t=>Math.abs(e[t]))),Ae=(e,t)=>[0,1,2].map(n=>[e[n]/t,e[4+n]/t,e[8+n]/t]),je=e=>Float64Array.from([e[0],e[4],e[8],0,e[1],e[5],e[9],0,e[2],e[6],e[10],0,e[3],e[7],e[11],1]);function Me(e,t,n,r){let i=Math.max(ke(e),ke(t));i>0||Ee(n,`is singular`,r);let a=Ae(e,i),o=Ae(t,i).map((e,t)=>e.map((e,n)=>e-a[t][n])),s=Oe(a[0],a[1],a[2]),c=Oe(o[0],a[1],a[2])+Oe(a[0],o[1],a[2])+Oe(a[0],a[1],o[2]),l=Oe(o[0],o[1],a[2])+Oe(o[0],a[1],o[2])+Oe(a[0],o[1],o[2]),u=Oe(o[0],o[1],o[2]),d=[0,1],f=3*u,p=2*l;if(f===0)p!==0&&d.push(-c/p);else{let e=p*p-4*f*c;e>=0&&d.push((-p+Math.sqrt(e))/(2*f),(-p-Math.sqrt(e))/(2*f))}let m=Math.sign(s);for(let e of d)e>=0&&e<=1&&!(m*(((u*e+l)*e+c)*e+s)>Ce)&&Ee(n,`becomes singular between the two transforms`,r)}function Ne(e,t,n){let r=ke(e),i=je(e);r>0||Ee(t,`has a singular endpoint`,n);for(let e of De)i[e]/=r;i[12]=i[13]=i[14]=0;let a=xe(i,we);(!a.lossless||a.shear.some(e=>!(Math.abs(e)<=we)))&&Ee(t,`has shear, which motionInterpolation 'trs' does not support`,n);let o=a.scale.map(e=>e*r),s=a.rotation.slice(),c=pe([0,0,0],s,o,new Float64Array(16)),l=je(e);for(let e of De)Math.abs(c[e]-l[e])<=we*r||Ee(t,`is not a rotation and scale`,n);return{q:s,scale:o}}function Pe(e,t,n,r,i,a=[0,0,0],o=`previousMatrix`){let s=new Float64Array([1/0,1/0,1/0,-1/0,-1/0,-1/0]),c;if(r===`trs`){let r=Ne(e,i,o),l=Ne(t,i,o);r.scale.some((e,t)=>Math.sign(e)!==Math.sign(l.scale[t]))&&Ee(i,`changes handedness`,o);let u=Se(r.q,r.q,0,Te),d=Se(u,l.q,1,Te),f=Math.max(0,Math.min(1,u.reduce((e,t,n)=>e+t*d[n],0))),p=Math.acos(f);c=new Float32Array(16),c.set(u,0),c.set(d,4),c.set(r.scale,8),c.set(l.scale,12),c[11]=p,c[15]=f>Te?0:1/Math.sin(p),c.every(Number.isFinite)||Ee(i,`is out of Float32 range`,o);let m=Math.hypot(...n.map((e,t)=>Math.max(Math.abs(a[t]),Math.abs(a[t]+e))*Math.max(Math.abs(r.scale[t]),Math.abs(l.scale[t]))));for(let n=0;n<3;n++)s[n]=Math.min(e[n*4+3],t[n*4+3])-m,s[n+3]=Math.max(e[n*4+3],t[n*4+3])+m}else Me(e,t,i,o);for(let r of[e,t])for(let e=0;e<8;e++)for(let t=0;t<3;t++){let i=t*4,o=r[i]*(a[0]+(e&1?n[0]:0))+r[i+1]*(a[1]+(e&2?n[1]:0))+r[i+2]*(a[2]+(e&4?n[2]:0))+r[i+3];s[t]=Math.min(s[t],o),s[t+3]=Math.max(s[t+3],o)}for(let e=0;e<3;e++){let t=2**-16*Math.max(1,Math.abs(s[e]),Math.abs(s[e+3]));s[e]-=t,s[e+3]+=t}return{payload:c,bounds:s}}function Fe(e,t,n){let r=Math.hypot(e[0],e[1],e[2]),i=[e[0]/r,e[1]/r,e[2]/r],a=t??(Math.abs(i[1])>.999?[0,0,1]:[0,1,0]),o=[a[1]*i[2]-a[2]*i[1],a[2]*i[0]-a[0]*i[2],a[0]*i[1]-a[1]*i[0]],s=Math.hypot(o[0],o[1],o[2]);if(!(s>1e-6*Math.hypot(a[0],a[1],a[2])))throw RangeError(`${n} up is parallel to its direction; pass another up vector`);let c=[o[0]/s,o[1]/s,o[2]/s];return{normal:i,right:c,up:[i[1]*c[2]-i[2]*c[1],i[2]*c[0]-i[0]*c[2],i[0]*c[1]-i[1]*c[0]]}}var Ie=1024,Le=e=>[[.1787*e-1.463,-.3554*e+.4275,-.0227*e+5.3251,.1206*e-2.5771,-.067*e+.3703],[-.0193*e-.2592,-.0665*e+8e-4,-4e-4*e+.2125,-.0641*e-.8989,-.0033*e+.0452],[-.0167*e-.2608,-.095*e+.0092,-.0079*e+.2102,-.0441*e-1.6537,-.0109*e+.0529]],Re=([e,t,n,r,i],a,o)=>(1+e*Math.exp(t/Math.max(Math.cos(a),1e-4)))*(1+n*Math.exp(r*o)+i*Math.cos(o)**2),ze=(e,t,n)=>{let r=[t*t*t,t*t,t,1],i=e=>n[e*4]*r[0]+n[e*4+1]*r[1]+n[e*4+2]*r[2]+n[e*4+3]*r[3];return e*e*i(0)+e*i(1)+i(2)},Be=[.00166,-.00375,.00209,0,-.02903,.06377,-.03202,.00394,.11693,-.21196,.06052,.25886],Ve=[.00275,-.0061,.00317,0,-.04214,.0897,-.04153,.00516,.15346,-.26756,.0667,.26688];function He(e,t,n,r=!1){let i=Math.max(2,e),a=Math.acos(Math.min(1,Math.max(0,t[1]))),o=Math.hypot(t[0],t[2]),s=t[1]>=0?t:o>0?[t[0]/o,0,t[2]/o]:[0,1,0],[c,l,u]=Le(i),d=(4/9-i/120)*(Math.PI-2*a),f=(4.0453*i-4.971)*Math.tan(d)-.2155*i+2.4192,p=ze(i,a,Be),m=ze(i,a,Ve),h=Re(c,0,a),g=Re(l,0,a),_=Re(u,0,a),v=new Float32Array(Ie*512*3);for(let e=0;e<512;e++){let t=Math.PI*(e+.5)/512;if(t>=Math.PI/2)break;let r=Math.sin(t),i=Math.cos(t);for(let a=0;a<Ie;a++){let o=((a+.5)/Ie-.5)*2*Math.PI,d=[r*Math.sin(o),i,-r*Math.cos(o)],y=Math.acos(Math.min(1,Math.max(-1,d[0]*s[0]+d[1]*s[1]+d[2]*s[2]))),b=f*Re(c,t,y)/h,x=p*Re(l,t,y)/g,S=Math.max(-3*x*x+2.87*x-.275,m*Re(u,t,y)/_);if(!(b>0&&S>0))continue;let C=x*b/S,w=(1-x-S)*b/S,T=(e*Ie+a)*3;v[T]=Math.max(0,3.2406*C-1.5372*b-.4986*w)*n,v[T+1]=Math.max(0,-.9689*C+1.8758*b+.0415*w)*n,v[T+2]=Math.max(0,.0557*C-.204*b+1.057*w)*n}}if(r){let e=Ie*3,t=255*e;for(let n=256;n<512;n++)v.copyWithin(n*e,t,786432)}return v}var Ue=.5876,We=.4861,Ge=.6563;function Ke(e,t){return t>0?(e-1)/(t*(1/(We*We)-1/(Ge*Ge))):0}var qe=[[[.362,442,.0624,.0374],[1.056,599.8,.0264,.0323],[-.065,501.1,.049,.0382]],[[.821,568.8,.0213,.0247],[.286,530.9,.0613,.0322]],[[1.217,437,.0845,.0278],[.681,459,.0385,.0725]]],Je=e=>qe.map(t=>t.reduce((t,[n,r,i,a])=>{let o=(e-r)*(e<r?i:a);return t+n*Math.exp(-.5*o*o)},0)),Ye=e=>e.map(([e,t,n,r])=>`${e}*cmfLobe(l,${z(t)},${n},${r})`).join(`+`),R=[3.2406,-1.5372,-.4986,-.9689,1.8758,.0415,.0557,-.204,1.057],Xe=e=>{let[t,n,r]=Je(e);return[0,1,2].map(e=>R[e*3]*t+R[e*3+1]*n+R[e*3+2]*r)},Ze=(()=>{let e=[0,0,0],t=.05;for(let n=380.025;n<780;n+=t){let r=Xe(n);for(let n=0;n<3;n++)e[n]+=r[n]*t}return e})(),Qe=.25,$e=550,z=e=>Number.isInteger(e)?`${e}.0`:`${e}`,et=`
const LAMBDA_MIN=${z(380)};
const LAMBDA_MAX=${z(780)};
const LAMBDA_D=${Ue};
fn cmfLobe(x:f32,mu:f32,k1:f32,k2:f32)->f32 {let t=(x-mu)*select(k2,k1,x<mu);return exp(-0.5*t*t);}
fn spectralRgb(l:f32)->vec3f {
 let x=${Ye(qe[0])};
 let y=${Ye(qe[1])};
 let z=${Ye(qe[2])};
 let rgb=vec3f(${R[0]}*x+${R[1]}*y+${R[2]}*z,${R[3]}*x+${R[4]}*y+${R[5]}*z,${R[6]}*x+${R[7]}*y+${R[8]}*z);
 return rgb/vec3f(${Ze.map(e=>e.toPrecision(9)).join(`,`)});
}
fn lambdaPdf(l:f32)->f32 {
 let ta=tanh((LAMBDA_MIN-${z($e)})/${z(56)});let tb=tanh((LAMBDA_MAX-${z($e)})/${z(56)});
 let t=tanh((l-${z($e)})/${z(56)});
 return ${Qe}/(LAMBDA_MAX-LAMBDA_MIN)+0.75*(1.0-t*t)/(${z(56)}*(tb-ta));
}
// A wavelength for uniform numbers u (choice, position) and its density.
fn sampleLambda(u:vec2f)->vec2f {
 var l:f32;
 if(u.x<${Qe}){l=mix(LAMBDA_MIN,LAMBDA_MAX,u.y);}
 else{
  let ta=tanh((LAMBDA_MIN-${z($e)})/${z(56)});let tb=tanh((LAMBDA_MAX-${z($e)})/${z(56)});
  l=clamp(${z($e)}+${z(56)}*atanh(clamp(mix(ta,tb,u.y),-0.999999,0.999999)),LAMBDA_MIN,LAMBDA_MAX);
 }
 return vec2f(l,lambdaPdf(l));
}
`,B=8,tt=2147483648,nt=1073741824,rt=65535,it=256,at=4096,ot=2048,st=4096,ct=1024,lt=2048,ut=8,dt=2,ft=16,pt=.001,mt=.1,ht=[`diffuse`,`plastic`,`metal`,`glass`,`emit`,`blend`,`media`],V=`VoxelPathTracer`,H=e=>typeof e==`object`&&!!e;function U(e,t,n,r,i){if(typeof e!=`number`||Number.isNaN(e))throw TypeError(`${V} ${t} must be a number; ${i}`);if(!(e>=n&&e<=r))throw RangeError(`${V} ${t} ${e} is outside ${n} to ${r}; ${i}`);return e}var W=(e,t,n,r,i,a)=>e===void 0?t:U(e,n,r,i,a);function G(e,t,n,r){if(!Array.isArray(e)&&!ArrayBuffer.isView(e))throw TypeError(`${V} ${t} must be an array of 3 numbers; ${r}`);let i=e;if(i.length!==3||![0,1,2].every(e=>typeof i[e]==`number`))throw TypeError(`${V} ${t} must be an array of 3 numbers; ${r}`);let a=[i[0],i[1],i[2]];if(!a.every(Number.isFinite)||n&&a.some(e=>e<0))throw RangeError(`${V} ${t} [${a}] must be finite${n?` and 0 or more`:``}; ${r}`);return a}var gt=(e,t)=>{if(typeof e!=`string`||!e)throw TypeError(`${V} ${t} must be a non-empty string id`);return e},_t=(e,t)=>{if(!Array.isArray(e))throw TypeError(`${V} scene.${t} must be an array`);return e};function vt(e,t){if(!Array.isArray(e)&&!ArrayBuffer.isView(e)||e.length!==16)throw TypeError(`${V} ${t} must be 16 numbers (a column-major 4x4 matrix)`);let n=e;for(let e=0;e<16;e++)if(typeof n[e]!=`number`)throw TypeError(`${V} ${t} must be 16 numbers (a column-major 4x4 matrix)`);let r=n;for(let e=0;e<16;e++)if(!Number.isFinite(r[e]))throw RangeError(`${V} ${t}[${e}] ${r[e]} is not finite; pass finite numbers`);if(Math.abs(r[3])>1e-9||Math.abs(r[7])>1e-9||Math.abs(r[11])>1e-9||Math.abs(r[15]-1)>1e-9)throw RangeError(`${V} ${t} is not affine (its last row must be 0, 0, 0, 1); pass a model-to-world transform`);let i=new Float64Array(12);for(let e=0;e<3;e++)for(let t=0;t<4;t++)i[e*4+t]=r[t*4+e];let a=yt(i),o=Math.max(...[0,1,2].map(e=>Math.hypot(i[e],i[4+e],i[8+e])));if(!(Math.abs(a)>1e-12*o*o*o)||!Number.isFinite(a))throw RangeError(`${V} ${t} is singular (determinant ${a}); pass an invertible transform`);return i}var yt=e=>e[0]*(e[5]*e[10]-e[6]*e[9])-e[1]*(e[4]*e[10]-e[6]*e[8])+e[2]*(e[4]*e[9]-e[5]*e[8]);function bt(e){let t=yt(e),n=new Float64Array(12),r=[e[0],e[1],e[2]],i=[e[4],e[5],e[6]],a=[e[8],e[9],e[10]],o=(e,t)=>[e[1]*t[2]-e[2]*t[1],e[2]*t[0]-e[0]*t[2],e[0]*t[1]-e[1]*t[0]],s=o(i,a),c=o(a,r),l=o(r,i);for(let e=0;e<3;e++)n[e*4]=s[e]/t,n[e*4+1]=c[e]/t,n[e*4+2]=l[e]/t;for(let t=0;t<3;t++)n[t*4+3]=-(n[t*4]*e[3]+n[t*4+1]*e[7]+n[t*4+2]*e[11]);return n}function xt(e,t){return e.blocks===void 0?e.voxels instanceof Uint8Array&&e.voxels.length===t[0]*t[1]*t[2]:Array.isArray(e.blocks)&&e.voxels===void 0}function St(e,t,n){let r=G(e.size,`${t}.size`,!0,`pass integer dimensions 1 to ${ot}`);if(!r.every(e=>Number.isInteger(e)&&e>=1&&e<=ot))throw RangeError(`${V} ${t}.size [${r}] must be integers 1 to ${ot}; pass the model's voxel dimensions`);if(typeof e.revision!=`number`||!Number.isFinite(e.revision))throw TypeError(`${V} ${t}.revision must be a finite number; bump it when the voxels change`);let[i,a,o]=r,s=Math.ceil(i/B),c=Math.ceil(a/B),l=Math.ceil(o/B);if(s*c*l+4>n)throw RangeError(`${V} ${t} of ${i}x${a}x${o} needs a ${s*c*l*4}-byte brick grid; this device binds at most ${n*4}; split it into smaller models`);if(e.blocks!==void 0){if(e.voxels!==void 0)throw TypeError(`${V} ${t} has both voxels and blocks; pass one of them`);if(!Array.isArray(e.blocks))throw TypeError(`${V} ${t}.blocks must be an array of {origin, size, voxels}`);return Tt(e,t,[i,a,o])}let u=e.voxels;if(!(u instanceof Uint8Array))throw TypeError(`${V} ${t}.voxels must be a Uint8Array of palette indices (or pass blocks)`);if(u.length!==i*a*o)throw TypeError(`${V} ${t}.voxels has ${u.length} entries; a ${i}x${a}x${o} model needs ${i*a*o} (index = x + sx * (z + sz * y))`);let d=wt(e.shapes,u.length,t),f=new Uint32Array(s*c*l),p=new Uint32Array(256),m=new Uint8Array(512),h=new Uint8Array(512),g=new Uint32Array(128*Math.min(f.length,64)),_=0;for(let e=0;e<c;e++)for(let t=0;t<l;t++)for(let n=0;n<s;n++){let r=n*B,c=e*B,v=t*B,y=Math.min(B,i-r),b=Math.min(B,a-c),x=Math.min(B,o-v),S=y<B||b<B||x<B;S&&(m.fill(0),h.fill(0));let C=-1,w=!S,T=!1;for(let e=0;e<b;e++)for(let t=0;t<x;t++){let n=r+i*(v+t+o*(c+e)),a=8*(t+8*e);for(let e=0;e<y;e++){let t=u[n+e],r=t&&d?d[n+e]%255:0;m[a+e]=t,h[a+e]=r,r&&(T=!0),p[t]++,C<0?C=t:t!==C&&(w=!1)}}T&&(w=!1);let E=n+s*(t+l*e);if(S&&C===0){let e=!0;for(let t=0;t<m.length&&e;t++)e=m[t]===0;if(e)continue}w?f[E]=C===0?0:(tt|C)>>>0:(g=Ct(g,_+(T?2:1),f.length*2),new Uint8Array(g.buffer,_*128*4,512).set(m),f[E]=T?(nt|++_)>>>0:++_,T&&new Uint8Array(g.buffer,_++*128*4,512).set(h))}return p[0]=0,{id:e.id,revision:e.revision,key:e.contentKey,size:[i,a,o],bricks:[s,c,l],grid:f,payload:g.slice(0,_*128),counts:p}}function Ct(e,t,n){if(t*128<=e.length)return e;let r=new Uint32Array(Math.min(n,Math.max(t,e.length/128*2+1))*128);return r.set(e),r}function wt(e,t,n){if(e!==void 0){if(!(e instanceof Uint8Array))throw TypeError(`${V} ${n}.shapes must be a Uint8Array of octant masks (0 for whole cells)`);if(e.length!==t)throw TypeError(`${V} ${n}.shapes has ${e.length} entries; it needs one per cell (${t})`);return e}}function Tt(e,t,n){let[r,i,a]=n,o=Math.ceil(r/B),s=Math.ceil(i/B),c=Math.ceil(a/B),l=new Map,u=new Map;for(let[s,d]of e.blocks.entries()){let e=`${t}.blocks[${s}]`;if(!H(d))throw TypeError(`${V} ${e} must be {origin, size, voxels}`);let f=G(d.origin,`${e}.origin`,!0,`pass integer cell coordinates inside the model`),p=G(d.size,`${e}.size`,!0,`pass integer dimensions of 1 or more`);if(!f.every(Number.isInteger)||!p.every(e=>Number.isInteger(e)&&e>=1))throw RangeError(`${V} ${e} origin and size must be whole numbers (size 1 or more)`);if(f.some((e,t)=>e+p[t]>n[t]))throw RangeError(`${V} ${e} spans [${f}] to [${f.map((e,t)=>e+p[t])}], outside the ${r}x${i}x${a} model; move or crop it`);let m=d.voxels;if(!(m instanceof Uint8Array))throw TypeError(`${V} ${e}.voxels must be a Uint8Array of palette indices`);if(m.length!==p[0]*p[1]*p[2])throw TypeError(`${V} ${e}.voxels has ${m.length} entries; a ${p[0]}x${p[1]}x${p[2]} block needs ${p[0]*p[1]*p[2]} (index = x + sx * (z + sz * y))`);let h=wt(d.shapes,m.length,e);for(let e=0;e<p[1];e++)for(let t=0;t<p[2];t++){let n=f[1]+e,r=f[2]+t,i=p[0]*(t+p[2]*e);for(let e=0;e<p[0];e++){let t=f[0]+e,a=(t>>3)+o*((r>>3)+c*(n>>3)),s=l.get(a);s||l.set(a,s=new Uint8Array(512));let d=(t&7)+8*((r&7)+8*(n&7)),p=h&&m[i+e]?h[i+e]%255:0;s[d]=m[i+e];let g=u.get(a);p&&!g&&u.set(a,g=new Uint8Array(512)),g&&(g[d]=p)}}}let d=new Uint32Array(o*s*c),f=new Uint32Array(256),p=[...l.keys()].sort((e,t)=>e-t),m=new Uint32Array(128*Math.min(p.length,64)),h=0;for(let e of p){let t=l.get(e),n=e%o,s=Math.floor(e/o)%c,g=Math.floor(e/(o*c)),_=n*8+8>r||g*8+8>i||s*8+8>a,v=u.get(e)?.some(Boolean)?u.get(e):void 0,y=t[0],b=!_&&!v;for(let e=0;e<t.length;e++)f[t[e]]++,t[e]!==y&&(b=!1);b?d[e]=y===0?0:(tt|y)>>>0:t.every(e=>e===0)||(m=Ct(m,h+(v?2:1),p.length*2),new Uint8Array(m.buffer,h*128*4,512).set(t),d[e]=v?(1073741824|++h)>>>0:++h,v&&new Uint8Array(m.buffer,h++*128*4,512).set(v))}return f[0]=0,{id:e.id,revision:e.revision,key:e.contentKey,size:[r,i,a],bricks:[o,s,c],grid:d,payload:m.slice(0,h*128),counts:f}}function Et(e,t,n,r){if(t<0||n<0||r<0||t>=e.size[0]||n>=e.size[1]||r>=e.size[2])return 0;let[i,,a]=e.bricks,o=e.grid[(t>>3)+i*((r>>3)+a*(n>>3))];if(o===0)return 0;if(o>=2147483648)return o&255;let s=(t&7)+8*((r&7)+8*(n&7));return e.payload[((o&-1073741825)-1)*128+(s>>2)]>>>(s&3)*8&255}function Dt(e,t,n,r){if(t<0||n<0||r<0||t>=e.size[0]||n>=e.size[1]||r>=e.size[2])return 0;let i=e.grid[(t>>3)+e.bricks[0]*((r>>3)+e.bricks[2]*(n>>3))];if(i>=2147483648||!(i&1073741824))return 0;let a=(t&7)+8*((r&7)+8*(n&7));return e.payload[(i&-1073741825)*128+(a>>2)]>>>(a&3)*8&255}var Ot=(e,t,n)=>.2126*e+.7152*t+.0722*n;function kt(e){if(e===void 0)return[];let t=_t(e,`textures`);if(t.length>at)throw RangeError(`${V} scene.textures has ${t.length}; at most ${at} are supported`);return t.map((e,t)=>{let n=`scene.textures[${t}]`;if(!H(e))throw TypeError(`${V} ${n} must be an object {width, height, data}`);for(let t of[`width`,`height`]){if(typeof e[t]!=`number`||!Number.isInteger(e[t]))throw TypeError(`${V} ${n}.${t} must be an integer number of texels`);if(e[t]<1||e[t]>1024)throw RangeError(`${V} ${n}.${t} ${e[t]} is outside 1 to 1024; use a size from 1 to 1024`)}if(!(e.data instanceof Uint8Array||e.data instanceof Uint8ClampedArray))throw TypeError(`${V} ${n}.data must be a Uint8Array of RGBA bytes`);if(e.data.length!==e.width*e.height*4)throw TypeError(`${V} ${n}.data has ${e.data.length} bytes; pass width x height x 4 = ${e.width*e.height*4}`);let r=new Uint32Array(e.width*e.height);for(let t=0;t<r.length;t++)r[t]=(e.data[4*t]|e.data[4*t+1]<<8|e.data[4*t+2]<<16|e.data[4*t+3]<<24)>>>0;return{width:e.width,height:e.height,texels:r}})}function At(e,t,n){if(!H(e))throw TypeError(`${V} ${t} must be an object {id, color, type}`);if(typeof e.id!=`number`||!Number.isInteger(e.id))throw TypeError(`${V} ${t}.id must be an integer palette index 1 to 255`);if(e.id<1||e.id>255)throw RangeError(`${V} ${t}.id ${e.id} is outside 1 to 255 (0 is empty); use an id from 1 to 255`);if(!ht.includes(e.type))throw TypeError(`${V} ${t}.type ${String(e.type)} is unknown; pass one of ${ht.join(`, `)}`);let r=G(e.color,`${t}.color`,!0,`pass linear RGB, 0 or more`),i=e.emissionColor===void 0?r:G(e.emissionColor,`${t}.emissionColor`,!0,`pass linear RGB, 0 or more`),a=e.type,o=(e,n,r)=>W(e,n,`${t}.${r}`,0,1,`pass 0 to 1`),s=o(e.roughness,a===`glass`?0:.2,`roughness`),c=o(e.metalness,+(a===`metal`),`metalness`),l=o(e.transmission,+(a===`glass`),`transmission`),u=o(e.specular,a===`diffuse`||a===`emit`?0:1,`specular`),d=W(e.emission,+(a===`emit`),`${t}.emission`,0,1e6,`pass 0 or more`),f=W(e.cameraEmission,d,`${t}.cameraEmission`,0,1e6,`pass 0 or more`),p=W(e.ior,1.5,`${t}.ior`,1,3,`pass 1 to 3 (glass is about 1.5)`),m=W(e.density,+(a===`media`),`${t}.density`,0,1e6,`pass 0 or more per world unit`),h=W(e.scatter,0,`${t}.scatter`,0,1e6,`pass 0 or more per world unit`),g=W(e.anisotropy,0,`${t}.anisotropy`,-.95,.95,`pass -0.95 to 0.95`),_=W(e.abbe,0,`${t}.abbe`,0,200,`pass 0 (no dispersion) or an Abbe number of 5 to 200`),v=W(e.cutout,0,`${t}.cutout`,0,1,`pass an alpha threshold 0 to 1 (0: none)`),y=e.metalColor===void 0?r:G(e.metalColor,`${t}.metalColor`,!0,`pass linear RGB, each 0 to 1`);if(e.coat!==void 0&&e.coat!==`layered`&&e.coat!==`additive`)throw TypeError(`${V} ${t}.coat ${String(e.coat)} is unknown; pass 'layered' or 'additive'`);let b=(e,n)=>{if(e!==void 0&&typeof e!=`boolean`)throw TypeError(`${V} ${t}.${n} must be true or false`);return e===!0},x=e.tint===void 0||b(e.tint,`tint`),S=b(e.voxelwise,`voxelwise`),C=b(e.sunlit,`sunlit`),w=b(e.subsurface,`subsurface`),T=b(e.contactTransmission,`contactTransmission`),E=e.texture===void 0?void 0:typeof e.texture==`number`?[,,,,,,].fill(e.texture):e.texture;if(E!==void 0){if(!Array.isArray(E)||E.length!==6||!E.every(e=>typeof e==`number`&&Number.isInteger(e)))throw TypeError(`${V} ${t}.texture must be a texture index or six (+x, -x, +y, -y, +z, -z) into scene.textures`);for(let e of E)if(e<0||n!==void 0&&e>=n)throw RangeError(`${V} ${t}.texture ${e} is not an index into scene.textures; use an index below the texture count${n===void 0?``:` (${n})`}`)}if(_>0&&_<5)throw RangeError(`${V} ${t}.abbe ${_} is out of range; pass 0 (no dispersion) or 5 to 200`);return{id:e.id,color:r,type:a,roughness:s,metalness:c,emission:d,emissionColor:i,cameraEmission:f,sunlit:C,subsurface:w,voxelwise:S,contactTransmission:T,...E===void 0?{}:{texture:E},cutout:v,ior:p,transmission:l,density:m,specular:u,scatter:h,anisotropy:g,abbe:_,metalColor:y,coat:e.coat??`layered`,tint:x}}function jt(e,t,n,r){let i=At(e,t,r),{type:a,color:o,emissionColor:s,roughness:c,metalness:l,transmission:u,specular:d,emission:f,ior:p,density:m,scatter:h,anisotropy:g,abbe:_,cutout:v,metalColor:y}=i,b=e.cameraEmission===void 0?-1:i.cameraEmission,x=i.texture,S=i.id*32,C=c*c,w=a===`media`,T=w?0:l,E=w?0:(1-l)*u,D=ft;w&&(D|=1),E>0&&(D|=dt),!w&&f>0&&Ot(s[0],s[1],s[2])*f>0&&(D|=4),C<.001&&(D|=8),i.coat===`additive`&&(D|=32),i.tint||(D|=64),i.sunlit&&w&&!i.subsurface&&(D|=128),i.subsurface&&w&&(D|=lt);let O=i.subsurface&&w?Mt(o):y;i.voxelwise&&E>0&&E<1&&(D|=256),i.contactTransmission&&E>0&&E<1&&(D|=512),v>0&&x!==void 0&&!w&&(D|=ct),n.set([Math.min(o[0],1),Math.min(o[1],1),Math.min(o[2],1),C,T,E,w?0:d,((p-1)/(p+1))**2,s[0]*f,s[1]*f,s[2]*f,p,m,h,g,D,E>0?Ke(p,_):0,Math.min(O[0],1),Math.min(O[1],1),Math.min(O[2],1),b>=0&&!w?s[0]*b:0,b>=0&&!w?s[1]*b:0,b>=0&&!w?s[2]*b:0,+(b>=0&&!w),...(x??[,,,,,,].fill(-1)).map(e=>e+1),v,0],S)}function Mt(e){let t=e=>{let t=Math.min(Math.max(e,0),1);return 1-Math.exp(t*(-5.09406+t*(2.61188-4.31805*t)))};return[t(e[0]),t(e[1]),t(e[2])]}function Nt(e,t,n){let r=``,i=``;for(let n=1;n<256;n++){let a=t[n*32+15];e.counts[n]&&a&4&&(r+=`${n},`),a&3&&(i+=`${n},`)}if(!r)return;let a=`${r}|${i}`,o=n.emitters.get(e);if(o?.key===a)return o;let s=new Uint8Array(256),c=new Uint8Array(256);s[0]=1;for(let e=1;e<256;e++){let n=t[e*32+15];n&3&&(s[e]=1),n&4&&(c[e]=1)}let l=[],u=[],[d,f,p]=e.size,[m,h,g]=e.bricks,_=[[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];for(let t=0;t<h;t++)for(let n=0;n<g;n++)for(let r=0;r<m;r++){let i=e.grid[r+m*(n+g*t)];if(!(!i||i>=2147483648&&!c[i&255]))for(let i=t*8;i<Math.min(t*8+8,f);i++)for(let t=n*8;t<Math.min(n*8+8,p);t++)for(let n=r*8;n<Math.min(r*8+8,d);n++){let r=Et(e,n,i,t);if(!c[r])continue;let a=Dt(e,n,i,t)||255;for(let o=0;o<6;o++){let c=_[o],d=n+c[0],f=i+c[1],p=t+c[2];if(a===255&&s[Et(e,d,f,p)]){l.push((n|i<<16)>>>0,(t|o<<16)>>>0),u.push(r);continue}let m=o>>1,h=1<<m,g=o&1?0:h,v=h^g,y=1<<(m+1)%3,b=1<<(m+2)%3,x=s[Et(e,d,f,p)]?0:Dt(e,d,f,p)||255;for(let e=0;e<4;e++){let s=(e&1?y:0)|(e&2?b:0),c=(t|o<<16|1<<19|(e&3)<<21)>>>0;if(a>>(s|g)&1){if(x>>(s|v)&1)continue;l.push((n|i<<16)>>>0,c)}else if(a>>(s|v)&1)l.push((n|i<<16)>>>0,(c|1<<20)>>>0);else continue;u.push(r)}}}}let v={key:a,faces:Uint32Array.from(l),ids:Uint8Array.from(u)};return n.emitters.set(e,v),v}function Pt(e){let t=t=>[e[t],e[4+t],e[8+t]],n=(e,t)=>Math.hypot(e[1]*t[2]-e[2]*t[1],e[2]*t[0]-e[0]*t[2],e[0]*t[1]-e[1]*t[0]),r=t(0),i=t(1),a=t(2);return[n(i,a),n(a,r),n(r,i)]}function Ft(e,t,n){for(let r=0;r<8;r++){let i=[r&1?n[0]:0,r&2?n[1]:0,r&4?n[2]:0];for(let n=0;n<3;n++){let r=t[n*4]*i[0]+t[n*4+1]*i[1]+t[n*4+2]*i[2]+t[n*4+3];e[n]=Math.min(e[n],r),e[n+3]=Math.max(e[n+3],r)}}}function It(e,t){let n=new Int32Array(t).map((e,t)=>t),r=[],i=new Float32Array(1),a=new Uint32Array(i.buffer),o=e=>(i[0]=e,a[0]);if(!t)return{nodes:new Uint32Array,order:n};let s=(t,n)=>(e[t*6+n]+e[t*6+n+3])/2,c=e=>{let t=e[3]-e[0],n=e[4]-e[1],r=e[5]-e[2];return t>0||n>0||r>0?2*(t*n+n*r+r*t):0},l=()=>[1/0,1/0,1/0,-1/0,-1/0,-1/0],u=(t,n)=>{for(let r=0;r<3;r++)t[r]=Math.min(t[r],e[n*6+r]),t[r+3]=Math.max(t[r+3],e[n*6+r+3])},d=[[0,0,t,0]];for(r.push(0,0,0,0,0,0,0,0);d.length;){let[e,t,i,a]=d.pop(),f=l();for(let e=t;e<i;e++)u(f,n[e]);let p=(t,n)=>{let i=e*8;r[i]=o(f[0]),r[i+1]=o(f[1]),r[i+2]=o(f[2]),r[i+3]=t,r[i+4]=o(f[3]),r[i+5]=o(f[4]),r[i+6]=o(f[5]),r[i+7]=n},m=i-t;if(m<=2){p(t,m);continue}let h=l();for(let e=t;e<i;e++)for(let t=0;t<3;t++){let r=s(n[e],t);h[t]=Math.min(h[t],r),h[t+3]=Math.max(h[t+3],r)}let g=0;for(let e=1;e<3;e++)h[e+3]-h[e]>h[g+3]-h[g]&&(g=e);let _=t+(m>>1),v=h[g+3]-h[g],y=()=>{let e=Array.from(n.subarray(t,i)).sort((e,t)=>s(e,g)-s(t,g));n.set(e,t)};if(v>0&&a<12){let e=1/0,r=-1,a=-1;for(let o=0;o<3;o++){let d=h[o],f=h[o+3]-d;if(!(f>0))continue;let p=Array.from({length:12},()=>({box:l(),n:0}));for(let e=t;e<i;e++){let t=Math.min(11,Math.floor((s(n[e],o)-d)/f*12));p[t].n++,u(p[t].box,n[e])}for(let t=1;t<12;t++){let n=l(),i=l(),s=0,u=0;for(let e=0;e<t;e++)if(p[e].n){s+=p[e].n;for(let t=0;t<3;t++)n[t]=Math.min(n[t],p[e].box[t]),n[t+3]=Math.max(n[t+3],p[e].box[t+3])}for(let e=t;e<12;e++)if(p[e].n){u+=p[e].n;for(let t=0;t<3;t++)i[t]=Math.min(i[t],p[e].box[t]),i[t+3]=Math.max(i[t+3],p[e].box[t+3])}if(!s||!u)continue;let d=s*c(n)+u*c(i);d<e&&(e=d,r=o,a=t)}}if(r>=0){g=r;let e=h[g],o=e+(h[g+3]-e)*a/12;for(y(),_=t;_<i&&s(n[_],g)<o;)_++;(_===t||_===i)&&(_=t+(m>>1))}else y()}else y();let b=r.length/8;r.push(0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0),p(b,0),d.push([b+1,_,i,a+1],[b,t,_,a+1])}return{nodes:Uint32Array.from(r),order:n}}function Lt(e,t){let n=`scene.environment.map`;if(!H(e))throw TypeError(`${V} ${n} must be {width, height, data}`);let r=U(e.width,`${n}.width`,1,8192,`pass the image width in texels`),i=U(e.height,`${n}.height`,1,4096,`pass the image height in texels`);if(!Number.isInteger(r)||!Number.isInteger(i))throw RangeError(`${V} ${n} size ${r}x${i} must be whole texels`);let a=e.data;if(!(a instanceof Float32Array))throw TypeError(`${V} ${n}.data must be a Float32Array of linear RGB(A)`);let o=a.length===r*i*3?3:a.length===r*i*4?4:0;if(!o)throw TypeError(`${V} ${n}.data has ${a.length} floats; pass width * height * 3 (RGB) or * 4 (RGBA)`);let s=W(e.intensity,1,`${n}.intensity`,0,1e6,`pass 0 or more`),c=W(e.rotation,0,`${n}.rotation`,-1e6,1e6,`pass radians`),l=t.environment;if(l&&l.width===r&&l.height===i){let e=l.source.length===a.length;for(let t=0;e&&t<a.length;t++)e=Object.is(l.source[t],a[t]);if(e)return{...l,intensity:s,rotation:c}}let u=new Float32Array(r*i*4),d=new Float32Array(i),f=new Float32Array(r*i),p=0;for(let e=0;e<i;e++){let t=Math.sin(Math.PI*(e+.5)/i),s=0;for(let i=0;i<r;i++){let c=e*r+i,l=a[c*o],d=a[c*o+1],p=a[c*o+2];if(!(l>=0&&d>=0&&p>=0&&l<1/0&&d<1/0&&p<1/0))throw RangeError(`${V} ${n}.data texel ${i},${e} is negative or not finite; pass linear radiance`);let m=Ot(l,d,p)*t;u.set([l,d,p,m],c*4),s+=m,f[c]=s}for(let t=0;t<r;t++)f[e*r+t]=s>0?f[e*r+t]/s:(t+1)/r;p+=s,d[e]=p}for(let e=0;e<i;e++)d[e]=p>0?d[e]/p:(e+1)/i;return{source:a.slice(),width:r,height:i,intensity:s,rotation:c,texels:u,marginal:d,conditional:f,integral:p/(r*i)}}function Rt(e,t){let n=`scene.environment`;if(e!==void 0&&!H(e))throw TypeError(`${V} ${n} must be an object`);let r=e??{},i=(e,t)=>e===void 0?[1,1,1]:G(e,`${n}.${t}`,!0,`pass linear RGB`),a=i(r.skyColor,`skyColor`),o=W(r.skyIntensity,1,`${n}.skyIntensity`,0,1e6,`pass 0 or more`),s=r.sunDirection===void 0?[.4,.8,.3]:G(r.sunDirection,`${n}.sunDirection`,!1,`pass a direction toward the sun`),c=Math.hypot(...s);if(!(c>1e-12))throw RangeError(`${V} ${n}.sunDirection is zero; pass a direction toward the sun`);let l=i(r.sunColor,`sunColor`),u=W(r.sunIntensity,0,`${n}.sunIntensity`,0,1e6,`pass 0 (no sun) or more`),d=W(r.sunAngularSize,.0093,`${n}.sunAngularSize`,0,.5,`pass 0 to 0.5 radians`),f=r.groundColor===void 0?void 0:G(r.groundColor,`${n}.groundColor`,!0,`pass linear RGB`),p=W(r.groundHeight,0,`${n}.groundHeight`,-1e9,1e9,`pass a finite height`),m=W(r.groundFade,0,`${n}.groundFade`,0,0xe8d4a51000,`pass 0 (no fade) or a distance`),h=W(r.groundFadeStart,0,`${n}.groundFadeStart`,0,0xe8d4a51000,`pass a distance`),g=r.background===void 0?void 0:G(r.background,`${n}.background`,!0,`pass linear RGB, 0 or more, or leave it out`),_;if(r.fog!==void 0){if(!H(r.fog))throw TypeError(`${V} ${n}.fog must be {density, color?, anisotropy?}`);let e=W(r.fog.density,0,`${n}.fog.density`,0,1e6,`pass an extinction per unit above 0`),t=r.fog.color===void 0?[1,1,1]:G(r.fog.color,`${n}.fog.color`,!0,`pass linear RGB 0 to 1`),i=W(r.fog.anisotropy,0,`${n}.fog.anisotropy`,-.95,.95,`pass -0.95 to 0.95`);e>0&&(_={density:e,color:[Math.min(t[0],1),Math.min(t[1],1),Math.min(t[2],1)],anisotropy:i,hemisphere:zt(i)})}if(r.sunVisible!==void 0&&typeof r.sunVisible!=`boolean`)throw TypeError(`${V} ${n}.sunVisible must be true or false`);if(r.fadeModels!==void 0&&typeof r.fadeModels!=`boolean`)throw TypeError(`${V} ${n}.fadeModels must be true or false`);let v=[s[0]/c,s[1]/c,s[2]/c],y=r.map===void 0?void 0:Lt(r.map,t),b;if(r.physicalSky!==void 0){if(r.map!==void 0)throw TypeError(`${V} ${n} has both map and physicalSky; pass one of them`);let e=r.physicalSky;if(!H(e))throw TypeError(`${V} ${n}.physicalSky must be {turbidity?, intensity?, horizonBelow?}`);if(e.horizonBelow!==void 0&&typeof e.horizonBelow!=`boolean`)throw TypeError(`${V} ${n}.physicalSky.horizonBelow must be true or false`);let i=W(e.turbidity,3,`${n}.physicalSky.turbidity`,1.7,10,`pass 1.7 (clear) to 10 (hazy)`),a=W(e.intensity,.1,`${n}.physicalSky.intensity`,0,1e6,`pass 0 or more`),o=e.horizonBelow===!0,s=`${i},${a},${v.join(`,`)},${o}`;b=t.sky?.key===s?t.sky:{key:s,data:He(i,v,a,o)},y=Lt({width:Ie,height:512,data:b.data},t)}return{sky:[a[0]*o,a[1]*o,a[2]*o],sunDirection:v,sun:[l[0]*u,l[1]*u,l[2]*u],sunAngularSize:d,ground:f&&[Math.min(f[0],1),Math.min(f[1],1),Math.min(f[2],1)],groundHeight:p,sunVisible:r.sunVisible!==!1,groundFade:m,groundFadeStart:h,fadeModels:r.fadeModels===!0,background:g,fog:_,map:y,skyCache:b}}function zt(e){let t=new Float32Array(16);for(let n=0;n<16;n++){let r=-1+2*n/15,i=[Math.sqrt(Math.max(0,1-r*r)),r,0],a=0;for(let t=0;t<48;t++){let n=(t+.5)/48,r=Math.sqrt(1-n*n);for(let t=0;t<96;t++){let o=(t+.5)/96*2*Math.PI,s=i[0]*r*Math.cos(o)+i[1]*n,c=1+e*e-2*e*s;a+=(1-e*e)/(4*Math.PI*c*Math.sqrt(c))}}t[n]=a*2*Math.PI/4608}return t}function Bt(e){if(e===void 0)return{lights:new Float32Array,count:0,power:0};let t=_t(e,`lights`);if(t.length>it)throw RangeError(`${V} scene.lights has ${t.length} lights; at most ${it} are supported`);let n=[],r=[];for(let[e,i]of t.entries()){let t=`scene.lights[${e}]`;if(!H(i))throw TypeError(`${V} ${t} must be {position, direction, width, height}`);let a=G(i.position,`${t}.position`,!1,`pass a world point`),o=G(i.direction,`${t}.direction`,!1,`pass the side the light faces`),s=U(i.width,`${t}.width`,0,1e9,`pass a size above 0`),c=U(i.height,`${t}.height`,0,1e9,`pass a size above 0`),l=i.up===void 0?void 0:G(i.up,`${t}.up`,!1,`pass an up hint`),u=i.color===void 0?[1,1,1]:G(i.color,`${t}.color`,!0,`pass linear RGB`),d=W(i.intensity,1,`${t}.intensity`,0,1e6,`pass 0 or more`);if(!(s>0&&c>0&&Math.hypot(o[0],o[1],o[2])>0))throw RangeError(`${V} ${t} has no area; pass width and height above 0 and a nonzero direction`);if(i.twoSided!==void 0&&typeof i.twoSided!=`boolean`)throw TypeError(`${V} ${t}.twoSided must be true or false`);if(i.visible!==void 0&&typeof i.visible!=`boolean`)throw TypeError(`${V} ${t}.visible must be true or false`);if(i.opaque!==void 0&&typeof i.opaque!=`boolean`)throw TypeError(`${V} ${t}.opaque must be true or false`);let{right:f,up:p}=Fe(o,l,`${V} ${t}`),m=f.map(e=>e*s),h=p.map(e=>e*c),g=a.map((e,t)=>e-m[t]/2-h[t]/2),_=i.opaque!==!1,v=s*c;if(i.visible===!1)continue;let y=[u[0]*d,u[1]*d,u[2]*d],b=Ot(y[0],y[1],y[2])*v*(i.twoSided?2:1);(b>0||_)&&(r.push(b>0?b:0),n.push(g[0],g[1],g[2],0,m[0],m[1],m[2],+!!i.twoSided,h[0],h[1],h[2],v,...y),n.push(+!!_))}let i=r.reduce((e,t)=>e+t,0),a=0;for(let e=0;e<r.length;e++)a+=r[e],n[e*16+3]=e===r.length-1||!(i>0)?1:a/i;return{lights:Float32Array.from(n),count:r.length,power:i}}function Vt(e){let t=t=>{let n=Math.hypot(e[t*4],e[t*4+1],e[t*4+2]);return[e[t*4]/n,e[t*4+1]/n,e[t*4+2]/n]},[n,r,i]=[t(0),t(1),t(2)],a=(e,t)=>Math.abs(e[0]*t[0]+e[1]*t[1]+e[2]*t[2]);return a(n,r)<1e-6&&a(r,i)<1e-6&&a(n,i)<1e-6}function Ht(e,t,n){let r=t.map((e,t)=>{let r=n[t],i=0;for(let t=1;t<256;t++){if(!e.counts[t])continue;let n=t*32,a=r[n+15];if(a&dt){if(!(a&8)||r[n+5]<.999||r[n+16]>0||i)return 0;i=r[n+11]}}return i}),i=t.map((e,t)=>{let r=n[t];for(let t=1;t<256;t++){let n=t*32;if(e.counts[t]&&r[n+15]&8&&r[n+4]===1)return!0}return!1}),a=[],o=0,s=0;for(let[t,n]of e.entries()){let e=r[n.model];e&&!n.previous&&Vt(n.toLocal)&&o<ut&&(n.prism=!0,o++,a.push(t,e)),i[n.model]&&s<ut&&(n.mirror=!0,s++,a.push(t,0))}return Float32Array.from(a)}function Ut(e,t,n){let r=new Float32Array(8192);for(let[i,a]of e.entries()){let e=`${t}[${i}]`;if(!H(a))throw TypeError(`${V} ${e} must be an object {id, color, type}`);if(typeof a.id!=`number`||!Number.isInteger(a.id))throw TypeError(`${V} ${e}.id must be an integer palette index 1 to 255`);if(a.id<1||a.id>255)throw RangeError(`${V} ${e}.id ${a.id} is outside 1 to 255 (0 is empty); use an id from 1 to 255`);if(r[a.id*32+15])throw TypeError(`${V} ${e}.id ${a.id} is used twice; give each palette index one material`);jt(a,e,r,n)}return r}function Wt(e,t){let n=new Uint32Array(e.buffer,e.byteOffset,e.length),r=new Uint32Array(t.buffer,t.byteOffset,t.length);for(let e=0;e<n.length;e++)if(n[e]!==r[e])return!1;return!0}function Gt(e){let t=new Uint32Array(e.buffer,e.byteOffset,e.length),n=2166136261;for(let e=0;e<t.length;e++)n=Math.imul(n^t[e],16777619);return n>>>0}function Kt(e,t,n,r=0){if(!H(e))throw TypeError(`${V} scene must be {revision, models, instances, materials}`);if(typeof e.revision!=`number`||!Number.isFinite(e.revision))throw TypeError(`${V} scene.revision must be a finite number`);let i=_t(e.models,`models`),a=_t(e.instances,`instances`),o=_t(e.materials,`materials`);if(a.length>rt)throw RangeError(`${V} scene.instances has ${a.length}; at most ${rt} are supported`);let s=kt(e.textures),c=[Ut(o,`scene.materials`,s.length)],l=new Map,u=new Map,d=[],f=[],p=new Map,m=new Map,h=new Map,g=0;for(let[e,r]of i.entries()){let i=`scene.models[${e}]`;if(!H(r))throw TypeError(`${V} ${i} must be {id, revision, size, voxels}`);let a=gt(r.id,`${i}.id`);if(p.has(a))throw TypeError(`${V} ${i}.id '${a}' is used twice; give every model its own id`);if(r.materials===void 0)d.push(0);else{let e=r.materials;if(!Array.isArray(e))throw TypeError(`${V} ${i}.materials must be an array of materials`);let t=u.get(e);if(t===void 0){let n=Ut(e,`${i}.materials`,s.length),r=Gt(n),a=l.get(r)?.find(e=>Wt(c[e],n));if(a!==void 0)t=a;else{if(t=c.length,t>=st)throw RangeError(`${V} scene needs more than ${st} material tables; share tables between models`);c.push(n),l.set(r,[...l.get(r)??[],t])}u.set(e,t)}d.push(t)}let o=r.contentKey;if(o===null)throw TypeError(`${V} ${i}.contentKey is null; pass a key of the voxel contents, or leave it out`);let _=o===void 0?t.models.get(a)?.key===void 0?t.models.get(a):void 0:h.get(o)??t.keys?.get(o),v=r.size,y;_&&(o!==void 0||_.revision===r.revision)&&v?.length===3&&_.size.every((e,t)=>e===v[t])&&xt(r,_.size)?y=_:(y=St(r,i,n),g++),p.set(a,f.length),f.push(y),m.set(a,y),o!==void 0&&h.set(o,y)}let _=[],v=new Set,y=!1,b;for(let[e,t]of a.entries()){let n=`scene.instances[${e}]`;if(!H(t))throw TypeError(`${V} ${n} must be {id, modelId, matrix}`);let r=gt(t.id,`${n}.id`);if(v.has(r))throw TypeError(`${V} ${n}.id '${r}' is used twice; give every instance its own id`);v.add(r);let i=gt(t.modelId,`${n}.modelId`),a=p.get(i);if(a===void 0)throw TypeError(`${V} ${n}.modelId '${i}' names no model of this scene; add the model or fix the id`);let o=vt(t.matrix,`${n}.matrix`),s=t.previousMatrix===void 0?void 0:vt(t.previousMatrix,`${n}.previousMatrix`),c=t.motionInterpolation===void 0?`matrix`:t.motionInterpolation;if(c!==`matrix`&&c!==`trs`)throw TypeError(`${V} ${n}.motionInterpolation must be 'matrix' or 'trs'`);if(t.visible!==void 0&&typeof t.visible!=`boolean`)throw TypeError(`${V} ${n}.visible must be true or false`);if(t.visible===!1)continue;let l=new Float64Array([1/0,1/0,1/0,-1/0,-1/0,-1/0]),u=f[a].size,d;if(s)try{d=Pe(s,o,u,c,n)}catch(e){b??=e}d?(l.set(d.bounds),y=!0):Ft(l,o,u),_.push({id:r,source:e,model:a,toWorld:o,toLocal:bt(o),previous:d&&s,motion:d?.payload,box:l,lightPick:0,prism:!1,mirror:!1})}let x=e=>c[d[e]];for(let[e,t]of p){let n=f[t],r=x(t),i=d[t]?`model '${e}'.materials has`:`scene.materials has`;for(let t=1;t<256;t++)if(n.counts[t]&&!r[t*32+15])throw TypeError(`${V} model '${e}' uses palette index ${t} (${n.counts[t]} voxels) but ${i} no material with id ${t}; add one`)}let S=Rt(e.environment,t),{lights:C,count:w,power:T}=Bt(e.lights),E=4;for(let e of new Set(f))E+=e.grid.length+e.payload.length;if(E>n)throw RangeError(`${V} scene needs ${E*4} bytes of voxel bricks; this device binds at most ${n*4}; use fewer or smaller models`);if(c.length*256*32>n)throw RangeError(`${V} scene's ${c.length} material tables need ${c.length*256*32*4} bytes; this device binds at most ${n*4}; share tables between models`);let D=new Float64Array(_.length*6);for(let[e,t]of _.entries())D.set(t.box,e*6);let{nodes:O,order:k}=It(D,_.length),A=Array.from(k,e=>_[e]),j=f.map((e,n)=>{let r=x(n),i=Nt(e,r,t);if(!i)return{faces:new Uint32Array,cdf:new Float32Array,total:0};let a=new Float32Array(i.ids.length),o=0;for(let e=0;e<i.ids.length;e++){let t=i.ids[e]*32+8;o+=Ot(r[t],r[t+1],r[t+2])*(i.faces[e*2+1]>>>19&1?.25:1),a[e]=o}for(let e=0;e<a.length;e++)a[e]=e===a.length-1?1:a[e]/o;return{faces:i.faces,cdf:a,total:o}}),M=[],N=[];for(let[e,t]of A.entries()){let n=j[t.model].total;if(!(n>0))continue;let[r,i,a]=Pt(t.toWorld);M.push(e),N.push(n*(r+i+a)/3)}let P=N.reduce((e,t)=>e+t,0),F=new Float32Array(N.length),I=0;for(let e=0;e<N.length;e++)I+=N[e],F[e]=e===N.length-1?1:I/P,A[M[e]].lightPick=N[e]/P;return Yt({models:f,instances:A,nodes:O,textures:s,environment:S,emitters:j,emissiveInstances:{length:M.length},lightCount:w,voxelWords:E,materials:{length:c.length*256*32}},n,r),t.models=m,t.keys=h,S.map&&(t.environment=S.map),S.skyCache&&(t.sky=S.skyCache),{revision:e.revision,models:f,modelIds:[...p.keys()],modelIndex:p,packedModels:g,reusedModels:f.length-g,instances:A,nodes:O,materials:qt(c),modelTables:Uint32Array.from(d),environment:S,lights:C,lightCount:w,lightPower:T,emitters:j,emissiveInstances:Uint32Array.from(M),emissiveCdf:F,moving:y,motionError:b,deflectors:Ht(A,f,f.map((e,t)=>x(t))),clearGlass:f.some((e,t)=>e.counts.some((e,n)=>{let r=n*32,i=x(t);return n>0&&e>0&&(i[r+15]&dt)!==0&&!!(i[r+15]&8)&&i[r+5]>=.999&&i[r+16]===0})),focusing:f.some((e,t)=>e.counts.some((e,n)=>{let r=n*32,i=x(t);return n>0&&e>0&&(i[r+5]>0||i[r+3]<.1&&(i[r+4]>0||i[r+6]*i[r+7]>0))})),voxelWords:E,textures:s}}function qt(e){if(e.length===1)return e[0];let t=new Float32Array(e.length*256*32);for(let[n,r]of e.entries())t.set(r,n*256*32);return t}function Jt(e){return 4+e.models.length*12+e.instances.reduce((e,t)=>e+40+(t.motion?16:0),0)+e.nodes.length+e.textures.reduce((e,t)=>e+4+t.texels.length,0)}function Yt(e,t,n=0){if(e.voxelWords>t)throw RangeError(`${V} scene needs ${e.voxelWords*4} bytes of voxel bricks; this device binds at most ${t*4}; use fewer or smaller models`);if(e.materials.length>t)throw RangeError(`${V} scene's material tables need ${e.materials.length*4} bytes; this device binds at most ${t*4}; share tables between models`);let r=e.environment.map,i=e.emitters.reduce((e,t)=>e+t.cdf.length,0),a=Jt(e)+n+4+32+e.emissiveInstances.length*2+i*3+e.lightCount*16+(r?r.height+r.width*r.height:0);if(r&&r.width*r.height*4>t)throw RangeError(`${V} scene.environment.map ${r.width}x${r.height} needs ${r.width*r.height*16} bytes; this device binds at most ${t*4}; pass a smaller map`);if(a>t)throw RangeError(`${V} scene's records, textures and light tables (${i} emissive voxel faces) need ${a*4} bytes and this device binds at most ${t*4}; use fewer emissive voxels, instances or textures`)}var Xt=1024,Zt=2048,Qt=4096,$t=8192,en=16384,tn=32768,nn=new Float32Array(1),rn=new Uint32Array(nn.buffer),an=e=>(nn[0]=e,rn[0]);function on(e,t){let n=new Uint32Array(e.grid.length+e.payload.length),r=t+e.grid.length;for(let t=0;t<e.grid.length;t++){let i=e.grid[t];n[t]=i===0||i>=2147483648?i:r+((i&~nt)-1)*128|i&nt}return n.set(e.payload,e.grid.length),n}function sn(e){let t=e.environment.map,n=Jt(e),r=n+4,i=r;r+=e.deflectors.length;let a=r;r+=e.emissiveInstances.length*2;let o=e.emitters.map(e=>{let t=r;return r+=e.cdf.length*3,{first:t,count:e.cdf.length,total:e.total}}),s=r;r+=e.lightCount*16;let c=r;r+=t?t.height:0;let l=r;r+=t?t.width*t.height:0;let u=new Uint32Array(r),d=new Float32Array(u.buffer);u[1]=n,u[n]=i,u[n+1]=e.deflectors.length/2;for(let t=0;t<e.deflectors.length;t+=2)u[i+t]=e.deflectors[t],d[i+t+1]=e.deflectors[t+1];for(let t=0;t<e.emissiveInstances.length;t++)u[a+t*2]=e.emissiveInstances[t],d[a+t*2+1]=e.emissiveCdf[t];for(let[t,n]of e.emitters.entries())for(let e=0;e<n.cdf.length;e++)u[o[t].first+e*3]=n.faces[e*2],u[o[t].first+e*3+1]=n.faces[e*2+1],d[o[t].first+e*3+2]=n.cdf[e];return d.set(e.lights,s),t&&(d.set(t.marginal,c),d.set(t.conditional,l)),{words:u,emissiveBase:a,areaBase:s,marginalBase:c,conditionalBase:l,emitters:o}}function cn(e,t,n){let r=4+e.models.length*12,i=r+e.instances.length*40,a=e.nodes.length/8,o=i+e.nodes.length,s=o+e.instances.reduce((e,t)=>e+(t.motion?16:0),0),c=n.words,l=new Float32Array(c.buffer),u=o;c[0]=e.textures.length?s:0;let d=s+4*e.textures.length;for(let[t,n]of e.textures.entries())c.set([d,n.width,n.height,0],s+4*t),c.set(n.texels,d),d+=n.texels.length;for(let[r,i]of e.models.entries()){let a=4+r*12,o=n.emitters[r];c.set([i.size[0],i.size[1],i.size[2],t[r],i.bricks[0],i.bricks[1],i.bricks[2],e.modelTables[r]<<8],a),c[a+8]=o.first,c[a+9]=o.count,c[a+10]=an(o.total)}for(let[t,n]of e.instances.entries()){let e=r+t*40;l.set(n.toLocal,e),l.set(n.toWorld,e+12),l.set(n.previous??n.toWorld,e+24),c[e+36]=n.model,c[e+37]=+!!n.previous|(n.prism?2:0)|(n.mirror?4:0)|(n.motion?8:0),l[e+38]=n.lightPick,n.motion&&(c[e+39]=u,l.set(n.motion,u),u+=16)}return c.set(e.nodes,i),{words:c,modelBase:4,instanceBase:r,nodeBase:i,nodeCount:a}}var ln=1<<20,un=e=>e*4+16+(e+1)*16,dn=ln*un(8);function fn(e,t=dn){return Math.max(1,Math.min(ln,Math.floor(t/un(e))))}var pn=class{constructor(){this.budget=dn/16}observe(e,t){if(!(e>0)||!(t>0))return;let n=e/t*50;this.budget=Math.max(dn/4096,Math.min(dn,this.budget*2,n))}};function mn(e,t,n,r,i=1,a=ln,o=a){let s=Math.min(t,i),c=Math.max(1,Math.min(r,Math.floor(a/(s*e)))),l=Math.min(t,Math.max(s,Math.floor(Math.min(o,a)/(e*c)/i)*i)),u=[];for(let e=0;e<r;e+=c)for(let i=0;i<t;i+=l)u.push({y0:i,rows:Math.min(l,t-i),s0:n+e,count:Math.min(c,r-e)});return u}function hn(e,t){let n=e*16,r=t;for(;r;)[n,r]=[r,n%r];return t/n}var gn=`fn pbrNeutral(input:vec3f)->vec3f {let x=min(input.r,min(input.g,input.b));let offset=select(0.04,x-6.25*x*x,x<0.08);var v=input-offset;let peak=max(v.r,max(v.g,v.b));if(peak<0.76){return v;}let newPeak=1.0-0.24*0.24/(peak+0.24-0.76);v*=newPeak/peak;return mix(v,vec3f(newPeak),1.0-1.0/(0.15*(peak-newPeak)+1.0));}
fn toDisplay(c:vec3f)->vec3f {let x=pbrNeutral(max(c,vec3f(0)));return select(x*12.92,1.055*pow(x,vec3f(1.0/2.4))-0.055,x>=vec3f(0.0031308));}
`,K=Object.freeze({twoOverPi:[0,2734261102,1313084713,4230436817,4113882560,3680671129,1011060801,4266746795],halfPiFixed:3373259426,halfPi:[1.5707963705062866,-4.371138828673793e-8],quarterPi:[.7853981852531433,-2.1855694143368964e-8],pi:[3.1415927410125732,-8.742277657347586e-8],ln2:[.693145751953125,1428606765330187e-21],ln2Pair:[.6931471824645996,-1.9046542121259336e-9],log2e:[1.4426950216293335,1.925963033500011e-8],sin:[-.1666666716337204,.008333379402756691,-.00019853089179378003,2833021881087916e-21],cos:[.0416666679084301,-.0013888980029150844,2482202216924634e-20,-2.8881245839329495e-7],atan:[-.3333333432674408,.20000059902668,-.14286741614341736,.11114691942930222,-.09025663882493973,.06947030127048492,-.03550770878791809],asin:[.1666666716337204,.07499949634075165,.044659871608018875,.03011295571923256,.024605773389339447,.007497195154428482,.03466988354921341],sinh:[.1666666716337204,.00833326205611229,.00019874409190379083,20846018742304295e-22,6.411173671949655e-7,-2.0997923400045693e-7],cosh:[.0416666679084301,.0013888796092942357,2482521813362837e-20,2.506288865333772e-7,1.1460320692435744e-8],tanh:[-.3333333432674408,.1333339512348175,-.05398104339838028,.021990614011883736,-.009435489773750305,.004868379328399897,-.0023415694013237953],expm1:[.5,.1666666567325592,.04166649281978607,.008333546109497547,.0013932319125160575,.00019761594012379646],log:[.6666666269302368,.40000975131988525,.28498485684394836,.24286234378814697]}),q=e=>{let t=String(e);for(let n=1;n<=9;n++){let r=e.toPrecision(n);if(Math.fround(Number(r))===e){t=r;break}}return/[.e]/.test(t)?t:`${t}.0`},_n=(e,t)=>{let n=q(t[t.length-1]);for(let r=t.length-2;r>=0;r--)n=`(${e} * ${n} + ${q(t[r])})`;return n},vn=e=>`0x${e.toString(16)}u`,yn,bn=()=>yn??={pmBits:[[],`fn pmExponent(x: f32) -> u32 { return (bitcast<u32>(x) >> 23u) & 0xffu; }
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
const PM_PIO2_HI: f32 = ${q(K.halfPi[0])};
const PM_PIO2_LO: f32 = ${q(K.halfPi[1])};
const PM_PIO4_HI: f32 = ${q(K.quarterPi[0])};
const PM_PIO4_LO: f32 = ${q(K.quarterPi[1])};
const PM_PI_HI: f32 = ${q(K.pi[0])};
const PM_PI_LO: f32 = ${q(K.pi[1])};
const PM_LN2_HI: f32 = ${q(K.ln2[0])};
const PM_LN2_LO: f32 = ${q(K.ln2[1])};
const PM_LN2: f32 = ${q(K.ln2Pair[0])};
const PM_LN2_TAIL: f32 = ${q(K.ln2Pair[1])};
const PM_LOG2E: f32 = ${q(K.log2e[0])};
const PM_LOG2E_LO: f32 = ${q(K.log2e[1])};
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
${K.twoOverPi.map((e,t)=>`    case ${t}u: { return ${vn(e)}; }`).join(`
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
 let L = pmMul32(lo, ${K.halfPiFixed}u); let H = pmMul32(hi, ${K.halfPiFixed}u);
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
 let p = ${_n(`w`,K.sin)};
 return h + pmHide(l * (1.0 - 0.5 * w) + (h * w) * p);
}
fn pmCosK(h: f32, l: f32) -> f32 {
 let w = pmHide(h * h); let hw = 0.5 * w; let t = pmFastTwoSum(1.0, -hw);
 let ew = pmProductError(h, h, w);
 let p = ${_n(`w`,K.cos)};
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
 let p = ${_n(`w`,K.atan)};
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
 let p = ${_n(`w`,K.asin)};
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
`],pmExp:[[`pmBits`],`fn pmExpm1P(r: f32) -> f32 { return ${_n(`r`,K.expm1)}; }
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
 if (a <= 1.0) { let w = a * a; r = a + pmHide((a * w) * ${_n(`w`,K.sinh)}); }
 else if (a > 88.72284) { let t = preciseExp(0.5 * a); r = pmHide(0.5 * t) * t; }
 else if (a > 9.0) { r = 0.5 * preciseExp(a); }
 else { let e = preciseExpm1(a); r = 0.5 * (e + preciseDiv(e, e + 1.0)); }
 return pmWithSign(r, x);
}
`],preciseCosh:[[`preciseExp`,`preciseDiv`],`fn preciseCosh(x: f32) -> f32 {
 let a = abs(x);
 if (pmIsNan(x)) { return x; }
 if (a < 0.000244140625) { return 1.0; }
 if (a <= 1.0) { let w = a * a; return 1.0 + pmHide((w * w) * ${_n(`w`,K.cosh)} + 0.5 * w); }
 if (a > 88.72284) { let t = preciseExp(0.5 * a); return pmHide(0.5 * t) * t; }
 let t = preciseExp(a);
 return 0.5 * (t + preciseDiv(1.0, t));
}
`],preciseTanh:[[`preciseExpm1`,`preciseDiv`],`fn preciseTanh(x: f32) -> f32 {
 let a = abs(x);
 if (pmIsNan(x)) { return x; }
 if (a < 0.000244140625) { return x; }
 if (a > 9.1) { return pmWithSign(1.0, x); }
 if (a <= 0.55) { let w = a * a; return pmWithSign(a + pmHide((a * w) * ${_n(`w`,K.tanh)}), x); }
 let e = preciseExpm1(2.0 * a);
 return pmWithSign(preciseDiv(e, e + 2.0), x);
}
`],pmLog:[[`preciseDiv`],`struct PmLogK { s: f32, R: f32, hfsq: f32, t: f32 }
fn pmLogK(f: f32) -> PmLogK {
 let s = preciseDiv(f, 2.0 + f);
 let z = s * s;
 let R = z * ${_n(`z`,K.log)};
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
 let w = pmFastTwoSum(${q(Math.fround(2/3))}, ${q(Math.fround(2/3-Math.fround(2/3)))} + z * ${_n(`z`,[2/5,2/7,2/9,2/11,2/13,2/15].map(e=>Math.fround(e)))});
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
`]},xn=Object.freeze([`preciseDiv`,`preciseSqrt`,`preciseSin`,`preciseCos`,`preciseTan`,`preciseAtan`,`preciseAtan2`,`preciseAsin`,`preciseAcos`,`preciseExp`,`preciseExp2`,`preciseExpm1`,`preciseSinh`,`preciseCosh`,`preciseTanh`,`preciseLog`,`preciseLog2`,`preciseLog1p`,`precisePow`]);function Sn(e){let t=[],n=new Set,r=e=>{if(n.has(e))return;let i=bn()[e];if(!i)throw RangeError(`Unknown precise maths function ${e}; use one of ${xn.join(`, `)}`);n.add(e);for(let e of i[0])r(e);t.push(i[1])};for(let t of e)r(t);return t.join(``)}var Cn=(e,t,n=`nh`,r=`a2`)=>`(max(dot(cross(${e},${t}),cross(${e},${t})),step(${n},0.0))+${r}*${n}*${n})`,wn=`
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
`,Tn=e=>`${Math.round(e*2**32)%2**32}u`,En=`
const PI=3.141592653589793;
const TAU=6.283185307179586;
const INV_PI=0.3183098861837907;
fn basis(n:vec3f)->mat3x3f {
 let s=select(-1.0,1.0,n.z>=0.0);let a=-1.0/(s+n.z);let b=n.x*n.y*a;
 return mat3x3f(vec3f(1.0+s*n.x*n.x*a,s*b,-s*n.x),vec3f(b,s+n.y*n.y*a,-n.y),n);
}
fn ggxD(a2:f32,n:vec3f,h:vec3f)->f32 {let nh=max(dot(n,h),0.0);let k=${Cn(`n`,`h`)};return a2/(PI*k*k);}
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
`,Dn=2312,On=`${En}
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
 for(var k=0u;k<SAMPLES;k++){sum+=reflectWeight(mu,alpha,vec2f(seq(k,${Tn(.7548776662466927)}),seq(k,${Tn(.5698402909980532)})));}
 return sum/f32(SAMPLES);
}
fn averageE(r:f32)->f32 {
 let alpha=max(r*r,1e-4);var sum=0.0;let n=SAMPLES*16u;
 for(var k=0u;k<n;k++){
  let mu=max(sqrt(seq(k,${Tn(.8191725133961645)})),0.002);
  sum+=reflectWeight(mu,alpha,vec2f(seq(k,${Tn(.6710436067037893)}),seq(k,${Tn(.5497004779019703)})));
 }
 return sum/f32(n);
}
fn albedoGlass(mu:f32,r:f32,eta:f32)->f32 {
 let alpha=max(r*r,1e-4);let a2=alpha*alpha;let n=vec3f(0.0,0.0,1.0);let wo=vec3f(sqrt(max(0.0,1.0-mu*mu)),0.0,mu);
 let lo=lambdaG(a2,mu);var sum=0.0;
 for(var k=0u;k<SAMPLES;k++){
  let m=vndfU(wo,alpha,n,vec2f(seq(k,${Tn(.7548776662466927)}),seq(k,${Tn(.5698402909980532)})));
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
`,kn=`${wn}${En}${et}${Sn([`preciseSin`,`preciseCos`,`preciseAsin`,`preciseAtan`])}
const INF=3.0e38;
const NONE=0xffffffffu;
const GROUND=0xfffffffeu;
const AREA=0xfffffffdu;
const EPS=2e-3;
const MEDIA=1u;
const EMISSIVE=4u;
const SMOOTH=8u;
const DELTA=${pt};
// GGX alpha below which a lobe is specular for caustics (scene.ts decides from it whether a scene has any).
const GLOSSY=${mt};
const SUN=1u;
const HAS_GROUND=2u;
const ENV=4u;
const MOTION=8u;
const JITTER=16u;
const CLAMP=32u;
const SPLIT=64u;
const DIRECT=${tn}u;
const AREA_NEE=128u;
const CAMERA_MOTION=256u;
const CLEAR_GLASS=512u;
const OPAQUE_SHADOWS=${Xt}u;
const SUN_DIFFUSE=${Zt}u;
const NO_SUN_MEDIA=${Qt}u;
const HIDE_SUN=${$t}u;
const NO_COMPENSATION=${en}u;
const ADDITIVE=32u;
const UNTINTED=64u;
const SUNLIT=128u;
const SUBSURFACE=${lt}u;
const WALK=256u;
const VOXELWISE=256u;
const CONTACT=512u;
const CUTOUT=${ct}u;
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
@group(0) @binding(9) var<uniform> tables:array<vec4f,${Dn}>;
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
struct Seen {albedo:vec3f,normal:vec3f,inv:f32,primary:f32}
struct Path {color:vec3f,caustic:vec3f,direct:vec3f,seen:Seen}
fn radiance(px:vec2u)->Path {
 var res:Seen;
 var jit=vec2f(0.5);
 if((f.config.z&JITTER)!=0u){jit=vec2f(rand(),rand());}
 motion=1.0;
 if((f.config.z&MOTION)!=0u){motion=1.0-f.weights.z*rand();}
 let ray=cameraRay(vec2f(px)+jit);
 if(dot(ray.d,ray.d)==0.0){res.albedo=vec3f(0.0);res.primary=1.0;return Path(vec3f(0.0),vec3f(0.0),vec3f(0.0),res);}
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
 var diffuse=false;var focused=false;var C=vec3f(0.0);var D=vec3f(0.0);
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
 var wLp=0.0;var wPdf=0.0;var wCaustic=false;var wDirect=false;
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
     let add=wAdd*wT*wJ*select(1.0,power2(wLp/wJ,wPdf)/wLp,wLp>0.0);L+=add;if(wCaustic){C+=add;}else if(wDirect){D+=add;}
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
   let add=thr*fogGlow(d/dl)*(1.0-tr);L+=add;if(focused){C+=add;}else if(bounces<=1u){D+=add;}
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
   if(any(md.emit!=vec3f(0.0))){let add=thr*md.emit*min(ts,min(h.t,1e30));L+=add;if(focused){C+=add;}else if(bounces<=1u){D+=add;}}
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
    let add=thr*select(environment(d,select(0.0,sunPdf,kept),jChain,bounces==0u),f.background.xyz,bg);L+=add;if(focused){C+=add;}else if(bounces<=1u){D+=add;}
    break;
   }
   if(h.inst==AREA){
    let add=thr*areaHit(h.value,d,distance(p,lastVertex),lastPdf);L+=add;if(focused){C+=add;}else if(bounces<=1u){D+=add;}
    if(feature){feature=false;res.albedo=tint;res.normal=-d;res.primary=select(0.0,1.0,bounces==0u);}
    break;
   }
   // Seen by the camera, the ground (and models, when asked) at distance D fades into the sky behind it by
   // 1 - e^(-(D - start) / fade).
   let fade=bitcast<f32>(f.limits.w);
   if(bounces==0u&&fade>0.0&&f.fog.z==0.0&&(h.inst==GROUND||f.groundFade.y>0.0)){
    let w=1.0-exp(-max(0.0,h.t*length(d)-f.groundFade.x)/fade);
    let add=thr*w*skyBehind(d);L+=add;D+=add;thr*=1.0-w;
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
    let add=thr*e*emitWeight(lightHit,n,d,m.emission,lastPdf);L+=add;if(focused){C+=add;}else if(bounces<=1u){D+=add;}
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
   if(caustic){C+=add;}else if(bounces==0u){D+=add;}
   if(walk.total>0.0){
    // Walked from the next loop turn on; the path resumes after it.
    pending=true;wo=walk.o;wd=walk.d;wMedium=walk.medium;wInst=walk.mInst;wS=walk.s;wWant=walk.want;
    wAdd=thr*walk.f;wLp=walk.lp;wPdf=walk.pdf;wCaustic=caustic;wDirect=bounces==0u;
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
 var got=Path(L,C,D,res);
 if((f.config.z&CLAMP)!=0u){let l=lum(L);if(l>f.weights.w){let k=f.weights.w/l;got.color*=k;got.caustic*=k;got.direct*=k;}}
 // Finite values only (dispersive paths may carry negative channel weights; their mean is right).
 if(!all(abs(got.color)<vec3f(1e30))||!all(abs(got.caustic)<vec3f(1e30))||!all(abs(got.direct)<vec3f(1e30))){
  got.color=vec3f(0.0);got.caustic=vec3f(0.0);got.direct=vec3f(0.0);
 }
 return got;
}

@compute @workgroup_size(8,8) fn trace(@builtin(global_invocation_id) gid:vec3u) {
 if(gid.x>=f.tile.x||gid.y>=f.tile.y){return;}
 let px=vec2u(gid.x+f.image.z,gid.y+f.image.w);
 let pixel=px.y*f.image.x+px.x;
 let slot=gid.y*f.tile.x+gid.x;
 var c=vec4f(0.0);var a=vec4f(0.0);var nn=vec4f(0.0);var cs=vec4f(0.0);var ds=vec4f(0.0);
 let split=(f.config.z&SPLIT)!=0u;
 let two=(f.config.z&DIRECT)!=0u;
 for(var s=0u;s<f.tile.w;s++){
  rng=hash((pixel*0x9e3779b1u)^hash(f.tile.z+s+hash(f.config.y)));
  let r=radiance(px);
  let rc=select(vec3f(0.0),r.caustic,split);let rd=select(vec3f(0.0),r.direct,two);
  let l=lum(r.color-rc-rd);let lc=lum(r.caustic);let ld=lum(rd);
  c+=vec4f(r.color,l*l);
  cs+=vec4f(r.caustic,lc*lc);
  ds+=vec4f(rd,ld*ld);
  a+=vec4f(r.seen.albedo,r.seen.inv);
  nn+=vec4f(r.seen.normal,r.seen.primary);
 }
 let both=split&&two;let part=select(slot,2u*slot,both);let dpart=select(slot,2u*slot+1u,both);
 if(f.tile.z==0u){accum[slot]=c;albedo[slot]=a;normals[slot]=nn;if(split){caustics[part]=cs;}if(two){caustics[dpart]=ds;}}
 else{accum[slot]+=c;albedo[slot]+=a;normals[slot]+=nn;if(split){caustics[part]+=cs;}if(two){caustics[dpart]+=ds;}}
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
`,An=`
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
fn causticAt(q:u32)->vec4f {return caustics[q<<((p.size.w>>7u)&1u)];}
fn directAt(q:u32)->vec4f {return caustics[select(q,2u*q+1u,(p.size.w&2u)!=0u)];}
fn partLum(q:u32,part:u32)->f32 {
 let k=p.sigma.w;var lc=0.0;var ld=0.0;
 if(part==1u||(p.size.w&2u)!=0u){lc=lum(causticAt(q).xyz*k);}
 if(part==2u||(p.size.w&128u)!=0u){ld=lum(directAt(q).xyz*k);}
 if(part==1u){return lc;}
 if(part==2u){return ld;}
 return lum(accum[q].xyz*k)-lc-ld;
}
fn partOf(q:u32,part:u32)->vec3f {
 let k=p.sigma.w;var cc=vec3f(0.0);var dd=vec3f(0.0);
 if(part==1u||(p.size.w&2u)!=0u){cc=causticAt(q).xyz*k;}
 if(part==2u||(p.size.w&128u)!=0u){dd=directAt(q).xyz*k;}
 if(part==1u){return cc;}
 if(part==2u){return dd;}
 return accum[q].xyz*k-cc-dd;
}
struct Local {v:f32,c:vec3f,n:f32,white:f32}
fn spatial(g:vec2u,np:vec3f,t:f32,foot:f32,through:bool)->Local {
 let k=p.sigma.w;let w=i32(p.size.x);let h=i32(p.size.y);
 let pp=hitPoint(f32(g.x)+0.5,f32(g.y)+0.5,t);
 let planar=t>0.0&&!through&&(p.size.w&4u)==0u;let plane=p.sigma.z*foot+1e-6;
 var s0=0.0;var s1=0.0;var s2=0.0;var sc=vec3f(0.0);var sw=0.0;
 var above=array<f32,7>();var d2=0.0;var dn=0.0;
 for(var y=-3;y<=3;y++){var left=-1.0;for(var x=-3;x<=3;x++){
  let qx=i32(g.x)+x;let qy=i32(g.y)+y;
  if(qx<0||qy<0||qx>=w||qy>=h){left=-1.0;above[x+3]=-1.0;continue;}
  let q=u32(qy*w+qx);let nq=normals[q];let lq=length(nq.xyz);let iq=albedo[q].w*k;let tq=select(0.0,1.0/iq,iq>0.0);
  var wt=select(0.0,1.0,(t>0.0)==(tq>0.0)&&through==(nq.w*k<0.5));
  if(planar&&wt>0.0){wt=exp(-abs(dot(np,hitPoint(f32(qx)+0.5,f32(qy)+0.5,tq)-pp))/plane);}
  wt*=pow(max(0.0,dot(np,select(vec3f(0.0,0.0,1.0),nq.xyz/lq,lq>1e-6))),p.sigma.y);
  let aq=albedoAt(q);let rq=partOf(q,0u);let l=lum(rq)/max(lum(aq),0.02);
  s0+=wt;s1+=l*wt;s2+=l*l*wt;sc+=rq/aq*wt;sw+=wt*wt;
  let on=select(-1.0,l,wt>0.5);
  if(on>=0.0&&left>=0.0){d2+=(on-left)*(on-left);dn+=1.0;}
  if(on>=0.0&&y>-3&&above[x+3]>=0.0){d2+=(on-above[x+3])*(on-above[x+3]);dn+=1.0;}
  left=on;above[x+3]=on;
 }}
 let d=max(s0,1e-6);let m=s1/d;let v=max(0.0,s2/d-m*m);
 return Local(v,sc/d,d*d/max(sw,1e-12),select(0.0,d2/dn/(2.0*v+1e-12),dn>=8.0));
}
fn variance(i:u32,c:vec3f,m2:f32,part:u32,g:vec2u)->f32 {
 let k=p.sigma.w;let n=1.0/k;let l=lum(c);let w=p.size.x;let h=p.size.y;
 var v=max(0.0,m2-l*l)/max(n-1.0,1.0);
 if(n<4.0){
  var s1=0.0;var s2=0.0;
  for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){
   let q=u32(clamp(i32(g.y)+y,0,i32(h)-1))*w+u32(clamp(i32(g.x)+x,0,i32(w)-1));
   let lq=partLum(q,part);
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
 let split=(p.size.w&2u)!=0u;let lane=(p.size.w&256u)!=0u;
 var cc=vec3f(0.0);var dd=vec3f(0.0);
 if(split){cc=causticAt(i).xyz*k;}
 if((p.size.w&128u)!=0u){dd=directAt(i).xyz*k;}
 var c=accum[i].xyz*k-cc-dd;var m2=accum[i].w*k;let a=albedoAt(i);
 if(lane){c=dd;m2=directAt(i).w*k;}
 let la=max(lum(a),0.02);
 var e=c/a;var ev=variance(i,c,m2,select(0u,2u,lane),g.xy)/(la*la);
 if(split&&!lane){dst2[i]=vec4f(cc/a,variance(i,cc,causticAt(i).w*k,1u,g.xy)/(la*la));}
 let nn=normals[i].xyz;let len=length(nn);
 let inv=albedo[i].w*k;
 let t=select(0.0,1.0/inv,inv>0.0);
 let x=f32(g.x)+0.5;let y=f32(g.y)+0.5;
 let foot=select(0.0,length(hitPoint(x+1.0,y,t)-hitPoint(x,y,t)),t>0.0);
 // Features seen through glass or a mirror (most samples): no plane test, the first hit's plane is not theirs.
 let through=normals[i].w*k<0.5;
 let nrm=select(vec3f(0.0,0.0,1.0),nn/len,len>1e-6);
 var loc=Local(0.0,vec3f(0.0),0.0,0.0);
 if(n<4.0&&!lane&&(p.size.w&128u)!=0u){loc=spatial(g.xy,nrm,t,foot,through);ev=max(ev,loc.v);}
 var count=n;
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
     e=(e*n+vec3f(h0,h1.x)*nh)/(n+nh);ev*=n/(n+nh)*wide*wide;count=n+nh;
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
  let shown=dst[i];let kept=packHalves(vec2f(e.z,min(select(32.0,8.0,through),n+nh)));
  if(lane){textureStore(hout,g.xy,vec4u(packHalves(e.xy),kept,pack2x16float(oct(nrm)),bitcast<u32>(t)));}
  else{textureStore(hout,g.xy,vec4u(packHalves(e.xy),kept,
   packHalves(shown.xy),packHalves(vec2f(shown.z,clamp(shown.w,0.0,8.0)+16.0*f32(mask)))));}
 }
 let own=min(loc.white,1.0)/count;let other=min(loc.white,1.0)/max(loc.n,1.0)+max(0.0,1.0-loc.white);
 dst[i]=vec4f(mix(e,loc.c,own/max(own+other,1e-6)*clamp((4.0-count)/3.0,0.0,1.0)),ev);
 if(!lane){guide[i]=vec4f(oct(nrm),t,select(foot,-1.0,through||(p.size.w&4u)!=0u));}
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
 if((p.size.w&512u)!=0u){r+=dst2[i];}
 dst[i]=r;
}
// The filtered estimate of pixel q (both chains, remodulated) and the variance of its luminance.
fn filteredAt(q:u32,split:bool)->vec4f {var f=dst[q];if(split){f+=src[q];}return vec4f(f.xyz,max(f.w,0.0));}
// The raw mean of pixel q and the variance of its luminance (regular and caustic parts, as prepare estimates them).
fn rawAt(q:u32,g:vec2u)->vec4f {
 let k=p.sigma.w;var cc=vec3f(0.0);var dd=vec3f(0.0);var v=0.0;
 if((p.size.w&2u)!=0u){cc=causticAt(q).xyz*k;v=variance(q,cc,causticAt(q).w*k,1u,g);}
 if((p.size.w&128u)!=0u){dd=directAt(q).xyz*k;v+=variance(q,dd,directAt(q).w*k,2u,g);}
 let r=accum[q].xyz*k;
 return vec4f(r,v+variance(q,r-cc-dd,accum[q].w*k,0u,g));
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
  let q=qy*w+qx;let f=filteredAt(q,split);let r=rawAt(q,vec2u(qx,qy));
  let wq=select(0.5,1.0,x==0)*select(0.5,1.0,y==0);
  let dl=lum(f.xyz)-lum(r.xyz);d1+=dl*wq;d2+=dl*dl*wq;vr+=r.w*wq;vf+=f.w*wq;ws+=wq;ww+=wq*wq;
 }}
 d1/=ws;d2/=ws;vr/=ws;vf/=ws;
 let f=filteredAt(i,split);let r=rawAt(i,g);
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
 // Flags 2 and 128: there are a caustic or a direct chain (src holds their sum) to add.
 let split=(p.size.w&130u)!=0u;
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
`,jn=`${gn}
${M}
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
`,Mn=class extends Error{constructor(e,t){super(t),this.name=`MargoError`,this.code=e}static[Symbol.hasInstance](e){return e instanceof Error&&e.name===`MargoError`}},Nn=(e,t)=>Object.assign(Error(t),{name:`MargoError`,code:e}),Pn=(e,t)=>`${e}; see https://margoengine.com/errors#${t}`,J=(e,t,n=e)=>Nn(e,Pn(t,n)),Y=(e,t)=>TypeError(Pn(e,t)),X=(e,t)=>RangeError(Pn(e,t)),Fn=()=>{throw Object.assign(Y(`Retained vector: use a transform setter`,`transform`),{code:`transform`})};function In(e){return!/^(Compile|Eval|Runtime)Error$/.test(e?.name)||!/wasm-unsafe-eval|content security policy|\bCSP\b|disallowed by embedder/i.test(e.message)?e:Object.assign(Nn(`failed`,`Wasm compilation blocked by CSP; add 'wasm-unsafe-eval' to script-src; see https://margoengine.com/llms/docs/csp.md`),{cause:e})}var Ln=[.018,.023,.035,1],Rn=e=>/^#([\da-f]{3}){1,2}$/i.test(e)?parseInt((e[4]?e:e.replace(/\w/g,`$&$&`)).slice(1),16):-1,zn=e=>(e/=255)>.04045?((e+.055)/1.055)**2.4:e/12.92,Bn=e=>e/255,Vn=/float$|srgb$/,Hn=Ln.map(e=>zn(e*255));function Un(e,t){let n=Vn.test(t)?zn:Bn;if(typeof e!=`string`)return n===Bn?Ln:Hn;let r=Rn(e);if(r<0)throw RangeError(`Invalid color; use #rrggbb`);return[n(r>>16),n(r>>8&255),n(r&255),1]}var Wn=new WeakMap;function Gn(e,t){let n=Wn.get(e);if(!n){let t=e.createBindGroupLayout({entries:[{binding:0,visibility:2,buffer:{}}]});n={group:t,layout:e.createPipelineLayout({bindGroupLayouts:[t]}),groups:new Map},Wn.set(e,n)}let r=t.join(),i=n.groups.get(r);if(!i){let a=e.createBuffer({size:16,usage:72});if(e.queue.writeBuffer(a,0,new Float32Array(t)),i=e.createBindGroup({layout:n.group,entries:[{binding:0,resource:{buffer:a}}]}),i.b=a,n.groups.size>63){let[t,r]=n.groups.entries().next().value;n.groups.delete(t),e.queue.onSubmittedWorkDone().then(()=>r.b.destroy())}n.groups.set(r,i)}return[n.layout,i]}function Kn(e,t,n,{formats:r,values:i=[],depthFormat:a,writeDepth:o,samples:s=1,writeColor:c=!0,tint:l=Ln}){let u=[r,i,a,+!!o,s,+c].join(`|`),[d,f]=Gn(e,l),p=t.get(u);if(!p){let n=r.map((e,t)=>`@location(${t}) c${t}:vec4f`).join(`,`),l=e.createShaderModule({code:`@group(0) @binding(0) var<uniform> t:vec4f;
struct Out{${n}}
@vertex fn v(@builtin(vertex_index) i:u32)->@builtin(position) vec4f{return vec4f(f32(i&1u)*4-1,f32(i>>1u)*4-1,0,1);}
@fragment fn f()->Out{return Out(t${i.map(e=>`,vec4f(${e})`).join(``)});}`});p=e.createRenderPipeline({layout:d,vertex:{module:l,entryPoint:`v`},fragment:{module:l,entryPoint:`f`,targets:r.map((e,t)=>t?{format:e}:{format:e,writeMask:c?15:0})},...a?{depthStencil:{format:a,depthWriteEnabled:!!o,depthCompare:`always`}}:{},multisample:{count:s}}),t.set(u,p)}n.setPipeline(p),n.setBindGroup(0,f),n.draw(3)}function Z(e,t,n){if(e.length!==t)throw Y(`${n}: ${t} values`,`transform`);for(let r=0;r<t;r++){let t=e[r];if(typeof t!=`number`||!(Math.abs(t)<34028235677973366e22))throw X(`${n}: finite values`,`transform`)}}var qn=class{vertices;indices;bounds;constructor(e,t,n){let r=e.length/3;if(!Number.isInteger(r)||r>11184810||(r===0?n.length!==0:r<3||!n.length)||n.length%3)throw X(`Invalid geometry`,`geometry`);Z(e,r*3,`Positions`),Z(t,r*3,`Normals`);for(let e=0;e<n.length;e++)if(!Number.isInteger(n[e])||n[e]<0||n[e]>=r)throw X(`Invalid geometry`,`geometry`);this.vertices=new Float32Array(r*6);let i=[1/0,1/0,1/0],a=[-1/0,-1/0,-1/0];for(let n=0;n<r;n++)for(let r=0;r<3;r++)this.vertices[n*6+r]=e[n*3+r],this.vertices[n*6+3+r]=t[n*3+r],i[r]=Math.min(i[r],e[n*3+r]),a[r]=Math.max(a[r],e[n*3+r]);this.indices=Uint32Array.from(n);let o=this.bounds=new Float32Array(4),s=this.vertices;if(r)for(let e=0;e<3;e++)o[e]=(i[e]+a[e])/2;let c=0;for(let e=0;e<r;e++)c=Math.max(c,Math.hypot(s[e*6]-o[0],s[e*6+1]-o[1],s[e*6+2]-o[2]));o[3]=c,o[3]<c&&new Uint32Array(o.buffer)[3]++,Z(o,4,`Bounds`)}},Jn=class{data=new Float32Array([0,0,0,1,.5,0,1,0]);constructor(e={}){this.set({...e,color:e.color??`#4f46e5`})}set({color:e=this.data.slice(0,3),roughness:t=this.data[4],metalness:n=this.data[5],doubleSided:r=!!this.data[6]}){let i=typeof e==`string`?Rn(e):0,a=typeof e==`string`?i<0?null:[16,8,0].map(e=>zn(i>>e&255)):e;if(!a)throw Y(`Invalid Color`,`material`);if(Z(a,3,`Color`),[...a,t,n].some(e=>!Number.isFinite(e)||e<0||e>1))throw X(`Invalid material`,`material`);if(typeof r!=`boolean`)throw Y(`Invalid material`,`material`);this.data.set([...a,1,Math.max(.045,t),n,+r])}},Yn=new Float64Array(5);function Xn(e){let t=Yn,n=0,r=0,i=0,a=!1;for(let r=0;r<e;r++){let e=t[r]=Math.abs(t[r]);e>n?n=e:e!==e&&(a=!0)}if(n===1/0||a||!n)t[4]=n===1/0||!a?n:NaN;else{for(let a=0;a<e;a++){let e=t[a]/n,o=e*e-i,s=r+o;i=s-r-o,r=s}t[4]=r,t[4]=Math.sqrt(t[4])*n}}function Zn(e,t,n,r=0,i=0){let a=Yn;return a[0]=t,a[1]=n,a[2]=r,a[3]=i,Xn(e),a[4]}var Qn=new Float64Array(1),$n=new Float32Array(16),er=new Float32Array(24),tr=class{fov;near;far;position;target;up=[0,1,0];project;matrix=new Float32Array(16);planes=new Float32Array(24);e;g=new Float64Array(16);f=new Float64Array(16);constructor({fov:e=60,position:t=[0,2,5],target:n=[0,0,0],near:r=.1,far:i=1e3}={}){this.fov=e,this.position=t,this.target=n,this.near=r,this.far=i}update(e,t){if(Z(this.position,3,`Camera position`),Z(this.target,3,`Camera target`),!Number.isFinite(e)||!Number.isFinite(this.fov)||!Number.isFinite(this.near)||!Number.isFinite(this.far)||e<=0||this.fov<=0||this.fov>=180||this.near<=0||this.far<=this.near)throw X(`Invalid projection`,`camera`);let n=this.position[0]-this.target[0],r=this.position[1]-this.target[1],i=this.position[2]-this.target[2],a=Zn(3,n,r,i);if(!a)throw X(`Camera at target`,`camera`);n/=a,r/=a,i/=a;let o=this.up,s=o[1]*i-o[2]*r,c=o[2]*n-o[0]*i,l=o[0]*r-o[1]*n,u=Zn(3,s,c,l);if(!u)throw X(`Vertical camera`,`camera`);s/=u,c/=u,l/=u;let d=r*l-i*c,f=i*s-n*l,p=n*c-r*s,m=this.position,h=this.g;h[0]=s,h[1]=d,h[2]=n,h[4]=c,h[5]=f,h[6]=r,h[8]=l,h[9]=p,h[10]=i,h[12]=-s*m[0]-c*m[1]-l*m[2],h[13]=-d*m[0]-f*m[1]-p*m[2],h[14]=-n*m[0]-r*m[1]-i*m[2],h[15]=1;let g=1/Math.tan(this.fov*Math.PI/360),_=this.near-this.far,v=this.f;v.fill(0),this.project?this.project(v,e,t):(v[0]=g/e,v[5]=g,v[10]=t?-this.near/_:(this.far+this.near)/_,v[11]=-1,v[14]=t?-this.far*this.near/_:2*this.far*this.near/_);let y=$n;for(let e=0;e<4;e++)for(let t=0;t<4;t++)y[e*4+t]=v[t]*h[e*4]+v[4+t]*h[e*4+1]+v[8+t]*h[e*4+2]+v[12+t]*h[e*4+3];Z(y,16,`Camera matrix`);for(let e=0;e<6;e++){let n=e>>1,r=e%2==0?1:-1,i=0;for(let a=0;a<4;a++){let o=e===4&&t?y[a*4+2]:y[a*4+3]+r*y[a*4+n];er[e*4+a]=o,a<3&&(i+=o*o)}Qn[0]=i;let a=Math.sqrt(Qn[0]);if(!a)throw X(`Invalid frustum`,`camera`);for(let t=0;t<4;t++)er[e*4+t]/=a}this.matrix.set(y),this.planes.set(er)}fitToBoundingBox(e,t,{aspect:n=1,duration:r=.3,padding:i=1.1}={}){if(Z(e,3,`Bounds`),Z(t,3,`Bounds`),e.some((e,n)=>e>t[n])||![n,r,i,this.fov,this.near,this.far].every(Number.isFinite)||n<=0||r<0||i<1||this.fov<=0||this.fov>=180||this.near<=0||this.far<=this.near)throw X(`Invalid fit`,`camera`);let a=e.map((e,n)=>(e+t[n])/2),o=Math.hypot(...t.map((t,n)=>(t-e[n])/2)),s=Math.atan(Math.tan(this.fov*Math.PI/360)*Math.min(1,n)),c=Math.max(o/Math.sin(s),o+this.near)*i,l=this.position.map((e,t)=>e-this.target[t]),u=Math.hypot(...l);if(!u||c+o>=this.far)throw X(`Bounds exceed far: raise camera.far`,`camera`);let d=a.map((e,t)=>e+l[t]/u*c);this.e={position:d,target:a,elapsed:0,duration:r,from:this.position,fromTarget:this.target},this.advance(0)}advance(e){if(!this.e)return;let t=this.e,n=t.duration?Math.min(1,(t.elapsed+=e)/t.duration):1,r=n*n*(3-2*n);this.position=t.from.map((e,n)=>e+(t.position[n]-e)*r),this.target=t.fromTarget.map((e,n)=>e+(t.target[n]-e)*r),n===1&&(this.e=void 0)}cancelFit(){this.e=void 0}},nr=`1.0.0`,rr={version:nr,source:import.meta.url};function ir(e=nr,t=import.meta.url){return{version:e,source:t,runtime:rr}}function ar(e,t=ir()){let n=e?.coreRequirement?.runtime;if(n&&(n.version!==t.version||n.version!==t.runtime.version||n!==t.runtime))throw J(`version`,`core ${n.version} ${n.source}; ${t.source} needs ${t.version}, got ${t.runtime.version} ${t.runtime.source}`);return e}function or(){return globalThis[Symbol.for(`margoengine.layers`)]}function sr(e){return or()?.maskOf(e)??1}var cr=(e,t,n)=>!!e&&(e[0]!==0||e[1]!==0||e[2]!==t||e[3]!==n);function lr(e,t,n){if(e!==void 0){if(!Array.isArray(e)||e.length!==4)throw X(`Invalid draw rectangle`,`views`);for(let t=0;t<4;t++)if(!Number.isSafeInteger(e[t])||e[t]<(t<2?0:1))throw X(`Invalid draw rectangle`,`views`);if(e[0]+e[2]>t||e[1]+e[3]>n)throw X(`Draw rectangle exceeds target`,`views`)}}function ur(e,t){if(!Number.isInteger(e)||e<0||e>4294967295)throw RangeError(`${t} ${e} is not a 32-bit layer mask; pass an integer from 0 to 0xffffffff`);return e>>>0}var dr=`zVf/ixxHdq+qrv423T0zWu3aK68svS6tpNVqBfpBHMIY1IW1soSdnBObYPA6J53tHFc7tm/GG18uspgJiLBh9YMR+4N+OHBrLr8lkB8OFsIYzj/eX5CfHRBGPyiw51NAIdts9Kq6Z3p6RnIECkRip9579XnvVVd9XvVrcu2zjykhhJ5yr9Iu7V61ut18uJFr5Crtkqusa35o16r5lFmEE2I7tkXJAfdnrvPxRx9/2vkVI8H6R51PPmr95MNrG9eINdQ6n/6C8DDX/qp17WefEbuWq5989EvizObKZ7/65IOfdD7duLbx808/IW4RYOPnH6wTr/Yvq/6ObQVdep3eYAlLgMkLb0QEyBLzhI9DU7jSbgFVSnhnCBGWpJciwhKwVnkCnqSvEA0nwjJwLu+wlgIqnQ0lvyVK2BlhBCzg0sI4oibZhtI63QCqco0CH4o4ZmuMZH/BCMUfhj+WqGd/lr0tAp6ADfUsYCQAWzaVcIYZ3NYoIpfOmGaPaazI/eREIU/AGSUCJaJhooWWWSb+CUebamPx/THN+uFsFk8gKrI5MlTgSK6y9w2e6SOBmjpDSHbYEnWw5VklOC5Iu9s8AV64kzNkFgIIO2B1wO5I8non1sdDwB2tc5kR0XiNkN7v3osoNL4Wttzf399324JLuo6ydQVsSS4Luw1c9nq9PfdSp5DeyCW+jr+P3CtgtzvQAPe3VzsRgwY09qjgv12LGHDwcd2rEQMCHJikqknkPm0LJtmliAEDqxNbIQ3AktalBg60vRpRIECh0aQRDSRrBOCBJZlCxlnBPxzkM1/43cYNep0lhoEvmDPB5zr1taQb+Ai/RDq/YKj5YunBlyuAF0dsxOnTE9OGvHMF4MgEgG2Il0oRjk4A7PLGw8S0U56OJ6bd8rSYXF559ccmpv2y9+LY9JGBsMHuw9GBsMDqpwADwYH3U4gHwgGnnwr3Isn/XYtILu9eAAvcr4T7G+0mAuDg/kZ7Ci8VPvjpXRAD4fd3xJHsINg4ayMyBA4Oam5fOKmoQS0FRB3NgIKN/jUM3RfRXVGHupmEDBiE4NzFJaVwbCCc/o6IM6RK9k80Cwkh++W/LMnC/X1Cyn/Zn44Wj88sfPBS4YGX3gUMJ7KDWK59wXG5fWGn+GypnjuGq6tBlJsWB8Lq74hFXBYH+y4+eApoOv6sa8r+nmZvl/fVhyDV8e7qgCfGjktfzQswhxUVz7EuMFPCPIE5SV6P5yXFQlqAl4DtUUEUAsW83CdtcQhvd6oJ8XvaUkDwkhYEr+llRvD8jwxE0Acid3MLR1p4/RSI7FFjspEgtX6azQKR93KcC9rtYa46YHxu5j4+oIMwWzL2L9ul4kwWE0OSM1lMcyIEQOT9PFzQBw+IfJSrJvZmHjsEsxgL+VrrA0fWRf0UbGRJ/QfzamaZxEM6QYAH3MC0xwei2U8hhBMDcaCfDish3REnNF1ODcQMZl0eiIM66+mBmNUr/NKsMN0Rp/CJXJjpgwMI8sEgtoeIZVxFgAhPI8IccWeIOD3k1b9OpRa4jzcCHIh0/LrekwBNnjaF8MNbIYZHoNluQQMfrKmf6oAO6KLJ0SZfm54ecHG0t08vi4hQbnt+GDUPzM7NHzr8cvY2TyRpBJrUMP+NJJc78TwcklQF8SGgkm+Iw5rJD0hLKUHwYmPjlbLMuDhZNXliqWoKxcrXYq54+ZHRy28OX35zbSR//vIjw5cfGX/5zbU7EQGGNQSDPpzE0jk26KewhBVzAqXTg1S4OzED63FRGZ7qnT2Ow/IgFc5OfBKwBnEyNpOLOJwapMLeiZckVnwCK6/hLr83vDIIgSNbWGRHtwYiSAG2BngFP76nwPrpgrBGsJH44YKej7ewgMTWQNRSOLY1EJG+eYD/dEFwvAtz3OLWQNTh+NZANFI4sTUQzQncKIsPYQr1/90CArz9G9OTehClMJmo/xWsDPpgw9Lgrn73gAMnczEFF1ghf5UKa0esfB3PgQUrgw9XIwJzkqp4LoASCaDEkQ6UOITgwt7JX6T63qT5vflrqjQfrB8xAkTeeqwSI+6RofhgJN6hCk6f1+ImVXDCiI+IgmNGvE8UgBFvUgXHjfiQKBBGvEcUHDXiNlWwbMQvqYJTRuxRBYtG3CUKYiN+SxQcQREfYRP788O4/gdEwdyPhpnZKMfJkd8Sii/BggKq4JDs0Q4cgvmFVwiRNH45gJeD7yLLu05v0G71Kti9IHhsYxcnb+G+MRm2zEdBiOUaaB6v8QSCQc6Lby/0s9lhmN78mYvv/Hf8XxfwRrHAykJjOJQUY/ZHmm3TKfbvafYHahgIVvYfNPueCqsIPJ8UI/p/T4Wd7VIYTp9LijH7IwV7ErCaFOMTAH+eFON0QO+9pBifAPggKcbpgEQlxfiENbSTYpwOuPrXSTE+IcXfJsU4HZB2k2IsANkuje0AQrx6//8cL3/K8fJJwPjxTgGMH+8koHK8UwDjxzsJqBzvlDWMH+8koHK8U1KMH+8koHK8PD9eHgDDjx2m6zpsKQU2HriXH/h7/Hqxxt0LxU1gT3CgOPuCC//XHHCewgFnEjDOgSmAcQ5MAiocmAIY58AkoMKBKWsY58AkoMKBKSnGOTAJqHDAMRwIhJVFnl8LwqjeKEbhAAcLOzlmcdtxi1G42fdUH9HQZTjlYUIf7Kl+tok3kYfreOhZy3Yp9pn6ZaV7QgVMgQ+17A8Uu85iYralJxxNYtBZ9SfeMJJViTRvHHABw0iBq7++SHCK0i4QnqAWCmoETxKgewEJZK/3DZHkFUKC3MML/pPRWpclQOTfFU3jF1cioqFn8EXaxk5U/htpyXklPF1eMu19Q5RwgUi3JWwlqGx+DlTu71ttSV5Xgl8ggr7BE+BA1xMiu5ciGgDjifaUBBguB2yegCsJ2FojcqmVR3ZiSy+JbQhf8nVBZfhjnoADVLLPJVWiJvdMS8wl21CxBU7MgMfUSoAhP3q/K/9lASPAZFPFDI9iXdCIBMChppflgK+0p6U7puvYdViSK2EBfT0iQSDv4KIpthXbvW8IYMskv0TJRukWSi5Kmyh5KN1ED3wWVHpDdzTHVgBWcIxSvevY+FE8iaZgP47MKQID2mRB8M8LFr8x0+XX9XzssgToakRYYlCu7lyEs8RI+avBWWK8onsVPazozYo+W9HnK/rhig4VfbGiL1X0lYp+tqKfq+jnK/qrFT2p6Bcr+uWK/mZFf6uiv1PR363oa6g//rr6myvIH1dS1Qh0NcUHWAKuZjXbiOvgyju0FfvmqOIQXGltxE04gD4bKp7RBxk7VsIS8OCAOkM0ITyYQVHUzGnXJG1r9vtKBNijYodqQYDtsP62/MuIggORKjMBrCd8OnRwzTXJSiHvj0I+GAtZf6aQvBRydxTy4VjI5jOF9EohH41C7o2FDHXj/ixhm6WwPToMe5NWwt57trDQXtWePl5Qm0XcGn595XGJiXv/KXEjUor8JxjYMwSrS67iOvjyrIp9CGWo4hCaaGxChEMErsYKD68tQ7aoxD3kYi2npiRxU5LY19Tzc755SD6/xMOCeE0l8J6sKdEoSGdBo6AigwAHDhz42oIeGf5fWxA48vfNWOi6KVpbEBbK7y/g6wu8go/1UqYHo0z3n2OmnKZRKdPDUabd55gpZ6/h5yjb3ijbo+eYrTnMdq+c7SYdZsup/lyywTDb/XK2W6Nsm88x2/n2qq4dF/wmCwq65zVQw4qoFfWRV4QLPpaCr0sBL1y7peKDksSevqAPSgKubjtc6bSs4fWLHRN4kjSJ3KdtyS5FVlAtq01m6uj3eV1t0paus5u0pe98F+94V+6RVhzAARXPgitXWnEDXNTm9Gqwa3nBXP8zuCi9gjklXtTtWWk1HhxESVqXeAINmFHCgRAHPy8/7AsdyRX4eWkag4eG+yVDiIYHJUMTDbslwywaHpYM82h4VDIcRsNeyQBoMLQyhkU03CwZltCwWTKsoOFWyXAWDV+WDOfQsF0ynEfDnZLhVTT8emgIYEZBTe9NaVOaaHVKm1I3htGmRMYw2hQPZpXu1AJ4ETx4Qe989zPZo23pfq7tAdIrKFiWcy7nYw1bzBqEMlmPQ2jg0BgjT5C3cEiAz0UTGwWkhKeJIJy8pYvxHaJphdEcwywkuqPJhZkcwy8V160E6hlhRMwDzXzWzL6jEGnDIW2Yzb6j2T0Koba9pG3zCELhcHZPT9ZwMvt3Khay17J/pGBiEYSZKDyPYvy9wj/M/Y1bJ/eDkd/imN9S4bcy1e/syO/cmN/5wu/VqX7JyO/imN/lwu/NqX5vjfzeGfN7t/BbG/cTjnkheuYbChzz1sLzHVq4sbCRxTMWq7DUkSXImaa5w5rmDtPU8ZBIHjQlXRdNJMzjc/6iLTxwL+UfB4Lq20P+oi0KEmA7QDU1wFEYhRrKaC3U2mauRYZwjjYarmEHwBKIlhm5hZ88yywE31zcdJmRbaiZ65suM759G0LUbNS87du3saOhy+wwaHBzGzRudvs2aMj89u3bYL1vQCsGBDlosQAtlUGvGtDZHHSuAJ0vg940oCQHXSxAl8ugNQN6Kwe9U4DeNaBV8+nnFafi48772MWaEua4dXldmwIG94o+EYIes5Jgz4+XxayeD/4H`,fr=new WeakMap;function pr(e,t){let n=fr.get(e);if(!n?.handle)throw J(`disposed`,`Transforms disposed`);n.api.kernel_sync_rotation(n.handle,t)}var mr,hr=0,gr=1,_r=2,vr=3,yr=4,br=5,xr=6,Sr=7,Cr=8,wr=9,Tr=10,Er=11,Dr=27,Or=35,kr=38,Ar=24,jr=0,Mr=1,Nr=2,Pr=3,Fr=6,Ir=class e{f;static async create(t=1024){mr??=(async()=>{let e=Uint8Array.from(atob(dr),e=>e.charCodeAt(0));return WebAssembly.compile(await new Response(new Blob([e]).stream().pipeThrough(new DecompressionStream(`deflate-raw`))).arrayBuffer())})().catch(e=>{throw mr=void 0,e});try{let n=await WebAssembly.instantiate(await mr);return new e(n.exports,t)}catch(e){throw In(e)}}constructor(e,t){this.f=e,fr.set(this,{handle:0,api:e}),this.g(t)}g(e){if(!Number.isSafeInteger(e)||e<1||e>1<<23)throw X(`Capacity: 1..8388608`,`limits`);let t=this.f,n=t.kernel_new(e);if(!n)throw J(`failed`,`Transform allocation`,`limits`);let r=t.kernel_data(n),i=t.kernel_flags(n),a=t.memory.buffer,o=(t,n=e)=>new Float32Array(a,r+t*4,n),s=t=>new Uint8Array(a,i+t*e,e);this.e=n;let c=fr.get(this);c&&(c.handle=n),Object.assign(this,{capacity:e,transforms:{x:o(hr*e),y:o(gr*e),z:o(_r*e),qx:o(vr*e),qy:o(yr*e),qz:o(br*e),qw:o(xr*e),sx:o(Sr*e),sy:o(Cr*e),sz:o(wr*e)},parents:o(Tr*e),matrices:o(Er*e,16*e),bounds:o(Dr*e,4*e),planes:o(Or*e,Ar),rotations:o(Or*e+Ar,3*e),limits:o(kr*e+Ar,12*e),active:s(jr),visible:s(Mr),constrained:s(Nr),hidden:s(Pr),changed:s(Fr)})}grow(e){if(!(e>this.capacity))throw X(`Capacity`,`limits`);let t=()=>Object.values({...this.transforms,...this}).filter(ArrayBuffer.isView),n=t().map(e=>e.slice()),r=this.capacity;this.f.kernel_drop(this.e);try{this.g(e)}catch(e){throw this.g(r),e}finally{t().forEach((e,t)=>e.set(n[t]))}}tick(e=!0){if(!this.e)throw J(`disposed`,`Transforms disposed`);let t=this.f.kernel_tick(this.e,+e);if(t)throw t>this.capacity?X(`Invalid frustum`,`camera`):X(`Invalid transform/bounds: ${t-1}`,`transform`)}dispose(){let e=fr.get(this);e&&(e.handle=0),this.e&&=(this.f.kernel_drop(this.e),0)}},Lr=/Mobi|Android/;function Rr(e){return e?.exact||(globalThis.margoLow||Lr.test(globalThis.navigator?.userAgent)?1:4)}var zr=`
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
}`,Br={},Vr=e=>(e.count||e.redirect)&&!e.claimed;function Hr(e,t,n,r,i,a){if(!r&&!i)return`none`;if(!cr(e,t,n))return`attachment`;if(a)throw Y(`Partial-view clear: draw extra attachments with clear: false`,`views`);return`draw`}var Ur=(e,t,n,r,i,a)=>{r*=24,i=i*24>a?a:i*24,i>r&&e.writeBuffer(t,r*4,n,r,i-r)};function Wr(e,t,n,r){let{rows:i,instances:a}=n,o=n.count*24;if(r||!i||!(n.dirty>=0))Ur(e,t,a,0,o,o),i?.fill(0);else if(n.dirty){let n=i.h??=new Uint16Array(i.buffer,i.byteOffset,i.length*2);for(let r=0,i=0,s=0;r<=n.length;r++){let c=n[r];if(r===n.length)Ur(e,t,a,i,s,o);else if(c)for(n[r]=0;c;){let n=31-Math.clz32(c&-c),l=~(c>>n),u=n+31-Math.clz32(l&-l),d=r*16+n;d!==s&&(Ur(e,t,a,i,s,o),i=d),s=r*16+u,c=c>>u<<u}}}n.dirty=0}var Gr=(e,t,{signal:n,startupWarning:r=8e3,startupTimeout:i},a)=>new Promise((o,s)=>{let c=1,l=()=>{clearTimeout(f),clearTimeout(p),n?.removeEventListener(`abort`,d)},u=e=>{c=0,l(),s(e)},d=()=>u(n.reason),f=setTimeout(console.warn,r,`Margo: still waiting for ${t} after ${r/1e3} s; see https://margoengine.com/errors#timeout`),p=setTimeout(u,i??3e4,J(`timeout`,`WebGPU ${t} never settled`));n?.aborted?d():n?.addEventListener(`abort`,d),e.then(e=>{l(),c?o(e):a?.(e)},u)}),Kr=class e{o;e;x;p;z;f;H;set onLost(e){this.e.lost.then(t=>{this.h||e(this.memory??J(`failed`,`GPU lost: ${t.message}`,`gpu-lost`),!!this.memory)})}get target(){return{format:this.p,depthFormat:this.f.depthStencil.format,samples:this.f.multisample.count}}get gpu(){return this.e}backend=`webgpu`;g=new Float32Array(32);v=[];k;l;r=!1;cleared=!1;depthView;keepDepth=!1;u;resolvePass;I=[];B=[];q;D;y=!1;G=new Map;w=[];t=0;s;memory;i=!1;j=new Map;n=[];E=new WeakMap;m;A;C;h=!1;static async create(t,n=[],r=Rr(),i={},a=!0){let o=navigator.gpu,s=i.powerPreference,c=o&&await Gr(o.requestAdapter(s?{powerPreference:s}:/Win/.test(navigator.userAgent)?{}:{powerPreference:`high-performance`}),`requestAdapter`,i);if(!c)throw J(`unsupported`,`WebGPU adapter unavailable`,`webgpu`);let l=c.limits,u=await Gr(c.requestDevice({requiredLimits:{maxTextureArrayLayers:l?.maxTextureArrayLayers,maxBufferSize:l?.maxBufferSize,maxStorageBufferBindingSize:l?.maxStorageBufferBindingSize},requiredFeatures:[`depth32float-stencil8`,...n].filter(e=>c.features.has(e))}),`requestDevice`,i,e=>e.destroy());try{let n=navigator.gpu.getPreferredCanvasFormat(),o=u.createShaderModule({code:zr}),s={layout:`auto`,vertex:{module:o,entryPoint:`vertex`,buffers:[{arrayStride:24,attributes:[{shaderLocation:0,offset:0,format:`float32x3`},{shaderLocation:1,offset:12,format:`float32x3`}]},{arrayStride:96,stepMode:`instance`,attributes:Array.from({length:6},(e,t)=>({shaderLocation:t+2,offset:t*16,format:`float32x4`}))}]},fragment:{module:o,entryPoint:`fragment`,targets:[{format:n}]},depthStencil:{format:u.features.has(`depth32float-stencil8`)?`depth32float-stencil8`:`depth32float`,depthWriteEnabled:!0,depthCompare:`greater-equal`},multisample:{count:r}},c=`createRenderPipelineAsync`,l=await Gr(u.createRenderPipelineAsync(s),c,i),d=await Gr(u.createRenderPipelineAsync({...s,primitive:{cullMode:`back`},fragment:{...s.fragment,constants:{C:1}}}),c,i),f=t.getContext(`webgpu`);if(!f)throw J(`unsupported`,`No WebGPU canvas`,`webgpu`);let p=new e(t,u,f,n,l,s,d);return a&&p.configure(),p}catch(e){throw u.destroy(),e}}constructor(e,t,n,r,i,a,o){this.o=e,this.e=t,this.x=n,this.p=r,this.z=i,this.f=a,this.H=o,this.m=t.createBuffer({size:128,usage:72}),this.A=t.createBindGroup({layout:i.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.m}}]}),this.C=t.createBindGroup({layout:o.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.m}}]}),t.lost.then(()=>this.i=!0),t.addEventListener(`uncapturederror`,({error:e})=>{this.memory||(e instanceof GPUOutOfMemoryError?(this.memory=J(`failed`,`GPU out of memory: ${e.message}`,`gpu-lost`),this.i=!0,t.destroy()):this.s=J(`failed`,e.message,`gpu-lost`))})}configure(){this.x.configure({device:this.e,format:this.p})}add(e,t){let n=[];try{let r=(e,t)=>{if(e.byteLength>this.e.limits.maxBufferSize)throw X(`GPU buffer limit`,`limits`);let r=this.e.createBuffer({size:e.byteLength,usage:t|8});return n.push(r),this.e.queue.writeBuffer(r,0,e),r},i=r(e.vertices,160),a=r(e.indices,144);if(t*96>this.e.limits.maxBufferSize)throw X(`GPU buffer limit`,`limits`);let o=this.e.createBuffer({size:t*96,usage:168});n.push(o),this.remove(e),this.j.set(e,{vertex:i,index:a,instance:o,frame:-1})}catch(e){for(let e of n)e.destroy();throw e}}remove(e){let t=this.j.get(e);t&&(t.vertex.destroy(),t.index.destroy(),t.instance.destroy(),t.indirect?.destroy(),this.j.delete(e))}geometryBuffers(e){let t=this.j.get(e);if(this.h||this.i||!t)throw J(`state`,`Geometry unavailable`,`device-restore`);return t}render(e,t,n,r,i,a){if(!(this.i||this.h))try{this.J(e,t,n,r,i,a)}catch(e){throw this.s=void 0,e}}J(e,t,n,r,i,a){if(this.s)throw this.s;let o=a?.target,{width:s,height:c}=o?.color??this.o,l=o?.color.format.replace(`-srgb`,``)??this.p,u=this.F(+!!o,s,c,l),d=this.f.multisample.count,f=o?.depth;if(o&&(o.color.sampleCount>1||f&&(f.width!==s||f.height!==c)))throw Y(`Invalid view target: use 1-sample colour`,`views`);if(f&&(f.sampleCount!==d||f.format!==this.f.depthStencil.format))throw Y(`Invalid view depth: use the scene depth format and samples, or omit depth`,`views`);this.g.set(e.matrix),this.g.set(e.position,16),this.g.set(t.direction,20);let p=Math.hypot(this.g[20],this.g[21],this.g[22]);for(let e=20;e<23;e++)this.g[e]/=p;this.g.set(t.radiance,24),this.g.fill(1,28,31),t.ambient&&this.g.set(t.ambient,28),this.e.queue.writeBuffer(this.m,0,this.g),this.q?.settle();let m=!!a&&a.index+1!==a.count;this.y=m;let h=this.e.createCommandEncoder();this.t++;let g=this.I;for(let e=0;e<n.length;e++)g[e]=n[e];g.length=n.length,this.l=o?.color.createView({format:l})??this.x.getCurrentTexture().createView(),this.k=u.length>1?u[0]:void 0;let _=this.k??this.l,v=f?f.createView():u.at(-1);this.r=(r.revision>0||m)&&!!this.k,this.keepDepth=!!f,this.depthView=v;let y=this.q??={backend:`webgpu`,draw:(e=Br)=>{let t=this.q,n=t.view?.viewport,r=e.viewport===void 0?n:e.viewport,i=e.scissor===void 0?e.viewport===void 0?t.view?.scissor??n:void 0:e.scissor;lr(r,t.width,t.height),lr(i,t.width,t.height);let a=e.pipeline??this.z,o=e.bindings??t.bindings;if(!e.pipeline&&(t.shader!==zr||t.format!==this.p||t.descriptor!==this.f)){let e=t.descriptor.multisample?.count+t.format+t.descriptor.depthStencil?.format;a=this.variant(t.shader,e,e=>({...t.descriptor,vertex:{...this.f.vertex,module:e},fragment:{...this.f.fragment,module:e,targets:[{format:t.format}]}}))}let s=this.A;if(a!==this.z||o.length){let e=this.E.get(a),t=!e||e.bindings.length!==o.length;for(let n=0;!t&&n<o.length;n++){let r=o[n],i=e.bindings[n],a=r.resource,s=i.resource;t=r.binding!==i.binding||(a.buffer?a.buffer!==s.buffer||a.offset!==s.offset||a.size!==s.size:a!==s)}if(t||!e){let t=this.e.createBindGroup({layout:a.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.m}},...o]});e={bindings:o.map(({binding:e,resource:t})=>({binding:e,resource:t.buffer?{...t}:t})),group:t},this.E.set(a,e)}s=e.group}let c=t.view?.clear?.color,l=typeof c==`string`,u=e.clear??(c===!1?!1:l||!t.view?.index),d=e.clearDepth??t.view?.clear?.depth??e.clear??!0,f=Un(l?c:void 0,t.color!==this.k&&t.color!==this.l&&t.format),p=Hr(t.view?r??i:void 0,t.width,t.height,!!u,!!d,e.colorAttachments?.length??0),m=this.u??={colorAttachments:[{view:t.color,clearValue:Ln,loadOp:`clear`,storeOp:`store`}],depthStencilAttachment:{view:t.depth,depthClearValue:0,depthLoadOp:`clear`,depthStoreOp:`store`}},h=m.colorAttachments,_=h[0],v=m.depthStencilAttachment;_.view=t.color,_.loadOp=p===`attachment`&&u?`clear`:`load`,p===`attachment`&&u&&(_.clearValue=f),v.view=t.depth,v.depthLoadOp=p===`attachment`&&d?`clear`:`load`,_.resolveTarget=t.color===this.k&&!this.r?this.l:void 0,_.storeOp=_.resolveTarget?`discard`:`store`,v.depthStoreOp=this.keepDepth?`store`:_.storeOp,h.length=1,e.colorAttachments&&h.push(...e.colorAttachments);let y=t.descriptor.depthStencil.format.includes(`stencil`);if(v.stencilClearValue=y?e.stencilClear??0:void 0,v.stencilLoadOp=y?p===`draw`?`load`:u||e.stencilClear!==void 0?`clear`:`load`:void 0,v.stencilStoreOp=y?v.depthStoreOp:void 0,t.only&&t.draw===this.D){if(t.joins&&p===`attachment`&&!g.some(Vr)){this.cleared=!0;return}t.attach(_,v,!0)}let b=t.encoder.beginRenderPass(m);r&&b.setViewport(...r,0,1),i&&b.setScissorRect(...i),p===`draw`&&Kn(this.e,this.G,b,{formats:[t.format],depthFormat:t.descriptor.depthStencil.format,writeDepth:!!d,samples:t.descriptor.multisample?.count,writeColor:!!u,tint:f});let x;for(let n=0;n<g.length;n++){let r=g[n];if(Vr(r)){let n=a===this.z&&!o.length&&!r.mask?this.H:a;n!==x&&(x=n,b.setPipeline(n),b.setBindGroup(0,n===a?s:this.C));let i=this.j.get(r.geometry);i.frame!==this.t&&this.upload(r,i,this.t);let c=r.redirect;b.setVertexBuffer(0,i.vertex),b.setVertexBuffer(1,c?.instances??i.instance),b.setIndexBuffer(i.index,`uint32`),c?b.drawIndexedIndirect(c.args,0):e.indirect??t.indirect?(i.indirect??=this.e.createBuffer({size:20,usage:264}),i.command??=new Uint32Array([r.geometry.indices.length,0,0,0,0]),i.command[1]!==r.count&&(i.command[1]=r.count,this.e.queue.writeBuffer(i.indirect,0,i.command)),b.drawIndexedIndirect(i.indirect,0)):b.drawIndexed(r.geometry.indices.length,r.count)}}b.end()},attach:(e,t,n)=>{if(this.cleared){let n=this.u.colorAttachments[0],r=this.u.depthStencilAttachment;this.cleared=!1,e.loadOp=n.loadOp,e.clearValue=n.clearValue,t.depthLoadOp=r.depthLoadOp,t.depthClearValue=r.depthClearValue,r.stencilLoadOp&&(t.stencilReadOnly=void 0,t.stencilLoadOp=r.stencilLoadOp,t.stencilClearValue=r.stencilClearValue,t.stencilStoreOp=`store`)}n&&this.q.last&&this.r&&!this.y&&e.view===this.k&&t.view===this.depthView&&(e.resolveTarget=this.l,e.storeOp=`discard`,t.depthStoreOp=this.keepDepth?`store`:`discard`,t.stencilStoreOp&&=t.depthStoreOp,this.r=!1)},settle:()=>{this.cleared&&(this.cleared=!1,this.q.encoder.beginRenderPass(this.u).end())}};for(y.batches=g,y.draw=this.D??=y.draw,y.descriptor=this.f,y.device=this.e,y.encoder=h,y.color=_,y.depth=v,y.camera=e,y.view=a&&{id:a.id,camera:e,viewport:a.rect,scissor:a.scissor,index:a.index,count:a.count,clear:a.clear,layers:a.layers,target:a.target},y.width=s,y.height=c,y.delta=i,y.format=l,y.shader=zr,y.bindings=this.w,y.indirect=!1;this.w.length;)this.w.pop();if(r.execute(y),!this.i&&!this.h){if(this.r&&!this.y){let e=this.resolvePass??={colorAttachments:[{view:_,loadOp:`load`,storeOp:`store`}],depthStencilAttachment:{view:v,depthLoadOp:`load`,stencilReadOnly:!0}},t=e.colorAttachments[0];t.view=_,t.resolveTarget=this.l,t.storeOp=m?`store`:`discard`,e.depthStencilAttachment.view=v,e.depthStencilAttachment.depthStoreOp=m||f?`store`:`discard`,h.beginRenderPass(e).end()}this.B[0]=h.finish(),this.e.queue.submit(this.B)}}F(e,t,n,r){let i=this.v[e];if(!i||i.width!==t||i.height!==n||i.format!==r){for(let e of i?.textures??[])e.destroy();i=this.v[e]={width:t,height:n,format:r,textures:[],views:[]};for(let e of[r,this.f.depthStencil.format].slice(this.f.multisample.count===4?0:1)){let r=this.e.createTexture({size:[t,n],sampleCount:this.f.multisample.count,format:e,usage:16});i.textures.push(r),i.views.push(r.createView())}}return i.views}upload(e,t,n){Wr(this.e.queue,t.instance,e,t.frame<0),t.frame=n}variant(e,t,n){for(let n=0;n<this.n.length;n++)if(this.n[n][0]===e&&this.n[n][1]===t)return this.n[n][2];if(this.n.length>=64)throw X(`Shader limit: 64`,`limits`);let r=this.e.createRenderPipeline(n(this.e.createShaderModule({code:e})));return this.n.push([e,t,r]),r}async pick(e,t,n,r,i,a,o){if(this.i||this.h)return null;let s,c,l,u;try{let d=this.e;s=d.createTexture({size:[1,1],format:`r32uint`,usage:17}),c=d.createTexture({size:[1,1],format:`depth32float`,usage:16}),l=d.createBuffer({size:4,usage:9});let f=e.matrix.slice(),p=o?.[0]??this.o.width,m=o?.[1]??this.o.height,h=2*(Math.floor(i)+.5)/p-1,g=1-2*(Math.floor(a)+.5)/m;for(let t=0;t<4;t++)f[t*4]=(e.matrix[t*4]-h*e.matrix[t*4+3])*p,f[t*4+1]=(e.matrix[t*4+1]-g*e.matrix[t*4+3])*m;let _=new Float32Array(32);_.set(f),_.set(e.position,16),_.set(t.direction,20),_.set(t.radiance,24),_.fill(1,28,31),t.ambient&&_.set(t.ambient,28),u=d.createBuffer({size:128,usage:72}),d.queue.writeBuffer(u,0,_);let v=d.createCommandEncoder(),y={backend:`webgpu`,device:d,encoder:v,color:s.createView(),depth:c.createView(),camera:e,width:this.o.width,height:this.o.height,delta:0,format:this.p,shader:zr,bindings:[],indirect:!1,descriptor:this.f,draw:()=>{}};r.prepare(y);let b=y.shader.replace(`@location(3) material:vec4f`,`@location(3) material:vec4f,@location(4) @interpolate(flat) id:u32`).replace(`o.color=i.color.rgb`,`o.id=u32(i.factors.w)+1u;o.color=i.color.rgb`).replace(`->@location(0) vec4f {`,`->@location(0) u32 {`).replace(/let n=normalize\(i.normal\)[\s\S]*$/,`return i.id;
}`),x=this.variant(b,``,e=>({...this.f,multisample:{count:1},vertex:{...this.f.vertex,module:e},fragment:{module:e,entryPoint:`fragment`,targets:[{format:`r32uint`}]},depthStencil:{format:`depth32float`,depthWriteEnabled:!0,depthCompare:`greater-equal`}})),S=d.createBindGroup({layout:x.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:u}},...y.bindings]}),C=v.beginRenderPass({colorAttachments:[{view:s.createView(),clearValue:[0,0,0,0],loadOp:`clear`,storeOp:`store`}],depthStencilAttachment:{view:c.createView(),depthClearValue:0,depthLoadOp:`clear`,depthStoreOp:`store`}});C.setPipeline(x),C.setBindGroup(0,S);for(let e of n)if(e.count){let t=this.j.get(e.geometry);this.upload(e,t,this.t-1),C.setVertexBuffer(0,t.vertex),C.setVertexBuffer(1,t.instance),C.setIndexBuffer(t.index,`uint32`),C.drawIndexed(e.geometry.indices.length,e.count)}if(C.end(),this.i||this.h||(v.copyTextureToBuffer({texture:s},{buffer:l},[1,1]),d.queue.submit([v.finish()]),!await l.mapAsync(1).then(()=>1,e=>{if(this.i||this.h)return 0;throw e})))return null;let w=new Uint32Array(l.getMappedRange())[0];return l.unmap(),w===0?null:w-1}finally{u?.destroy(),s?.destroy(),c?.destroy(),l?.destroy()}}dispose(e=!0){if(!this.h){this.h=!0;for(let e of this.j.keys())this.remove(e);for(let e of this.v)for(let t of e?.textures??[])t.destroy();this.m.destroy(),e&&this.x.unconfigure(),this.e.destroy()}}},qr=class{revision=0;e=[{name:`main`,order:0,joins:!0,execute:e=>{e.only=!0,e.draw(),e.only=!1}}];g;f=!1;idle(){if(this.f)throw J(`state`,`Graph executing`,`reentrancy`)}add(e){if(this.idle(),!e.name||!Number.isFinite(e.order)||typeof e.execute!=`function`||this.e.some(t=>t.name===e.name))throw Y(`Invalid pass`,`arguments`);let t={...e,owner:this.g,execute:t=>e.execute(t),prepare:t=>e.prepare?.(t)};return this.e.push(t),this.e.sort((e,t)=>e.order-t.order),this.revision++,()=>{this.idle(),this.e=this.e.filter(e=>e!==t),this.revision++}}withOwner(e,t){this.idle();let n=this.g;this.g=e;try{t()}finally{this.g=n}}removeOwner(e){this.idle(),this.e=this.e.filter(t=>t.owner!==e),this.revision++}execute(e){if(this.f)throw J(`state`,`Graph recursion`,`reentrancy`);this.f=!0;try{for(let t=0;t<this.e.length;t++)e.last=t+1===this.e.length&&this.e[t].joins,e.joins=this.e[t+1]?.joins,this.e[t].execute(e),e.backend===`webgpu`&&!e.joins&&e.settle?.()}finally{this.f=!1}}prepare(e){if(this.f)throw J(`state`,`Graph recursion`,`reentrancy`);this.f=!0;try{for(let t of this.e)t.prepare?.(e)}finally{this.f=!1}}},Jr=`Engine disposed`,Yr=`WebGPU required`,Xr=[`x`,`y`,`z`],Zr=[`sx`,`sy`,`sz`],Qr=new WeakMap,$r=(e,t)=>{try{t()}catch(t){e.push(t)}},ei=class{e;f;constructor(e,t){this.e=e,this.f=t}h(e){return this.e.check(),this.f===`rotation`?this.e.engine.store.rotations[this.e.id*3+e]:this.e.engine.store.transforms[(this.f===`scale`?Zr:Xr)[e]][this.e.id]}g(e){if(typeof e!=`number`||!(e<34028235677973366e22&&e>-34028235677973366e22))throw X(`Invalid transform`,`transform`)}i(e,t){this.e.check(),this.g(t),this.f===`rotation`?(this.e.engine.store.rotations[this.e.id*3+e]=t,this.e.syncRotation()):this.e.engine.store.transforms[(this.f===`scale`?Zr:Xr)[e]][this.e.id]=t}set(e,t,n){this.e.check(),this.g(e),this.g(t),this.g(n);let r=this.f===`scale`?Zr:Xr,i=this.e.engine.store.transforms,a=this.e.id;for(let o=0;o<3;o++){let s=o===0?e:o===1?t:n;this.f===`rotation`?this.e.engine.store.rotations[a*3+o]=s:i[r[o]][a]=s}return this.f===`rotation`&&this.e.syncRotation(),this}setAll(e){return this.set(e,e,e)}get x(){return this.h(0)}set x(e){this.i(0,e)}get y(){return this.h(1)}set y(e){this.i(1,e)}get z(){return this.h(2)}set z(e){this.i(2,e)}},ti=(e,t,n,r)=>{let i=Zn(4,n[r],n[r+1],n[r+2],n[r+3]);if(!i)throw X(`Quaternion nonzero`,`transform`);let a=n[r]/i,o=n[r+1]/i,s=n[r+2]/i,c=n[r+3]/i,l=e.transforms,u=e.rotations,d=t*3;l.qx[t]=a,l.qy[t]=o,l.qz[t]=s,l.qw[t]=c;let f=2*(a*s+c*o),p=2*(c*s-a*o),m=1-2*(o*o+s*s);u[d+1]=Math.asin(f>1?1:f<-1?-1:f),p*p+m*m<36e-13?(u[d]=0,u[d+2]=2*Math.atan2(s,c)):(u[d]=Math.atan2(2*(c*a-o*s),1-2*(a*a+o*o)),u[d+2]=Math.atan2(p,m))},ni=(e,t)=>+(e[t+22]>.5||e[t]*(e[t+5]*e[t+10]-e[t+6]*e[t+9])-e[t+4]*(e[t+1]*e[t+10]-e[t+2]*e[t+9])+e[t+8]*(e[t+1]*e[t+6]-e[t+2]*e[t+5])<0),ri=(e,t)=>{let n=t/24,r=1<<(n&31),i=e.rows;e.dirty>=0&&!(i[n>>5]&r)&&(i[n>>5]|=r,e.dirty++)},ii=e=>Object.assign(e,{matrix:e.engine.store.matrices.subarray(e.id*16,e.id*16+16)}),ai=class{engine;id;scene;name=``;geometry=null;e=new Jn;get material(){return this.e}set material(e){if(!(e instanceof Jn))throw Y(`Invalid material`,`arguments`);this.e=e,this.engine.collected=-1}f=!0;get receiveShadow(){return this.f}set receiveShadow(e){if(typeof e!=`boolean`)throw Y(`receiveShadow: boolean`,`arguments`);this.f=e,this.engine.collected=-1}constructor(e,t,n=e.scene){this.engine=e,this.id=t,this.scene=n;for(let e of[`position`,`rotation`,`scale`]){let t=new ei(this,e);Object.defineProperty(this,e,{get:()=>t,set:Fn,enumerable:!0})}ii(this)}get visible(){return this.check(),this.engine.store.hidden[this.id]===0}set visible(e){if(this.check(),typeof e!=`boolean`)throw Y(`Visibility: boolean`,`arguments`);this.engine.store.hidden[this.id]=+!e}check(){if(this.engine.disposed||this.engine.meshes.get(this.id)!==this)throw J(`disposed`,`Mesh disposed`)}setPosition(e){return this.check(),Z(e,3,`Position`),this.position.set(e[0],e[1],e[2]),this}setScale(e){return this.check(),Z(e,3,`Scale`),this.scale.set(e[0],e[1],e[2]),this}setRotation(e){return this.check(),Z(e,3,`Rotation`),this.rotation.set(e[0],e[1],e[2]),this}syncRotation(){pr(this.engine.store,this.id)}setQuaternion(e){return this.check(),Z(e,4,`Quaternion`),ti(this.engine.store,this.id,e,0),this}setParent(e){if(this.check(),e?.check(),e&&(e.engine!==this.engine||e.scene!==this.scene))throw Y(`Foreign parent`,`hierarchy`);let t=0;for(let n=e?.id??-1;n!==-1;n=this.engine.store.parents[n]){if(n===this.id)throw Y(`Hierarchy cycle`,`hierarchy`);if(++t>=64)throw X(`Parent depth: 64`,`hierarchy`)}let n=e=>{let t=0;for(let r of e?.kids??[])t=Math.max(t,1+n(this.engine.meshes.get(r)));return t};if(e&&t+n(this)>=64)throw X(`Parent depth: 64`,`hierarchy`);let r=this.engine.store.parents;return this.engine.meshes.get(r[this.id])?.kids?.delete(this.id),e&&(e.kids??=new Set).add(this.id),r[this.id]=e?.id??-1,this}setGeometry(e){if(this.check(),e!==null&&!(e instanceof qn))throw Y(`Invalid geometry`,`arguments`);if(e===this.geometry)return this;e&&this.engine.retain(e);let t=this.geometry;this.geometry=e;let n=this.engine.store.bounds;return n.fill(0,this.id*4,this.id*4+4),e&&n.set(e.bounds,this.id*4),t&&this.engine.release(t),this.engine.collected=-1,this}setMaterial(e){return this.check(),this.material=e,this}dispose(){this.engine.meshes.get(this.id)===this&&this.engine.remove(this)}},oi=class{engine;name;background;frameGraph=new qr;plugins=new Map;meshes=new Map;stats={visible:0,drawCalls:0};lighting={direction:new Float32Array([3,5,4,3]),radiance:new Float32Array([1,1,1,.15]),ambient:new Float32Array([1,1,1])};constructor(e,t){this.engine=e,this.name=t}createMesh(e=null){return this.engine.createMesh(e,this)}use(e){return this.engine.use(e,this),this}removePlugin(e){this.engine.removePlugin(e,this)}dispose(){let e=this.engine,t=[];if(this===e.scene)throw Y(`Default scene: dispose the engine instead`,`scene`);if(e.scenes.delete(this)){for(let n of this.plugins.keys())$r(t,()=>e.removePlugin(n,this));for(let t of this.meshes.values())e.remove(t);if(t.length)throw t[0]}}},si=class e{canvas;store;renderer;fallbackReason;coreRequirement=ir();scene;scenes=new Set;meshes=new Map;camera;disposed=!1;onError=e=>{typeof reportError==`function`?reportError(e):console.error(e)};pace;maxDelta=.1;views;i=new Map;k=[];I=new WeakMap;C=0;Q=[];D=0;r=0;collected=-1;unshadowed=0;L;K=-1;w=[];F;l;t=new Set;p=null;o=0;s=!1;n=!1;T=!0;q={delta:null};j=!1;g;A=new AbortController;y=0;B=0;f;e=-1;v;x;J=new WeakMap;features;exact;fixed;power;get frameGraph(){return this.f.frameGraph}get lighting(){return this.f.lighting}get stats(){return this.f.stats}get plugins(){return this.f.plugins}static async create(t,n={}){if(!t||typeof t.getContext!=`function`)throw Y(`Expected canvas`,`arguments`);let r=n.backend??`auto`;if(![`auto`,`webgpu`,`webgl2`].includes(r))throw Y(`Unknown backend`,`arguments`);let i=n.exactSize,a=n.antialias??!i?void 0:1;if(Array.isArray(i)){if(i.length!==2||!i.every(e=>Number.isInteger(e)&&e>0&&e<=8192))throw X(`Invalid exactSize`,`pixel-exact`);[t.width,t.height]=i}let o=await Ir.create(n.capacity??1024),s,c=null;try{if(n.signal?.throwIfAborted(),r!==`webgl2`)try{s=await Kr.create(t,n.features,a,n)}catch(e){if(r===`webgpu`||n.signal?.aborted)throw e;c=String(e)}s??=(n.fallback??(()=>{throw J(`unsupported`,r===`webgl2`?`webgl2 needs fallback: webglRenderer`:`WebGPU unavailable`,`webgpu`)}))(t);let l=new e(t,o,s,n.camera,c);return l.features=n.features,l.exact=a,l.fixed=i?1:void 0,l.power=n.powerPreference,l}catch(e){throw s?.dispose(),o.dispose(),e}}constructor(e,t,n,r,i){this.canvas=e,this.store=t,this.renderer=n,this.fallbackReason=i,this.camera=new tr(r),this.scenes.add(this.scene=this.f=new oi(this,`default`)),this.F=new Uint8Array(t.capacity),this.l=new Int32Array(t.capacity),this.V()}V(){let e=this.renderer,t=(n,r)=>{if(this.disposed||this.j||this.renderer!==e)return;let i=()=>t(n,r);if(this.g)return void this.g.then(i,i);r&&this.onError(n),this.B=0,++this.y<4?this.rebootDevice().catch(e=>this.disposed||this.onError(e)):this.y===4&&this.onError(J(`failed`,`GPU lost 4 times; reload the page`,`gpu-lost`))};e.onLost=t}rebootDevice(){return this.disposed||this.j?Promise.reject(J(`disposed`,Jr)):this.backend===`webgpu`?(this.g||=(async()=>{let e=this.renderer,t=await Kr.create(this.canvas,this.features,this.exact,{powerPreference:this.power,signal:this.A.signal},!1);try{this.A.signal.throwIfAborted();for(let e of this.i.values())t.add(e.geometry,e.instances.length/24);t.configure()}catch(e){throw t.dispose(!1),e}this.renderer=t,this.V(),e.dispose(!1);let n=[];for(let e of this.scenes){let t=this.h(e);for(let t of e.plugins.values())$r(n,()=>t.onDeviceRestored?.(this));this.h(t)}if(n.length)throw n[0]})().finally(()=>{this.g=void 0}),this.g):Promise.reject(J(`unsupported`,Yr,`webgpu`))}O(){return this.y&&++this.B>=120&&(this.y=this.B=0),!0}get backend(){return this.renderer.backend}get renderTarget(){return this.renderer.target??null}get gpu(){return this.renderer.gpu??null}geometryBuffers(e){if(this.disposed||this.j||this.g)throw J(`state`,`Geometry unavailable`,`device-restore`);return e.indices.length?this.renderer.geometryBuffers?.(e)??null:null}hasPlugin(e){return this.plugins.has(e)}h(e){let t=this.f;if(t!==e){for(let n of this.i.values()){let r=this.J.get(n);r||this.J.set(n,r=new WeakMap),r.set(t,[n.claimed,n.redirect]),[n.claimed,n.redirect]=r.get(e)??[]}this.f=e}return t}m(){if(this.disposed||this.j)throw J(`disposed`,Jr)}u(e){if(!this.scenes.has(e))throw Y(`Unknown scene: use engine.createScene()`,`scene`)}use(e,t=this.f){this.m(),e.coreRequirement&&ar(this,e.coreRequirement),this.u(t);let n=e.name,r=t.plugins;if(!n||r.has(n)||Qr.has(e)||typeof e.setup!=`function`)throw Y(`Invalid plugin`,`arguments`);let i=this.h(t);try{t.frameGraph.withOwner(n,()=>{r.set(n,e);for(let[e,t]of[...r])t.late&&(r.delete(e),r.set(e,t));Qr.set(e,t);try{e.setup(this),e.registerPasses?.(t.frameGraph)}catch(i){t.frameGraph.removeOwner(n),r.delete(n),Qr.delete(e);try{e.dispose?.()}catch{}throw i}})}finally{this.h(i)}return this}removePlugin(e,t=this.f){let n=t.plugins.get(e);if(!n)return;t.frameGraph.removeOwner(e),t.plugins.delete(e),Qr.delete(n);let r=this.h(t);try{n.dispose?.()}finally{this.h(r)}}createScene(e=`scene`){this.m();let t=new oi(this,e);return this.scenes.add(t),t}sceneOf(e){let t=Qr.get(e);return t?.engine===this?t:void 0}createMesh(e=null,t=this.f){if(this.m(),this.u(t),e?.check(),e&&(e.engine!==this||e.scene!==t))throw Y(`Foreign parent`,`hierarchy`);let n=this.Q.pop()??this.D++;if(n>=this.store.capacity)try{let e=Math.min(n*2,1<<23),t=new Uint8Array(e),r=new Int32Array(e);this.store.grow(e),this.F=t,this.l=r,this.meshes.forEach(ii)}catch(e){throw this.D=n,e}let r=this.store.transforms;for(let e of[`x`,`y`,`z`,`qx`,`qy`,`qz`])r[e][n]=0;for(let e of[`qw`,`sx`,`sy`,`sz`])r[e][n]=1;this.store.parents[n]=-1,this.store.constrained[n]=0,this.store.hidden[n]=0,this.store.rotations.fill(0,n*3,n*3+3);let i=new ai(this,n,t);this.meshes.set(n,i),t.meshes.set(n,i),i.born=this.r++,this.store.active[n]=1;try{return i.setParent(e)}catch(e){throw i.dispose(),e}}remove(e){let t=this.store.parents;if(e.check(),!this.j){for(let n of e.kids??[])t[n]=-1;e.setParent(null)}e.geometry&&this.release(e.geometry),this.meshes.delete(e.id),e.scene.meshes.delete(e.id),this.r++,this.store.active[e.id]=0,this.store.visible[e.id]=0,this.Q.push(e.id)}writePoses(e,t,n=e.length){this.m();let{transforms:r,active:i}=this.store;if(!(n>=0&&n<=e.length&&t.length>=n*7))throw X(`Invalid poses`,`transform`);for(let r=0,a=0;r<n;r++,a+=7){if(i[e[r]]!==1)throw J(`disposed`,`Mesh disposed`);for(let e=a;e<a+7;e++){let n=t[e];if(typeof n!=`number`||!(n<34028235677973366e22&&n>-34028235677973366e22))throw X(`Invalid transform: ${r}`,`transform`)}if(!(t[a+3]||t[a+4]||t[a+5]||t[a+6]))throw X(`Quaternion nonzero: ${r}`,`transform`)}for(let i=0,a=0;i<n;i++,a+=7){let n=e[i];r.x[n]=t[a],r.y[n]=t[a+1],r.z[n]=t[a+2],ti(this.store,n,t,a+3)}}retain(e){if(!e.indices.length)return;let t=this.i.get(e)??{geometry:e,instances:new Float32Array,rows:new Uint32Array,count:0,references:0};if(t.references>=t.instances.length/24){let n=(t.references+1)*2,r=new Float32Array(n*24),i=new Uint32Array(n+31>>5);this.renderer.add(e,n),t.instances=r,t.rows=i,this.collected=-1}t.references++||(this.i.set(e,t),this.k.push(t))}release(e){if(!e.indices.length)return;let t=this.i.get(e);--t.references===0&&(this.renderer.remove(e),this.i.delete(e),this.k.splice(this.k.indexOf(t),1))}X=e=>{(this.e===-1||sr(e)&this.e)&&(this.unshadowed+=+!e.receiveShadow,e.geometry?.indices.length&&this.store.visible[e.id]&&this.S(e))};S(e){if(this.I.get(e.material)!==this.C){let t=e.material.data;Z(t,8,`Material`);for(let e=0;e<8;e++)if(t[e]<0||t[e]>1)throw X(`Invalid material`,`material`);if(t[3]!==1||t[4]<Math.fround(.045)||t[6]!==0&&t[6]!==1)throw X(`Invalid material`,`material`);this.I.set(e.material,this.C),this.w.push([e.material,...t])}let t=this.i.get(e.geometry),n=t.count++*24;this.l[e.id]=n,t.instances.set(e.matrix,n),t.instances.set(e.material.data,n+16),e.receiveShadow||(t.instances[n+22]+=.25),t.instances[n+23]=e.id,t.mask+=ni(t.instances,n),ri(t,n)}render({camera:e=this.camera,culling:t=!0,delta:n=0,views:r}={}){if(this.n)throw J(`state`,`Render recursion`,`reentrancy`);if(r)return this.Z(r,t,n);if(!(e instanceof tr))throw Y(`Invalid camera`,`arguments`);this.n=!0,this.v=void 0;let i=!1;try{this.G(t,n,e);let r=this.f.background,{width:i,height:a}=this.canvas;!this.g&&!this.disposed&&this.O()&&this.renderer.render(e,this.lighting,this.k,this.frameGraph,n,r===void 0&&this.e===-1?void 0:{rect:[0,0,i,a],index:0,count:1,id:`0`,clear:r===void 0?void 0:{color:r??!1},layers:this.e===-1?void 0:this.e})}catch(e){throw i=!0,e}finally{try{e!==this.camera&&!this.disposed&&!this.j&&(this.camera.update(this.canvas.width/this.canvas.height,this.backend===`webgpu`),this.store.planes.set(this.camera.planes),this.store.tick(this.T),this.e=this.H(this.camera),this.M())}catch(e){if(!i)throw e}finally{this.n=!1}}}Z(e,t,n){if(!Array.isArray(e)||!e.length)throw Y(`Invalid views`,`views`);this.n=!0;let r=new Set,i=new Set,a=[],o=e=>e?.target?.color??this.canvas,s=new Map,c=new Map;for(let t of e)s.set(o(t),(s.get(o(t))??0)+1);let l=[...s.keys()],u=e.map((e,t)=>t).sort((t,n)=>l.indexOf(o(e[t]))-l.indexOf(o(e[n])));try{this.E();for(let l of u){let u=e[l];if(!(u?.camera instanceof tr)||!u.viewport)throw Y(`Invalid view: pass {camera, viewport}`,`views`);let d={...u,viewport:[...u.viewport],scissor:u.scissor&&[...u.scissor]},f=d.scene??this.scene,p=d.target?.color,m=p?[p.width,p.height]:[this.canvas.width,this.canvas.height],h=this.z(d.viewport,d.pixels,m),g=!i.has(f);if(this.u(f),this.h(f),this.G(t,r.has(d.camera)?0:n,d.camera,h,g,n,d.layers),this.disposed)break;r.add(d.camera),i.add(f),!this.g&&(l||this.O())&&this.renderer.render(d.camera,this.lighting,this.k,this.frameGraph,g?n:0,{rect:h,scissor:d.scissor&&this.z(d.scissor,d.pixels,m),layers:this.e===-1?void 0:this.e,index:c.get(o(d))??0,count:s.get(o(d)),id:d.id??String(l),clear:d.clear??(f.background===void 0?void 0:{color:f.background??!1}),target:d.target}),c.set(o(d),(c.get(o(d))??0)+1),p||a.push(d)}}finally{this.n=!1,this.v=a,this.h(this.scene)}}z(e,t,[n,r],i){let a=t?[...e]:[Math.round(e[0]*n),Math.round(e[1]*r),Math.round((e[0]+e[2])*n)-Math.round(e[0]*n),Math.round((e[1]+e[3])*r)-Math.round(e[1]*r)];return i||lr(a,n,r),a}G(e,t,n=this.camera,r,i=!0,a=t,o){if(this.m(),!Number.isFinite(a)||a<0||a>1)throw X(`Invalid delta`,`arguments`);if(this.N=a,i&&this.plugins.forEach(this.Y),this.disposed)return;r||this.E(),n.advance(t),n.update(r?r[2]/r[3]:this.canvas.width/this.canvas.height,this.backend===`webgpu`),this.e=this.H(n,o),this.store.planes.set(n.planes),this.store.tick(e);let{direction:s,radiance:c,ambient:l}=this.lighting;Z(s,4,`Light`),Z(c,4,`Radiance`),Z(l,3,`Ambient`);let u=!(s[0]||s[1]||s[2])||s[3]<0;for(let e=0;e<4;e++)u||=c[e]<0||e<3&&l[e]<0;if(u)throw X(`Invalid lighting`,`lighting`);if(this.M(),this.n){let{stats:e}=this,t=this.k;e.visible=e.drawCalls=0;for(let n=0;n<t.length;n++)e.visible+=t[n].count,(t[n].count||t[n].redirect)&&!t[n].claimed&&e.drawCalls++}n===this.camera&&(this.T=e)}H(e,t){return(t===void 0?or()?.cameras.get(e)??-1:ur(t,`View layers`))|0}E(){if(this.fixed)return;let e=Math.min(globalThis.devicePixelRatio??1,globalThis.margoLow||2,4/Rr(this)),t=Math.round(this.canvas.clientWidth*e)||this.canvas.width,n=Math.round(this.canvas.clientHeight*e)||this.canvas.height,r=Math.min(1,(this.gpu?.limits.maxTextureDimension2D??4096)/Math.max(t,n)),i=Math.max(1,Math.round(t*r)),a=Math.max(1,Math.round(n*r));this.canvas.width!==i&&(this.canvas.width=i),this.canvas.height!==a&&(this.canvas.height=a)}M(){let{visible:e,changed:t}=this.store,n=this.F,r=this.f,i=this.e,a=this.collected!==this.r||this.L!==r||this.K!==i||i!==-1&&!!or()?.source;for(let e=0;!a&&e<this.w.length;e++)for(let t=0,n=this.w[e];!a&&t<8;t++)a=n[0].data[t]!==n[t+1];if(a){this.collected=-1;for(let e of this.k)e.count=e.mask=0,e.dirty=-1;this.unshadowed=0,this.C++,this.w.length=0,this.l.fill(-1),r.meshes.forEach(this.X),this.collected=this.r,this.L=r,this.K=i,n.set(e),t.fill(0)}else{for(let a=0;a<this.D;a++)if(e[a]!==n[a]){let o=this.meshes.get(a),s=this.l[a];if(o?.geometry?.indices.length&&o.scene===r&&(i===-1||sr(o)&i)&&+(s>=0)!==e[a]){if(s<0)this.S(o),t[a]=0;else{let e=this.i.get(o.geometry),t=--e.count*24,n=e.instances;e.mask-=ni(n,s),s!==t&&(n.copyWithin(s,t,t+24),this.l[n[s+23]]=s,ri(e,s)),this.l[a]=-1}}n[a]=e[a]}for(let e=t.indexOf(1);e>=0;e=t.indexOf(1,e+1)){t[e]=0;let n=this.l[e];if(n>=0){let t=this.meshes.get(e),r=this.i.get(t.geometry);r.mask-=ni(r.instances,n),r.instances.set(t.matrix,n),r.mask+=ni(r.instances,n),ri(r,n)}}}}pick(e,t,n){let r=n&&{...n},i=this.x??(this.n?Promise.resolve():void 0),a,o=this.x=new Promise(e=>a=e),s=i?i.then(()=>this.disposed||this.j?null:this.R(e,t,r)):this.R(e,t,r),c=()=>{this.x===o&&(this.x=void 0),a()};return s.then(c,c),s}async R(e,t,n){if(![e,t].every(Number.isFinite))throw X(`Invalid pick`,`views`);if(this.m(),this.backend!==`webgpu`)throw J(`unsupported`,Yr,`webgpu`);let r=this.canvas.clientWidth||this.canvas.width,i=this.canvas.clientHeight||this.canvas.height;if(e<0||t<0||e>=r||t>=i||this.g)return null;this.E();let a=this.renderer,o=this.r,s=[this.canvas.width,this.canvas.height],c=e*s[0]/r,l=t*s[1]/i,u=e=>!e||c>=e[0]&&l>=e[1]&&c<e[0]+e[2]&&l<e[1]+e[3],d=(e,t)=>({...e,viewport:this.z(e.viewport,e.pixels,s,t),scissor:e.scissor&&this.z(e.scissor,e.pixels,s,t),pixels:!0}),f=n&&d(n);if(!n&&this.v){for(let e of this.v){let t=d(e,!0);u(t.viewport)&&u(t.scissor)&&(f=t)}if(!f)return null}if(f&&!(u(f.viewport)&&u(f.scissor)))return null;let p=f?.scene??this.scene,m=f?.camera??this.camera,h=f?.viewport;if(this.u(p),!(m instanceof tr))throw Y(`Invalid camera`,`arguments`);let g=this.h(p),_;try{this.G(!0,0,m,h,!0,0,f?.layers),f&&(f.layers=this.e===-1?void 0:this.e);let n=[...this.plugins.values()].find(e=>e.onPick);_=n?n.onPick(e,t,f):a.pick(m,this.lighting,this.k,this.frameGraph,c-(h?.[0]??0),l-(h?.[1]??0),h&&[h[2],h[3]]).then(e=>this.meshes.get(e??-1)??null)}finally{this.h(g)}let v=this.e,y=await _;return this.renderer===a&&(!y||this.meshes.get(y.id)===y&&y.born<o&&y.scene===p&&(v===-1||sr(y)&v))?y:null}onFrame(e){return this.t.add(e),()=>{this.t.delete(e)}}start({culling:e}={}){this.m(),this.q.culling=e,!this.s&&(this.s=!0,this.o=0,globalThis.document?.addEventListener(`visibilitychange`,this.U),this.p=requestAnimationFrame(this.P))}U=()=>{this.o=0};N=0;Y=e=>e.onPreUpdate?.(this.N);W=e=>e(this,this.q.delta);P=e=>{if(this.p=null,this.s){if(!this.pace||this.pace(e)){let t=(e-this.o)/1e3,n=this.maxDelta,r=this.o?t!==t||t<n?t:n:0;this.o=e;try{this.q.delta=r,this.t.forEach(this.W),this.q.views=this.views?.length?this.views:void 0,this.disposed||this.render(this.q)}catch(e){this.stop(),this.onError(e);return}}this.s&&(this.p??=requestAnimationFrame(this.P))}};stop(){this.s=!1,this.p!==null&&cancelAnimationFrame(this.p),this.p=null,this.o=0,globalThis.document?.removeEventListener(`visibilitychange`,this.U)}dispose(){if(this.disposed||this.j)return;this.j=!0,this.stop(),this.A.abort(J(`disposed`,Jr));let e=[];for(let t of this.scenes)for(let n of t.plugins.keys())$r(e,()=>this.removePlugin(n,t));for(let t of this.meshes.values())$r(e,()=>t.dispose());if(this.t.clear(),$r(e,()=>this.renderer.dispose()),$r(e,()=>this.store.dispose()),this.disposed=!0,e.length)throw e[0]}};if(Symbol.dispose)for(let e of[si,ai,oi])e.prototype[Symbol.dispose]=e.prototype.dispose;var ci=si,li=async()=>{let{gpu:e}=globalThis.navigator;return!!e&&await e.requestAdapter().catch(()=>null)!=null},ui=async(e,t)=>{try{return await t(e),e}catch(t){throw e.dispose(),t}},di=async(e,t,{loadCompat:n,...r}={})=>{let a=r.backend===`webgl2`||r.backend!==`webgpu`&&!await li()?(await i(async()=>{let{webglRenderer:e}=await import(`./preview-B_-I75Oo.js`);return{webglRenderer:e}},__vite__mapDeps([0,1]),import.meta.url)).webglRenderer:void 0,o;try{let n=await ci.create(e,{...r,fallback:a});return o=n.backend,await ui(n,t)}catch(e){if(!n||o!==`webgl2`||e.code!==`unsupported`)throw e}r.signal?.throwIfAborted(),await(await n()).install();let s=e.cloneNode(!1);return e.replaceWith(s),ui(await ci.create(s,{...r,backend:`webgpu`}),t)},fi=(e,t=nr,n=import.meta.url)=>(ar(e,ir(t,n)),e),pi=(e,t=`1.0.0`,n=import.meta.url)=>fi(e,t,n);function mi(e){return e?.adapterInfo?.vendor===`margo-webgl2`?`webgl2`:`native`}function hi(e,t){return mi(e)===`webgl2`?t():void 0}var gi=Symbol.for(`margoengine.temporal-camera-source`),_i=e=>e[gi]??e,vi={samplesPerFrame:1,maxBounces:8,maxSamples:1024,seed:0,resolutionScale:1,exposure:0,aperture:0,focusDistance:void 0,denoise:!1,lensBlades:0,lensRotation:0,shutter:0,clamp:1/0,toneMapping:`neutral`,gamma:void 0,bounceLimits:void 0,transparentShadows:!0,sunSpecular:!0,sunInMedia:!0,energyCompensation:!0,vignette:0,edges:void 0,grid:void 0,order:20,previousCamera:void 0,projection:`camera`,panoramaFit:`width`,fisheye:{mapping:`equidistant`,fov:180},distortion:void 0},yi=Object.keys(vi),bi=[`maxBounces`,`seed`,`resolutionScale`,`aperture`,`focusDistance`,`lensBlades`,`lensRotation`,`shutter`,`previousCamera`,`projection`,`panoramaFit`,`fisheye`,`distortion`,`clamp`,`bounceLimits`,`transparentShadows`,`sunSpecular`,`sunInMedia`,`energyCompensation`,`edges`,`grid`],xi=(e,t,n,r,i)=>{let a=U(e,t,n,r,i);if(!Number.isInteger(a))throw RangeError(`VoxelPathTracer ${t} ${a} must be a whole number; ${i}`);return a},Si=(e,t)=>{if(typeof e!=`boolean`)throw TypeError(`VoxelPathTracer ${t} must be true or false`);return e},Ci=65535;function wi(e){if(e===null)return;if(typeof e!=`object`)throw TypeError(`VoxelPathTracer bounceLimits must be {diffuse?, specular?, scatter?, subsurface?, internalReflections?} or null`);let t=e,n=e=>t[e]===void 0?Ci:e===`subsurface`?xi(t[e],`bounceLimits.${e}`,1,256,`pass 1 to 256, or leave it out`):xi(t[e],`bounceLimits.${e}`,1,64,`pass 1 to 64, or leave it out`);return{diffuse:n(`diffuse`),specular:n(`specular`),scatter:n(`scatter`),subsurface:n(`subsurface`),internalReflections:t.internalReflections===void 0?Ci:xi(t.internalReflections,`bounceLimits.internalReflections`,0,64,`pass 0 to 64, or leave it out`)}}function Ti(e){if(e===null)return;if(typeof e!=`object`)throw TypeError(`VoxelPathTracer edges must be {color, width} or null`);let t=e;return{color:G(t.color,`VoxelPathTracer edges.color`,!0,`pass linear RGB, 0 or more`),width:U(t.width,`edges.width`,0,.5,`pass 0 to 0.5 voxels`)}}function Ei(e){if(e===null)return;if(typeof e!=`object`)throw TypeError(`VoxelPathTracer grid must be {color, spacing, width, onVoxels?} or null`);let t=e;return{color:G(t.color,`VoxelPathTracer grid.color`,!0,`pass linear RGB, 0 or more`),spacing:U(t.spacing,`grid.spacing`,.001,1e6,`pass a distance above 0`),width:U(t.width,`grid.width`,0,1e6,`pass a half width, 0 or more`),onVoxels:t.onVoxels!==void 0&&Si(t.onVoxels,`grid.onVoxels`)}}function Di(e,t){if(!e||typeof e!=`object`)throw TypeError(`VoxelPathTracer options must be an object`);let n={...t},r=e;if(r.samplesPerFrame!==void 0&&(n.samplesPerFrame=r.samplesPerFrame===`auto`?`auto`:xi(r.samplesPerFrame,`samplesPerFrame`,1,64,`pass 1 to 64 or 'auto'`)),r.maxBounces!==void 0&&(n.maxBounces=xi(r.maxBounces,`maxBounces`,1,64,`pass 1 to 64`)),r.maxSamples!==void 0){let e=U(r.maxSamples,`maxSamples`,1,1/0,`pass 1 or more, or Infinity`);if(e!==1/0&&!Number.isInteger(e))throw RangeError(`VoxelPathTracer maxSamples ${e} must be a whole number or Infinity`);n.maxSamples=e}if(r.seed!==void 0&&(n.seed=xi(r.seed,`seed`,0,4294967295,`pass an integer 0 to 4294967295`)),r.resolutionScale!==void 0&&(n.resolutionScale=U(r.resolutionScale,`resolutionScale`,.1,2,`pass 0.1 to 2`)),r.exposure!==void 0&&(n.exposure=U(r.exposure,`exposure`,-20,20,`pass EV stops, -20 to 20`)),r.aperture!==void 0&&(n.aperture=U(r.aperture,`aperture`,0,1e6,`pass a diameter, 0 or more`)),r.focusDistance===null?n.focusDistance=void 0:r.focusDistance!==void 0&&(n.focusDistance=U(r.focusDistance,`focusDistance`,1e-6,1e9,`pass a distance above 0, or null for automatic focus`)),r.denoise!==void 0&&(n.denoise=r.denoise===`auto`?`auto`:Si(r.denoise,`denoise`)),r.lensBlades!==void 0){let e=xi(r.lensBlades,`lensBlades`,0,16,`pass 0 (round) or 3 to 16`);if(e===1||e===2)throw RangeError(`VoxelPathTracer lensBlades must be 0 (round) or 3 to 16`);n.lensBlades=e}if(r.lensRotation!==void 0&&(n.lensRotation=U(r.lensRotation,`lensRotation`,-1e6,1e6,`pass radians`)),r.shutter!==void 0&&(n.shutter=U(r.shutter,`shutter`,0,1,`pass 0 (off) to 1`)),r.clamp!==void 0){let e=U(r.clamp,`clamp`,0,1/0,`pass a luminance above 0, or Infinity`);if(!(e>0))throw RangeError(`VoxelPathTracer clamp must be above 0 (Infinity turns it off)`);n.clamp=e}if(r.toneMapping!==void 0){if(r.toneMapping!==`neutral`&&r.toneMapping!==`linear`&&r.toneMapping!==`aces-narkowicz`&&r.toneMapping!==`agx`)throw TypeError(`VoxelPathTracer toneMapping ${String(r.toneMapping)} is unknown; pass 'neutral', 'linear', 'aces-narkowicz' or 'agx'`);n.toneMapping=r.toneMapping}if(`gamma`in r&&(n.gamma=r.gamma===void 0?void 0:U(r.gamma,`gamma`,1,5,`pass 1 to 5, or undefined for sRGB`)),r.bounceLimits!==void 0&&(n.bounceLimits=wi(r.bounceLimits)),r.transparentShadows!==void 0&&(n.transparentShadows=Si(r.transparentShadows,`transparentShadows`)),r.sunSpecular!==void 0&&(n.sunSpecular=Si(r.sunSpecular,`sunSpecular`)),r.sunInMedia!==void 0&&(n.sunInMedia=Si(r.sunInMedia,`sunInMedia`)),r.energyCompensation!==void 0&&(n.energyCompensation=Si(r.energyCompensation,`energyCompensation`)),r.vignette!==void 0&&(n.vignette=U(r.vignette,`vignette`,0,100,`pass 0 (off) or more`)),r.edges!==void 0&&(n.edges=Ti(r.edges)),r.grid!==void 0&&(n.grid=Ei(r.grid)),r.order!==void 0&&(n.order=U(r.order,`order`,-1e9,1e9,`pass a finite frame-graph order`)),r.previousCamera!==void 0&&(n.previousCamera=Oi(r.previousCamera)),r.projection!==void 0){if(r.projection!==`camera`&&r.projection!==`panorama`&&r.projection!==`fisheye`)throw TypeError(`VoxelPathTracer projection ${String(r.projection)} is unknown; pass 'camera', 'panorama' or 'fisheye'`);n.projection=r.projection}if(r.panoramaFit!==void 0){if(r.panoramaFit!==`width`&&r.panoramaFit!==`height`)throw TypeError(`VoxelPathTracer panoramaFit ${String(r.panoramaFit)} is unknown; pass 'width' or 'height'`);n.panoramaFit=r.panoramaFit}if(r.fisheye!==void 0){if(!r.fisheye||typeof r.fisheye!=`object`)throw TypeError(`VoxelPathTracer fisheye must be {mapping?, fov?}`);let e=r.fisheye;if(e.mapping!==void 0&&e.mapping!==`equidistant`&&e.mapping!==`equisolid`&&e.mapping!==`stereographic`)throw TypeError(`VoxelPathTracer fisheye.mapping ${String(e.mapping)} is unknown; pass 'equidistant', 'equisolid' or 'stereographic'`);n.fisheye={mapping:e.mapping??`equidistant`,fov:e.fov===void 0?180:U(e.fov,`fisheye.fov`,.001,360,`pass degrees above 0 to 360`)}}if(r.distortion!==void 0){if(r.distortion===null)n.distortion=void 0;else{if(typeof r.distortion!=`object`)throw TypeError(`VoxelPathTracer distortion must be {k1?, k2?, p1?, p2?} or null`);let e=r.distortion,t=t=>e[t]===void 0?0:U(e[t],`distortion.${t}`,-1,1,`pass -1 to 1`);n.distortion={k1:t(`k1`),k2:t(`k2`),p1:t(`p1`),p2:t(`p2`)}}}return n}function Oi(e){if(e===null)return;if(!e||typeof e!=`object`)throw TypeError(`VoxelPathTracer previousCamera must be {position, target, up?, fov?} or null`);let t=e,n=G(t.position,`previousCamera.position`,!1,`pass a world point`),r=G(t.target,`previousCamera.target`,!1,`pass a world point`),i=t.up===void 0?void 0:G(t.up,`previousCamera.up`,!1,`pass a direction`),a=t.fov===void 0?void 0:U(t.fov,`previousCamera.fov`,.001,179.999,`pass degrees`);if(n.every((e,t)=>e===r[t]))throw RangeError(`VoxelPathTracer previousCamera.position equals its target; pass a distinct target`);return{position:n,target:r,up:i,fov:a}}function ki(e){let t=e.bounceLimits,n=e=>e===65535?void 0:e;return{...e,fisheye:{...e.fisheye},bounceLimits:t&&{diffuse:n(t.diffuse),specular:n(t.specular),scatter:n(t.scatter),subsurface:n(t.subsurface),internalReflections:n(t.internalReflections)},edges:e.edges&&{...e.edges},grid:e.grid&&{...e.grid},previousCamera:e.previousCamera&&{...e.previousCamera},distortion:e.distortion&&{...e.distortion}}}Object.freeze(ki(vi));function Ai(e,t){if(t===void 0)return{...vi};if(typeof t!=`object`||!t||!(Symbol.iterator in t))throw TypeError(`VoxelPathTracer resetOptions takes a list of option names, or nothing for all of them; pass an array of names`);let n={...e};for(let e of t){if(typeof e!=`string`||!yi.includes(e))throw TypeError(`VoxelPathTracer resetOptions: ${String(e)} is not an option; pass names such as 'focusDistance' or 'exposure'`);n[e]=vi[e]}return n}var ji;function Mi(){ji=new Int32Array(2048);for(let e=0;e<256;e++){let t=e;for(let e=0;e<8;e++)t=t&1?3988292384^t>>>1:t>>>1;ji[e]=t}for(let e=0;e<256;e++)for(let t=1;t<8;t++){let n=ji[(t-1)*256+e];ji[t*256+e]=n>>>8^ji[n&255]}return ji}function Ni(e,t=0){let n=ji??Mi(),r=e.length,i=r-(r&7),a=~t,o=0;for(;o<i;o+=8)a^=e[o]|e[o+1]<<8|e[o+2]<<16|e[o+3]<<24,a=n[1792+(a&255)]^n[1536+(a>>>8&255)]^n[1280+(a>>>16&255)]^n[1024+(a>>>24)]^n[768+e[o+4]]^n[512+e[o+5]]^n[256+e[o+6]]^n[e[o+7]];for(;o<r;o++)a=n[(a^e[o])&255]^a>>>8;return~a>>>0}var Pi=Object.freeze([137,80,78,71,13,10,26,10]);function Fi(e,t,n,r){if(e===1)return t;if(e===2)return n;if(e===3)return t+n>>1;if(e===4){let e=t+n-r,i=Math.abs(e-t),a=Math.abs(e-n),o=Math.abs(e-r);return i<=a&&i<=o?t:a<=o?n:r}return 0}var Ii=(e,t)=>{let n=new Uint8Array(t.length+12),r=new DataView(n.buffer);r.setUint32(0,t.length);for(let t=0;t<4;t++)n[4+t]=e.charCodeAt(t);return n.set(t,8),r.setUint32(t.length+8,Ni(n.subarray(4,t.length+8))),n};function Li(e,t,n,r){let i=new Uint8Array(13),a=new DataView(i.buffer);return a.setUint32(0,e),a.setUint32(4,t),i[8]=8,i[9]=n,[Uint8Array.from(Pi),Ii(`IHDR`,i),Ii(`IDAT`,r),Ii(`IEND`,new Uint8Array)]}var Ri=class{#e=0;#t;#n;#r;#i;#a;constructor(e,t,n=!1){this.width=e,this.height=t,this.channels=n?4:3;let r=new CompressionStream(`deflate`);this.#t=r.writable.getWriter();let i=r.readable.getReader(),a=[];this.#n=(async()=>{for(;;){let{done:e,value:t}=await i.read();if(e)return a;a.push(t)}})(),this.#n.catch(()=>{});let o=e*this.channels;this.#r=new Uint8Array(o),this.#i=new Uint8Array(o),this.#a=Array.from({length:5},()=>new Uint8Array(o+1))}async write(e,t){let n=this.channels,r=this.width*n;for(let i=0;i<t;i++){let t=e.subarray(i*r,(i+1)*r),a=this.#r,o=this.#a[0],s=1/0;for(let e=0;e<5;e++){let i=this.#a[e];i[0]=e;let c=0;for(let o=0;o<r;o++){let r=o>=n?t[o-n]:0,s=a[o],l=o>=n?a[o-n]:0,u=t[o]-Fi(e,r,s,l)&255;i[o+1]=u,c+=u<128?u:256-u}c<s&&(s=c,o=i)}await this.#t.ready,await this.#t.write(o.slice()),this.#i.set(t),[this.#r,this.#i]=[this.#i,this.#r],this.#e++}}async finish(){if(this.#e!==this.height)throw RangeError(`PNG has ${this.#e} of ${this.height} rows; write every row before finish`);await this.#t.close();let e=await this.#n,t=0;for(let n of e)t+=n.length;let n=new Uint8Array(t),r=0;for(let t of e)n.set(t,r),r+=t.length;return new Blob(Li(this.width,this.height,this.channels===4?6:2,n),{type:`image/png`})}abort(){this.#t.abort().catch(()=>{})}},zi=8192;function Bi(e,t,n,r={}){for(let[n,r]of[[`width`,e],[`height`,t]])if(!Number.isInteger(U(r,`viewport ${n}`,1,1<<20,`pass the drawing buffer size in pixels`)))throw RangeError(`VoxelPathTracer viewport ${n} ${r} must be a whole number of pixels`);if(!n||typeof n!=`object`)throw TypeError(`VoxelPathTracer viewport limits must be the device limits {maxStorageBufferBindingSize, ...}`);let i=U(n.maxStorageBufferBindingSize,`maxStorageBufferBindingSize`,16,2**53-1,`pass the device limits (device.limits)`),a=n.maxTextureDimension2D===void 0?zi:U(n.maxTextureDimension2D,`maxTextureDimension2D`,1,1<<20,`pass the device limits`),o=r.resolutionScale===void 0?1:U(r.resolutionScale,`resolutionScale`,.1,2,`pass 0.1 to 2`),s=Math.max(1,Math.round(e*o)),c=Math.max(1,Math.round(t*o)),l=Math.floor(i/16),u=s,d=c,f;if(u*d>l){let e=Math.sqrt(l/(u*d));u=Math.max(1,Math.floor(u*e)),d=Math.max(1,Math.floor(d*e)),f=`storage-binding`}if((r.denoise??!1)!==!1&&Math.max(u,d)>a){let e=a/Math.max(u,d);u=Math.max(1,Math.min(a,Math.floor(u*e))),d=Math.max(1,Math.min(a,Math.floor(d*e))),f=`texture-dimension`}return{width:u,height:d,requestedWidth:s,requestedHeight:c,...f?{limitedBy:f}:{}}}var Vi=1e-12,Hi=e=>1/(Math.abs(e)<Vi?e<0?-1e-12:Vi:e),Ui=(e,t)=>t<0?Math.ceil(e)-1:Math.floor(e);function Wi(e,t,n,r,i,a,o,s){let c=i+Math.min((a-i)*.5,1e-4),l=[0,0,0],u=[1/0,1/0,1/0];for(let e=0;e<3;e++)l[e]=+(t[e]+n[e]*c-r[e]>=.5),(n[e]>0&&!l[e]||n[e]<0&&l[e])&&(u[e]=(r[e]+.5-t[e])*Hi(n[e]));let d=i,f=o;for(let t=0;t<4;t++){if((e>>(l[0]|l[1]<<1|l[2]<<2)&1)==1===s)return[d,f];if(d=Math.min(u[0],u[1],u[2]),!(d<a))return;f=u[0]===d?0:u[1]===d?1:2,l[f]^=1,u[f]=1/0}}function Gi(e,t,n,r,i,a,o,s,c,l,u){let[d,f,p]=e.size,[m,h,g]=e.bricks,_=Hi(i),v=Hi(a),y=Hi(o),b=-t*_,x=(d-t)*_,S=-n*v,C=(f-n)*v,w=-r*y,T=(p-r)*y,E=Math.min(b,x),D=Math.min(S,C),O=Math.min(w,T),k=Math.max(b,x),A=Math.max(S,C),j=Math.max(w,T),M=Math.max(E,D,O,s),N=Math.min(k,A,j,c);if(!(M<N))return!1;let P=3;M>s&&(P=M===E?0:M===D?1:2);let F=i>=0?1:-1,I=a>=0?1:-1,ee=o>=0?1:-1,te=+(i>=0),ne=+(a>=0),re=+(o>=0),ie=Math.abs(_),ae=Math.abs(v),oe=Math.abs(y),se=(e,t,n)=>e<t?t:e>n?n:e,ce=se(Ui((t+i*M)/8,i),0,m-1),le=se(Ui((n+a*M)/8,a),0,h-1),ue=se(Ui((r+o*M)/8,o),0,g-1),de=((ce+te)*8-t)*_,fe=((le+ne)*8-n)*v,pe=((ue+re)*8-r)*y,L=M,me=(e,t,n,r,s,c)=>{let l=n,d;if(l===3){let e=[Math.abs(i),Math.abs(a),Math.abs(o)];l=e[0]>=e[1]&&e[0]>=e[2]?0:e[1]>=e[2]?1:2}return d=-[F,I,ee][l],u.t=e,u.value=t,u.axis=l,u.sign=d,u.cell=[r,s,c],!0};for(;;){let s=e.grid[ce+m*(ue+g*le)],c=Math.min(de,fe,pe,N),u=ce*8,b=le*8,x=ue*8,S=Math.min(u+8,d)-1,C=Math.min(b+8,f)-1,w=Math.min(x+8,p)-1;if(s===0||s>=2147483648){let e=s===0?0:s&255;if(e!==l)return me(L,e,P,se(Ui(t+i*L,i),u,S),se(Ui(n+a*L,a),b,C),se(Ui(r+o*L,o),x,w))}else{let d=((s&~nt)-1)*128,f=(s&nt)!==0,p=se(Ui(t+i*L,i),u,S),m=se(Ui(n+a*L,a),b,C),h=se(Ui(r+o*L,o),x,w),g=(p+te-t)*_,T=(m+ne-n)*v,E=(h+re-r)*y,D=L,O=P;for(;;){let s=p-u+8*(h-x+8*(m-b)),_=e.payload[d+(s>>2)]>>>(s&3)*8&255,v=f&&_?e.payload[d+128+(s>>2)]>>>(s&3)*8&255:0;if(v){let e=[t,n,r],s=[i,a,o],c=[p,m,h],u=Math.min(g,T,E);if(_===l){let t=Wi(v,e,s,c,D,u,O,!1);if(t)return me(t[0],0,t[1],p,m,h)}else{let t=Wi(v,e,s,c,D,u,O,!0);if(l!==0&&(!t||t[0]>D))return me(D,0,O,p,m,h);if(t)return me(t[0],_,t[1],p,m,h)}}else if(_!==l)return me(D,_,O,p,m,h);if(g<T&&g<E?(O=0,D=g,p+=F,g+=ie):T<E?(O=1,D=T,m+=I,T+=ae):(O=2,D=E,h+=ee,E+=oe),D>=c||p<u||m<b||h<x||p>S||m>C||h>w)break}}if(c>=N||(de<fe&&de<pe?(P=0,L=de,ce+=F,de+=ie*8):fe<pe?(P=1,L=fe,le+=I,fe+=ae*8):(P=2,L=pe,ue+=ee,pe+=oe*8),ce<0||le<0||ue<0||ce>=m||le>=h||ue>=g))break}return l!==0&&me(N,0,k<=A&&k<=j?0:A<=j?1:2,Math.floor(t+i*N),Math.floor(n+a*N),Math.floor(r+o*N))}function Ki(e,t,n,r){let i=Math.hypot(n[0],n[1],n[2]),a=[n[0]/i,n[1]/i,n[2]/i],o={t:0,value:0,axis:0,sign:0,cell:[0,0,0]},s,c=r;for(let[n,r]of e.instances.entries()){let i=r.box,l=0,u=c;for(let e=0;e<3&&l<=u;e++){let n=Hi(a[e]),r=(i[e]-t[e])*n,o=(i[e+3]-t[e])*n;l=Math.max(l,Math.min(r,o)),u=Math.min(u,Math.max(r,o))}if(l>u)continue;let d=r.toLocal,f=[0,1,2].map(e=>d[e*4]*t[0]+d[e*4+1]*t[1]+d[e*4+2]*t[2]+d[e*4+3]),p=[0,1,2].map(e=>d[e*4]*a[0]+d[e*4+1]*a[1]+d[e*4+2]*a[2]);Gi(e.models[r.model],f[0],f[1],f[2],p[0],p[1],p[2],0,c,0,o)&&o.t<c&&(c=o.t,s={instance:n,hit:{...o,cell:[...o.cell]},distance:o.t})}return s}function qi(e){return e?.view?.viewport}function Ji(e,t){let n=qi(t);if(!n)return;e.setViewport(n[0],n[1],n[2],n[3],0,1);let r=t.view.scissor??n;e.setScissorRect(r[0],r[1],r[2],r[3])}var Yi=e=>typeof e==`string`&&e.endsWith(`float`),Xi=(128<<20)/4,Zi=1024,Qi=64,$i=64,ea=5,ta=6,na=1.5,ra=4,ia=5,aa=12,oa=19,sa=176,ca=512,la=368,ua=4,da=class{constructor(e,t){this.runs=t>e?[e,t-e]:[]}alloc(e){let t=this.runs;for(let n=0;n<t.length;n+=2)if(t[n+1]>=e){let r=t[n];return t[n]+=e,t[n+1]-=e,t[n+1]||t.splice(n,2),r}return-1}release(e,t){let n=this.runs,r=0;for(;r<n.length&&n[r]<e;)r+=2;r<n.length&&e+t===n[r]?(n[r]=e,n[r+1]+=t):n.splice(r,0,e,t),r&&n[r-2]+n[r-1]===e&&(n[r-1]+=n[r+1],n.splice(r,2))}},fa=e=>e.caustics?+!!e.focusing|(e.direct?2:0):0,pa=0,ma=new WeakMap,ha=(e,t)=>{let n=ma.get(e);if(!n){let t=n={lost:!1,states:new Set};ma.set(e,t),e.lost?.then(()=>{t.lost=!0;for(let e of t.states)e.lost=!0;t.states.clear()})}n.lost?t.lost=!0:n.states.add(t)},ga=(e,t)=>ma.get(e)?.states.delete(t),_a=(e,t)=>{if(t.shutter>0&&e.motionError)throw e.motionError;return e},va=e=>{let t=new Uint32Array(Float32Array.from(e).buffer),n=2166136261;for(let e of t)n=Math.imul(n^e,16777619);return n>>>0},ya=e=>{if(e?.aborted)throw e.reason??new DOMException(`The render was aborted`,`AbortError`)},ba=class{coreRequirement=ir(`1.0.0`,import.meta.url);#e;#t;#n;#r;#i;#a;#o;#s;#c;#l;#u;#d;#f;#p;#m;#h;#g;#_;#v;#y;#b;#x;#S;#C;#w;#T;#E;#D;#O;#k;#A;#j;constructor(e){if(this.name=`voxel-pathtracer:${pa++}`,this.#r=!1,this.#i=!0,this.#o={models:new Map,emitters:new WeakMap},this.#c=1,this.#u=`compiling`,this.#f=1,this.#p=0,this.#m=64,this.#h=0,this.#g=0,this.#y=new Map,this.#b=0,this.#x=this.#I(),this.#S=0,this.#C=-1,this.#w=0,this.#T=0,this.#E=Promise.resolve(),this.#D=0,this.#O=new ArrayBuffer(800),this.#k=new Float32Array(sa/4),this.#A=new Float64Array(16),this.#j=new Float32Array(32),!e||typeof e!=`object`)throw TypeError(`VoxelPathTracer.attach expects (engine, {scene, ...options})`);let{scene:t,...n}=e;this.#a=Di(n,vi),this.#s=_a(Kt(t,this.#o,Xi),this.#a),this.#B()}static attach(e,t){ar(e,ir(`1.0.0`,import.meta.url));let n=new this(t);try{pi(e).use(n)}catch(e){throw n.dispose(),e}return n}tracingSource(){return kn}sceneWordReserve(){return 0}sceneStorage(e){return e}geometryMoving(){return!1}imageInstance(e){return e===-2?-2:e===-3?-3:-1}get enabled(){return this.#i}set enabled(e){if(Si(e,`enabled`),e&&!this.#i&&this.#N(),!e)for(let e of this.#y.values())e.shown=!1;this.#i=e}get stats(){let e=this.#x;return{samples:e.previewing?0:e.samples,frameMs:e.frameMs,gpuBytes:this.#w,converged:e.shown&&!e.previewing&&e.samples>=this.#a.maxSamples,width:e.width,height:e.height,requestedWidth:e.requested[0],requestedHeight:e.requested[1],...e.limitedBy?{limitedBy:e.limitedBy}:{},sceneRevision:this.#s.revision,packedModels:this.#s.packedModels,reusedModels:this.#s.reusedModels,renders:this.#D}}get ready(){return this.#_}get status(){return this.#u}get error(){return this.#d}get options(){return ki(this.#a)}setScene(e){this.#z();let t=this.#l?Math.floor(this.#l.device.limits.maxStorageBufferBindingSize/4):Xi;this.#s=_a(Kt(e,this.#o,t,this.sceneWordReserve()),this.#a),this.#c++;for(let e of this.#y.values())this.#P(e,!1)}setOptions(e){if(this.#z(),e&&typeof e==`object`&&`scene`in e)throw TypeError(`VoxelPathTracer setOptions does not take a scene; call setScene`);this.#M(Di(e,this.#a))}resetOptions(e){this.#z(),this.#M(Ai(this.#a,e))}#M(e){_a(this.#s,e);let t=this.#a;this.#a=e,bi.some(n=>!Object.is(t[n],e[n]))&&this.#N(),e.order!==t.order&&this.#t&&this.#V(this.#t)}invalidateModels(e){if(this.#z(),e!==void 0&&(typeof e!=`object`||!e||!(Symbol.iterator in e)))throw TypeError(`VoxelPathTracer invalidateModels takes a list of model ids, or nothing for all of them; pass an array of ids`);let t=e===void 0?void 0:[...e];if(t?.some(e=>typeof e!=`string`))throw TypeError(`VoxelPathTracer invalidateModels takes model ids (strings); pass ids from your models`);let n=this.#o;if(!t)n.models.clear(),n.keys?.clear();else for(let e of t){let t=n.models.get(e);if(t){if(n.models.delete(e),n.keys)for(let[e,r]of n.keys)r===t&&n.keys.delete(e);for(let[e,r]of n.models)r===t&&n.models.delete(e)}}}async whenIdle(){await this.#E;let e=this.#l;if(e&&!e.lost&&!this.#r)try{await e.device.queue.onSubmittedWorkDone()}catch{}}reset(){this.#z(),this.#N()}#N(){for(let e of this.#y.values())this.#P(e,!0)}#P(e,t,n=!1){n?e.held=e.samples||e.held:(e.held=0,e.cut++),e.samples=0,e.epoch++,t&&(e.history.valid=!1)}#F(e,t){return t.cut===e.cut&&(t.s0===0||t.epoch===e.epoch)}#I(){return{serial:this.#b++,samples:0,epoch:0,cut:0,held:0,matrix:new Float64Array(16),key:new Float64Array(30),history:{matrix:new Float32Array(16),corners:new Float32Array(32),version:-1,width:0,height:0,valid:!1},restarted:!1,previewing:!1,shown:!1,frameMs:0,lastTrace:0,width:0,height:0,requested:[0,0],limitedBy:void 0,corners:new Float32Array(32),drawn:this.#S,released:!1,routeKeys:new Set}}#L(e){let t=e.view?.id??``,n=this.#y.get(t);return n||this.#y.set(t,n=this.#I()),n.drawn=this.#S,this.#x=n,n}#R(e){let t=e.image;e.image=void 0,e.routeJob=void 0,e.samples=0,e.held=0,e.epoch++,e.cut++;for(let t of e.routeKeys)this.#l?.routeReady?.release(t);e.routeKeys.clear(),t&&(this.#J(t),this.#U(t.frame),this.#U(t.uniform),this.#U(t.bands?.frames))}onPreUpdate(e){if(e>0){this.#S++;for(let[e,t]of this.#y)this.#S-t.drawn>ua&&(this.#y.delete(e),t.released=!0,this.#R(t))}}raycast(e,t,n=1/0){this.#z();let r=G(e,`raycast origin`,!1,`pass a world point`),i=G(t,`raycast direction`,!1,`pass a direction`);if(!(Math.hypot(i[0],i[1],i[2])>0))throw RangeError(`VoxelPathTracer raycast direction is zero; pass a non-zero direction`);U(n,`raycast maxDistance`,0,1/0,`pass a distance, 0 or more`);let a=this.#s,o=Ki(a,r,i,n);if(!o)return null;let s=a.instances[o.instance],{hit:c,distance:l}=o,u=[0,0,0],d=Math.hypot(i[0],i[1],i[2]);return u[c.axis]=c.sign,{instanceId:s.id,modelId:a.modelIds[s.model],cell:c.cell,normal:u,adjacent:[c.cell[0]+u[0],c.cell[1]+u[1],c.cell[2]+u[2]],paletteIndex:c.value,distance:l,point:[r[0]+i[0]/d*l,r[1]+i[1]/d*l,r[2]+i[2]/d*l]}}capture(e){return this.#fe(async()=>{let t=this.#pe(e,1<<26),n={...this.#a},r=new Ri(t.width,t.height,t.transparent),i=r.channels;try{return await this.#me(t,!1,async(e,a,o)=>{let s=new Uint8Array(t.width*a*i);de(n,t.width,t.height,e,a,o.color,o.alpha,i,s),await r.write(s,a)}),await r.finish()}catch(e){throw r.abort(),e}})}renderImage(e){return this.#fe(async()=>{let t=this.#pe(e,1<<24),n=t.width*t.height,r=new Float32Array(n*3),i=e.aovs===!0,a=i?new Float32Array(n*3):void 0,o=i?new Float32Array(n*3):void 0,s=i?new Float32Array(n):void 0,c=i?new Int32Array(n):void 0,l=i?new Uint8Array(n):void 0,u=t.transparent?new Float32Array(n):void 0,d=this.#s.instances.map(e=>e.source);return await this.#me(t,i,async(e,n,f)=>{let p=e*t.width;if(r.set(f.color,p*3),u&&u.set(f.alpha,p),i){a.set(f.albedo,p*3),o.set(f.normal,p*3),s.set(f.depth,p);for(let e=0;e<t.width*n;e++){let t=f.ids[e];t>=256?(c[p+e]=d[Math.floor(t/256)-1]??-1,l[p+e]=t%256):c[p+e]=this.imageInstance(t)}}}),{width:t.width,height:t.height,samples:t.samples,color:r,albedo:a,normal:o,depth:s,instance:c,palette:l,...u?{alpha:u}:{}}})}setup(e){this.#z();let t=e.gpu;if(!t)throw new Mn(`unsupported`,`VoxelPathTracer needs WebGPU or the WebGL2 compatibility layer; see https://margoengine.com/errors#voxel-pathtracer`);this.#e=e,this.#K(t)}registerPasses(e){this.#t=e,this.#V(e)}onDeviceRestored(e){this.#r||(this.#q(),e.gpu&&this.#K(e.gpu))}dispose(){if(!this.#r){this.#r=!0;try{this.#n?.()}catch{}this.#e?.sceneOf(this)?.removePlugin(this.name),this.#q(),this.#e=this.#t=this.#n=void 0,this.#u===`compiling`&&this.#v?.[1](new Mn(`disposed`,`VoxelPathTracer is disposed`)),this.#u=`disposed`}}[Symbol.dispose](){this.dispose()}#z(){if(this.#r)throw new Mn(`disposed`,`VoxelPathTracer is disposed; attach a new one`)}#B(){this.#_=new Promise((e,t)=>{this.#v=[e,t]}),this.#_.catch(()=>{})}#V(e){this.#n?.(),this.#n=e.add({name:this.name,order:this.#a.order,execute:e=>{if(e.backend!==`webgpu`||!this.#i||this.#r)return;let t=e.camera;e.camera=_i(t);try{this.#de(e)}finally{e.camera=t}}})}#H(e,t,n){let r=e.device.createBuffer({size:Math.max(16,Math.ceil(t/4)*4),usage:n});return this.#w+=r.size,r}#U(e){e&&(this.#w-=e.size,e.destroy())}#W(e,t,n){let r=e.device.createTexture({size:[t,n],format:`rgba32uint`,usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.STORAGE_BINDING});return this.#w+=t*n*16,r}#G(e){e&&(this.#w-=e.width*e.height*16,e.destroy())}#K(e){if(this.#l?.device===e)return this.#l;Yt(this.#s,Math.floor(e.limits.maxStorageBufferBindingSize/4),this.sceneWordReserve()),this.#l&&this.#q();let t=GPUShaderStage.COMPUTE,n=GPUShaderStage.FRAGMENT,r=(e,n,r=t)=>({binding:e,visibility:r,buffer:{type:n}}),a=e.createBindGroupLayout({entries:[r(0,`uniform`),r(1,`uniform`),r(2,`read-only-storage`),r(3,`read-only-storage`),r(4,`read-only-storage`),r(5,`read-only-storage`),r(6,`storage`),r(7,`storage`),r(8,`storage`),r(9,`uniform`),r(10,`storage`)]}),o=e.createBindGroupLayout({entries:[r(0,`storage`)]}),s=e.createBindGroupLayout({entries:[r(0,`uniform`),r(1,`read-only-storage`),r(2,`read-only-storage`),r(3,`read-only-storage`),r(4,`read-only-storage`),r(5,`storage`),r(6,`storage`),r(7,`read-only-storage`),r(8,`storage`),{binding:9,visibility:t,texture:{sampleType:`uint`}},{binding:10,visibility:t,storageTexture:{access:`write-only`,format:`rgba32uint`}}]}),c=e.createBindGroupLayout({entries:[r(0,`uniform`,GPUShaderStage.VERTEX|n),r(1,`read-only-storage`,n),r(2,`read-only-storage`,n)]}),l=GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC,u={device:e,lost:!1,pacer:new pn,traceLayout:a,denoiseLayout:s,displayLayout:c,display:new Map,buffers:void 0,tables:void 0,tableScratch:void 0,dummy:void 0,dummyRead:void 0,dummyHistory:void 0,capacity:0,runs:new da(4,4),regions:new Map,version:0,resources:0};this.#l=u,mi(e)===`webgl2`&&(u.inputs=new WeakMap),u.route=hi(e,()=>i(()=>import(`./compat-CN1yz3KS-gymMBdoO.js`),[],import.meta.url))?.then(({TraceRoute:t})=>u.routeReady=new t(e,this.tracingSource())),u.buffers={table0:this.#H(u,32768,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC),materials:this.#H(u,16,l),voxels:this.#H(u,16,l),scene:this.#H(u,16,l),env:this.#H(u,16,l)},u.tables=this.#H(u,Dn*16,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST),u.tableScratch=this.#H(u,Dn*16,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC),u.dummy=this.#H(u,16,GPUBufferUsage.STORAGE),u.dummyRead=this.#H(u,16,GPUBufferUsage.STORAGE),u.dummyHistory=[this.#W(u,1,1),this.#W(u,1,1)],u.capacity=4,ha(e,u);for(let e of this.#y.values())this.#P(e,!1);this.#u!==`compiling`&&this.#B(),this.#u=`compiling`;let d=u.traceModule=e.createShaderModule({code:this.tracingSource()}),f=e.createShaderModule({code:An}),p=e.createShaderModule({code:On}),m=t=>e.createPipelineLayout({bindGroupLayouts:[t]}),h=(t,n,r)=>e.createComputePipelineAsync({label:`voxel-pathtracer ${n}`,layout:m(r),compute:{module:t,entryPoint:n}});return u.route||h(d,`preview`,a).then(e=>{this.#l===u&&!this.#r&&!u.pipelines&&(u.preview=e)},()=>{}),Promise.all([this.#oe(u,!1),h(d,`ids`,a),h(f,`prepare`,s),h(f,`atrous`,s),h(p,`tables`,o),h(f,`combine`,s)]).then(([t,n,r,i,a,s])=>{if(this.#l!==u||this.#r)return;let c=e.createCommandEncoder(),l=c.beginComputePass();l.setPipeline(a),l.setBindGroup(0,e.createBindGroup({layout:o,entries:[{binding:0,resource:{buffer:u.tableScratch}}]})),l.dispatchWorkgroups(Math.ceil(Dn*4/64)),l.end(),c.copyBufferToBuffer(u.tableScratch,0,u.tables,0,Dn*16),e.queue.submit([c.finish()]),u.pipelines={trace:t,ids:n,prepare:r,atrous:i,combine:s},this.#u=`ready`,this.#v?.[0]()},e=>{this.#l!==u||this.#r||(this.#u=`failed`,this.#d=e,this.#v?.[1](e),this.#e?.onError(e))}),u}#q(){let e=this.#l;if(e){this.#l=void 0,ga(e.device,e),e.routeReady?.destroy();for(let t of Object.values(e.buffers))this.#U(t);this.#U(e.tables),this.#U(e.tableScratch),this.#U(e.dummy),this.#U(e.dummyRead);for(let t of e.dummyHistory)this.#G(t);for(let e of this.#y.values())e.routeKeys.clear(),this.#R(e)}}#J(e){if(e){for(let t of[e.accum,e.albedo,e.normals,e.ping,e.pong,e.guide,e.params,e.caustics,e.cping,e.cpong])this.#U(t);this.#U(e.dpong);for(let t of[...e.history??[],...e.dhistory??[]])this.#G(t);e.ping=e.pong=e.guide=e.params=e.caustics=e.cping=e.cpong=e.history=void 0,e.dpong=e.dhistory=e.directGroups=void 0,e.denoiseGroups=void 0}}#Y(e){if(e.version===this.#c)return;let t=this.#s,n=e.device,r=Math.floor(n.limits.maxStorageBufferBindingSize/4),i=GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC,a=new Set(t.models);for(let[t,n]of e.regions)a.has(t)||(e.runs.release(n,t.grid.length+t.payload.length),e.regions.delete(t));let o=t=>{let r=t.grid.length+t.payload.length,i=e.runs.alloc(r);return i<0?!1:(e.regions.set(t,i),n.queue.writeBuffer(e.buffers.voxels,i*4,on(t,i)),!0)},s=!0;for(let n of t.models)if(!e.regions.has(n)&&!(s=o(n)))break;if(!s){let n=Math.min(r,Math.max(t.voxelWords*2,65536));this.#U(e.buffers.voxels),e.buffers.voxels=this.#H(e,n*4,i),e.capacity=n,e.runs=new da(4,n),e.regions.clear();for(let n of t.models)e.regions.has(n)||o(n);e.resources++}let c=sn(t),l=cn(t,t.models.map(t=>e.regions.get(t)),c),u=(t,a)=>{if(e.buffers[t].size<a.byteLength){this.#U(e.buffers[t]);let n=Math.max(a.byteLength,Math.min(e.buffers[t].size*2,r*4));e.buffers[t]=this.#H(e,n,i),e.resources++}a.byteLength&&n.queue.writeBuffer(e.buffers[t],0,a)};l.words=this.sceneStorage(l.words),u(`scene`,l.words);let d=t.environment.map;d&&d!==e.envSource&&(u(`env`,d.texels),e.envSource=d),t.materials.length>8192&&u(`materials`,t.materials),n.queue.writeBuffer(e.buffers.table0,0,t.materials,0,8192),e.layout={scene:l,lights:c},e.version=this.#c}#X(e,t,n,r,i,a,o=!1){let s=GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC,c=n*r*16,l=t;if((!l||l.width!==n||l.height!==r)&&(this.#J(l),l={...l??{},width:n,height:r,accum:this.#H(e,c,s),albedo:this.#H(e,c,s),normals:this.#H(e,c,s)},e.resources++),l.ping&&(!i||l.focusing!==a)){for(let e of[l.ping,l.pong,l.guide,l.params,l.caustics,l.cping,l.cpong,l.dpong])this.#U(e);for(let e of[...l.history??[],...l.dhistory??[]])this.#G(e);l.ping=l.pong=l.guide=l.params=l.caustics=l.cping=l.cpong=l.history=void 0,l.dpong=l.dhistory=l.directGroups=void 0,l.denoiseGroups=void 0,e.resources++}if(i&&!l.ping){l.ping=this.#H(e,c,s),l.pong=this.#H(e,c,s),l.guide=this.#H(e,c,s),o&&(l.history=[this.#W(e,n,r),this.#W(e,n,r)]);let t=c*(a?2:1)<=e.device.limits.maxStorageBufferBindingSize;l.focusing=a,l.direct=t,l.lanes=a&&t?2:1,l.dflip=0,(a||t)&&(l.caustics=this.#H(e,c*l.lanes,s)),a&&(l.cping=this.#H(e,c,s),l.cpong=this.#H(e,c,s)),t&&(a||(l.dpong=this.#H(e,c,s)),o&&(l.dhistory=[this.#W(e,n,r),this.#W(e,n,r)])),l.params=this.#H(e,ca*oa,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);let i=[],u=l,d=t=>t??e.dummyRead,[f,p]=u.history??e.dummyHistory,[m,h]=e.dummyHistory,g=u.dpong??u.cpong,[_,v]=u.dhistory??e.dummyHistory,y=(n,r)=>{let i=n-ea,a=n-aa,o=n===18,[s,c]=n===0?[u.pong,u.ping]:n<=ea?n%2?[u.ping,u.pong]:[u.pong,u.ping]:i<=ta?i%2?[u.cping,u.cpong]:[u.cpong,u.cping]:a===0?[u.pong,u.ping]:o?[t?g:d(u.cping),u.pong]:a%2?[u.ping,g]:[g,u.ping],l=a===0?r?v:_:u.history?n===0?f:o?p:m:m,y=a===0?r?_:v:u.history?n===0?p:o?f:h:h;return e.device.createBindGroup({layout:e.denoiseLayout,entries:[{binding:0,resource:{buffer:u.params,offset:n*ca,size:la}},{binding:1,resource:{buffer:u.accum}},{binding:2,resource:{buffer:u.albedo}},{binding:3,resource:{buffer:u.normals}},{binding:4,resource:{buffer:s}},{binding:5,resource:{buffer:c}},{binding:6,resource:{buffer:u.guide}},{binding:7,resource:{buffer:d(u.caustics)}},{binding:8,resource:{buffer:n===0?u.cping??e.dummy:o?u.ping:a===ia&&u.cping?u.cping:e.dummy}},{binding:9,resource:l.createView()},{binding:10,resource:y.createView()}]})};for(let e=0;e<oa;e++){let n=e-ea,r=e-aa;!a&&n>0&&n<=ta||!t&&r>=0&&e<18?i.push(void 0):i.push(y(e,0))}u.dhistory&&(u.directGroups=[i[aa],y(aa,1)]),l.denoiseGroups=i,e.resources++}return l}#Z(e,t,n,r=e.buffers,i){let a=e=>i?{buffer:e,offset:i.at,size:i.size}:{buffer:e},o=n.lanes??1,s=e=>i?{buffer:e,offset:i.at*o,size:i.size*o}:{buffer:e},c=e.device.createBindGroup({layout:e.traceLayout,entries:[{binding:0,resource:i?{buffer:t,offset:i.frame,size:800}:{buffer:t}},{binding:1,resource:{buffer:r.table0}},{binding:2,resource:{buffer:r.voxels}},{binding:3,resource:{buffer:r.scene}},{binding:4,resource:{buffer:r.materials}},{binding:5,resource:{buffer:r.env}},{binding:6,resource:a(n.accum)},{binding:7,resource:a(n.albedo)},{binding:8,resource:a(n.normals)},{binding:9,resource:{buffer:e.tables}},{binding:10,resource:n.caustics?s(n.caustics):{buffer:e.dummy}}]});return e.inputs?.set(c,{frame:i?{buffer:t,offset:i.frame,size:800}:{buffer:t},table0:r.table0,voxels:r.voxels,scene:r.scene,materials:r.materials,env:r.env,tables:e.tables,images:[a(n.accum),a(n.albedo),a(n.normals),n.caustics?s(n.caustics):{buffer:e.dummy}]}),c}#Q(e,t,n,r,i){let a=this.#A;if(!fe(e.matrix,a))return!1;let o=(e,t,n)=>{let r=a[3]*e+a[7]*t+a[11]*n+a[15];return[0,1,2].map(i=>(a[i]*e+a[4+i]*t+a[8+i]*n+a[12+i])/r)};for(let[e,[i,a]]of[[-1,1],[1,1],[-1,-1],[1,-1]].entries()){let s=o(i,a,1),c=o(i,a,.5);t.set([s[0],s[1],s[2],0],n+e*4),t.set([c[0]-s[0],c[1]-s[1],c[2]-s[2],0],r+e*4)}let s=e.position,c=e.target,l=[c[0]-s[0],c[1]-s[1],c[2]-s[2]],u=Math.hypot(l[0],l[1],l[2])||1;for(let e=0;e<3;e++)l[e]/=u;let d=e.up,f=[l[1]*d[2]-l[2]*d[1],l[2]*d[0]-l[0]*d[2],l[0]*d[1]-l[1]*d[0]],p=Math.hypot(f[0],f[1],f[2])||1;for(let e=0;e<3;e++)f[e]/=p;let m=[f[1]*l[2]-f[2]*l[1],f[2]*l[0]-f[0]*l[2],f[0]*l[1]-f[1]*l[0]];return t.set([s[0],s[1],s[2],u],i),t.set([l[0],l[1],l[2],0],i+4),t.set([f[0],f[1],f[2],0],i+8),t.set([m[0],m[1],m[2],0],i+12),!0}#$(e,t,n,r,i,a,o,s,c,l,u=0,d=!1,f=0){let p=this.#a,m=new Float32Array(this.#O),h=new Uint32Array(this.#O);if(!this.#Q(n,m,0,76,16))return!1;this.#j.set(m.subarray(0,16),0),this.#j.set(m.subarray(76,92),16),m[19]=p.focusDistance??m[19],m[23]=p.aperture/2,m[27]=p.lensBlades,m[31]=p.lensRotation;let g=!1,_=p.previousCamera;if(_&&p.shutter>0){let e=new tr({fov:_.fov??n.fov,position:_.position,target:_.target,near:n.near,far:n.far});e.up=_.up??n.up,e.project=n.project;try{e.update(r[0]/r[1],!0),g=this.#Q(e,m,92,108,124),m[127]=p.focusDistance??m[127]}catch{g=!1}}h.set(r,32),h.set(i,36);let v=l.environment,y=v.sun[0]+v.sun[1]+v.sun[2]>0,b=v.map,x=(o?16:0)|(s&1?64:0)|(s&2?tn:0);y&&(x|=1),v.ground&&(x|=2),b&&(x|=4),(l.moving||g||this.geometryMoving())&&p.shutter>0&&(x|=8);let S=p.fisheye.fov*Math.PI/180,C=p.projection===`camera`?p.distortion:void 0;h.set([p.projection===`camera`?0:p.projection===`panorama`?1:2,p.fisheye.mapping===`equisolid`?1:p.fisheye.mapping===`stereographic`?2:0,C&&(C.k1||C.k2||C.p1||C.p2)?1:0,+(p.panoramaFit===`height`)],140),m.set([S,p.fisheye.mapping===`stereographic`?Math.tan(S/4):Math.sin(S/4),0,0],144),m.set(C?[C.k1,C.k2,C.p1,C.p2]:[0,0,0,0],148),g&&(x|=256),p.clamp<1/0&&(x|=32),l.lightPower>0&&(x|=128),l.clearGlass&&p.transparentShadows&&(x|=512),p.transparentShadows||(x|=1024),p.sunSpecular||(x|=2048),p.sunInMedia||(x|=4096),v.sunVisible||(x|=8192),p.energyCompensation||(x|=16384),h.set([p.maxBounces,a>>>0,x,l.lightCount],40);let w=p.bounceLimits;h.set(w?[w.diffuse,w.specular+w.internalReflections*65536,w.scatter+w.subsurface*65536]:[Ci,Ci*65537,Ci*65537],152),m[155]=v.groundFade;let T=v.fog;m.set(T?[T.density,T.anisotropy,1,0]:[0,0,0,0],156),m.set(T?[T.color[0],T.color[1],T.color[2],0]:[0,0,0,0],160),m.set(T?T.hemisphere:new Float32Array(16),164),m.set([v.groundFadeStart,+!!v.fadeModels,0,0],180);let E=d?[0,0,0]:v.background,D=p.edges,O=p.grid;m.set(E?[E[0],E[1],E[2],1]:[0,0,0,0],184),m.set(D?[D.color[0],D.color[1],D.color[2],D.width]:[0,0,0,0],188),m.set(O?[O.color[0],O.color[1],O.color[2],O.spacing]:[0,0,0,1],192),m.set(O?[O.width,O.onVoxels?2:1,0,0]:[0,0,0,0],196);let k=c.scene,A=c.lights;h.set([k.modelBase,k.instanceBase,k.nodeBase,l.instances.length?k.nodeCount:0],44),h.set([l.emissiveInstances.length,A.emissiveBase,A.areaBase,0],48),m[51]=u,h.set([b?.width??0,b?.height??0,A.marginalBase,A.conditionalBase],52),m.set([v.sky[0],v.sky[1],v.sky[2],b?.intensity??0],56);let j=v.sunAngularSize/2,M=j>0?2*Math.PI*(1-Math.cos(j)):0,N=j>0?1/(Math.PI*Math.sin(j)**2):1;return m.set([v.sunDirection[0],v.sunDirection[1],v.sunDirection[2],j>0?Math.cos(j):1],60),m.set([v.sun[0]*N,v.sun[1]*N,v.sun[2]*N,M],64),m.set([v.ground?.[0]??0,v.ground?.[1]??0,v.ground?.[2]??0,v.groundHeight],68),m.set([b?.integral??0,b?.rotation??0,p.shutter,p.clamp<1/0?p.clamp:0],72),e.queue.writeBuffer(t,f,this.#O),!0}#ee(e,t,n,r,i=0,a){let o=new ArrayBuffer(ca*oa),s=new Uint32Array(o),c=new Float32Array(o);for(let e=0;e<oa;e++){let o=e*ca/4,l=e-ea,u=e-aa,d=e===0||u===0||e===18,f=l>0&&l<=ta,p=f?l:u>0?u:e,m=e===ea||l===ta||u===ia,h=this.#a.projection!==`camera`||this.#a.distortion!==void 0,g=h?0:i;s.set([t.width,t.height,d?0:1<<p-1,+!!m|(t.cping&&d?2:0)|(h?4:0)|(f?32:0)|(d?g:0)|(t.direct&&d?128:0)|(u===0?256:0)|(u===ia&&t.cping?512:0)],o),c.set([f?ra:na,128,1,1/n],o+4),s.set(r,o+8),c.set(a?.corners??this.#j,o+12),a&&(c.set(a.history.matrix,o+44),c.set(a.history.corners,o+60))}return e.queue.writeBuffer(t.params,0,o),i!==0&&this.#a.projection===`camera`&&this.#a.distortion===void 0}#te(e,t,n,r=!1){let i=e.pipelines,a=t.beginComputePass(),o=Math.ceil(n.width/8),s=Math.ceil(n.height/8);for(let e=0;e<oa;e++){let t=e===aa&&n.directGroups?n.directGroups[n.dflip??0]:n.denoiseGroups[e];t&&(a.setPipeline(e===0||e===aa?i.prepare:e===18?i.combine:i.atrous),a.setBindGroup(0,t),a.dispatchWorkgroups(o,s))}a.end(),r&&n.directGroups&&(n.dflip=1-(n.dflip??0))}#ne(e,t){let n=t.descriptor.multisample?.count??1,r=t.descriptor.depthStencil?.format??`depth32float`,i=`${t.format}|${n}|${r}`,a=e.display.get(i);if(!a){let o=e.device,s=o.createShaderModule({code:jn}),c={};e.display.set(i,a=c),o.createRenderPipelineAsync({layout:o.createPipelineLayout({bindGroupLayouts:[e.displayLayout]}),vertex:{module:s,entryPoint:`vs`},fragment:{module:s,entryPoint:`fs`,targets:[{format:t.format}]},primitive:{topology:`triangle-list`},depthStencil:{format:r,depthWriteEnabled:!0,depthCompare:`always`},multisample:{count:n}}).then(e=>{c.pipeline=e},e=>this.#e?.onError(e))}return a.pipeline}#re(e){this.#p=this.#p>0?Math.min(this.#p*1.01,e):e;let t=Math.min(50,Math.max(4,this.#p));e>t*1.6?(this.#m=Math.max(1,Math.min(Math.floor(this.#f*.8),Math.floor(this.#f*.8*t/e))),this.#f=this.#m,this.#h=120,this.#g=0):(this.#h>0&&--this.#h===0&&(this.#m=64),this.#g=e<=t*1.2?this.#g+1:0,this.#g>=4&&(this.#f=Math.min(this.#m,Math.ceil(this.#f*1.25)),this.#g=0))}#ie(e,t,n,r){let i=e.key,a=t.camera,o=[this.#c,n,r,...a.matrix,...a.position,...a.target,...a.up],s=0;for(let e=0;e<o.length;e++)Object.is(i[e],o[e])||(i[e]=o[e],e<3?s=2:s||=1);return s}#ae(e,t,n){return e.device.createComputePipelineAsync({label:`voxel-pathtracer ${t}`,layout:e.device.createPipelineLayout({bindGroupLayouts:[e.traceLayout]}),compute:{module:e.traceModule,entryPoint:t,...n?{constants:{TABLES:1}}:{}}})}#oe(e,t){return e.route?e.route.then(e=>e.kernel(t)):this.#ae(e,`trace`,t)}#se(e){return e.tableKernelsPending??=Promise.all([this.#oe(e,!0),this.#ae(e,`ids`,!0)]).then(([t,n])=>(this.#l===e&&(e.tableKernels={trace:t,ids:n}),{trace:t,ids:n}),t=>{throw this.#l===e&&!this.#r&&(this.#u=`failed`,this.#d=t,this.#e?.onError(t)),t}),e.tableKernelsPending}#ce(){return this.#s.materials.length>8192}#le(e,t,n,r,i,a,o,s,c,l,u){let d=e.device,f=Math.max(8,hn(a,d.limits.minStorageBufferOffsetAlignment??256)),p=this.#a.maxBounces,m=mn(a,o,s,c,f,fn(p),fn(p,e.pacer.budget)),h=(t,n,i)=>this.#$(d,t,r.camera,[a,o,0,i.y0],[a,i.rows,i.s0,i.count],l,!0,u,e.layout,this.#s,0,!1,n),g=[n.traceGroup];if(m.length===1){if(!h(n.frame,0,m[0]))return!1}else{let t=d.limits.minUniformBufferOffsetAlignment??256,r=Math.ceil(800/t)*t,i=`${n.traceKey}|${a}x${o}|${m.map(e=>`${e.y0}+${e.rows}`).join(`,`)}`;if(n.bands?.key!==i){this.#U(n.bands?.frames);let t=this.#H(e,r*m.length,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);n.bands={key:i,frames:t,groups:m.map((i,o)=>this.#Z(e,t,n,e.buffers,{frame:o*r,at:i.y0*a*16,size:i.rows*a*16}))}}for(let[e,t]of m.entries())if(!h(n.bands.frames,e*r,t))return!1;g=n.bands.groups}if(`sums`in i)return this.#ue(e,t,i,g,m,a,s,c,r.camera.matrix),!0;t.corners.set(this.#j),t.matrix.set(r.camera.matrix);let _=performance.now(),v=un(this.#a.maxBounces),y=0;for(let[e,t]of m.entries()){let n=d.createCommandEncoder({label:`voxel-pathtracer viewport band`}),r=n.beginComputePass();r.setPipeline(i),r.setBindGroup(0,g[e]),r.dispatchWorkgroups(Math.ceil(a/8),Math.ceil(t.rows/8)),r.end(),d.queue.submit([n.finish()]),y+=a*t.rows*t.count*v}return e.pacing||(e.pacing=!0,d.queue.onSubmittedWorkDone().then(()=>{e.pacing=!1,e.pacer.observe(y,performance.now()-_)},()=>{})),!0}#ue(e,t,n,r,i,a,o,s,c){let l=e.routeReady,u=e.inputs,d={epoch:t.epoch,cut:t.cut,s0:o,count:s,matrix:Float64Array.from(c),corners:this.#j.slice(0),width:a,adds:i.map((e,n)=>({inputs:u.get(r[n]),rows:e.rows,key:`${t.serial}:${n}`})),landed:!1},f=()=>this.#r||e.lost||this.#l!==e||t.released||!this.#F(t,d),p=()=>{if(f())throw new DOMException(`The viewport image restarted`,`AbortError`)},m=this.#O.slice(0);t.routeJob=d;for(let e of d.adds)t.routeKeys.add(e.key);(async()=>{for(let[e,t]of i.entries())await l.run(n,d.adds[e].inputs,a,t.rows,t.count,this.#a.maxBounces,p,d.adds[e].key,!1,m)})().then(()=>{d.landed=!0},e=>{t.routeJob===d&&(t.routeJob=void 0),f()||this.#e?.onError(e)})}#de(e){let t=this.#L(e);t.shown=!1;let n=this.#K(e.device);if(!n.pipelines&&!n.preview||n.lost)return;if(this.#ce()&&!n.tableKernels){n.pipelines&&this.#se(n).catch(()=>{});return}this.#Y(n);let r=qi(e)??[0,0,e.width,e.height],i=this.#a,a=Bi(Math.max(1,Math.round(r[2])),Math.max(1,Math.round(r[3])),n.device.limits,i),{width:o,height:s}=a;t.requested=[a.requestedWidth,a.requestedHeight],t.limitedBy=a.limitedBy;let c=this.#ne(n,e);if(!c)return;let l=n.device,u=t.image;if(u)Object.assign(u,this.#X(n,u,o,s,i.denoise!==!1,this.#s.focusing,!0));else{let e=this.#H(n,800,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST),r=this.#H(n,sa,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);u=t.image={...this.#X(n,void 0,o,s,i.denoise!==!1,this.#s.focusing,!0),frame:e,uniform:r,denoisedAt:-1}}let d=this.#ie(t,e,o,s);if(d||n.pipelines&&t.previewing){let e=d===1&&n.routeReady!==void 0&&n.pipelines!==void 0&&!t.previewing;this.#P(t,!1,e),e||(t.restarted=!0)}!t.samples&&!t.held&&(u.denoisedAt=-1),t.previewing=!n.pipelines,t.width=o,t.height=s;let f=`${n.resources}`;if(u.traceKey!==f){u.traceGroup=this.#Z(n,u.frame,u);let e=e=>l.createBindGroup({layout:n.displayLayout,entries:[{binding:0,resource:{buffer:u.uniform}},{binding:1,resource:{buffer:e}},{binding:2,resource:{buffer:u.albedo}}]});u.displayRaw=e(u.accum),u.displayDenoised=u.ping?e(u.ping):void 0,u.displayResolved=u.ping?e(u.ping):void 0,u.traceKey=f,u.denoisedAt=-1}let p=t.routeJob?.landed?t.routeJob:void 0;if(p&&(t.routeJob=void 0,this.#F(t,p))){let e=l.createCommandEncoder({label:`voxel-pathtracer route add`});for(let t of p.adds)n.routeReady.add(e,t.inputs,p.width,t.rows,t.key);l.queue.submit([e.finish()]);let r=p.s0+p.count;p.epoch===t.epoch?(t.samples=r,t.held=0):t.held=r,t.matrix.set(p.matrix),t.corners.set(p.corners),p.s0||(t.restarted=!0,u.denoisedAt=-1)}if(t.previewing){if(!this.#le(n,t,u,e,n.preview,o,s,0,1,i.seed,0))return;t.samples=1}else if(!t.routeJob){if(!this.#T&&t.samples<i.maxSamples){let r=(this.#ce()?n.tableKernels:n.pipelines).trace,a=Math.min(i.samplesPerFrame===`auto`?this.#f:i.samplesPerFrame,i.maxSamples-t.samples);if(!this.#le(n,t,u,e,r,o,s,t.samples,a,i.denoise===!1?i.seed:(i.seed^va(e.camera.matrix))>>>0,fa(u)))return;`sums`in r||(t.samples+=a);let c=performance.now();t.lastTrace&&(t.frameMs=c-t.lastTrace,i.samplesPerFrame===`auto`&&(this.#S===0||this.#C!==this.#S)&&(this.#C=this.#S,this.#re(t.frameMs))),t.lastTrace=c}else t.lastTrace=0}let m=t.samples||t.held;if(!m)return;let h=!t.previewing&&i.denoise!==!1&&u.denoiseGroups!==void 0,g=i.denoise===!0||u.denoisedAt<=0||m<32||m>=u.denoisedAt*1.25||m>=i.maxSamples;if(h&&u.denoisedAt!==m&&g){let r=t.history,i=r.valid&&r.version===this.#c&&r.width===o&&r.height===s,a=t.restarted;u.resolved=this.#ee(l,u,m,[0,0,o,s],8|(i?16:0)|(t.restarted?64:0),t),r.matrix.set(t.matrix),r.corners.set(t.corners),r.version=this.#c,r.width=o,r.height=s,r.valid=!0,t.restarted=!1,this.#te(n,e.encoder,u,a||!i),u.denoisedAt=m}let _=this.#k,v=this.#A;if(!fe(t.matrix,v))return;_.set(t.matrix,0),_.set(v,16),_.set([o,s,r[2],r[3]],32);let y=+!!Yi(e.format)|(i.toneMapping===`linear`?2:0)|(i.toneMapping===`aces-narkowicz`?4:0)|(i.toneMapping===`agx`?8:0),b=i.projection===`camera`&&!i.distortion?1/m:0;_.set([h?1:1/m,2**i.exposure,y,b],36),_.set([i.gamma??0,i.vignette,r[0],r[1]],40),l.queue.writeBuffer(u.uniform,0,_);let x=e.encoder.beginRenderPass({colorAttachments:[{view:e.color,loadOp:`load`,storeOp:`store`}],depthStencilAttachment:{view:e.depth,depthLoadOp:`load`,depthStoreOp:`store`,stencilReadOnly:!0}});Ji(x,e),x.setPipeline(c),x.setBindGroup(0,h?u.resolved?u.displayResolved:u.displayDenoised:u.displayRaw),x.draw(3),x.end(),t.shown=!0}#fe(e){this.#D++;let t=this.#E.then(()=>e(),()=>e());return this.#E=t.then(()=>{this.#D--},()=>{this.#D--}),t}#pe(e,t){if(this.#z(),!e||typeof e!=`object`)throw TypeError(`VoxelPathTracer render options must be {width, height, samples}`);let n=xi(e.width,`width`,1,16384,`pass the image width in pixels`),r=xi(e.height,`height`,1,16384,`pass the image height in pixels`),i=xi(e.samples,`samples`,1,1<<20,`pass samples per pixel, 1 or more`);if(n*r>t)throw RangeError(`VoxelPathTracer ${n}x${r} is over ${t} pixels; render a smaller image`);let a=e,o=a.denoise===void 0?this.#a.denoise!==!1:Si(a.denoise,`denoise`),s=a.jitter===void 0||Si(a.jitter,`jitter`),c=a.seed===void 0?this.#a.seed:xi(a.seed,`seed`,0,4294967295,`pass an integer seed`),l=a.transparent!==void 0&&Si(a.transparent,`transparent`),u=a.wavelength===void 0?0:U(a.wavelength,`wavelength`,380,780,`pass nanometres, 380 to 780`);if(a.signal!==void 0&&!(a.signal instanceof AbortSignal))throw TypeError(`VoxelPathTracer signal must be an AbortSignal`);return ya(a.signal),{width:n,height:r,samples:i,denoise:o,jitter:s,seed:c,wavelength:u,transparent:l,signal:a.signal}}async#me(e,t,n){this.#z(),this.#u===`compiling`&&await this.#_,this.#z();let r=this.#l;if(!r?.pipelines)throw new Mn(`state`,`VoxelPathTracer is not attached to a WebGPU engine; attach it first`);let i=r.device,a=this.#e.camera,o=new tr({fov:a.fov,position:a.position,target:a.target,near:a.near,far:a.far});o.up=a.up,o.project=a.project,o.update(e.width/e.height,!0);let s=this.#ce(),c=s?await this.#se(r):r.pipelines;this.#z(),this.#Y(r);let l=this.#s,u=r.layout,d=GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC,f=[],p=(e,t)=>{let n=this.#H(r,e,t);return f.push(n),n},m;this.#T++;try{let a={},f=i.createCommandEncoder();for(let e of[`table0`,`materials`,`voxels`,`scene`,`env`]){let t=r.buffers[e];a[e]=p(t.size,e===`table0`?GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST:d),f.copyBufferToBuffer(t,0,a[e],0,t.size)}i.queue.submit([f.finish()]);let h=e.width>Zi||e.height>Zi,g=e.denoise&&h?$i:0,_=Math.min(e.width,Zi)+2*g,v=Math.min(e.height,Zi)+2*g,y=p(800,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST),b=_*v*16,x=[0,...t?[1,2]:[],...e.transparent&&e.denoise?[3]:[]].map(()=>p(b,GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST)),S=e.transparent?await(s?r.tableCoverage??=this.#ae(r,`coverage`,!0):r.coverage??=this.#ae(r,`coverage`,!1)):void 0,C,w=0,T=0,E=performance.now(),D=new Map,O=()=>{if(ya(e.signal),this.#z(),r.lost||this.#l!==r)throw new Mn(`failed`,`VoxelPathTracer lost its GPU device during the render; render again`)};for(let s=0;s<e.height;s+=Zi){let d=Math.min(Zi,e.height-s),f={color:new Float32Array(e.width*d*3),albedo:t?new Float32Array(e.width*d*3):void 0,normal:t?new Float32Array(e.width*d*3):void 0,depth:t?new Float32Array(e.width*d):void 0,ids:t?new Float32Array(e.width*d):void 0,alpha:e.transparent?new Float32Array(e.width*d):void 0};for(let n=0;n<e.width;n+=Zi){let p=Math.min(Zi,e.width-n),h=Math.max(0,n-g),_=Math.max(0,s-g),v=Math.min(e.width,n+p+g),b=Math.min(e.height,s+d+g),k=v-h,A=b-_;(!m||m.width!==k||m.height!==A)&&(this.#J(m),m=this.#X(r,void 0,k,A,e.denoise,l.focusing),C=this.#Z(r,y,m,a),D.clear());let j=this.#a.maxBounces,M=un(j),N=Math.max(1,Math.min(16,Math.floor(fn(j)/(k*A)))),P=Math.max(8,hn(k,i.limits.minStorageBufferOffsetAlignment??256));for(let t=0;t<e.samples;t+=N){O();let n=Math.min(N,e.samples-t);if(`sums`in c.trace){this.#$(i,y,o,[e.width,e.height,h,_],[k,A,t,n],e.seed,e.jitter,fa(m),u,l,e.wavelength,e.transparent),await r.routeReady.run(c.trace,r.inputs.get(C),k,A,n,j,O,`image`,!0,this.#O);continue}let s=i.voxelTraceWork??r.pacer.budget;for(let d of mn(k,A,t,n,P,fn(j),fn(j,s))){let s=d.rows===A,f=`${d.y0}+${d.rows}`,p=s?C:D.get(f);p||(p=this.#Z(r,y,m,a,{frame:0,at:d.y0*k*16,size:d.rows*k*16}),D.set(f,p)),this.#$(i,y,o,[e.width,e.height,h,_+d.y0],[k,d.rows,t,n],e.seed,e.jitter,fa(m),u,l,e.wavelength,e.transparent);let g=i.createCommandEncoder(),v=g.beginComputePass();v.setPipeline(c.trace),v.setBindGroup(0,p),v.dispatchWorkgroups(Math.ceil(k/8),Math.ceil(d.rows/8)),v.end(),i.queue.submit([g.finish()]),T+=k*d.rows*n*M,++w%4==0&&(await i.queue.onSubmittedWorkDone(),r.pacer.observe(T,performance.now()-E),T=0,E=performance.now(),O())}}O();let F=i.createCommandEncoder();if(e.denoise&&(this.#ee(i,m,e.samples,[h,_,e.width,e.height]),this.#te(r,F,m)),t||S){this.#$(i,y,o,[e.width,e.height,h,_],[k,A,0,Qi],e.seed,!1,fa(m),u,l,0,e.transparent);for(let e of[t?c.ids:void 0,S]){if(!e)continue;let t=F.beginComputePass();t.setPipeline(e),t.setBindGroup(0,C),t.dispatchWorkgroups(Math.ceil(k/8),Math.ceil(A/8)),t.end()}}let I=k*A*16;F.copyBufferToBuffer(e.denoise?m.ping:m.accum,0,x[0],0,I),t&&(F.copyBufferToBuffer(m.albedo,0,x[1],0,I),F.copyBufferToBuffer(m.normals,0,x[2],0,I)),e.transparent&&e.denoise&&F.copyBufferToBuffer(m.accum,0,x[x.length-1],0,I),i.queue.submit([F.finish()]);let ee=x.map(e=>e.mapAsync(GPUMapMode.READ,0,I));try{await Promise.all(ee)}catch(e){throw O(),new Mn(`failed`,`VoxelPathTracer could not read the render back (${String(e)}); render again`)}let te=e=>new Float32Array(e.getMappedRange(0,I).slice(0)),ne=te(x[0]),re=t?te(x[1]):void 0,ie=t?te(x[2]):void 0,ae=e.transparent?e.denoise?te(x[x.length-1]):ne:void 0;for(let e of x)e.unmap();let oe=e.denoise?1:1/e.samples;for(let t=0;t<d;t++)for(let r=0;r<p;r++){let i=(s+t-_)*k+(n+r-h),a=t*e.width+n+r;for(let e=0;e<3;e++)f.color[a*3+e]=ne[i*4+e]*oe;if(ae&&(f.alpha[a]=ae[i*4+3]),re&&ie){for(let t=0;t<3;t++)f.albedo[a*3+t]=re[i*4+t]/e.samples,f.normal[a*3+t]=ie[i*4+t]/e.samples;let t=re[i*4+3]/e.samples;f.depth[a]=t>0?1/t:1/0,f.ids[a]=ie[i*4+3]}}}O(),await n(s,d,f)}}finally{this.#T--,this.#J(m);for(let e of f)this.#U(e)}}},xa=(e,t)=>e===void 0?void 0:e instanceof Map?e.get(t):e[t],Q=(e,t)=>{let n=xa(e,t);if(n===void 0||n.trim()===``)return;let r=Number(n);return Number.isFinite(r)?r:void 0},Sa=e=>Math.min(1,Math.max(0,e)),Ca=(e,t=2.2)=>{if(typeof t!=`number`||!Number.isFinite(t)||t<1||t>5)throw RangeError(`magicaVoxelLinear gamma must be finite and between 1 and 5; pass the file lighting.options.gamma`);return Sa(e/255)**t},wa=(e,t=2.2)=>[Ca(e[0],t),Ca(e[1],t),Ca(e[2],t)],Ta=(e,t,n,r)=>({id:e,type:`media`,color:t,density:14*n,anisotropy:r,sunlit:!0});function Ea(e,t,n,r=2.2){if(!Number.isInteger(e)||e<1||e>255)throw RangeError(`magicaVoxelMaterial id ${e} is out of range; pass a palette index 1 to 255`);let i=n,a=xa(i,`_type`)??`_diffuse`,o=wa(t,r),s=Q(i,`_weight`),c=Math.sqrt(.13*Sa(Q(i,`_rough`)??0)),l=Q(i,`_spec`),u=l===void 0?Q(i,`_sp`)??1:1+l,d=Math.min(3,Math.max(1,1+(Q(i,`_ior`)??(Q(i,`_ri`)??1)-1))),f=Math.max(0,Q(i,`_d`)??0),p=Math.min(.95,Math.max(-.95,Q(i,`_g`)??0)),m=xa(i,`_media_type`)??(a===`_media`?`_scatter`:`_absorb`),h=Math.sqrt(Sa(s??Q(i,`_alpha`)??Q(i,`_trans`)??0)),g=[Math.min(1,u*o[0]),Math.min(1,u*o[1]),Math.min(1,u*o[2])],_=m===`_scatter`||m===`_sss`?{scatter:f,anisotropy:p}:{density:m===`_absorb`?f:0};switch(a){case`_metal`:return{id:e,type:`metal`,color:o,metalColor:g,metalness:Sa(s??Q(i,`_metal`)??0),roughness:c,ior:d,specular:1,coat:`additive`};case`_glass`:return m===`_sss`&&h>=1?Ta(e,o,f,p):{id:e,type:h<1?`blend`:`glass`,color:o,transmission:h,contactTransmission:h<1,metalness:0,roughness:c,ior:d,specular:1,coat:`additive`,tint:!1,..._};case`_blend`:return{id:e,type:`blend`,color:o,metalColor:g,metalness:Sa(Q(i,`_metal`)??0),transmission:Math.sqrt(Sa(Q(i,`_alpha`)??Q(i,`_trans`)??0)),contactTransmission:!0,roughness:c,ior:d,specular:1,coat:`additive`,tint:!1,..._};case`_emit`:{let t=Math.max(0,s??Q(i,`_emit`)??0),n=Q(i,`_flux`)??0,r=Sa(Q(i,`_ldr`)??0);return{id:e,type:`emit`,color:[0,0,0],emissionColor:o,emission:1+3*t*10**n,...r>0?{cameraEmission:1+3*r}:{}}}case`_media`:{let t=Q(i,`_d`)??(s===void 0?0:Math.min(.1,s));return m===`_absorb`?{id:e,type:`glass`,color:o,ior:1,roughness:0,density:t,tint:!1,specular:0}:m===`_sss`?Ta(e,o,t,p):{id:e,type:`media`,color:o,density:t,anisotropy:p,...m===`_emit`?{density:0,emission:.93*t}:{}}}default:return{id:e,type:`diffuse`,color:o}}}-Math.atan(Math.SQRT1_2);function Da(e,t,n,r){let[i,a,o]=[n[0],n[1],n[2]];if(![i,a,o].every(e=>Number.isInteger(e)&&e>=1&&e<=256))throw RangeError(`magicaVoxelModel size ${Array.from(n).join(` x `)} is out of range; pass 1 to 256 per axis`);let s=new Uint8Array(i*a*o);for(let e=0;e+3<r.length;e+=4){let t=r[e],n=r[e+1],c=r[e+2];t<i&&n<a&&c<o&&(s[t+i*(a-1-n+a*c)]=r[e+3])}return{id:e,revision:t,size:[i,o,a],voxels:s}}var Oa=new Map([[`PACK`,`pack`],[`SIZE`,`models`],[`nTRN`,`nodes`],[`nGRP`,`nodes`],[`nSHP`,`nodes`],[`LAYR`,`layers`],[`RGBA`,`palette`],[`MATL`,`materials`]]),ka=(()=>{let e=new Uint8Array(1024),t=[255,204,153,102,51,0],n=[238,221,187,170,136,119,85,68,34,17],r=1;for(let n of t)for(let i of t)for(let a of t)n|i|a&&e.set([n,i,a,255],4*r++);for(let t of[[1,0,0],[0,1,0],[0,0,1],[1,1,1]])for(let i of n)e.set([i*t[0],i*t[1],i*t[2],255],4*r++);return e})(),Aa=e=>typeof e==`number`&&(e|0)===e,ja=(e,t,n,r)=>typeof t===n?RangeError(`${e} ${String(t)} is invalid; pass ${r}`):TypeError(`${e} must be a ${n}; pass ${r}`),Ma={read:e=>e,write(e,t){if(typeof e!=`string`)throw TypeError(`${t} must be a string`);return e}},Na={read:e=>e!==`0`,write(e,t){if(typeof e!=`boolean`)throw TypeError(`${t} must be true or false`);return e?`1`:`0`}},Pa={read:e=>Number.isFinite(Number(e))?Number(e):void 0,write(e,t){if(typeof e!=`number`||!Number.isFinite(e))throw ja(t,e,`number`,`a finite number`);return String(e)}},Fa={read:e=>Aa(Number(e))&&Number(e)>=0?Number(e):void 0,write(e,t){if(!Aa(e)||e<0)throw ja(t,e,`number`,`an integer frame index from 0`);return String(e)}},Ia={read:e=>e.startsWith(`_`)?e.slice(1):e,write:(e,t)=>`_${Ma.write(e,t)}`},La={read(e){let t=e.trim().split(/\s+/).map(Number);return t.length===3&&t.every(Aa)?t:void 0},write(e,t){if(!Array.isArray(e)||e.length!==3||!e.every(Aa))throw RangeError(`${t} must be 3 32-bit integers [x, y, z]`);return e.join(` `)}};function Ra(e){let t=e&3,n=e>>2&3;if(t>2||n>2||t===n)return;let r=[0,0,0,0,0,0,0,0,0];return r[t]=e&16?-1:1,r[3+n]=e&32?-1:1,r[9-t-n]=e&64?-1:1,r}function za(e,t){let n=e,r=[];if(Array.isArray(n)&&n.length===9)for(let e=0;e<3;e++){let t=n.slice(3*e,3*e+3),i=t.findIndex(e=>e===1||e===-1);if(i<0||r.includes(i)||t.some((e,t)=>t!==i&&e!==0))break;r.push(i)}if(r.length!==3)throw RangeError(`${t} must be a row-major 3 x 3 signed permutation (each row and column one 1 or -1)`);return r[0]|r[1]<<2|(n[r[0]]<0?16:0)|(n[3+r[1]]<0?32:0)|(n[6+r[2]]<0?64:0)}var Ba={read:e=>Aa(Number(e))&&(Number(e)&255)===Number(e)?Ra(Number(e)):void 0,write:(e,t)=>String(za(e,t))},Va=[[`name`,`_name`,Ma],[`hidden`,`_hidden`,Na]],Ha=[[`rotation`,`_r`,Ba],[`translation`,`_t`,La],[`frame`,`_f`,Fa]],Ua=[[`frame`,`_f`,Fa]],Wa=[[`type`,`_type`,Ia],...[`weight`,`rough`,`spec`,`ior`,`att`,`flux`,`plastic`].map(e=>[e,`_${e}`,Pa])],Ga=new TextDecoder(`utf-8`,{fatal:!0,ignoreBOM:!0}),Ka=new TextDecoder(`windows-1252`);new TextEncoder;var qa=!1,Ja=e=>{if(qa=!1,e.length<=64&&e.every(e=>e<128))return String.fromCharCode(...e);try{return Ga.decode(e)}catch{return qa=!0,Ka.decode(e)}},Ya=new WeakMap,$=e=>RangeError(`Vox file ${e}; pass a complete .vox file as written by MagicaVoxel or writeVox`),Xa=e=>JSON.stringify(e.length>40?`${e.slice(0,40)}...`:e);function Za(e){let t=e instanceof ArrayBuffer?new Uint8Array(e):e;if(!(t instanceof Uint8Array))throw TypeError(`parseVox expects the file bytes as a Uint8Array or ArrayBuffer`);let n=new DataView(t.buffer,t.byteOffset,t.byteLength),r=e=>String.fromCharCode(t[e],t[e+1],t[e+2],t[e+3]);if(t.length<20||r(0)!==`VOX `||r(8)!==`MAIN`)throw TypeError(`Bytes are not a .vox file (no "VOX " header and MAIN chunk); pass a MagicaVoxel .vox file`);if(n.getInt32(12,!0))throw $(`MAIN chunk has content bytes`);if(n.getInt32(16,!0)!==t.length-20)throw $(`MAIN chunk declares ${n.getInt32(16,!0)} bytes of chunks but ${t.length-20} follow`);let i={version:n.getInt32(4,!0),models:[],palette:ka.slice(),materials:[],nodes:[],layers:[],chunks:[]},a=i.chunks,o=20,s=-1,c=!1,l=``,u=0,d=0,f=()=>`chunk ${l} at byte ${o}`,p=()=>{if(t.length-o<12)throw $(`is truncated: a chunk header at byte ${o} needs 12 bytes`);let e=n.getInt32(o+4,!0),i=n.getInt32(o+8,!0);if(e<0||i<0||e+i>t.length-o-12)throw $(`is truncated: chunk ${Xa(r(o))} at byte ${o} declares ${e} + ${i} bytes, ${t.length-o-12} remain`);return[r(o),e,i]},m=e=>{if(e>d-u)throw $(`${f()} is truncated at byte ${u}`)},h=()=>(m(4),u+=4,n.getInt32(u-4,!0)),g=(e,t,n)=>{let r=h();if(r<e||r>(d-u)/t)throw $(`${f()} has ${r} ${n}, ${r<e?`fewer than ${e}`:`more than its bytes hold`}`);return r},_=()=>{let e=h();if(e<0)throw $(`${f()} has a string of ${e} bytes`);return m(e),u+=e,Ja(t.subarray(u-e,u))},v=()=>{let e=new Map,t;for(let n=g(0,8,`attributes`);n--;){let n=_(),r=qa;if(e.has(n))throw $(`${f()} has attribute ${Xa(n)} twice`);let i=_();e.set(n,i),(r||qa)&&(t??=new Map).set(n,{key:r,value:qa?i:void 0})}return t&&Ya.set(e,t),e},y=(e,t,n,r)=>{for(let[i,a,o]of n){let n=t.get(a),s=n===void 0?void 0:o.read(n);if(n!==void 0&&s===void 0)throw $(`${r} attribute ${a} ${Xa(n)} is invalid`);s!==void 0&&(e[i]=s)}return e};for(;o<t.length;){let[e,r,_]=p();if(l=e,u=o+12,d=u+r,l===`MAIN`||l===`XYZI`)throw $(l===`MAIN`?`has a second MAIN chunk at byte ${o}`:`has an XYZI chunk at byte ${o} without a SIZE before it`);if(!Oa.has(l))a.push({id:l,content:t.slice(u,d),children:t.slice(d,d+_)}),o=d+_;else{if(_)throw $(`${f()} has child chunks`);if(l===`PACK`){if(s>=0)throw $(`has a second PACK chunk at byte ${o}`);if(s=h(),s<0)throw $(`${f()} counts ${s} models`)}else if(l===`SIZE`){let e=[h(),h(),h()];if(!e.every(e=>e>=1&&e<=256))throw $(`${f()} has size ${e.join(` x `)}, not 1-256 per axis`);if(u!==d)throw $(`${f()} has ${d-u} extra bytes`);let r=o;o=d;let[a,s,c]=o<t.length?p():[``,0,0];if(a!==`XYZI`)throw $(`chunk SIZE at byte ${r} is not followed by its XYZI chunk`);let m=s>=4?n.getInt32(o+12,!0):-1;if(c||m<0||s!==4+4*m)throw $(`chunk XYZI at byte ${o} has ${s} content bytes, not 4 + 4 per voxel (and no children)`);let g=t.slice(o+16,o+16+4*m);for(let t=0;t<g.length;t+=4)if(g[t]>=e[0]||g[t+1]>=e[1]||g[t+2]>=e[2]||!g[t+3])throw $(`voxel ${t/4} of model ${i.models.length} (${g.subarray(t,t+4).join(`, `)}) is outside ${e.join(` x `)} or has palette index 0`);i.models.push({size:e,voxels:g}),l=`SIZE`,u=d=o+12+s}else if(l===`RGBA`){if(c)throw $(`has a second RGBA chunk at byte ${o}`);m(1024),c=!0;for(let e=0;e<256;e++)i.palette.set(t.subarray(u+4*e,u+4*e+4),4*(e+1&255));u+=1024}else if(l===`MATL`){let e={id:h(),attributes:v()};i.materials.push(y(e,e.attributes,Wa,`material ${e.id}`))}else if(l===`LAYR`){let e={id:h(),attributes:v()};h(),i.layers.push(y(e,e.attributes,Va,`layer ${e.id}`))}else{let e=h(),t=v(),n;if(l===`nTRN`){let r=h();h(),n={id:e,type:`transform`,child:r,layer:h(),frames:Array.from({length:g(1,4,`frames`)},(t,n)=>{let r=v();return y({attributes:r},r,Ha,`node ${e} frame ${n}`)}),attributes:t}}else n=l===`nGRP`?{id:e,type:`group`,children:Array.from({length:g(0,4,`children`)},h),attributes:t}:{id:e,type:`shape`,models:Array.from({length:g(1,8,`models`)},(t,n)=>{let r=h(),i=v();return y({model:r,attributes:i},i,Ua,`node ${e} model ${n}`)}),attributes:t};i.nodes.push(y(n,t,Va,`node ${e}`))}if(u!==d)throw $(`${f()} has ${d-u} bytes after its content`);a.push({id:l}),o=d}}if(s>=0&&s!==i.models.length)throw $(`PACK counts ${s} models but ${i.models.length} follow`);return Qa(i.nodes,i.models.length,$),i}function Qa(e,t,n){let r=new Map,i=new Map;for(let t of e){if(r.has(t.id))throw n(`has two nodes with id ${t.id}`);r.set(t.id,t)}let a=(e,t,a)=>{let o=r.get(t);if(!o||o.type===`transform`!==a)throw n(`node ${e} has child ${t}, which is not a ${a?`transform`:`group or shape`} node`);if(i.has(t))throw n(`node ${t} has two parents, ${i.get(t)} and ${e}`);i.set(t,e)};for(let r of e)if(r.type===`transform`)a(r.id,r.child,!1);else if(r.type===`group`)for(let e of r.children)a(r.id,e,!0);else for(let{model:e}of r.models)if(!(Number.isInteger(e)&&e>=0&&e<t))throw n(`has shape node ${r.id} showing model ${e} of ${t}`);let o=new Set;for(let t of e){let r=[];for(let a=t.id;a!==void 0&&!o.has(a);a=i.get(a))if(r.push(a),r.length>e.length)throw n(`has node ${t.id} on a cycle of parents`);for(let e of r)o.add(e)}}var $a=[7,8],eo=[9,10,18];function to(e){let t=Za(new Uint8Array(e)),n=t.models[0],r=Da(`afterglass`,1,n.size,n.voxels),i=[...new Set(r.voxels)].filter(Boolean).sort((e,t)=>e-t).map(e=>Ea(e,t.palette.subarray(e*4,e*4+3),t.materials.find(t=>t.id===e)?.attributes));if(eo.some(e=>i.find(t=>t.id===e)?.type!==`glass`)||$a.some(e=>i.find(t=>t.id===e)?.type!==`emit`))throw Error(`The VOX file is missing glass or emitter materials.`);let a=Object.fromEntries([...$a,...eo].map(e=>[e,0]));for(let e of r.voxels)e in a&&a[e]++;let o={skyColor:[.48,.63,.78],skyIntensity:.4,sunColor:[1,.88,.76],sunDirection:[-.55,.8,.33],sunIntensity:.34,sunAngularSize:.1,groundColor:[.052,.062,.079],groundHeight:-.02,background:[.018,.024,.047]};function s(e,t,n){let a=i.map(e=>$a.includes(e.id)&&e.id!==(t?8:7)?{id:e.id,type:`diffuse`,color:e.color.map(e=>e*.34)}:eo.includes(e.id)&&n?{id:e.id,type:`diffuse`,color:e.color}:e);return{revision:e,models:[r],instances:[{id:`gallery`,modelId:r.id,matrix:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]}],materials:a,environment:o}}return{state:s,counts:a,cells:n.voxels.length/4}}var no=()=>new Promise(e=>requestAnimationFrame(e));async function ro(a,o,s,c,l,u,d,f){let p,m,h=a,g,_,v,y,b=!1,x=!1,S=!1,C=1;function w(){b||(b=!0,cancelAnimationFrame(y),v?.disconnect(),m?.dispose(),p?.dispose())}s.addEventListener(`abort`,w,{once:!0});let T=async()=>{if(l){let e=await l;if(e.error)throw e.error}else await(await i(async()=>{let{installCompatibility:e}=await import(`./compatibility-ECKI6euk.js`);return{installCompatibility:e}},__vite__mapDeps([2,3,4]),import.meta.url)).installCompatibility(o,s)};function E(){let e=Math.min(devicePixelRatio,2,r[0]/Math.max(1,h.clientWidth),r[1]/Math.max(1,h.clientHeight)),t=Math.max(1,Math.round(h.clientWidth*e)),n=Math.max(1,Math.round(h.clientHeight*e));return h.width===t&&h.height===n?!1:(h.width=t,h.height=n,!0)}function D(){if(s.throwIfAborted(),g||(E(),p.render({delta:0}),g))throw g;d(m.stats)}async function O(e){cancelAnimationFrame(y);let t=performance.now()+13e3;for(;;){if(D(),m.stats.sceneRevision===e&&m.stats.samples>0)return await p.gpu.queue.onSubmittedWorkDone(),s.throwIfAborted(),m.stats;if(performance.now()>=t)throw Error(`The path tracer did not produce a first sample.`);await no()}}function k(){if(!(b||S))try{D(),m.stats.converged||(y=requestAnimationFrame(k))}catch(e){f(e)}}async function A(e,t){let n=++C;cancelAnimationFrame(y),m.setScene(_.state(n,e,t));let r=await O(n);return S||(y=requestAnimationFrame(k)),r}l&&await T();try{p=await di(a,async n=>{if(!n.gpu){let e=Error(`This exhibit requires native WebGPU or full Margo WebGL2 compatibility.`);throw e.code=`unsupported`,e}p=n,h=n.canvas,g=void 0,n.onError=e=>{g=e,x&&f(e)},n.camera.project=t,n.scene.background=`#273046`,performance.mark(`trace-device`);let r=await c;if(r.error)throw r.error;_=to(r),performance.mark(`trace-vox-loaded`),m=ba.attach(n,{...e,scene:_.state(1,u.blue,u.opaque)}),performance.mark(`trace-attached`),await m.ready,performance.mark(`trace-compiled`),await O(C),performance.mark(`trace-first-samples`)},{backend:l?`webgpu`:void 0,loadCompat:async()=>({install:T}),signal:s,exactSize:!0,antialias:!1,capacity:18,startupTimeout:12e3,camera:n}),x=!0,v=new ResizeObserver(()=>{b||S||!E()||(cancelAnimationFrame(y),y=requestAnimationFrame(k))}),v.observe(h),y=requestAnimationFrame(k)}catch(e){throw w(),e}return{close:w,change:A,counts:_.counts,cells:_.cells,canvas:h,pause(){S=!0,cancelAnimationFrame(y)},resume(){S=!1,cancelAnimationFrame(y),y=requestAnimationFrame(k)},backend:p.gpu.adapterInfo?.vendor===`margo-webgl2`?`webgl2`:`webgpu`}}export{kn as a,wn as i,un as n,ro as openStudy,tn as r,Mn as t};