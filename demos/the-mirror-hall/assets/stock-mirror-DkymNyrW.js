import{a as e,i as t,n,o as r,r as i,s as a,t as o}from"./matrix4-C0CUW6df.js";import{a as s,c,i as l,l as u,n as d,o as f,r as p,s as m,t as h,u as g}from"./ssr-bRfq9wmx-DwydA6T6.js";import{r as _}from"./gallery-BZXMxGla.js";var v=0,y=1,b=2,x=e=>{if(e===void 0||e===`double`)return v;if(e===`front`)return y;if(e===`back`)return b;throw TypeError(`Unknown side ${String(e)}; use 'front', 'back' or 'double'`)};function S(e,t,n,r,i,a,o,s,c,l,u,d,f,p,m,h,g,_,b){let x=l-o,S=u-s,w=d-c,T=f-o,E=p-s,D=m-c,O=i*D-a*E,k=a*T-r*D,A=r*E-i*T,j=x*O+S*k+w*A;if(h===v?j===0:h===y?!(j>0):!(j<0))return C(e,t,n,r,i,a,o,s,c,l,u,d,f,p,m,h,g,_,b);let M=1/j,N=e-o,P=t-s,F=n-c,I=(N*O+P*k+F*A)*M;if(!(I>=0&&I<=1))return C(e,t,n,r,i,a,o,s,c,l,u,d,f,p,m,h,g,_,b);let L=P*w-F*S,R=F*x-N*w,z=N*S-P*x,B=(r*L+i*R+a*z)*M;if(!(B>=0&&I+B<=1))return C(e,t,n,r,i,a,o,s,c,l,u,d,f,p,m,h,g,_,b);let V=(T*L+E*R+D*z)*M;return V>=g&&V<=_&&(b[0]=V,b[1]=I,b[2]=B,b[3]=j,!0)}function C(e,t,n,r,i,a,o,s,c,l,u,d,f,p,m,h,g,_,b){let x=Math.abs(r),S=Math.abs(i),C=Math.abs(a),w=x>=S&&x>=C?0:S>=C?1:2,T=w===0?r:w===1?i:a;if(T===0)return!1;let E=w===2?0:w+1,D=E===2?0:E+1;if(T<0){let e=E;E=D,D=e}let O=(e,t,n,r)=>e===0?t:e===1?n:r,k=O(E,r,i,a)/T,A=O(D,r,i,a)/T,j=O(w,o-e,s-t,c-n),M=O(w,l-e,u-t,d-n),N=O(w,f-e,p-t,m-n),P=O(E,o-e,s-t,c-n)-k*j,F=O(D,o-e,s-t,c-n)-A*j,I=O(E,l-e,u-t,d-n)-k*M,L=O(D,l-e,u-t,d-n)-A*M,R=O(E,f-e,p-t,m-n)-k*N,z=O(D,f-e,p-t,m-n)-A*N,B=R*L-z*I,V=P*z-F*R,H=I*F-L*P;if((B<0||V<0||H<0)&&(B>0||V>0||H>0))return!1;let U=B+V+H;if(h===v?U===0:h===y?!(U>0):!(U<0))return!1;let W=(B*j+V*M+H*N)/U/T;return W>=g&&W<=_&&(b[0]=W,b[1]=V/U,b[2]=H/U,b[3]=U,!0)}function w(e,t,n,r,i,a,o,s,c,l,u,d,f){let p=o-r,m=s-i,h=c-a,g=l-r,_=u-i,v=d-a,y=e-r,b=t-i,x=n-a,S=p*y+m*b+h*x,C=g*y+_*b+v*x,w,T,E;if(S<=0&&C<=0)w=1,T=0,E=0;else{let r=e-o,i=t-s,a=n-c,f=p*r+m*i+h*a,y=g*r+_*i+v*a;if(f>=0&&y<=f)w=0,T=1,E=0;else{let r=S*y-f*C;if(r<=0&&S>=0&&f<=0){let e=S-f,t=e>0?S/e:0;w=1-t,T=t,E=0}else{let i=e-l,a=t-u,o=n-d,s=p*i+m*a+h*o,c=g*i+_*a+v*o;if(c>=0&&s<=c)w=0,T=0,E=1;else{let e=s*C-S*c;if(e<=0&&C>=0&&c<=0){let e=C-c,t=e>0?C/e:0;w=1-t,T=0,E=t}else{let t=f*c-s*y;if(t<=0&&y-f>=0&&s-c>=0){let e=y-f+(s-c),t=e>0?(y-f)/e:0;w=0,T=1-t,E=t}else{let n=t+e+r;if(n>0){let t=e/n,i=r/n;w=1-t-i,T=t,E=i}else w=1,T=0,E=0}}}}}}let D=w*r+T*o+E*l,O=w*i+T*s+E*u,k=w*a+T*c+E*d;f[0]=D,f[1]=O,f[2]=k,f[3]=w,f[4]=T,f[5]=E;let A=D-e,j=O-t,M=k-n;return A*A+j*j+M*M}var T=new Float64Array(12),E=new Float64Array(18),D=new Float64Array(9),O=new Float64Array(9);function k(e,t,n){let r=e*T[0]+t*T[1]+n*T[2],i=e*T[3]+t*T[4]+n*T[5],a=e*T[6]+t*T[7]+n*T[8],o=T[9]*Math.abs(e)+T[10]*Math.abs(t)+T[11]*Math.abs(n);return!(Math.min(r,i,a)>o||Math.max(r,i,a)<-o)}function A(e,t,n){let r=e*E[0]+t*E[1]+n*E[2],i=e*E[3]+t*E[4]+n*E[5],a=e*E[6]+t*E[7]+n*E[8],o=e*E[9]+t*E[10]+n*E[11],s=e*E[12]+t*E[13]+n*E[14],c=e*E[15]+t*E[16]+n*E[17];return Math.max(r,i,a)<Math.min(o,s,c)||Math.max(o,s,c)<Math.min(r,i,a)}function j(e,t,n,r,i,a,o){let s=(t+i)*.5,c=(n+a)*.5,l=(r+o)*.5,u=(i-t)*.5,d=(a-n)*.5,f=(o-r)*.5,p=e[0]-s,m=e[1]-c,h=e[2]-l,g=e[3]-s,_=e[4]-c,v=e[5]-l,y=e[6]-s,b=e[7]-c,x=e[8]-l;if(Math.min(p,g,y)>u||Math.max(p,g,y)<-u||Math.min(m,_,b)>d||Math.max(m,_,b)<-d||Math.min(h,v,x)>f||Math.max(h,v,x)<-f)return!1;let S=g-p,C=_-m,w=v-h,E=y-g,D=b-_,O=x-v,A=p-y,j=m-b,M=h-x,N=C*O-w*D,P=w*E-S*O,F=S*D-C*E,I=N*p+P*m+F*h,L=u*Math.abs(N)+d*Math.abs(P)+f*Math.abs(F);return I>L||I<-L?!1:(T[0]=p,T[1]=m,T[2]=h,T[3]=g,T[4]=_,T[5]=v,T[6]=y,T[7]=b,T[8]=x,T[9]=u,T[10]=d,T[11]=f,k(0,-w,C)&&k(0,-O,D)&&k(0,-M,j)&&k(w,0,-S)&&k(O,0,-E)&&k(M,0,-A)&&k(-C,S,0)&&k(-D,E,0)&&k(-j,A,0))}function M(e,t,n,r){let i=e[t],a=e[t+1],o=e[t+2],s=e[t+3],c=e[t+4],l=e[t+5],u=e[t+6],d=e[t+7],f=e[t+8],p=n[r],m=n[r+1],h=n[r+2],g=n[r+3],_=n[r+4],v=n[r+5],y=n[r+6],b=n[r+7],x=n[r+8];if(Math.max(i,s,u)<Math.min(p,g,y)||Math.max(p,g,y)<Math.min(i,s,u)||Math.max(a,c,d)<Math.min(m,_,b)||Math.max(m,_,b)<Math.min(a,c,d)||Math.max(o,l,f)<Math.min(h,v,x)||Math.max(h,v,x)<Math.min(o,l,f))return!1;let S=D,C=O;S[0]=s-i,S[1]=c-a,S[2]=l-o,S[3]=u-s,S[4]=d-c,S[5]=f-l,S[6]=i-u,S[7]=a-d,S[8]=o-f,C[0]=g-p,C[1]=_-m,C[2]=v-h,C[3]=y-g,C[4]=b-_,C[5]=x-v,C[6]=p-y,C[7]=m-b,C[8]=h-x,E[0]=i,E[1]=a,E[2]=o,E[3]=s,E[4]=c,E[5]=l,E[6]=u,E[7]=d,E[8]=f,E[9]=p,E[10]=m,E[11]=h,E[12]=g,E[13]=_,E[14]=v,E[15]=y,E[16]=b,E[17]=x;let w=S[1]*S[5]-S[2]*S[4],T=S[2]*S[3]-S[0]*S[5],k=S[0]*S[4]-S[1]*S[3],j=C[1]*C[5]-C[2]*C[4],M=C[2]*C[3]-C[0]*C[5],N=C[0]*C[4]-C[1]*C[3];if(A(w,T,k)||A(j,M,N))return!1;for(let e=0;e<9;e+=3){let t=S[e],n=S[e+1],r=S[e+2];for(let e=0;e<9;e+=3){let i=C[e],a=C[e+1],o=C[e+2];if(A(n*o-r*a,r*i-t*o,t*a-n*i))return!1}}for(let e=0;e<9;e+=3)if(A(T*S[e+2]-k*S[e+1],k*S[e]-w*S[e+2],w*S[e+1]-T*S[e])||A(M*C[e+2]-N*C[e+1],N*C[e]-j*C[e+2],j*C[e+1]-M*C[e]))return!1;return!0}function N(e,t,n,r,i,a,o,s,c,l,u){for(let d=0;d<t*4;d+=4){let t=e[d],f=e[d+1],p=e[d+2],m=e[d+3];if(t*n+f*r+p*i+m<0&&t*a+f*o+p*s+m<0&&t*c+f*l+p*u+m<0)return!0}return!1}function P(e,t,n,r,i,a=0){i[a]=e[0]*t+e[4]*n+e[8]*r+e[12],i[a+1]=e[1]*t+e[5]*n+e[9]*r+e[13],i[a+2]=e[2]*t+e[6]*n+e[10]*r+e[14]}var F=new Int32Array(512),I=new Float64Array(512),L=new Float64Array(4),R=new Float64Array(6),z=new Float64Array(6),B=new Float64Array(9),V=1e-7,H=1213612630,U=e=>!!e&&e.vertices instanceof Float32Array&&e.indices instanceof Uint32Array;function W(e){if(U(e))return{positions:e.vertices,stride:6,normals:e.vertices,normalStride:6,normalOffset:3};if(!e||!e.positions)throw TypeError(`Expected a Geometry or {positions, indices}`);let t=e.stride??3,n=e.precision??`float32`;if(n!==`float32`&&n!==`float64`)throw TypeError(`Triangle source precision ${String(n)} is invalid; use 'float32' or 'float64'.`);let r=n===`float64`?Float64Array:Float32Array,i=e.positions instanceof r?e.positions:r.from(e.positions),a=e.normals?e.normals instanceof Float32Array?e.normals:Float32Array.from(e.normals):null;if(a&&i.length>=3&&a.length<Math.floor((i.length-3)/t)*t+3)throw RangeError(`normals are shorter than positions; supply one normal per vertex`);return{positions:i,stride:t,normals:a,normalStride:t,normalOffset:0}}function ee(e,t){let n=e.indices;return!n||n instanceof Uint32Array?n??null:(r(t.positions,t.stride,n),Uint32Array.from(n))}var te=class n{static fromGeometry(e,t){if(!U(e))throw TypeError(`Expected Geometry`);return n.build(e,t)}static build(e,r){let i=W(e),a=ee(e,i);return new n(t(i.positions,i.stride,a,r),U(e)?e:{positions:i.positions,stride:i.stride,normals:i.normals,precision:e.precision})}static deserialize(e,t){if(!e||e.version!==1)throw TypeError(`Unknown serialized BVH version; rebuild the BVH with this release and serialize it again`);return new n({nodes:e.nodes,index:e.index,triangles:e.triangles},t)}static fromArrayBuffer(e,t){if(!(e instanceof ArrayBuffer)||e.byteLength<16)throw TypeError(`Expected a BVH ArrayBuffer`);let[r,i,a,o]=new Uint32Array(e,0,4);if(r!==H||i!==1)throw TypeError(`Not a Margo Engine BVH buffer; pass the output of toArrayBuffer()`);let s=a*8*4;if(e.byteLength!==16+s+o*16)throw RangeError(`Truncated BVH buffer; re-read the whole file or serialize again`);return new n({nodes:e.slice(16,16+s),index:new Uint32Array(e,16+s,o*3),triangles:new Uint32Array(e,16+s+o*12,o)},t)}constructor(e,t){this.revision=0;let n=W(t);if(this.positions=n.positions,this.stride=n.stride,this.normals=n.normals,this.normalStride=n.normalStride,this.normalOffset=n.normalOffset,!(e.nodes instanceof ArrayBuffer)||!e.nodes.byteLength||e.nodes.byteLength%32)throw RangeError(`Invalid BVH nodes; pass the unmodified output of serialize()`);if(!(e.index instanceof Uint32Array)||!(e.triangles instanceof Uint32Array)||e.index.length!==e.triangles.length*3||!e.triangles.length)throw RangeError(`Invalid BVH triangles; pass the unmodified output of serialize()`);this.nodes=e.nodes,this.nodeBounds=new Float32Array(e.nodes),this.nodeData=new Uint32Array(e.nodes),this.index=e.index,this.triangles=e.triangles,r(this.positions,this.stride,this.index);let i=this.nodeData,a=this.nodeCount,o=0,s=0;for(let e=0,t=0;e<a;e++,t+=8){let n=i[t+7];if(n&2147483648){if((n&2147483647)>2||i[t+6]<=e+1||i[t+6]>=a)throw RangeError(`Invalid BVH node links; pass the unmodified output of serialize()`)}else{if(!n||i[t+6]!==o)throw RangeError(`Invalid BVH leaf ranges; pass the unmodified output of serialize()`);o+=n,s++}}if(o!==this.triangleCount)throw RangeError(`BVH leaves do not cover every triangle; pass the unmodified output of serialize()`);let c=new Uint32Array(s),l=0;for(let e=a-1;e>=0;e--){let t=e*8;if(i[t+7]&2147483648){if(l<2||c[l-1]!==e+1||c[l-2]!==i[t+6])throw RangeError(`Invalid BVH node links; pass the unmodified output of serialize()`);l-=2}c[l++]=e}if(l!==1)throw RangeError(`Invalid BVH node links; pass the unmodified output of serialize()`)}get nodeCount(){return this.nodeData.length/8}get triangleCount(){return this.triangles.length}getBoundingBox(){let e=this.nodeBounds;return{min:[e[0],e[1],e[2]],max:[e[3],e[4],e[5]]}}isLeaf(e){return!(this.nodeData[e*8+7]&i)}leafTriangles(e){let t=e*8,n=this.nodeData[t+7];if(n&2147483648)throw RangeError(`Not a leaf node; check isLeaf(node) before calling leafTriangles`);return this.triangles.subarray(this.nodeData[t+6],this.nodeData[t+6]+n)}serialize({copy:e=!0}={}){return e?{version:1,nodes:this.nodes.slice(0),index:this.index.slice(),triangles:this.triangles.slice()}:{version:1,nodes:this.nodes,index:this.index,triangles:this.triangles}}toArrayBuffer(){let e=this.nodes.byteLength,t=this.triangleCount,n=new ArrayBuffer(16+e+t*16);return new Uint32Array(n,0,4).set([H,1,this.nodeCount,t]),new Uint8Array(n,16,e).set(new Uint8Array(this.nodes)),new Uint32Array(n,16+e,t*3).set(this.index),new Uint32Array(n,16+e+t*12,t).set(this.triangles),n}refit(){this.revision++;let t=this.nodeBounds,n=this.nodeData,r=this.index,i=this.positions,o=this.stride;for(let s=this.nodeCount-1;s>=0;s--){let c=s*8,l=n[c+7];if(l&2147483648){let e=c+8,r=n[c+6]*8;t[c]=Math.min(t[e],t[r]),t[c+1]=Math.min(t[e+1],t[r+1]),t[c+2]=Math.min(t[e+2],t[r+2]),t[c+3]=Math.max(t[e+3],t[r+3]),t[c+4]=Math.max(t[e+4],t[r+4]),t[c+5]=Math.max(t[e+5],t[r+5])}else{let s=1/0,u=1/0,d=1/0,f=-1/0,p=-1/0,m=-1/0;for(let e=n[c+6]*3,t=e+l*3;e<t;e++){let t=r[e]*o,n=i[t],a=i[t+1],c=i[t+2];n<s&&(s=n),n>f&&(f=n),a<u&&(u=a),a>p&&(p=a),c<d&&(d=c),c>m&&(m=c)}t[c]=a(s),t[c+1]=a(u),t[c+2]=a(d),t[c+3]=e(f),t[c+4]=e(p),t[c+5]=e(m)}}}intersectsSegment(e,t,n={}){let r=[t[0]-e[0],t[1]-e[1],t[2]-e[2]],i=Math.hypot(r[0],r[1],r[2]);return!!this.raycastFirst({origin:e,direction:r},{...n,near:i*V,far:i*.9999999})}raycastFirst(e,t={}){let{origin:n,direction:r}=e,[i,a,o]=re(r,t),s=x(t.side),c=t.includeFace,l=n[0],u=n[1],d=n[2],f=r[0],p=r[1],m=r[2],h=this.nodeBounds,g=this.nodeData,_=this.index,v=this.positions,y=this.stride,b=1/f,C=1/p,w=1/m,T=ie(b,C,w),E=a,D=-1,O=0,k=0,A=0,j=0,M=T?G(h,0,l,u,d,b,C,w,i,E):K(h,0,l,u,d,f,p,m,b,C,w,i,E);for(M!==1/0&&(F[j]=0,I[j++]=M);j;){let e=F[--j],t=I[j];if(t>E+V*(Math.abs(E)+Math.abs(t)+1))continue;let n=e*8,r=g[n+7];if(r&2147483648){let t=e+1,r=g[n+6],a=T?G(h,t*8,l,u,d,b,C,w,i,E):K(h,t*8,l,u,d,f,p,m,b,C,w,i,E),o=T?G(h,r*8,l,u,d,b,C,w,i,E):K(h,r*8,l,u,d,f,p,m,b,C,w,i,E);a<=o?(o!==1/0&&(F[j]=r,I[j++]=o),a!==1/0&&(F[j]=t,I[j++]=a)):(a!==1/0&&(F[j]=t,I[j++]=a),F[j]=r,I[j++]=o)}else for(let e=g[n+6],t=e+r;e<t;e++){let t=_[e*3]*y,n=_[e*3+1]*y,r=_[e*3+2]*y;S(l,u,d,f,p,m,v[t],v[t+1],v[t+2],v[n],v[n+1],v[n+2],v[r],v[r+1],v[r+2],s,i,E,L)&&(D<0||L[0]<E||L[0]===E&&this.triangles[e]<this.triangles[D])&&(!c||c(this.triangles[e]))&&(E=L[0],D=e,O=L[1],k=L[2],A=L[3])}}return D<0?null:this.makeHit(D,E,O,k,A,l,u,d,f,p,m,o)}raycast(e,t={}){let{origin:n,direction:r}=e,[i,a,o]=re(r,t),s=x(t.side),c=t.includeFace,l=n[0],u=n[1],d=n[2],f=r[0],p=r[1],m=r[2],h=this.nodeBounds,g=this.nodeData,_=this.index,v=this.positions,y=this.stride,b=1/f,C=1/p,w=1/m,T=ie(b,C,w),E=[],D=0;for(F[D++]=0;D;){let e=F[--D],t=e*8;if((T?G(h,t,l,u,d,b,C,w,i,a):K(h,t,l,u,d,f,p,m,b,C,w,i,a))===1/0)continue;let n=g[t+7];if(n&2147483648)F[D++]=g[t+6],F[D++]=e+1;else for(let e=g[t+6],r=e+n;e<r;e++){let t=_[e*3]*y,n=_[e*3+1]*y,r=_[e*3+2]*y;S(l,u,d,f,p,m,v[t],v[t+1],v[t+2],v[n],v[n+1],v[n+2],v[r],v[r+1],v[r+2],s,i,a,L)&&(!c||c(this.triangles[e]))&&E.push(this.makeHit(e,L[0],L[1],L[2],L[3],l,u,d,f,p,m,o))}}return E.sort((e,t)=>e.distance-t.distance||e.faceIndex-t.faceIndex)}makeHit(e,t,n,r,i,a,o,s,c,l,u,d){let f=this.index[e*3],p=this.index[e*3+1],m=this.index[e*3+2],h=1-n-r,g=this.faceNormal(f,p,m);return{distance:t*d,point:[a+c*t,o+l*t,s+u*t],faceIndex:this.triangles[e],face:[f,p,m],barycoord:[h,n,r],normal:this.interpolateNormal(f,p,m,h,n,r,g),faceNormal:g,frontFace:i>0}}faceNormal(e,t,n){let r=this.positions,i=this.stride,a=e*i,o=t*i,s=n*i,c=r[o]-r[a],l=r[o+1]-r[a+1],u=r[o+2]-r[a+2],d=r[s]-r[a],f=r[s+1]-r[a+1],p=r[s+2]-r[a+2];return se(l*p-u*f,u*d-c*p,c*f-l*d)}interpolateNormal(e,t,n,r,i,a,o){let s=this.normals;if(!s)return[o[0],o[1],o[2]];let c=this.normalStride,l=this.normalOffset,u=e*c+l,d=t*c+l,f=n*c+l,p=se(s[u]*r+s[d]*i+s[f]*a,s[u+1]*r+s[d+1]*i+s[f+1]*a,s[u+2]*r+s[d+2]*i+s[f+2]*a);return p[0]||p[1]||p[2]?p:[o[0],o[1],o[2]]}closestPointToPoint(e,{maxDistance:t=1/0,minDistance:n=0}={}){if(!(t>=0)||!(n>=0))throw RangeError(`Distances must be >= 0`);let r=e[0],i=e[1],a=e[2],o=this.nodeBounds,s=this.nodeData,c=this.index,l=this.positions,u=this.stride,d=n*n,f=t*t,p=-1,m=0;F[m]=0,I[m++]=q(o,0,r,i,a);search:for(;m;){let e=F[--m],t=e*8;if(I[m]>f*1.0000001+V)continue;let n=s[t+7];if(n&2147483648){let n=e+1,c=s[t+6],l=q(o,n*8,r,i,a),u=q(o,c*8,r,i,a);l<u?(F[m]=c,I[m++]=u,F[m]=n,I[m++]=l):(F[m]=n,I[m++]=l,F[m]=c,I[m++]=u)}else for(let e=s[t+6],o=e+n;e<o;e++){let t=c[e*3]*u,n=c[e*3+1]*u,o=c[e*3+2]*u,s=w(r,i,a,l[t],l[t+1],l[t+2],l[n],l[n+1],l[n+2],l[o],l[o+1],l[o+2],R);if((s<f||p<0&&s<=f)&&(f=s,p=e,z.set(R),f<=d))break search}}return p<0?null:{point:[z[0],z[1],z[2]],distance:Math.sqrt(f),faceIndex:this.triangles[p],barycoord:[z[3],z[4],z[5]]}}intersectsSphere(e,t){if(!(t>=0))throw RangeError(`Radius must be >= 0`);let n=e[0],r=e[1],i=e[2],a=t*t,o=this.nodeBounds,s=this.nodeData,c=this.index,l=this.positions,u=this.stride,d=0;for(F[d++]=0;d;){let e=F[--d],t=e*8;if(q(o,t,n,r,i)>a*1.0000001+V)continue;let f=s[t+7];if(f&2147483648)F[d++]=s[t+6],F[d++]=e+1;else for(let e=s[t+6],o=e+f;e<o;e++){let t=c[e*3]*u,o=c[e*3+1]*u,s=c[e*3+2]*u;if(w(n,r,i,l[t],l[t+1],l[t+2],l[o],l[o+1],l[o+2],l[s],l[s+1],l[s+2],R)<=a)return!0}}return!1}intersectsBox(e,t){let n=e.min[0],r=e.min[1],i=e.min[2],a=e.max[0],o=e.max[1],s=e.max[2];if(!(n<=a&&r<=o&&i<=s))return!1;let c=t?g(t,new Float64Array(16)):null;if(t&&!c)throw RangeError(`Box matrix is singular; pass an invertible matrix (no zero scale)`);let l=t?ce(t,n,r,i,a,o,s):[n,r,i,a,o,s],u=V*(Math.abs(l[0])+Math.abs(l[3])+Math.abs(l[1])+Math.abs(l[4])+Math.abs(l[2])+Math.abs(l[5])+1),d=this.nodeBounds,f=this.nodeData,p=this.index,m=this.positions,h=this.stride,_=0;for(F[_++]=0;_;){let e=F[--_],t=e*8;if(d[t]>l[3]+u||d[t+3]<l[0]-u||d[t+1]>l[4]+u||d[t+4]<l[1]-u||d[t+2]>l[5]+u||d[t+5]<l[2]-u)continue;let g=f[t+7];if(g&2147483648)F[_++]=f[t+6],F[_++]=e+1;else for(let e=f[t+6],l=e+g;e<l;e++)if(J(m,h,p,e,c,B),j(B,n,r,i,a,o,s))return!0}return!1}shapecast(e){let{intersectsBounds:t,intersectsTriangle:n,intersectsRange:r,boundsTraverseOrder:a}=e;if(typeof t!=`function`)throw TypeError(`shapecast needs intersectsBounds: pass a function that classifies node boxes`);let o=this.nodeBounds,s=this.nodeData,c=this.index,l=this.triangles,u=this.positions,d=this.stride,f={min:new Float64Array(3),max:new Float64Array(3)},p={a:new Float64Array(3),b:new Float64Array(3),c:new Float64Array(3)},m=e=>{let t=e*8;return f.min[0]=o[t],f.min[1]=o[t+1],f.min[2]=o[t+2],f.max[0]=o[t+3],f.max[1]=o[t+4],f.max[2]=o[t+5],f},h=(e,t)=>{let n=t*d;e[0]=u[n],e[1]=u[n+1],e[2]=u[n+2]},g=(t,i,a)=>{let o=t*8,u=s[o+6],d=s[o+7];if(r&&r.call(e,u,d,i,a,t)===!0)return!0;if(!n)return!1;for(let t=u;t<u+d;t++)if(h(p.a,c[t*3]),h(p.b,c[t*3+1]),h(p.c,c[t*3+2]),n.call(e,p,l[t],i,a)===!0)return!0;return!1},_=(e,t)=>{let n=e*8;return s[n+7]&2147483648?_(e+1,t+1)||_(s[n+6],t+1):g(e,!0,t)},v=(n,r,o)=>{let c=n*8,l=(s[c+7]&i)!==0,u=t.call(e,m(n),!l,r,o,n);if(u===0||u===!1)return!1;if(u===2)return _(n,o);if(!l)return g(n,!1,o);let d=n+1,f=s[c+6];if(!a)return v(d,void 0,o+1)||v(f,void 0,o+1);let p=a.call(e,m(d)),h=a.call(e,m(f));return h<p?v(f,h,o+1)||v(d,p,o+1):v(d,p,o+1)||v(f,h,o+1)};return v(0,void 0,0)}intersectsBVH(e,t,r){if(!(e instanceof n))throw TypeError(`Expected MeshBVH`);let a=t??ne,o=this.nodeBounds,s=this.nodeData,c=e.nodeBounds,l=e.nodeData,u=this.positions,d=this.stride,f=this.index,p=e.positions,m=e.stride,h=e.index,g=new Int32Array(256),_=0,v=!1,y=-1,b=new Float64Array,x=new Float64Array(9),S=new Float64Array(6);for(g[_++]=0,g[_++]=0;_;){let t=g[--_],n=g[--_],C=n*8,w=t*8;le(a,c[w],c[w+1],c[w+2],c[w+3],c[w+4],c[w+5],S);let T=V*(Math.abs(S[0])+Math.abs(S[3])+Math.abs(S[1])+Math.abs(S[4])+Math.abs(S[2])+Math.abs(S[5])+1);if(o[C]>S[3]+T||o[C+3]<S[0]-T||o[C+1]>S[4]+T||o[C+4]<S[1]-T||o[C+2]>S[5]+T||o[C+5]<S[2]-T)continue;let E=s[C+7],D=l[w+7],O=!(E&i),k=!(D&i);if(O&&k){if(y!==t){b.length<D*9&&(b=new Float64Array(D*9));for(let e=0;e<D;e++)J(p,m,h,l[w+6]+e,a,b,e*9);y=t}for(let t=s[C+6],n=t+E;t<n;t++){J(u,d,f,t,null,x);for(let n=0;n<D;n++)if(M(x,0,b,n*9)&&(!r||(v=!0,r(this.triangles[t],e.triangles[l[w+6]+n])===!0)))return!0}continue}if(_+4>g.length){let e=new Int32Array(g.length*2);e.set(g),g=e}let A=o[C+3]-o[C]+o[C+4]-o[C+1]+o[C+5]-o[C+2],j=S[3]-S[0]+S[4]-S[1]+S[5]-S[2];k||!O&&A>=j?(g[_++]=s[C+6],g[_++]=t,g[_++]=n+1,g[_++]=t):(g[_++]=n,g[_++]=l[w+6],g[_++]=n,g[_++]=t+1)}return v}collectFrustum(e,{mode:t=`triangles`}={}){if(e.length%4||!e.length)throw RangeError(`Planes need 4 values each`);if(t!==`triangles`&&t!==`leaves`)throw TypeError(`mode must be triangles or leaves`);let n=e.length/4,r=this.nodeBounds,a=this.nodeData,o=this.index,s=this.positions,c=this.stride,l=this.triangles,u=new Uint32Array(64),d=0,f=0,p=e=>{if(d===u.length){let e=new Uint32Array(u.length*2);e.set(u),u=e}u[d++]=e};for(F[f++]=0;f;){let u=F[--f],d=u*8,m=!1,h=!0;for(let t=0;t<n*4;t+=4){let n=e[t],i=e[t+1],a=e[t+2],o=e[t+3];if(n*(n>=0?r[d+3]:r[d])+i*(i>=0?r[d+4]:r[d+1])+a*(a>=0?r[d+5]:r[d+2])+o<0){m=!0;break}n*(n>=0?r[d]:r[d+3])+i*(i>=0?r[d+1]:r[d+4])+a*(a>=0?r[d+2]:r[d+5])+o<0&&(h=!1)}if(m)continue;let g=a[d+7];if(t===`leaves`)g&2147483648?(F[f++]=a[d+6],F[f++]=u+1):p(u);else if(h){let e=u,t=u;for(;a[e*8+7]&i;)e++;for(;a[t*8+7]&i;)t=a[t*8+6];for(let n=a[e*8+6],r=a[t*8+6]+a[t*8+7];n<r;n++)p(l[n])}else if(g&2147483648)F[f++]=a[d+6],F[f++]=u+1;else for(let t=a[d+6],r=t+g;t<r;t++){let r=o[t*3]*c,i=o[t*3+1]*c,a=o[t*3+2]*c;N(e,n,s[r],s[r+1],s[r+2],s[i],s[i+1],s[i+2],s[a],s[a+1],s[a+2])||p(l[t])}}return u.slice(0,d)}},ne=new Float64Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);function re(e,{near:t=0,far:n=1/0}){let r=Math.hypot(e[0],e[1],e[2]);if(!(r>0)||!Number.isFinite(r))throw RangeError(`Ray direction must be finite and nonzero`);if(!(t>=0)||!(n>=t))throw RangeError(`Expected 0 <= near <= far`);return[t/r,n/r,r]}var ie=(e,t,n)=>Number.isFinite(e)&&Number.isFinite(t)&&Number.isFinite(n);function G(e,t,n,r,i,a,o,s,c,l){let u=(e[t]-n)*a,d=(e[t+3]-n)*a;if(u>d){let e=u;u=d,d=e}if(u>c&&(c=u),d<l&&(l=d),u=(e[t+1]-r)*o,d=(e[t+4]-r)*o,u>d){let e=u;u=d,d=e}if(u>c&&(c=u),d<l&&(l=d),u=(e[t+2]-i)*s,d=(e[t+5]-i)*s,u>d){let e=u;u=d,d=e}return u>c&&(c=u),d<l&&(l=d),ae(c,l)?1/0:c}function K(e,t,n,r,i,a,o,s,c,l,u,d,f){for(let p=0;p<3;p++){let m=p===0?n:p===1?r:i,h=p===0?a:p===1?o:s,g=p===0?c:p===1?l:u,_=e[t+p],v=e[t+p+3];if(h===0){if(oe(m,_,v))return 1/0;continue}let y=Number.isFinite(g)?(_-m)*g:(_-m)/h,b=Number.isFinite(g)?(v-m)*g:(v-m)/h;if(y>b){let e=y;y=b,b=e}y>d&&(d=y),b<f&&(f=b)}return ae(d,f)?1/0:d}var ae=(e,t)=>e>t&&(!Number.isFinite(e)||!Number.isFinite(t)||e>t+V*(Math.abs(t)+Math.abs(e)+1));function oe(e,t,n){let r=V*(Math.abs(e)+Math.abs(t)+Math.abs(n)+1);return e<t-r||e>n+r}function se(e,t,n){let r=Math.hypot(e,t,n);return r>0?[e/r,t/r,n/r]:[0,0,0]}function q(e,t,n,r,i){let a=n<e[t]?e[t]-n:n>e[t+3]?n-e[t+3]:0,o=r<e[t+1]?e[t+1]-r:r>e[t+4]?r-e[t+4]:0,s=i<e[t+2]?e[t+2]-i:i>e[t+5]?i-e[t+5]:0;return a*a+o*o+s*s}function J(e,t,n,r,i,a,o=0){for(let s=0;s<3;s++){let c=n[r*3+s]*t;i?P(i,e[c],e[c+1],e[c+2],a,o+s*3):(a[o+s*3]=e[c],a[o+s*3+1]=e[c+1],a[o+s*3+2]=e[c+2])}}function ce(e,t,n,r,i,a,o){return le(e,t,n,r,i,a,o,new Float64Array(6))}function le(e,t,n,r,i,a,o,s){let c=(t+i)*.5,l=(n+a)*.5,u=(r+o)*.5,d=(i-t)*.5,f=(a-n)*.5,p=(o-r)*.5;for(let t=0;t<3;t++){let n=e[t]*c+e[4+t]*l+e[8+t]*u+e[12+t],r=Math.abs(e[t])*d+Math.abs(e[4+t])*f+Math.abs(e[8+t])*p;s[t]=n-r,s[3+t]=n+r}return s}var Y=class extends Error{constructor(e,t){super(t),this.name=`MargoError`,this.code=e}static[Symbol.hasInstance](e){return e instanceof Error&&e.name===`MargoError`}},ue=e=>{let t=e?.gpu??e;if(!t||typeof t.createBuffer!=`function`)throw new Y(`unsupported`,`GPU BVH needs WebGPU; pass a GPUDevice or an Engine running on WebGPU.`);return t};function de(e){let t=e.nodeCount,n=new ArrayBuffer(t*8*4),r=new Float32Array(n),a=new Uint32Array(n),o=new Uint8Array(t),s=e.nodeBounds,c=e.nodeData;for(let e=0;e<t;e++){let t=e*8,n=c[t+6],l=c[t+7];if(r[t]=s[t],r[t+1]=s[t+1],r[t+2]=s[t+2],r[t+4]=s[t+3],r[t+5]=s[t+4],r[t+6]=s[t+5],l&2147483648){if(o[e]>=64)throw RangeError(`BVH is deeper than 64; rebuild it with a maxDepth of at most 64.`);o[e+1]=o[n]=o[e]+1,a[t+3]=e+1,a[t+7]=(n|i)>>>0}else a[t+3]=n,a[t+7]=l}return n}function fe(e){let{positions:t,stride:n}=e,r=Math.floor((t.length-3)/n)+1,i=new Float32Array(r*3);for(let e=0;e<r;e++)i[e*3]=t[e*n],i[e*3+1]=t[e*n+1],i[e*3+2]=t[e*n+2];return i}var pe=(e,t)=>`
struct ${t}Ray { origin: vec3f, direction: vec3f, inverse: vec3f, shear: vec3f, axes: vec3u, near: f32, far: f32 }
fn ${e}Inverse(d: f32) -> f32 {

  let m = max(abs(d), 1e-18);
  return select(1.0 / m, -1.0 / m, d < 0.0);
}



fn ${e}Edge(p: vec2f, q: vec2f) -> f32 {
  let swap = q.x < p.x || (q.x == p.x && q.y < p.y);
  let s = select(p, q, swap);
  let e = select(q, p, swap);
  let value = s.x * e.y - s.y * e.x;
  return select(value, -value, swap);
}

fn ${e}Triangle(r: ${t}Ray, a3: vec3f, b3: vec3f, c3: vec3f, side: u32, far: f32) -> vec4f {
  let a = a3 - r.origin;
  let b = b3 - r.origin;
  let c = c3 - r.origin;
  let az = a[r.axes.z];
  let bz = b[r.axes.z];
  let cz = c[r.axes.z];
  let ax = a[r.axes.x] - r.shear.x * az;
  let ay = a[r.axes.y] - r.shear.y * az;
  let bx = b[r.axes.x] - r.shear.x * bz;
  let by = b[r.axes.y] - r.shear.y * bz;
  let cx = c[r.axes.x] - r.shear.x * cz;
  let cy = c[r.axes.y] - r.shear.y * cz;
  let u = ${e}Edge(vec2f(cx, cy), vec2f(bx, by));
  let v = ${e}Edge(vec2f(ax, ay), vec2f(cx, cy));
  let w = ${e}Edge(vec2f(bx, by), vec2f(ax, ay));
  let det = u + v + w;
  let positive = u >= 0.0 && v >= 0.0 && w >= 0.0;
  let negative = u <= 0.0 && v <= 0.0 && w <= 0.0;
  if (det == 0.0 || !(positive || negative)) { return vec4f(0.0, 0.0, 0.0, -1.0); }
  if ((side == 1u && det < 0.0) || (side == 2u && det > 0.0)) { return vec4f(0.0, 0.0, 0.0, -1.0); }
  let t = (u * az + v * bz + w * cz) * r.shear.z / det;
  if (t < r.near || t > far) { return vec4f(0.0, 0.0, 0.0, -1.0); }
  return vec4f(u / det, v / det, w / det, t);
}
`,X=64,me=64,he={double:0,front:1,back:2},Z=16,ge=40;function _e({group:e=0,binding:t=0}={}){for(let[n,r]of[[`group`,e],[`binding`,t]])if(!Number.isInteger(r)||r<0)throw RangeError(`Invalid ${n}; pass a non-negative integer.`);let n=n=>`@group(${e}) @binding(${t+n})`;return`
struct SceneNode { lo: vec3f, left: u32, hi: vec3f, right: u32 }
struct SceneInstance { r0: vec4f, r1: vec4f, r2: vec4f, base: vec4u, color: vec4f, emissive: vec4f, pbr: vec4f }
struct SceneParams { top: u32, instances: u32, pad0: u32, pad1: u32 }
struct SceneHit { distance: f32, instance: u32, face: u32, triangle: u32, barycoord: vec3f, front: bool }
struct SceneMaterial { color: vec3f, opacity: f32, emissive: vec3f, metalness: f32, roughness: f32 }
${n(0)} var<storage, read> sceneNodes: array<SceneNode>;
${n(1)} var<storage, read> sceneTris: array<vec4u>;
${n(2)} var<storage, read> scenePositions: array<f32>;
${n(3)} var<storage, read> sceneInstances: array<SceneInstance>;
${n(4)} var<uniform> sceneParams: SceneParams;
const SCENE_MISS = 0xffffffffu;
const SCENE_INTERNAL = 0x80000000u;
const SCENE_NEVER = 3.4e38;
${pe(`scene`,`Scene`)}
fn sceneVertex(i: u32) -> vec3f {
  return vec3f(scenePositions[i * 3u], scenePositions[i * 3u + 1u], scenePositions[i * 3u + 2u]);
}


fn sceneRay(origin: vec3f, d: vec3f, near: f32, far: f32) -> SceneRay {
  let a = abs(d);
  var z = 2u;
  if (a.x >= a.y && a.x >= a.z) { z = 0u; } else if (a.y >= a.z) { z = 1u; }
  var x = (z + 1u) % 3u;
  var y = (x + 1u) % 3u;
  if (d[z] < 0.0) { let swap = x; x = y; y = swap; }
  let shear = vec3f(d[x] / d[z], d[y] / d[z], 1.0 / d[z]);
  return SceneRay(origin, d, vec3f(sceneInverse(d.x), sceneInverse(d.y), sceneInverse(d.z)), shear, vec3u(x, y, z), near, far);
}
fn sceneEnter(node: u32, r: SceneRay, far: f32) -> f32 {
  let n = sceneNodes[node];
  let a = (n.lo - r.origin) * r.inverse;
  let b = (n.hi - r.origin) * r.inverse;
  let near3 = min(a, b);
  let far3 = max(a, b);
  let enter = max(max(near3.x, near3.y), max(near3.z, r.near));
  let leave = min(min(far3.x, far3.y), far3.z) * 1.0000004;
  return select(SCENE_NEVER, enter, enter <= leave && enter <= far);
}

fn sceneBetter(t: f32, instance: u32, face: u32, best: SceneHit) -> bool {
  if (best.instance == SCENE_MISS || t < best.distance) { return true; }
  return t == best.distance && (instance < best.instance || (instance == best.instance && face < best.face));
}
fn sceneBottom(instance: u32, world: SceneRay, best0: SceneHit, any: bool) -> SceneHit {
  var best = best0;
  let m = sceneInstances[instance];
  let o = world.origin;
  let d = world.direction;
  let r = sceneRay(
    vec3f(dot(m.r0.xyz, o) + m.r0.w, dot(m.r1.xyz, o) + m.r1.w, dot(m.r2.xyz, o) + m.r2.w),
    vec3f(dot(m.r0.xyz, d), dot(m.r1.xyz, d), dot(m.r2.xyz, d)),
    world.near,
    best.distance,
  );
  let root = m.base.x;


  let side = m.base.w;
  var stack: array<u32, 64>;
  var entry: array<f32, 64>;
  var top = 0u;
  var node = root;
  if (sceneEnter(root, r, best.distance) >= SCENE_NEVER) { return best; }
  loop {
    let n = sceneNodes[node];
    var next = false;
    if ((n.right & SCENE_INTERNAL) != 0u) {
      let left = root + n.left;
      let right = root + (n.right & ~SCENE_INTERNAL);
      let tl = sceneEnter(left, r, best.distance);
      let tr = sceneEnter(right, r, best.distance);
      if (tl < SCENE_NEVER && tr < SCENE_NEVER) {
        stack[top] = select(right, left, tr < tl);
        entry[top] = max(tl, tr);
        top += 1u;
        node = select(left, right, tr < tl);
        next = true;
      } else if (tl < SCENE_NEVER) {
        node = left;
        next = true;
      } else if (tr < SCENE_NEVER) {
        node = right;
        next = true;
      }
    } else {
      for (var k = 0u; k < n.right; k += 1u) {
        let slot = m.base.y + n.left + k;
        let t = sceneTris[slot];
        let a = sceneVertex(m.base.z + t.x);
        let b = sceneVertex(m.base.z + t.y);
        let c = sceneVertex(m.base.z + t.z);
        let hit = sceneTriangle(r, a, b, c, side, best.distance);
        if (hit.w < 0.0 || !sceneBetter(hit.w, instance, t.w, best)) { continue; }
        best = SceneHit(hit.w, instance, t.w, slot, hit.xyz, dot(cross(b - a, c - a), r.direction) < 0.0);
        if (any) { return best; }
      }
    }
    if (next) { continue; }
    var found = false;
    while (top > 0u && !found) {
      top -= 1u;
      if (entry[top] <= best.distance) {
        node = stack[top];
        found = true;
      }
    }
    if (!found) { break; }
  }
  return best;
}
fn sceneWalk(origin: vec3f, direction: vec3f, near: f32, far: f32, any: bool) -> SceneHit {
  var best = SceneHit(far, SCENE_MISS, SCENE_MISS, SCENE_MISS, vec3f(0.0), false);
  if (sceneParams.instances == 0u || dot(direction, direction) == 0.0) { return best; }
  let r = sceneRay(origin, normalize(direction), near, far);
  var stack: array<u32, 64>;
  var entry: array<f32, 64>;
  var top = 0u;
  var node = 0u;
  if (sceneEnter(0u, r, far) >= SCENE_NEVER) { return best; }
  loop {
    let n = sceneNodes[node];
    var next = false;
    if ((n.right & SCENE_INTERNAL) != 0u) {
      let left = n.left;
      let right = n.right & ~SCENE_INTERNAL;
      let tl = sceneEnter(left, r, best.distance);
      let tr = sceneEnter(right, r, best.distance);
      if (tl < SCENE_NEVER && tr < SCENE_NEVER) {
        stack[top] = select(right, left, tr < tl);
        entry[top] = max(tl, tr);
        top += 1u;
        node = select(left, right, tr < tl);
        next = true;
      } else if (tl < SCENE_NEVER) {
        node = left;
        next = true;
      } else if (tr < SCENE_NEVER) {
        node = right;
        next = true;
      }
    } else {
      best = sceneBottom(n.left, r, best, any);
      if (any && best.instance != SCENE_MISS) { return best; }
    }
    if (next) { continue; }
    var found = false;
    while (top > 0u && !found) {
      top -= 1u;
      if (entry[top] <= best.distance) {
        node = stack[top];
        found = true;
      }
    }
    if (!found) { break; }
  }
  return best;
}
fn sceneClosest(origin: vec3f, direction: vec3f, near: f32, far: f32) -> SceneHit {
  return sceneWalk(origin, direction, near, far, false);
}
fn sceneAny(origin: vec3f, direction: vec3f, near: f32, far: f32) -> SceneHit {
  return sceneWalk(origin, direction, near, far, true);
}
fn sceneNormal(h: SceneHit) -> vec3f {
  let m = sceneInstances[h.instance];
  let t = sceneTris[h.triangle];
  let a = sceneVertex(m.base.z + t.x);
  let n = cross(sceneVertex(m.base.z + t.y) - a, sceneVertex(m.base.z + t.z) - a);

  let w = n.x * m.r0.xyz + n.y * m.r1.xyz + n.z * m.r2.xyz;
  return normalize(w);
}
fn sceneMaterial(instance: u32) -> SceneMaterial {
  let m = sceneInstances[instance];
  return SceneMaterial(m.color.rgb, m.color.a, m.emissive.rgb, m.pbr.x, m.pbr.y);
}
`}var ve=`${_e()}
struct TraceRay { origin: vec3f, near: f32, direction: vec3f, far: f32 }
struct Trace { count: u32, any: u32, width: u32, pad: u32 }
@group(1) @binding(0) var<storage, read> rays: array<TraceRay>;
@group(1) @binding(1) var<storage, read_write> hits: array<vec4u>;
@group(1) @binding(2) var<uniform> trace: Trace;
@compute @workgroup_size(${X})
fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.y * trace.width + id.x;
  if (i >= trace.count) { return; }
  let ray = rays[i];
  let hit = sceneWalk(ray.origin, ray.direction, ray.near, ray.far, trace.any != 0u);
  if (hit.instance == SCENE_MISS) {
    hits[i * 2u] = vec4u(bitcast<u32>(-1.0), SCENE_MISS, SCENE_MISS, 0u);
    hits[i * 2u + 1u] = vec4u(0u);
    return;
  }
  let front = select(0u, SCENE_INTERNAL, hit.front);
  hits[i * 2u] = vec4u(bitcast<u32>(hit.distance), hit.face | front, hit.instance, bitcast<u32>(hit.barycoord.y));
  hits[i * 2u + 1u] = vec4u(bitcast<u32>(hit.barycoord.z), hit.triangle, 0u, 0u);
}
`,Q=new WeakMap;function ye(e){let t=Q.get(e);return t||(t=e.createComputePipelineAsync({label:`bvh scene trace`,layout:`auto`,compute:{module:e.createShaderModule({label:`bvh scene trace`,code:ve}),entryPoint:`main`}}),Q.set(e,t),t.catch(()=>Q.delete(e))),t}var be=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],xe=(e,t)=>{if(!(e>=0&&e<=1))throw RangeError(`Invalid ${t}; pass a number from 0 to 1.`);return e};function Se(e={}){let t=(e,t,n)=>{if(e.length!==3||!e.every(e=>e>=0&&e<=n))throw RangeError(`Invalid ${t}; pass three numbers from 0 to ${n===1/0?`any size`:n}.`);return[e[0],e[1],e[2]]};return{color:t(e.color??[1,1,1],`color`,1),opacity:xe(e.opacity??1,`opacity`),emissive:t(e.emissive??[0,0,0],`emissive`,1/0),metalness:xe(e.metalness??0,`metalness`),roughness:xe(e.roughness??.5,`roughness`)}}function Ce(e=be,t){if(e.length!==16)throw RangeError(`Invalid matrix of instance ${t}; pass 16 numbers.`);let n=Float64Array.from(e);if(!n.every(Number.isFinite))throw RangeError(`Matrix of instance ${t} is not finite; pass 16 finite numbers.`);if(n[3]!==0||n[7]!==0||n[11]!==0||n[15]!==1)throw RangeError(`Matrix of instance ${t} is not affine; the last row must be 0, 0, 0, 1.`);if(!g(n))throw RangeError(`Matrix of instance ${t} is not invertible; give every axis a non-zero scale.`);return n}function we(e,t,n){let{lo:r,hi:i}=e.bottom,a=e.matrix;t.fill(1/0,n,n+3),t.fill(-1/0,n+3,n+6);for(let e=0;e<8;e++){let o=e&1?i[0]:r[0],s=e&2?i[1]:r[1],c=e&4?i[2]:r[2];for(let e=0;e<3;e++){let r=a[e]*o+a[4+e]*s+a[8+e]*c+a[12+e];r<t[n+e]&&(t[n+e]=r),r>t[n+3+e]&&(t[n+3+e]=r)}}}var Te=(e,t)=>{let n=Math.max(0,e[t+3]-e[t]),r=Math.max(0,e[t+4]-e[t+1]),i=Math.max(0,e[t+5]-e[t+2]);return n*r+r*i+i*n};function Ee(t,n){let r=Math.max(1,2*n-1),i=new Float32Array(r*8),o=new Uint32Array(i.buffer),s=new Uint32Array(n),c=new Float64Array(n*3);for(let e=0;e<n;e++){s[e]=e;for(let n=0;n<3;n++)c[e*3+n]=(t[e*6+n]+t[e*6+3+n])*.5}let l=0,u=new Float64Array(96),d=new Uint32Array(Z),f=new Float64Array(Z),p=new Uint32Array(Z),m=(n,r,h)=>{let g=l++,_=g*8,v=[1/0,1/0,1/0],y=[-1/0,-1/0,-1/0],b=[1/0,1/0,1/0],x=[-1/0,-1/0,-1/0];for(let e=n;e<r;e++){let n=s[e];for(let e=0;e<3;e++)v[e]=Math.min(v[e],t[n*6+e]),y[e]=Math.max(y[e],t[n*6+3+e]),b[e]=Math.min(b[e],c[n*3+e]),x[e]=Math.max(x[e],c[n*3+e])}for(let t=0;t<3;t++)i[_+t]=a(v[t]),i[_+4+t]=e(y[t]);if(r-n===1)return o[_+3]=s[n],o[_+7]=1,g;let S=-1,C=0;if(h<ge){let e=1/0;for(let i=0;i<3;i++){let a=x[i]-b[i];if(!(a>0))continue;u.fill(1/0);for(let e=0;e<Z;e++)u.fill(-1/0,e*6+3,e*6+6);d.fill(0);for(let e=n;e<r;e++){let n=s[e],r=Math.min(15,Math.floor((c[n*3+i]-b[i])/a*Z));d[r]++;for(let e=0;e<3;e++)u[r*6+e]=Math.min(u[r*6+e],t[n*6+e]),u[r*6+3+e]=Math.max(u[r*6+3+e],t[n*6+3+e])}let o=[1/0,1/0,1/0,-1/0,-1/0,-1/0],l=0;for(let e=15;e>0;e--){for(let t=0;t<3;t++)o[t]=Math.min(o[t],u[e*6+t]),o[3+t]=Math.max(o[3+t],u[e*6+3+t]);l+=d[e],f[e]=l?Te(o,0):0,p[e]=l}o.fill(1/0,0,3),o.fill(-1/0,3,6),l=0;for(let t=0;t<15;t++){for(let e=0;e<3;e++)o[e]=Math.min(o[e],u[t*6+e]),o[3+e]=Math.max(o[3+e],u[t*6+3+e]);l+=d[t];let n=p[t+1];if(!l||!n)continue;let r=Te(o,0)*l+f[t+1]*n;r<e&&(e=r,C=i,S=t+1)}}}let w;if(S>=0){let e=x[C]-b[C],t=n,i=r-1,a=t=>Math.min(15,Math.floor((c[t*3+C]-b[C])/e*Z));for(;t<=i;)if(a(s[t])<S)t++;else{let e=s[t];s[t]=s[i],s[i--]=e}w=t}else{let e=0;for(let t=1;t<3;t++)x[t]-b[t]>x[e]-b[e]&&(e=t);let t=Array.from(s.subarray(n,r)).sort((t,n)=>c[t*3+e]-c[n*3+e]||t-n);s.set(t,n),w=n+r>>1}m(n,w,h+1);let T=m(w,r,h+1);return o[_+3]=g+1,o[_+7]=(T|2147483648)>>>0,g};return n&&m(0,n,0),{nodes:i,words:o,count:r}}var De=(e,t)=>Te([e[t],e[t+1],e[t+2],e[t+4],e[t+5],e[t+6]],0);function $(e){let t=De(e.nodes,0)||1,n=0;for(let t=0;t<e.count;t++)e.words[t*8+7]&2147483648&&(n+=De(e.nodes,t*8));return n/t}var Oe=class t{#e;#t;#n;#r;#i;#a=!1;#o=!1;#s;#c;#l=new Map;#u=!1;static async create(e,n,r){let i=ue(e);return new t(i,[...n],r??{},await ye(i))}static forShader(e,n,r){return new t(ue(e),[...n],r??{},null)}constructor(e,t,{rebuildThreshold:n=1.5},r){if(!(n>=1))throw RangeError(`Invalid rebuildThreshold; pass a number of at least 1.`);this.device=e,this.rebuildThreshold=n,this.count=t.length,this.#s=r;let i=new Map,a=0,o=0,s=0;this.#e=t.map((e,t)=>{let n=e?.bvh;if(!n||!(n.nodeBounds instanceof Float32Array))throw TypeError(`Instance ${t} has no bvh; pass a MeshBVH.`);if(e.side!==void 0&&!Object.hasOwn(he,e.side))throw TypeError(`Invalid side of instance ${t}; use front, back or double.`);let r=i.get(n);if(!r){let e=n.nodeBounds;r={bvh:n,lo:[e[0],e[1],e[2]],hi:[e[3],e[4],e[5]],node:0,tri:o,vertex:s},a+=n.nodeCount,o+=n.triangleCount,s+=Math.floor((n.positions.length-3)/n.stride)+1,i.set(n,r)}return{bottom:r,matrix:Ce(e.matrix,t),material:Se(e.material),side:he[e.side??`double`]}}),this.#i=new Float64Array(this.count*6),this.#e.forEach((e,t)=>we(e,this.#i,t*6)),this.#t=Ee(this.#i,this.count),this.#r=$(this.#t),this.#n=this.#t.count;let c=this.#n;for(let e of i.values())e.node=c,c+=e.bvh.nodeCount;let l=Math.min(e.limits.maxStorageBufferBindingSize,e.limits.maxBufferSize);for(let[e,t]of[[`nodes`,(this.#n+a)*8*4],[`positions`,s*12],[`triangles`,o*16],[`instances`,this.count*28*4]])if(t>l)throw RangeError(`Scene ${e} take ${t} bytes, over this device's ${l}; request a higher maxStorageBufferBindingSize or split the scene.`);let u=(t,n,r,i=16)=>e.createBuffer({label:t,size:Math.max(i,n),usage:r|GPUBufferUsage.COPY_DST}),d=GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC;this.nodes=u(`bvh scene nodes`,(this.#n+a)*8*4,d,32),this.triangles=u(`bvh scene triangles`,o*16,d),this.positions=u(`bvh scene positions`,s*12,d),this.instances=u(`bvh scene instances`,this.count*28*4,d,112),this.params=u(`bvh scene params`,16,GPUBufferUsage.UNIFORM);for(let t of i.values()){let{bvh:n}=t;n.nodeCount>0&&e.queue.writeBuffer(this.nodes,t.node*8*4,de(n));let r=new Uint32Array(n.triangleCount*4);for(let e=0;e<n.triangleCount;e++)r[e*4]=n.index[e*3],r[e*4+1]=n.index[e*3+1],r[e*4+2]=n.index[e*3+2],r[e*4+3]=n.triangles[e];r.length&&e.queue.writeBuffer(this.triangles,t.tri*16,r);let i=fe(n);i.length&&e.queue.writeBuffer(this.positions,t.vertex*12,i)}e.queue.writeBuffer(this.params,0,new Uint32Array([this.#n,this.count,0,0])),this.#f(),this.#p(),this.#c=r&&e.createBindGroup({label:`bvh scene`,layout:r.getBindGroupLayout(0),entries:this.bindings()})}get disposed(){return this.#u}bindings(e=0){return[this.nodes,this.triangles,this.positions,this.instances,this.params].map((t,n)=>({binding:e+n,resource:{buffer:t}}))}setMatrix(e,t){this.#g(),this.#h(e),this.#e[e].matrix=Ce(t,e),this.#a=!0}setMaterial(e,t){this.#g(),this.#h(e),this.#e[e].material=Se(t),this.#o=!0}instanceBounds(e){return this.#h(e),this.#i.slice(e*6,e*6+6)}update(){if(this.#g(),!this.#a&&!this.#o)return`unchanged`;let e=`refit`;return this.#a&&(this.#e.forEach((e,t)=>we(e,this.#i,t*6)),this.#d(),$(this.#t)>this.#r*this.rebuildThreshold&&(this.#t=Ee(this.#i,this.count),this.#r=$(this.#t),e=`rebuilt`),this.#f()),this.#p(),this.#a=this.#o=!1,e}get cost(){return $(this.#t)}encodeTrace(e,t,n,r,{mode:i=`closest`}={}){if(this.#g(),!Number.isInteger(r)||r<0)throw RangeError(`Invalid ray count; pass a non-negative integer.`);if(i!==`closest`&&i!==`any`)throw TypeError(`Invalid trace mode; use closest or any.`);let a=this.#s;if(!a)throw new Y(`state`,`This scene is for your own shader; make one with GPUSceneBVH.create to trace rays.`);if(!r)return;if(t.size<r*8*4||n.size<r*8*4)throw RangeError(`Ray or hit buffer is too small for ${r} rays; size them with GPU_SCENE_RAY_FLOATS and GPU_SCENE_HIT_WORDS.`);let o=Math.ceil(r/X),s=this.device.limits.maxComputeWorkgroupsPerDimension,c=Math.min(o,s),l=Math.ceil(o/c);if(l>s)throw RangeError(`${r} rays are more than one dispatch holds; trace them in parts.`);let u=e.beginComputePass({label:`bvh scene trace`});u.setPipeline(a),u.setBindGroup(0,this.#c),u.setBindGroup(1,this.device.createBindGroup({label:`bvh scene rays`,layout:a.getBindGroupLayout(1),entries:[{binding:0,resource:{buffer:t}},{binding:1,resource:{buffer:n}},{binding:2,resource:{buffer:this.#m(r,+(i===`any`),c*X)}}]})),u.dispatchWorkgroups(c,l),u.end()}async raycast(e,t={}){this.#g();let{signal:n,near:r=0,far:i=1/0}=t;if(n?.throwIfAborted(),!(r>=0)||!(i>=r))throw RangeError(`Invalid near or far; pass 0 <= near <= far.`);let a;if(e instanceof Float32Array?a=e:(a=new Float32Array(e.length*8),e.forEach(({origin:e,direction:t},n)=>{let o=n*8;for(let n=0;n<3;n++)a[o+n]=e[n],a[o+4+n]=t[n];a[o+3]=r,a[o+7]=Math.min(i,3e38)})),a.length%8)throw RangeError(`Incomplete ray buffer; pass whole rays of GPU_SCENE_RAY_FLOATS floats.`);for(let e=0;e<a.length;e++)if(!Number.isFinite(a[e]))throw RangeError(`Ray ${Math.floor(e/8)} is not finite; far must be at most 3e38.`);let o=a.length/8,s=this.device,c={count:o,distance:new Float32Array(o),instance:new Int32Array(o),faceIndex:new Int32Array(o),barycoord:new Float32Array(o*3),frontFace:new Uint8Array(o)};if(!o)return c;if(a.byteLength>s.limits.maxStorageBufferBindingSize)throw RangeError(`${o} rays are over this device's storage binding size; trace them in parts.`);let l=o*8*4,u=s.createBuffer({label:`bvh scene rays`,size:a.byteLength,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST}),d=s.createBuffer({label:`bvh scene hits`,size:l,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC}),f=s.createBuffer({label:`bvh scene read`,size:l,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});try{s.queue.writeBuffer(u,0,a);let e=s.createCommandEncoder({label:`bvh scene raycast`});this.encodeTrace(e,u,d,o,t),e.copyBufferToBuffer(d,0,f,0,l),s.queue.submit([e.finish()]),await f.mapAsync(GPUMapMode.READ),n?.throwIfAborted();let r=f.getMappedRange(),i=new Float32Array(r),p=new Uint32Array(r);for(let e=0;e<o;e++){let t=e*8;if(p[t+2]===4294967295){c.distance[e]=1/0,c.instance[e]=c.faceIndex[e]=-1;continue}let n=i[t+3],r=i[t+4];c.distance[e]=i[t],c.faceIndex[e]=p[t+1]&2147483647,c.frontFace[e]=p[t+1]>>>31,c.instance[e]=p[t+2],c.barycoord[e*3]=1-n-r,c.barycoord[e*3+1]=n,c.barycoord[e*3+2]=r}return c}finally{u.destroy(),d.destroy(),f.destroy()}}dispose(){if(!this.#u){this.#u=!0;for(let e of[this.nodes,this.triangles,this.positions,this.instances,this.params])e.destroy();for(let e of this.#l.values())e.destroy();this.#l.clear()}}[Symbol.dispose](){this.dispose()}#d(){let{nodes:t,words:n,count:r}=this.#t,i=this.#i;for(let o=r-1;o>=0;o--){let r=o*8;if(n[r+7]&2147483648){let e=n[r+3]*8,i=(n[r+7]&2147483647)*8;for(let n=0;n<3;n++)t[r+n]=Math.min(t[e+n],t[i+n]),t[r+4+n]=Math.max(t[e+4+n],t[i+4+n])}else if(this.count){let o=n[r+3]*6;for(let n=0;n<3;n++)t[r+n]=a(i[o+n]),t[r+4+n]=e(i[o+3+n])}}}#f(){this.count&&this.device.queue.writeBuffer(this.nodes,0,this.#t.nodes)}#p(){if(!this.count)return;let e=new Float32Array(this.count*28),t=new Uint32Array(e.buffer),n=new Float64Array(16);this.#e.forEach(({bottom:r,matrix:i,material:a,side:o},s)=>{let c=s*28;g(i,n);for(let t=0;t<3;t++)for(let r=0;r<4;r++)e[c+t*4+r]=n[r*4+t];t[c+12]=r.node,t[c+13]=r.tri,t[c+14]=r.vertex,t[c+15]=o,e.set(a.color,c+16),e[c+19]=a.opacity,e.set(a.emissive,c+20),e[c+24]=a.metalness,e[c+25]=a.roughness}),this.device.queue.writeBuffer(this.instances,0,e)}#m(e,t,n){let r=`${e},${t},${n}`,i=this.#l.get(r);return i||(this.#l.size>=me&&this.#l.delete(this.#l.keys().next().value),i=this.device.createBuffer({label:`bvh scene trace`,size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),this.device.queue.writeBuffer(i,0,new Uint32Array([e,t,n,0])),this.#l.set(r,i)),i}#h(e){if(!Number.isInteger(e)||e<0||e>=this.count)throw RangeError(`Invalid instance ${e}; pass 0 to ${this.count-1}.`)}#g(){if(this.#u)throw new Y(`disposed`,`GPUSceneBVH is disposed; create a new one to trace rays.`)}},ke=`
struct RTLight {light:vec4f,radiance:vec4f,ambient:vec4f,b:vec4f}
@group(1) @binding(5) var<uniform> rt:RTLight;
fn rtShade(h:SceneHit,x:vec3f,r:vec3f)->vec3f {
let mat=sceneMaterial(h.instance);let v=-r;let gn=sceneNormal(h);let n=select(gn,-gn,dot(gn,v)<0.0);let l=rt.light.xyz;
var sun=rt.light.w;
if(rt.b.y>0.5&&sun>0.0&&dot(n,l)>0.0&&sceneAny(x+n*rt.b.x,l,0.0,SCENE_NEVER).instance!=SCENE_MISS){sun=0.0;}
let hv=(v+l)/max(length(v+l),0.0001);
let nl=clamp(dot(n,l),0.0,1.0);let nv=clamp(dot(n,v),0.0001,1.0);let nh=clamp(dot(n,hv),0.0,1.0);let vh=clamp(dot(v,hv),0.0,1.0);
let a=mat.roughness*mat.roughness;let a2=a*a;let kc=cross(n,hv);let qd=max(dot(kc,kc),step(nh,0.0))+a2*nh*nh;let dd=a2/(3.14159265*qd*qd);
let gg=2.0*nl*nv/max(nl*sqrt(a2+(1.0-a2)*nv*nv)+nv*sqrt(a2+(1.0-a2)*nl*nl),1e-30);
let f0=mix(vec3f(0.04),mat.color,mat.metalness);let w=1.0-pow(1.0-vh,5.0);let fr=1.0-(1.0-f0)*w;
let direct=(0.96*w*(1.0-mat.metalness)*mat.color/3.14159265+dd*gg*fr/max(4.0*nl*nv,0.0001))*nl;
return max(vec3f(0),direct*rt.radiance.xyz*sun+mat.color*(1.0-mat.metalness)*rt.radiance.w*rt.ambient.rgb+mat.emissive);
}
`,Ae=()=>_e({group:1,binding:0})+ke,je=e=>!!e&&typeof e.bindings==`function`&&typeof e.device==`object`&&typeof e.disposed==`boolean`;function Me(e,t){let{scene:n,shadows:r,bias:i}=e??{};if(!je(n))throw TypeError(`Invalid ${t} scene; pass a GPUSceneBVH from @margoengine/bvh/gpu-scene`);if(r!==void 0&&typeof r!=`boolean`)throw TypeError(`Invalid ${t} shadows; pass a boolean`);if(i!==void 0&&!(i>=0&&Number.isFinite(Math.fround(i))))throw RangeError(`Invalid ${t} bias; pass a finite number of at least 0`)}var Ne=4,Pe=class{#e;#t;#n;#r;#i=new Float32Array(16);#a=new WeakMap;constructor(e,t,n=0){this.owner=e,this.plain=t,this.storage=n}active(e,t){if(e.scene.disposed||e.scene.device!==t)return!1;let n=t.limits.maxStorageBuffersInFragmentStage,r=Ne+this.storage;return n===void 0||n>=r||(this.#t!==t&&(this.#t=t,console.warn(m(`unsupported`,`${this.owner} needs ${r} storage buffers in a fragment shader and this device allows ${n}; it runs as ${this.plain}`,`compatibility-layer`))),!1)}prepare(e,t,n){let r=e.device;this.#n!==r&&(this.release(),this.#n=r,this.#e=r.createBuffer({size:64,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}));let i=this.#i,{direction:a,radiance:o,ambient:s}=t.lighting,c=Math.hypot(a[0],a[1],a[2])||1;for(let e=0;e<3;e++)i[e]=a[e]/c;i[3]=a[3],i.set(o,4),i.fill(1,8,11),s&&i.set(s,8),i[12]=n.bias??.01,i[13]=+(n.shadows??!0),this.#r=l(r,this.#e,i,e.view??e)}group(e,t,n){let r=this.#e,i=this.#a.get(t);if(!i||i.scene!==n||i.uniform!==r){let a=t.getBindGroupLayout(1);i={scene:n,uniform:r,groups:p(r,t=>e.createBindGroup({label:`traced scene`,layout:a,entries:[...n.bindings(0),{binding:5,resource:t}]}))},this.#a.set(t,i)}return i.groups.get(this.#r)}release(){this.#n&&s(this.#n,this.#e),this.#n=this.#e=this.#t=void 0}};function Fe(e,t,n){for(let[r,i]of t){let t=e.replace(r,i);if(t===e)throw f(`failed`,`${n} changed shape; update its traced patch`);e=t}return Ae()+e}var Ie=(e,t)=>Fe(e,[[`if(toward<0.5){`,`var cover=0.0;${t?`let c0=c;`:``}\nif(toward<0.5){`],[`let hc=u.matrix*vec4f(hp,1.0);`,`cover=f;let hc=u.matrix*vec4f(hp,1.0);`],[/(\(m\.rgb\*reflected-e\.rgb\)\);\n\}\}\})\}/,`$1
let rf=1.0-smoothstep(u.a.z*0.5,u.a.z,rough);
if(cover<rf){let ro=p+n*rt.b.x;let rh=sceneClosest(ro,r,0.0,u.b.x);if(rh.instance!=SCENE_MISS){let rad=rtShade(rh,ro+r*rh.distance,r);let g=(rf-cover)*(1.0-smoothstep(0.8*u.b.x,u.b.x,rh.distance));${t?`let rk=select(vec3f(1),c0/e.rgb,e.rgb>vec3f(1e-6));c=max(vec3f(0),c+g*min(1.0,min(rk.x,min(rk.y,rk.z)))*(m.rgb*rad-e.rgb));`:`c=max(vec3f(0),c+g*(m.rgb*rad-e.rgb));`}}}
}`]],`RTReflections: SSR's composite`),Le=e=>Fe(e,[[`if(dot(r,n)>0.0&&toward<0.5){`,`var cover=0.0;
if(dot(r,n)>0.0&&toward<0.5){`],[`out=vec4f(f*textureLoad(scene,hq,0).rgb,f);`,`out=vec4f(f*textureLoad(scene,hq,0).rgb,f);cover=f;`],[`
}}}}
return out;`,`
}}}
if(dot(r,n)>0.0&&cover<1.0){let ro=p+n*rt.b.x;let rh=sceneClosest(ro,r,0.0,u.b.x);if(rh.instance!=SCENE_MISS){let g=(1.0-cover)*(1.0-smoothstep(0.8*u.b.x,u.b.x,rh.distance));out+=vec4f(g*rtShade(rh,ro+r*rh.distance,r),g);}}
}
return out;`]],`RTReflections: SSR's rough trace`),Re=class e extends h{#e=new Pe(`RTReflections`,`SSR`);constructor(e){super(e),Me(this.options,`RTReflections`),this.traced=this.#t}static attach(t,n){c(t,u(`1.0.0`,import.meta.url));let r=new e(n);return r.stack=d.attach(t,[r]),r}#t={active:e=>(Me(this.options,`RTReflections`),this.#e.active(this.options,e)),prepare:e=>this.#e.prepare(e,this.engine,this.options),mirror:Ie,rough:Le,group:(e,t)=>this.#e.group(e,t,this.options.scene)};onDeviceRestored(e){this.#e.release(),super.onDeviceRestored(e)}dispose(){super.dispose(),this.#e.release()}};function ze(){let e=new Map,t=new o,r=new n,i=([e,t,n])=>({x:e,y:t,z:n});return _().map(({geometry:n,appearance:a,position:o,rotation:s,scale:c})=>{let l=e.get(n);return l||(l=te.fromGeometry(n),e.set(n,l)),r.setFromEuler({...i(s),order:`XYZ`}),{bvh:l,matrix:t.compose(i(o),r,i(c)).elements.slice(),material:a.optical}})}function Be(e,t,n,r){let i=Oe.forShader(e.gpu,n),a=new Re({...r,scene:i,shadows:!1,bias:.013});return t.use(new d([a])),t.use({name:`mirror-tree`,setup(){},onDeviceRestored(e){i.dispose(),i=Oe.forShader(e.gpu,n),a.options.scene=i},dispose(){i.dispose()}}),i.count}export{Be as attachStockMirror,ze as prepareStockMirror};