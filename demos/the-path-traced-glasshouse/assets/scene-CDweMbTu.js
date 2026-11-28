import{t as e}from"./rolldown-runtime-DK3Fl9T5.js";import{t}from"./index-DYUjXne4.js";import{a as n,i as r,o as i,r as a}from"./api-BoPK1oUI.js";import{n as o}from"./glasshouse-CEMn_8VL.js";var s=(e,t=n,i=import.meta.url)=>(a(e,r(t,i)),e);function c(e){return{meshTriangles:e[2]??0,skippedDegenerateTriangles:e[3]??0,meshBvhNodes:e[1]===0?e[8]??0:e[0]??0,meshInstances:e[1]===0?e[4]??0:0,builtMeshBlases:e[1]===0?e[6]??0:0,reusedMeshBlases:e[1]===0?e[7]??0:0}}function l(e){return e[1]===0&&e[9]===1296649811&&(e[11]??0)>0}function u(e,t){if(!e||typeof e!=`object`||Array.isArray(e))throw TypeError(`${t} options must be an object`)}var d=class{check(e,t=this.error){if(t&&typeof e==`number`&&e>0)throw t}},f=class extends Error{constructor(e,t){super(t),this.name=`MargoError`,this.code=e}static[Symbol.hasInstance](e){return e instanceof Error&&e.name===`MargoError`}},p=`fn acesNarkowicz(c:vec3f)->vec3f{let x=0.6*c;return clamp(x*(2.51*x+0.03)/(x*(2.43*x+0.59)+0.14),vec3f(0.0),vec3f(1.0));}
`;function m(e,t=[0,0,0]){for(let n=0;n<3;n++){let r=.6*e[n];t[n]=Math.min(1,Math.max(0,r*(2.51*r+.03)/(r*(2.43*r+.59)+.14)))}return t}var h=.18,g=10,_=2.4,v=1.5,y=2.4,b=1e-10,x=.6,S=[.6274039,.32928304,.043313066,.069097289,.9195404,.011362316,.016391439,.088013308,.89559525],C=[.85662716,.095121245,.048251598,.13731897,.76124199,.10143904,.11189821,.076799415,.81130238],w=[1.1271006,-.11060664,-.016493931,-.14132975,1.1578237,-.016493931,-.14132975,-.11060664,1.2519364],T=[1.660491,-.58764114,-.072849863,-.12455047,1.1328999,-.0083494226,-.018150763,-.1005789,1.1187297],E=[.26270021,.67799807,.059301716],D=[.21263901,.71516868,.072192315],O=T.map((e,t)=>{let n=t-t%3,r=t%3;return T[n]*w[r]+T[n+1]*w[r+3]+T[n+2]*w[r+6]}),k=16.5,A=1/k,j=(g-Math.log2(h))/k,M=g/k,N=h**(1/y),P=(e,t)=>e*((e/t)**v-1)**(-1/v),ee=P(_*.3939393939393939,1-N),F=P(_*M,N),I=e=>Number.isInteger(e)?e+`.0`:String(e),te=e=>`mat3x3f(${[0,1,2].map(t=>`vec3f(${I(e[t])},${I(e[t+3])},${I(e[t+6])})`).join(`,`)})`,ne=e=>`vec3f(${e.map(I).join(`,`)})`,re=`fn agxRail(c:vec3f,w:vec3f)->vec3f{let o=c+max(-min(c.x,min(c.y,c.z)),0.0);let y=max(dot(c,w),0.0);
let s=dot(o,w);return select(o,o*(y/s),s>y);}
fn agxHsv(c:vec3f)->vec3f{let m=max(c.x,max(c.y,c.z));let d=m-min(c.x,min(c.y,c.z));var h=0.0;
if(d>0.0){if(m==c.x){h=(c.y-c.z)/d;}else if(m==c.y){h=(c.z-c.x)/d+2.0;}else{h=(c.x-c.y)/d+4.0;}}
return vec3f(fract(h/6.0),select(0.0,d/m,m>0.0),m);}
fn agxRgb(c:vec3f)->vec3f{let k=(vec3f(5.0,3.0,1.0)+c.x*6.0)%6.0;return c.z-c.z*c.y*clamp(min(k,4.0-k),vec3f(0.0),vec3f(1.0));}
fn agxSide(t:vec3f,k:vec3f)->vec3f{let u=${I(_)}*t/k;return k*u/pow(1.0+pow(u,vec3f(${I(v)})),vec3f(${I(1/v)}));}
fn agx(c:vec3f)->vec3f{
let i=${te(C)}*agxRail(${te(S)}*c,${ne(E)});
let x=clamp(log2(select(vec3f(${I(b)}),i,i>vec3f(${I(b)})))*${I(A)}+${I(j)},vec3f(0.0),vec3f(1.0));
let d=x-${I(M)};let y=${I(N)}+sign(d)*agxSide(abs(d),select(vec3f(${I(F)}),vec3f(${I(ee)}),d>=vec3f(0.0)));
var f=agxHsv(pow(max(y,vec3f(0.0)),vec3f(${I(y)})));let p=agxHsv(i);
if(f.y>0.0&&p.y>0.0){let h=p.x-f.x;f.x=fract(f.x+${I(x)}*(h-floor(h+0.5)));}
return clamp(agxRail(${te(O)}*agxRgb(f),${ne(D)}),vec3f(0.0),vec3f(1.0));}
`,L=0,R=0,z=0,B=0,V=0,H=0;function ie(e,t,n,r){L=e[0]*t+e[1]*n+e[2]*r,R=e[3]*t+e[4]*n+e[5]*r,z=e[6]*t+e[7]*n+e[8]*r}function ae(e,t,n,r){let i=Math.max(-Math.min(e,t,n),0),a=Math.max(e*r[0]+t*r[1]+n*r[2],0);e+=i,t+=i,n+=i;let o=e*r[0]+t*r[1]+n*r[2],s=o>a?a/o:1;L=e*s,R=t*s,z=n*s}function oe(e,t,n){let r=Math.max(e,t,n),i=r-Math.min(e,t,n),a=0;i>0&&(a=(r===e?(t-n)/i:r===t?(n-e)/i+2:(e-t)/i+4)/6),B=a-Math.floor(a),V=r>0?i/r:0,H=r}var se=e=>{let t=(e+B*6)%6;return H-H*V*Math.min(Math.max(Math.min(t,4-t),0),1)};function U(e){let t=Math.min(Math.max(Math.log2(e>b?e:b)*A+j,0),1)-M,n=t>=0?ee:F,r=_*Math.abs(t)/n;return Math.max(N+Math.sign(t)*n*r/(1+r**v)**(1/v),0)**y}function ce(e,t=[0,0,0]){ie(S,e[0],e[1],e[2]),ae(L,R,z,E),ie(C,L,R,z);let n=L,r=R,i=z;oe(U(n),U(r),U(i));let a=B,o=V,s=H;if(oe(n,r,i),o>0&&V>0){let e=B-a;B=a+x*(e-Math.floor(e+.5)),B-=Math.floor(B)}else B=a;return V=o,H=s,ie(O,se(5),se(3),se(1)),ae(L,R,z,D),t[0]=Math.min(Math.max(L,0),1),t[1]=Math.min(Math.max(R,0),1),t[2]=Math.min(Math.max(z,0),1),t}var le=e=>{let t=Math.min(e[0],e[1],e[2]),n=t<.08?t-6.25*t*t:.04,r=e.map(e=>e-n),i=Math.max(r[0],r[1],r[2]);if(i<.76)return r;let a=1-.0576/(i+.24-.76),o=1-1/(.15*(i-a)+1);return r.map(e=>e*a/i+(a-e*a/i)*o)},ue=e=>e===`linear`?e=>e:e===`aces-narkowicz`?m:e===`agx`?ce:le,de=(e,t)=>{let n=Math.min(1,Math.max(0,e));return Math.round(255*(t?n**(1/t):n<=.0031308?n*12.92:1.055*n**(1/2.4)-.055))};function fe(e,t,n,r,i,a,o,s,c){let l=2**e.exposure,u=ue(e.toneMapping),{gamma:d,vignette:f}=e,p=[0,0,0];for(let e=0;e<t*i;e++){let i=o?o[e]:1,m=i>0?l/i:0;if(f>0){let i=e%t+.5-t/2,a=r+Math.floor(e/t)+.5-n/2,o=f*Math.hypot(i,a)/(.2238*n);m/=(1+o*o)**2}for(let t=0;t<3;t++)p[t]=Math.max(0,a[e*3+t]*m);let h=u(p);for(let t=0;t<3;t++)c[e*s+t]=de(h[t],d);s===4&&(c[e*4+3]=Math.round(255*Math.min(1,Math.max(0,i))))}}function pe(e,t=new Float64Array(16)){let n=e[0],r=e[1],i=e[2],a=e[3],o=e[4],s=e[5],c=e[6],l=e[7],u=e[8],d=e[9],f=e[10],p=e[11],m=e[12],h=e[13],g=e[14],_=e[15],v=n*s-r*o,y=n*c-i*o,b=n*l-a*o,x=r*c-i*s,S=r*l-a*s,C=i*l-a*c,w=u*h-d*m,T=u*g-f*m,E=u*_-p*m,D=d*g-f*h,O=d*_-p*h,k=f*_-p*g,A=v*k-y*O+b*D+x*E-S*T+C*w;if(!A||!Number.isFinite(A))return null;let j=1/A;return t[0]=(s*k-c*O+l*D)*j,t[1]=(i*O-r*k-a*D)*j,t[2]=(h*C-g*S+_*x)*j,t[3]=(f*S-d*C-p*x)*j,t[4]=(c*E-o*k-l*T)*j,t[5]=(n*k-i*E+a*T)*j,t[6]=(g*b-m*C-_*y)*j,t[7]=(u*C-f*b+p*y)*j,t[8]=(o*O-s*E+l*w)*j,t[9]=(r*E-n*O-a*w)*j,t[10]=(m*S-h*b+_*v)*j,t[11]=(d*b-u*S-p*v)*j,t[12]=(s*T-o*D-c*w)*j,t[13]=(n*D-r*T+i*w)*j,t[14]=(h*y-m*x-g*v)*j,t[15]=(u*x-d*y+f*v)*j,t}function me(e,t,n,r){let i=t[0],a=t[1],o=t[2],s=t[3];return r.set([(1-2*(a*a+o*o))*n[0],2*(i*a+s*o)*n[0],2*(i*o-s*a)*n[0],0,2*(i*a-s*o)*n[1],(1-2*(i*i+o*o))*n[1],2*(a*o+s*i)*n[1],0,2*(i*o+s*a)*n[2],2*(a*o-s*i)*n[2],(1-2*(i*i+a*a))*n[2],0,e[0],e[1],e[2],1]),r}function he(e,t,n,r,i,a){let o=e.length===9?3:4,s=e[0]/t,c=e[1]/t,l=e[2]/t,u=e[o]/n,d=e[o+1]/n,f=e[o+2]/n,p=e[2*o]/r,m=e[2*o+1]/r,h=e[2*o+2]/r,g=s+d+h;if(g>0){let e=Math.sqrt(1+g),t=.5/e;return a(i,(f-m)*t,(p-l)*t,(c-u)*t,e/2)}if(s>d&&s>h){let e=Math.sqrt(1+s-d-h),t=.5/e;return a(i,e/2,(u+c)*t,(p+l)*t,(f-m)*t)}if(d>h){let e=Math.sqrt(1+d-s-h),t=.5/e;return a(i,(u+c)*t,e/2,(m+f)*t,(p-l)*t)}let _=Math.sqrt(1+h-s-d),v=.5/_;return a(i,(p+l)*v,(m+f)*v,_/2,(c-u)*v)}function ge(e,t,n,r,i,a){let o=Math.sqrt(e*e+t*t+n*n+r*r);if(!(o>2**-511&&o<1/0)){let i=Math.max(Math.abs(e),Math.abs(t),Math.abs(n),Math.abs(r));i>0&&i<1/0&&(e/=i,t/=i,n/=i,r/=i,o=Math.sqrt(e*e+t*t+n*n+r*r))}return o||=1,a(i,e/o,t/o,n/o,r/o)}var _e=(e,t,n,r,i,a)=>a(i,-e,-t,-n,r);function ve(e,t,n,r,i,a){let o=Math.sin(r/2);return a(i,e*o,t*o,n*o,Math.cos(r/2))}var ye=(e,t,n,r,i)=>e.set(t,n,r,i),be=class e{constructor(e=0,t=0,n=0,r=1){this.x=e,this.y=t,this.z=n,this.w=r}set(e,t,n,r){return this.x=e,this.y=t,this.z=n,this.w=r,this}identity(){return this.set(0,0,0,1)}copy(e){return this.set(e.x,e.y,e.z,e.w)}clone(){return new e(this.x,this.y,this.z,this.w)}setFromAxisAngle(e,t){return ve(e.x,e.y,e.z,t,this,ye)}setFromEuler(e){let t=e.x/2,n=e.y/2,r=e.z/2,i=Math.sin(t),a=Math.cos(t),o=Math.sin(n),s=Math.cos(n),c=Math.sin(r),l=Math.cos(r),u=i*s,d=a*o,f=a*s,p=i*o,m=u*l,h=d*c,g=d*l,_=u*c,v=f*c,y=p*l,b=f*l,x=p*c;switch(e.order){case`XYZ`:return this.set(m+h,g-_,v+y,b-x);case`YXZ`:return this.set(m+h,g-_,v-y,b+x);case`ZXY`:return this.set(m-h,g+_,v+y,b-x);case`ZYX`:return this.set(m-h,g+_,v-y,b+x);case`YZX`:return this.set(m+h,g+_,v-y,b-x);case`XZY`:return this.set(m-h,g-_,v+y,b+x)}throw RangeError(`Invalid Euler order ${e.order}; use XYZ, XZY, YXZ, YZX, ZXY or ZYX`)}setFromRotationMatrix(e){return he(e.elements,1,1,1,this,ye)}setFromUnitVectors(e,t){let{x:n,y:r,z:i}=e,{x:a,y:o,z:s}=t,c=1+n*a+r*o+i*s;if(c<1e-8){let e=Math.abs(n),t=Math.abs(r),a=Math.abs(i);return e<=t&&e<=a?this.set(0,i,-r,0):t<=a?this.set(-i,0,n,0):this.set(r,-n,0,0),this.normalize()}return this.set(r*s-i*o,i*a-n*s,n*o-r*a,c).normalize()}multiply(e){return this.multiplyComponents(this.x,this.y,this.z,this.w,e.x,e.y,e.z,e.w)}premultiply(e){return this.multiplyComponents(e.x,e.y,e.z,e.w,this.x,this.y,this.z,this.w)}multiplyQuaternions(e,t){return this.multiplyComponents(e.x,e.y,e.z,e.w,t.x,t.y,t.z,t.w)}multiplyComponents(e,t,n,r,i,a,o,s){return this.set(e*s+r*i+t*o-n*a,t*s+r*a+n*i-e*o,n*s+r*o+e*a-t*i,r*s-e*i-t*a-n*o)}conjugate(){return _e(this.x,this.y,this.z,this.w,this,ye)}invert(){let e=this.lengthSq()||1;return this.set(-this.x/e,-this.y/e,-this.z/e,this.w/e)}dot(e){return this.x*e.x+this.y*e.y+this.z*e.z+this.w*e.w}lengthSq(){return this.dot(this)}length(){return Math.sqrt(this.lengthSq())}normalize(){let{x:e,y:t,z:n,w:r}=this,i=this.length();return i===i&&(i||e||t||n||r)?ge(e,t,n,r,this,ye):this.identity()}angleTo(e){let{x:t,y:n,z:r,w:i}=this,a=i*e.x-e.w*t-(n*e.z-r*e.y),o=i*e.y-e.w*n-(r*e.x-t*e.z),s=i*e.z-e.w*r-(t*e.y-n*e.x);return 2*Math.atan2(Math.hypot(a,o,s),Math.abs(this.dot(e)))}rotateTowards(e,t){let n=this.angleTo(e);return n===0?this.copy(e):this.slerp(e,Math.min(1,t/n))}slerp(e,t){if(t===0)return this;if(t===1)return this.copy(e);let{x:n,y:r,z:i,w:a}=this,o=this.dot(e),s=e.x,c=e.y,l=e.z,u=e.w;if(o<0&&(o=-o,s=-s,c=-c,l=-l,u=-u),o>=1)return this;let d=1-o*o;if(d<=2**-52)return this.set(n+(s-n)*t,r+(c-r)*t,i+(l-i)*t,a+(u-a)*t).normalize();let f=Math.sqrt(d),p=Math.atan2(f,o),m=Math.sin((1-t)*p)/f,h=Math.sin(t*p)/f;return this.set(n*m+s*h,r*m+c*h,i*m+l*h,a*m+u*h)}slerpQuaternions(e,t,n){return this.copy(e).slerp(t,n)}equals(e,t=0){return Math.abs(this.x-e.x)<=t&&Math.abs(this.y-e.y)<=t&&Math.abs(this.z-e.z)<=t&&Math.abs(this.w-e.w)<=t}fromArray(e,t=0){return this.set(e[t],e[t+1],e[t+2],e[t+3])}toArray(e=[],t=0){return e[t]=this.x,e[t+1]=this.y,e[t+2]=this.z,e[t+3]=this.w,e}},xe,Se=class e{constructor(){this.elements=new Float64Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1])}set(e,t,n,r,i,a,o,s,c,l,u,d,f,p,m,h){let g=this.elements;return g[0]=e,g[4]=t,g[8]=n,g[12]=r,g[1]=i,g[5]=a,g[9]=o,g[13]=s,g[2]=c,g[6]=l,g[10]=u,g[14]=d,g[3]=f,g[7]=p,g[11]=m,g[15]=h,this}identity(){return this.set(1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1)}copy(e){return this.fromArray(e.elements)}clone(){return new e().copy(this)}multiply(e){return this.multiplyMatrices(this,e)}premultiply(e){return this.multiplyMatrices(e,this)}multiplyMatrices(e,t){let n=e.elements,r=t.elements,i=xe??=new Float64Array(16);for(let e=0;e<4;e++){let t=r[e*4],a=r[e*4+1],o=r[e*4+2],s=r[e*4+3];for(let r=0;r<4;r++)i[e*4+r]=n[r]*t+n[4+r]*a+n[8+r]*o+n[12+r]*s}return this.elements.set(i),this}multiplyScalar(e){let t=this.elements;for(let n=0;n<16;n++)t[n]*=e;return this}determinant(){return this.invertInto(!1)}invert(){return this.invertInto(!0),this}invertInto(e){let t=this.elements,n=t[0],r=t[4],i=t[8],a=t[12],o=t[1],s=t[5],c=t[9],l=t[13],u=t[2],d=t[6],f=t[10],p=t[14],m=t[3],h=t[7],g=t[11],_=t[15],v=n*s-o*r,y=n*c-o*i,b=n*l-o*a,x=r*c-s*i,S=r*l-s*a,C=i*l-c*a,w=u*h-m*d,T=u*g-m*f,E=u*_-m*p,D=d*g-h*f,O=d*_-h*p,k=f*_-g*p,A=v*k-y*O+b*D+x*E-S*T+C*w;if(!e)return A;if(A===0)return t.fill(0),A;let j=1/A;return this.set((s*k-c*O+l*D)*j,(-r*k+i*O-a*D)*j,(h*C-g*S+_*x)*j,(-d*C+f*S-p*x)*j,(-o*k+c*E-l*T)*j,(n*k-i*E+a*T)*j,(-m*C+g*b-_*y)*j,(u*C-f*b+p*y)*j,(o*O-s*E+l*w)*j,(-n*O+r*E-a*w)*j,(m*S-h*b+_*v)*j,(-u*S+d*b-p*v)*j,(-o*D+s*T-c*w)*j,(n*D-r*T+i*w)*j,(-m*x+h*y-g*v)*j,(u*x-d*y+f*v)*j),A}transpose(){let e=this.elements;for(let t=0;t<4;t++)for(let n=t+1;n<4;n++){let r=e[n*4+t];e[n*4+t]=e[t*4+n],e[t*4+n]=r}return this}setPosition(e,t=0,n=0){let r=this.elements;return typeof e==`number`?(r[12]=e,r[13]=t,r[14]=n):(r[12]=e.x,r[13]=e.y,r[14]=e.z),this}makeTranslation(e,t,n){return this.set(1,0,0,e,0,1,0,t,0,0,1,n,0,0,0,1)}makeScale(e,t,n){return this.set(e,0,0,0,0,t,0,0,0,0,n,0,0,0,0,1)}makeRotationX(e){let t=Math.cos(e),n=Math.sin(e);return this.set(1,0,0,0,0,t,-n,0,0,n,t,0,0,0,0,1)}makeRotationY(e){let t=Math.cos(e),n=Math.sin(e);return this.set(t,0,n,0,0,1,0,0,-n,0,t,0,0,0,0,1)}makeRotationZ(e){let t=Math.cos(e),n=Math.sin(e);return this.set(t,-n,0,0,n,t,0,0,0,0,1,0,0,0,0,1)}makeRotationAxis(e,t){let n=Math.cos(t),r=Math.sin(t),i=1-n,{x:a,y:o,z:s}=e;return this.set(i*a*a+n,i*a*o-r*s,i*a*s+r*o,0,i*a*o+r*s,i*o*o+n,i*o*s-r*a,0,i*a*s-r*o,i*o*s+r*a,i*s*s+n,0,0,0,0,1)}makeRotationFromQuaternion(e){return this.composeComponents(0,0,0,e.x,e.y,e.z,e.w,1,1,1)}compose(e,t,n){return this.composeComponents(e.x,e.y,e.z,t.x,t.y,t.z,t.w,n.x,n.y,n.z)}composeComponents(e,t,n,r,i,a,o,s,c,l){let u=2*r*r,d=2*i*i,f=2*a*a,p=2*r*i,m=2*r*a,h=2*i*a,g=2*o*r,_=2*o*i,v=2*o*a;return this.set((1-d-f)*s,(p-v)*c,(m+_)*l,e,(p+v)*s,(1-u-f)*c,(h-g)*l,t,(m-_)*s,(h+g)*c,(1-u-d)*l,n,0,0,0,1)}decompose(e,t,n){let r=this.elements,i=xe??=new Float64Array(16),a=Math.hypot(r[0],r[1],r[2]),o=Math.hypot(r[4],r[5],r[6]),s=Math.hypot(r[8],r[9],r[10]);this.determinant()<0&&(a=-a),e.x=r[12],e.y=r[13],e.z=r[14],n.x=a,n.y=o,n.z=s;for(let e=0;e<3;e++){let t=e===0?a:e===1?o:s;for(let n=0;n<3;n++)i[e*4+n]=t===0?0:r[e*4+n]/t;i[e*4+3]=0}return i[12]=i[13]=i[14]=0,i[15]=1,t.setFromRotationMatrix({elements:i}),this}lookAt(e,t,n){let r=this.elements,i=e.x-t.x,a=e.y-t.y,o=e.z-t.z,s=Math.hypot(i,a,o);s===0?(i=0,a=0,o=1):(i/=s,a/=s,o/=s);let c=n.y*o-n.z*a,l=n.z*i-n.x*o,u=n.x*a-n.y*i;if(c===0&&l===0&&u===0){let e=Math.abs(i),t=Math.abs(a),n=Math.abs(o);e<=t&&e<=n?(c=0,l=-o,u=a):t<=n?(c=o,l=0,u=-i):(c=-a,l=i,u=0)}let d=Math.hypot(c,l,u);return c/=d,l/=d,u/=d,r[0]=c,r[1]=l,r[2]=u,r[4]=a*u-o*l,r[5]=o*c-i*u,r[6]=i*l-a*c,r[8]=i,r[9]=a,r[10]=o,this}makePerspective(e,t,n,r,i,a,o=!0){let s=o?-a/(a-i):-(a+i)/(a-i),c=o?-a*i/(a-i):-2*a*i/(a-i);return this.set(2*i/(t-e),0,(t+e)/(t-e),0,0,2*i/(n-r),(n+r)/(n-r),0,0,0,s,c,0,0,-1,0)}makeOrthographic(e,t,n,r,i,a,o=!0){let s=1/(t-e),c=1/(n-r),l=1/(a-i);return this.set(2*s,0,0,-(t+e)*s,0,2*c,0,-(n+r)*c,0,0,o?-l:-2*l,o?-i*l:-(a+i)*l,0,0,0,1)}getMaxScaleOnAxis(){let e=this.elements;return Math.sqrt(Math.max(e[0]*e[0]+e[1]*e[1]+e[2]*e[2],e[4]*e[4]+e[5]*e[5]+e[6]*e[6],e[8]*e[8]+e[9]*e[9]+e[10]*e[10]))}equals(e,t=0){for(let n=0;n<16;n++)if(!(Math.abs(this.elements[n]-e.elements[n])<=t))return!1;return!0}fromArray(e,t=0){for(let n=0;n<16;n++)this.elements[n]=e[t+n];return this}toArray(e=[],t=0){for(let n=0;n<16;n++)e[t+n]=this.elements[n];return e}};function Ce(e,t=1e-5){if(!e||!(e.length>=16))throw TypeError(`decomposeAffine needs 16 column-major numbers, such as Matrix4.elements`);if(!(t>=0&&t<1/0))throw RangeError(`decomposeAffine tolerance ${t} is invalid; pass a finite number >= 0, e.g. 1e-5`);let n=new Se().fromArray(e),r=n.elements,i={x:0,y:0,z:0},a={x:0,y:0,z:0},o=new be;n.decompose(i,o,a),o.normalize();let s=new Se().compose(i,o,a).elements,c=0;for(let e=0;e<16;e++){let t=Math.abs(s[e]-r[e]);c=t===t&&t!==1/0?Math.max(c,t):1/0}let l=e=>[r[4*e],r[4*e+1],r[4*e+2]],u=(e,t)=>e[0]*t[0]+e[1]*t[1]+e[2]*t[2],d=(e,t,n)=>e.map((e,r)=>e-n*t[r]),f=e=>e.map(t=>t/Math.hypot(e[0],e[1],e[2])),p=l(0),m=l(1),h=l(2),g=f(p),_=u(g,m),v=d(m,g,_),y=f(v),b=u(g,h),x=u(y,h),S=d(d(h,g,b),y,x),C=Math.hypot(v[0],v[1],v[2]),w=Math.hypot(S[0],S[1],S[2]),T=p[0]*(m[1]*h[2]-m[2]*h[1])-p[1]*(m[0]*h[2]-m[2]*h[0])+p[2]*(m[0]*h[1]-m[1]*h[0]);return{translation:[i.x,i.y,i.z],rotation:o.toArray(),scale:[a.x,a.y,a.z],shear:[C>0?_/C:NaN,w>0?b/w:NaN,w>0?x/w:NaN],handedness:T>0?`right`:T<0?`left`:`degenerate`,projective:r[3]!==0||r[7]!==0||r[11]!==0||r[15]!==1,error:c,lossless:c<=t}}function we(e,t,n,r){if(!(r>=0&&r<1))throw RangeError(`Quaternion linearAbove ${r} is invalid; pass a dot from 0 to below 1, e.g. 0.9995`);let i=e[0]*t[0]+e[1]*t[1]+e[2]*t[2]+e[3]*t[3],a=1;i<0&&(a=-1,i=-i),i=Math.min(1,i);let o=[0,0,0,0];if(i>r)for(let r=0;r<4;r++)o[r]=e[r]+(t[r]*a-e[r])*n;else{let r=Math.acos(i),s=Math.sin(r),c=Math.sin((1-n)*r)/s,l=Math.sin(n*r)/s;for(let n=0;n<4;n++)o[n]=e[n]*c+t[n]*a*l}let s=Math.hypot(o[0],o[1],o[2],o[3]);for(let e=0;e<4;e++)o[e]/=s;return o}var Te=2**-15,Ee=1e-5,De=.9995,Oe=(e,t,n)=>{throw RangeError(`VoxelPathTracer ${e} motion interval ${t}; pass a ${n} that stays invertible, or motionInterpolation 'trs' for rotations`)},ke=[0,1,2,4,5,6,8,9,10],Ae=(e,t,n)=>e[0]*(t[1]*n[2]-t[2]*n[1])-t[0]*(e[1]*n[2]-e[2]*n[1])+n[0]*(e[1]*t[2]-e[2]*t[1]),je=e=>Math.max(...ke.map(t=>Math.abs(e[t]))),Me=(e,t)=>[0,1,2].map(n=>[e[n]/t,e[4+n]/t,e[8+n]/t]),Ne=e=>Float64Array.from([e[0],e[4],e[8],0,e[1],e[5],e[9],0,e[2],e[6],e[10],0,e[3],e[7],e[11],1]);function Pe(e,t,n,r){let i=Math.max(je(e),je(t));i>0||Oe(n,`is singular`,r);let a=Me(e,i),o=Me(t,i).map((e,t)=>e.map((e,n)=>e-a[t][n])),s=Ae(a[0],a[1],a[2]),c=Ae(o[0],a[1],a[2])+Ae(a[0],o[1],a[2])+Ae(a[0],a[1],o[2]),l=Ae(o[0],o[1],a[2])+Ae(o[0],a[1],o[2])+Ae(a[0],o[1],o[2]),u=Ae(o[0],o[1],o[2]),d=[0,1],f=3*u,p=2*l;if(f===0)p!==0&&d.push(-c/p);else{let e=p*p-4*f*c;e>=0&&d.push((-p+Math.sqrt(e))/(2*f),(-p-Math.sqrt(e))/(2*f))}let m=Math.sign(s);for(let e of d)e>=0&&e<=1&&!(m*(((u*e+l)*e+c)*e+s)>Te)&&Oe(n,`becomes singular between the two transforms`,r)}function Fe(e,t,n){let r=je(e),i=Ne(e);r>0||Oe(t,`has a singular endpoint`,n);for(let e of ke)i[e]/=r;i[12]=i[13]=i[14]=0;let a=Ce(i,Ee);(!a.lossless||a.shear.some(e=>!(Math.abs(e)<=Ee)))&&Oe(t,`has shear, which motionInterpolation 'trs' does not support`,n);let o=a.scale.map(e=>e*r),s=a.rotation.slice(),c=me([0,0,0],s,o,new Float64Array(16)),l=Ne(e);for(let e of ke)Math.abs(c[e]-l[e])<=Ee*r||Oe(t,`is not a rotation and scale`,n);return{q:s,scale:o}}function Ie(e,t,n,r,i,a=[0,0,0],o=`previousMatrix`){let s=new Float64Array([1/0,1/0,1/0,-1/0,-1/0,-1/0]),c;if(r===`trs`){let r=Fe(e,i,o),l=Fe(t,i,o);r.scale.some((e,t)=>Math.sign(e)!==Math.sign(l.scale[t]))&&Oe(i,`changes handedness`,o);let u=we(r.q,r.q,0,De),d=we(u,l.q,1,De),f=Math.max(0,Math.min(1,u.reduce((e,t,n)=>e+t*d[n],0))),p=Math.acos(f);c=new Float32Array(16),c.set(u,0),c.set(d,4),c.set(r.scale,8),c.set(l.scale,12),c[11]=p,c[15]=f>De?0:1/Math.sin(p),c.every(Number.isFinite)||Oe(i,`is out of Float32 range`,o);let m=Math.hypot(...n.map((e,t)=>Math.max(Math.abs(a[t]),Math.abs(a[t]+e))*Math.max(Math.abs(r.scale[t]),Math.abs(l.scale[t]))));for(let n=0;n<3;n++)s[n]=Math.min(e[n*4+3],t[n*4+3])-m,s[n+3]=Math.max(e[n*4+3],t[n*4+3])+m}else Pe(e,t,i,o);for(let r of[e,t])for(let e=0;e<8;e++)for(let t=0;t<3;t++){let i=t*4,o=r[i]*(a[0]+(e&1?n[0]:0))+r[i+1]*(a[1]+(e&2?n[1]:0))+r[i+2]*(a[2]+(e&4?n[2]:0))+r[i+3];s[t]=Math.min(s[t],o),s[t+3]=Math.max(s[t+3],o)}for(let e=0;e<3;e++){let t=2**-16*Math.max(1,Math.abs(s[e]),Math.abs(s[e+3]));s[e]-=t,s[e+3]+=t}return{payload:c,bounds:s}}function Le(e,t,n){let r=Math.hypot(e[0],e[1],e[2]),i=[e[0]/r,e[1]/r,e[2]/r],a=t??(Math.abs(i[1])>.999?[0,0,1]:[0,1,0]),o=[a[1]*i[2]-a[2]*i[1],a[2]*i[0]-a[0]*i[2],a[0]*i[1]-a[1]*i[0]],s=Math.hypot(o[0],o[1],o[2]);if(!(s>1e-6*Math.hypot(a[0],a[1],a[2])))throw RangeError(`${n} up is parallel to its direction; pass another up vector`);let c=[o[0]/s,o[1]/s,o[2]/s];return{normal:i,right:c,up:[i[1]*c[2]-i[2]*c[1],i[2]*c[0]-i[0]*c[2],i[0]*c[1]-i[1]*c[0]]}}var Re=1024,ze=e=>[[.1787*e-1.463,-.3554*e+.4275,-.0227*e+5.3251,.1206*e-2.5771,-.067*e+.3703],[-.0193*e-.2592,-.0665*e+8e-4,-4e-4*e+.2125,-.0641*e-.8989,-.0033*e+.0452],[-.0167*e-.2608,-.095*e+.0092,-.0079*e+.2102,-.0441*e-1.6537,-.0109*e+.0529]],Be=([e,t,n,r,i],a,o)=>(1+e*Math.exp(t/Math.max(Math.cos(a),1e-4)))*(1+n*Math.exp(r*o)+i*Math.cos(o)**2),Ve=(e,t,n)=>{let r=[t*t*t,t*t,t,1],i=e=>n[e*4]*r[0]+n[e*4+1]*r[1]+n[e*4+2]*r[2]+n[e*4+3]*r[3];return e*e*i(0)+e*i(1)+i(2)},He=[.00166,-.00375,.00209,0,-.02903,.06377,-.03202,.00394,.11693,-.21196,.06052,.25886],Ue=[.00275,-.0061,.00317,0,-.04214,.0897,-.04153,.00516,.15346,-.26756,.0667,.26688];function We(e,t,n,r=!1){let i=Math.max(2,e),a=Math.acos(Math.min(1,Math.max(0,t[1]))),o=Math.hypot(t[0],t[2]),s=t[1]>=0?t:o>0?[t[0]/o,0,t[2]/o]:[0,1,0],[c,l,u]=ze(i),d=(4/9-i/120)*(Math.PI-2*a),f=(4.0453*i-4.971)*Math.tan(d)-.2155*i+2.4192,p=Ve(i,a,He),m=Ve(i,a,Ue),h=Be(c,0,a),g=Be(l,0,a),_=Be(u,0,a),v=new Float32Array(Re*512*3);for(let e=0;e<512;e++){let t=Math.PI*(e+.5)/512;if(t>=Math.PI/2)break;let r=Math.sin(t),i=Math.cos(t);for(let a=0;a<Re;a++){let o=((a+.5)/Re-.5)*2*Math.PI,d=[r*Math.sin(o),i,-r*Math.cos(o)],y=Math.acos(Math.min(1,Math.max(-1,d[0]*s[0]+d[1]*s[1]+d[2]*s[2]))),b=f*Be(c,t,y)/h,x=p*Be(l,t,y)/g,S=Math.max(-3*x*x+2.87*x-.275,m*Be(u,t,y)/_);if(!(b>0&&S>0))continue;let C=x*b/S,w=(1-x-S)*b/S,T=(e*Re+a)*3;v[T]=Math.max(0,3.2406*C-1.5372*b-.4986*w)*n,v[T+1]=Math.max(0,-.9689*C+1.8758*b+.0415*w)*n,v[T+2]=Math.max(0,.0557*C-.204*b+1.057*w)*n}}if(r){let e=Re*3,t=255*e;for(let n=256;n<512;n++)v.copyWithin(n*e,t,786432)}return v}var Ge=.5876,Ke=.4861,qe=.6563;function Je(e,t){return t>0?(e-1)/(t*(1/(Ke*Ke)-1/(qe*qe))):0}var Ye=[[[.362,442,.0624,.0374],[1.056,599.8,.0264,.0323],[-.065,501.1,.049,.0382]],[[.821,568.8,.0213,.0247],[.286,530.9,.0613,.0322]],[[1.217,437,.0845,.0278],[.681,459,.0385,.0725]]],Xe=e=>Ye.map(t=>t.reduce((t,[n,r,i,a])=>{let o=(e-r)*(e<r?i:a);return t+n*Math.exp(-.5*o*o)},0)),Ze=e=>e.map(([e,t,n,r])=>`${e}*cmfLobe(l,${G(t)},${n},${r})`).join(`+`),W=[3.2406,-1.5372,-.4986,-.9689,1.8758,.0415,.0557,-.204,1.057],Qe=e=>{let[t,n,r]=Xe(e);return[0,1,2].map(e=>W[e*3]*t+W[e*3+1]*n+W[e*3+2]*r)},$e=(()=>{let e=[0,0,0],t=.05;for(let n=380.025;n<780;n+=t){let r=Qe(n);for(let n=0;n<3;n++)e[n]+=r[n]*t}return e})(),et=.25,tt=550,G=e=>Number.isInteger(e)?`${e}.0`:`${e}`,nt=`
const LAMBDA_MIN=${G(380)};
const LAMBDA_MAX=${G(780)};
const LAMBDA_D=${Ge};
fn cmfLobe(x:f32,mu:f32,k1:f32,k2:f32)->f32 {let t=(x-mu)*select(k2,k1,x<mu);return exp(-0.5*t*t);}
fn spectralRgb(l:f32)->vec3f {
 let x=${Ze(Ye[0])};
 let y=${Ze(Ye[1])};
 let z=${Ze(Ye[2])};
 let rgb=vec3f(${W[0]}*x+${W[1]}*y+${W[2]}*z,${W[3]}*x+${W[4]}*y+${W[5]}*z,${W[6]}*x+${W[7]}*y+${W[8]}*z);
 return rgb/vec3f(${$e.map(e=>e.toPrecision(9)).join(`,`)});
}
fn lambdaPdf(l:f32)->f32 {
 let ta=tanh((LAMBDA_MIN-${G(tt)})/${G(56)});let tb=tanh((LAMBDA_MAX-${G(tt)})/${G(56)});
 let t=tanh((l-${G(tt)})/${G(56)});
 return ${et}/(LAMBDA_MAX-LAMBDA_MIN)+0.75*(1.0-t*t)/(${G(56)}*(tb-ta));
}

fn sampleLambda(u:vec2f)->vec2f {
 var l:f32;
 if(u.x<${et}){l=mix(LAMBDA_MIN,LAMBDA_MAX,u.y);}
 else{
  let ta=tanh((LAMBDA_MIN-${G(tt)})/${G(56)});let tb=tanh((LAMBDA_MAX-${G(tt)})/${G(56)});
  l=clamp(${G(tt)}+${G(56)}*atanh(clamp(mix(ta,tb,u.y),-0.999999,0.999999)),LAMBDA_MIN,LAMBDA_MAX);
 }
 return vec2f(l,lambdaPdf(l));
}
`,K=8,rt=2147483648,it=1073741824,at=65535,ot=256,st=4096,ct=2048,lt=4096,ut=1024,dt=2048,ft=8,pt=2,mt=16,ht=.001,gt=.1,_t=[`diffuse`,`plastic`,`metal`,`glass`,`emit`,`blend`,`media`],q=`VoxelPathTracer`,J=e=>typeof e==`object`&&!!e;function Y(e,t,n,r,i){if(typeof e!=`number`||Number.isNaN(e))throw TypeError(`${q} ${t} must be a number; ${i}`);if(!(e>=n&&e<=r))throw RangeError(`${q} ${t} ${e} is outside ${n} to ${r}; ${i}`);return e}var X=(e,t,n,r,i,a)=>e===void 0?t:Y(e,n,r,i,a);function Z(e,t,n,r){if(!Array.isArray(e)&&!ArrayBuffer.isView(e))throw TypeError(`${q} ${t} must be an array of 3 numbers; ${r}`);let i=e;if(i.length!==3||![0,1,2].every(e=>typeof i[e]==`number`))throw TypeError(`${q} ${t} must be an array of 3 numbers; ${r}`);let a=[i[0],i[1],i[2]];if(!a.every(Number.isFinite)||n&&a.some(e=>e<0))throw RangeError(`${q} ${t} [${a}] must be finite${n?` and 0 or more`:``}; ${r}`);return a}var vt=(e,t)=>{if(typeof e!=`string`||!e)throw TypeError(`${q} ${t} must be a non-empty string id`);return e},yt=(e,t)=>{if(!Array.isArray(e))throw TypeError(`${q} scene.${t} must be an array`);return e};function bt(e,t){if(!Array.isArray(e)&&!ArrayBuffer.isView(e)||e.length!==16)throw TypeError(`${q} ${t} must be 16 numbers (a column-major 4x4 matrix)`);let n=e;for(let e=0;e<16;e++)if(typeof n[e]!=`number`)throw TypeError(`${q} ${t} must be 16 numbers (a column-major 4x4 matrix)`);let r=n;for(let e=0;e<16;e++)if(!Number.isFinite(r[e]))throw RangeError(`${q} ${t}[${e}] ${r[e]} is not finite; pass finite numbers`);if(Math.abs(r[3])>1e-9||Math.abs(r[7])>1e-9||Math.abs(r[11])>1e-9||Math.abs(r[15]-1)>1e-9)throw RangeError(`${q} ${t} is not affine (its last row must be 0, 0, 0, 1); pass a model-to-world transform`);let i=new Float64Array(12);for(let e=0;e<3;e++)for(let t=0;t<4;t++)i[e*4+t]=r[t*4+e];let a=xt(i),o=Math.max(...[0,1,2].map(e=>Math.hypot(i[e],i[4+e],i[8+e])));if(!(Math.abs(a)>1e-12*o*o*o)||!Number.isFinite(a))throw RangeError(`${q} ${t} is singular (determinant ${a}); pass an invertible transform`);return i}var xt=e=>e[0]*(e[5]*e[10]-e[6]*e[9])-e[1]*(e[4]*e[10]-e[6]*e[8])+e[2]*(e[4]*e[9]-e[5]*e[8]);function St(e){let t=xt(e),n=new Float64Array(12),r=[e[0],e[1],e[2]],i=[e[4],e[5],e[6]],a=[e[8],e[9],e[10]],o=(e,t)=>[e[1]*t[2]-e[2]*t[1],e[2]*t[0]-e[0]*t[2],e[0]*t[1]-e[1]*t[0]],s=o(i,a),c=o(a,r),l=o(r,i);for(let e=0;e<3;e++)n[e*4]=s[e]/t,n[e*4+1]=c[e]/t,n[e*4+2]=l[e]/t;for(let t=0;t<3;t++)n[t*4+3]=-(n[t*4]*e[3]+n[t*4+1]*e[7]+n[t*4+2]*e[11]);return n}function Ct(e,t){return e.blocks===void 0?e.voxels instanceof Uint8Array&&e.voxels.length===t[0]*t[1]*t[2]:Array.isArray(e.blocks)&&e.voxels===void 0}function wt(e,t,n){let r=Z(e.size,`${t}.size`,!0,`pass integer dimensions 1 to ${ct}`);if(!r.every(e=>Number.isInteger(e)&&e>=1&&e<=ct))throw RangeError(`${q} ${t}.size [${r}] must be integers 1 to ${ct}; pass the model's voxel dimensions`);if(typeof e.revision!=`number`||!Number.isFinite(e.revision))throw TypeError(`${q} ${t}.revision must be a finite number; bump it when the voxels change`);let[i,a,o]=r,s=Math.ceil(i/K),c=Math.ceil(a/K),l=Math.ceil(o/K);if(s*c*l+4>n)throw RangeError(`${q} ${t} of ${i}x${a}x${o} needs a ${s*c*l*4}-byte brick grid; this device binds at most ${n*4}; split it into smaller models`);if(e.blocks!==void 0){if(e.voxels!==void 0)throw TypeError(`${q} ${t} has both voxels and blocks; pass one of them`);if(!Array.isArray(e.blocks))throw TypeError(`${q} ${t}.blocks must be an array of {origin, size, voxels}`);return Dt(e,t,[i,a,o])}let u=e.voxels;if(!(u instanceof Uint8Array))throw TypeError(`${q} ${t}.voxels must be a Uint8Array of palette indices (or pass blocks)`);if(u.length!==i*a*o)throw TypeError(`${q} ${t}.voxels has ${u.length} entries; a ${i}x${a}x${o} model needs ${i*a*o} (index = x + sx * (z + sz * y))`);let d=Et(e.shapes,u.length,t),f=new Uint32Array(s*c*l),p=new Uint32Array(256),m=new Uint8Array(512),h=new Uint8Array(512),g=new Uint32Array(128*Math.min(f.length,64)),_=0;for(let e=0;e<c;e++)for(let t=0;t<l;t++)for(let n=0;n<s;n++){let r=n*K,c=e*K,v=t*K,y=Math.min(K,i-r),b=Math.min(K,a-c),x=Math.min(K,o-v),S=y<K||b<K||x<K;S&&(m.fill(0),h.fill(0));let C=-1,w=!S,T=!1;for(let e=0;e<b;e++)for(let t=0;t<x;t++){let n=r+i*(v+t+o*(c+e)),a=8*(t+8*e);for(let e=0;e<y;e++){let t=u[n+e],r=t&&d?d[n+e]%255:0;m[a+e]=t,h[a+e]=r,r&&(T=!0),p[t]++,C<0?C=t:t!==C&&(w=!1)}}T&&(w=!1);let E=n+s*(t+l*e);if(S&&C===0){let e=!0;for(let t=0;t<m.length&&e;t++)e=m[t]===0;if(e)continue}w?f[E]=C===0?0:(rt|C)>>>0:(g=Tt(g,_+(T?2:1),f.length*2),new Uint8Array(g.buffer,_*128*4,512).set(m),f[E]=T?(it|++_)>>>0:++_,T&&new Uint8Array(g.buffer,_++*128*4,512).set(h))}return p[0]=0,{id:e.id,revision:e.revision,key:e.contentKey,size:[i,a,o],bricks:[s,c,l],grid:f,payload:g.slice(0,_*128),counts:p}}function Tt(e,t,n){if(t*128<=e.length)return e;let r=new Uint32Array(Math.min(n,Math.max(t,e.length/128*2+1))*128);return r.set(e),r}function Et(e,t,n){if(e!==void 0){if(!(e instanceof Uint8Array))throw TypeError(`${q} ${n}.shapes must be a Uint8Array of octant masks (0 for whole cells)`);if(e.length!==t)throw TypeError(`${q} ${n}.shapes has ${e.length} entries; it needs one per cell (${t})`);return e}}function Dt(e,t,n){let[r,i,a]=n,o=Math.ceil(r/K),s=Math.ceil(i/K),c=Math.ceil(a/K),l=new Map,u=new Map;for(let[s,d]of e.blocks.entries()){let e=`${t}.blocks[${s}]`;if(!J(d))throw TypeError(`${q} ${e} must be {origin, size, voxels}`);let f=Z(d.origin,`${e}.origin`,!0,`pass integer cell coordinates inside the model`),p=Z(d.size,`${e}.size`,!0,`pass integer dimensions of 1 or more`);if(!f.every(Number.isInteger)||!p.every(e=>Number.isInteger(e)&&e>=1))throw RangeError(`${q} ${e} origin and size must be whole numbers (size 1 or more)`);if(f.some((e,t)=>e+p[t]>n[t]))throw RangeError(`${q} ${e} spans [${f}] to [${f.map((e,t)=>e+p[t])}], outside the ${r}x${i}x${a} model; move or crop it`);let m=d.voxels;if(!(m instanceof Uint8Array))throw TypeError(`${q} ${e}.voxels must be a Uint8Array of palette indices`);if(m.length!==p[0]*p[1]*p[2])throw TypeError(`${q} ${e}.voxels has ${m.length} entries; a ${p[0]}x${p[1]}x${p[2]} block needs ${p[0]*p[1]*p[2]} (index = x + sx * (z + sz * y))`);let h=Et(d.shapes,m.length,e);for(let e=0;e<p[1];e++)for(let t=0;t<p[2];t++){let n=f[1]+e,r=f[2]+t,i=p[0]*(t+p[2]*e);for(let e=0;e<p[0];e++){let t=f[0]+e,a=(t>>3)+o*((r>>3)+c*(n>>3)),s=l.get(a);s||l.set(a,s=new Uint8Array(512));let d=(t&7)+8*((r&7)+8*(n&7)),p=h&&m[i+e]?h[i+e]%255:0;s[d]=m[i+e];let g=u.get(a);p&&!g&&u.set(a,g=new Uint8Array(512)),g&&(g[d]=p)}}}let d=new Uint32Array(o*s*c),f=new Uint32Array(256),p=[...l.keys()].sort((e,t)=>e-t),m=new Uint32Array(128*Math.min(p.length,64)),h=0;for(let e of p){let t=l.get(e),n=e%o,s=Math.floor(e/o)%c,g=Math.floor(e/(o*c)),_=n*8+8>r||g*8+8>i||s*8+8>a,v=u.get(e)?.some(Boolean)?u.get(e):void 0,y=t[0],b=!_&&!v;for(let e=0;e<t.length;e++)f[t[e]]++,t[e]!==y&&(b=!1);b?d[e]=y===0?0:(rt|y)>>>0:t.every(e=>e===0)||(m=Tt(m,h+(v?2:1),p.length*2),new Uint8Array(m.buffer,h*128*4,512).set(t),d[e]=v?(1073741824|++h)>>>0:++h,v&&new Uint8Array(m.buffer,h++*128*4,512).set(v))}return f[0]=0,{id:e.id,revision:e.revision,key:e.contentKey,size:[r,i,a],bricks:[o,s,c],grid:d,payload:m.slice(0,h*128),counts:f}}function Ot(e,t,n,r){if(t<0||n<0||r<0||t>=e.size[0]||n>=e.size[1]||r>=e.size[2])return 0;let[i,,a]=e.bricks,o=e.grid[(t>>3)+i*((r>>3)+a*(n>>3))];if(o===0)return 0;if(o>=2147483648)return o&255;let s=(t&7)+8*((r&7)+8*(n&7));return e.payload[((o&-1073741825)-1)*128+(s>>2)]>>>(s&3)*8&255}function kt(e,t,n,r){if(t<0||n<0||r<0||t>=e.size[0]||n>=e.size[1]||r>=e.size[2])return 0;let i=e.grid[(t>>3)+e.bricks[0]*((r>>3)+e.bricks[2]*(n>>3))];if(i>=2147483648||!(i&1073741824))return 0;let a=(t&7)+8*((r&7)+8*(n&7));return e.payload[(i&-1073741825)*128+(a>>2)]>>>(a&3)*8&255}var At=(e,t,n)=>.2126*e+.7152*t+.0722*n;function jt(e){if(e===void 0)return[];let t=yt(e,`textures`);if(t.length>st)throw RangeError(`${q} scene.textures has ${t.length}; at most ${st} are supported`);return t.map((e,t)=>{let n=`scene.textures[${t}]`;if(!J(e))throw TypeError(`${q} ${n} must be an object {width, height, data}`);for(let t of[`width`,`height`]){if(typeof e[t]!=`number`||!Number.isInteger(e[t]))throw TypeError(`${q} ${n}.${t} must be an integer number of texels`);if(e[t]<1||e[t]>1024)throw RangeError(`${q} ${n}.${t} ${e[t]} is outside 1 to 1024; use a size from 1 to 1024`)}if(!(e.data instanceof Uint8Array||e.data instanceof Uint8ClampedArray))throw TypeError(`${q} ${n}.data must be a Uint8Array of RGBA bytes`);if(e.data.length!==e.width*e.height*4)throw TypeError(`${q} ${n}.data has ${e.data.length} bytes; pass width x height x 4 = ${e.width*e.height*4}`);let r=new Uint32Array(e.width*e.height);for(let t=0;t<r.length;t++)r[t]=(e.data[4*t]|e.data[4*t+1]<<8|e.data[4*t+2]<<16|e.data[4*t+3]<<24)>>>0;return{width:e.width,height:e.height,texels:r}})}function Mt(e,t,n){if(!J(e))throw TypeError(`${q} ${t} must be an object {id, color, type}`);if(typeof e.id!=`number`||!Number.isInteger(e.id))throw TypeError(`${q} ${t}.id must be an integer palette index 1 to 255`);if(e.id<1||e.id>255)throw RangeError(`${q} ${t}.id ${e.id} is outside 1 to 255 (0 is empty); use an id from 1 to 255`);if(!_t.includes(e.type))throw TypeError(`${q} ${t}.type ${String(e.type)} is unknown; pass one of ${_t.join(`, `)}`);let r=Z(e.color,`${t}.color`,!0,`pass linear RGB, 0 or more`),i=e.emissionColor===void 0?r:Z(e.emissionColor,`${t}.emissionColor`,!0,`pass linear RGB, 0 or more`),a=e.type,o=(e,n,r)=>X(e,n,`${t}.${r}`,0,1,`pass 0 to 1`),s=o(e.roughness,a===`glass`?0:.2,`roughness`),c=o(e.metalness,+(a===`metal`),`metalness`),l=o(e.transmission,+(a===`glass`),`transmission`),u=o(e.specular,a===`diffuse`||a===`emit`?0:1,`specular`),d=X(e.emission,+(a===`emit`),`${t}.emission`,0,1e6,`pass 0 or more`),f=X(e.cameraEmission,d,`${t}.cameraEmission`,0,1e6,`pass 0 or more`),p=X(e.ior,1.5,`${t}.ior`,1,3,`pass 1 to 3 (glass is about 1.5)`),m=X(e.density,+(a===`media`),`${t}.density`,0,1e6,`pass 0 or more per world unit`),h=X(e.scatter,0,`${t}.scatter`,0,1e6,`pass 0 or more per world unit`),g=X(e.anisotropy,0,`${t}.anisotropy`,-.95,.95,`pass -0.95 to 0.95`),_=X(e.abbe,0,`${t}.abbe`,0,200,`pass 0 (no dispersion) or an Abbe number of 5 to 200`),v=X(e.cutout,0,`${t}.cutout`,0,1,`pass an alpha threshold 0 to 1 (0: none)`),y=e.metalColor===void 0?r:Z(e.metalColor,`${t}.metalColor`,!0,`pass linear RGB, each 0 to 1`);if(e.coat!==void 0&&e.coat!==`layered`&&e.coat!==`additive`)throw TypeError(`${q} ${t}.coat ${String(e.coat)} is unknown; pass 'layered' or 'additive'`);let b=(e,n)=>{if(e!==void 0&&typeof e!=`boolean`)throw TypeError(`${q} ${t}.${n} must be true or false`);return e===!0},x=e.tint===void 0||b(e.tint,`tint`),S=b(e.voxelwise,`voxelwise`),C=b(e.sunlit,`sunlit`),w=b(e.subsurface,`subsurface`),T=b(e.contactTransmission,`contactTransmission`),E=e.texture===void 0?void 0:typeof e.texture==`number`?[,,,,,,].fill(e.texture):e.texture;if(E!==void 0){if(!Array.isArray(E)||E.length!==6||!E.every(e=>typeof e==`number`&&Number.isInteger(e)))throw TypeError(`${q} ${t}.texture must be a texture index or six (+x, -x, +y, -y, +z, -z) into scene.textures`);for(let e of E)if(e<0||n!==void 0&&e>=n)throw RangeError(`${q} ${t}.texture ${e} is not an index into scene.textures; use an index below the texture count${n===void 0?``:` (${n})`}`)}if(_>0&&_<5)throw RangeError(`${q} ${t}.abbe ${_} is out of range; pass 0 (no dispersion) or 5 to 200`);return{id:e.id,color:r,type:a,roughness:s,metalness:c,emission:d,emissionColor:i,cameraEmission:f,sunlit:C,subsurface:w,voxelwise:S,contactTransmission:T,...E===void 0?{}:{texture:E},cutout:v,ior:p,transmission:l,density:m,specular:u,scatter:h,anisotropy:g,abbe:_,metalColor:y,coat:e.coat??`layered`,tint:x}}function Nt(e,t,n,r){let i=Mt(e,t,r),{type:a,color:o,emissionColor:s,roughness:c,metalness:l,transmission:u,specular:d,emission:f,ior:p,density:m,scatter:h,anisotropy:g,abbe:_,cutout:v,metalColor:y}=i,b=e.cameraEmission===void 0?-1:i.cameraEmission,x=i.texture,S=i.id*32,C=c*c,w=a===`media`,T=w?0:l,E=w?0:(1-l)*u,D=mt;w&&(D|=1),E>0&&(D|=pt),!w&&f>0&&At(s[0],s[1],s[2])*f>0&&(D|=4),C<.001&&(D|=8),i.coat===`additive`&&(D|=32),i.tint||(D|=64),i.sunlit&&w&&!i.subsurface&&(D|=128),i.subsurface&&w&&(D|=dt);let O=i.subsurface&&w?Pt(o):y;i.voxelwise&&E>0&&E<1&&(D|=256),i.contactTransmission&&E>0&&E<1&&(D|=512),v>0&&x!==void 0&&!w&&(D|=ut),n.set([Math.min(o[0],1),Math.min(o[1],1),Math.min(o[2],1),C,T,E,w?0:d,((p-1)/(p+1))**2,s[0]*f,s[1]*f,s[2]*f,p,m,h,g,D,E>0?Je(p,_):0,Math.min(O[0],1),Math.min(O[1],1),Math.min(O[2],1),b>=0&&!w?s[0]*b:0,b>=0&&!w?s[1]*b:0,b>=0&&!w?s[2]*b:0,+(b>=0&&!w),...(x??[,,,,,,].fill(-1)).map(e=>e+1),v,0],S)}function Pt(e){let t=e=>{let t=Math.min(Math.max(e,0),1);return 1-Math.exp(t*(-5.09406+t*(2.61188-4.31805*t)))};return[t(e[0]),t(e[1]),t(e[2])]}function Ft(e,t,n){let r=``,i=``;for(let n=1;n<256;n++){let a=t[n*32+15];e.counts[n]&&a&4&&(r+=`${n},`),a&3&&(i+=`${n},`)}if(!r)return;let a=`${r}|${i}`,o=n.emitters.get(e);if(o?.key===a)return o;let s=new Uint8Array(256),c=new Uint8Array(256);s[0]=1;for(let e=1;e<256;e++){let n=t[e*32+15];n&3&&(s[e]=1),n&4&&(c[e]=1)}let l=[],u=[],[d,f,p]=e.size,[m,h,g]=e.bricks,_=[[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];for(let t=0;t<h;t++)for(let n=0;n<g;n++)for(let r=0;r<m;r++){let i=e.grid[r+m*(n+g*t)];if(!(!i||i>=2147483648&&!c[i&255]))for(let i=t*8;i<Math.min(t*8+8,f);i++)for(let t=n*8;t<Math.min(n*8+8,p);t++)for(let n=r*8;n<Math.min(r*8+8,d);n++){let r=Ot(e,n,i,t);if(!c[r])continue;let a=kt(e,n,i,t)||255;for(let o=0;o<6;o++){let c=_[o],d=n+c[0],f=i+c[1],p=t+c[2];if(a===255&&s[Ot(e,d,f,p)]){l.push((n|i<<16)>>>0,(t|o<<16)>>>0),u.push(r);continue}let m=o>>1,h=1<<m,g=o&1?0:h,v=h^g,y=1<<(m+1)%3,b=1<<(m+2)%3,x=s[Ot(e,d,f,p)]?0:kt(e,d,f,p)||255;for(let e=0;e<4;e++){let s=(e&1?y:0)|(e&2?b:0),c=(t|o<<16|1<<19|(e&3)<<21)>>>0;if(a>>(s|g)&1){if(x>>(s|v)&1)continue;l.push((n|i<<16)>>>0,c)}else if(a>>(s|v)&1)l.push((n|i<<16)>>>0,(c|1<<20)>>>0);else continue;u.push(r)}}}}let v={key:a,faces:Uint32Array.from(l),ids:Uint8Array.from(u)};return n.emitters.set(e,v),v}function It(e){let t=t=>[e[t],e[4+t],e[8+t]],n=(e,t)=>Math.hypot(e[1]*t[2]-e[2]*t[1],e[2]*t[0]-e[0]*t[2],e[0]*t[1]-e[1]*t[0]),r=t(0),i=t(1),a=t(2);return[n(i,a),n(a,r),n(r,i)]}function Lt(e,t,n){for(let r=0;r<8;r++){let i=[r&1?n[0]:0,r&2?n[1]:0,r&4?n[2]:0];for(let n=0;n<3;n++){let r=t[n*4]*i[0]+t[n*4+1]*i[1]+t[n*4+2]*i[2]+t[n*4+3];e[n]=Math.min(e[n],r),e[n+3]=Math.max(e[n+3],r)}}}function Rt(e,t){let n=new Int32Array(t).map((e,t)=>t),r=[],i=new Float32Array(1),a=new Uint32Array(i.buffer),o=e=>(i[0]=e,a[0]);if(!t)return{nodes:new Uint32Array,order:n};let s=(t,n)=>(e[t*6+n]+e[t*6+n+3])/2,c=e=>{let t=e[3]-e[0],n=e[4]-e[1],r=e[5]-e[2];return t>0||n>0||r>0?2*(t*n+n*r+r*t):0},l=()=>[1/0,1/0,1/0,-1/0,-1/0,-1/0],u=(t,n)=>{for(let r=0;r<3;r++)t[r]=Math.min(t[r],e[n*6+r]),t[r+3]=Math.max(t[r+3],e[n*6+r+3])},d=[[0,0,t,0]];for(r.push(0,0,0,0,0,0,0,0);d.length;){let[e,t,i,a]=d.pop(),f=l();for(let e=t;e<i;e++)u(f,n[e]);let p=(t,n)=>{let i=e*8;r[i]=o(f[0]),r[i+1]=o(f[1]),r[i+2]=o(f[2]),r[i+3]=t,r[i+4]=o(f[3]),r[i+5]=o(f[4]),r[i+6]=o(f[5]),r[i+7]=n},m=i-t;if(m<=2){p(t,m);continue}let h=l();for(let e=t;e<i;e++)for(let t=0;t<3;t++){let r=s(n[e],t);h[t]=Math.min(h[t],r),h[t+3]=Math.max(h[t+3],r)}let g=0;for(let e=1;e<3;e++)h[e+3]-h[e]>h[g+3]-h[g]&&(g=e);let _=t+(m>>1),v=h[g+3]-h[g],y=()=>{let e=Array.from(n.subarray(t,i)).sort((e,t)=>s(e,g)-s(t,g));n.set(e,t)};if(v>0&&a<12){let e=1/0,r=-1,a=-1;for(let o=0;o<3;o++){let d=h[o],f=h[o+3]-d;if(!(f>0))continue;let p=Array.from({length:12},()=>({box:l(),n:0}));for(let e=t;e<i;e++){let t=Math.min(11,Math.floor((s(n[e],o)-d)/f*12));p[t].n++,u(p[t].box,n[e])}for(let t=1;t<12;t++){let n=l(),i=l(),s=0,u=0;for(let e=0;e<t;e++)if(p[e].n){s+=p[e].n;for(let t=0;t<3;t++)n[t]=Math.min(n[t],p[e].box[t]),n[t+3]=Math.max(n[t+3],p[e].box[t+3])}for(let e=t;e<12;e++)if(p[e].n){u+=p[e].n;for(let t=0;t<3;t++)i[t]=Math.min(i[t],p[e].box[t]),i[t+3]=Math.max(i[t+3],p[e].box[t+3])}if(!s||!u)continue;let d=s*c(n)+u*c(i);d<e&&(e=d,r=o,a=t)}}if(r>=0){g=r;let e=h[g],o=e+(h[g+3]-e)*a/12;for(y(),_=t;_<i&&s(n[_],g)<o;)_++;(_===t||_===i)&&(_=t+(m>>1))}else y()}else y();let b=r.length/8;r.push(0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0),p(b,0),d.push([b+1,_,i,a+1],[b,t,_,a+1])}return{nodes:Uint32Array.from(r),order:n}}function zt(e,t){let n=`scene.environment.map`;if(!J(e))throw TypeError(`${q} ${n} must be {width, height, data}`);let r=Y(e.width,`${n}.width`,1,8192,`pass the image width in texels`),i=Y(e.height,`${n}.height`,1,4096,`pass the image height in texels`);if(!Number.isInteger(r)||!Number.isInteger(i))throw RangeError(`${q} ${n} size ${r}x${i} must be whole texels`);let a=e.data;if(!(a instanceof Float32Array))throw TypeError(`${q} ${n}.data must be a Float32Array of linear RGB(A)`);let o=a.length===r*i*3?3:a.length===r*i*4?4:0;if(!o)throw TypeError(`${q} ${n}.data has ${a.length} floats; pass width * height * 3 (RGB) or * 4 (RGBA)`);let s=X(e.intensity,1,`${n}.intensity`,0,1e6,`pass 0 or more`),c=X(e.rotation,0,`${n}.rotation`,-1e6,1e6,`pass radians`),l=t.environment;if(l&&l.width===r&&l.height===i){let e=l.source.length===a.length;for(let t=0;e&&t<a.length;t++)e=Object.is(l.source[t],a[t]);if(e)return{...l,intensity:s,rotation:c}}let u=new Float32Array(r*i*4),d=new Float32Array(i),f=new Float32Array(r*i),p=0;for(let e=0;e<i;e++){let t=Math.sin(Math.PI*(e+.5)/i),s=0;for(let i=0;i<r;i++){let c=e*r+i,l=a[c*o],d=a[c*o+1],p=a[c*o+2];if(!(l>=0&&d>=0&&p>=0&&l<1/0&&d<1/0&&p<1/0))throw RangeError(`${q} ${n}.data texel ${i},${e} is negative or not finite; pass linear radiance`);let m=At(l,d,p)*t;u.set([l,d,p,m],c*4),s+=m,f[c]=s}for(let t=0;t<r;t++)f[e*r+t]=s>0?f[e*r+t]/s:(t+1)/r;p+=s,d[e]=p}for(let e=0;e<i;e++)d[e]=p>0?d[e]/p:(e+1)/i;return{source:a.slice(),width:r,height:i,intensity:s,rotation:c,texels:u,marginal:d,conditional:f,integral:p/(r*i)}}function Bt(e,t){let n=`scene.environment`;if(e!==void 0&&!J(e))throw TypeError(`${q} ${n} must be an object`);let r=e??{},i=(e,t)=>e===void 0?[1,1,1]:Z(e,`${n}.${t}`,!0,`pass linear RGB`),a=i(r.skyColor,`skyColor`),o=X(r.skyIntensity,1,`${n}.skyIntensity`,0,1e6,`pass 0 or more`),s=r.sunDirection===void 0?[.4,.8,.3]:Z(r.sunDirection,`${n}.sunDirection`,!1,`pass a direction toward the sun`),c=Math.hypot(...s);if(!(c>1e-12))throw RangeError(`${q} ${n}.sunDirection is zero; pass a direction toward the sun`);let l=i(r.sunColor,`sunColor`),u=X(r.sunIntensity,0,`${n}.sunIntensity`,0,1e6,`pass 0 (no sun) or more`),d=X(r.sunAngularSize,.0093,`${n}.sunAngularSize`,0,.5,`pass 0 to 0.5 radians`),f=r.groundColor===void 0?void 0:Z(r.groundColor,`${n}.groundColor`,!0,`pass linear RGB`),p=X(r.groundHeight,0,`${n}.groundHeight`,-1e9,1e9,`pass a finite height`),m=X(r.groundFade,0,`${n}.groundFade`,0,0xe8d4a51000,`pass 0 (no fade) or a distance`),h=X(r.groundFadeStart,0,`${n}.groundFadeStart`,0,0xe8d4a51000,`pass a distance`),g=r.background===void 0?void 0:Z(r.background,`${n}.background`,!0,`pass linear RGB, 0 or more, or leave it out`),_;if(r.fog!==void 0){if(!J(r.fog))throw TypeError(`${q} ${n}.fog must be {density, color?, anisotropy?}`);let e=X(r.fog.density,0,`${n}.fog.density`,0,1e6,`pass an extinction per unit above 0`),t=r.fog.color===void 0?[1,1,1]:Z(r.fog.color,`${n}.fog.color`,!0,`pass linear RGB 0 to 1`),i=X(r.fog.anisotropy,0,`${n}.fog.anisotropy`,-.95,.95,`pass -0.95 to 0.95`);e>0&&(_={density:e,color:[Math.min(t[0],1),Math.min(t[1],1),Math.min(t[2],1)],anisotropy:i,hemisphere:Vt(i)})}if(r.sunVisible!==void 0&&typeof r.sunVisible!=`boolean`)throw TypeError(`${q} ${n}.sunVisible must be true or false`);if(r.fadeModels!==void 0&&typeof r.fadeModels!=`boolean`)throw TypeError(`${q} ${n}.fadeModels must be true or false`);let v=[s[0]/c,s[1]/c,s[2]/c],y=r.map===void 0?void 0:zt(r.map,t),b;if(r.physicalSky!==void 0){if(r.map!==void 0)throw TypeError(`${q} ${n} has both map and physicalSky; pass one of them`);let e=r.physicalSky;if(!J(e))throw TypeError(`${q} ${n}.physicalSky must be {turbidity?, intensity?, horizonBelow?}`);if(e.horizonBelow!==void 0&&typeof e.horizonBelow!=`boolean`)throw TypeError(`${q} ${n}.physicalSky.horizonBelow must be true or false`);let i=X(e.turbidity,3,`${n}.physicalSky.turbidity`,1.7,10,`pass 1.7 (clear) to 10 (hazy)`),a=X(e.intensity,.1,`${n}.physicalSky.intensity`,0,1e6,`pass 0 or more`),o=e.horizonBelow===!0,s=`${i},${a},${v.join(`,`)},${o}`;b=t.sky?.key===s?t.sky:{key:s,data:We(i,v,a,o)},y=zt({width:Re,height:512,data:b.data},t)}return{sky:[a[0]*o,a[1]*o,a[2]*o],sunDirection:v,sun:[l[0]*u,l[1]*u,l[2]*u],sunAngularSize:d,ground:f&&[Math.min(f[0],1),Math.min(f[1],1),Math.min(f[2],1)],groundHeight:p,sunVisible:r.sunVisible!==!1,groundFade:m,groundFadeStart:h,fadeModels:r.fadeModels===!0,background:g,fog:_,map:y,skyCache:b}}function Vt(e){let t=new Float32Array(16);for(let n=0;n<16;n++){let r=-1+2*n/15,i=[Math.sqrt(Math.max(0,1-r*r)),r,0],a=0;for(let t=0;t<48;t++){let n=(t+.5)/48,r=Math.sqrt(1-n*n);for(let t=0;t<96;t++){let o=(t+.5)/96*2*Math.PI,s=i[0]*r*Math.cos(o)+i[1]*n,c=1+e*e-2*e*s;a+=(1-e*e)/(4*Math.PI*c*Math.sqrt(c))}}t[n]=a*2*Math.PI/4608}return t}function Ht(e){if(e===void 0)return{lights:new Float32Array,count:0,power:0};let t=yt(e,`lights`);if(t.length>ot)throw RangeError(`${q} scene.lights has ${t.length} lights; at most ${ot} are supported`);let n=[],r=[];for(let[e,i]of t.entries()){let t=`scene.lights[${e}]`;if(!J(i))throw TypeError(`${q} ${t} must be {position, direction, width, height}`);let a=Z(i.position,`${t}.position`,!1,`pass a world point`),o=Z(i.direction,`${t}.direction`,!1,`pass the side the light faces`),s=Y(i.width,`${t}.width`,0,1e9,`pass a size above 0`),c=Y(i.height,`${t}.height`,0,1e9,`pass a size above 0`),l=i.up===void 0?void 0:Z(i.up,`${t}.up`,!1,`pass an up hint`),u=i.color===void 0?[1,1,1]:Z(i.color,`${t}.color`,!0,`pass linear RGB`),d=X(i.intensity,1,`${t}.intensity`,0,1e6,`pass 0 or more`);if(!(s>0&&c>0&&Math.hypot(o[0],o[1],o[2])>0))throw RangeError(`${q} ${t} has no area; pass width and height above 0 and a nonzero direction`);if(i.twoSided!==void 0&&typeof i.twoSided!=`boolean`)throw TypeError(`${q} ${t}.twoSided must be true or false`);if(i.visible!==void 0&&typeof i.visible!=`boolean`)throw TypeError(`${q} ${t}.visible must be true or false`);if(i.opaque!==void 0&&typeof i.opaque!=`boolean`)throw TypeError(`${q} ${t}.opaque must be true or false`);let{right:f,up:p}=Le(o,l,`${q} ${t}`),m=f.map(e=>e*s),h=p.map(e=>e*c),g=a.map((e,t)=>e-m[t]/2-h[t]/2),_=i.opaque!==!1,v=s*c;if(i.visible===!1)continue;let y=[u[0]*d,u[1]*d,u[2]*d],b=At(y[0],y[1],y[2])*v*(i.twoSided?2:1);(b>0||_)&&(r.push(b>0?b:0),n.push(g[0],g[1],g[2],0,m[0],m[1],m[2],+!!i.twoSided,h[0],h[1],h[2],v,...y),n.push(+!!_))}let i=r.reduce((e,t)=>e+t,0),a=0;for(let e=0;e<r.length;e++)a+=r[e],n[e*16+3]=e===r.length-1||!(i>0)?1:a/i;return{lights:Float32Array.from(n),count:r.length,power:i}}function Ut(e){let t=t=>{let n=Math.hypot(e[t*4],e[t*4+1],e[t*4+2]);return[e[t*4]/n,e[t*4+1]/n,e[t*4+2]/n]},[n,r,i]=[t(0),t(1),t(2)],a=(e,t)=>Math.abs(e[0]*t[0]+e[1]*t[1]+e[2]*t[2]);return a(n,r)<1e-6&&a(r,i)<1e-6&&a(n,i)<1e-6}function Wt(e,t,n){let r=t.map((e,t)=>{let r=n[t],i=0;for(let t=1;t<256;t++){if(!e.counts[t])continue;let n=t*32,a=r[n+15];if(a&pt){if(!(a&8)||r[n+5]<.999||r[n+16]>0||i)return 0;i=r[n+11]}}return i}),i=t.map((e,t)=>{let r=n[t];for(let t=1;t<256;t++){let n=t*32;if(e.counts[t]&&r[n+15]&8&&r[n+4]===1)return!0}return!1}),a=[],o=0,s=0;for(let[t,n]of e.entries()){let e=r[n.model];e&&!n.previous&&Ut(n.toLocal)&&o<ft&&(n.prism=!0,o++,a.push(t,e)),i[n.model]&&s<ft&&(n.mirror=!0,s++,a.push(t,0))}return Float32Array.from(a)}function Gt(e,t,n){let r=new Float32Array(8192);for(let[i,a]of e.entries()){let e=`${t}[${i}]`;if(!J(a))throw TypeError(`${q} ${e} must be an object {id, color, type}`);if(typeof a.id!=`number`||!Number.isInteger(a.id))throw TypeError(`${q} ${e}.id must be an integer palette index 1 to 255`);if(a.id<1||a.id>255)throw RangeError(`${q} ${e}.id ${a.id} is outside 1 to 255 (0 is empty); use an id from 1 to 255`);if(r[a.id*32+15])throw TypeError(`${q} ${e}.id ${a.id} is used twice; give each palette index one material`);Nt(a,e,r,n)}return r}function Kt(e,t){let n=new Uint32Array(e.buffer,e.byteOffset,e.length),r=new Uint32Array(t.buffer,t.byteOffset,t.length);for(let e=0;e<n.length;e++)if(n[e]!==r[e])return!1;return!0}function qt(e){let t=new Uint32Array(e.buffer,e.byteOffset,e.length),n=2166136261;for(let e=0;e<t.length;e++)n=Math.imul(n^t[e],16777619);return n>>>0}function Jt(e,t,n,r=0){if(!J(e))throw TypeError(`${q} scene must be {revision, models, instances, materials}`);if(typeof e.revision!=`number`||!Number.isFinite(e.revision))throw TypeError(`${q} scene.revision must be a finite number`);let i=yt(e.models,`models`),a=yt(e.instances,`instances`),o=yt(e.materials,`materials`);if(a.length>at)throw RangeError(`${q} scene.instances has ${a.length}; at most ${at} are supported`);let s=jt(e.textures),c=[Gt(o,`scene.materials`,s.length)],l=new Map,u=new Map,d=[],f=[],p=new Map,m=new Map,h=new Map,g=0;for(let[e,r]of i.entries()){let i=`scene.models[${e}]`;if(!J(r))throw TypeError(`${q} ${i} must be {id, revision, size, voxels}`);let a=vt(r.id,`${i}.id`);if(p.has(a))throw TypeError(`${q} ${i}.id '${a}' is used twice; give every model its own id`);if(r.materials===void 0)d.push(0);else{let e=r.materials;if(!Array.isArray(e))throw TypeError(`${q} ${i}.materials must be an array of materials`);let t=u.get(e);if(t===void 0){let n=Gt(e,`${i}.materials`,s.length),r=qt(n),a=l.get(r)?.find(e=>Kt(c[e],n));if(a!==void 0)t=a;else{if(t=c.length,t>=lt)throw RangeError(`${q} scene needs more than ${lt} material tables; share tables between models`);c.push(n),l.set(r,[...l.get(r)??[],t])}u.set(e,t)}d.push(t)}let o=r.contentKey;if(o===null)throw TypeError(`${q} ${i}.contentKey is null; pass a key of the voxel contents, or leave it out`);let _=o===void 0?t.models.get(a)?.key===void 0?t.models.get(a):void 0:h.get(o)??t.keys?.get(o),v=r.size,y;_&&(o!==void 0||_.revision===r.revision)&&v?.length===3&&_.size.every((e,t)=>e===v[t])&&Ct(r,_.size)?y=_:(y=wt(r,i,n),g++),p.set(a,f.length),f.push(y),m.set(a,y),o!==void 0&&h.set(o,y)}let _=[],v=new Set,y=!1,b;for(let[e,t]of a.entries()){let n=`scene.instances[${e}]`;if(!J(t))throw TypeError(`${q} ${n} must be {id, modelId, matrix}`);let r=vt(t.id,`${n}.id`);if(v.has(r))throw TypeError(`${q} ${n}.id '${r}' is used twice; give every instance its own id`);v.add(r);let i=vt(t.modelId,`${n}.modelId`),a=p.get(i);if(a===void 0)throw TypeError(`${q} ${n}.modelId '${i}' names no model of this scene; add the model or fix the id`);let o=bt(t.matrix,`${n}.matrix`),s=t.previousMatrix===void 0?void 0:bt(t.previousMatrix,`${n}.previousMatrix`),c=t.motionInterpolation===void 0?`matrix`:t.motionInterpolation;if(c!==`matrix`&&c!==`trs`)throw TypeError(`${q} ${n}.motionInterpolation must be 'matrix' or 'trs'`);if(t.visible!==void 0&&typeof t.visible!=`boolean`)throw TypeError(`${q} ${n}.visible must be true or false`);if(t.visible===!1)continue;let l=new Float64Array([1/0,1/0,1/0,-1/0,-1/0,-1/0]),u=f[a].size,d;if(s)try{d=Ie(s,o,u,c,n)}catch(e){b??=e}d?(l.set(d.bounds),y=!0):Lt(l,o,u),_.push({id:r,source:e,model:a,toWorld:o,toLocal:St(o),previous:d&&s,motion:d?.payload,box:l,lightPick:0,prism:!1,mirror:!1})}let x=e=>c[d[e]];for(let[e,t]of p){let n=f[t],r=x(t),i=d[t]?`model '${e}'.materials has`:`scene.materials has`;for(let t=1;t<256;t++)if(n.counts[t]&&!r[t*32+15])throw TypeError(`${q} model '${e}' uses palette index ${t} (${n.counts[t]} voxels) but ${i} no material with id ${t}; add one`)}let S=Bt(e.environment,t),{lights:C,count:w,power:T}=Ht(e.lights),E=4;for(let e of new Set(f))E+=e.grid.length+e.payload.length;if(E>n)throw RangeError(`${q} scene needs ${E*4} bytes of voxel bricks; this device binds at most ${n*4}; use fewer or smaller models`);if(c.length*256*32>n)throw RangeError(`${q} scene's ${c.length} material tables need ${c.length*256*32*4} bytes; this device binds at most ${n*4}; share tables between models`);let D=new Float64Array(_.length*6);for(let[e,t]of _.entries())D.set(t.box,e*6);let{nodes:O,order:k}=Rt(D,_.length),A=Array.from(k,e=>_[e]),j=f.map((e,n)=>{let r=x(n),i=Ft(e,r,t);if(!i)return{faces:new Uint32Array,cdf:new Float32Array,total:0};let a=new Float32Array(i.ids.length),o=0;for(let e=0;e<i.ids.length;e++){let t=i.ids[e]*32+8;o+=At(r[t],r[t+1],r[t+2])*(i.faces[e*2+1]>>>19&1?.25:1),a[e]=o}for(let e=0;e<a.length;e++)a[e]=e===a.length-1?1:a[e]/o;return{faces:i.faces,cdf:a,total:o}}),M=[],N=[];for(let[e,t]of A.entries()){let n=j[t.model].total;if(!(n>0))continue;let[r,i,a]=It(t.toWorld);M.push(e),N.push(n*(r+i+a)/3)}let P=N.reduce((e,t)=>e+t,0),ee=new Float32Array(N.length),F=0;for(let e=0;e<N.length;e++)F+=N[e],ee[e]=e===N.length-1?1:F/P,A[M[e]].lightPick=N[e]/P;return Zt({models:f,instances:A,nodes:O,textures:s,environment:S,emitters:j,emissiveInstances:{length:M.length},lightCount:w,voxelWords:E,materials:{length:c.length*256*32}},n,r),t.models=m,t.keys=h,S.map&&(t.environment=S.map),S.skyCache&&(t.sky=S.skyCache),{revision:e.revision,models:f,modelIds:[...p.keys()],modelIndex:p,packedModels:g,reusedModels:f.length-g,instances:A,nodes:O,materials:Yt(c),modelTables:Uint32Array.from(d),environment:S,lights:C,lightCount:w,lightPower:T,emitters:j,emissiveInstances:Uint32Array.from(M),emissiveCdf:ee,moving:y,motionError:b,deflectors:Wt(A,f,f.map((e,t)=>x(t))),clearGlass:f.some((e,t)=>e.counts.some((e,n)=>{let r=n*32,i=x(t);return n>0&&e>0&&(i[r+15]&pt)!==0&&!!(i[r+15]&8)&&i[r+5]>=.999&&i[r+16]===0})),focusing:f.some((e,t)=>e.counts.some((e,n)=>{let r=n*32,i=x(t);return n>0&&e>0&&(i[r+5]>0||i[r+3]<.1&&(i[r+4]>0||i[r+6]*i[r+7]>0))})),voxelWords:E,textures:s}}function Yt(e){if(e.length===1)return e[0];let t=new Float32Array(e.length*256*32);for(let[n,r]of e.entries())t.set(r,n*256*32);return t}function Xt(e){return 4+e.models.length*12+e.instances.reduce((e,t)=>e+40+(t.motion?16:0),0)+e.nodes.length+e.textures.reduce((e,t)=>e+4+t.texels.length,0)}function Zt(e,t,n=0){if(e.voxelWords>t)throw RangeError(`${q} scene needs ${e.voxelWords*4} bytes of voxel bricks; this device binds at most ${t*4}; use fewer or smaller models`);if(e.materials.length>t)throw RangeError(`${q} scene's material tables need ${e.materials.length*4} bytes; this device binds at most ${t*4}; share tables between models`);let r=e.environment.map,i=e.emitters.reduce((e,t)=>e+t.cdf.length,0),a=Xt(e)+n+4+32+e.emissiveInstances.length*2+i*3+e.lightCount*16+(r?r.height+r.width*r.height:0);if(r&&r.width*r.height*4>t)throw RangeError(`${q} scene.environment.map ${r.width}x${r.height} needs ${r.width*r.height*16} bytes; this device binds at most ${t*4}; pass a smaller map`);if(a>t)throw RangeError(`${q} scene's records, textures and light tables (${i} emissive voxel faces) need ${a*4} bytes and this device binds at most ${t*4}; use fewer emissive voxels, instances or textures`)}var Qt=1024,$t=2048,en=4096,tn=8192,nn=16384,rn=32768,an=new Float32Array(1),on=new Uint32Array(an.buffer),sn=e=>(an[0]=e,on[0]);function cn(e,t){let n=new Uint32Array(e.grid.length+e.payload.length),r=t+e.grid.length;for(let t=0;t<e.grid.length;t++){let i=e.grid[t];n[t]=i===0||i>=2147483648?i:r+((i&~it)-1)*128|i&it}return n.set(e.payload,e.grid.length),n}function ln(e){let t=e.environment.map,n=Xt(e),r=n+4,i=r;r+=e.deflectors.length;let a=r;r+=e.emissiveInstances.length*2;let o=e.emitters.map(e=>{let t=r;return r+=e.cdf.length*3,{first:t,count:e.cdf.length,total:e.total}}),s=r;r+=e.lightCount*16;let c=r;r+=t?t.height:0;let l=r;r+=t?t.width*t.height:0;let u=new Uint32Array(r),d=new Float32Array(u.buffer);u[1]=n,u[n]=i,u[n+1]=e.deflectors.length/2;for(let t=0;t<e.deflectors.length;t+=2)u[i+t]=e.deflectors[t],d[i+t+1]=e.deflectors[t+1];for(let t=0;t<e.emissiveInstances.length;t++)u[a+t*2]=e.emissiveInstances[t],d[a+t*2+1]=e.emissiveCdf[t];for(let[t,n]of e.emitters.entries())for(let e=0;e<n.cdf.length;e++)u[o[t].first+e*3]=n.faces[e*2],u[o[t].first+e*3+1]=n.faces[e*2+1],d[o[t].first+e*3+2]=n.cdf[e];return d.set(e.lights,s),t&&(d.set(t.marginal,c),d.set(t.conditional,l)),{words:u,emissiveBase:a,areaBase:s,marginalBase:c,conditionalBase:l,emitters:o}}function un(e,t,n){let r=4+e.models.length*12,i=r+e.instances.length*40,a=e.nodes.length/8,o=i+e.nodes.length,s=o+e.instances.reduce((e,t)=>e+(t.motion?16:0),0),c=n.words,l=new Float32Array(c.buffer),u=o;c[0]=e.textures.length?s:0;let d=s+4*e.textures.length;for(let[t,n]of e.textures.entries())c.set([d,n.width,n.height,0],s+4*t),c.set(n.texels,d),d+=n.texels.length;for(let[r,i]of e.models.entries()){let a=4+r*12,o=n.emitters[r];c.set([i.size[0],i.size[1],i.size[2],t[r],i.bricks[0],i.bricks[1],i.bricks[2],e.modelTables[r]<<8],a),c[a+8]=o.first,c[a+9]=o.count,c[a+10]=sn(o.total)}for(let[t,n]of e.instances.entries()){let e=r+t*40;l.set(n.toLocal,e),l.set(n.toWorld,e+12),l.set(n.previous??n.toWorld,e+24),c[e+36]=n.model,c[e+37]=+!!n.previous|(n.prism?2:0)|(n.mirror?4:0)|(n.motion?8:0),l[e+38]=n.lightPick,n.motion&&(c[e+39]=u,l.set(n.motion,u),u+=16)}return c.set(e.nodes,i),{words:c,modelBase:4,instanceBase:r,nodeBase:i,nodeCount:a}}var dn=1<<20,fn=e=>e*4+16+(e+1)*16,pn=dn*fn(8);function mn(e,t=pn){return Math.max(1,Math.min(dn,Math.floor(t/fn(e))))}var hn=class{constructor(){this.budget=pn/16}observe(e,t){if(!(e>0)||!(t>0))return;let n=e/t*50;this.budget=Math.max(pn/4096,Math.min(pn,this.budget*2,n))}};function gn(e,t,n,r,i=1,a=dn,o=a){let s=Math.min(t,i),c=Math.max(1,Math.min(r,Math.floor(a/(s*e)))),l=Math.min(t,Math.max(s,Math.floor(Math.min(o,a)/(e*c)/i)*i)),u=[];for(let e=0;e<r;e+=c)for(let i=0;i<t;i+=l)u.push({y0:i,rows:Math.min(l,t-i),s0:n+e,count:Math.min(c,r-e)});return u}function _n(e,t){let n=e*16,r=t;for(;r;)[n,r]=[r,n%r];return t/n}var vn=`fn pbrNeutral(input:vec3f)->vec3f {let x=min(input.r,min(input.g,input.b));let offset=select(0.04,x-6.25*x*x,x<0.08);var v=input-offset;let peak=max(v.r,max(v.g,v.b));if(peak<0.76){return v;}let newPeak=1.0-0.24*0.24/(peak+0.24-0.76);v*=newPeak/peak;return mix(v,vec3f(newPeak),1.0-1.0/(0.15*(peak-newPeak)+1.0));}
fn toDisplay(c:vec3f)->vec3f {let x=pbrNeutral(max(c,vec3f(0)));return select(x*12.92,1.055*pow(x,vec3f(1.0/2.4))-0.055,x>=vec3f(0.0031308));}
`,Q=Object.freeze({twoOverPi:[0,2734261102,1313084713,4230436817,4113882560,3680671129,1011060801,4266746795],halfPiFixed:3373259426,halfPi:[1.5707963705062866,-4.371138828673793e-8],quarterPi:[.7853981852531433,-2.1855694143368964e-8],pi:[3.1415927410125732,-8.742277657347586e-8],ln2:[.693145751953125,1428606765330187e-21],ln2Pair:[.6931471824645996,-1.9046542121259336e-9],log2e:[1.4426950216293335,1.925963033500011e-8],sin:[-.1666666716337204,.008333379402756691,-.00019853089179378003,2833021881087916e-21],cos:[.0416666679084301,-.0013888980029150844,2482202216924634e-20,-2.8881245839329495e-7],atan:[-.3333333432674408,.20000059902668,-.14286741614341736,.11114691942930222,-.09025663882493973,.06947030127048492,-.03550770878791809],asin:[.1666666716337204,.07499949634075165,.044659871608018875,.03011295571923256,.024605773389339447,.007497195154428482,.03466988354921341],sinh:[.1666666716337204,.00833326205611229,.00019874409190379083,20846018742304295e-22,6.411173671949655e-7,-2.0997923400045693e-7],cosh:[.0416666679084301,.0013888796092942357,2482521813362837e-20,2.506288865333772e-7,1.1460320692435744e-8],tanh:[-.3333333432674408,.1333339512348175,-.05398104339838028,.021990614011883736,-.009435489773750305,.004868379328399897,-.0023415694013237953],expm1:[.5,.1666666567325592,.04166649281978607,.008333546109497547,.0013932319125160575,.00019761594012379646],log:[.6666666269302368,.40000975131988525,.28498485684394836,.24286234378814697]}),$=e=>{let t=String(e);for(let n=1;n<=9;n++){let r=e.toPrecision(n);if(Math.fround(Number(r))===e){t=r;break}}return/[.e]/.test(t)?t:`${t}.0`},yn=(e,t)=>{let n=$(t[t.length-1]);for(let r=t.length-2;r>=0;r--)n=`(${e} * ${n} + ${$(t[r])})`;return n},bn=e=>`0x${e.toString(16)}u`,xn,Sn=()=>xn??={pmBits:[[],`fn pmExponent(x: f32) -> u32 { return (bitcast<u32>(x) >> 23u) & 0xffu; }
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
const PM_PIO2_HI: f32 = ${$(Q.halfPi[0])};
const PM_PIO2_LO: f32 = ${$(Q.halfPi[1])};
const PM_PIO4_HI: f32 = ${$(Q.quarterPi[0])};
const PM_PIO4_LO: f32 = ${$(Q.quarterPi[1])};
const PM_PI_HI: f32 = ${$(Q.pi[0])};
const PM_PI_LO: f32 = ${$(Q.pi[1])};
const PM_LN2_HI: f32 = ${$(Q.ln2[0])};
const PM_LN2_LO: f32 = ${$(Q.ln2[1])};
const PM_LN2: f32 = ${$(Q.ln2Pair[0])};
const PM_LN2_TAIL: f32 = ${$(Q.ln2Pair[1])};
const PM_LOG2E: f32 = ${$(Q.log2e[0])};
const PM_LOG2E_LO: f32 = ${$(Q.log2e[1])};
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
${Q.twoOverPi.map((e,t)=>`    case ${t}u: { return ${bn(e)}; }`).join(`
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
 let L = pmMul32(lo, ${Q.halfPiFixed}u); let H = pmMul32(hi, ${Q.halfPiFixed}u);
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
 let p = ${yn(`w`,Q.sin)};
 return h + pmHide(l * (1.0 - 0.5 * w) + (h * w) * p);
}
fn pmCosK(h: f32, l: f32) -> f32 {
 let w = pmHide(h * h); let hw = 0.5 * w; let t = pmFastTwoSum(1.0, -hw);
 let ew = pmProductError(h, h, w);
 let p = ${yn(`w`,Q.cos)};
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
 let p = ${yn(`w`,Q.atan)};
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
 let p = ${yn(`w`,Q.asin)};
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
`],pmExp:[[`pmBits`],`fn pmExpm1P(r: f32) -> f32 { return ${yn(`r`,Q.expm1)}; }
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
 if (a <= 1.0) { let w = a * a; r = a + pmHide((a * w) * ${yn(`w`,Q.sinh)}); }
 else if (a > 88.72284) { let t = preciseExp(0.5 * a); r = pmHide(0.5 * t) * t; }
 else if (a > 9.0) { r = 0.5 * preciseExp(a); }
 else { let e = preciseExpm1(a); r = 0.5 * (e + preciseDiv(e, e + 1.0)); }
 return pmWithSign(r, x);
}
`],preciseCosh:[[`preciseExp`,`preciseDiv`],`fn preciseCosh(x: f32) -> f32 {
 let a = abs(x);
 if (pmIsNan(x)) { return x; }
 if (a < 0.000244140625) { return 1.0; }
 if (a <= 1.0) { let w = a * a; return 1.0 + pmHide((w * w) * ${yn(`w`,Q.cosh)} + 0.5 * w); }
 if (a > 88.72284) { let t = preciseExp(0.5 * a); return pmHide(0.5 * t) * t; }
 let t = preciseExp(a);
 return 0.5 * (t + preciseDiv(1.0, t));
}
`],preciseTanh:[[`preciseExpm1`,`preciseDiv`],`fn preciseTanh(x: f32) -> f32 {
 let a = abs(x);
 if (pmIsNan(x)) { return x; }
 if (a < 0.000244140625) { return x; }
 if (a > 9.1) { return pmWithSign(1.0, x); }
 if (a <= 0.55) { let w = a * a; return pmWithSign(a + pmHide((a * w) * ${yn(`w`,Q.tanh)}), x); }
 let e = preciseExpm1(2.0 * a);
 return pmWithSign(preciseDiv(e, e + 2.0), x);
}
`],pmLog:[[`preciseDiv`],`struct PmLogK { s: f32, R: f32, hfsq: f32, t: f32 }
fn pmLogK(f: f32) -> PmLogK {
 let s = preciseDiv(f, 2.0 + f);
 let z = s * s;
 let R = z * ${yn(`z`,Q.log)};
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
 let w = pmFastTwoSum(${$(Math.fround(2/3))}, ${$(Math.fround(2/3-Math.fround(2/3)))} + z * ${yn(`z`,[2/5,2/7,2/9,2/11,2/13,2/15].map(e=>Math.fround(e)))});
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
`]},Cn=Object.freeze([`preciseDiv`,`preciseSqrt`,`preciseSin`,`preciseCos`,`preciseTan`,`preciseAtan`,`preciseAtan2`,`preciseAsin`,`preciseAcos`,`preciseExp`,`preciseExp2`,`preciseExpm1`,`preciseSinh`,`preciseCosh`,`preciseTanh`,`preciseLog`,`preciseLog2`,`preciseLog1p`,`precisePow`]);function wn(e){let t=[],n=new Set,r=e=>{if(n.has(e))return;let i=Sn()[e];if(!i)throw RangeError(`Unknown precise maths function ${e}; use one of ${Cn.join(`, `)}`);n.add(e);for(let e of i[0])r(e);t.push(i[1])};for(let t of e)r(t);return t.join(``)}var Tn=(e,t,n=`nh`,r=`a2`)=>`(max(dot(cross(${e},${t}),cross(${e},${t})),step(${n},0.0))+${r}*${n}*${n})`,En=`
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

 prevOrigins:array<vec4f,4>,
 prevDirections:array<vec4f,4>,
 prevEye:vec4f,
 prevForward:vec4f,
 prevRight:vec4f,
 prevUp:vec4f,

 projection:vec4u,

 lensFov:vec4f,

 distortion:vec4f,


 limits:vec4u,

 fog:vec4f,
 fogColor:vec4f,
 fogHemi:array<vec4f,4>,

 groundFade:vec4f,


 background:vec4f,
 edges:vec4f,
 grid:vec4f,
 grid2:vec4f,
}
`,Dn=e=>`${Math.round(e*2**32)%2**32}u`,On=`
const PI=3.141592653589793;
const TAU=6.283185307179586;
const INV_PI=0.3183098861837907;
fn basis(n:vec3f)->mat3x3f {
 let s=select(-1.0,1.0,n.z>=0.0);let a=-1.0/(s+n.z);let b=n.x*n.y*a;
 return mat3x3f(vec3f(1.0+s*n.x*n.x*a,s*b,-s*n.x),vec3f(b,s+n.y*n.y*a,-n.y),n);
}
fn ggxD(a2:f32,n:vec3f,h:vec3f)->f32 {let nh=max(dot(n,h),0.0);let k=${Tn(`n`,`h`)};return a2/(PI*k*k);}
fn lambdaG(a2:f32,c:f32)->f32 {let c2=max(c*c,1e-8);return 0.5*(sqrt(1.0+a2*(1.0-c2)/c2)-1.0);}
fn fresnel(ci:f32,eta:f32)->f32 {
 let s2=eta*eta*max(0.0,1.0-ci*ci);
 if(s2>=1.0){return 1.0;}
 let ct=sqrt(1.0-s2);
 let rs=(eta*ci-ct)/(eta*ci+ct);let rp=(ci-eta*ct)/(ci+eta*ct);
 return 0.5*(rs*rs+rp*rp);
}

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
`,kn=2312,An=`${On}
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
 for(var k=0u;k<SAMPLES;k++){sum+=reflectWeight(mu,alpha,vec2f(seq(k,${Dn(.7548776662466927)}),seq(k,${Dn(.5698402909980532)})));}
 return sum/f32(SAMPLES);
}
fn averageE(r:f32)->f32 {
 let alpha=max(r*r,1e-4);var sum=0.0;let n=SAMPLES*16u;
 for(var k=0u;k<n;k++){
  let mu=max(sqrt(seq(k,${Dn(.8191725133961645)})),0.002);
  sum+=reflectWeight(mu,alpha,vec2f(seq(k,${Dn(.6710436067037893)}),seq(k,${Dn(.5497004779019703)})));
 }
 return sum/f32(n);
}
fn albedoGlass(mu:f32,r:f32,eta:f32)->f32 {
 let alpha=max(r*r,1e-4);let a2=alpha*alpha;let n=vec3f(0.0,0.0,1.0);let wo=vec3f(sqrt(max(0.0,1.0-mu*mu)),0.0,mu);
 let lo=lambdaG(a2,mu);var sum=0.0;
 for(var k=0u;k<SAMPLES;k++){
  let m=vndfU(wo,alpha,n,vec2f(seq(k,${Dn(.7548776662466927)}),seq(k,${Dn(.5698402909980532)})));
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
`,jn=`${En}${On}${nt}${wn([`preciseSin`,`preciseCos`,`preciseAsin`,`preciseAtan`])}
const INF=3.0e38;
const NONE=0xffffffffu;
const GROUND=0xfffffffeu;
const AREA=0xfffffffdu;
const EPS=2e-3;
const MEDIA=1u;
const EMISSIVE=4u;
const SMOOTH=8u;
const DELTA=${ht};

const GLOSSY=${gt};
const SUN=1u;
const HAS_GROUND=2u;
const ENV=4u;
const MOTION=8u;
const JITTER=16u;
const CLAMP=32u;
const SPLIT=64u;
const DIRECT=${rn}u;
const AREA_NEE=128u;
const CAMERA_MOTION=256u;
const CLEAR_GLASS=512u;
const OPAQUE_SHADOWS=${Qt}u;
const SUN_DIFFUSE=${$t}u;
const NO_SUN_MEDIA=${en}u;
const HIDE_SUN=${tn}u;
const NO_COMPENSATION=${nn}u;
const ADDITIVE=32u;
const UNTINTED=64u;
const SUNLIT=128u;
const SUBSURFACE=${dt}u;
const WALK=256u;
const VOXELWISE=256u;
const CONTACT=512u;
const CUTOUT=${ut}u;

const STEP=0xfffffffeu;
const MODEL=12u;
const INSTANCE=40u;
@group(0) @binding(0) var<uniform> f:Frame;
const MV=8u;



override TABLES:bool=false;
@group(0) @binding(1) var<uniform> table0:array<vec4f,2048>;
@group(0) @binding(2) var<storage,read> voxels:array<u32>;

@group(0) @binding(3) var<storage,read> scene:array<u32>;

@group(0) @binding(4) var<storage,read> materials:array<vec4f>;

fn mat(i:u32)->vec4f {if(TABLES){return materials[i];}return table0[i];}
@group(0) @binding(5) var<storage,read> envmap:array<vec4f>;
@group(0) @binding(6) var<storage,read_write> accum:array<vec4f>;
@group(0) @binding(7) var<storage,read_write> albedo:array<vec4f>;
@group(0) @binding(8) var<storage,read_write> normals:array<vec4f>;
@group(0) @binding(9) var<uniform> tables:array<vec4f,${kn}>;
@group(0) @binding(10) var<storage,read_write> caustics:array<vec4f>;
var<private> rng:u32;
var<private> motion:f32;


var<private> sunFace:bool;
var<private> sunCell:bool;

fn lum(c:vec3f)->f32 {return dot(c,vec3f(0.2126,0.7152,0.0722));}
fn hash(v:u32)->u32 {let s=v*747796405u+2891336453u;let w=((s>>((s>>28u)+4u))^s)*277803737u;return (w>>22u)^w;}
fn rand()->f32 {rng=rng*747796405u+2891336453u;let w=((rng>>((rng>>28u)+4u))^rng)*277803737u;return f32(((w>>22u)^w)>>8u)*5.960464477539063e-8;}
fn power2(a:f32,b:f32)->f32 {let a2=a*a;let b2=b*b;return select(1.0,a2/(a2+b2),a2+b2>0.0);}
fn fl(i:u32)->f32 {return bitcast<f32>(scene[i]);}
fn ll(i:u32)->f32 {return bitcast<f32>(scene[i]);}


struct Xform {r0:vec4f,r1:vec4f,r2:vec4f}
fn rowAt(i:u32)->vec4f {return vec4f(fl(i),fl(i+1u),fl(i+2u),fl(i+3u));}
fn xpoint(m:Xform,p:vec3f)->vec3f {return vec3f(dot(m.r0.xyz,p)+m.r0.w,dot(m.r1.xyz,p)+m.r1.w,dot(m.r2.xyz,p)+m.r2.w);}
fn xdir(m:Xform,d:vec3f)->vec3f {return vec3f(dot(m.r0.xyz,d),dot(m.r1.xyz,d),dot(m.r2.xyz,d));}
fn rowOf(m:Xform,k:u32)->vec3f {return select(select(m.r2.xyz,m.r1.xyz,k==1u),m.r0.xyz,k==0u);}
fn colOf(m:Xform,k:u32)->vec3f {return vec3f(m.r0[k],m.r1[k],m.r2[k]);}
fn invertX(m:Xform)->Xform {

 let h=max(max(max(abs(m.r0.x),abs(m.r0.y)),max(abs(m.r0.z),abs(m.r1.x))),max(max(abs(m.r1.y),abs(m.r1.z)),max(max(abs(m.r2.x),abs(m.r2.y)),abs(m.r2.z))));
 let a=m.r0.xyz/h;let b=m.r1.xyz/h;let c=m.r2.xyz/h;
 let c0=cross(b,c);let c1=cross(c,a);let c2=cross(a,b);let k=(1.0/h)/dot(a,c0);
 let r0=vec3f(c0.x,c1.x,c2.x)*k;let r1=vec3f(c0.y,c1.y,c2.y)*k;let r2=vec3f(c0.z,c1.z,c2.z)*k;
 let t=vec3f(m.r0.w,m.r1.w,m.r2.w);
 return Xform(vec4f(r0,-dot(r0,t)),vec4f(r1,-dot(r1,t)),vec4f(r2,-dot(r2,t)));
}


fn motionRotation(p:u32)->mat3x3f {
 let a=normalize(rowAt(p));let q=normalize(rowAt(p+4u));let angle=fl(p+11u);let inv=fl(p+15u);
 var v=a*(1.0-motion)+q*motion;
 if(inv>0.0){v=a*(sin((1.0-motion)*angle)*inv)+q*(sin(motion*angle)*inv);}
 v=normalize(v);let x=v.x;let y=v.y;let z=v.z;let w=v.w;
 return mat3x3f(vec3f(1.0-2.0*(y*y+z*z),2.0*(x*y+w*z),2.0*(x*z-w*y)),vec3f(2.0*(x*y-w*z),1.0-2.0*(x*x+z*z),2.0*(y*z+w*x)),vec3f(2.0*(x*z+w*y),2.0*(y*z-w*x),1.0-2.0*(x*x+y*y)));
}
fn motionScale(p:u32)->vec3f {return mix(vec3f(fl(p+8u),fl(p+9u),fl(p+10u)),vec3f(fl(p+12u),fl(p+13u),fl(p+14u)),motion);}
fn motionTranslation(b:u32)->vec3f {return mix(vec3f(fl(b+27u),fl(b+31u),fl(b+35u)),vec3f(fl(b+15u),fl(b+19u),fl(b+23u)),motion);}

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

fn planeAxis(l:vec3f,c:vec3i)->u32 {let e=min(abs(l-vec3f(c)),abs(l-vec3f(c+1)));return select(select(2u,1u,e.y<=e.z),0u,e.x<=e.y&&e.x<=e.z);}



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



fn forwardCell(p:vec3f,d:vec3f)->vec3i {


 return vec3i(select(floor(p),ceil(p)-vec3f(1.0),d<vec3f(0.0)));
}
fn march(model:u32,o:vec3f,d:vec3f,tMin:f32,tMax:f32,want:u32,h:ptr<function,Hit>)->bool {
 let mb=f.scene.x+model*MODEL;

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

    let tc=min(min(vn.x,vn.y),vn.z);

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




fn extinction(v:u32,own:bool)->f32 {
 let x=mat(v*MV+3u);let fl=u32(x.w);
 return select(-1.0,x.x,(fl&MEDIA)!=0u&&(fl&SUBSURFACE)==0u&&((f.config.z&OPAQUE_SHADOWS)==0u||((fl&SUNLIT)!=0u&&own)));
}

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

   if(sm!=0u){
    if(cutMat(v)){if(shapeCut(v,sm,o,d,c,vt,next,start&&vt==0.0).x>=0.0){return -1.0;}}
    else{let span=octSpan(sm,o,d,c,vt,next);if(span>0.0){let x=extinction(v,false);if(x<0.0){return -1.0;}depth+=x*span;}}
    own=false;
   }

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


fn closest(o:vec3f,d:vec3f,medium:u32,mInst:u32)->Hit {
 var h:Hit;h.t=INF;h.inst=NONE;
 if((f.config.z&HAS_GROUND)!=0u&&abs(d.y)>1e-9){let t=(f.ground.w-o.y)/d.y;if(t>0.0){h.t=t;h.inst=GROUND;}}
 for(var k=0u;k<f.config.w;k++){

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



fn mediumClosest(o:vec3f,d:vec3f,medium:u32,mInst:u32,advance:bool)->Hit {
 var shift=0.0;
 if(advance){shift=max(1e-6,max(max(abs(o.x),abs(o.y)),abs(o.z))*4.76837158e-7)/length(d);}
 var h=closest(o+d*shift,d,medium,mInst);
 if(h.inst!=NONE){h.t+=shift;}
 return h;
}

fn shadow(o:vec3f,d:vec3f,tMax:f32)->f32 {
 if((f.config.z&HAS_GROUND)!=0u&&abs(d.y)>1e-9){let t=(f.ground.w-o.y)/d.y;if(t>0.0&&t<tMax){return 0.0;}}

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

fn filled(model:u32,c:vec3i)->bool {
 let mb=f.scene.x+model*MODEL;
 let sz=vec3i(i32(scene[mb]),i32(scene[mb+1u]),i32(scene[mb+2u]));
 if(any(c<vec3i(0))||any(c>=sz)){return false;}
 return voxelAt(model,c)!=0u;
}


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


fn gridLine(p:vec3f,n:vec3f)->bool {
 let s=f.grid.w;let q=abs(p/s-round(p/s))*s;let a=abs(n);
 let k=select(select(2u,1u,a.y>=a.z),0u,a.x>=a.y&&a.x>=a.z);
 return (k!=0u&&q.x<f.grid2.x)||(k!=1u&&q.y<f.grid2.x)||(k!=2u&&q.z<f.grid2.x);
}



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

fn faceOf(a:u32,l:vec3f,c:vec3i)->u32 {return a*2u+select(1u,0u,l[a]-f32(c[a])>0.5);}

fn faceTexel(h:Hit,l:vec3f)->vec4f {
 if(scene[0]==0u||h.inst>=AREA){return vec4f(1.0);}
 var face=faceOf(h.axis,l,h.cell);

 if(abs(l[h.axis]-f32(h.cell[h.axis])-0.5)<1e-3){face=h.axis*2u+select(1u,0u,h.sgn>0.0);}
 return texelAt(h.value,face,l);
}
fn cutMat(v:u32)->bool {return v!=0u&&(u32(mat(v*MV+3u).w)&CUTOUT)!=0u;}



fn cutThrough(v:u32,o:vec3f,d:vec3f,t0:f32,inside:bool,c:vec3i,vn:vec3f)->u32 {
 let cut=mat(v*MV+7u).z;
 if(!inside){

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




struct Ray {o:vec3f,d:vec3f}
fn pinhole(px:vec2f)->Ray {
 let uv=px/vec2f(f32(f.image.x),f32(f.image.y));
 var o=mix(mix(f.origins[0],f.origins[1],uv.x),mix(f.origins[2],f.origins[3],uv.x),uv.y).xyz;
 var d=mix(mix(f.directions[0],f.directions[1],uv.x),mix(f.directions[2],f.directions[3],uv.x),uv.y).xyz;
 if((f.config.z&CAMERA_MOTION)!=0u&&motion<1.0){

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





fn wideRay(px:vec2f)->Ray {
 var eye=f.eye.xyz;var fw=f.forward.xyz;var rt=f.right.xyz;var up=f.up.xyz;
 if((f.config.z&CAMERA_MOTION)!=0u&&motion<1.0){
  eye=mix(f.prevEye.xyz,eye,motion);fw=normalize(mix(f.prevForward.xyz,fw,motion));
  rt=normalize(mix(f.prevRight.xyz,rt,motion));up=normalize(mix(f.prevUp.xyz,up,motion));
 }
 let W=f32(f.image.x);let H=f32(f.image.y);
 if(f.projection.x==1u){

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



struct Mat {color:vec3f,alpha:f32,metal:f32,glass:f32,spec:f32,f0:f32,emission:vec3f,ior:f32,density:f32,scatter:f32,g:f32,flags:u32,disp:f32,metalColor:vec3f,seen:vec4f}
fn material(id:u32)->Mat {
 let a=mat(id*MV);let b=mat(id*MV+1u);let c=mat(id*MV+2u);let e=mat(id*MV+3u);
 let x=mat(id*MV+4u);
 return Mat(a.xyz,a.w,b.x,b.y,b.z,b.w,c.xyz,c.w,e.x,e.y,e.z,u32(e.w),x.x,x.yzw,mat(id*MV+5u));
}

fn iorAt(m:Mat,l:f32)->f32 {let x=l*0.001;return m.ior+m.disp*(1.0/(x*x)-1.0/(LAMBDA_D*LAMBDA_D));}

fn clearGlass(m:Mat)->bool {return (m.flags&SMOOTH)!=0u&&m.disp==0.0;}


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

struct Bounce {wi:vec3f,w:vec3f,pdf:f32,transmit:bool,ok:bool,lobe:u32}
fn guideWeight(s:Bounce,alpha:f32,n:vec3f,wo:vec3f,eta:f32,isSmooth:bool)->vec3f {
 if(isSmooth||s.lobe!=3u){return s.w;}
 let e=tableGlass(dot(n,wo),sqrt(alpha),eta);
 return vec3f(min(select(e/0.05,e,(f.config.z&NO_COMPENSATION)!=0u),1.0));
}


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


fn envUV(d:vec3f)->vec2f {
 var u=atan2(d.x,-d.z)/TAU+0.5-f.weights.y/TAU;
 u=u-floor(u);
 return vec2f(u,acos(clamp(d.y,-1.0,1.0))/PI);
}
fn envTexel(uv:vec2f)->vec4f {
 let x=min(u32(uv.x*f32(f.env.x)),f.env.x-1u);let y=min(u32(uv.y*f32(f.env.y)),f.env.y-1u);
 return envmap[y*f.env.x+x];
}

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

fn skyBehind(d:vec3f)->vec3f {
 if((f.config.z&ENV)==0u){return f.sky.xyz;}
 return envSmooth(envUV(d))*f.sky.w;
}

fn horizonSky(d:vec3f)->vec3f {
 if((f.config.z&ENV)==0u){return f.sky.xyz;}
 let h=vec3f(d.x,0.0,d.z);
 if(dot(h,h)<1e-12){return envSmooth(envUV(vec3f(0.0,0.0,-1.0)))*f.sky.w;}
 return envSmooth(envUV(normalize(h)))*f.sky.w;
}

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


const SAME_C=1e-5;

const UNLIKELY=0.02;
fn same(a:vec3f,b:vec3f)->bool {let e=a-b;return dot(e,e)<SAME_C*SAME_C;}
fn rowSel(u0:vec3f,u1:vec3f,u2:vec3f,k:u32)->vec3f {return select(select(u2,u1,k==1u),u0,k==0u);}
fn comp(v:vec3f,k:u32)->f32 {return select(select(v.z,v.y,k==1u),v.x,k==0u);}



fn boxEntry(x:Xform,sz:vec3f,o:vec3f,d:vec3f)->vec2f {
 let lo=xpoint(x,o);let inv=safeInv(xdir(x,d));
 let ta=-lo*inv;let tb=(sz-lo)*inv;let tn=min(ta,tb);let tf=max(ta,tb);
 let t0=max(max(tn.x,tn.y),tn.z);let t1=min(min(tf.x,tf.y),tf.z);
 if(!(t0<t1&&t1>0.0)){return vec2f(4.0,0.0);}
 if(t0<=0.0){return vec2f(3.0,0.0);}
 return vec2f(select(select(2.0,1.0,t0==tn.y),0.0,t0==tn.x),t0);
}

fn boxExit(x:Xform,sz:vec3f,o:vec3f,d:vec3f)->u32 {
 let lo=xpoint(x,o);let inv=safeInv(xdir(x,d));
 let tf=max(-lo*inv,(sz-lo)*inv);let t1=min(min(tf.x,tf.y),tf.z);
 return select(select(2u,1u,t1==tf.y),0u,t1==tf.x);
}

fn flippable(v:vec3f,u0:vec3f,u1:vec3f,u2:vec3f)->u32 {
 return select(0u,1u,abs(dot(v,u0))>=SAME_C)|select(0u,2u,abs(dot(v,u1))>=SAME_C)|select(0u,4u,abs(dot(v,u2))>=SAME_C);
}

fn flipped(v:vec3f,u0:vec3f,u1:vec3f,u2:vec3f,bits:u32)->vec3f {
 var r=v;
 if((bits&1u)!=0u){r-=2.0*dot(v,u0)*u0;}
 if((bits&2u)!=0u){r-=2.0*dot(v,u1)*u1;}
 if((bits&4u)!=0u){r-=2.0*dot(v,u2)*u2;}
 return r;
}








fn glassCandidates(kind:u32,m:Mat,n:vec3f,o:vec3f,medium:u32,mInst:u32,s:vec3f,light:vec3f,lp:f32,w:ptr<function,Walk>) {


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

    let k=j>>3u;let b=j&7u;
    let nout=select(-1.0,1.0,(k&1u)==0u)*rowSel(u0,u1,u2,k>>1u);
    if(dot(nout,s)<=0.0||(b!=0u&&!mirrors)){continue;}
    let tin=refract(-s,nout,1.0/eta);
    if(dot(tin,tin)<0.5){continue;}
    if((b&~(flippable(tin,u0,u1,u2)&~(1u<<(k>>1u))))!=0u){continue;}
    d0=-flipped(tin,u0,u1,u2,b);

    let first=boxExit(x,sz,o,d0);


    if(b==0u&&same(d0,s)&&first!=(k>>1u)){continue;}
    if((b==0u&&first!=(k>>1u))||(b!=0u&&(b&(1u<<first))==0u)){weight=UNLIKELY;}
   } else if(g>0u){


    var axes=7u;var inner=0u;
    if(eta==0.0){

     let nk=select(-1.0,1.0,(j&1u)==0u)*rowSel(u0,u1,u2,j>>1u);
     if(dot(nk,s)<=0.0){continue;}
     d0=reflect(s,nk);axes=1u<<(j>>1u);
    } else if(j<7u){

     if(((j+1u)&~flippable(s,u0,u1,u2))!=0u){continue;}
     d0=flipped(s,u0,u1,u2,j+1u);axes=select(7u,7u&~(j+1u),eta*eta>=2.0);inner=j+1u;
    } else {

     let pair=(j-7u)>>3u;let sg=(j-7u)&7u;
     let a=pair>>1u;let bb=(a+1u+(pair&1u))%3u;let cc=3u-a-bb;
     let tA=abs(comp(c,a))/eta;let dC=abs(comp(c,cc));let tC=dC/eta;
     let tB2=1.0-tA*tA-tC*tC;
     if(tB2<0.0){continue;}
     let dB=eta*sqrt(tB2);
     let dA2=1.0-dB*dB-dC*dC;
     if(dA2<0.0){continue;}

     let ax=vec3u(0u,1u,2u);
     let mag=select(vec3f(0.0),vec3f(sqrt(dA2)),ax==vec3u(a))+select(vec3f(0.0),vec3f(dB),ax==vec3u(bb))+select(vec3f(0.0),vec3f(dC),ax==vec3u(cc));
     let signs=select(0u,1u,mag.x>=SAME_C)|select(0u,2u,mag.y>=SAME_C)|select(0u,4u,mag.z>=SAME_C);
     if((sg&~signs)!=0u){continue;}
     let q=select(mag,-mag,vec3<bool>((sg&1u)!=0u,(sg&2u)!=0u,(sg&4u)!=0u));
     d0=q.x*u0+q.y*u1+q.z*u2;axes=1u<<a;inner=1u<<bb;
    }
    let be=boxEntry(x,sz,o,d0);let entry=u32(be.x);
    if(entry==4u){continue;}


    if(entry<3u&&(axes&(1u<<entry))==0u){weight=UNLIKELY;}
    else if(entry<3u&&eta>0.0&&inner!=0u){
     let ue=rowSel(u0,u1,u2,entry);let ne=select(ue,-ue,dot(d0,ue)>0.0);
     let ti=refract(d0,ne,1.0/eta);
     if((inner&(1u<<boxExit(x,sz,o+d0*be.y,ti)))==0u){weight=UNLIKELY;}
    }
   }

   if(kind==0u&&m.glass==0.0&&dot(n,d0)<=0.0){continue;}
   offer(w,weight,o,d0,medium,mInst,s,want,light,lp);
  }
 }
}






fn direct(kind:u32,m:Mat,n:vec3f,wo:vec3f,o:vec3f,medium:u32,mInst:u32,w:ptr<function,Walk>,mask:u32)->vec3f {
 var L=vec3f(0.0);
 let air=medium==0u||(material(medium).flags&MEDIA)!=0u;
 for(var q=0u;q<5u;q++){
  var wi=vec3f(0.0);var dist=INF;var radiance=vec3f(0.0);var lp=0.0;var far=false;

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

  let sunOnly=q==0u&&(f.config.z&SUN_DIFFUSE)!=0u;
  let lobes=select(mask,mask&1u,sunOnly);
  if(kind==0u&&lobes==0u){continue;}
  let e=evalAt(kind,m,n,wo,wi,lobes);
  if(q==4u){
   if(any(e.f>vec3f(0.0))){(*w).f=e.f*(*w).light*((*w).total/(*w).weight);(*w).pdf=e.pdf;}else{(*w).total=0.0;}
   continue;
  }

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


 var lastVertex=o;
 var bounces=0u;



 var nd=0u;var ns=0u;var nm=0u;var nu=0u;var nir=0u;
 var feature=true;var tint=vec3f(1.0);var primary=true;
 var diffuse=false;var focused=false;var C=vec3f(0.0);var D=vec3f(0.0);




 var sunPdf=0.0;var jChain=1.0;var chainOk=false;var chainSet=false;
 var glassStart=false;var deflections=0u;var deflectOk=true;var entryDir=vec3f(0.0);

 var lambda=bitcast<f32>(f.lights.w);


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

  if(f.fog.z>0.0&&medium==0u){
   let dl=length(d);let tr=select(exp(-f.fog.x*h.t*dl),0.0,h.inst==NONE);
   let add=thr*fogGlow(d/dl)*(1.0-tr);L+=add;if(focused){C+=add;}else if(bounces<=1u){D+=add;}
   thr*=tr;
   if(h.inst==NONE){break;}
  }


  var scatter=false;var p=o+d*h.t;
  if(medium!=0u){
   let md=mediumOf(medium);
   var ts=INF;
   if(md.sigma>0.0){ts=-log(1.0-rand())/md.sigma;}

   if(any(md.emit!=vec3f(0.0))){let add=thr*md.emit*min(ts,min(h.t,1e30));L+=add;if(focused){C+=add;}else if(bounces<=1u){D+=add;}}
   if(md.sigma>0.0){
    if(ts<h.t){
     thr*=exp(-md.absorb*ts)*md.albedo;
     p=o+d*ts;
     if(feature){feature=false;res.albedo=tint*md.albedo;res.normal=-d;res.primary=select(0.0,1.0,bounces==0u);}


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


   let fade=bitcast<f32>(f.limits.w);
   if(bounces==0u&&fade>0.0&&f.fog.z==0.0&&(h.inst==GROUND||f.groundFade.y>0.0)){
    let w=1.0-exp(-max(0.0,h.t*length(d)-f.groundFade.x)/fade);
    let add=thr*w*skyBehind(d);L+=add;D+=add;thr*=1.0-w;
   }
   if(h.inst==GROUND){


    p.y=f.ground.w;
    n=vec3f(0.0,select(-1.0,1.0,d.y<0.0),0.0);
    off=n*max(1e-4,1e-6*length(p));
    m=groundMat();
    if(bounces==0u&&f.grid2.y>0.0&&gridLine(p,n)){m=lineMat(f.grid.xyz);}
   } else {
    let lx=localX(h.inst);let lp=xpoint(lx,p);
    n=h.sgn*normalize(rowOf(lx,h.axis));
    off=h.sgn*EPS*colOf(worldX(h.inst),h.axis);



    var inner=false;
    let other=h.value==0u||(material(h.value).flags&(MEDIA|SUBSURFACE))==MEDIA;
    skinOut=other&&medium!=0u&&(material(medium).flags&SUBSURFACE)!=0u;
    if(h.value==0u&&medium!=0u){let mc=material(medium);if((mc.flags&CONTACT)!=0u&&rand()>=mc.glass/max(1e-6,1.0-0.4*mc.metal)){inner=true;}}
    if(h.value==0u&&!inner&&!skinOut){

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

    if(bounces==0u&&medium==0u){
     if(f.edges.w>0.0&&edgeBand(h,lp)){m=lineMat(f.edges.xyz);}
     else if(f.grid2.y>1.5&&gridLine(p,n)){m=lineMat(f.grid.xyz);}
    }
   }
   if((m.flags&EMISSIVE)!=0u||m.seen.w>0.0){

    let e=select(m.emission,m.seen.xyz,bounces==0u&&m.seen.w>0.0);
    var lightHit=h;lightHit.t=distance(p,lastVertex);
    let add=thr*e*emitWeight(lightHit,n,d,m.emission,lastPdf);L+=add;if(focused){C+=add;}else if(bounces<=1u){D+=add;}
   }
   let pb=max(0.0,1.0-m.metal-m.glass);
   soft=pb>1e-6||((m.flags&SMOOTH)==0u&&m.metal>0.0);
   if(feature&&(soft||bounces>=3u)){feature=false;res.albedo=tint*m.color;res.normal=n;res.primary=select(0.0,1.0,bounces==0u);}
  }



  // Light sampled at a glossy metal seen from a diffuse vertex is a caustic too (light focused by the metal).
  let skinIn=medium!=0u&&(material(medium).flags&SUBSURFACE)!=0u&&!skinOut;
  if(soft&&!skinIn&&(scatter||bounces<f.config.x)){
   var walk:Walk;
   let lobes=select(0u,1u,nd<f.limits.x)|select(0u,2u,ns<(f.limits.y&0xffffu));
   let add=thr*direct(select(0u,1u,scatter),m,n,-d,p+off,medium,mInst,&walk,lobes);L+=add;
   let caustic=focused||(diffuse&&!scatter&&m.metal>0.5&&m.alpha<GLOSSY);
   if(caustic){C+=add;}else if(bounces==0u){D+=add;}
   if(walk.total>0.0){

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

  let through=s.lobe==3u&&s.transmit&&!inAir&&medium==h.value&&(m.flags&VOXELWISE)!=0u;
  if(through){medium=h.value;mInst=h.inst;o=p-off;continue;}
  if(s.lobe==0u){if(nd>=f.limits.x){done=true;continue;}nd++;}
  else{if(ns>=(f.limits.y&0xffffu)){done=true;continue;}ns++;}
  if(s.lobe<=1u){

   let roughGlass=!inAir&&!clearGlass(material(medium));
   sunPdf=select(s.pdf,0.0,roughGlass);jChain=1.0;chainOk=true;chainSet=inAir;
   glassStart=!inAir;deflections=0u;deflectOk=true;
  } else if(s.lobe==3u&&s.transmit&&clearGlass(m)&&m.glass>=0.999&&inAir){

   jChain*=abs(dot(n,s.wi))*m.ior*m.ior/dot(n,wo);
   entryDir=d;
  } else if(s.lobe==2u&&isMirror(m)&&inAir&&h.inst!=GROUND&&mirrorAt(h.inst)){
   deflections++;
  } else {chainOk=false;}

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
`,Mn=`
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





@group(0) @binding(9) var hin:texture_2d<u32>;
@group(0) @binding(10) var hout:texture_storage_2d<rgba32uint,write>;
fn lum(c:vec3f)->f32 {return dot(c,vec3f(0.2126,0.7152,0.0722));}


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

fn hitPoint(x:f32,y:f32,t:f32)->vec3f {
 let uv=(vec2f(f32(p.tile.x),f32(p.tile.y))+vec2f(x,y))/vec2f(f32(p.tile.z),f32(p.tile.w));
 let o=mix(mix(p.origins[0],p.origins[1],uv.x),mix(p.origins[2],p.origins[3],uv.x),uv.y).xyz;
 let d=mix(mix(p.directions[0],p.directions[1],uv.x),mix(p.directions[2],p.directions[3],uv.x),uv.y).xyz;
 return o+normalize(d)*t;
}

fn viewDir(x:f32,y:f32)->vec3f {
 let uv=(vec2f(f32(p.tile.x),f32(p.tile.y))+vec2f(x,y))/vec2f(f32(p.tile.z),f32(p.tile.w));
 return normalize(mix(mix(p.directions[0],p.directions[1],uv.x),mix(p.directions[2],p.directions[3],uv.x),uv.y).xyz);
}

fn previousPixel(P:vec4f)->vec2f {
 let clip=p.prev*P;
 if(clip.w<=1e-6){return vec2f(-1.0);}
 return vec2f((clip.x/clip.w*0.5+0.5)*f32(p.size.x),(0.5-clip.y/clip.w*0.5)*f32(p.size.y));
}

fn prevHitPoint(x:f32,y:f32,t:f32)->vec3f {
 let uv=(vec2f(f32(p.tile.x),f32(p.tile.y))+vec2f(x,y))/vec2f(f32(p.tile.z),f32(p.tile.w));
 let o=mix(mix(p.prevOrigins[0],p.prevOrigins[1],uv.x),mix(p.prevOrigins[2],p.prevOrigins[3],uv.x),uv.y).xyz;
 let d=mix(mix(p.prevDirections[0],p.prevDirections[1],uv.x),mix(p.prevDirections[2],p.prevDirections[3],uv.x),uv.y).xyz;
 return o+normalize(d)*t;
}
fn albedoAt(i:u32)->vec3f {return max(albedo[i].xyz*p.sigma.w,vec3f(0.02));}


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

 let through=normals[i].w*k<0.5;
 let nrm=select(vec3f(0.0,0.0,1.0),nn/len,len>1e-6);
 var loc=Local(0.0,vec3f(0.0),0.0,0.0);
 if(n<4.0&&!lane&&(p.size.w&128u)!=0u){loc=spatial(g.xy,nrm,t,foot,through);}
 var count=n;




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

     let wide=(1.0+2.0/sqrt(n+nh))/(1.0+2.0/sqrt(n));
     e=(e*n+vec3f(h0,h1.x)*nh)/(n+nh);ev*=n/(n+nh)*wide*wide;count=n+nh;
    }
   }


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


 if(count<4.0){ev=max(ev,loc.v);}
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



  if(st>=4&&(p.size.w&32u)==0u){let lr=log((lum(cq.xyz)+1e-3)/(lp+1e-3));wl*=exp(-lr*lr/(0.96*(1.0+4.0*sqrt(p.sigma.w))));}
  let wt=tap(x)*tap(y)*wn*wg*wl;
  sum+=cq.xyz*wt;vs+=cq.w*wt*wt;ws+=wt;
 }}
 var r=vec4f(sum/ws,vs/(ws*ws));

 if((p.size.w&1u)!=0u){let a=albedoAt(i);let la=max(lum(a),0.02);r=vec4f(r.xyz*a,r.w*la*la);}
 if((p.size.w&512u)!=0u){r+=dst2[i];}
 dst[i]=r;
}

fn filteredAt(q:u32,split:bool)->vec4f {var f=dst[q];if(split){f+=src[q];}return vec4f(f.xyz,max(f.w,0.0));}

fn rawAt(q:u32,g:vec2u)->vec4f {
 let k=p.sigma.w;var cc=vec3f(0.0);var dd=vec3f(0.0);var v=0.0;
 if((p.size.w&2u)!=0u){cc=causticAt(q).xyz*k;v=variance(q,cc,causticAt(q).w*k,1u,g);}
 if((p.size.w&128u)!=0u){dd=directAt(q).xyz*k;v+=variance(q,dd,directAt(q).w*k,2u,g);}
 let r=accum[q].xyz*k;
 return vec4f(r,v+variance(q,r-cc-dd,accum[q].w*k,0u,g));
}



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


 let ef=f.w+max(0.0,max(d1*d1-(vr+vf)*ww/(ws*ws),d2-(2.0+8.0*p.sigma.w)*(vr+vf)));
 let er=max(r.w,vr);

 return mix(f.xyz,r.xyz,clamp(ef/(ef+er+1e-20),0.0,1.0));
}







@compute @workgroup_size(8,8) fn combine(@builtin(global_invocation_id) g:vec3u) {
 let w=p.size.x;let h=p.size.y;
 if(g.x>=w||g.y>=h){return;}
 let i=g.y*w+g.x;

 let split=(p.size.w&130u)!=0u;
 if((p.size.w&8u)==0u){
  dst2[i]=vec4f(weighed(i,g.xy,split),1.0);return;
 }
 let gi=guide[i];let n=1.0/p.sigma.w;

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
`,Nn=`${vn}
${re}
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
${p}
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
`,Pn=(e,t=`1.0.0`,n=import.meta.url)=>s(e,t,n);function Fn(e){return e?.adapterInfo?.vendor===`margo-webgl2`?`webgl2`:`native`}function In(e,t){return Fn(e)===`webgl2`?t():void 0}var Ln=Symbol.for(`margoengine.temporal-camera-source`),Rn=e=>e[Ln]??e,zn={samplesPerFrame:1,maxBounces:8,maxSamples:1024,seed:0,resolutionScale:1,exposure:0,aperture:0,focusDistance:void 0,denoise:!1,lensBlades:0,lensRotation:0,shutter:0,clamp:1/0,toneMapping:`neutral`,gamma:void 0,bounceLimits:void 0,transparentShadows:!0,sunSpecular:!0,sunInMedia:!0,energyCompensation:!0,vignette:0,edges:void 0,grid:void 0,order:20,previousCamera:void 0,projection:`camera`,panoramaFit:`width`,fisheye:{mapping:`equidistant`,fov:180},distortion:void 0},Bn=Object.keys(zn),Vn=[`maxBounces`,`seed`,`resolutionScale`,`aperture`,`focusDistance`,`lensBlades`,`lensRotation`,`shutter`,`previousCamera`,`projection`,`panoramaFit`,`fisheye`,`distortion`,`clamp`,`bounceLimits`,`transparentShadows`,`sunSpecular`,`sunInMedia`,`energyCompensation`,`edges`,`grid`],Hn=(e,t,n,r,i)=>{let a=Y(e,t,n,r,i);if(!Number.isInteger(a))throw RangeError(`VoxelPathTracer ${t} ${a} must be a whole number; ${i}`);return a},Un=(e,t)=>{if(typeof e!=`boolean`)throw TypeError(`VoxelPathTracer ${t} must be true or false`);return e},Wn=65535;function Gn(e){if(e===null)return;if(typeof e!=`object`)throw TypeError(`VoxelPathTracer bounceLimits must be {diffuse?, specular?, scatter?, subsurface?, internalReflections?} or null`);let t=e,n=e=>t[e]===void 0?Wn:e===`subsurface`?Hn(t[e],`bounceLimits.${e}`,1,256,`pass 1 to 256, or leave it out`):Hn(t[e],`bounceLimits.${e}`,1,64,`pass 1 to 64, or leave it out`);return{diffuse:n(`diffuse`),specular:n(`specular`),scatter:n(`scatter`),subsurface:n(`subsurface`),internalReflections:t.internalReflections===void 0?Wn:Hn(t.internalReflections,`bounceLimits.internalReflections`,0,64,`pass 0 to 64, or leave it out`)}}function Kn(e){if(e===null)return;if(typeof e!=`object`)throw TypeError(`VoxelPathTracer edges must be {color, width} or null`);let t=e;return{color:Z(t.color,`VoxelPathTracer edges.color`,!0,`pass linear RGB, 0 or more`),width:Y(t.width,`edges.width`,0,.5,`pass 0 to 0.5 voxels`)}}function qn(e){if(e===null)return;if(typeof e!=`object`)throw TypeError(`VoxelPathTracer grid must be {color, spacing, width, onVoxels?} or null`);let t=e;return{color:Z(t.color,`VoxelPathTracer grid.color`,!0,`pass linear RGB, 0 or more`),spacing:Y(t.spacing,`grid.spacing`,.001,1e6,`pass a distance above 0`),width:Y(t.width,`grid.width`,0,1e6,`pass a half width, 0 or more`),onVoxels:t.onVoxels!==void 0&&Un(t.onVoxels,`grid.onVoxels`)}}function Jn(e,t){if(!e||typeof e!=`object`)throw TypeError(`VoxelPathTracer options must be an object`);let n={...t},r=e;if(r.samplesPerFrame!==void 0&&(n.samplesPerFrame=r.samplesPerFrame===`auto`?`auto`:Hn(r.samplesPerFrame,`samplesPerFrame`,1,64,`pass 1 to 64 or 'auto'`)),r.maxBounces!==void 0&&(n.maxBounces=Hn(r.maxBounces,`maxBounces`,1,64,`pass 1 to 64`)),r.maxSamples!==void 0){let e=Y(r.maxSamples,`maxSamples`,1,1/0,`pass 1 or more, or Infinity`);if(e!==1/0&&!Number.isInteger(e))throw RangeError(`VoxelPathTracer maxSamples ${e} must be a whole number or Infinity`);n.maxSamples=e}if(r.seed!==void 0&&(n.seed=Hn(r.seed,`seed`,0,4294967295,`pass an integer 0 to 4294967295`)),r.resolutionScale!==void 0&&(n.resolutionScale=Y(r.resolutionScale,`resolutionScale`,.1,2,`pass 0.1 to 2`)),r.exposure!==void 0&&(n.exposure=Y(r.exposure,`exposure`,-20,20,`pass EV stops, -20 to 20`)),r.aperture!==void 0&&(n.aperture=Y(r.aperture,`aperture`,0,1e6,`pass a diameter, 0 or more`)),r.focusDistance===null?n.focusDistance=void 0:r.focusDistance!==void 0&&(n.focusDistance=Y(r.focusDistance,`focusDistance`,1e-6,1e9,`pass a distance above 0, or null for automatic focus`)),r.denoise!==void 0&&(n.denoise=r.denoise===`auto`?`auto`:Un(r.denoise,`denoise`)),r.lensBlades!==void 0){let e=Hn(r.lensBlades,`lensBlades`,0,16,`pass 0 (round) or 3 to 16`);if(e===1||e===2)throw RangeError(`VoxelPathTracer lensBlades must be 0 (round) or 3 to 16`);n.lensBlades=e}if(r.lensRotation!==void 0&&(n.lensRotation=Y(r.lensRotation,`lensRotation`,-1e6,1e6,`pass radians`)),r.shutter!==void 0&&(n.shutter=Y(r.shutter,`shutter`,0,1,`pass 0 (off) to 1`)),r.clamp!==void 0){let e=Y(r.clamp,`clamp`,0,1/0,`pass a luminance above 0, or Infinity`);if(!(e>0))throw RangeError(`VoxelPathTracer clamp must be above 0 (Infinity turns it off)`);n.clamp=e}if(r.toneMapping!==void 0){if(r.toneMapping!==`neutral`&&r.toneMapping!==`linear`&&r.toneMapping!==`aces-narkowicz`&&r.toneMapping!==`agx`)throw TypeError(`VoxelPathTracer toneMapping ${String(r.toneMapping)} is unknown; pass 'neutral', 'linear', 'aces-narkowicz' or 'agx'`);n.toneMapping=r.toneMapping}if(`gamma`in r&&(n.gamma=r.gamma===void 0?void 0:Y(r.gamma,`gamma`,1,5,`pass 1 to 5, or undefined for sRGB`)),r.bounceLimits!==void 0&&(n.bounceLimits=Gn(r.bounceLimits)),r.transparentShadows!==void 0&&(n.transparentShadows=Un(r.transparentShadows,`transparentShadows`)),r.sunSpecular!==void 0&&(n.sunSpecular=Un(r.sunSpecular,`sunSpecular`)),r.sunInMedia!==void 0&&(n.sunInMedia=Un(r.sunInMedia,`sunInMedia`)),r.energyCompensation!==void 0&&(n.energyCompensation=Un(r.energyCompensation,`energyCompensation`)),r.vignette!==void 0&&(n.vignette=Y(r.vignette,`vignette`,0,100,`pass 0 (off) or more`)),r.edges!==void 0&&(n.edges=Kn(r.edges)),r.grid!==void 0&&(n.grid=qn(r.grid)),r.order!==void 0&&(n.order=Y(r.order,`order`,-1e9,1e9,`pass a finite frame-graph order`)),r.previousCamera!==void 0&&(n.previousCamera=Yn(r.previousCamera)),r.projection!==void 0){if(r.projection!==`camera`&&r.projection!==`panorama`&&r.projection!==`fisheye`)throw TypeError(`VoxelPathTracer projection ${String(r.projection)} is unknown; pass 'camera', 'panorama' or 'fisheye'`);n.projection=r.projection}if(r.panoramaFit!==void 0){if(r.panoramaFit!==`width`&&r.panoramaFit!==`height`)throw TypeError(`VoxelPathTracer panoramaFit ${String(r.panoramaFit)} is unknown; pass 'width' or 'height'`);n.panoramaFit=r.panoramaFit}if(r.fisheye!==void 0){if(!r.fisheye||typeof r.fisheye!=`object`)throw TypeError(`VoxelPathTracer fisheye must be {mapping?, fov?}`);let e=r.fisheye;if(e.mapping!==void 0&&e.mapping!==`equidistant`&&e.mapping!==`equisolid`&&e.mapping!==`stereographic`)throw TypeError(`VoxelPathTracer fisheye.mapping ${String(e.mapping)} is unknown; pass 'equidistant', 'equisolid' or 'stereographic'`);n.fisheye={mapping:e.mapping??`equidistant`,fov:e.fov===void 0?180:Y(e.fov,`fisheye.fov`,.001,360,`pass degrees above 0 to 360`)}}if(r.distortion!==void 0){if(r.distortion===null)n.distortion=void 0;else{if(typeof r.distortion!=`object`)throw TypeError(`VoxelPathTracer distortion must be {k1?, k2?, p1?, p2?} or null`);let e=r.distortion,t=t=>e[t]===void 0?0:Y(e[t],`distortion.${t}`,-1,1,`pass -1 to 1`);n.distortion={k1:t(`k1`),k2:t(`k2`),p1:t(`p1`),p2:t(`p2`)}}}return n}function Yn(e){if(e===null)return;if(!e||typeof e!=`object`)throw TypeError(`VoxelPathTracer previousCamera must be {position, target, up?, fov?} or null`);let t=e,n=Z(t.position,`previousCamera.position`,!1,`pass a world point`),r=Z(t.target,`previousCamera.target`,!1,`pass a world point`),i=t.up===void 0?void 0:Z(t.up,`previousCamera.up`,!1,`pass a direction`),a=t.fov===void 0?void 0:Y(t.fov,`previousCamera.fov`,.001,179.999,`pass degrees`);if(n.every((e,t)=>e===r[t]))throw RangeError(`VoxelPathTracer previousCamera.position equals its target; pass a distinct target`);return{position:n,target:r,up:i,fov:a}}function Xn(e){let t=e.bounceLimits,n=e=>e===65535?void 0:e;return{...e,fisheye:{...e.fisheye},bounceLimits:t&&{diffuse:n(t.diffuse),specular:n(t.specular),scatter:n(t.scatter),subsurface:n(t.subsurface),internalReflections:n(t.internalReflections)},edges:e.edges&&{...e.edges},grid:e.grid&&{...e.grid},previousCamera:e.previousCamera&&{...e.previousCamera},distortion:e.distortion&&{...e.distortion}}}Object.freeze(Xn(zn));function Zn(e,t){if(t===void 0)return{...zn};if(typeof t!=`object`||!t||!(Symbol.iterator in t))throw TypeError(`VoxelPathTracer resetOptions takes a list of option names, or nothing for all of them; pass an array of names`);let n={...e};for(let e of t){if(typeof e!=`string`||!Bn.includes(e))throw TypeError(`VoxelPathTracer resetOptions: ${String(e)} is not an option; pass names such as 'focusDistance' or 'exposure'`);n[e]=zn[e]}return n}var Qn;function $n(){Qn=new Int32Array(2048);for(let e=0;e<256;e++){let t=e;for(let e=0;e<8;e++)t=t&1?3988292384^t>>>1:t>>>1;Qn[e]=t}for(let e=0;e<256;e++)for(let t=1;t<8;t++){let n=Qn[(t-1)*256+e];Qn[t*256+e]=n>>>8^Qn[n&255]}return Qn}function er(e,t=0){let n=Qn??$n(),r=e.length,i=r-(r&7),a=~t,o=0;for(;o<i;o+=8)a^=e[o]|e[o+1]<<8|e[o+2]<<16|e[o+3]<<24,a=n[1792+(a&255)]^n[1536+(a>>>8&255)]^n[1280+(a>>>16&255)]^n[1024+(a>>>24)]^n[768+e[o+4]]^n[512+e[o+5]]^n[256+e[o+6]]^n[e[o+7]];for(;o<r;o++)a=n[(a^e[o])&255]^a>>>8;return~a>>>0}var tr=Object.freeze([137,80,78,71,13,10,26,10]);function nr(e,t,n,r){if(e===1)return t;if(e===2)return n;if(e===3)return t+n>>1;if(e===4){let e=t+n-r,i=Math.abs(e-t),a=Math.abs(e-n),o=Math.abs(e-r);return i<=a&&i<=o?t:a<=o?n:r}return 0}var rr=(e,t)=>{let n=new Uint8Array(t.length+12),r=new DataView(n.buffer);r.setUint32(0,t.length);for(let t=0;t<4;t++)n[4+t]=e.charCodeAt(t);return n.set(t,8),r.setUint32(t.length+8,er(n.subarray(4,t.length+8))),n};function ir(e,t,n,r){let i=new Uint8Array(13),a=new DataView(i.buffer);return a.setUint32(0,e),a.setUint32(4,t),i[8]=8,i[9]=n,[Uint8Array.from(tr),rr(`IHDR`,i),rr(`IDAT`,r),rr(`IEND`,new Uint8Array)]}var ar=class{#e=0;#t;#n;#r;#i;#a;constructor(e,t,n=!1){this.width=e,this.height=t,this.channels=n?4:3;let r=new CompressionStream(`deflate`);this.#t=r.writable.getWriter();let i=r.readable.getReader(),a=[];this.#n=(async()=>{for(;;){let{done:e,value:t}=await i.read();if(e)return a;a.push(t)}})(),this.#n.catch(()=>{});let o=e*this.channels;this.#r=new Uint8Array(o),this.#i=new Uint8Array(o),this.#a=Array.from({length:5},()=>new Uint8Array(o+1))}async write(e,t){let n=this.channels,r=this.width*n;for(let i=0;i<t;i++){let t=e.subarray(i*r,(i+1)*r),a=this.#r,o=this.#a[0],s=1/0;for(let e=0;e<5;e++){let i=this.#a[e];i[0]=e;let c=0;for(let o=0;o<r;o++){let r=o>=n?t[o-n]:0,s=a[o],l=o>=n?a[o-n]:0,u=t[o]-nr(e,r,s,l)&255;i[o+1]=u,c+=u<128?u:256-u}c<s&&(s=c,o=i)}await this.#t.ready,await this.#t.write(o.slice()),this.#i.set(t),[this.#r,this.#i]=[this.#i,this.#r],this.#e++}}async finish(){if(this.#e!==this.height)throw RangeError(`PNG has ${this.#e} of ${this.height} rows; write every row before finish`);await this.#t.close();let e=await this.#n,t=0;for(let n of e)t+=n.length;let n=new Uint8Array(t),r=0;for(let t of e)n.set(t,r),r+=t.length;return new Blob(ir(this.width,this.height,this.channels===4?6:2,n),{type:`image/png`})}abort(){this.#t.abort().catch(()=>{})}},or=8192;function sr(e,t,n,r={}){for(let[n,r]of[[`width`,e],[`height`,t]])if(!Number.isInteger(Y(r,`viewport ${n}`,1,1<<20,`pass the drawing buffer size in pixels`)))throw RangeError(`VoxelPathTracer viewport ${n} ${r} must be a whole number of pixels`);if(!n||typeof n!=`object`)throw TypeError(`VoxelPathTracer viewport limits must be the device limits {maxStorageBufferBindingSize, ...}`);let i=Y(n.maxStorageBufferBindingSize,`maxStorageBufferBindingSize`,16,2**53-1,`pass the device limits (device.limits)`),a=n.maxTextureDimension2D===void 0?or:Y(n.maxTextureDimension2D,`maxTextureDimension2D`,1,1<<20,`pass the device limits`),o=r.resolutionScale===void 0?1:Y(r.resolutionScale,`resolutionScale`,.1,2,`pass 0.1 to 2`),s=Math.max(1,Math.round(e*o)),c=Math.max(1,Math.round(t*o)),l=Math.floor(i/16),u=s,d=c,f;if(u*d>l){let e=Math.sqrt(l/(u*d));u=Math.max(1,Math.floor(u*e)),d=Math.max(1,Math.floor(d*e)),f=`storage-binding`}if((r.denoise??!1)!==!1&&Math.max(u,d)>a){let e=a/Math.max(u,d);u=Math.max(1,Math.min(a,Math.floor(u*e))),d=Math.max(1,Math.min(a,Math.floor(d*e))),f=`texture-dimension`}return{width:u,height:d,requestedWidth:s,requestedHeight:c,...f?{limitedBy:f}:{}}}var cr=1e-12,lr=e=>1/(Math.abs(e)<cr?e<0?-1e-12:cr:e),ur=(e,t)=>t<0?Math.ceil(e)-1:Math.floor(e);function dr(e,t,n,r,i,a,o,s){let c=i+Math.min((a-i)*.5,1e-4),l=[0,0,0],u=[1/0,1/0,1/0];for(let e=0;e<3;e++)l[e]=+(t[e]+n[e]*c-r[e]>=.5),(n[e]>0&&!l[e]||n[e]<0&&l[e])&&(u[e]=(r[e]+.5-t[e])*lr(n[e]));let d=i,f=o;for(let t=0;t<4;t++){if((e>>(l[0]|l[1]<<1|l[2]<<2)&1)==1===s)return[d,f];if(d=Math.min(u[0],u[1],u[2]),!(d<a))return;f=u[0]===d?0:u[1]===d?1:2,l[f]^=1,u[f]=1/0}}function fr(e,t,n,r,i,a,o,s,c,l,u){let[d,f,p]=e.size,[m,h,g]=e.bricks,_=lr(i),v=lr(a),y=lr(o),b=-t*_,x=(d-t)*_,S=-n*v,C=(f-n)*v,w=-r*y,T=(p-r)*y,E=Math.min(b,x),D=Math.min(S,C),O=Math.min(w,T),k=Math.max(b,x),A=Math.max(S,C),j=Math.max(w,T),M=Math.max(E,D,O,s),N=Math.min(k,A,j,c);if(!(M<N))return!1;let P=3;M>s&&(P=M===E?0:M===D?1:2);let ee=i>=0?1:-1,F=a>=0?1:-1,I=o>=0?1:-1,te=+(i>=0),ne=+(a>=0),re=+(o>=0),L=Math.abs(_),R=Math.abs(v),z=Math.abs(y),B=(e,t,n)=>e<t?t:e>n?n:e,V=B(ur((t+i*M)/8,i),0,m-1),H=B(ur((n+a*M)/8,a),0,h-1),ie=B(ur((r+o*M)/8,o),0,g-1),ae=((V+te)*8-t)*_,oe=((H+ne)*8-n)*v,se=((ie+re)*8-r)*y,U=M,ce=(e,t,n,r,s,c)=>{let l=n,d;if(l===3){let e=[Math.abs(i),Math.abs(a),Math.abs(o)];l=e[0]>=e[1]&&e[0]>=e[2]?0:e[1]>=e[2]?1:2}return d=-[ee,F,I][l],u.t=e,u.value=t,u.axis=l,u.sign=d,u.cell=[r,s,c],!0};for(;;){let s=e.grid[V+m*(ie+g*H)],c=Math.min(ae,oe,se,N),u=V*8,b=H*8,x=ie*8,S=Math.min(u+8,d)-1,C=Math.min(b+8,f)-1,w=Math.min(x+8,p)-1;if(s===0||s>=2147483648){let e=s===0?0:s&255;if(e!==l)return ce(U,e,P,B(ur(t+i*U,i),u,S),B(ur(n+a*U,a),b,C),B(ur(r+o*U,o),x,w))}else{let d=((s&~it)-1)*128,f=(s&it)!==0,p=B(ur(t+i*U,i),u,S),m=B(ur(n+a*U,a),b,C),h=B(ur(r+o*U,o),x,w),g=(p+te-t)*_,T=(m+ne-n)*v,E=(h+re-r)*y,D=U,O=P;for(;;){let s=p-u+8*(h-x+8*(m-b)),_=e.payload[d+(s>>2)]>>>(s&3)*8&255,v=f&&_?e.payload[d+128+(s>>2)]>>>(s&3)*8&255:0;if(v){let e=[t,n,r],s=[i,a,o],c=[p,m,h],u=Math.min(g,T,E);if(_===l){let t=dr(v,e,s,c,D,u,O,!1);if(t)return ce(t[0],0,t[1],p,m,h)}else{let t=dr(v,e,s,c,D,u,O,!0);if(l!==0&&(!t||t[0]>D))return ce(D,0,O,p,m,h);if(t)return ce(t[0],_,t[1],p,m,h)}}else if(_!==l)return ce(D,_,O,p,m,h);if(g<T&&g<E?(O=0,D=g,p+=ee,g+=L):T<E?(O=1,D=T,m+=F,T+=R):(O=2,D=E,h+=I,E+=z),D>=c||p<u||m<b||h<x||p>S||m>C||h>w)break}}if(c>=N||(ae<oe&&ae<se?(P=0,U=ae,V+=ee,ae+=L*8):oe<se?(P=1,U=oe,H+=F,oe+=R*8):(P=2,U=se,ie+=I,se+=z*8),V<0||H<0||ie<0||V>=m||H>=h||ie>=g))break}return l!==0&&ce(N,0,k<=A&&k<=j?0:A<=j?1:2,Math.floor(t+i*N),Math.floor(n+a*N),Math.floor(r+o*N))}function pr(e,t,n,r){let i=Math.hypot(n[0],n[1],n[2]),a=[n[0]/i,n[1]/i,n[2]/i],o={t:0,value:0,axis:0,sign:0,cell:[0,0,0]},s,c=r;for(let[n,r]of e.instances.entries()){let i=r.box,l=0,u=c;for(let e=0;e<3&&l<=u;e++){let n=lr(a[e]),r=(i[e]-t[e])*n,o=(i[e+3]-t[e])*n;l=Math.max(l,Math.min(r,o)),u=Math.min(u,Math.max(r,o))}if(l>u)continue;let d=r.toLocal,f=[0,1,2].map(e=>d[e*4]*t[0]+d[e*4+1]*t[1]+d[e*4+2]*t[2]+d[e*4+3]),p=[0,1,2].map(e=>d[e*4]*a[0]+d[e*4+1]*a[1]+d[e*4+2]*a[2]);fr(e.models[r.model],f[0],f[1],f[2],p[0],p[1],p[2],0,c,0,o)&&o.t<c&&(c=o.t,s={instance:n,hit:{...o,cell:[...o.cell]},distance:o.t})}return s}function mr(e){return e?.view?.viewport}function hr(e,t){let n=mr(t);if(!n)return;e.setViewport(n[0],n[1],n[2],n[3],0,1);let r=t.view.scissor??n;e.setScissorRect(r[0],r[1],r[2],r[3])}var gr=e=>typeof e==`string`&&e.endsWith(`float`),_r=e=>e.device.voxelTraceWork??e.pacer.budget,vr=(128<<20)/4,yr=1024,br=64,xr=64,Sr=5,Cr=6,wr=1.5,Tr=4,Er=5,Dr=12,Or=19,kr=176,Ar=512,jr=368,Mr=4,Nr=class{constructor(e,t){this.runs=t>e?[e,t-e]:[]}alloc(e){let t=this.runs;for(let n=0;n<t.length;n+=2)if(t[n+1]>=e){let r=t[n];return t[n]+=e,t[n+1]-=e,t[n+1]||t.splice(n,2),r}return-1}release(e,t){let n=this.runs,r=0;for(;r<n.length&&n[r]<e;)r+=2;r<n.length&&e+t===n[r]?(n[r]=e,n[r+1]+=t):n.splice(r,0,e,t),r&&n[r-2]+n[r-1]===e&&(n[r-1]+=n[r+1],n.splice(r,2))}},Pr=e=>e.caustics?+!!e.focusing|(e.direct?2:0):0,Fr=0,Ir=new WeakMap,Lr=(e,t)=>{let n=Ir.get(e);if(!n){let t=n={lost:!1,states:new Set};Ir.set(e,t),e.lost?.then(()=>{t.lost=!0;for(let e of t.states)e.lost=!0;t.states.clear()})}n.lost?t.lost=!0:n.states.add(t)},Rr=(e,t)=>Ir.get(e)?.states.delete(t),zr=(e,t)=>{if(t.shutter>0&&e.motionError)throw e.motionError;return e},Br=e=>{let t=new Uint32Array(Float32Array.from(e).buffer),n=2166136261;for(let e of t)n=Math.imul(n^e,16777619);return n>>>0},Vr=e=>{if(e?.aborted)throw e.reason??new DOMException(`The render was aborted`,`AbortError`)},Hr=class{coreRequirement=r(`1.0.0`,import.meta.url);#e;#t;#n;#r;#i;#a;#o;#s;#c;#l;#u;#d;#f;#p;#m;#h;#g;#_;#v;#y;#b;#x;#S;#C;#w;#T;#E;#D;#O;#k;#A;#j;constructor(e){if(this.name=`voxel-pathtracer:${Fr++}`,this.#r=!1,this.#i=!0,this.#o={models:new Map,emitters:new WeakMap},this.#c=1,this.#u=`compiling`,this.#f=1,this.#p=0,this.#m=64,this.#h=0,this.#g=0,this.#y=new Map,this.#b=0,this.#x=this.#I(),this.#S=0,this.#C=-1,this.#w=0,this.#T=0,this.#E=Promise.resolve(),this.#D=0,this.#O=new ArrayBuffer(800),this.#k=new Float32Array(kr/4),this.#A=new Float64Array(16),this.#j=new Float32Array(32),!e||typeof e!=`object`)throw TypeError(`VoxelPathTracer.attach expects (engine, {scene, ...options})`);let{scene:t,...n}=e;this.#a=Jn(n,zn),this.#s=zr(Jt(t,this.#o,vr),this.#a),this.#B()}static attach(e,t){a(e,r(`1.0.0`,import.meta.url));let n=new this(t);try{Pn(e).use(n)}catch(e){throw n.dispose(),e}return n}tracingSource(){return jn}sceneWordReserve(){return 0}sceneStorage(e){return e}geometryMoving(){return!1}imageInstance(e){return e===-2?-2:e===-3?-3:-1}get enabled(){return this.#i}set enabled(e){if(Un(e,`enabled`),e&&!this.#i&&this.#N(),!e)for(let e of this.#y.values())e.shown=!1;this.#i=e}get stats(){let e=this.#x;return{samples:e.previewing?0:e.samples,frameMs:e.frameMs,gpuBytes:this.#w,converged:e.shown&&!e.previewing&&e.samples>=this.#a.maxSamples,width:e.width,height:e.height,requestedWidth:e.requested[0],requestedHeight:e.requested[1],...e.limitedBy?{limitedBy:e.limitedBy}:{},sceneRevision:this.#s.revision,packedModels:this.#s.packedModels,reusedModels:this.#s.reusedModels,renders:this.#D}}get ready(){return this.#_}get status(){return this.#u}get error(){return this.#d}get options(){return Xn(this.#a)}setScene(e){this.#z();let t=this.#l?Math.floor(this.#l.device.limits.maxStorageBufferBindingSize/4):vr;this.#s=zr(Jt(e,this.#o,t,this.sceneWordReserve()),this.#a),this.#c++;for(let e of this.#y.values())this.#P(e,!1)}setOptions(e){if(this.#z(),e&&typeof e==`object`&&`scene`in e)throw TypeError(`VoxelPathTracer setOptions does not take a scene; call setScene`);this.#M(Jn(e,this.#a))}resetOptions(e){this.#z(),this.#M(Zn(this.#a,e))}#M(e){zr(this.#s,e);let t=this.#a;this.#a=e,Vn.some(n=>!Object.is(t[n],e[n]))&&this.#N(),e.order!==t.order&&this.#t&&this.#V(this.#t)}invalidateModels(e){if(this.#z(),e!==void 0&&(typeof e!=`object`||!e||!(Symbol.iterator in e)))throw TypeError(`VoxelPathTracer invalidateModels takes a list of model ids, or nothing for all of them; pass an array of ids`);let t=e===void 0?void 0:[...e];if(t?.some(e=>typeof e!=`string`))throw TypeError(`VoxelPathTracer invalidateModels takes model ids (strings); pass ids from your models`);let n=this.#o;if(!t)n.models.clear(),n.keys?.clear();else for(let e of t){let t=n.models.get(e);if(t){if(n.models.delete(e),n.keys)for(let[e,r]of n.keys)r===t&&n.keys.delete(e);for(let[e,r]of n.models)r===t&&n.models.delete(e)}}}async whenIdle(){await this.#E;let e=this.#l;if(e&&!e.lost&&!this.#r)try{await e.device.queue.onSubmittedWorkDone()}catch{}}reset(){this.#z(),this.#N()}#N(){for(let e of this.#y.values())this.#P(e,!0)}#P(e,t,n=!1){n?e.held=e.samples||e.held:(e.held=0,e.cut++),e.samples=0,e.epoch++,t&&(e.history.valid=!1)}#F(e,t){return t.cut===e.cut&&(t.s0===0||t.epoch===e.epoch)}#I(){return{serial:this.#b++,samples:0,epoch:0,cut:0,held:0,matrix:new Float64Array(16),key:new Float64Array(30),history:{matrix:new Float32Array(16),corners:new Float32Array(32),version:-1,width:0,height:0,valid:!1},restarted:!1,previewing:!1,shown:!1,frameMs:0,lastTrace:0,width:0,height:0,requested:[0,0],limitedBy:void 0,corners:new Float32Array(32),drawn:this.#S,released:!1,routeKeys:new Set}}#L(e){let t=e.view?.id??``,n=this.#y.get(t);return n||this.#y.set(t,n=this.#I()),n.drawn=this.#S,this.#x=n,n}#R(e){let t=e.image;e.image=void 0,e.routeJob=void 0,e.samples=0,e.held=0,e.epoch++,e.cut++;for(let t of e.routeKeys)this.#l?.routeReady?.release(t);e.routeKeys.clear(),t&&(this.#J(t),this.#U(t.frame),this.#U(t.uniform),this.#U(t.bands?.frames))}onPreUpdate(e){if(e>0){this.#S++;for(let[e,t]of this.#y)this.#S-t.drawn>Mr&&(this.#y.delete(e),t.released=!0,this.#R(t))}}raycast(e,t,n=1/0){this.#z();let r=Z(e,`raycast origin`,!1,`pass a world point`),i=Z(t,`raycast direction`,!1,`pass a direction`);if(!(Math.hypot(i[0],i[1],i[2])>0))throw RangeError(`VoxelPathTracer raycast direction is zero; pass a non-zero direction`);Y(n,`raycast maxDistance`,0,1/0,`pass a distance, 0 or more`);let a=this.#s,o=pr(a,r,i,n);if(!o)return null;let s=a.instances[o.instance],{hit:c,distance:l}=o,u=[0,0,0],d=Math.hypot(i[0],i[1],i[2]);return u[c.axis]=c.sign,{instanceId:s.id,modelId:a.modelIds[s.model],cell:c.cell,normal:u,adjacent:[c.cell[0]+u[0],c.cell[1]+u[1],c.cell[2]+u[2]],paletteIndex:c.value,distance:l,point:[r[0]+i[0]/d*l,r[1]+i[1]/d*l,r[2]+i[2]/d*l]}}capture(e){return this.#fe(async()=>{let t=this.#pe(e,1<<26),n={...this.#a},r=new ar(t.width,t.height,t.transparent),i=r.channels;try{return await this.#me(t,!1,async(e,a,o)=>{let s=new Uint8Array(t.width*a*i);fe(n,t.width,t.height,e,a,o.color,o.alpha,i,s),await r.write(s,a)}),await r.finish()}catch(e){throw r.abort(),e}})}renderImage(e){return this.#fe(async()=>{let t=this.#pe(e,1<<24),n=t.width*t.height,r=new Float32Array(n*3),i=e.aovs===!0,a=i?new Float32Array(n*3):void 0,o=i?new Float32Array(n*3):void 0,s=i?new Float32Array(n):void 0,c=i?new Int32Array(n):void 0,l=i?new Uint8Array(n):void 0,u=t.transparent?new Float32Array(n):void 0,d=this.#s.instances.map(e=>e.source);return await this.#me(t,i,async(e,n,f)=>{let p=e*t.width;if(r.set(f.color,p*3),u&&u.set(f.alpha,p),i){a.set(f.albedo,p*3),o.set(f.normal,p*3),s.set(f.depth,p);for(let e=0;e<t.width*n;e++){let t=f.ids[e];t>=256?(c[p+e]=d[Math.floor(t/256)-1]??-1,l[p+e]=t%256):c[p+e]=this.imageInstance(t)}}}),{width:t.width,height:t.height,samples:t.samples,color:r,albedo:a,normal:o,depth:s,instance:c,palette:l,...u?{alpha:u}:{}}})}setup(e){this.#z();let t=e.gpu;if(!t)throw new f(`unsupported`,`VoxelPathTracer needs WebGPU or the WebGL2 compatibility layer; see https://margoengine.com/errors#voxel-pathtracer`);this.#e=e,this.#K(t)}registerPasses(e){this.#t=e,this.#V(e)}onDeviceRestored(e){this.#r||(this.#q(),e.gpu&&this.#K(e.gpu))}dispose(){if(!this.#r){this.#r=!0;try{this.#n?.()}catch{}this.#e?.sceneOf(this)?.removePlugin(this.name),this.#q(),this.#e=this.#t=this.#n=void 0,this.#u===`compiling`&&this.#v?.[1](new f(`disposed`,`VoxelPathTracer is disposed`)),this.#u=`disposed`}}[Symbol.dispose](){this.dispose()}#z(){if(this.#r)throw new f(`disposed`,`VoxelPathTracer is disposed; attach a new one`)}#B(){this.#_=new Promise((e,t)=>{this.#v=[e,t]}),this.#_.catch(()=>{})}#V(e){this.#n?.(),this.#n=e.add({name:this.name,order:this.#a.order,execute:e=>{if(e.backend!==`webgpu`||!this.#i||this.#r)return;let t=e.camera;e.camera=Rn(t);try{this.#de(e)}finally{e.camera=t}}})}#H(e,t,n){let r=e.device.createBuffer({size:Math.max(16,Math.ceil(t/4)*4),usage:n});return this.#w+=r.size,r}#U(e){e&&(this.#w-=e.size,e.destroy())}#W(e,t,n){let r=e.device.createTexture({size:[t,n],format:`rgba32uint`,usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.STORAGE_BINDING});return this.#w+=t*n*16,r}#G(e){e&&(this.#w-=e.width*e.height*16,e.destroy())}#K(e){if(this.#l?.device===e)return this.#l;Zt(this.#s,Math.floor(e.limits.maxStorageBufferBindingSize/4),this.sceneWordReserve()),this.#l&&this.#q();let n=GPUShaderStage.COMPUTE,r=GPUShaderStage.FRAGMENT,i=(e,t,r=n)=>({binding:e,visibility:r,buffer:{type:t}}),a=e.createBindGroupLayout({entries:[i(0,`uniform`),i(1,`uniform`),i(2,`read-only-storage`),i(3,`read-only-storage`),i(4,`read-only-storage`),i(5,`read-only-storage`),i(6,`storage`),i(7,`storage`),i(8,`storage`),i(9,`uniform`),i(10,`storage`)]}),o=e.createBindGroupLayout({entries:[i(0,`storage`)]}),s=e.createBindGroupLayout({entries:[i(0,`uniform`),i(1,`read-only-storage`),i(2,`read-only-storage`),i(3,`read-only-storage`),i(4,`read-only-storage`),i(5,`storage`),i(6,`storage`),i(7,`read-only-storage`),i(8,`storage`),{binding:9,visibility:n,texture:{sampleType:`uint`}},{binding:10,visibility:n,storageTexture:{access:`write-only`,format:`rgba32uint`}}]}),c=e.createBindGroupLayout({entries:[i(0,`uniform`,GPUShaderStage.VERTEX|r),i(1,`read-only-storage`,r),i(2,`read-only-storage`,r)]}),l=GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC,u={device:e,lost:!1,pacer:new hn,traceLayout:a,denoiseLayout:s,displayLayout:c,display:new Map,buffers:void 0,tables:void 0,tableScratch:void 0,dummy:void 0,dummyRead:void 0,dummyHistory:void 0,capacity:0,runs:new Nr(4,4),regions:new Map,version:0,resources:0};this.#l=u,Fn(e)===`webgl2`&&(u.inputs=new WeakMap),u.route=In(e,()=>t(()=>import(`./compat-Ck_Be4SE-C7-lenRd.js`),[],import.meta.url))?.then(({TraceRoute:t})=>u.routeReady=new t(e,this.tracingSource())),u.buffers={table0:this.#H(u,32768,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC),materials:this.#H(u,16,l),voxels:this.#H(u,16,l),scene:this.#H(u,16,l),env:this.#H(u,16,l)},u.tables=this.#H(u,kn*16,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST),u.tableScratch=this.#H(u,kn*16,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC),u.dummy=this.#H(u,16,GPUBufferUsage.STORAGE),u.dummyRead=this.#H(u,16,GPUBufferUsage.STORAGE),u.dummyHistory=[this.#W(u,1,1),this.#W(u,1,1)],u.capacity=4,Lr(e,u);for(let e of this.#y.values())this.#P(e,!1);this.#u!==`compiling`&&this.#B(),this.#u=`compiling`;let d=u.traceModule=e.createShaderModule({code:this.tracingSource()}),f=e.createShaderModule({code:Mn}),p=e.createShaderModule({code:An}),m=t=>e.createPipelineLayout({bindGroupLayouts:[t]}),h=(t,n,r)=>e.createComputePipelineAsync({label:`voxel-pathtracer ${n}`,layout:m(r),compute:{module:t,entryPoint:n}});return u.route||h(d,`preview`,a).then(e=>{this.#l===u&&!this.#r&&!u.pipelines&&(u.preview=e)},()=>{}),Promise.all([this.#oe(u,!1),h(d,`ids`,a),h(f,`prepare`,s),h(f,`atrous`,s),h(p,`tables`,o),h(f,`combine`,s)]).then(([t,n,r,i,a,s])=>{if(this.#l!==u||this.#r)return;let c=e.createCommandEncoder(),l=c.beginComputePass();l.setPipeline(a),l.setBindGroup(0,e.createBindGroup({layout:o,entries:[{binding:0,resource:{buffer:u.tableScratch}}]})),l.dispatchWorkgroups(Math.ceil(kn*4/64)),l.end(),c.copyBufferToBuffer(u.tableScratch,0,u.tables,0,kn*16),e.queue.submit([c.finish()]),u.pipelines={trace:t,ids:n,prepare:r,atrous:i,combine:s},this.#u=`ready`,this.#v?.[0]()},e=>{this.#l!==u||this.#r||(this.#u=`failed`,this.#d=e,this.#v?.[1](e),this.#e?.onError(e))}),u}#q(){let e=this.#l;if(e){this.#l=void 0,Rr(e.device,e),e.routeReady?.destroy();for(let t of Object.values(e.buffers))this.#U(t);this.#U(e.tables),this.#U(e.tableScratch),this.#U(e.dummy),this.#U(e.dummyRead);for(let t of e.dummyHistory)this.#G(t);for(let e of this.#y.values())e.routeKeys.clear(),this.#R(e)}}#J(e){if(e){for(let t of[e.accum,e.albedo,e.normals,e.ping,e.pong,e.guide,e.params,e.caustics,e.cping,e.cpong])this.#U(t);this.#U(e.dpong);for(let t of[...e.history??[],...e.dhistory??[]])this.#G(t);e.ping=e.pong=e.guide=e.params=e.caustics=e.cping=e.cpong=e.history=void 0,e.dpong=e.dhistory=e.directGroups=void 0,e.denoiseGroups=void 0}}#Y(e){if(e.version===this.#c)return;let t=this.#s,n=e.device,r=Math.floor(n.limits.maxStorageBufferBindingSize/4),i=GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC,a=new Set(t.models);for(let[t,n]of e.regions)a.has(t)||(e.runs.release(n,t.grid.length+t.payload.length),e.regions.delete(t));let o=t=>{let r=t.grid.length+t.payload.length,i=e.runs.alloc(r);return i<0?!1:(e.regions.set(t,i),n.queue.writeBuffer(e.buffers.voxels,i*4,cn(t,i)),!0)},s=!0;for(let n of t.models)if(!e.regions.has(n)&&!(s=o(n)))break;if(!s){let n=Math.min(r,Math.max(t.voxelWords*2,65536));this.#U(e.buffers.voxels),e.buffers.voxels=this.#H(e,n*4,i),e.capacity=n,e.runs=new Nr(4,n),e.regions.clear();for(let n of t.models)e.regions.has(n)||o(n);e.resources++}let c=ln(t),l=un(t,t.models.map(t=>e.regions.get(t)),c),u=(t,a)=>{if(e.buffers[t].size<a.byteLength){this.#U(e.buffers[t]);let n=Math.max(a.byteLength,Math.min(e.buffers[t].size*2,r*4));e.buffers[t]=this.#H(e,n,i),e.resources++}a.byteLength&&n.queue.writeBuffer(e.buffers[t],0,a)};l.words=this.sceneStorage(l.words),u(`scene`,l.words);let d=t.environment.map;d&&d!==e.envSource&&(u(`env`,d.texels),e.envSource=d),t.materials.length>8192&&u(`materials`,t.materials),n.queue.writeBuffer(e.buffers.table0,0,t.materials,0,8192),e.layout={scene:l,lights:c},e.version=this.#c}#X(e,t,n,r,i,a,o=!1){let s=GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC,c=n*r*16,l=t;if((!l||l.width!==n||l.height!==r)&&(this.#J(l),l={...l??{},width:n,height:r,accum:this.#H(e,c,s),albedo:this.#H(e,c,s),normals:this.#H(e,c,s)},e.resources++),l.ping&&(!i||l.focusing!==a)){for(let e of[l.ping,l.pong,l.guide,l.params,l.caustics,l.cping,l.cpong,l.dpong])this.#U(e);for(let e of[...l.history??[],...l.dhistory??[]])this.#G(e);l.ping=l.pong=l.guide=l.params=l.caustics=l.cping=l.cpong=l.history=void 0,l.dpong=l.dhistory=l.directGroups=void 0,l.denoiseGroups=void 0,e.resources++}if(i&&!l.ping){l.ping=this.#H(e,c,s),l.pong=this.#H(e,c,s),l.guide=this.#H(e,c,s),o&&(l.history=[this.#W(e,n,r),this.#W(e,n,r)]);let t=c*(a?2:1)<=e.device.limits.maxStorageBufferBindingSize;l.focusing=a,l.direct=t,l.lanes=a&&t?2:1,l.dflip=0,(a||t)&&(l.caustics=this.#H(e,c*l.lanes,s)),a&&(l.cping=this.#H(e,c,s),l.cpong=this.#H(e,c,s)),t&&(a||(l.dpong=this.#H(e,c,s)),o&&(l.dhistory=[this.#W(e,n,r),this.#W(e,n,r)])),l.params=this.#H(e,Ar*Or,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);let i=[],u=l,d=t=>t??e.dummyRead,[f,p]=u.history??e.dummyHistory,[m,h]=e.dummyHistory,g=u.dpong??u.cpong,[_,v]=u.dhistory??e.dummyHistory,y=(n,r)=>{let i=n-Sr,a=n-Dr,o=n===18,[s,c]=n===0?[u.pong,u.ping]:n<=Sr?n%2?[u.ping,u.pong]:[u.pong,u.ping]:i<=Cr?i%2?[u.cping,u.cpong]:[u.cpong,u.cping]:a===0?[u.pong,u.ping]:o?[t?g:d(u.cping),u.pong]:a%2?[u.ping,g]:[g,u.ping],l=a===0?r?v:_:u.history?n===0?f:o?p:m:m,y=a===0?r?_:v:u.history?n===0?p:o?f:h:h;return e.device.createBindGroup({layout:e.denoiseLayout,entries:[{binding:0,resource:{buffer:u.params,offset:n*Ar,size:jr}},{binding:1,resource:{buffer:u.accum}},{binding:2,resource:{buffer:u.albedo}},{binding:3,resource:{buffer:u.normals}},{binding:4,resource:{buffer:s}},{binding:5,resource:{buffer:c}},{binding:6,resource:{buffer:u.guide}},{binding:7,resource:{buffer:d(u.caustics)}},{binding:8,resource:{buffer:n===0?u.cping??e.dummy:o?u.ping:a===Er&&u.cping?u.cping:e.dummy}},{binding:9,resource:l.createView()},{binding:10,resource:y.createView()}]})};for(let e=0;e<Or;e++){let n=e-Sr,r=e-Dr;!a&&n>0&&n<=Cr||!t&&r>=0&&e<18?i.push(void 0):i.push(y(e,0))}u.dhistory&&(u.directGroups=[i[Dr],y(Dr,1)]),l.denoiseGroups=i,e.resources++}return l}#Z(e,t,n,r=e.buffers,i){let a=e=>i?{buffer:e,offset:i.at,size:i.size}:{buffer:e},o=n.lanes??1,s=e=>i?{buffer:e,offset:i.at*o,size:i.size*o}:{buffer:e},c=e.device.createBindGroup({layout:e.traceLayout,entries:[{binding:0,resource:i?{buffer:t,offset:i.frame,size:800}:{buffer:t}},{binding:1,resource:{buffer:r.table0}},{binding:2,resource:{buffer:r.voxels}},{binding:3,resource:{buffer:r.scene}},{binding:4,resource:{buffer:r.materials}},{binding:5,resource:{buffer:r.env}},{binding:6,resource:a(n.accum)},{binding:7,resource:a(n.albedo)},{binding:8,resource:a(n.normals)},{binding:9,resource:{buffer:e.tables}},{binding:10,resource:n.caustics?s(n.caustics):{buffer:e.dummy}}]});return e.inputs?.set(c,{frame:i?{buffer:t,offset:i.frame,size:800}:{buffer:t},table0:r.table0,voxels:r.voxels,scene:r.scene,materials:r.materials,env:r.env,tables:e.tables,images:[a(n.accum),a(n.albedo),a(n.normals),n.caustics?s(n.caustics):{buffer:e.dummy}]}),c}#Q(e,t,n,r,i){let a=this.#A;if(!pe(e.matrix,a))return!1;let o=(e,t,n)=>{let r=a[3]*e+a[7]*t+a[11]*n+a[15];return[0,1,2].map(i=>(a[i]*e+a[4+i]*t+a[8+i]*n+a[12+i])/r)};for(let[e,[i,a]]of[[-1,1],[1,1],[-1,-1],[1,-1]].entries()){let s=o(i,a,1),c=o(i,a,.5);t.set([s[0],s[1],s[2],0],n+e*4),t.set([c[0]-s[0],c[1]-s[1],c[2]-s[2],0],r+e*4)}let s=e.position,c=e.target,l=[c[0]-s[0],c[1]-s[1],c[2]-s[2]],u=Math.hypot(l[0],l[1],l[2])||1;for(let e=0;e<3;e++)l[e]/=u;let d=e.up,f=[l[1]*d[2]-l[2]*d[1],l[2]*d[0]-l[0]*d[2],l[0]*d[1]-l[1]*d[0]],p=Math.hypot(f[0],f[1],f[2])||1;for(let e=0;e<3;e++)f[e]/=p;let m=[f[1]*l[2]-f[2]*l[1],f[2]*l[0]-f[0]*l[2],f[0]*l[1]-f[1]*l[0]];return t.set([s[0],s[1],s[2],u],i),t.set([l[0],l[1],l[2],0],i+4),t.set([f[0],f[1],f[2],0],i+8),t.set([m[0],m[1],m[2],0],i+12),!0}#$(e,t,n,r,a,o,s,c,l,u,d=0,f=!1,p=0){let m=this.#a,h=new Float32Array(this.#O),g=new Uint32Array(this.#O);if(!this.#Q(n,h,0,76,16))return!1;this.#j.set(h.subarray(0,16),0),this.#j.set(h.subarray(76,92),16),h[19]=m.focusDistance??h[19],h[23]=m.aperture/2,h[27]=m.lensBlades,h[31]=m.lensRotation;let _=!1,v=m.previousCamera;if(v&&m.shutter>0){let e=new i({fov:v.fov??n.fov,position:v.position,target:v.target,near:n.near,far:n.far});e.up=v.up??n.up,e.project=n.project;try{e.update(r[0]/r[1],!0),_=this.#Q(e,h,92,108,124),h[127]=m.focusDistance??h[127]}catch{_=!1}}g.set(r,32),g.set(a,36);let y=u.environment,b=y.sun[0]+y.sun[1]+y.sun[2]>0,x=y.map,S=(s?16:0)|(c&1?64:0)|(c&2?rn:0);b&&(S|=1),y.ground&&(S|=2),x&&(S|=4),(u.moving||_||this.geometryMoving())&&m.shutter>0&&(S|=8);let C=m.fisheye.fov*Math.PI/180,w=m.projection===`camera`?m.distortion:void 0;g.set([m.projection===`camera`?0:m.projection===`panorama`?1:2,m.fisheye.mapping===`equisolid`?1:m.fisheye.mapping===`stereographic`?2:0,w&&(w.k1||w.k2||w.p1||w.p2)?1:0,+(m.panoramaFit===`height`)],140),h.set([C,m.fisheye.mapping===`stereographic`?Math.tan(C/4):Math.sin(C/4),0,0],144),h.set(w?[w.k1,w.k2,w.p1,w.p2]:[0,0,0,0],148),_&&(S|=256),m.clamp<1/0&&(S|=32),u.lightPower>0&&(S|=128),u.clearGlass&&m.transparentShadows&&(S|=512),m.transparentShadows||(S|=1024),m.sunSpecular||(S|=2048),m.sunInMedia||(S|=4096),y.sunVisible||(S|=8192),m.energyCompensation||(S|=16384),g.set([m.maxBounces,o>>>0,S,u.lightCount],40);let T=m.bounceLimits;g.set(T?[T.diffuse,T.specular+T.internalReflections*65536,T.scatter+T.subsurface*65536]:[Wn,Wn*65537,Wn*65537],152),h[155]=y.groundFade;let E=y.fog;h.set(E?[E.density,E.anisotropy,1,0]:[0,0,0,0],156),h.set(E?[E.color[0],E.color[1],E.color[2],0]:[0,0,0,0],160),h.set(E?E.hemisphere:new Float32Array(16),164),h.set([y.groundFadeStart,+!!y.fadeModels,0,0],180);let D=f?[0,0,0]:y.background,O=m.edges,k=m.grid;h.set(D?[D[0],D[1],D[2],1]:[0,0,0,0],184),h.set(O?[O.color[0],O.color[1],O.color[2],O.width]:[0,0,0,0],188),h.set(k?[k.color[0],k.color[1],k.color[2],k.spacing]:[0,0,0,1],192),h.set(k?[k.width,k.onVoxels?2:1,0,0]:[0,0,0,0],196);let A=l.scene,j=l.lights;g.set([A.modelBase,A.instanceBase,A.nodeBase,u.instances.length?A.nodeCount:0],44),g.set([u.emissiveInstances.length,j.emissiveBase,j.areaBase,0],48),h[51]=d,g.set([x?.width??0,x?.height??0,j.marginalBase,j.conditionalBase],52),h.set([y.sky[0],y.sky[1],y.sky[2],x?.intensity??0],56);let M=y.sunAngularSize/2,N=M>0?2*Math.PI*(1-Math.cos(M)):0,P=M>0?1/(Math.PI*Math.sin(M)**2):1;return h.set([y.sunDirection[0],y.sunDirection[1],y.sunDirection[2],M>0?Math.cos(M):1],60),h.set([y.sun[0]*P,y.sun[1]*P,y.sun[2]*P,N],64),h.set([y.ground?.[0]??0,y.ground?.[1]??0,y.ground?.[2]??0,y.groundHeight],68),h.set([x?.integral??0,x?.rotation??0,m.shutter,m.clamp<1/0?m.clamp:0],72),e.queue.writeBuffer(t,p,this.#O),!0}#ee(e,t,n,r,i=0,a){let o=new ArrayBuffer(Ar*Or),s=new Uint32Array(o),c=new Float32Array(o);for(let e=0;e<Or;e++){let o=e*Ar/4,l=e-Sr,u=e-Dr,d=e===0||u===0||e===18,f=l>0&&l<=Cr,p=f?l:u>0?u:e,m=e===Sr||l===Cr||u===Er,h=this.#a.projection!==`camera`||this.#a.distortion!==void 0,g=h?0:i;s.set([t.width,t.height,d?0:1<<p-1,+!!m|(t.cping&&d?2:0)|(h?4:0)|(f?32:0)|(d?g:0)|(t.direct&&d?128:0)|(u===0?256:0)|(u===Er&&t.cping?512:0)],o),c.set([f?Tr:wr,128,1,1/n],o+4),s.set(r,o+8),c.set(a?.corners??this.#j,o+12),a&&(c.set(a.history.matrix,o+44),c.set(a.history.corners,o+60))}return e.queue.writeBuffer(t.params,0,o),i!==0&&this.#a.projection===`camera`&&this.#a.distortion===void 0}#te(e,t,n,r=!1){let i=e.pipelines,a=t.beginComputePass(),o=Math.ceil(n.width/8),s=Math.ceil(n.height/8);for(let e=0;e<Or;e++){let t=e===Dr&&n.directGroups?n.directGroups[n.dflip??0]:n.denoiseGroups[e];t&&(a.setPipeline(e===0||e===Dr?i.prepare:e===18?i.combine:i.atrous),a.setBindGroup(0,t),a.dispatchWorkgroups(o,s))}a.end(),r&&n.directGroups&&(n.dflip=1-(n.dflip??0))}#ne(e,t){let n=t.descriptor.multisample?.count??1,r=t.descriptor.depthStencil?.format??`depth32float`,i=`${t.format}|${n}|${r}`,a=e.display.get(i);if(!a){let o=e.device,s=o.createShaderModule({code:Nn}),c={};e.display.set(i,a=c),o.createRenderPipelineAsync({layout:o.createPipelineLayout({bindGroupLayouts:[e.displayLayout]}),vertex:{module:s,entryPoint:`vs`},fragment:{module:s,entryPoint:`fs`,targets:[{format:t.format}]},primitive:{topology:`triangle-list`},depthStencil:{format:r,depthWriteEnabled:!0,depthCompare:`always`},multisample:{count:n}}).then(e=>{c.pipeline=e},e=>this.#e?.onError(e))}return a.pipeline}#re(e){this.#p=this.#p>0?Math.min(this.#p*1.01,e):e;let t=Math.min(50,Math.max(4,this.#p));e>t*1.6?(this.#m=Math.max(1,Math.min(Math.floor(this.#f*.8),Math.floor(this.#f*.8*t/e))),this.#f=this.#m,this.#h=120,this.#g=0):(this.#h>0&&--this.#h===0&&(this.#m=64),this.#g=e<=t*1.2?this.#g+1:0,this.#g>=4&&(this.#f=Math.min(this.#m,Math.ceil(this.#f*1.25)),this.#g=0))}#ie(e,t,n,r){let i=e.key,a=t.camera,o=[this.#c,n,r,...a.matrix,...a.position,...a.target,...a.up],s=0;for(let e=0;e<o.length;e++)Object.is(i[e],o[e])||(i[e]=o[e],e<3?s=2:s||=1);return s}#ae(e,t,n){return e.device.createComputePipelineAsync({label:`voxel-pathtracer ${t}`,layout:e.device.createPipelineLayout({bindGroupLayouts:[e.traceLayout]}),compute:{module:e.traceModule,entryPoint:t,...n?{constants:{TABLES:1}}:{}}})}#oe(e,t){return e.route?e.route.then(e=>e.kernel(t)):this.#ae(e,`trace`,t)}#se(e){return e.tableKernelsPending??=Promise.all([this.#oe(e,!0),this.#ae(e,`ids`,!0)]).then(([t,n])=>(this.#l===e&&(e.tableKernels={trace:t,ids:n}),{trace:t,ids:n}),t=>{throw this.#l===e&&!this.#r&&(this.#u=`failed`,this.#d=t,this.#e?.onError(t)),t}),e.tableKernelsPending}#ce(){return this.#s.materials.length>8192}#le(e,t,n,r,i,a,o,s,c,l,u){let d=e.device,f=Math.max(8,_n(a,d.limits.minStorageBufferOffsetAlignment??256)),p=this.#a.maxBounces,m=gn(a,o,s,c,f,mn(p),mn(p,_r(e))),h=(t,n,i)=>this.#$(d,t,r.camera,[a,o,0,i.y0],[a,i.rows,i.s0,i.count],l,!0,u,e.layout,this.#s,0,!1,n),g=[n.traceGroup];if(m.length===1){if(!h(n.frame,0,m[0]))return!1}else{let t=d.limits.minUniformBufferOffsetAlignment??256,r=Math.ceil(800/t)*t,i=`${n.traceKey}|${a}x${o}|${m.map(e=>`${e.y0}+${e.rows}`).join(`,`)}`;if(n.bands?.key!==i){this.#U(n.bands?.frames);let t=this.#H(e,r*m.length,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);n.bands={key:i,frames:t,groups:m.map((i,o)=>this.#Z(e,t,n,e.buffers,{frame:o*r,at:i.y0*a*16,size:i.rows*a*16}))}}for(let[e,t]of m.entries())if(!h(n.bands.frames,e*r,t))return!1;g=n.bands.groups}if(`sums`in i)return this.#ue(e,t,i,g,m,a,s,c,r.camera.matrix),!0;t.corners.set(this.#j),t.matrix.set(r.camera.matrix);let _=performance.now(),v=fn(this.#a.maxBounces),y=0;for(let[e,t]of m.entries()){let n=d.createCommandEncoder({label:`voxel-pathtracer viewport band`}),r=n.beginComputePass();r.setPipeline(i),r.setBindGroup(0,g[e]),r.dispatchWorkgroups(Math.ceil(a/8),Math.ceil(t.rows/8)),r.end(),d.queue.submit([n.finish()]),y+=a*t.rows*t.count*v}return e.pacing||(e.pacing=!0,d.queue.onSubmittedWorkDone().then(()=>{e.pacing=!1,e.pacer.observe(y,performance.now()-_)},()=>{})),!0}#ue(e,t,n,r,i,a,o,s,c){let l=e.routeReady,u=e.inputs,d={epoch:t.epoch,cut:t.cut,s0:o,count:s,matrix:Float64Array.from(c),corners:this.#j.slice(0),width:a,adds:i.map((e,n)=>({inputs:u.get(r[n]),rows:e.rows,key:`${t.serial}:${n}`})),landed:!1},f=()=>this.#r||e.lost||this.#l!==e||t.released||!this.#F(t,d),p=()=>{if(f())throw new DOMException(`The viewport image restarted`,`AbortError`)},m=this.#O.slice(0);t.routeJob=d;for(let e of d.adds)t.routeKeys.add(e.key);(async()=>{for(let[e,t]of i.entries())await l.run(n,d.adds[e].inputs,a,t.rows,t.count,this.#a.maxBounces,p,d.adds[e].key,!1,m)})().then(()=>{d.landed=!0},e=>{t.routeJob===d&&(t.routeJob=void 0),f()||this.#e?.onError(e)})}#de(e){let t=this.#L(e);t.shown=!1;let n=this.#K(e.device);if(!n.pipelines&&!n.preview||n.lost)return;if(this.#ce()&&!n.tableKernels){n.pipelines&&this.#se(n).catch(()=>{});return}this.#Y(n);let r=mr(e)??[0,0,e.width,e.height],i=this.#a,a=sr(Math.max(1,Math.round(r[2])),Math.max(1,Math.round(r[3])),n.device.limits,i),{width:o,height:s}=a;t.requested=[a.requestedWidth,a.requestedHeight],t.limitedBy=a.limitedBy;let c=this.#ne(n,e);if(!c)return;let l=n.device,u=t.image;if(u)Object.assign(u,this.#X(n,u,o,s,i.denoise!==!1,this.#s.focusing,!0));else{let e=this.#H(n,800,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST),r=this.#H(n,kr,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);u=t.image={...this.#X(n,void 0,o,s,i.denoise!==!1,this.#s.focusing,!0),frame:e,uniform:r,denoisedAt:-1}}let d=this.#ie(t,e,o,s);if(d||n.pipelines&&t.previewing){let e=d===1&&n.routeReady!==void 0&&n.pipelines!==void 0&&!t.previewing;this.#P(t,!1,e),e||(t.restarted=!0)}!t.samples&&!t.held&&(u.denoisedAt=-1),t.previewing=!n.pipelines,t.width=o,t.height=s;let f=`${n.resources}`;if(u.traceKey!==f){u.traceGroup=this.#Z(n,u.frame,u);let e=e=>l.createBindGroup({layout:n.displayLayout,entries:[{binding:0,resource:{buffer:u.uniform}},{binding:1,resource:{buffer:e}},{binding:2,resource:{buffer:u.albedo}}]});u.displayRaw=e(u.accum),u.displayDenoised=u.ping?e(u.ping):void 0,u.displayResolved=u.ping?e(u.ping):void 0,u.traceKey=f,u.denoisedAt=-1}let p=t.routeJob?.landed?t.routeJob:void 0;if(p&&(t.routeJob=void 0,this.#F(t,p))){let e=l.createCommandEncoder({label:`voxel-pathtracer route add`});for(let t of p.adds)n.routeReady.add(e,t.inputs,p.width,t.rows,t.key);l.queue.submit([e.finish()]);let r=p.s0+p.count;p.epoch===t.epoch?(t.samples=r,t.held=0):t.held=r,t.matrix.set(p.matrix),t.corners.set(p.corners),p.s0||(t.restarted=!0,u.denoisedAt=-1)}if(t.previewing){if(!this.#le(n,t,u,e,n.preview,o,s,0,1,i.seed,0))return;t.samples=1}else if(!t.routeJob){if(!this.#T&&t.samples<i.maxSamples){let r=(this.#ce()?n.tableKernels:n.pipelines).trace,a=Math.min(i.samplesPerFrame===`auto`?this.#f:i.samplesPerFrame,i.maxSamples-t.samples);if(!this.#le(n,t,u,e,r,o,s,t.samples,a,i.denoise===!1?i.seed:(i.seed^Br(e.camera.matrix))>>>0,Pr(u)))return;`sums`in r||(t.samples+=a);let c=performance.now();t.lastTrace&&(t.frameMs=c-t.lastTrace,i.samplesPerFrame===`auto`&&(this.#S===0||this.#C!==this.#S)&&(this.#C=this.#S,this.#re(t.frameMs))),t.lastTrace=c}else t.lastTrace=0}let m=t.samples||t.held;if(!m)return;let h=!t.previewing&&i.denoise!==!1&&u.denoiseGroups!==void 0,g=i.denoise===!0||u.denoisedAt<=0||m<32||m>=u.denoisedAt*1.25||m>=i.maxSamples;if(h&&u.denoisedAt!==m&&g){let r=t.history,i=r.valid&&r.version===this.#c&&r.width===o&&r.height===s,a=t.restarted;u.resolved=this.#ee(l,u,m,[0,0,o,s],8|(i?16:0)|(t.restarted?64:0),t),r.matrix.set(t.matrix),r.corners.set(t.corners),r.version=this.#c,r.width=o,r.height=s,r.valid=!0,t.restarted=!1,this.#te(n,e.encoder,u,a||!i),u.denoisedAt=m}let _=this.#k,v=this.#A;if(!pe(t.matrix,v))return;_.set(t.matrix,0),_.set(v,16),_.set([o,s,r[2],r[3]],32);let y=+!!gr(e.format)|(i.toneMapping===`linear`?2:0)|(i.toneMapping===`aces-narkowicz`?4:0)|(i.toneMapping===`agx`?8:0),b=i.projection===`camera`&&!i.distortion?1/m:0;_.set([h?1:1/m,2**i.exposure,y,b],36),_.set([i.gamma??0,i.vignette,r[0],r[1]],40),l.queue.writeBuffer(u.uniform,0,_);let x=e.encoder.beginRenderPass({colorAttachments:[{view:e.color,loadOp:`load`,storeOp:`store`}],depthStencilAttachment:{view:e.depth,depthLoadOp:`load`,depthStoreOp:`store`,stencilReadOnly:!0}});hr(x,e),x.setPipeline(c),x.setBindGroup(0,h?u.resolved?u.displayResolved:u.displayDenoised:u.displayRaw),x.draw(3),x.end(),t.shown=!0}#fe(e){this.#D++;let t=this.#E.then(()=>e(),()=>e());return this.#E=t.then(()=>{this.#D--},()=>{this.#D--}),t}#pe(e,t){if(this.#z(),!e||typeof e!=`object`)throw TypeError(`VoxelPathTracer render options must be {width, height, samples}`);let n=Hn(e.width,`width`,1,16384,`pass the image width in pixels`),r=Hn(e.height,`height`,1,16384,`pass the image height in pixels`),i=Hn(e.samples,`samples`,1,1<<20,`pass samples per pixel, 1 or more`);if(n*r>t)throw RangeError(`VoxelPathTracer ${n}x${r} is over ${t} pixels; render a smaller image`);let a=e,o=a.denoise===void 0?this.#a.denoise!==!1:Un(a.denoise,`denoise`),s=a.jitter===void 0||Un(a.jitter,`jitter`),c=a.seed===void 0?this.#a.seed:Hn(a.seed,`seed`,0,4294967295,`pass an integer seed`),l=a.transparent!==void 0&&Un(a.transparent,`transparent`),u=a.wavelength===void 0?0:Y(a.wavelength,`wavelength`,380,780,`pass nanometres, 380 to 780`);if(a.signal!==void 0&&!(a.signal instanceof AbortSignal))throw TypeError(`VoxelPathTracer signal must be an AbortSignal`);return Vr(a.signal),{width:n,height:r,samples:i,denoise:o,jitter:s,seed:c,wavelength:u,transparent:l,signal:a.signal}}async#me(e,t,n){this.#z(),this.#u===`compiling`&&await this.#_,this.#z();let r=this.#l;if(!r?.pipelines)throw new f(`state`,`VoxelPathTracer is not attached to a WebGPU engine; attach it first`);let a=r.device,o=this.#e.camera,s=new i({fov:o.fov,position:o.position,target:o.target,near:o.near,far:o.far});s.up=o.up,s.project=o.project,s.update(e.width/e.height,!0);let c=this.#ce(),l=c?await this.#se(r):r.pipelines;this.#z(),this.#Y(r);let u=this.#s,d=r.layout,p=GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC,m=[],h=(e,t)=>{let n=this.#H(r,e,t);return m.push(n),n},g;this.#T++;try{let i={},o=a.createCommandEncoder();for(let e of[`table0`,`materials`,`voxels`,`scene`,`env`]){let t=r.buffers[e];i[e]=h(t.size,e===`table0`?GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST:p),o.copyBufferToBuffer(t,0,i[e],0,t.size)}a.queue.submit([o.finish()]);let m=e.width>yr||e.height>yr,_=e.denoise&&m?xr:0,v=Math.min(e.width,yr)+2*_,y=Math.min(e.height,yr)+2*_,b=h(800,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST),x=v*y*16,S=[0,...t?[1,2]:[],...e.transparent&&e.denoise?[3]:[]].map(()=>h(x,GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST)),C=e.transparent?await(c?r.tableCoverage??=this.#ae(r,`coverage`,!0):r.coverage??=this.#ae(r,`coverage`,!1)):void 0,w,T=0,E=0,D=performance.now(),O=new Map,k=()=>{if(Vr(e.signal),this.#z(),r.lost||this.#l!==r)throw new f(`failed`,`VoxelPathTracer lost its GPU device during the render; render again`)};for(let o=0;o<e.height;o+=yr){let c=Math.min(yr,e.height-o),p={color:new Float32Array(e.width*c*3),albedo:t?new Float32Array(e.width*c*3):void 0,normal:t?new Float32Array(e.width*c*3):void 0,depth:t?new Float32Array(e.width*c):void 0,ids:t?new Float32Array(e.width*c):void 0,alpha:e.transparent?new Float32Array(e.width*c):void 0};for(let n=0;n<e.width;n+=yr){let m=Math.min(yr,e.width-n),h=Math.max(0,n-_),v=Math.max(0,o-_),y=Math.min(e.width,n+m+_),x=Math.min(e.height,o+c+_),A=y-h,j=x-v;(!g||g.width!==A||g.height!==j)&&(this.#J(g),g=this.#X(r,void 0,A,j,e.denoise,u.focusing),w=this.#Z(r,b,g,i),O.clear());let M=this.#a.maxBounces,N=fn(M),P=Math.max(1,Math.min(16,Math.floor(mn(M)/(A*j)))),ee=Math.max(8,_n(A,a.limits.minStorageBufferOffsetAlignment??256));for(let t=0;t<e.samples;t+=P){k();let n=Math.min(P,e.samples-t);if(`sums`in l.trace)this.#$(a,b,s,[e.width,e.height,h,v],[A,j,t,n],e.seed,e.jitter,Pr(g),d,u,e.wavelength,e.transparent),await r.routeReady.run(l.trace,r.inputs.get(w),A,j,n,M,k,`image`,!0,this.#O);else for(let o of gn(A,j,t,n,ee,mn(M),mn(M,_r(r)))){let c=o.rows===j,f=`${o.y0}+${o.rows}`,p=c?w:O.get(f);p||(p=this.#Z(r,b,g,i,{frame:0,at:o.y0*A*16,size:o.rows*A*16}),O.set(f,p)),this.#$(a,b,s,[e.width,e.height,h,v+o.y0],[A,o.rows,t,n],e.seed,e.jitter,Pr(g),d,u,e.wavelength,e.transparent);let m=a.createCommandEncoder(),_=m.beginComputePass();_.setPipeline(l.trace),_.setBindGroup(0,p),_.dispatchWorkgroups(Math.ceil(A/8),Math.ceil(o.rows/8)),_.end(),a.queue.submit([m.finish()]),E+=A*o.rows*n*N,++T%4==0&&(await a.queue.onSubmittedWorkDone(),r.pacer.observe(E,performance.now()-D),E=0,D=performance.now(),k())}}k();let F=a.createCommandEncoder();if(e.denoise&&(this.#ee(a,g,e.samples,[h,v,e.width,e.height]),this.#te(r,F,g)),t||C){this.#$(a,b,s,[e.width,e.height,h,v],[A,j,0,br],e.seed,!1,Pr(g),d,u,0,e.transparent);for(let e of[t?l.ids:void 0,C]){if(!e)continue;let t=F.beginComputePass();t.setPipeline(e),t.setBindGroup(0,w),t.dispatchWorkgroups(Math.ceil(A/8),Math.ceil(j/8)),t.end()}}let I=A*j*16;F.copyBufferToBuffer(e.denoise?g.ping:g.accum,0,S[0],0,I),t&&(F.copyBufferToBuffer(g.albedo,0,S[1],0,I),F.copyBufferToBuffer(g.normals,0,S[2],0,I)),e.transparent&&e.denoise&&F.copyBufferToBuffer(g.accum,0,S[S.length-1],0,I),a.queue.submit([F.finish()]);let te=S.map(e=>e.mapAsync(GPUMapMode.READ,0,I));try{await Promise.all(te)}catch(e){throw k(),new f(`failed`,`VoxelPathTracer could not read the render back (${String(e)}); render again`)}let ne=e=>new Float32Array(e.getMappedRange(0,I).slice(0)),re=ne(S[0]),L=t?ne(S[1]):void 0,R=t?ne(S[2]):void 0,z=e.transparent?e.denoise?ne(S[S.length-1]):re:void 0;for(let e of S)e.unmap();let B=e.denoise?1:1/e.samples;for(let t=0;t<c;t++)for(let r=0;r<m;r++){let i=(o+t-v)*A+(n+r-h),a=t*e.width+n+r;for(let e=0;e<3;e++)p.color[a*3+e]=re[i*4+e]*B;if(z&&(p.alpha[a]=z[i*4+3]),L&&R){for(let t=0;t<3;t++)p.albedo[a*3+t]=L[i*4+t]/e.samples,p.normal[a*3+t]=R[i*4+t]/e.samples;let t=L[i*4+3]/e.samples;p.depth[a]=t>0?1/t:1/0,p.ids[a]=R[i*4+3]}}}k(),await n(o,c,p)}}finally{this.#T--,this.#J(g);for(let e of m)this.#U(e)}}};-Math.atan(Math.SQRT1_2);var Ur=[`resampling`,`mesh`,`media`,`guiding`,`spectral`];function Wr(e){if(!Array.isArray(e))throw TypeError(`ComposedVoxelPathTracer features must be an array`);let t=new Set,n=e.map(e=>{if(!e||!Ur.includes(e.id)||typeof e.source!=`function`||e.scene!==void 0&&typeof e.scene!=`function`||e.geometry!==void 0&&(e.id!==`mesh`||typeof e.geometry!=`function`))throw TypeError(`ComposedVoxelPathTracer expects features from the optional tracer entries`);if(t.has(e.id))throw TypeError(`ComposedVoxelPathTracer features must contain each identity once; duplicate: `+e.id);return t.add(e.id),Object.freeze({...e})});return Object.freeze(n.sort((e,t)=>Ur.indexOf(e.id)-Ur.indexOf(t.id)))}function Gr(e,t){if(!e||!Array.isArray(e.models))throw TypeError(`ComposedVoxelPathTracer scene.models must be an array`);let{models:n,...r}=e,i={...structuredClone(r),models:n.map(e=>{let{contentKey:t,...n}=e;return{...structuredClone(n),...t===void 0?{}:{contentKey:t}}})};for(let e of t)e.scene&&(i=e.scene(i));return i}async function Kr(e,t,n){n?.throwIfAborted();let r=t?await t.build(e,n):new Uint32Array;return n?.throwIfAborted(),r}var qr=class extends Hr{#e;#t;constructor(e){let{geometry:t,features:n,...r}=e;super(r),this.motion=new d,this.#e=t,this.#t=n}static attach(e,t){return a(e,r(`1.0.0`,import.meta.url)),super.attach(e,t)}replace(e,t,n){this.motion.check(this.options.shutter,n);let r=this.#e;this.#e=t;try{super.setScene(e)}catch(e){throw this.#e=r,e}this.motion.error=n}setOptions(e){this.motion.check(e?.shutter),super.setOptions(e)}sceneWordReserve(){return this.#e.length}geometryMoving(){return l(this.#e)}get stats(){return{...super.stats,...c(this.#e)}}sceneStorage(e){if(this.#e.length===0)return e;let t=new Uint32Array(e.length+this.#e.length);return t.set(e),t[2]=e.length,t.set(this.#e,e.length),t}tracingSource(){let e=super.tracingSource();for(let t of this.#t)e=t.source(e);return e}imageInstance(e){return e<=-4&&this.#t.some(e=>e.id===`mesh`)?e:super.imageInstance(e)}},Jr=class e{#e;#t=Promise.resolve();#n;#r;constructor(e,t,n){this.#e=e,this.#n=t,this.#r=n}static async create(t,n){if(!n||typeof n!=`object`)throw TypeError(`ComposedVoxelPathTracer.create expects engine and {scene}`);let{signal:r,scene:i,features:a=[],...o}=n,s=Wr(a);r?.throwIfAborted();let c=Gr(i,s),l=s.find(e=>e.geometry)?.geometry?.(),u=await Kr(c,l,r);r?.throwIfAborted(),new d().check(o.shutter,l?.motionError);let f=qr.attach(t,{...o,scene:c,geometry:u,features:s});return f.motion.error=l?.motionError,new e(f,s,l)}get enabled(){return this.#e.enabled}set enabled(e){this.#e.enabled=e}get ready(){return this.#e.ready}get status(){return this.#e.status}get error(){return this.#e.error}get stats(){return this.#e.stats}get options(){return this.#e.options}setScene(e,t={}){if(this.status===`disposed`)return Promise.reject(new f(`disposed`,`ComposedVoxelPathTracer is disposed; https://margoengine.com/errors#voxel-pathtracer`));let n;try{t.signal?.throwIfAborted(),n=Gr(e,this.#n)}catch(e){return Promise.reject(e)}let r=this.#t.then(async()=>{let e=await Kr(n,this.#r,t.signal);t.signal?.throwIfAborted(),this.#e.replace(n,e,this.#r?.motionError)});return this.#t=r.catch(()=>{}),r}setOptions(e){this.#e.setOptions(e)}resetOptions(e){this.#e.resetOptions(e)}invalidateModels(e){this.#e.invalidateModels(e)}reset(){this.#e.reset()}async whenIdle(){await this.#t,await this.#e.whenIdle()}renderImage(e){return this.#e.renderImage(e)}capture(e){return this.#e.capture(e)}raycast(e,t,n=1/0){return this.#e.raycast(e,t,n)}dispose(){this.#r?.dispose(),this.#e.dispose()}[Symbol.dispose](){this.dispose()}};async function Yr(e){let n=new URL(new URL(new URL(`mesh-BGFEegqF.wasm`,import.meta.url).href,``+import.meta.url).href,import.meta.url),r;if(n.protocol===`file:`){n.search=``;let{readFile:i}=await t(async()=>{let{readFile:e}=await import(`node:fs/promises`);return{readFile:e}},[],import.meta.url),a=await i(n,{signal:e});r=a.buffer.slice(a.byteOffset,a.byteOffset+a.byteLength)}else{let t=await fetch(n,{signal:e});if(!t.ok)throw new f(`failed`,`Mesh Wasm fetch failed; serve package assets: https://margoengine.com/errors#voxel-pathtracer`);r=await t.arrayBuffer()}e?.throwIfAborted();let i=await WebAssembly.instantiate(r);return e?.throwIfAborted(),i.instance.exports}async function Xr(e,t){if(t?.throwIfAborted(),!e||!Array.isArray(e.meshes)||!Array.isArray(e.materials))throw TypeError(`MeshPathTracer scene must contain meshes and materials arrays`);let n=new Set,r=new Map(e.materials.map(e=>[e?.id,e])),i=1,a=0;for(let t of e.meshes){if(!t||typeof t.id!=`string`||!t.id||n.has(t.id))throw TypeError(`MeshPathTracer mesh ids must be nonempty and unique`);if(n.add(t.id),!(t.positions instanceof Float32Array)||t.positions.length%3!=0||!(t.indices instanceof Uint32Array)||t.indices.length%3!=0)throw TypeError(`MeshPathTracer expects Float32Array xyz positions and Uint32Array triangle indices`);let e=r.get(t.material);if(!e)throw TypeError(`MeshPathTracer mesh.material must name a scene palette material`);if(e.type===`media`||e.cutout!==void 0||e.texture!==void 0&&(typeof e.texture!=`number`||t.uvs===void 0))throw TypeError(`MeshPathTracer meshes support surface materials; textures require one numeric texture index and vertex UVs; media and cutout are unsupported`);if(t.normals!==void 0&&(!(t.normals instanceof Float32Array)||t.normals.length!==t.positions.length))throw TypeError(`MeshPathTracer normals must be Float32Array xyz values, one per position`);if(t.uvs!==void 0&&(!(t.uvs instanceof Float32Array)||t.uvs.length!==t.positions.length/3*2))throw TypeError(`MeshPathTracer uvs must be Float32Array pairs, one per position`);if(t.previousPositions!==void 0&&(!(t.previousPositions instanceof Float32Array)||t.previousPositions.length!==t.positions.length))throw TypeError(`MeshPathTracer previousPositions must be Float32Array xyz values, one per position`);a+=t.indices.length/3,i+=3+t.positions.length+t.indices.length}if(a>1e6||i>(128<<20)/4)throw RangeError(`MeshPathTracer accepts at most 1,000,000 triangles and 128 MiB of input words; pass fewer triangles or vertices`);let o=e.meshes.some(e=>e.normals!==void 0||e.uvs!==void 0);o&&(i+=1+e.meshes.reduce((e,t)=>e+2+(t.normals?.length??0)+(t.uvs?.length??0),0));let s=e.meshes.some(e=>e.previousPositions!==void 0);if(s&&(i+=1+e.meshes.reduce((e,t)=>e+1+(t.previousPositions?.length??0),0)),i>(128<<20)/4)throw RangeError(`MeshPathTracer accepts at most 128 MiB of input words`);let c=new Uint32Array(i);c[0]=e.meshes.length;let l=1;for(let t of e.meshes)c.set([t.positions.length/3,t.indices.length,t.material],l),l+=3,c.set(new Uint32Array(t.positions.buffer,t.positions.byteOffset,t.positions.length),l),l+=t.positions.length,c.set(t.indices,l),l+=t.indices.length;if(o){c[l++]=1296127060;for(let t of e.meshes){c.set([t.normals?.length??0,t.uvs?.length??0],l),l+=2;for(let e of[t.normals,t.uvs])e&&(c.set(new Uint32Array(e.buffer,e.byteOffset,e.length),l),l+=e.length)}}if(s){c[l++]=1297109590;for(let t of e.meshes){let e=t.previousPositions;c[l++]=e?.length??0,e&&(c.set(new Uint32Array(e.buffer,e.byteOffset,e.length),l),l+=e.length)}}let u=await Yr(t),d=u.allocate(i);try{new Uint32Array(u.memory.buffer,d,i).set(c);let e=u.build_mesh(d,i);if(e)throw RangeError(`MeshPathTracer ${[``,`invalid mesh packet`,`positions must be finite within +/-1e8 world units, previousPositions too`,`index outside positions`,`normals must be finite and nonzero`,`UVs must be finite within +/-1e8`][e]??`invalid mesh`}; check scene.meshes`);return t?.throwIfAborted(),new Uint32Array(u.memory.buffer,u.output_ptr(),u.output_len()).slice()}finally{u.release(d,i)}}var Zr=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],Qr=32,$r=e=>(Array.isArray(e)||e instanceof Float32Array)&&e.length===16&&e[3]===0&&e[7]===0&&e[11]===0&&e[15]===1&&Array.from(e).every(e=>typeof e==`number`&&Number.isFinite(e)&&Math.abs(e)<=1e8),ei=e=>[0,1,2].flatMap(t=>[e[t],e[4+t],e[8+t],e[12+t]]);function ti(e,t,n){if(e===void 0||t===void 0)return e===t;if(e.byteLength!==t.byteLength)return!1;let r=new Uint32Array(e.buffer,e.byteOffset,e.byteLength/4),i=new Uint32Array(t.buffer,t.byteOffset,t.byteLength/4),a=n.allocate(r.length*2);try{return new Uint32Array(n.memory.buffer,a,r.length).set(r),new Uint32Array(n.memory.buffer,a+r.byteLength,i.length).set(i),n.equal_words(a,r.length*2)===1}finally{n.release(a,r.length*2)}}function ni(e,t,n){return e.material===t.material&&ti(e.positions,t.positions,n)&&ti(e.indices,t.indices,n)&&ti(e.normals,t.normals,n)&&ti(e.uvs,t.uvs,n)&&ti(e.previousPositions,t.previousPositions,n)}function ri(e,t){let n=new Float32Array(t.buffer,t.byteOffset+16,8);if(t[0]===0||e.previousPositions===void 0)return{section:0,box:n};let r=t.length-t[0]*8-t[2]*12,i=new Float32Array(t.buffer,t.byteOffset+r*4,8),a=new Float32Array(8);for(let e=0;e<3;e++)a[e]=Math.min(n[e],i[e]),a[4+e]=Math.max(n[4+e],i[4+e]);return{section:r,box:a}}var ii=class{#e=new Map;#t=!1;#n;get motionError(){return this.#n}async build(e,t){if(t?.throwIfAborted(),this.#t)throw new f(`disposed`,`Mesh builder is disposed; https://margoengine.com/errors#voxel-pathtracer`);let n={...e,meshes:structuredClone(e.meshes),materials:structuredClone(e.materials),...e.meshInstances!==void 0&&{meshInstances:structuredClone(e.meshInstances)}},r=()=>Array.isArray(n.meshes)&&n.meshes.some(e=>e?.previousPositions!==void 0);if(r()){let e=await Yr(t);for(let t of n.meshes)t?.previousPositions instanceof Float32Array&&t.positions instanceof Float32Array&&ti(t.previousPositions,t.positions,e)&&delete t.previousPositions;n.meshInstances===void 0&&r()&&(n.meshInstances=n.meshes.map(e=>({id:e.id,mesh:e.id})))}if(n.meshInstances===void 0){let e=await Xr(n,t);return this.#e.clear(),this.#n=void 0,e}if(!Array.isArray(n.meshInstances)||n.meshInstances.length>1e6)throw TypeError(`MeshPathTracer meshInstances must be an array of at most 1,000,000 instances`);if(!Array.isArray(n.meshes)||!Array.isArray(n.materials))throw TypeError(`MeshPathTracer scene must contain meshes and materials arrays`);let i=new Map;for(let e of n.meshes){if(!e||typeof e.id!=`string`||!e.id||i.has(e.id))throw TypeError(`MeshPathTracer mesh ids must be nonempty and unique`);if(!(e.positions instanceof Float32Array)||e.positions.length%3!=0||!(e.indices instanceof Uint32Array)||e.indices.length%3!=0||e.normals!==void 0&&(!(e.normals instanceof Float32Array)||e.normals.length!==e.positions.length)||e.uvs!==void 0&&(!(e.uvs instanceof Float32Array)||e.uvs.length!==e.positions.length/3*2)||e.previousPositions!==void 0&&(!(e.previousPositions instanceof Float32Array)||e.previousPositions.length!==e.positions.length))throw TypeError(`MeshPathTracer expects Float32Array positions/normals/uvs/previousPositions and Uint32Array indices`);i.set(e.id,e)}let a=new Set,o=0,s=n.meshInstances.map((e,t)=>{if(!e||typeof e.id!=`string`||!e.id||a.has(e.id))throw TypeError(`MeshPathTracer mesh instance ids must be nonempty and unique`);a.add(e.id);let n=i.get(e.mesh);if(!n)throw TypeError(`MeshPathTracer mesh instance must reference a scene mesh id`);let r=e.transform===void 0?Zr:e.transform;if(!$r(r))throw TypeError(`MeshPathTracer instance transform must contain 16 finite column-major values within +/-1e8`);let s=e.previousTransform,c=e.motionInterpolation??`matrix`;if(s!==void 0&&!$r(s))throw TypeError(`MeshPathTracer instance previousTransform must contain 16 finite column-major values within +/-1e8`);if(c!==`matrix`&&c!==`trs`)throw TypeError(`MeshPathTracer instance motionInterpolation must be 'matrix' or 'trs'`);let l=o;if(o+=n.indices.length/3,o>1e6)throw RangeError(`MeshPathTracer accepts at most 1,000,000 instanced input triangles`);return{mesh:n,matrix:r,previous:s!==void 0&&Array.from(s).some((e,t)=>e!==r[t])?s:void 0,interpolation:c,base:l,index:t}}),c=await Yr(t),l=new Map,u=0,d=0,p=0,m=0,h=0,g=0,_=0;for(let e of n.meshes){if(g+=e.indices.length/3,_+=e.positions.byteLength+e.indices.byteLength+(e.normals?.byteLength??0)+(e.uvs?.byteLength??0)+(e.previousPositions?.byteLength??0),g>1e6||_>128<<20)throw RangeError(`MeshPathTracer accepts at most 1,000,000 triangles and 128 MiB of input words`);let r=this.#e.get(e.id),i=n.materials.find(t=>t.id===e.material);if(!i||i.type===`media`||i.cutout!==void 0||i.texture!==void 0&&(typeof i.texture!=`number`||e.uvs===void 0))throw TypeError(`MeshPathTracer meshes require surface materials; textures require vertex UVs`);let a=r&&ni(r.mesh,e,c)?(d++,r.words):(u++,await Xr({...n,meshes:[e]},t));l.set(e.id,{mesh:e,words:a}),p+=a[2],m+=a[3],h+=a[0]}t?.throwIfAborted();let v=s.filter(e=>l.get(e.mesh.id).words[0]!==0),y,b=new Map;for(let e of v){if(!e.previous)continue;let{box:t}=ri(e.mesh,l.get(e.mesh.id).words),n=[t[0],t[1],t[2]];try{b.set(e.index,Ie(ei(e.previous),ei(e.matrix),[t[4]-n[0],t[5]-n[1],t[6]-n[2]],e.interpolation,`meshInstances[${e.index}]`,n,`previousTransform`))}catch(e){if(!(e instanceof RangeError))throw e;y??=e}}let x=16+Math.max(0,v.length*2-1)*8,S=x+v.length*32,C=S;S+=b.size*Qr;let w=new Map;for(let[e,t]of l)w.set(e,S),S+=t.words.length;if(S>(128<<20)/4)throw RangeError(`MeshPathTracer instance packet exceeds 128 MiB; pass fewer meshes or instances`);let T=new Uint32Array(s.length*28),E=new Float32Array(T.buffer);s.forEach((e,t)=>{let n=t*28,r=l.get(e.mesh.id).words;r[0]!==0&&E.set(ri(e.mesh,r).box,n),E.set(e.matrix,n+8);let i=b.get(e.index);i&&E.set([...i.bounds.subarray(0,3),0,...i.bounds.subarray(3,6),0],n),T.set([w.get(e.mesh.id),e.base,e.index,r[0]===0?1:i?6:2],n+24)});let D=c.allocate(T.length),O;try{if(new Uint32Array(c.memory.buffer,D,T.length).set(T),c.build_instances(D,T.length))throw RangeError(`MeshPathTracer instance transform must be affine, invertible and finite in Float32 within +/-1e8, with transformed bounds within +/-1e8`);O=new Uint32Array(c.memory.buffer,c.output_ptr(),c.output_len()).slice()}finally{c.release(D,T.length)}if(t?.throwIfAborted(),this.#t)throw new f(`disposed`,`Mesh builder is disposed; https://margoengine.com/errors#voxel-pathtracer`);let k=new Uint32Array(S);k.set([O[0],0,p,m,v.length,x,u,d,h,1296649811]);let A=v.map(e=>ri(e.mesh,l.get(e.mesh.id).words).section);k[11]=v.filter((e,t)=>b.has(e.index)||A[t]!==0).length,k.set(O.subarray(4),16);let j=new Float32Array(k.buffer),M=C;v.forEach((e,t)=>{k[x+t*32+27]=A[t];let n=b.get(e.index);n&&(k[x+t*32+31]=M,k[M]=+(e.interpolation===`trs`),j.set(ei(e.previous),M+4),n.payload&&j.set(n.payload,M+16),M+=Qr)});for(let[e,t]of l)k.set(t.words,w.get(e));return this.#e=l,this.#n=y,k}dispose(){this.#t=!0,this.#e.clear()}};function ai(e,t,n=0,r=1e8){if(!Number.isFinite(e)||e<n||e>r)throw RangeError(`Mesh light ${t} must be finite in [${n}, ${r}]`);return e}function oi(e,t,n=-1e8,r=1e8){if(!e||e.length!==3)throw TypeError(`Mesh light ${t} needs three components`);return Array.from(e,e=>ai(e,t,n,r))}function si(e,t){let n=Math.hypot(...e);if(n===0)throw RangeError(`Mesh light ${t} must be nonzero`);return e.map(e=>e/n)}function ci(e,t){return[e[1]*t[2]-e[2]*t[1],e[2]*t[0]-e[0]*t[2],e[0]*t[1]-e[1]*t[0]]}function li(e){for(let[t,n,r]of[[`verticalAngles`,e.verticalAngles,180],[`horizontalAngles`,e.horizontalAngles,360],[`tiltAngles`,e.tiltAngles,180]])if((n!==void 0||t!==`tiltAngles`)&&(!(n instanceof Float32Array)||!n.length||n.length>1e6||n.some((e,t)=>!Number.isFinite(e)||e<0||e>r||t>0&&e<=n[t-1])))throw TypeError(`Mesh IES ${t} needs strictly increasing Float32 angles`);let t=e.horizontalAngles;if(t.length>1&&(t[0]!==0||![90,180,360].includes(t[t.length-1])))throw RangeError(`Mesh IES planes must cover 90, 180 or 360 degrees`);if(!(e.candela instanceof Float32Array)||e.candela.length!==e.verticalAngles.length*t.length||e.candela.length>1e6||e.candela.some(e=>!Number.isFinite(e)||e<0||e>0x2386f26fc10000))throw TypeError(`Mesh IES needs finite nonnegative horizontal-major candela`);if(e.tiltAngles===void 0!=(e.tiltMultipliers===void 0)||e.tiltAngles&&(!(e.tiltMultipliers instanceof Float32Array)||e.tiltMultipliers.length!==e.tiltAngles.length||e.tiltMultipliers.some(e=>!Number.isFinite(e)||e<0||e>1e8)))throw TypeError(`Mesh IES tilt angles need matching finite nonnegative multipliers`)}function ui(e,t){let n=e.tiltAngles,r=e.tiltMultipliers;if(!n||!r)return 1;if(t<=n[0])return r[0];for(let e=1;e<n.length;e++)if(t<=n[e]){let i=(t-n[e-1])/(n[e]-n[e-1]);return r[e-1]*(1-i)+r[e]*i}return r[r.length-1]}function di(e){if(e===void 0)return[];if(!Array.isArray(e)||e.length>4096)throw TypeError(`Mesh spotLights needs at most 4096 spot lights`);let t=structuredClone(e);for(let e of t){oi(e.position,`position`),si(oi(e.direction??[0,-1,0],`direction`),`direction`),e.up&&si(ci(si(oi(e.direction??[0,-1,0],`direction`),`direction`),oi(e.up,`up`)),`up perpendicular to direction`),oi(e.color??[1,1,1],`color`,0,1e8),ai(e.intensity??1,`intensity`);let t=ai(e.outerConeAngle??Math.PI/4,`outerConeAngle`,0,Math.PI/2);if(ai(e.innerConeAngle??0,`innerConeAngle`,0,t),t===0||(e.innerConeAngle??0)===t)throw RangeError(`Mesh spot inner cone must be smaller than its positive outer cone`);e.range!==void 0&&ai(e.range,`range`,Number.MIN_VALUE),ai(e.tiltDegrees??0,`tiltDegrees`,0,180),e.ies&&li(e.ies)}return t}function fi(e,t){if(!t.length)return e;let n=e.length+t.length*32,r=new Map;for(let e of t)e.ies&&!r.has(e.ies)&&(r.set(e.ies,n),n+=e.ies.verticalAngles.length+e.ies.horizontalAngles.length+e.ies.candela.length);if(n>(128<<20)/4)throw RangeError(`Mesh light packet exceeds 128 MiB; pass fewer profiles or mesh instances`);let i=new Uint32Array(n),a=new Float32Array(i.buffer);i.set(e);let o=i[12];i[o+2]=t.length,i[o+3]=e.length;for(let[e,t]of r)a.set(e.verticalAngles,t),a.set(e.horizontalAngles,t+e.verticalAngles.length),a.set(e.candela,t+e.verticalAngles.length+e.horizontalAngles.length);return t.forEach((t,n)=>{let o=e.length+n*32,s=si(oi(t.direction??[0,-1,0],`direction`),`direction`),c=si(ci(s,oi(t.up??(Math.abs(s[1])<.99?[0,1,0]:[0,0,1]),`up`)),`up perpendicular to direction`),l=ci(c,s),u=oi(t.color??[1,1,1],`color`,0),d=t.intensity??1;a.set(t.position,o),a.set(s,o+4),a[o+7]=t.ies&&t.outerConeAngle===void 0&&t.innerConeAngle===void 0?-2:Math.cos(t.innerConeAngle??0),a.set(c,o+8),a[o+11]=t.ies&&t.outerConeAngle===void 0&&t.innerConeAngle===void 0?-3:Math.cos(t.outerConeAngle??Math.PI/4),a.set(l,o+12),a[o+15]=t.range??0,a.set(u.map(e=>e*d),o+16);let f=t.ies;f&&(i[o+20]=r.get(f),i[o+21]=f.verticalAngles.length,i[o+22]=f.horizontalAngles.length,a[o+23]=ui(f,t.tiltDegrees??0))}),i}var pi=class{#e;constructor(e=new ii){this.#e=e}get motionError(){return this.#e.motionError}async build(e,t){t?.throwIfAborted();let n=e,r=di(n.spotLights),i=new Float32Array(1024),a=!1;for(let e of n.materials){let t=e.emission??+(e.type===`emit`),n=e.emissionColor??e.color;t>0&&n?.some(e=>e>0)&&(a=!0,e.id>=1&&e.id<256&&i.set([...n.map(e=>e*t),0],e.id*4))}let o=n.pbrMaterials!==void 0;if(!a&&!r.length&&!o)return this.#e.build(n,t);let s=n.meshInstances===void 0?{...n,meshInstances:n.meshes.map(e=>({id:e.id,mesh:e.id}))}:n,c=await this.#e.build(s,t),l=await Yr(t),u=1025+c.length,d=l.allocate(u),f;try{let e=new Uint32Array(l.memory.buffer,d,u);e[0]=c.length,e.set(new Uint32Array(i.buffer),1),e.set(c,1025);let t=l.build_lights(d,u);if(t)throw RangeError(`Mesh emitter packet is invalid or exceeds 128 MiB (${t}); check meshes and pass fewer instances`);f=new Uint32Array(l.memory.buffer,l.output_ptr(),l.output_len()).slice()}finally{l.release(d,u)}return f[f[12]+4]=7,t?.throwIfAborted(),fi(f,r)}dispose(){this.#e.dispose()}},mi=`


const MESH_LIGHT_SLACK=7.62939453e-6;
fn meshLights()->u32 {
 let g=scene[2];if(g==0u||scene[g+1u]!=0u||scene[g+12u]==0u){return 0u;}return g+scene[g+12u];
}
fn meshProposalCount()->u32 {let header=meshLights();if(header==0u){return 5u;}return scene[header+4u];}
fn meshEmitterRadiance(h:Hit,p:vec3f,wo:vec3f)->vec3f {return material(h.value).emission;}


fn meshArea(lx:Xform,p0:vec3f,p1:vec3f,p2:vec3f)->f32 {
 let c=cross(p1-p0,p2-p0);let w=c.x*lx.r0.xyz+c.y*lx.r1.xyz+c.z*lx.r2.xyz;
 return 0.5*length(w)/abs(dot(lx.r0.xyz,cross(lx.r1.xyz,lx.r2.xyz)));
}
fn meshEmitterWeight(h:Hit,d:vec3f,lastPdf:f32)->f32 {
 if(lastPdf<=0.0||h.mesh==0u){return 1.0;}
 let lookup=scene[h.mesh+30u];if(lookup==0u){return 1.0;}
 let ordinal=(h.tri-h.meshHead-scene[h.meshHead+1u])/16u;
 let relative=scene[scene[2]+lookup+ordinal];if(relative==0u){return 1.0;}
 let r=scene[2]+relative;let pmf=fl(r+20u);if(pmf<=0.0){return 1.0;}
 if(meshMotion(h.mesh)!=0u||meshDeforms(h)){

  let area=meshArea(meshModel(h),meshVertex(h,0u),meshVertex(h,1u),meshVertex(h,2u));if(!(area>1e-30)){return 1.0;}
  let moved=abs(dot(triangleNormal(h),d));if(moved<=0.0){return 1.0;}
  return power2(lastPdf,pmf/area*h.t*h.t/moved);
 }
 let cosine=abs(dot(vec3f(fl(r+12u),fl(r+13u),fl(r+14u)),d));
 if(cosine<=0.0){return 1.0;}
 return power2(lastPdf,pmf/fl(r+7u)*h.t*h.t/cosine);
}



fn sampleMeshEmitter(o:vec3f)->LightPoint {
 var result:LightPoint;let header=meshLights();if(header==0u||scene[header]==0u){return result;}
 let records=scene[2]+scene[header+1u];var lo=0u;var hi=scene[header]-1u;let pick=rand();
 while(lo<hi){let mid=(lo+hi)/2u;if(fl(records+mid*24u+3u)<=pick){lo=mid+1u;}else{hi=mid;}}
 let r=records+lo*24u;let root=sqrt(rand());let v=rand();let bary=vec2f(root*(1.0-v),root*v);
 var h:Hit;h.inst=TRIANGLE;h.tri=scene[2]+scene[r+16u];h.meshHead=scene[2]+scene[r+17u];h.mesh=scene[2]+scene[r+18u];h.value=scene[r+19u];h.bary=bary;
 if(meshMotion(h.mesh)==0u&&!meshDeforms(h)){
  if(fl(r+7u)<=0.0){return result;}
  result.p=vec3f(fl(r),fl(r+1u),fl(r+2u))*(1.0-root)+vec3f(fl(r+4u),fl(r+5u),fl(r+6u))*bary.x+vec3f(fl(r+8u),fl(r+9u),fl(r+10u))*bary.y;
  result.n=vec3f(fl(r+12u),fl(r+13u),fl(r+14u));result.twoSided=scene[r+15u]!=0u;result.pdfA=fl(r+20u)/fl(r+7u);
 } else {

  let lx=meshLocal(h.mesh);h.ml=lx;
  let p0=meshVertex(h,0u);let p1=meshVertex(h,1u);let p2=meshVertex(h,2u);
  let c=cross(p1-p0,p2-p0);h.ng=meshCorner(h.tri+12u);if(meshDeforms(h)&&dot(c,c)>1e-30){h.ng=normalize(c);}
  let area=meshArea(lx,p0,p1,p2);if(!(area>1e-30)){return result;}
  var world=meshX(h.mesh);if(meshMotion(h.mesh)!=0u){world=invertX(lx);}
  result.p=xpoint(world,p0*(1.0-root)+p1*bary.x+p2*bary.y);result.n=triangleNormal(h);
  result.twoSided=scene[r+15u]!=0u;result.pdfA=fl(r+20u)/area;result.moving=true;
 }

 let d=result.p-o;let wi=d/sqrt(dot(d,d));
 if(result.twoSided||-dot(result.n,wi)>0.0){
  let wo=-wi;h.sgn=select(-1.0,1.0,dot(triangleNormal(h),wo)>=0.0);result.radiance=meshEmitterRadiance(h,result.p,wo);
 }
 return result;
}
fn iesInterval(at:u32,count:u32,angle:f32)->vec2f {
 if(count==1u){return vec2f(0.0);}
 var lo=0u;var hi=count-1u;
 while(lo+1u<hi){let mid=(lo+hi)/2u;if(fl(at+mid)<=angle){lo=mid;}else{hi=mid;}}
 return vec2f(f32(lo),clamp((angle-fl(at+lo))/(fl(at+lo+1u)-fl(at+lo)),0.0,1.0));
}
fn iesCandela(r:u32,d:vec3f)->f32 {
 let relative=scene[r+20u];if(relative==0u){return 1.0;}
 let at=scene[2]+relative;let nv=scene[r+21u];let nh=scene[r+22u];let horizontal=at+nv;let table=horizontal+nh;
 let polar=acos(clamp(dot(d,vec3f(fl(r+4u),fl(r+5u),fl(r+6u))),-1.0,1.0))*180.0/PI;
 if(polar<fl(at)||polar>fl(at+nv-1u)){return 0.0;}
 let x=dot(d,vec3f(fl(r+8u),fl(r+9u),fl(r+10u)));let y=dot(d,vec3f(fl(r+12u),fl(r+13u),fl(r+14u)));
 var azimuth=0.0;if(x!=0.0||y!=0.0){azimuth=atan2(y,x)*180.0/PI;}
 azimuth=azimuth-floor(azimuth/360.0)*360.0;
 let end=fl(horizontal+nh-1u);
 if(end<=180.0&&azimuth>180.0){azimuth=360.0-azimuth;}
 if(end<=90.0&&azimuth>90.0){azimuth=180.0-azimuth;}
 let vertical=iesInterval(at,nv,polar);let plane=iesInterval(horizontal,nh,azimuth);
 let v0=u32(vertical.x);let v1=min(v0+1u,nv-1u);let h0=u32(plane.x);let h1=min(h0+1u,nh-1u);
 let a=mix(fl(table+h0*nv+v0),fl(table+h0*nv+v1),vertical.y);
 let b=mix(fl(table+h1*nv+v0),fl(table+h1*nv+v1),vertical.y);
 return mix(a,b,plane.y)*fl(r+23u);
}
struct MeshSpotSample {wi:vec3f,dist:f32,radiance:vec3f}
fn sampleMeshSpot(o:vec3f)->MeshSpotSample {
 var result:MeshSpotSample;let header=meshLights();if(header==0u||scene[header+2u]==0u){return result;}
 let count=scene[header+2u];let chosen=min(u32(rand()*f32(count)),count-1u);let r=scene[2]+scene[header+3u]+chosen*32u;
 let v=vec3f(fl(r),fl(r+1u),fl(r+2u))-o;let d2=dot(v,v);if(d2<=0.0){return result;}
 result.dist=sqrt(d2);result.wi=v/result.dist;
 let cosine=dot(-result.wi,vec3f(fl(r+4u),fl(r+5u),fl(r+6u)));
 let cone=clamp((cosine-fl(r+11u))/(fl(r+7u)-fl(r+11u)),0.0,1.0);
 var falloff=cone*cone;let range=fl(r+15u);if(range>0.0){let ratio=result.dist/range;falloff*=pow(max(1.0-ratio*ratio*ratio*ratio,0.0),2.0);}
 result.radiance=vec3f(fl(r+16u),fl(r+17u),fl(r+18u))*iesCandela(r,-result.wi)*falloff*f32(count)/d2;
 return result;
}
`;function hi(e){let t=e,n=(e,n)=>{if(!t.includes(e))throw new f(`state`,`Mesh light kernel mismatch; rebuild: https://margoengine.com/errors#voxel-pathtracer`);t=t.replace(e,n)};return n(`fn direct(`,mi+`
fn direct(`),n(`q<5u`,`q<meshProposalCount()`),n(`} else if(q<3u){`,`} else if(q<3u||q==5u){`),n(`}else{ls=sampleArea();}`,`}else if(q==2u){ls=sampleArea();}else{ls=sampleMeshEmitter(o);}`),n(`radiance=ls.radiance;lp=ls.pdfA*d2/cl;`,`radiance=ls.radiance;lp=ls.pdfA*d2/cl;
   if(q==5u){
    // sampleMeshEmitter resolved the emitted radiance. A moving point comes through a Float32 invertX while the hit
    // it must not see is found in object space, so its shadow ray stops further short (Wachter and Binder 2019).
    dist=max(0.0,dist-max(1e-5,max(max(abs(ls.p.x),abs(ls.p.y)),abs(ls.p.z))*select(9.53674316e-7,MESH_LIGHT_SLACK,ls.moving)));
   }`),n(`twoSided:bool}`,`twoSided:bool,moving:bool}`),n(`  } else {
   if((*w).total==0.0)`,`  } else if(q==6u){
   if(!air){continue;}let spot=sampleMeshSpot(o);if(spot.dist<=0.0||!any(spot.radiance>vec3f(0.0))){continue;}
   wi=spot.wi;dist=spot.dist;radiance=spot.radiance;
  } else {
   if((*w).total==0.0)`),n(`if(h.inst==TRIANGLE){return 1.0;}`,`if(h.inst==TRIANGLE){return meshEmitterWeight(h,d,lastPdf);}`),t}var gi=`
const TRIANGLE=0xfffffffcu;
var<private> meshGeometric:vec3f;
fn triangleBase(h:Hit)->u32 {return h.tri;}
fn meshCorner(b:u32)->vec3f {return vec3f(fl(b),fl(b+1u),fl(b+2u));}
fn meshBlend(open:vec3f,close:vec3f)->vec3f {return open*(1.0-motion)+close*motion;}
fn meshVertex(h:Hit,k:u32)->vec3f {
 let c=meshCorner(h.tri+k*4u);if(!meshDeforms(h)){return c;}
 let i=(h.tri-h.meshHead-scene[h.meshHead+1u])/16u;
 return meshBlend(meshCorner(h.meshHead+scene[h.mesh+27u]+scene[h.meshHead]*8u+i*12u+k*4u),c);
}
fn meshX(b:u32)->Xform {return Xform(vec4f(fl(b),fl(b+1u),fl(b+2u),fl(b+3u)),vec4f(fl(b+4u),fl(b+5u),fl(b+6u),fl(b+7u)),vec4f(fl(b+8u),fl(b+9u),fl(b+10u),fl(b+11u)));}
fn meshMotion(i:u32)->u32 {if(i==0u||motion>=1.0){return 0u;}let r=scene[i+31u];if(r==0u){return 0u;}return scene[2]+r;}
fn meshLocal(i:u32)->Xform {
 let p=meshMotion(i);if(p==0u){return meshX(i+12u);}
 let x=meshX(i);
 if(scene[p]==1u){
  let r=motionRotation(p+16u);let s=motionScale(p+16u);
  let t=mix(vec3f(fl(p+7u),fl(p+11u),fl(p+15u)),vec3f(x.r0.w,x.r1.w,x.r2.w),motion);
  let a=r[0]/s.x;let c=r[1]/s.y;let d=r[2]/s.z;
  return Xform(vec4f(a,-dot(a,t)),vec4f(c,-dot(c,t)),vec4f(d,-dot(d,t)));
 }
 return invertX(Xform(mix(rowAt(p+4u),x.r0,motion),mix(rowAt(p+8u),x.r1,motion),mix(rowAt(p+12u),x.r2,motion)));
}
fn meshModel(h:Hit)->Xform {if(meshMotion(h.mesh)==0u){return meshX(h.mesh+12u);}return h.ml;}
fn meshWorld(h:Hit)->Xform {if(meshMotion(h.mesh)==0u){return meshX(h.mesh);}return invertX(h.ml);}
fn meshWorldNormal(h:Hit,n:vec3f)->vec3f {
 if(h.mesh==0u){return n;}let lx=meshModel(h);
 return normalize(n.x*lx.r0.xyz+n.y*lx.r1.xyz+n.z*lx.r2.xyz);
}
fn meshDeforms(h:Hit)->bool {return h.mesh!=0u&&motion<1.0&&scene[h.mesh+27u]!=0u;}
fn triangleNormal(h:Hit)->vec3f {if(!meshDeforms(h)){return meshWorldNormal(h,meshCorner(h.tri+12u));}return meshWorldNormal(h,h.ng);}
fn triangleShadingNormal(h:Hit)->vec3f {
 let ng=triangleNormal(h);let a=scene[triangleBase(h)+7u];if(a==0u){return h.sgn*ng;}
 let b=h.meshHead+a;if((scene[b+15u]&1u)==0u){return h.sgn*ng;}
 let n0=vec3f(fl(b),fl(b+1u),fl(b+2u));
 let n1=vec3f(fl(b+4u),fl(b+5u),fl(b+6u));
 let n2=vec3f(fl(b+8u),fl(b+9u),fl(b+10u));
 let v=n0*(1.0-h.bary.x-h.bary.y)+n1*h.bary.x+n2*h.bary.y;
 if(dot(v,v)<=1e-20){return h.sgn*ng;}
 let n=meshWorldNormal(h,normalize(v));return h.sgn*select(n,-n,dot(n,ng)<0.0);
}
fn meshTexel(h:Hit)->vec4f {
 let table=scene[0];let a=scene[triangleBase(h)+7u];
 if(table==0u||a==0u){return vec4f(1.0);}
 let b=h.meshHead+a;if((scene[b+15u]&2u)==0u){return vec4f(1.0);}
 let slot=u32(mat(h.value*MV+6u).x);if(slot==0u){return vec4f(1.0);}
 let uv0=vec2f(fl(b+3u),fl(b+7u));let uv1=vec2f(fl(b+11u),fl(b+12u));let uv2=vec2f(fl(b+13u),fl(b+14u));
 let uv=fract(uv0*(1.0-h.bary.x-h.bary.y)+uv1*h.bary.x+uv2*h.bary.y);
 let t=table+4u*(slot-1u);let w=scene[t+1u];let ht=scene[t+2u];
 let c=unpack4x8unorm(scene[scene[t]+min(u32(uv.y*f32(ht)),ht-1u)*w+min(u32(uv.x*f32(w)),w-1u)]);
 return vec4f(select(c.rgb/12.92,pow((c.rgb+0.055)/1.055,vec3f(2.4)),c.rgb>vec3f(0.04045)),c.a);
}
fn triangleHitNormal(h:Hit)->vec3f {return h.sgn*triangleNormal(h);}
fn hitNormal(h:Hit)->vec3f {
 if(h.inst==TRIANGLE){return triangleHitNormal(h);}
 return h.sgn*normalize(rowOf(localX(h.inst),h.axis));
}
fn triangleShading(h:Hit)->vec3f {return triangleShadingNormal(h);}
fn hitOffset(h:Hit,p:vec3f)->vec3f {
 if(h.inst==TRIANGLE){return triangleHitNormal(h)*max(1e-5,max(max(abs(p.x),abs(p.y)),abs(p.z))*9.53674316e-7);}
 return h.sgn*EPS*colOf(worldX(h.inst),h.axis);
}



fn meshBox(bl:vec3f,bh:vec3f,o:vec3f,d:vec3f,tMax:f32)->bool {
 var lo=0.0;var hi=tMax;
 for(var a=0u;a<3u;a++){
  let mn=bl[a];let mx=bh[a];
  if(d[a]==0.0){if(o[a]<mn||o[a]>mx){return false;}}
  else{let t0=(mn-o[a])/d[a];let t1=(mx-o[a])/d[a];
   let near=min(t0,t1);let far=max(t0,t1);
   lo=max(lo,near-abs(near)*2e-6);hi=min(hi,far+abs(far)*2e-6);
   if(lo>hi){return false;}
  }
 }
 return true;
}



fn meshProduct(x:f32,y:f32)->vec4u {
 let a=bitcast<u32>(x);let b=bitcast<u32>(y);
 let ea=(a>>23u)&255u;let eb=(b>>23u)&255u;
 let ma=(a&0x7fffffu)|select(0u,0x800000u,ea>0u);
 let mb=(b&0x7fffffu)|select(0u,0x800000u,eb>0u);
 let low=(ma&65535u)*(mb&65535u);
 let middle=(ma>>16u)*(mb&65535u)+(mb>>16u)*(ma&65535u)+(low>>16u);
 let high=(ma>>16u)*(mb>>16u)+(middle>>16u);
 return vec4u((middle<<16u)|(low&65535u),high,max(ea,1u)+max(eb,1u),(a^b)>>31u);
}
fn meshShift(v:vec2u,s:u32)->vec2u {
 if(s==0u){return v;}return vec2u(v.x<<s,(v.y<<s)|(v.x>>(32u-s)));
}



fn meshEdge(a:vec2f,b:vec2f)->f32 {
 let p=a.x*b.y;let q=a.y*b.x;let e=p-q;
 if(abs(e)>1e-6*(abs(p)+abs(q))){return e;}
 let x=meshProduct(a.x,b.y);let y=meshProduct(a.y,b.x);
 if(x.w!=y.w){return e;}
 let base=min(x.z,y.z);let sx=x.z-base;let sy=y.z-base;


 if(max(sx,sy)>16u){return e;}
 var left=meshShift(x.xy,sx);var right=meshShift(y.xy,sy);
 let less=left.y<right.y||(left.y==right.y&&left.x<right.x);
 if(less){let t=left;left=right;right=t;}
 let lo=left.x-right.x;let hi=left.y-right.y-select(0u,1u,left.x<right.x);
 let value=ldexp(f32(hi)*4294967296.0+f32(lo),i32(base)-300);
 return select(value,-value,(x.w!=0u)!=less);
}
fn triangleHit(p0:vec3f,p1:vec3f,p2:vec3f,o:vec3f,d:vec3f,tMax:f32)->vec3f {
 var kz=0u;if(abs(d.y)>abs(d.x)){kz=1u;}if(abs(d.z)>abs(d[kz])){kz=2u;}
 var kx=(kz+1u)%3u;var ky=(kx+1u)%3u;
 if(d[kz]<0.0){let t=kx;kx=ky;ky=t;}
 let sx=d[kx]/d[kz];let sy=d[ky]/d[kz];let sz=1.0/d[kz];
 let a=p0-o;let c=p2-o;let v=p1-o;
 let ax=a[kx]-sx*a[kz];let ay=a[ky]-sy*a[kz];
 let bx=v[kx]-sx*v[kz];let by=v[ky]-sy*v[kz];
 let cx=c[kx]-sx*c[kz];let cy=c[ky]-sy*c[kz];
 let u=meshEdge(vec2f(cx,cy),vec2f(bx,by));let w=meshEdge(vec2f(bx,by),vec2f(ax,ay));let q=meshEdge(vec2f(ax,ay),vec2f(cx,cy));
 if((min(min(u,w),q)<0.0)&&(max(max(u,w),q)>0.0)){return vec3f(-1.0);}
 let det=u+w+q;if(det==0.0){return vec3f(-1.0);}
 let t=(u*a[kz]+q*v[kz]+w*c[kz])*sz/det;
 if(t>0.0&&t<tMax){return vec3f(t,q/det,w/det);}return vec3f(-1.0);
}
fn meshBlas(head:u32,instance:u32,lx:Xform,section:u32,o:vec3f,d:vec3f,medium:u32,mInst:u32,h:ptr<function,Hit>){
 let count=scene[head];let triangles=head+scene[head+1u];
 var node=0u;
 loop{
  if(node>=count){break;}
  let b=head+4u+node*8u;var bl=meshCorner(b);var bh=meshCorner(b+4u);
  if(section!=0u){let q=section+node*8u;bl=meshBlend(meshCorner(q),bl);bh=meshBlend(meshCorner(q+4u),bh);}
  if(!meshBox(bl,bh,o,d,(*h).t)){node=scene[b+3u];continue;}
  let leaf=scene[b+7u];node++;
  if(leaf==0u){continue;}
  let tb=triangles+(leaf-1u)*16u;var p0=meshCorner(tb);var p1=meshCorner(tb+4u);var p2=meshCorner(tb+8u);var n=meshCorner(tb+12u);
  if(section!=0u){
   let q=section+count*8u+(leaf-1u)*12u;p0=meshBlend(meshCorner(q),p0);p1=meshBlend(meshCorner(q+4u),p1);p2=meshBlend(meshCorner(q+8u),p2);
   let c=cross(p1-p0,p2-p0);if(dot(c,c)>1e-30){n=normalize(c);}
  }
  let hit=triangleHit(p0,p1,p2,o,d,(*h).t);let t=hit.x;
  if(t<=0.0){continue;}
  let back=dot(n,d)>0.0;
  (*h).t=t;(*h).inst=TRIANGLE;(*h).tri=tb;(*h).meshHead=head;(*h).mesh=instance;(*h).ml=lx;(*h).ng=n;(*h).axis=0u;(*h).cell=vec3i(0);
  (*h).sgn=select(1.0,-1.0,back);(*h).bary=hit.yz;
  (*h).value=select(scene[tb+3u],0u,back&&mInst==TRIANGLE&&medium==scene[tb+3u]);
 }
}
fn meshClosest(o:vec3f,d:vec3f,medium:u32,mInst:u32,h:ptr<function,Hit>){
 let head=scene[2];if(head==0u){return;}
 let lone=scene[head+1u]!=0u;
 let count=select(scene[head],1u,lone);var node=0u;
 loop{
  if(node>=count){break;}
  var blas=head;var instance=0u;var section=0u;var lo=o;var ld=d;var lx=Xform(vec4f(1,0,0,0),vec4f(0,1,0,0),vec4f(0,0,1,0));
  if(lone){node++;}
  else{
   let b=head+16u+node*8u;
   if(!meshBox(meshCorner(b),meshCorner(b+4u),o,d,(*h).t)){node=scene[b+3u];continue;}
   let leaf=scene[b+7u];node++;if(leaf==0u){continue;}
   instance=head+scene[head+5u]+(leaf-1u)*32u;lx=meshLocal(instance);
   lo=vec3f(dot(lx.r0,vec4f(o,1.0)),dot(lx.r1,vec4f(o,1.0)),dot(lx.r2,vec4f(o,1.0)));

   ld=vec3f(dot(lx.r0.xyz,d),dot(lx.r1.xyz,d),dot(lx.r2.xyz,d));
   blas=head+scene[instance+24u];
   if(motion<1.0&&scene[instance+27u]!=0u){section=blas+scene[instance+27u];}
  }
  meshBlas(blas,instance,lx,section,lo,ld,medium,mInst,h);
 }
}
fn meshOccludes(o:vec3f,d:vec3f,tMax:f32)->bool {
 var h:Hit;h.t=tMax;h.inst=NONE;meshClosest(o,d,0u,NONE,&h);return h.inst==TRIANGLE;
}
`;function _i(e){let t=e,n=(e,n)=>{if(!t.includes(e))throw new f(`state`,`Mesh kernel mismatch; rebuild: https://margoengine.com/errors#voxel-pathtracer`);t=t.replace(e,n)};return n(`sgn:f32,cell:vec3i}`,`sgn:f32,cell:vec3i,tri:u32,bary:vec2f,mesh:u32,meshHead:u32,ml:Xform,ng:vec3f}`),n(`fn closest(`,gi+`
fn closest(`),n(`if(f.scene.w==0u){return h;}`,`meshClosest(o,d,medium,mInst,&h);
 if(f.scene.w==0u){return h;}`),n(`fn shadow(o:vec3f,d:vec3f,tMax:f32)->f32 {`,`fn shadow(o:vec3f,d:vec3f,tMax:f32)->f32 {
 if(meshOccludes(o,d,tMax)){return 0.0;}`),n(`fn edgeBand(h:Hit,lp:vec3f)->bool {`,`fn edgeBand(h:Hit,lp:vec3f)->bool {
 if(h.inst==TRIANGLE){return false;}`),n(`fn faceTexel(h:Hit,l:vec3f)->vec4f {`,`fn faceTexel(h:Hit,l:vec3f)->vec4f {
 if(h.inst==TRIANGLE){return meshTexel(h);}`),t=t.replace(`if(h.inst>=AREA||h.value==0u)`,`if(h.inst>=TRIANGLE||h.value==0u)`),n(`fn emitWeight(h:Hit,n:vec3f,d:vec3f,radiance:vec3f,lastPdf:f32)->f32 {`,`fn emitWeight(h:Hit,n:vec3f,d:vec3f,radiance:vec3f,lastPdf:f32)->f32 {
 if(h.inst==TRIANGLE){return 1.0;}`),n(`fn prismAt(inst:u32)->bool {return`,`fn prismAt(inst:u32)->bool {if(inst==TRIANGLE){return false;}return`),n(`fn mirrorAt(inst:u32)->bool {return`,`fn mirrorAt(inst:u32)->bool {if(inst==TRIANGLE){return false;}return`),n(`let inGlass=medium!=0u&&(material(medium).flags&MEDIA)==0u;`,`let inGlass=medium!=0u&&(material(medium).flags&MEDIA)==0u;
 if(inGlass&&mInst==TRIANGLE){return;}`),n(`chainOk=true;chainSet=md.media;`,`chainOk=mInst!=TRIANGLE;chainSet=md.media;`),n(`chainOk=true;chainSet=inAir;`,`chainOk=mInst!=TRIANGLE;chainSet=inAir;`),n(`fn evalAt(kind:u32,m:Mat,n:vec3f,wo:vec3f,wi:vec3f,mask:u32)->Eval {`,`fn evalAt(kind:u32,m:Mat,n:vec3f,wo:vec3f,wi:vec3f,mask:u32)->Eval {
 if(kind==0u&&dot(meshGeometric,meshGeometric)>0.0&&dot(meshGeometric,wi)<=0.0){return Eval(vec3f(0.0),0.0);}`),n(`  // Light sampled at a glossy metal`,`  meshGeometric=vec3f(0.0);if(!scatter&&h.inst==TRIANGLE){meshGeometric=triangleHitNormal(h); }
  // Light sampled at a glossy metal`),n(`let s=dielectric(mm.alpha,n,-d,mm.ior,sm);
     if(!s.ok){break;}`,`let s=dielectric(mm.alpha,n,-d,mm.ior,sm);
     if(!s.ok){break;}
     if(h.inst==TRIANGLE&&select(dot(triangleHitNormal(h),s.wi)<=0.0,dot(triangleHitNormal(h),s.wi)>=0.0,s.transmit)){break;}`),n(`if(!s.ok){done=true;continue;}`,`if(!s.ok){done=true;continue;}
  if(h.inst==TRIANGLE&&select(dot(triangleHitNormal(h),s.wi)<=0.0,dot(triangleHitNormal(h),s.wi)>=0.0,s.transmit)){done=true;continue;}`),n(`let wn=h.sgn*normalize(rowOf(localX(h.inst),h.axis));`,`let wn=hitNormal(h);`),n(`let woff=h.sgn*EPS*colOf(worldX(h.inst),h.axis);`,`let woff=hitOffset(h,wp);`),n(`if(h.inst!=GROUND){n=rowOf(localX(h.inst),h.axis);}`,`if(h.inst!=GROUND){n=hitNormal(h);}`),n(`let lx=localX(h.inst);let lp=xpoint(lx,p);
    n=h.sgn*normalize(rowOf(lx,h.axis));
    off=h.sgn*EPS*colOf(worldX(h.inst),h.axis);`,`var lp=p;
    if(h.inst==TRIANGLE){n=triangleShading(h);}else{let lx=localX(h.inst);lp=xpoint(lx,p);n=h.sgn*normalize(rowOf(lx,h.axis));}
    off=hitOffset(h,p);`),n(`let lx=localX(h.inst);let lp=xpoint(lx,p);
    n=normalize(h.sgn*rowOf(lx,h.axis));m=material(h.value);`,`var lp=p;
    if(h.inst==TRIANGLE){n=triangleShading(h);}else{let lx=localX(h.inst);lp=xpoint(lx,p);n=normalize(h.sgn*rowOf(lx,h.axis));}m=material(h.value);`),n(`else if(h.inst!=NONE){v=f32(h.inst+1u)*256.0+f32(h.value&255u);}`,`else if(h.inst==TRIANGLE){v=-f32(scene[triangleBase(h)+15u]+select(0u,scene[h.mesh+25u],h.mesh!=0u)+4u);}else if(h.inst!=NONE){v=f32(h.inst+1u)*256.0+f32(h.value&255u);}`),hi(t)}function vi(){return Object.freeze({id:`mesh`,source:_i,geometry:()=>new pi})}function yi(e,t,n,r){if(typeof e!=`number`)throw TypeError(`SpectralVoxelPathTracer ${t} must be a number`);if(!Number.isFinite(e)||e<n||e>r)throw RangeError(`SpectralVoxelPathTracer ${t} must be finite and between ${n} and ${r}`);return e}function bi(e={}){u(e,`spectralTransport`);let t=yi(e.lensAbbe===void 0?0:e.lensAbbe,`lensAbbe`,0,200),n=yi(e.focalLength===void 0?.05:e.focalLength,`focalLength`,1e-6,1e6);if(t!==0&&t<5)throw RangeError(`SpectralVoxelPathTracer lensAbbe must be 0 or 5 to 200`);return Object.freeze({id:`spectral`,source:e=>xi(e,t,n)})}function xi(e,t,n){let r=e,i=(e,t)=>{if(!r.includes(e))throw new f(`state`,`Spectral kernel mismatch; rebuild the package, see https://margoengine.com/errors#voxel-pathtracer`);r=r.replace(e,t)};i(`fn radiance(px:vec2u)->Path {`,`var<private> spectralLambda:f32;
fn radiance(px:vec2u)->Path {`),i(` let ray=cameraRay(vec2f(px)+jit);`,` var cameraLambda=bitcast<f32>(f.lights.w);var cameraWeight=vec3f(1.0);
 if(${t>0?`true`:`false`}&&f.forward.w>0.0&&f.projection.x==0u){collapse(&cameraLambda,&cameraWeight);}
 spectralLambda=cameraLambda;
 let ray=cameraRay(vec2f(px)+jit);`),i(`var thr=vec3f(1.0);var L=vec3f(0.0);`,`var thr=cameraWeight;var L=vec3f(0.0);`),i(`var lambda=bitcast<f32>(f.lights.w);`,`var lambda=cameraLambda;`),i(`  let ray=cameraRay(vec2f(px)+(vec2f(f32(s%8u),f32(s/8u))`,`  spectralLambda=bitcast<f32>(f.lights.w);
  if(${t>0?`true`:`false`}&&f.forward.w>0.0&&f.projection.x==0u&&spectralLambda<=0.0){spectralLambda=380.0+400.0*rand();}
  let ray=cameraRay(vec2f(px)+(vec2f(f32(s%8u),f32(s/8u))`),i(` s.ok=true;
 return s;
}
// One lobe`,` s.w*=select(1.0,eta*eta,s.transmit);
 s.ok=true;
 return s;
}
// One lobe`),i(`wT*=1.0-fr;`,`wT*=(1.0-fr)*ma.ior*ma.ior;`),i(`*(1.0-fr);wJ*=`,`*(1.0-fr)*eta*eta;wJ*=`);let a=t===0?0:1/(t*(1/.4861**2-1/.6563**2)*n);return t>0&&i(`r.d=normalize(focus-r.o);`,`r.d=normalize(focus-r.o);
  let um=spectralLambda*0.001;
  let dp=${a.toExponential(12)}*(1.0/(um*um)-1.0/(0.5876*0.5876));
  r.d=normalize(r.d/dot(r.d,fw)-(rt*l.x+up*l.y)*dp);`),r}var Si=e({open:()=>Mi}),Ci=document.querySelector(`#glasshouse`),wi=document.querySelector(`#exhibit`),Ti=document.querySelector(`#status`),Ei=new URLSearchParams(location.search).get(`capture`),Di=Ei!==null&&Ei!==`opening`,Oi=Ei===`opening`&&new URLSearchParams(location.search).get(`glass`)===`fixed`,ki={aperture:.025,lensBlades:9,exposure:-.14,clamp:3.25,denoise:`auto`,maxBounces:11};function Ai(e,t){let n=Math.min(1,Math.max(0,t/10)),r=n*n*(3-2*n);e.camera.position=[2.13-.54*r,1.23-.16*r,3.9-.67*r],e.camera.target=[.31+.39*r,.45-.12*r,.13+.22*r]}function ji(){let e=Math.max(1,Math.min(1280,Math.round(Ci.parentElement.clientWidth*devicePixelRatio))),t=Math.max(1,Math.round(e*9/16));return Ci.width===e&&Ci.height===t?!1:(Ci.width=e,Ci.height=t,!0)}async function Mi(e,{signal:n,ready:r,sampleCount:i,onError:a,capturePrepared:s,selected:c,active:l,attach:u}){let d,f,p,m=!1,h=!1,g=!1;function _(){g||(g=!0,p?.disconnect(),f!==void 0&&cancelAnimationFrame(f),d?.dispose(),e.dispose())}function v(e){n.aborted||g||(a(e),queueMicrotask(_))}n.addEventListener(`abort`,_,{once:!0}),n.throwIfAborted(),e.onError=v;let y=[vi(),bi()];if(Di){let{causticGuiding:e}=await t(async()=>{let{causticGuiding:e}=await import(`./guiding-ITi057R0.js`);return{causticGuiding:e}},[],import.meta.url);y.push(e({guideStrength:.67}))}let b=Di?{aperture:.025,exposure:-.2,denoise:`auto`,maxBounces:11}:ki,x=Ei===null?c():Oi?`fixed`:`flint`,S=o({analyticSlits:!Di}),C=e=>e===`flint`?S:{...S,materials:S.materials.map(e=>e.id===4?{...e,abbe:0}:e)};if(d=await Jr.create(e,{scene:C(x),features:y,...b,samplesPerFrame:3,maxSamples:144,signal:n}),performance.mark(`glasshouse-mesh-ready`),await d.ready,n.throwIfAborted(),performance.mark(`glasshouse-pipelines-ready`),wi.dataset.renderer=e.gpu.adapterInfo?.vendor===`margo-webgl2`?`compatibility`:`webgpu`,wi.dataset.triangles=String(d.stats.meshTriangles),Ai(e,0),Ei!==null){window.captureGlasshouseFrame=async({time:t=0,width:r=1440,height:i=810,sampleCount:a=96,denoise:o=!0,timeout:s=48e3}={})=>{Ai(e,t),e.render({delta:0});let c=await d.capture({width:r,height:i,samples:a,denoise:o,signal:AbortSignal.any([n,AbortSignal.timeout(s)])});return Array.from(new Uint8Array(await c.arrayBuffer()))},window.drawGlasshouseFrame=async({time:t,width:n,height:r,passes:i})=>{Ci.width!==n&&(Ci.width=n),Ci.height!==r&&(Ci.height=r),Ai(e,t);for(let t=0;t<i;t++)e.render({delta:0}),await e.gpu.queue.onSubmittedWorkDone();return d.stats.samples},wi.dataset.captureReady=`true`,Ti.hidden=!0,s();return}function w(){f===void 0&&!h&&!g&&!n.aborted&&l()&&(f=requestAnimationFrame(E))}function T(){return n.throwIfAborted(),new Promise((t,n)=>{e.render({delta:0}),Ci.toBlob(e=>{e?t(e):n(Error(`The rendered frame could not be saved.`))},`image/png`)})}async function E(){if(f=void 0,!(n.aborted||g||!l())){h=!0;try{let t=c();if(t!==x&&(await d.setScene(C(t),{signal:n}),n.throwIfAborted(),x=t,m=!1,wi.dataset.samples=`0`),!l()||c()!==x||(e.render({delta:0}),await e.gpu.queue.onSubmittedWorkDone(),n.aborted||g))return;let a=d.stats.samples;a>=39&&!m&&c()===x&&l()?(m=!0,r({snapshot:T,samples:a,glass:x})):m&&i(a,x),wi.dataset.samples=String(a)}catch(e){v(e)}finally{h=!1,!g&&(!d.stats.converged||c()!==x)&&w()}}}p=new ResizeObserver(()=>{ji()&&w()}),p.observe(Ci.parentElement),u({refresh(){m=!1,w()}}),w()}export{jn as a,En as i,fn as n,f as o,Mi as open,rn as r,u as s,Si as t};