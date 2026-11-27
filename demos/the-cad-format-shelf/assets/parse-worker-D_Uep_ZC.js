function e(e,t,n=/* @__PURE__ */ new Float64Array(16)){for(let r=0;r<4;r++)for(let i=0;i<4;i++)n[r*4+i]=e[i]*t[r*4]+e[4+i]*t[r*4+1]+e[8+i]*t[r*4+2]+e[12+i]*t[r*4+3];return n}var t=class extends Error{constructor(e,t){super(t),this.name=`MargoError`,this.code=e}static[Symbol.hasInstance](e){return e instanceof Error&&e.name===`MargoError`}},n=class{constructor(e){this.id=e}},r=class{constructor(e){this.name=e}},i=class{constructor(e,t){this.type=e,this.value=t}},a=Symbol(`derived`),o=(e,t)=>e.charCodeAt(t),s=35,c=39,l=34,u=40,d=41,f=59,p=61,m=47,h=42,g=36,_=46,v=44,y=e=>e===32||e===9||e===10||e===13,b=e=>e>=48&&e<=57,x=e=>e>=65&&e<=90||e>=97&&e<=122||b(e)||e===95;function S(e,t,n){let r=t.slice(0,n).split(`
`).length;return/* @__PURE__ */ TypeError(`Invalid STEP file: ${e} at line ${r}; export it again from the CAD tool`)}function C(e,t){for(;;){for(;t<e.length&&y(o(e,t));)t++;if(o(e,t)===m&&o(e,t+1)===h){let n=e.indexOf(`*/`,t+2);if(n<0)throw S(`unterminated comment`,e,t);t=n+2}else return t}}function w(e){if(!e.includes(`\\`)&&!e.includes(`''`))return e;let t=``;for(let n=0;n<e.length;n++){let r=e[n];if(r===`'`&&e[n+1]===`'`)t+=`'`,n++;else if(r!==`\\`)t+=r;else if(e[n+1]===`\\`)t+=`\\`,n++;else if(e[n+1]===`S`&&e[n+2]===`\\`)t+=String.fromCharCode(e.charCodeAt(n+3)+128),n+=3;else if(e[n+1]===`P`&&e[n+3]===`\\`)n+=3;else if(e[n+1]===`X`&&e[n+2]===`\\`)t+=String.fromCharCode(Number.parseInt(e.slice(n+3,n+5),16)),n+=4;else if(e[n+1]===`X`&&(e[n+2]===`2`||e[n+2]===`4`)&&e[n+3]===`\\`){let r=e[n+2]===`2`?4:8,i=e.indexOf(`\\X0\\`,n+4),a=i<0?``:e.slice(n+4,i);for(let e=0;e+r<=a.length;e+=r)t+=String.fromCodePoint(Number.parseInt(a.slice(e,e+r),16));n=i<0?e.length:i+3}else t+=r}return t}var T=256;function ee(e,t,d=0){t=C(e,t);let f=o(e,t);if(f===s){let r=t+1;for(;b(o(e,r));)r++;if(r===t+1)throw S(`reference without a number`,e,t);return[new n(Number(e.slice(t+1,r))),r]}if(f===c){let n=t+1;for(;;){if(n=e.indexOf(`'`,n),n<0)throw S(`unterminated string`,e,t);if(o(e,n+1)===c)n+=2;else break}return[w(e.slice(t+1,n)),n+1]}if(f===l){let n=e.indexOf(`"`,t+1);if(n<0)throw S(`unterminated binary`,e,t);return[e.slice(t+1,n),n+1]}if(f===_){let n=e.indexOf(`.`,t+1);if(n<0)throw S(`unterminated enumeration`,e,t);return[new r(e.slice(t+1,n).trim()),n+1]}if(f===g)return[null,t+1];if(f===h)return[a,t+1];if(f===u)return E(e,t,d+1);if(b(f)||f===45||f===43){let n=t+1;for(;n<e.length;){let t=o(e,n);if(b(t)||t===_||t===69||t===101||t===45||t===43)n++;else break}let r=Number(e.slice(t,n));if(!Number.isFinite(r))throw S(`bad number '${e.slice(t,n)}'`,e,t);return[r,n]}if(x(f)){let n=t;for(;x(o(e,n));)n++;let r=e.slice(t,n).toUpperCase(),a=C(e,n);if(o(e,a)!==u)throw S(`typed parameter ${r} without a value`,e,t);let[s,c]=E(e,a,d+1);return[new i(r,s.length===1?s[0]:s),c]}throw S(`unexpected '${e[t]??`end of file`}'`,e,t)}function E(e,t,n=0){if(n>T)throw S(`lists nested more than ${T} deep`,e,t);let r=[];if(t=C(e,t+1),o(e,t)===d)return[r,t+1];for(;;){let[i,a]=ee(e,t,n);r.push(i),t=C(e,a);let s=o(e,t);if(s===v)t++;else if(s===d)return[r,t+1];else throw S(`expected ',' or ')' but found '${e[t]??`end of file`}'`,e,t)}}function te(e,t,n){let r=[];for(;;){if(t=C(e,t),o(e,t)===n)return[r,t+1];let i=t;for(;x(o(e,i));)i++;if(i===t)throw S(`expected an entity name but found '${e[t]??`end of file`}'`,e,t);let a=e.slice(t,i).toUpperCase(),s=C(e,i);if(o(e,s)!==u)throw S(`${a} without parameters`,e,s);let[c,l]=E(e,s);if(r.push([a,c]),t=l,n===f){if(t=C(e,t),o(e,t)!==f)throw S(`expected ';' after ${a}`,e,t);return[r,t+1]}}}function ne(e,t,n){let r=t,i=0;for(;t<e.length;t++){let a=o(e,t);if(a===c){for(t=e.indexOf(`'`,t+1);t>=0&&o(e,t+1)===c;)t=e.indexOf(`'`,t+2);if(t<0)break}else if(a===l){if(t=e.indexOf(`"`,t+1),t<0)break}else if(a===m&&o(e,t+1)===h){if(t=e.indexOf(`*/`,t+2)+1,t<=0)break}else if(a===u)i++;else if(a===d){if(--i<0)throw S(`#${n}: ')' with no '(' open in '${e.slice(r,t+1)}'`,e,t)}else if(a===p)throw S(`#${n}: '=' inside the instance (a ';' missing before it?)`,e,t);else if(a===f&&i===0)return t}throw S(`unterminated entity instance`,e,e.length)}var D=e=>typeof e==`string`?e:``,re=e=>Array.isArray(e)?e.filter(e=>typeof e==`string`):[],ie=class{constructor(e){this.text=e,this.slots=/* @__PURE__ */ new Map,this.starts=[],this.ends=[],this.types=[],this.byType=/* @__PURE__ */ new Map,this.cache=/* @__PURE__ */ new Map,this.missing=/* @__PURE__ */ new Set;let t=C(e,0);if(!e.startsWith(`ISO-10303-21`,t))throw S(`missing 'ISO-10303-21;' at the start`,e,t);let n=e.indexOf(`HEADER;`,t);if(n<0)throw S(`no HEADER section`,e,t);let[r,i]=this.headerSection(n+7);this.header=r,t=i;let a=0;for(;;){let n=e.indexOf(`DATA`,t);if(n<0)break;let r=C(e,n+4);o(e,r)===u&&(r=E(e,r)[1]),r=C(e,r),o(e,r)===f?(a++,t=this.dataSection(r+1)):t=n+4}if(!a)throw S(`no DATA section`,e,e.length)}headerSection(e){let t=/* @__PURE__ */ new Map;for(;;){if(e=C(this.text,e),this.text.startsWith(`ENDSEC`,e)){let t=C(this.text,e+6);if(o(this.text,t)!==f)throw S(`expected ';' after ENDSEC`,this.text,t);break}let[[n],r]=te(this.text,e,f);t.set(n[0],n[1]),e=r}let n=t.get(`FILE_DESCRIPTION`)??[],r=t.get(`FILE_NAME`)??[],i=t.get(`FILE_SCHEMA`)??[];return[{description:re(n[0]),name:D(r[0]),timeStamp:D(r[1]),author:re(r[2]),organization:re(r[3]),preprocessor:D(r[4]),system:D(r[5]),schema:re(i[0])},e]}dataSection(e){let t=this.text;for(;;){if(e=C(t,e),t.startsWith(`ENDSEC`,e))return e+6;if(o(t,e)!==s)throw S(`expected '#' or ENDSEC but found '${t[e]??`end of file`}'`,t,e);let n=e+1;for(;b(o(t,n));)n++;let r=Number(t.slice(e+1,n));if(n=C(t,n),n===e+1||o(t,n)!==p)throw S(`expected #id=`,t,e);let i=C(t,n+1),a=ne(t,i,r);if(this.slots.has(r))throw S(`#${r} is defined twice`,t,e);let c=this.starts.length;if(this.slots.set(r,c),this.starts.push(i),this.ends.push(a),o(t,i)===u){this.types.push(`COMPLEX`);for(let e of this.get(r).parts.keys())this.index(e,r)}else{let e=i;for(;x(o(t,e));)e++;let n=t.slice(i,e).toUpperCase();this.types.push(n),this.index(n,r)}e=a+1}}index(e,t){let n=this.byType.get(e);n?n.push(t):this.byType.set(e,[t])}get size(){return this.starts.length}has(e){return this.slots.has(e)?!0:(e>=0&&this.missing.add(e),!1)}referrers(e,t=5){let n=[];for(let[e,t]of this.slots)n[t]=e;let r=[];for(let i of this.text.matchAll(RegExp(`#${e}(?![0-9])`,`g`))){let e=0,a=this.starts.length-1;for(;e<a;){let t=e+a+1>>1;this.starts[t]<=i.index?e=t:a=t-1}let o=n[e];if(this.starts[e]<=i.index&&i.index<this.ends[e]&&!r.includes(o)&&r.push(o)>=t)break}return r}describe(e){let t=this.slots.get(e);return t===void 0?`#${e}`:`#${e} ${this.types[t]}`}ids(e){return this.byType.get(e)??[]}census(){return new Map([...this.byType].map(([e,t])=>[e,t.length]))}get(e){let t=this.cache.get(e);if(t)return t;let n=this.slots.get(e);if(e<0)throw TypeError(`Invalid STEP file: an instance has no reference ($, or a value) where one is needed; export it again from the CAD tool`);if(n===void 0){let t=this.referrers(e).map(e=>this.describe(e));throw TypeError(`Invalid STEP file: #${e} is referenced${t.length?` by ${t.join(`, `)}`:``} but never defined; export it again from the CAD tool`)}let r=this.text,i=this.starts[n],a;if(o(r,i)===u){let[t,o]=te(r,i+1,d);if(C(r,o)!==this.ends[n])throw S(`#${e}: text after the complex instance`,r,o);a={id:e,type:`COMPLEX`,args:[],parts:new Map(t)}}else{let t=i;for(;x(o(r,t));)t++;let s=C(r,t);if(o(r,s)!==u)throw S(`#${e}: entity without parameters`,r,s);let[c,l]=E(r,s);if(C(r,l)!==this.ends[n])throw S(`#${e}: text after the parameters`,r,l);a={id:e,type:this.types[n],args:c}}return this.cache.set(e,a),a}args(e,t){let n=this.get(e);if(!t||n.type===t)return n.args;let r=n.parts?.get(t);if(!r)throw TypeError(`Invalid STEP file: #${e} is ${n.type}, expected ${t}`);return r}is(e,t){let n=this.get(e);return n.type===t||!!n.parts?.has(t)}typeName(e){let t=this.get(e);return t.parts?[...t.parts.keys()].join(`+`):t.type}};function ae(e){if(typeof e==`string`)return e;let t=e instanceof ArrayBuffer?new Uint8Array(e):new Uint8Array(e.buffer,e.byteOffset,e.byteLength);return new TextDecoder(`latin1`).decode(t)}var O=e=>e instanceof n?e.id:void 0,k=e=>Array.isArray(e)?e.flatMap(e=>e instanceof n?[e.id]:[]):[],A=e=>typeof e==`string`?e:``,j=e=>typeof e==`number`?e:e instanceof i&&typeof e.value==`number`?e.value:void 0,M={EXA:0xde0b6b3a7640000,PETA:0x38d7ea4c68000,TERA:0xe8d4a51000,GIGA:1e9,MEGA:1e6,KILO:1e3,HECTO:100,DECA:10,DECI:.1,CENTI:.01,MILLI:.001,MICRO:1e-6,NANO:1e-9,PICO:1e-12,FEMTO:1e-15,ATTO:1e-18},oe={red:[1,0,0],green:[0,1,0],blue:[0,0,1],yellow:[1,1,0],magenta:[1,0,1],cyan:[0,1,1],black:[0,0,0],white:[1,1,1]},se={MANIFOLD_SOLID_BREP:`solid`,BREP_WITH_VOIDS:`solid`,FACETED_BREP:`faceted`,SHELL_BASED_SURFACE_MODEL:`shell`,TESSELLATED_SOLID:`tessellated`,TESSELLATED_SHELL:`tessellated`,TRIANGULATED_FACE:`tessellated`,COMPLEX_TRIANGULATED_FACE:`tessellated`,TRIANGULATED_SURFACE_SET:`tessellated`,COMPLEX_TRIANGULATED_SURFACE_SET:`tessellated`},ce=()=>Float64Array.of(1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1),le=(t,n)=>e(t,n);function ue(e){let[t,n,r,,i,a,o,,s,c,l]=e,u=a*l-o*c,d=o*s-i*l,f=i*c-a*s,p=t*u+n*d+r*f;if(!p||!Number.isFinite(p))throw TypeError(`Invalid STEP file: a placement has no inverse (zero axes); export it again from the CAD tool`);let m=1/p,h=Float64Array.of(u*m,(r*c-n*l)*m,(n*o-r*a)*m,0,d*m,(t*l-r*s)*m,(r*i-t*o)*m,0,f*m,(n*s-t*c)*m,(t*a-n*i)*m,0,0,0,0,1);for(let t=0;t<3;t++)h[12+t]=-(h[t]*e[12]+h[4+t]*e[13]+h[8+t]*e[14]);return h}var de=e=>Array.isArray(e)?e.map(e=>j(e)??0):[],fe=e=>{let t=Math.hypot(e[0],e[1],e[2]);return t>0&&Number.isFinite(t)?[e[0]/t,e[1]/t,e[2]/t]:void 0};function N(e,{maxInstances:t=1e6}={}){if(!Number.isSafeInteger(t)||t<1)throw RangeError(`maxInstances must be a positive integer`);let a=[],o=e=>{a.length<100&&a.push(e)},s=(t,n,i=0)=>{if(!(t===void 0||i>8||!e.has(t))){if(e.is(t,`SI_UNIT`)){let[i,a]=e.args(t,`SI_UNIT`).slice(-2);return!(a instanceof r)||a.name!==n?void 0:i instanceof r?M[i.name]:1}if(e.is(t,`CONVERSION_BASED_UNIT`)){let r=O(e.args(t,`CONVERSION_BASED_UNIT`)[1]);if(r===void 0||!e.has(r))return;let a=e.get(r),o=a.parts?a.parts.get(`MEASURE_WITH_UNIT`)??[]:a.args,c=j(o[0]),l=s(O(o[1]),n,i+1);return c!==void 0&&l!==void 0?c*l:void 0}}},c=/* @__PURE__ */ new Map,l=t=>{if(t===void 0)throw TypeError(`Invalid STEP file: a representation has no context, so no length unit; export it again from the CAD tool`);let n=c.get(t);if(!n){if(n={length:NaN,angle:NaN},e.has(t)&&e.is(t,`GLOBAL_UNIT_ASSIGNED_CONTEXT`)){let r=k(e.args(t,`GLOBAL_UNIT_ASSIGNED_CONTEXT`)[0]);for(let e of r){let t=s(e,`METRE`),r=s(e,`RADIAN`);t!==void 0&&(n.length=t),r!==void 0&&(n.angle=r)}}let r=e.has(t)?`#${t} ${e.typeName(t)}`:`#${t} (never defined)`;if(!(n.length>0))throw TypeError(`Invalid STEP file: context ${r} assigns no length unit the reader can read (a GLOBAL_UNIT_ASSIGNED_CONTEXT with a length unit); its sizes are unknown`);n.angle>0||o(`context #${t}: no plane-angle unit the reader can read; angles in it are not read`),c.set(t,n)}return n},u=t=>{if(!e.has(t))return;let n=e.get(t);if(!n.parts)return n.type.endsWith(`REPRESENTATION`)?n.args:void 0;for(let e of[`SHAPE_REPRESENTATION`,`REPRESENTATION`])if(n.parts.has(e)&&n.parts.get(e).length>=3)return n.parts.get(e)},d=e=>l(O(u(e)?.[2])).length,f=(t,n)=>{if(t===void 0||!e.has(t))return ce();if(!e.is(t,`AXIS2_PLACEMENT_3D`))return o(`#${t} (${e.typeName(t)}) used as a placement; treated as identity`),ce();let[,r,i,a]=e.args(t,`AXIS2_PLACEMENT_3D`),s=O(r),c=s!==void 0&&e.has(s)?de(e.args(s)[1]):[],l=t=>{let n=O(t);return n===void 0||!e.has(n)?void 0:fe(de(e.args(n)[1]))},u=l(i)??[0,0,1],d=l(a)??(Math.abs(u[0])>1-1e-9&&!u[1]&&!u[2]?[0,1,0]:[1,0,0]),f=d[0]*u[0]+d[1]*u[1]+d[2]*u[2];d=fe([d[0]-f*u[0],d[1]-f*u[1],d[2]-f*u[2]])??[1,0,0];let p=[u[1]*d[2]-u[2]*d[1],u[2]*d[0]-u[0]*d[2],u[0]*d[1]-u[1]*d[0]];return Float64Array.of(d[0],d[1],d[2],0,p[0],p[1],p[2],0,u[0],u[1],u[2],0,(c[0]??0)*n,(c[1]??0)*n,(c[2]??0)*n,1)},p=/* @__PURE__ */ new Map,m=(e,t)=>{p.set(e,[...p.get(e)??[],t]),p.set(t,[...p.get(t)??[],e])};for(let t of[`SHAPE_REPRESENTATION_RELATIONSHIP`,`REPRESENTATION_RELATIONSHIP`])for(let n of e.ids(t)){let t=e.get(n);if(t.parts?.has(`REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION`))continue;let r=t.parts?t.parts.get(`REPRESENTATION_RELATIONSHIP`)??[]:t.args,i=O(r[2]),a=O(r[3]);i!==void 0&&a!==void 0&&m(i,a)}let h=e=>{let t=/* @__PURE__ */ new Set,n=[...e];for(;n.length;){let e=n.pop();if(!t.has(e)){t.add(e);for(let t of p.get(e)??[])n.push(t)}}return t},g=[],_=/* @__PURE__ */ new Map;for(let t of[`PRODUCT_DEFINITION`,`PRODUCT_DEFINITION_WITH_ASSOCIATED_DOCUMENTS`])for(let n of e.ids(t)){if(_.has(n))continue;let r=O(e.args(n,t)[2]),i=r!==void 0&&e.has(r)?O(e.args(r)[2]):void 0,[a,o]=i!==void 0&&e.has(i)?e.args(i):[];_.set(n,g.length),g.push({id:n,name:A(o)||A(a)||`#${n}`,partNumber:A(a)})}let v=/* @__PURE__ */ new Map;for(let t of e.ids(`PRODUCT_DEFINITION_SHAPE`)){let n=O(e.args(t)[2]);n!==void 0&&v.set(t,n)}let y=/* @__PURE__ */ new Map;for(let t of e.ids(`SHAPE_DEFINITION_REPRESENTATION`)){let[n,r]=e.args(t),i=v.get(O(n)??-1),a=O(r);i!==void 0&&a!==void 0&&y.set(i,[...y.get(i)??[],a])}let b=[],x=/* @__PURE__ */ new Set;for(let t of e.ids(`NEXT_ASSEMBLY_USAGE_OCCURRENCE`)){let n=e.args(t,`NEXT_ASSEMBLY_USAGE_OCCURRENCE`),r=O(n[3]),i=O(n[4]);r===void 0||i===void 0||!_.has(r)||!_.has(i)?o(`#${t}: assembly link to an unknown product definition; skipped`):(b.push({id:t,parent:r,child:i}),x.add(i))}let S=/* @__PURE__ */ new Map;for(let t of e.ids(`CONTEXT_DEPENDENT_SHAPE_REPRESENTATION`)){let[n,r]=e.args(t),i=v.get(O(r)??-1),a=O(n);if(i===void 0||a===void 0||!e.has(a))continue;let o=e.get(a),s=o.parts?o.parts.get(`REPRESENTATION_RELATIONSHIP`):o.args,c=o.parts?.get(`REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION`),l=O(s?.[2]),u=O(s?.[3]),d=O(c?.[0]);l!==void 0&&u!==void 0&&d!==void 0&&S.set(i,{rep1:l,rep2:u,operator:d})}let C=t=>{let n=S.get(t.id);if(!n)return o(`#${t.id}: assembly link without a placement; component placed at its parent's origin`),ce();let r=h(y.get(t.child)??[]),i=r.has(n.rep1)||!r.has(n.rep2);i&&!r.has(n.rep1)&&o(`#${t.id}: its placement names neither representation of the component; assuming the first`);let[a,s]=i?[n.rep1,n.rep2]:[n.rep2,n.rep1];if(e.is(n.operator,`ITEM_DEFINED_TRANSFORMATION`)){let[,,t,r]=e.args(n.operator,`ITEM_DEFINED_TRANSFORMATION`),[o,c]=i?[t,r]:[r,t],l=(t,n)=>k(e.args(t)[1]).includes(O(n)??-1);if(l(s,o)&&l(a,c)){let e=o;o=c,c=e}return le(f(O(c),d(s)),ue(f(O(o),d(a))))}if(e.is(n.operator,`CARTESIAN_TRANSFORMATION_OPERATOR_3D`)){let t=e.get(n.operator),r=t.parts?t.parts.get(`CARTESIAN_TRANSFORMATION_OPERATOR`)??[]:t.args,a=t.parts?t.parts.get(`CARTESIAN_TRANSFORMATION_OPERATOR_3D`)?.[0]:r[6],o=(t,n)=>{let r=O(t);return r!==void 0&&e.has(r)&&fe(de(e.args(r)[1]))||n},c=o(r[2],[1,0,0]),l=o(r[3],[0,1,0]),u=o(a,[0,0,1]),f=O(r[4]),p=j(r[5])??1,m=f!==void 0&&e.has(f)?de(e.args(f)[1]):[0,0,0],h=d(s),g=Float64Array.of(c[0]*p,c[1]*p,c[2]*p,0,l[0]*p,l[1]*p,l[2]*p,0,u[0]*p,u[1]*p,u[2]*p,0,(m[0]??0)*h,(m[1]??0)*h,(m[2]??0)*h,1);return i?g:ue(g)}return o(`#${t.id}: placement ${e.typeName(n.operator)} is not supported; component placed at its parent's origin`),ce()},w=t=>{let r,i=1,a=/* @__PURE__ */ new Set,o=[...t];for(;o.length&&a.size<64;){let t=o.pop();if(a.has(t)||!e.has(t))continue;a.add(t);let s=e.get(t);if(s.type!==`CURVE_STYLE`){if(!r&&e.is(t,`COLOUR_RGB`)){let[,n,i,a]=e.args(t,`COLOUR_RGB`);r=[j(n)??0,j(i)??0,j(a)??0]}else if(!r&&s.type===`DRAUGHTING_PRE_DEFINED_COLOUR`)r=oe[A(s.args[0]).toLowerCase()];else if(s.type===`SURFACE_STYLE_TRANSPARENT`)i=1-(j(s.args[0])??0);else for(let e of s.parts?[...s.parts.values()].flat():s.args)for(let t of e instanceof n?[e.id]:k(e))o.push(t)}}return r?[r[0],r[1],r[2],i]:void 0},T=/* @__PURE__ */ new Map;for(let t of[`STYLED_ITEM`,`OVER_RIDING_STYLED_ITEM`])for(let n of e.ids(t)){let[,r,i]=e.args(n,t),a=O(i),o=a===void 0?void 0:w(k(r));o&&a!==void 0&&(t===`OVER_RIDING_STYLED_ITEM`||!T.has(a))&&T.set(a,o)}let ee=[],E=/* @__PURE__ */ new Map,te={},ne={},D=/* @__PURE__ */ new Map,re=/* @__PURE__ */ new Set,ie=e=>e instanceof r&&e.name===`F`,ae=/* @__PURE__ */ new Set,N=t=>e.has(t)||t>=0&&!ae.add(t),P=(t,n=!1)=>{if(!N(t))return[];if(e.is(t,`ORIENTED_CLOSED_SHELL`)||e.is(t,`ORIENTED_OPEN_SHELL`)){let r=e.get(t).args;return P(O(r[2])??-1,n!==ie(r[3]))}return k(e.get(t).args[1]).map(t=>{if(!N(t)||!e.is(t,`ORIENTED_FACE`))return[t,n];let r=e.get(t).args;return[O(r[2])??t,n!==ie(r[3])]})},pe=(t,n,r)=>{let i=E.get(t);if(i!==void 0)return i;ae=/* @__PURE__ */ new Set;let a=e.get(t),o=se[a.type]??`tessellated`,s=a.args,c=a.type===`SHELL_BASED_SURFACE_MODEL`?k(s[1]):a.type===`BREP_WITH_VOIDS`?[O(s[1])??-1,...k(s[2])]:o===`tessellated`?[]:[O(s[1])??-1],l=[],u=[],d=/* @__PURE__ */ new Set;for(let t of c)for(let[n,r]of P(t)){if(!N(n))continue;l.push(n),r&&u.push(n);let[,t,i]=e.get(n).args,a=O(i);if(a!==void 0&&N(a)){let t=e.typeName(a);te[t]=(te[t]??0)+1}let o=T.get(n);o&&D.set(n,o);for(let n of k(t)){let t=N(n)?O(e.get(n).args[1]):void 0;if(t!==void 0&&N(t)&&e.is(t,`EDGE_LOOP`))for(let n of k(e.args(t,`EDGE_LOOP`)[1])){let t=N(n)?O(e.get(n).args[3]):void 0;if(t===void 0||d.has(t))continue;d.add(t);let r=N(t)?O(e.get(t).args[3]):void 0;if(r!==void 0&&N(r)&&!re.has(t)){re.add(t);let n=e.typeName(r);ne[n]=(ne[n]??0)+1}}}}if(o===`tessellated`)for(let e of a.type===`TESSELLATED_SOLID`||a.type===`TESSELLATED_SHELL`?k(s[1]):[t]){let t=T.get(e);t&&D.set(e,t)}let f=T.get(t)??(c.length?T.get(c[0]):void 0);return E.set(t,ee.length),ee.push({id:t,kind:o,name:A(s[0]),faces:l,...u.length?{reversed:u}:{},edges:d.size,unit:n,angleUnit:r,...f?{color:f}:{},...ae.size?{unresolved:[...ae]}:{}}),ee.length-1},me=[],he=[],ge=/* @__PURE__ */ new Map;for(let e of b)ge.set(e.parent,[...ge.get(e.parent)??[],e]);let _e=(e,n,r,i,a,o)=>{if(me.length>=t)throw RangeError(`STEP assembly places more than ${t} bodies; raise the maxInstances option`);me.push({body:pe(e,n.length,n.angle),product:r,matrix:a,path:o,occurrence:i})},ve=(t,n,r,i,a,o,s=/* @__PURE__ */ new Set)=>{let c=u(t);if(!c||o>32)return;let p=l(O(c[2])),m=p.length;for(let t of k(c[1])){if(!e.has(t))continue;let c=e.get(t).type;if(se[c])_e(t,p,r,i,n,a);else if(c===`MAPPED_ITEM`){let[,c,l]=e.args(t),u=O(c);if(u===void 0||!e.has(u))continue;let[p,g]=e.args(u),_=O(g);if(_===void 0||s.has(_))continue;let v=le(f(O(l),m),ue(f(O(p),d(_))));for(let e of h([_]))ve(e,le(n,v),r,i,a,o+1,s)}}},ye=(t,n)=>{let r=[];for(let i of t){let t=u(i);if(!t)continue;let a=l(O(t[2])).length;for(let i of k(t[1])){if(!e.has(i)||e.get(i).type!==`MAPPED_ITEM`)continue;let[,t,o]=e.args(i),s=O(t);if(s===void 0||!e.has(s))continue;let[c,l]=e.args(s),u=O(l);u!==void 0&&n.has(u)&&r.push(le(f(O(o),a),ue(f(O(c),d(u)))))}}return r},be=(e,t,n,r,i)=>{let a=_.get(e);if(n.includes(a)||r>64){o(`#${e}: assembly contains itself; stopped there`);return}let s=[...n,a],c=/* @__PURE__ */ new Set,l=he.push({product:a,parent:i,matrix:t})-1,u=h(y.get(e)??[]),d=/* @__PURE__ */ new Map;for(let t of ge.get(e)??[]){let e=h(y.get(t.child)??[]);if(!S.has(t.id)&&!d.has(t.child)){let n=ye(u,e);n.length&&d.set(t.child,n)}for(let t of e)c.add(t)}for(let e of u)c.has(e)||ve(e,t,a,l,s,0,c);let f=/* @__PURE__ */ new Set;for(let n of ge.get(e)??[]){let e=d.get(n.child);if(!e)be(n.child,le(t,C(n)),s,r+1,l);else if(!f.has(n.child)){f.add(n.child);for(let i of e)be(n.child,le(t,i),s,r+1,l)}}},F=g.map((e,t)=>t).filter(e=>!x.has(g[e].id));for(let e of F)be(g[e].id,ce(),[],0,-1);if(!g.length)for(let t of[`ADVANCED_BREP_SHAPE_REPRESENTATION`,`MANIFOLD_SURFACE_SHAPE_REPRESENTATION`,`SHAPE_REPRESENTATION`])for(let n of e.ids(t))ve(n,ce(),-1,-1,[],0);for(let t of[`MANIFOLD_SOLID_BREP`,`BREP_WITH_VOIDS`,`FACETED_BREP`,`SHELL_BASED_SURFACE_MODEL`])for(let n of e.ids(t))E.has(n)||o(`${e.describe(n)} '${A(e.args(n)[0])}' is in no placed representation; not read`);let xe=(t,n,r)=>{if(t!==void 0&&e.has(t)){let i=e.get(t),a=i.parts?i.parts.get(`DERIVED_UNIT`):i.type===`DERIVED_UNIT`?i.args:void 0;if(a){let t=1;for(let i of k(a[0])){let[a,o]=e.has(i)?e.args(i):[],c=s(O(a),`METRE`);if(c===void 0||typeof o!=`number`)return r**n;t*=c**o}return t}let o=s(t,`METRE`);if(o!==void 0)return o**n}return r**n},Se=/* @__PURE__ */ new Map,Ce=(e,t)=>{e!==void 0&&Se.set(e,[...Se.get(e)??[],...t])};for(let t of e.ids(`GEOMETRIC_ITEM_SPECIFIC_USAGE`)){let r=e.args(t,`GEOMETRIC_ITEM_SPECIFIC_USAGE`),i=r[4];Ce(O(r[2]),i instanceof n?[i.id]:k(i))}let we=/* @__PURE__ */ new Map;for(let t of e.ids(`PROPERTY_DEFINITION_REPRESENTATION`)){let[n,r]=e.args(t,`PROPERTY_DEFINITION_REPRESENTATION`),i=O(n),a=O(r);i!==void 0&&a!==void 0&&we.set(i,[...we.get(i)??[],a])}for(let t of e.ids(`SHAPE_DEFINITION_REPRESENTATION`)){let[n,r]=e.args(t),i=O(n);if(i===void 0||!e.has(i)||!e.is(i,`PROPERTY_DEFINITION`))continue;let a=O(e.args(i,`PROPERTY_DEFINITION`)[2]);a!==void 0&&e.has(a)&&e.is(a,`SHAPE_ASPECT`)&&Ce(a,k(u(O(r)??-1)?.[1]))}let Te=t=>{let n=e.get(t);if(n.parts){let e=n.parts.get(`MEASURE_WITH_UNIT`);return e?{name:A(n.parts.get(`REPRESENTATION_ITEM`)?.[0]),value:e[0],unit:O(e[1])}:void 0}return n.type===`MEASURE_REPRESENTATION_ITEM`?{name:A(n.args[0]),value:n.args[1],unit:O(n.args[2])}:void 0},Ee=/* @__PURE__ */ new Map;for(let t of e.ids(`PROPERTY_DEFINITION`)){let[n,r,a]=e.args(t,`PROPERTY_DEFINITION`),o=`${A(n)} ${A(r)}`.toLowerCase(),s=o.includes(`tessellated validation property`),c=O(a);if(!s&&!o.includes(`geometric validation property`)||c===void 0||!e.has(c))continue;let d,f,p;if(e.is(c,`SHAPE_ASPECT`)){let[t,n,r]=e.args(c,`SHAPE_ASPECT`);if(d=_.get(v.get(O(r)??-1)??-1)??-1,f=[...new Set((Se.get(c)??[]).flatMap(e=>E.get(e)??[]))].sort((e,t)=>e-t),p=A(n).trim()||A(t).trim()||`#${c}`,!f.length)continue}else d=_.get(v.get(c)??-1)??-1,p=d>=0?g[d].name:`#${c}`;let m=e=>{let n=`${d}|${f?.join(`,`)??`*`}|${s}|${e}`,r=Ee.get(n);return r||(r={id:t,label:p,product:d,tessellated:s,...f?{bodies:f}:{}},e&&(r.independent=!0),Ee.set(n,r)),r};for(let n of we.get(t)??[]){let t=u(n);if(!t)continue;let r=l(O(t[2])).length,a=/* @__PURE__ */ new Map;for(let n of k(t[1])){if(!e.has(n))continue;let o=e.get(n),c=Te(n),l=`${c?c.name:A(o.args[0])} ${A(t[0])}`;if(/independent\s+(point|curve)|curve length/i.test(l))continue;let u=m(/independent/i.test(l));if(c&&c.value instanceof i&&typeof c.value.value==`number`)c.value.type===`VOLUME_MEASURE`?u.volume??=c.value.value*xe(c.unit,3,r):c.value.type===`AREA_MEASURE`&&(u.area??=c.value.value*xe(c.unit,2,r));else if(o.type===`CARTESIAN_POINT`){let[e,t]=o.args,n=de(t).map(e=>e*r);if(n.length!==3)continue;/bounding box/i.test(l)?a.set(u,[...a.get(u)??[],n]):u.centroid||(u.centroid=[n[0],n[1],n[2]],(s||/surface/i.test(A(e)))&&(u.surfaceCentroid=!0))}else if(/facet/i.test(A(o.args[0]))){let e=j(o.args[1]);e!==void 0&&(u.facets??=e)}}for(let[e,[t,n,...r]]of a)n&&!r.length&&!e.box&&(e.box=[[Math.min(t[0],n[0]),Math.min(t[1],n[1]),Math.min(t[2],n[2])],[Math.max(t[0],n[0]),Math.max(t[1],n[1]),Math.max(t[2],n[2])]])}}for(let e of Ee.values())(e.volume===0||e.area===0)&&(e.volume===0&&delete e.volume,e.area===0&&delete e.area,e.centroid&&e.centroid.every(e=>e===0)&&delete e.centroid);let I=[...Ee.values()].filter(e=>e.volume!==void 0||e.area!==void 0||e.centroid||e.box||e.facets!==void 0);for(let t of[...e.missing].sort((e,t)=>e-t)){let n=e.referrers(t).map(t=>e.describe(t));o(`#${t} is referred to${n.length?` by ${n.join(`, `)}`:``} but never defined; left out`)}return{products:g,roots:F,bodies:ee,instances:me,occurrences:he,validation:I,faceColors:D,census:{surfaces:te,curves:ne},warnings:a}}function P(e,t){if(e.length!==t.length||!e.length)throw TypeError(`Invalid STEP B-spline: knots and multiplicities must have the same, non-zero length`);let n=[];for(let r=0;r<e.length;r++){let i=t[r];if(!Number.isInteger(i)||i<1||i>64)throw TypeError(`Invalid STEP B-spline: a knot multiplicity; export it again from the CAD tool`);if(r&&e[r]<e[r-1])throw TypeError(`Invalid STEP B-spline: knots must not decrease`);for(let t=0;t<i;t++)n.push(e[r])}return n}function pe(e,t,n,r){if(n>=r[e+1]){let n=e;for(;n>t&&!(r[n+1]>r[n]);)n--;return n}if(n<=r[t]){let n=t;for(;n<e&&!(r[n+1]>r[n]);)n++;return n}let i=t,a=e+1,o=i+a>>1;for(;n<r[o]||n>=r[o+1];)n<r[o]?a=o:i=o,o=i+a>>1;return o}var me=31,he=/* @__PURE__ */ new Float64Array(1024),ge=/* @__PURE__ */ new Float64Array(32),_e=/* @__PURE__ */ new Float64Array(32);function ve(e,t,n,r,i,a){let o=n>me,s=o?new Float64Array((n+1)*(n+1)):he,c=o?new Float64Array(n+1):ge,l=o?new Float64Array(n+1):_e,u=n+1;s[0]=1;for(let i=1;i<=n;i++){c[i]=t-r[e+1-i],l[i]=r[e+i]-t;let n=0;for(let e=0;e<i;e++){let t=l[e+1]+c[i-e];s[i*u+e]=t;let r=t?s[e*u+i-1]/t:0;s[e*u+i]=n+l[e+1]*r,n=c[i-e]*r}s[i*u+i]=n}for(let e=0;e<=n;e++)i[e]=s[e*u+n];if(!n)a[0]=0;else for(let e=0;e<=n;e++){let t=0;e>=1&&s[n*u+e-1]&&(t+=s[(e-1)*u+n-1]/s[n*u+e-1]),e<=n-1&&s[n*u+e]&&(t-=s[e*u+n-1]/s[n*u+e]),a[e]=t*n}}var ye=/* @__PURE__ */ new Float64Array(32),be=/* @__PURE__ */ new Float64Array(32);function F(e,t){let n=e.points.length/4-1,r=e.degree,i=pe(n,r,t,e.knots),a=r>me,o=a?new Float64Array(r+1):ye,s=a?new Float64Array(r+1):be;ve(i,t,r,e.knots,o,s);let c=[0,0,0,0],l=[0,0,0,0];for(let t=0;t<=r;t++){let n=(i-r+t)*4;for(let r=0;r<4;r++)c[r]+=o[t]*e.points[n+r],l[r]+=s[t]*e.points[n+r]}let u=c[3],d=[c[0]/u,c[1]/u,c[2]/u,0,0,0];for(let e=0;e<3;e++)d[3+e]=(l[e]-l[3]*d[e])/u;return d}var xe={knots:void 0,count:0,degree:-1,t:NaN,span:0,values:/* @__PURE__ */ new Float64Array(32),derivatives:/* @__PURE__ */ new Float64Array(32)},Se={...xe,values:/* @__PURE__ */ new Float64Array(32),derivatives:/* @__PURE__ */ new Float64Array(32)};function Ce(e,t,n,r,i){if(n>me){let e=pe(t-1,n,r,i),a=new Float64Array(n+1),o=new Float64Array(n+1);return ve(e,r,n,i,a,o),{knots:i,count:t,degree:n,t:r,span:e,values:a,derivatives:o}}return Object.is(r,e.t)&&i===e.knots&&t===e.count&&n===e.degree||(e.knots=void 0,e.span=pe(t-1,n,r,i),ve(e.span,r,n,i,e.values,e.derivatives),e.knots=i,e.count=t,e.degree=n,e.t=r),e}function we(e,t,n){let r=e.uDegree,i=e.vDegree,a=Ce(xe,e.nu,r,t,e.uKnots),o=Ce(Se,e.nv,i,n,e.vKnots),s=a.span,c=o.span,l=a.values,u=a.derivatives,d=o.values,f=o.derivatives,p=0,m=0,h=0,g=0,_=0,v=0,y=0,b=0,x=0,S=0,C=0,w=0,T=e.points;for(let t=0;t<=r;t++){let n=l[t],a=u[t],o=((s-r+t)*e.nv+(c-i))*4;for(let e=0;e<=i;e++,o+=4){let t=n*d[e],r=a*d[e],i=n*f[e],s=T[o],c=T[o+1],l=T[o+2],u=T[o+3];p+=t*s,m+=t*c,h+=t*l,g+=t*u,_+=r*s,v+=r*c,y+=r*l,b+=r*u,x+=i*s,S+=i*c,C+=i*l,w+=i*u}}let ee=p/g,E=m/g,te=h/g;return[ee,E,te,(_-b*ee)/g,(v-b*E)/g,(y-b*te)/g,(x-w*ee)/g,(S-w*E)/g,(C-w*te)/g]}function Te(e,t){for(let n=1;n<=t;n++)if(e[n]!==e[0]||e[e.length-1-n]!==e[e.length-1])return!1;return!0}function Ee(e,t,n){let r=[];for(let i=t;i<=n+1;i++)(!r.length||e[i]>r[r.length-1])&&r.push(e[i]);return r}var I=(e,t)=>[e[0]+t[0],e[1]+t[1],e[2]+t[2]],L=(e,t)=>[e[0]-t[0],e[1]-t[1],e[2]-t[2]],R=(e,t)=>[e[0]*t,e[1]*t,e[2]*t],z=(e,t)=>e[0]*t[0]+e[1]*t[1]+e[2]*t[2],B=(e,t)=>[e[1]*t[2]-e[2]*t[1],e[2]*t[0]-e[0]*t[2],e[0]*t[1]-e[1]*t[0]],De=(e,t,n)=>{let r=e*e+t*t+n*n;return r>1e-280&&r<1e280?Math.sqrt(r):Math.hypot(e,t,n)},V=e=>De(e[0],e[1],e[2]),H=(e,t)=>De(e[0]-t[0],e[1]-t[1],e[2]-t[2]),U=e=>{let t=V(e);return t>0&&Number.isFinite(t)?[e[0]/t,e[1]/t,e[2]/t]:void 0},Oe=(e,t)=>{let n=V(e)*V(t);return n>0?Math.acos(Math.max(-1,Math.min(1,z(e,t)/n))):0},W=(e,t,n)=>n>0?e+Math.round((t-e)/n)*n:e;function ke(e,t=[],n=Ae){let r=[1/0,1/0,1/0],i=[-1/0,-1/0,-1/0],a=0,o=(e,t)=>{for(let n=0;n<3;n++)r[n]=Math.min(r[n],e[n]-t),i[n]=Math.max(i[n],e[n]+t);a=Math.max(a,V(e)+t)};for(let t of e)o(t,0);for(let[e,n]of t)o(e,Math.abs(n));if(!(i[0]>=r[0]&&i[1]>=r[1]&&i[2]>=r[2]))return 0;let s=Math.max(...r.map(Math.abs),...i.map(Math.abs));return Math.max(Math.min(a,De(i[0]-r[0],i[1]-r[1],i[2]-r[2])),n*s)}var Ae=1e-6,G=e=>e instanceof n?e.id:void 0,K=(e,t=0)=>typeof e==`number`?e:e instanceof i&&typeof e.value==`number`?e.value:t,q=e=>Array.isArray(e)?e:[];function je(e,t,n){return/* @__PURE__ */ TypeError(`Unsupported STEP ${n}: #${t} ${e.typeName(t)}; export it as a B-spline from the CAD tool`)}function Me(e,t){if(t===void 0||!e.is(t,`CARTESIAN_POINT`))throw TypeError(`Invalid STEP file: #${t} is not a point; export it again from the CAD tool`);let n=q(e.args(t,`CARTESIAN_POINT`)[1]);return[K(n[0]),K(n[1]),K(n[2])]}function Ne(e,t){if(t===void 0||!e.is(t,`DIRECTION`))throw TypeError(`Invalid STEP file: #${t} is not a direction; export it again from the CAD tool`);let n=q(e.args(t,`DIRECTION`)[1]),r=U([K(n[0]),K(n[1]),K(n[2])]);if(!r)throw TypeError(`Invalid STEP file: #${t} is a zero direction; export it again from the CAD tool`);return r}function Pe(e,t){if(t===void 0||!e.is(t,`VECTOR`))throw TypeError(`Invalid STEP file: #${t} is not a vector; export it again from the CAD tool`);let[,n,r]=e.args(t,`VECTOR`),i=Ne(e,G(n)),a=K(r,1);return[i[0]*a,i[1]*a,i[2]*a]}function Fe(e,t){if(t!==void 0&&e.is(t,`AXIS2_PLACEMENT_2D`)){let[,n,r]=e.args(t,`AXIS2_PLACEMENT_2D`),i=Me(e,G(n)),a=G(r)===void 0?[1,0,0]:Ne(e,G(r));return{origin:[i[0],i[1],0],x:a,y:[-a[1],a[0],0],z:[0,0,1]}}if(t===void 0||!e.is(t,`AXIS2_PLACEMENT_3D`))throw TypeError(`Invalid STEP file: #${t} is not an axis placement; export it again from the CAD tool`);let[,n,r,i]=e.args(t,`AXIS2_PLACEMENT_3D`),a=Me(e,G(n)),o=G(r)===void 0?[0,0,1]:Ne(e,G(r)),s=G(i)===void 0?Math.abs(o[0])>1-1e-9?[0,1,0]:[1,0,0]:Ne(e,G(i)),c=z(s,o);return s=U([s[0]-c*o[0],s[1]-c*o[1],s[2]-c*o[2]])??[1,0,0],{origin:a,x:s,y:B(o,s),z:o}}var Ie=(e,t,n)=>e>t?Math.min(n,2*Math.acos(1-t/e)):n,Le=(e,t,n)=>{let r=Math.max(1,Math.min(4096,Math.ceil(Math.abs(t-e)/n-1e-9)));return Array.from({length:r+1},(n,i)=>i===r?t:e+(t-e)*i/r)};function Re(e,t,n,r){let i=[t[0]],a=(t,o,s,c,l)=>{let u=(t+s)/2,d=e.at(u),f=e=>[o[0]+(c[0]-o[0])*e,o[1]+(c[1]-o[1])*e,o[2]+(c[2]-o[2])*e];(H(d,f(.5))>n||H(e.at(t+(s-t)/4),f(.25))>n||H(e.at(t+(s-t)*3/4),f(.75))>n||H(o,c)>n*.01&&Oe(o.slice(3),c.slice(3))>r)&&l<14?(a(t,o,u,d,l+1),a(u,d,s,c,l+1)):i.push(s)};for(let n=1;n<t.length;n++)t[n]!==t[n-1]&&a(t[n-1],e.at(t[n-1]),t[n],e.at(t[n]),0);return i}var ze=(e,t,n)=>e<=t?n(e,t):n(t,e).reverse(),Be=class{constructor(e,t){this.origin=e,this.dir=t,this.period=0,this.domain=[-1/0,1/0]}at(e){return[...I(this.origin,R(this.dir,e)),...this.dir]}parameter(e){return z(L(e,this.origin),this.dir)/z(this.dir,this.dir)}sample(e,t){return[e,t]}},Ve=class{constructor(e,t,n){this.f=e,this.a=t,this.b=n,this.period=2*Math.PI,this.domain=[0,2*Math.PI]}at(e){let t=Math.cos(e),n=Math.sin(e),{origin:r,x:i,y:a}=this.f,o=this.a,s=this.b;return[r[0]+o*t*i[0]+s*n*a[0],r[1]+o*t*i[1]+s*n*a[1],r[2]+o*t*i[2]+s*n*a[2],-o*n*i[0]+s*t*a[0],-o*n*i[1]+s*t*a[1],-o*n*i[2]+s*t*a[2]]}parameter(e){let t=L(e,this.f.origin),n=Math.atan2(z(t,this.f.y)/this.b,z(t,this.f.x)/this.a);return n<0?n+2*Math.PI:n}sample(e,t,n,r){return Le(e,t,Ie(Math.max(this.a,this.b),n,r))}},He=class{constructor(e,t){this.spline=e,this.step=0;let n=e.points.length/4-1;this.domain=[e.knots[e.degree],e.knots[n+1]],this.breaks=Ee(e.knots,e.degree,n),this.period=t?this.domain[1]-this.domain[0]:0}clamp(e){let[t,n]=this.domain;return this.period?t+((e-t)%this.period+this.period)%this.period:Math.min(n,Math.max(t,e))}at(e){return F(this.spline,this.clamp(e))}parameter(e,t){if(t!==void 0){let n=this.newton(e,t);return n.start<=this.hull()[1]/8||n.miss<=1e-6*this.size()?n.t:this.nearest(e,n).t}return this.nearest(e,{t:this.domain[0],miss:1/0,start:1/0}).t}nearest(e,t){let n=this.samples(),r=n.length,i=new Float64Array(r),a=0;for(let t=0;t<r;t++)i[t]=H(n[t].p,e),i[t]<i[a]&&(a=t);let o=this.newton(e,n[a].t);if(o.miss<t.miss&&(t=o),t.miss<=.001*this.size())return t;let s=[];for(let e=0;e<r;e++){let t=e>0?i[e-1]:this.period?i[r-1]:1/0,n=e+1<r?i[e+1]:this.period?i[0]:1/0;i[e]<=t&&i[e]<=n&&s.push(e)}s.sort((e,t)=>i[e]-i[t]);for(let r of s.slice(0,16)){if(r===a)continue;if(t.miss<=1e-9*this.size()||i[r]>t.miss+this.step)break;let o=this.newton(e,n[r].t);o.miss<t.miss&&(t=o)}return t}samples(){if(!this.seeds){this.seeds=[...this.breaks.slice(1).flatMap((e,t)=>{let n=this.breaks[t];return Array.from({length:8},(t,r)=>{let i=n+(e-n)*r/8;return{t:i,p:this.at(i)}})}),{t:this.domain[1],p:this.at(this.domain[1])}];for(let e=1;e<this.seeds.length;e++)this.step=Math.max(this.step,H(this.seeds[e-1].p,this.seeds[e].p))}return this.seeds}size(){return this.hull()[0]}hull(){if(!this.extent){let e=this.spline.points,t=[1/0,1/0,1/0],n=[-1/0,-1/0,-1/0],r=0,i;for(let a=0;a<e.length;a+=4){let o=[e[a]/e[a+3],e[a+1]/e[a+3],e[a+2]/e[a+3]];for(let e=0;e<3;e++)t[e]=Math.min(t[e],o[e]),n[e]=Math.max(n[e],o[e]);i&&(r=Math.max(r,H(i,o))),i=o}this.extent=[Math.hypot(n[0]-t[0],n[1]-t[1],n[2]-t[2])||1,r]}return this.extent}newton(e,t){let n=this.clamp(t),r=1/0;for(let t=0;t<40;t++){let i=this.at(n),a=i.slice(3),o=z(a,a);if(t===0&&(r=H(i,e)),!o)break;let s=z(L(i,e),a)/o,c=this.clamp(n-s);if(Math.abs(c-n)<1e-14*Math.max(1,Math.abs(n))){n=c;break}n=c}return{t:n,miss:H(this.at(n),e),start:r}}sample(e,t,n,r){return ze(e,t,(e,t)=>{let i=this.breaks.filter(n=>n>e&&n<t),a=this.period?Math.floor((e-this.domain[0])/this.period)*this.period:0;if(this.period)for(let n of this.breaks)for(let r of[a,a+this.period])n+r>e&&n+r<t&&i.push(n+r);return i.sort((e,t)=>e-t),Re(this,[e,...i,t],n,r)})}},Ue=class{constructor(e){this.points=e,this.period=0,this.domain=[0,Math.max(0,e.length-1)]}at(e){let t=this.points.length-1,n=Math.max(0,Math.min(t-1,Math.floor(e))),r=e-n,i=this.points[n],a=this.points[n+1];return[...I(i,R(L(a,i),r)),...L(a,i)]}parameter(e){let t=1/0,n=0;for(let r=0;r+1<this.points.length;r++){let i=this.points[r],a=L(this.points[r+1],i),o=Math.max(0,Math.min(1,z(L(e,i),a)/(z(a,a)||1))),s=H(I(i,R(a,o)),e);s<t&&(t=s,n=r+o)}return n}sample(e,t){return ze(e,t,(e,t)=>{let n=[];for(let r=Math.floor(e)+1;r<t;r++)n.push(r);return[e,...n,t]})}};function We(e,t){let n=e.get(t),i=n.parts?n.parts.get(`B_SPLINE_CURVE`):n.args.slice(1,6),a=n.parts?n.parts.get(`B_SPLINE_CURVE_WITH_KNOTS`):n.args.slice(6,9),o=n.parts?.get(`RATIONAL_B_SPLINE_CURVE`);if(!i||!a)throw je(e,t,`B-spline curve (knots implied, not listed)`);let s=K(i[0]),c=q(i[1]).map(t=>Me(e,G(t))),l=o?q(o[0]).map(e=>K(e,1)):void 0,u=P(q(a[1]).map(e=>K(e)),q(a[0]).map(e=>K(e)));if(u.length!==c.length+s+1||s<1)throw TypeError(`Invalid STEP file: #${t} B-spline knots do not match its control points and degree; export it again from the CAD tool`);let d=new Float64Array(c.length*4);c.forEach((e,t)=>{let n=l?.[t]??1;d.set([e[0]*n,e[1]*n,e[2]*n,n],t*4)});let f=ke(c),p=i[3]instanceof r&&i[3].name===`T`||Te(u,s)&&H(c[0],c[c.length-1])<=1e-9*Math.max(f,1e-30);return new He({degree:s,points:d,knots:u},p)}function Ge(e,t){let n=e.get(t),r=n.parts?n.parts.has(`B_SPLINE_CURVE`)?`B_SPLINE_CURVE_WITH_KNOTS`:``:n.type,i=n.args;switch(r){case`LINE`:return new Be(Me(e,G(i[1])),Pe(e,G(i[2])));case`CIRCLE`:{let t=K(i[2]);return new Ve(Fe(e,G(i[1])),t,t)}case`ELLIPSE`:return new Ve(Fe(e,G(i[1])),K(i[2]),K(i[3]));case`B_SPLINE_CURVE_WITH_KNOTS`:return We(e,t);case`POLYLINE`:return new Ue(q(i[1]).map(t=>Me(e,G(t))));case`SURFACE_CURVE`:case`SEAM_CURVE`:case`INTERSECTION_CURVE`:case`TRIMMED_CURVE`:{let n=G(i[1]);if(n===void 0)throw je(e,t,`curve`);return Ge(e,n)}default:throw je(e,t,`curve`)}}var Ke=2*Math.PI,qe=e=>e<0?e+Ke:e;function Je(e,t,n,r){if(!e.singular(t,n))return!1;let i=e.at(t,n),a=(e,t)=>Number.isFinite(e[0])&&Number.isFinite(e[1])?[e[0],(e[0]+e[1])/2,e[1]]:[t-1,t+1],o=e=>e.every(e=>H(e,i)<=r);return o(a(e.uDomain,t).map(t=>e.at(t,n)))||o(a(e.vDomain,n).map(n=>e.at(t,n)))}function Ye(e,t,n,r=e.vDomain){let i=e.at(t,n),a=i.slice(3,6),o=i.slice(6,9),s=B(a,o);if(V(s)>1e-10*V(a)*V(o))return U(s)??[0,0,1];let[c,l]=r,u=Number.isFinite(l-c)?(l-c)*1e-4:1e-4,d=n+u<=l?u:-u,f=z(a,a),p=f>0?-z(o,a)/f*d:0,m=e.at(e.uPeriod?t+p:Math.min(e.uDomain[1],Math.max(e.uDomain[0],t+p)),n+d);return U(B(m.slice(3,6),m.slice(6,9)))??[0,0,1]}var Xe=(e,t)=>{let n=Math.cos(t),r=Math.sin(t);return[[n*e.x[0]+r*e.y[0],n*e.x[1]+r*e.y[1],n*e.x[2]+r*e.y[2]],[-r*e.x[0]+n*e.y[0],-r*e.x[1]+n*e.y[1],-r*e.x[2]+n*e.y[2]]]},Ze=(e,t)=>{let n=L(t,e.origin),r=z(n,e.x),i=z(n,e.y),a=z(n,e.z);return{u:qe(Math.atan2(i,r)),x:r,y:i,z:a,r:De(r,i,0)}},Qe=class{constructor(e){this.f=e,this.uPeriod=0,this.vPeriod=0,this.uDomain=[-1/0,1/0],this.vDomain=[-1/0,1/0]}at(e,t){let{origin:n,x:r,y:i}=this.f;return[n[0]+e*r[0]+t*i[0],n[1]+e*r[1]+t*i[1],n[2]+e*r[2]+t*i[2],r[0],r[1],r[2],i[0],i[1],i[2]]}normal(){return this.f.z}parameters(e){let t=L(e,this.f.origin);return[z(t,this.f.x),z(t,this.f.y)]}steps(){return[1/0,1/0]}pole(){}singular(){return!1}},$e=class{constructor(e,t,n){this.f=e,this.radius=t,this.uPeriod=Ke,this.vPeriod=0,this.uDomain=[0,Ke],this.vDomain=[-1/0,1/0],this.tan=Math.tan(n)}rho(e){return this.radius+e*this.tan}at(e,t){let{origin:n,x:r,y:i,z:a}=this.f,o=Math.cos(e),s=Math.sin(e),c=o*r[0]+s*i[0],l=o*r[1]+s*i[1],u=o*r[2]+s*i[2],d=this.rho(t),f=this.tan;return[n[0]+d*c+t*a[0],n[1]+d*l+t*a[1],n[2]+d*u+t*a[2],(-s*r[0]+o*i[0])*d,(-s*r[1]+o*i[1])*d,(-s*r[2]+o*i[2])*d,c*f+a[0],l*f+a[1],u*f+a[2]]}normal(e,t){let[n]=Xe(this.f,e),r=U(L(n,R(this.f.z,this.tan)));return this.rho(t)<0?R(r,-1):r}parameters(e,t){let n=Ze(this.f,e);return[n.r>0?n.u:t?.[0]??0,n.z]}steps(e,t,n){return[Ie(Math.max(Math.abs(this.rho(e[2])),Math.abs(this.rho(e[3]))),t,n),1/0]}pole(e){if(!this.tan)return;let t=-this.radius/this.tan;return e*this.tan*Math.sign(this.radius||1)<0?t:void 0}singular(e,t){return Math.abs(this.rho(t))<=1e-7*Math.max(Math.abs(this.radius),Math.abs(t*this.tan))+1e-12}},et=class{constructor(e,t){this.f=e,this.radius=t,this.uPeriod=Ke,this.vPeriod=0,this.uDomain=[0,Ke],this.vDomain=[-Math.PI/2,Math.PI/2]}at(e,t){let{origin:n,x:r,y:i,z:a}=this.f,o=Math.cos(e),s=Math.sin(e),c=o*r[0]+s*i[0],l=o*r[1]+s*i[1],u=o*r[2]+s*i[2],d=this.radius,f=Math.cos(t),p=Math.sin(t),m=d*f,h=-d*p;return[n[0]+d*(f*c+p*a[0]),n[1]+d*(f*l+p*a[1]),n[2]+d*(f*u+p*a[2]),(-s*r[0]+o*i[0])*m,(-s*r[1]+o*i[1])*m,(-s*r[2]+o*i[2])*m,c*h+a[0]*m,l*h+a[1]*m,u*h+a[2]*m]}normal(e,t){let[n]=Xe(this.f,e);return I(R(n,Math.cos(t)),R(this.f.z,Math.sin(t)))}parameters(e,t){let n=Ze(this.f,e);return[n.r>1e-12*this.radius?n.u:t?.[0]??0,Math.atan2(n.z,n.r)]}steps(e,t,n){let r=Ie(this.radius,t,n);return[r,r]}pole(e){return e*Math.PI/2}singular(e,t){return Math.abs(Math.cos(t))<1e-7}},tt=class{constructor(e,t,n){this.f=e,this.major=t,this.minor=n,this.uPeriod=Ke,this.vPeriod=Ke,this.uDomain=[0,Ke],this.vDomain=[0,Ke]}at(e,t){let{origin:n,x:r,y:i,z:a}=this.f,o=Math.cos(e),s=Math.sin(e),c=o*r[0]+s*i[0],l=o*r[1]+s*i[1],u=o*r[2]+s*i[2],d=Math.cos(t),f=Math.sin(t),p=this.major+this.minor*d,m=-this.minor*f,h=this.minor*d;return[n[0]+p*c+this.minor*f*a[0],n[1]+p*l+this.minor*f*a[1],n[2]+p*u+this.minor*f*a[2],(-s*r[0]+o*i[0])*p,(-s*r[1]+o*i[1])*p,(-s*r[2]+o*i[2])*p,c*m+a[0]*h,l*m+a[1]*h,u*m+a[2]*h]}normal(e,t){let[n]=Xe(this.f,e),r=I(R(n,Math.cos(t)),R(this.f.z,Math.sin(t)));return this.major+this.minor*Math.cos(t)<0?R(r,-1):r}parameters(e,t){let n=Ze(this.f,e);return[n.r>0?n.u:t?.[0]??0,qe(Math.atan2(n.z,n.r-this.major))]}steps(e,t,n){return[Ie(this.major+this.minor,t,n),Ie(this.minor,t,n)]}pole(){}singular(){return!1}};function nt(e,t,n,r,i){if(!Number.isFinite(t)||!Number.isFinite(n)||t===n)return 1/0;let a=e.sample(t,n,r,i),o=1/0;for(let e=1;e<a.length;e++)o=Math.min(o,Math.abs(a[e]-a[e-1]));return a.length>2?o:1/0}var rt=class{constructor(e,t,n){this.profile=e,this.axisPoint=t,this.axis=n,this.uPeriod=Ke,this.skewed=!0,this.uDomain=[0,Ke],this.vDomain=[-1/0,1/0],this.vPeriod=e.period}rotate(e,t){let n=Math.cos(t),r=Math.sin(t),i=this.axis;return I(I(R(e,n),R(B(i,e),r)),R(i,z(i,e)*(1-n)))}at(e,t){let n=this.profile.at(t),r=this.rotate(L(n,this.axisPoint),e);return[...I(this.axisPoint,r),...B(this.axis,r),...this.rotate(n.slice(3),e)]}turnAt(e,t){let n=L(this.profile.at(t),this.axisPoint),r=L(n,R(this.axis,z(n,this.axis)));return V(r)<1e-12*Math.max(V(n),1e-300)?NaN:Math.atan2(z(B(e,r),this.axis),z(e,r))}turnTable(){if(this.turns===void 0){let[e,t]=this.profile.period?[0,this.profile.period]:this.profile.domain,n=Number.isFinite(e)&&Number.isFinite(t)?[e,t]:[-1,1],r=Array.from({length:65},(e,t)=>n[0]+(n[1]-n[0])*t/64),i=r.map(e=>{let t=L(this.profile.at(e),this.axisPoint);return L(t,R(this.axis,z(t,this.axis)))}),a=U(i[32])??i.map(e=>U(e)).find(e=>e);if(this.turns=null,a){let e=[];for(let t of r){let n=this.turnAt(a,t),r=e.length?e[e.length-1]:0;e.push(Number.isNaN(n)?r:n+Ke*Math.round((r-n)/Ke))}e.some(e=>Math.abs(Math.sin(e))>1e-12)&&(this.turns={e0:a,at:e,lo:n[0],hi:n[1]})}}return this.turns}twisted(){return this.turnTable()!==null}twist(e){let t=this.turnTable();if(!t)return 0;let n=t.at.length-1,r=Math.max(0,Math.min(n,(e-t.lo)/(t.hi-t.lo)*n)),i=Math.min(n-1,Math.floor(r)),a=t.at[i]+(t.at[i+1]-t.at[i])*(r-i),o=this.turnAt(t.e0,e);return Number.isNaN(o)?a:o+Ke*Math.round((a-o)/Ke)}meridianTable(){if(this.arc===void 0){let[e,t]=this.profile.domain,n=this.profile.at(Number.isFinite(e)?e:0),r=L(n,this.axisPoint),i=n.slice(3,6),a=z(i,this.axis),o=L(r,R(this.axis,z(r,this.axis)));if(this.arc={speed:Math.hypot(a,V(o)?z(o,i)/V(o):V(L(i,R(this.axis,a))))||1},!this.profile.period&&Number.isFinite(e)&&Number.isFinite(t)&&t>e){let n=1024,r=e=>{let t=L(this.profile.at(e),this.axisPoint),n=z(t,this.axis);return[n,V(L(t,R(this.axis,n)))]},i=[0],[a,o]=r(e);for(let s=1;s<=n;s++){let c=0;for(let i=1;i<=4;i++){let[l,u]=r(e+(t-e)*(s-1+i/4)/n);c+=Math.hypot(l-a,u-o),[a,o]=[l,u]}i.push(i[s-1]+c)}i[n]>0&&(this.arc={lo:e,hi:t,at:i})}}return this.arc}meridian(e){let t=this.meridianTable();if(`speed`in t)return e*t.speed;let n=t.at.length-1,r=(e-t.lo)/(t.hi-t.lo)*n,i=Math.max(0,Math.min(n-1,Math.floor(r)));return t.at[i]+(t.at[i+1]-t.at[i])*(r-i)}meridianParameter(e){let t=this.meridianTable();if(`speed`in t)return e/t.speed;let n=t.at.length-1,r=0,i=n;for(;i-r>1;){let n=r+i>>1;t.at[n]<=e?r=n:i=n}let a=e<t.at[0]?0:Math.min(r,n-1),o=t.at[a+1]-t.at[a],s=a+(o>0?(e-t.at[a])/o:0);return t.lo+(t.hi-t.lo)*s/n}normal(e,t){return Ye(this,e,t,this.profile.period?this.vDomain:this.profile.domain)}parameters(e,t){let n=this.axis,r=e=>{let t=L(e,this.axisPoint);return L(t,R(n,z(t,n)))},i=L(e,this.axisPoint),a=z(i,n),o=L(i,R(n,a)),s=V(o),c=e=>{let t=this.profile.at(e),i=r(t),o=V(i),c=t.slice(3,6),l=z(c,n),u=o?z(i,c)/o:V(L(c,R(n,l)));return{eh:z(L(t,this.axisPoint),n)-a,er:o-s,dh:l,dr:u}},l=U(r(this.profile.at(t?.[1]??0)))??U(o)??[1,0,0],u=I(I(this.axisPoint,R(n,a)),R(l,s)),[d,f]=this.profile.period?[-1/0,1/0]:this.profile.domain,p=e=>{let t=Math.min(f,Math.max(d,e)),n=c(t),r=Math.hypot(n.eh,n.er);for(let e=0;e<60&&r>0;e++){let e=n.dh*n.dh+n.dr*n.dr;if(!(e>0))break;let i=-(n.eh*n.dh+n.er*n.dr)/e,a=!1;for(let e=0;e<30&&!a;e++,i/=2){let e=Math.min(f,Math.max(d,t+i)),o=c(e),s=Math.hypot(o.eh,o.er);s<r&&([t,n,r,a]=[e,o,s,!0])}if(!a)break}return{v:t,miss:r}},m=p(this.profile.parameter(u,t?.[1])),h=this.profile.period?[0,this.profile.period]:[d,f];if(m.miss>1e-9*Math.max(V(i),1e-9)&&Number.isFinite(h[0])&&Number.isFinite(h[1])){let e=Array.from({length:65},(e,t)=>h[0]+(h[1]-h[0])*t/64).map(e=>({t:e,miss:Math.hypot(c(e).eh,c(e).er)})).sort((e,t)=>e.miss-t.miss).slice(0,3);for(let{t}of e){let e=p(t);e.miss<m.miss&&(m=e)}}let g=m.v,_=r(this.profile.at(g));return s<1e-12||V(_)<1e-12?[t?.[0]??0,g]:[qe(Math.atan2(z(B(_,o),n),z(_,o))),g]}steps(e,t,n){let r=0;for(let t of[e[2],(e[2]+e[3])/2,e[3]]){let e=L(this.profile.at(t),this.axisPoint);r=Math.max(r,V(L(e,R(this.axis,z(e,this.axis)))))}return[Ie(r,t,n),nt(this.profile,e[2],e[3],t,n)]}pole(){}singular(e,t){return V(this.at(e,t).slice(3,6))<1e-12}},it=class{constructor(e,t){this.profile=e,this.direction=t,this.vPeriod=0,this.vDomain=[-1/0,1/0],this.uPeriod=e.period,this.uDomain=e.domain}at(e,t){let n=this.profile.at(e);return[...I(n,R(this.direction,t)),...n.slice(3),...this.direction]}normal(e,t){return Ye(this,e,t)}parameters(e,t){let n=this.direction,r=z(n,n),i=this.profile.parameter(e,t?.[0]),a=z(L(e,this.profile.at(i)),n)/r;for(let t=0;t<3;t++)i=this.profile.parameter(L(e,R(n,a)),i),a=z(L(e,this.profile.at(i)),n)/r;return[i,a]}steps(e,t,n){return[nt(this.profile,e[0],e[1],t,n),1/0]}pole(){}singular(){return!1}},at=32,ot=class{constructor(e,t,n){this.s=e,this.uSamples=[],this.vSamples=[],this.cell=0,this.rows=[0,0],this.lastU=NaN,this.lastV=NaN,this.last=/* @__PURE__ */ new Float64Array(9),this.uDomain=[e.uKnots[e.uDegree],e.uKnots[e.nu]],this.vDomain=[e.vKnots[e.vDegree],e.vKnots[e.nv]],this.uBreaks=Ee(e.uKnots,e.uDegree,e.nu-1),this.vBreaks=Ee(e.vKnots,e.vDegree,e.nv-1),this.uPeriod=t?this.uDomain[1]-this.uDomain[0]:0,this.vPeriod=n?this.vDomain[1]-this.vDomain[0]:0;let r=1/0,i=-1/0;for(let t=0;t<e.points.length;t+=4)for(let n=0;n<3;n++){let a=e.points[t+n]/e.points[t+3];r=Math.min(r,a),i=Math.max(i,a)}this.size=Math.max(i-r,1e-12)}fit(e,t,n){let r=t[0];return n?r+((e-r)%n+n)%n:Math.min(t[1],Math.max(r,e))}at(e,t){let n=this.last;if(e===this.lastU&&t===this.lastV)return[n[0],n[1],n[2],n[3],n[4],n[5],n[6],n[7],n[8]];let r=we(this.s,this.fit(e,this.uDomain,this.uPeriod),this.fit(t,this.vDomain,this.vPeriod));return this.lastU=e,this.lastV=t,n.set(r),r}normal(e,t){return Ye(this,e,t)}parameters(e,t){if(this.grid(),t){let n=this.newton(e,t[0],t[1]),r=!this.singular(t[0],t[1])&&!this.singular(n.uv[0],n.uv[1]);return this.offPole(e,r&&n.along<=this.cell/4||n.miss<=1e-6*this.size?n:this.nearest(e,n,!1)).uv}return this.offPole(e,this.nearest(e,{uv:[this.uDomain[0],this.vDomain[0]],miss:1/0,along:1/0},!0)).uv}offPole(e,t){if(!(t.miss>1e-12*this.size))return t;let n=this.at(t.uv[0],t.uv[1]).slice(0,3);for(let r of this.poleRows??=this.findPoleRows()){if(!(H(n,r.point)<t.miss/2))continue;let i=L(e,r.point),a=V(i);if(!a)continue;let o=[];for(let e of r.inU?this.vSamples:this.uSamples){let t=r.inU?this.at(r.at,e):this.at(e,r.at),n=r.inU?t.slice(3,6):t.slice(6,9),s=V(n);s>0&&o.push({t:e,speed:s,lean:r.into*z(n,i)/(s*a)})}for(let{t:n,speed:i}of o.sort((e,t)=>t.lean-e.lean).slice(0,2)){let o=r.at+r.into*a/i,s=r.inU?this.newton(e,o,n):this.newton(e,n,o);s.miss<t.miss&&(t={...s,along:t.along})}}return t}findPoleRows(){let e=[];for(let t of[1,-1]){let n=this.pole(t),r=this.uPole(t),i=t>0?-1:1;n!==void 0&&e.push({inU:!1,at:n,into:i,point:this.at(this.uDomain[0],n).slice(0,3)}),r!==void 0&&e.push({inU:!0,at:r,into:i,point:this.at(r,this.vDomain[0]).slice(0,3)})}return e}grid(){if(this.seeds)return;let e=(e,t)=>{let n=[],r=Math.max(1,Math.min(4,Math.floor(48/Math.max(1,e.length-1))));t||n.push(e[0]);for(let t=1;t<e.length;t++)for(let i=0;i<r;i++)n.push(e[t-1]+(e[t]-e[t-1])*(i+.5)/r);return t||n.push(e[e.length-1]),n},t=e(this.uBreaks,this.uPeriod>0),n=e(this.vBreaks,this.vPeriod>0);this.seeds=t.flatMap(e=>n.map(t=>({u:e,v:t,p:this.at(e,t)}))),this.uSamples=t,this.vSamples=n,this.rows=[t.length,n.length];let r=0;for(let e=0;e<t.length;e++)for(let i=0;i<n.length;i++){let a=this.seeds[e*n.length+i].p;e+1<t.length&&(r=Math.max(r,H(a,this.seeds[(e+1)*n.length+i].p))),i+1<n.length&&(r=Math.max(r,H(a,this.seeds[e*n.length+i+1].p)))}this.cell=r}nearest(e,t,n){this.grid();let r=this.seeds,[i,a]=this.rows,o=new Float64Array(r.length),s=0;for(let t=0;t<r.length;t++)o[t]=H(r[t].p,e),o[t]<o[s]&&(s=t);let c=this.newton(e,r[s].u,r[s].v);if(c.miss<t.miss&&(t=c),t.miss<1e-9*this.size||!n&&t.miss<=.001*this.size)return t;let l=(e,t)=>(this.uPeriod&&(e=(e+i)%i),this.vPeriod&&(t=(t+a)%a),e<0||e>=i||t<0||t>=a?-1:e*a+t),u=(e,t)=>{let n=l(e,t);return n<0?1/0:o[n]},d=/* @__PURE__ */ new Set,f=Math.floor(s/a),p=s%a;for(let e=0;e<i;e++)for(let t=0;t<a;t++){let n=o[e*a+t];n<=u(e-1,t)&&n<=u(e+1,t)&&n<=u(e,t-1)&&n<=u(e,t+1)&&d.add(e*a+t)}for(let[e,t]of n?[[f-1,p],[f+1,p],[f,p-1],[f,p+1]]:[]){let n=l(e,t);n>=0&&d.add(n)}d.delete(s);for(let n of[...d].sort((e,t)=>o[e]-o[t]).slice(0,at)){if(t.miss<1e-9*this.size||o[n]>t.miss+this.cell)break;let i=this.newton(e,r[n].u,r[n].v);i.miss<t.miss&&(t=i)}return t}newton(e,t,n){let r=1/0,i;for(let a=0;a<50;a++){let o=this.at(t,n),s=L(o,e),c=o.slice(3,6),l=o.slice(6,9),u=z(c,c),d=z(c,l),f=z(l,l),p=z(c,s),m=z(l,s),h=u*f-d*d;if(a===0){let e=U(B(c,l));r=V(e?L(s,R(e,z(s,e))):s)}if(V(s)<1e-12*this.size||i&&H(o,i)<1e-12*this.size)break;if(i=o,!(h>1e-30*(u*f||1))){if(u>0)t=this.fit(t-p/u,this.uDomain,this.uPeriod);else if(f>0)n=this.fit(n-m/f,this.vDomain,this.vPeriod);else break;continue}let g=t+(-f*p+d*m)/h,_=n+(d*p-u*m)/h,v=this.fit(g,this.uDomain,this.uPeriod),y=this.fit(_,this.vDomain,this.vPeriod),b=u>0?this.fit(t-p/u,this.uDomain,this.uPeriod):t,x=f>0?this.fit(n-m/f,this.vDomain,this.vPeriod):n;v!==g&&y===_?[t,n]=[v,x]:y!==_&&v===g?[t,n]=[b,y]:v!==g&&y!==_&&!this.uPeriod&&!this.vPeriod?[t,n]=H(this.at(v,x),e)<=H(this.at(b,y),e)?[v,x]:[b,y]:[t,n]=[v,y]}return{uv:[t,n],miss:H(this.at(t,n),e),along:r}}breaks(){return[this.uBreaks,this.vBreaks]}steps(e){let t=(e,t,n,r)=>{let i=1/0;for(let t=1;t<e.length;t++)e[t]>n&&e[t-1]<r&&(i=Math.min(i,e[t]-e[t-1]));return i/(t+1)};return[t(this.uBreaks,this.s.uDegree,e[0],e[1]),t(this.vBreaks,this.s.vDegree,e[2],e[3])]}pole(e){let t=e>0?this.s.nv-1:0,n=[0,1,2].map(e=>this.s.points[t*4+e]/this.s.points[t*4+3]);for(let e=1;e<this.s.nu;e++){let r=(e*this.s.nv+t)*4;if(H([0,1,2].map(e=>this.s.points[r+e]/this.s.points[r+3]),n)>1e-9*this.size)return}return e>0?this.vDomain[1]:this.vDomain[0]}uPole(e){let t=e>0?this.s.nu-1:0,n=e=>[0,1,2].map(n=>this.s.points[(t*this.s.nv+e)*4+n]/this.s.points[(t*this.s.nv+e)*4+3]),r=n(0);for(let e=1;e<this.s.nv;e++)if(H(n(e),r)>1e-9*this.size)return;return e>0?this.uDomain[1]:this.uDomain[0]}singular(e,t){let n=this.at(e,t);return V(n.slice(3,6))<1e-9*this.size||V(n.slice(6,9))<1e-9*this.size}},st=class{constructor(e,t){this.basis=e,this.distance=t,this.uPeriod=e.uPeriod,this.vPeriod=e.vPeriod,this.uDomain=e.uDomain,this.vDomain=e.vDomain}point(e,t){return I(this.basis.at(e,t).slice(0,3),R(this.basis.normal(e,t),this.distance))}at(e,t){let n=1e-6,r=L(this.point(e+n,t),this.point(e-n,t)),i=L(this.point(e,t+n),this.point(e,t-n));return[...this.point(e,t),...R(r,.5/n),...R(i,.5/n)]}normal(e,t){return this.basis.normal(e,t)}parameters(e,t){let n=this.basis.parameters(e,t);for(let t=0;t<3;t++)n=this.basis.parameters(L(e,R(this.basis.normal(n[0],n[1]),this.distance)),n);return n}steps(e,t,n){return this.basis.steps(e,t,n)}pole(e){return this.basis.pole(e)}singular(e,t){return this.basis.singular(e,t)}breaks(){return this.basis.breaks?.()??[[],[]]}};function ct(e,t){let n=e.get(t),i=n.parts?n.parts.get(`B_SPLINE_SURFACE`):n.args.slice(1,8),a=n.parts?n.parts.get(`B_SPLINE_SURFACE_WITH_KNOTS`):n.args.slice(8,13),o=n.parts?.get(`RATIONAL_B_SPLINE_SURFACE`);if(!i||!a)throw je(e,t,`B-spline surface (knots implied, not listed)`);let s=K(i[0]),c=K(i[1]),l=q(i[2]).map(t=>q(t).map(t=>Me(e,G(t)))),u=l.length,d=l[0]?.length??0,f=o?q(o[0]).map(e=>q(e).map(e=>K(e,1))):void 0,p=P(q(a[2]).map(e=>K(e)),q(a[0]).map(e=>K(e))),m=P(q(a[3]).map(e=>K(e)),q(a[1]).map(e=>K(e)));if(!u||!d||l.some(e=>e.length!==d)||p.length!==u+s+1||m.length!==d+c+1||s<1||c<1)throw TypeError(`Invalid STEP file: #${t} B-spline surface knots do not match its control net and degrees; export it again from the CAD tool`);let h=new Float64Array(u*d*4);for(let e=0;e<u;e++)for(let t=0;t<d;t++){let n=l[e][t],r=f?.[e]?.[t]??1;h.set([n[0]*r,n[1]*r,n[2]*r,r],(e*d+t)*4)}let g=e=>e instanceof r&&e.name===`T`,_=ke(l.flat()),v=1e-9*Math.max(_,1e-30),y=Te(p,s)&&l[0].every((e,t)=>H(e,l[u-1][t])<=v),b=Te(m,c)&&l.every(e=>H(e[0],e[d-1])<=v);return new ot({uDegree:s,vDegree:c,nu:u,nv:d,points:h,uKnots:p,vKnots:m},g(i[4])||y,g(i[5])||b)}function lt(e,t,n,r){let i=e.get(t),a=i.parts?i.parts.has(`B_SPLINE_SURFACE`)?`B_SPLINE_SURFACE_WITH_KNOTS`:``:i.type,o=i.args;switch(a){case`PLANE`:return new Qe(Fe(e,G(o[1])));case`CYLINDRICAL_SURFACE`:return new $e(Fe(e,G(o[1])),K(o[2]),0);case`CONICAL_SURFACE`:if(!(n>0))throw TypeError(`#${t}: a cone's angle, and the file's context gives no angle unit; add a plane-angle unit to the representation context`);return new $e(Fe(e,G(o[1])),K(o[2]),K(o[3])*n);case`SPHERICAL_SURFACE`:return new et(Fe(e,G(o[1])),K(o[2]));case`TOROIDAL_SURFACE`:case`DEGENERATE_TOROIDAL_SURFACE`:return new tt(Fe(e,G(o[1])),K(o[2]),K(o[3]));case`SURFACE_OF_REVOLUTION`:{let n=G(o[2]);if(n===void 0||!e.is(n,`AXIS1_PLACEMENT`))throw je(e,t,`surface`);let[,i,a]=e.args(n,`AXIS1_PLACEMENT`);return new rt(r(G(o[1])??-1),Me(e,G(i)),G(a)===void 0?[0,0,1]:Ne(e,G(a)))}case`SURFACE_OF_LINEAR_EXTRUSION`:return new it(r(G(o[1])??-1),Pe(e,G(o[2])));case`B_SPLINE_SURFACE_WITH_KNOTS`:return ct(e,t);case`OFFSET_SURFACE`:return new st(lt(e,G(o[1])??-1,n,r),K(o[2]));case`RECTANGULAR_TRIMMED_SURFACE`:return lt(e,G(o[1])??-1,n,r);default:throw je(e,t,`surface`)}}var ut=2**-53,dt=2**27+1,ft=(3+16*ut)*ut,pt=(10+96*ut)*ut;function mt(e,t){let n=e*t,r=dt*e,i=r-(r-e),a=e-i;r=dt*t;let o=r-(r-t),s=t-o,c=a*s-(n-i*o-a*o-i*s);return c===0?n===0?[]:[n]:[c,n]}function ht(e,t){let n=e-t,r=e-n,i=e-(n+r)+(r-t);return i===0?n===0?[]:[n]:[i,n]}function gt(e,t){if(e.length===0)return t;if(t.length===0)return e;let n=[],r=0,i=0;for(;r<e.length&&i<t.length;)n.push(Math.abs(t[i])<Math.abs(e[r])?t[i++]:e[r++]);for(;r<e.length;)n.push(e[r++]);for(;i<t.length;)n.push(t[i++]);let a=[],o=n[0];for(let e=1;e<n.length;e++){let t=n[e],r=o+t,i=r-o,s=o-(r-i)+(t-i);s!==0&&a.push(s),o=r}return o!==0&&a.push(o),a}function _t(e,t){let n=[];if(e.length===0||t===0)return n;let r=dt*t,i=r-(r-t),a=t-i,o=0;for(let s=0;s<e.length;s++){let c=e[s],l=c*t;r=dt*c;let u=r-(r-c),d=c-u,f=d*a-(l-u*i-d*i-u*a);if(s===0){f!==0&&n.push(f),o=l;continue}let p=o+f,m=p-o,h=o-(p-m)+(f-m);h!==0&&n.push(h),o=l+p,m=o-l,h=l-(o-m)+(p-m),h!==0&&n.push(h)}return o!==0&&n.push(o),n}function vt(e,t){let n=[];for(let r=0;r<t.length;r++)n=gt(n,_t(e,t[r]));return n}var yt=e=>e.map(e=>-e),bt=e=>e.length>0?e[e.length-1]:0;function xt(e,t,n,r,i,a){let o=gt(mt(e,r),yt(mt(t,n))),s=gt(mt(n,a),yt(mt(r,i))),c=gt(mt(i,t),yt(mt(a,e)));return bt(gt(gt(o,s),c))}function St(e,t,n,r,i,a,o,s){let c=ht(e,o),l=ht(t,s),u=ht(n,o),d=ht(r,s),f=ht(i,o),p=ht(a,s),m=gt(vt(u,p),yt(vt(f,d))),h=gt(vt(f,l),yt(vt(c,p))),g=gt(vt(c,d),yt(vt(u,l))),_=gt(vt(c,c),vt(l,l)),v=gt(vt(u,u),vt(d,d)),y=gt(vt(f,f),vt(p,p));return bt(gt(gt(vt(_,m),vt(v,h)),vt(y,g)))}function Ct(e,t,n,r,i,a){let o=(e-i)*(r-a),s=(t-a)*(n-i),c=o-s,l;if(o>0){if(s<=0)return c;l=o+s}else if(o<0){if(s>=0)return c;l=-o-s}else return c;let u=ft*l;return c>=u||-c>=u?c:xt(e,t,n,r,i,a)}function wt(e,t,n,r,i,a,o,s){let c=e-o,l=n-o,u=i-o,d=t-s,f=r-s,p=a-s,m=l*p,h=u*f,g=c*c+d*d,_=u*d,v=c*p,y=l*l+f*f,b=c*f,x=l*d,S=u*u+p*p,C=g*(m-h)+y*(_-v)+S*(b-x),w=pt*((Math.abs(m)+Math.abs(h))*g+(Math.abs(_)+Math.abs(v))*y+(Math.abs(b)+Math.abs(x))*S);return C>w||-C>w?C:St(e,t,n,r,i,a,o,s)}var Tt=1,Et=2,J=e=>e%3==2?e-2:e+1,Dt=e=>e%3==0?e+2:e-1,Ot=e=>e>0?1:e<0?-1:0,kt=class{constructor(e,t,n){this.nt=1,this.last=0,this.random=625341585,this.budget=0,this.x=e,this.real=t,this.tv=new Int32Array(3*n),this.tw=new Int32Array(3*n).fill(-1),this.fl=new Uint8Array(3*n),this.vh=new Int32Array(t+3).fill(-1);for(let e=0;e<3;e++)this.tv[e]=t+e,this.vh[t+e]=e}orient(e,t,n){let r=this.x;return Ct(r[2*e],r[2*e+1],r[2*t],r[2*t+1],r[2*n],r[2*n+1])}inCircle(e,t,n,r){let i=this.x;return wt(i[2*e],i[2*e+1],i[2*t],i[2*t+1],i[2*n],i[2*n+1],i[2*r],i[2*r+1])}link(e,t){this.tw[e]=t,t>=0&&(this.tw[t]=e)}locate(e){let{tv:t,tw:n}=this,r=this.last;for(let i=3*this.nt+64;i>0;i--){let i=this.random;i^=i<<13,i^=i>>>17,i^=i<<5,this.random=i;let a=(i>>>0)%3,o=-1,s=-1;for(let n=0;n<3;n++){let i=(a+n)%3,c=3*r+i,l=this.orient(t[c],t[J(c)],e);if(l<0){o=c;break}l===0&&(s=i)}if(o<0)return 4*r+(s<0?3:s);let c=n[o];if(c<0)break;r=c/3|0}return this.scan(e)}scan(e){let t=this.tv;for(let n=0;n<this.nt;n++){let r=-1,i=0;for(;i<3;i++){let a=3*n+i,o=this.orient(t[a],t[J(a)],e);if(o<0)break;o===0&&(r=i)}if(i===3)return 4*n+(r<0?3:r)}throw RangeError(`triangulate: point ${e} fell outside the bounding triangle; pass coordinates of moderate size`)}insert(e){let t=this.locate(e),n=t>>2,r=t&3;r===3?this.splitTriangle(n,e):this.splitEdge(3*n+r,e)}splitTriangle(e,t){let{tv:n,tw:r,fl:i,vh:a}=this,o=3*e,s=o+1,c=o+2,l=n[o],u=n[s],d=n[c],f=3*this.nt++,p=3*this.nt++;n[f]=u,n[f+1]=d,n[f+2]=t,n[p]=d,n[p+1]=l,n[p+2]=t,this.link(f,r[s]),i[f]=i[s],this.link(p,r[c]),i[p]=i[c],n[c]=t,this.link(s,f+2),this.link(f+1,p+2),this.link(p+1,c),i[s]=i[c]=i[f+1]=i[f+2]=i[p+1]=i[p+2]=0,a[l]=o,a[u]=f,a[d]=p,a[t]=c,this.last=e,this.legalize([o,f,p],!1)}splitEdge(e,t){let{tv:n,tw:r,fl:i,vh:a}=this,o=r[e],s=J(e),c=Dt(e),l=J(o),u=Dt(o),d=n[e],f=n[s],p=n[c],m=n[u],h=i[e],g=3*this.nt++,_=3*this.nt++;n[g]=d,n[g+1]=t,n[g+2]=p,n[_]=f,n[_+1]=t,n[_+2]=m,this.link(g+2,r[c]),i[g+2]=i[c],this.link(_+2,r[u]),i[_+2]=i[u],n[e]=t,n[o]=t,this.link(e,_),this.link(o,g),this.link(c,g+1),this.link(u,_+1),i[e]=i[_]=i[o]=i[g]=h,i[c]=i[g+1]=i[u]=i[_+1]=0,a[t]=e,a[d]=g,a[f]=s,a[p]=c,a[m]=u,this.last=e/3|0,this.legalize([s,l,g+2,_+2],!1)}flip(e){let{tv:t,tw:n,fl:r,vh:i}=this,a=n[e],o=J(e),s=Dt(e),c=J(a),l=Dt(a),u=t[e],d=t[a],f=t[s],p=t[l],m=n[c],h=n[o],g=r[c],_=r[o];t[o]=p,t[c]=f,this.link(e,m),r[e]=g,this.link(a,h),r[a]=_,this.link(o,c),r[o]=r[c]=0,i[u]=e,i[d]=a,i[f]=s,i[p]=l}legalize(e,t){let{tv:n,tw:r,fl:i}=this;for(;e.length>0;){let a=e.pop(),o=r[a];if(!(o<0||i[a]&Tt)&&!(this.inCircle(n[a],n[J(a)],n[Dt(a)],n[Dt(o)])<=0)){if(--this.budget<0)throw RangeError(`triangulate: gave up after too many edge flips; the input is pathological (check for self-intersecting loops or extreme coordinates)`);this.flip(a),e.push(a,Dt(o)),t&&e.push(Dt(a),o)}}}find(e,t){let{tv:n,tw:r}=this,i=this.vh[e],a=i;do{if(n[J(a)]===t)return a;a=r[Dt(a)]}while(a>=0&&a!==i);if(a<0){for(let e=r[i];e>=0&&(a=J(e),a!==i);e=r[a])if(n[J(a)]===t)return a}return-1}edge(e,t){return e<this.real?this.find(e,t):this.tw[this.find(t,e)]}ahead(e,t,n){let r=this.x;return Ot(r[2*n]-r[2*e])*Ot(r[2*t]-r[2*e])>=0&&Ot(r[2*n+1]-r[2*e+1])*Ot(r[2*t+1]-r[2*e+1])>=0}crosses(e,t,n,r){return Ot(this.orient(n,r,e))*Ot(this.orient(n,r,t))<0&&Ot(this.orient(e,t,n))*Ot(this.orient(e,t,r))<0}constrain(e,t,n){let{tw:r,fl:i}=this;for(let a=this.real;e!==t;a--){if(a<0)throw RangeError(`triangulate: boundary edge ${e}-${t} could not be recovered; report this input`);let o=this.recover(e,t,n),s=this.find(e,o),c=r[s];i[s]=(i[s]|Tt)^Et,i[c]=(i[c]|Tt)^Et,e=o}}recover(e,t,n){let{tv:r,tw:i,fl:a}=this,o=this.vh[e],s=o,c=-1;do{let n=r[J(s)];if(n===t)return t;let a=this.orient(e,t,n);if(a===0&&this.ahead(e,t,n))return n;if(a<0&&this.orient(e,t,r[Dt(s)])>0){c=J(s);break}s=i[Dt(s)]}while(s>=0&&s!==o);if(c<0)throw RangeError(`triangulate: boundary edge ${e}-${t} could not be started; report this input`);let l=[],u=-1;for(let n=this.nt;;n--){if(n<0)throw RangeError(`triangulate: boundary edge ${e}-${t} could not be followed; report this input`);if(a[c]&Tt)throw TypeError(`triangulate: boundary edges ${e}-${t} and ${r[c]}-${r[J(c)]} cross; loops may share points but must not intersect`);l.push(r[c],r[J(c)]);let o=i[c],s=r[Dt(o)];if(s===t){u=t;break}let d=this.orient(e,t,s);if(d===0){u=s;break}c=d>0?J(o):Dt(o)}let d=l.length/2,f=1e4+64*d*d;for(let a=0;a<l.length;a+=2){if(--f<0)throw RangeError(`triangulate: boundary edge ${e}-${t} needs too many flips; the input is pathological (check for self-intersecting loops)`);let o=l[a],s=l[a+1],c=this.edge(o,s),d=i[c],p=r[Dt(c)],m=r[Dt(d)];Ot(this.orient(p,m,o))*Ot(this.orient(p,m,s))>=0?l.push(o,s):(this.flip(c),this.crosses(p,m,e,u)&&l.push(p,m),n.push(c,J(c),Dt(c),d,Dt(d)))}return u}};function At(e,t){let n=e,r=t,i=0;for(let e=32768;e>0;e>>=1){let t=n&e?1:0,a=r&e?1:0;if(i+=e*e*(3*t^a),a===0){t===1&&(n=65535-n,r=65535-r);let e=n;n=r,r=e}}return i}function jt(e,t,n){let r=e.length,i=1831565813;for(let t=r-1;t>0;t--){i^=i<<13,i^=i>>>17,i^=i<<5;let n=(i>>>0)%(t+1),r=e[t];e[t]=e[n],e[n]=r}let[a,o,s,c]=n,l=s>a?65536/(s-a):0,u=c>o?65536/(c-o):0,d=new Float64Array(t.length/2);for(let n=0;n<r;n++){let r=e[n];d[r]=At(Math.min(65535,Math.floor((t[2*r]-a)*l)),Math.min(65535,Math.floor((t[2*r+1]-o)*u)))}for(let t=r;t>0;){let n=t>64?t>>1:0;e.subarray(n,t).sort((e,t)=>d[e]-d[t]||e-t),t=n}return e}function Mt(e,t){if(!e||typeof e.length!=`number`||e.length%2!=0)throw TypeError(`triangulate: xy must hold interleaved x, y coordinates; pass an even count of numbers`);if(!t||typeof t.length!=`number`)throw TypeError(`triangulate: loops must be an array of point-index arrays; pass [] for no boundary`);let n=e.length/2,r=new Float64Array(2*n+6),i=1/0,a=1/0,o=-1/0,s=-1/0;for(let t=0;t<n;t++){let n=e[2*t],c=e[2*t+1];if(!Number.isFinite(n)||!Number.isFinite(c))throw TypeError(`triangulate: point ${t} is (${n}, ${c}); pass finite coordinates`);r[2*t]=n,r[2*t+1]=c,n<i&&(i=n),n>o&&(o=n),c<a&&(a=c),c>s&&(s=c)}let c=new Uint32Array(n);for(let e=0;e<n;e++)c[e]=e;c.sort((e,t)=>r[2*e]-r[2*t]||r[2*e+1]-r[2*t+1]||e-t);let l=new Uint32Array(n);for(let e=0;e<n;e++){let t=c[e],n=e>0?c[e-1]:t;l[t]=e>0&&r[2*t]===r[2*n]&&r[2*t+1]===r[2*n+1]?l[n]:t}let u=[],d=new Int32Array(n).fill(-1);for(let e=0;e<t.length;e++){let r=t[e];if(!r||typeof r.length!=`number`)throw TypeError(`triangulate: loop ${e} is not an array of point indices; pass one index array per loop`);let i=[],a=0;for(let t=0;t<r.length;t++){let o=r[t];if(!Number.isInteger(o))throw TypeError(`triangulate: loop ${e} entry ${t} is ${o}; pass integer indices`);if(o<0||o>=n)throw RangeError(`triangulate: loop ${e} entry ${t} is ${o}, but there are ${n} points; pass indices from 0 to ${n-1}`);let s=l[o];d[s]!==e&&(d[s]=e,a++),(i.length===0||i[i.length-1]!==s)&&i.push(s)}for(;i.length>1&&i[i.length-1]===i[0];)i.pop();if(a<3)throw TypeError(`triangulate: loop ${e} has ${a} distinct point(s); a boundary loop needs at least 3, so drop or repair it`);u.push(i)}if(u.length===0)return/* @__PURE__ */ new Uint32Array;let f=(i+o)/2,p=(a+s)/2,m=Math.max(o-i,s-a,1e-9*(Math.abs(f)+Math.abs(p)));if(!(m>1e-60&&m<1e60&&Math.abs(f)+Math.abs(p)<1e60))throw RangeError(`triangulate: the points span ${m} around (${f}, ${p}); scale them to a moderate range (1e-60 to 1e60)`);r[2*n]=f-20*m,r[2*n+1]=p-10*m,r[2*n+2]=f+20*m,r[2*n+3]=p-10*m,r[2*n+4]=f,r[2*n+5]=p+20*m;let h=0;for(let e=0;e<n;e++)l[e]===e&&h++;let g=new Uint32Array(h);for(let e=0,t=0;e<n;e++)l[e]===e&&(g[t++]=e);let _=new kt(r,n,2*h+1);_.budget=64*(h+3)+1e4;for(let e of jt(g,r,[i,a,o,s]))_.insert(e);let v=[];for(let e of u)for(let t=0;t<e.length;t++)_.constrain(e[t],e[(t+1)%e.length],v);_.budget=64*(h+3)+4*v.length+1e4,_.legalize(v,!0);let{tv:y,tw:b,fl:x,nt:S}=_,C=new Int8Array(S).fill(-1),w=[_.vh[n]/3|0];for(C[w[0]]=0;w.length>0;){let e=w.pop();for(let t=0;t<3;t++){let n=3*e+t,r=b[n];if(r<0)continue;let i=r/3|0;C[i]>=0||(C[i]=C[e]^(x[n]&Et?1:0),w.push(i))}}let T=e=>C[e]===1&&y[3*e]<n&&y[3*e+1]<n&&y[3*e+2]<n,ee=0;for(let e=0;e<S;e++)T(e)&&ee++;let E=new Uint32Array(3*ee);for(let e=0,t=0;e<S;e++)T(e)&&(E[t++]=y[3*e],E[t++]=y[3*e+1],E[t++]=y[3*e+2]);return E}function Nt(e,t){if(e.length%3!=0)throw TypeError(`interiorEdges: triangles must hold 3 indices per triangle; pass what triangulate returns`);let n=0;for(let t=0;t<e.length;t++)e[t]>n&&(n=e[t]);for(let e of t)for(let t=0;t<e.length;t++)e[t]>n&&(n=e[t]);let r=n+1;if(r>67108864)throw RangeError(`interiorEdges: point index ${n} is too large; pass at most 67,108,864 points`);let i=(e,t)=>e<t?e*r+t:t*r+e,a=/* @__PURE__ */ new Set;for(let e of t)for(let t=0;t<e.length;t++)a.add(i(e[t],e[(t+1)%e.length]));let o=/* @__PURE__ */ new Map;for(let t=0;t<e.length;t++){let n=i(e[t],e[J(t)]);o.set(n,(o.get(n)??0)+1)}let s=[];for(let[e,t]of o)t===2&&!a.has(e)&&s.push(Math.floor(e/r),e%r);return new Uint32Array(s)}var Pt=e=>!(e instanceof r)||e.name!==`F`,Ft=class{constructor(e,t=/* @__PURE__ */ new Map,n={}){this.file=e,this.faceColors=t,this.options=n,this.curves=/* @__PURE__ */ new Map,this.surfaces=/* @__PURE__ */ new Map,this.edges=/* @__PURE__ */ new Map,this.rim=/* @__PURE__ */ new Set,this.through=/* @__PURE__ */ new Map,this.skewedOn=/* @__PURE__ */ new Map;let{relativeDeflection:r=.001,deflection:i,angle:a=.5,interiorDeflection:o,interiorAngle:s}=n,c=e=>e===void 0||e>0&&Number.isFinite(e);if(!(r>0&&r<1))throw RangeError(`relativeDeflection must be between 0 and 1, such as 0.001`);if(!c(i))throw RangeError(`deflection must be a positive number of metres`);if(!c(o))throw RangeError(`interiorDeflection must be a positive number of metres`);if(!c(n.minSize))throw RangeError(`minSize must be a positive number of metres`);if(!(a>0&&a<Math.PI))throw RangeError(`angle must be between 0 and pi radians, such as 0.5`);if(s!==void 0&&!(s>0&&s<Math.PI))throw RangeError(`interiorAngle must be between 0 and pi radians, such as 0.5`);let l=n.maxFaceVertices??5e4;if(!(Number.isSafeInteger(l)&&l>=64))throw RangeError(`maxFaceVertices must be an integer of at least 64`);this.turn=a,this.maxFaceVertices=l}curve(e){let t=this.curves.get(e);return t||this.curves.set(e,t=Ge(this.file,e)),t}surface(e,t){let n=this.surfaces.get(e);return n||this.surfaces.set(e,n=lt(this.file,e,t,e=>this.curve(e))),n}vertex(e){if(e===void 0||!this.file.is(e,`VERTEX_POINT`))throw TypeError(`Invalid STEP file: #${e} is not a vertex point; export it again from the CAD tool`);return Me(this.file,G(this.file.args(e,`VERTEX_POINT`)[1]))}edge(e,t){let n=this.edges.get(e);if(n)return n;let[,r,i,a,o]=this.file.args(e,`EDGE_CURVE`),s=this.vertex(G(r)),c=this.vertex(G(i)),l=G(r)===G(i)||H(s,c)<=t*.001,u=G(a),d=l?[s]:[s,c];if(u!==void 0){let n=this.curve(u),r=Pt(o),i=n.parameter(s),a;if(n.period){let e=((n.parameter(c)-i)%n.period+n.period)%n.period,t=l?n.period:r?e:(n.period-e)%n.period;a=r?i+t:i-t}else if(l){let[e,o]=n.domain;Number.isFinite(e)&&Number.isFinite(o)&&H(n.at(e),n.at(o))<=t&&(i=r?e:o,a=r?o:e)}else a=n.parameter(c);if(a!==void 0&&i!==a){let r=n.sample(i,a,t,this.turn),o=Math.min(i,a),l=Math.max(i,a),u=1e-9*(l-o);for(let t of this.through.get(e)??[])for(let e=-1;e<=1;e++){let s=t+e*n.period;if(s<=o+u||s>=l-u||e&&!n.period)continue;let c=r.findIndex(e=>a>i?e>=s:e<=s);c>0&&Math.abs(r[c]-s)>u&&Math.abs(r[c-1]-s)>u&&r.splice(c,0,s)}for(let i of this.skewedOn.get(e)??[])It(n,i,r,t);d=r.map(e=>n.at(e).slice(0,3)),d[0]=s,d[d.length-1]=c;let f=t*1e-4,p=[s];for(let e=1;e<d.length-1;e++)H(d[e],p[p.length-1])>f&&p.push(d[e]);for(;p.length>1&&H(p[p.length-1],c)<=f;)p.pop();p.push(c),d=p}}return this.edges.set(e,d),d}bound(e,t){let[,n,r]=this.file.get(e).args,i=G(n);if(i===void 0)throw TypeError(`Invalid STEP file: face bound #${e} has no loop; export it again from the CAD tool`);let a=this.file.get(i).type;if(a===`VERTEX_LOOP`)return{points:[],pole:this.vertex(G(this.file.get(i).args[1]))};let o=[];if(a===`POLY_LOOP`)o=q(this.file.get(i).args[1]).map(e=>Me(this.file,G(e)));else if(a===`EDGE_LOOP`)for(let e of q(this.file.args(i,`EDGE_LOOP`)[1])){let[,,,n,r]=this.file.args(G(e)??-1,`ORIENTED_EDGE`),i=this.edge(G(n)??-1,t),a=Pt(r)?i:[...i].reverse();for(let e=0;e<Math.max(1,a.length-1);e++)o.push(a[e])}else throw TypeError(`Unsupported STEP face bound: #${i} ${a}; export it again from the CAD tool`);return o=o.filter((e,t,n)=>n.length===1||H(e,n[(t+n.length-1)%n.length])>0),{points:Pt(r)?o:o.reverse()}}face(e,t,n,r=!1){let i=this.file.get(e).args,a=q(i[1]).map(e=>this.bound(G(e)??-1,n.edge)),o=G(i[2]),s=Pt(i[3]),c=o===void 0?Rt(a.find(e=>e.points.length>=3)?.points??[]):this.surface(o,t.angleUnit),l=s?1:-1,u=e=>c.uPeriod?c.uDomain[0]+((e-c.uDomain[0])%c.uPeriod+c.uPeriod)%c.uPeriod:e,d=e=>c.vPeriod?c.vDomain[0]+((e-c.vDomain[0])%c.vPeriod+c.vPeriod)%c.vPeriod:e,f=(e,t)=>c.at(u(e),d(t)),p=(e,t)=>f(e,t).slice(0,3),m=(e,t)=>c.normal(u(e),d(t)),h=n.edge*1e-4,g=[],_=[],v=[];for(let e of a){if(e.pole){v.push(e.pole);continue}if(e.points.length<3)continue;let t,n=e.points.map(e=>{let n=c.parameters(e,t);return t=n,{p:e,u:n[0],v:n[1],singular:Je(c,n[0],n[1],h)}}),r=n.filter(e=>!e.singular);if(!r.length){v.push(n[0].p);continue}let i=n.length,a=n.indexOf(r[0]),o=r.reduce((e,t)=>e+t.u,0)/r.length,s=r.reduce((e,t)=>e+t.v,0)/r.length,u=c.uPeriod*1e-9,d=c.vPeriod*1e-9,m=[],y=r[0].u,b=r[0].v;for(let e=0;e<i;){let t=n[(a+e)%i];if(!t.singular){let n=W(t.u,y,c.uPeriod),r=W(t.v,b,c.vPeriod),i=m[m.length-1];if(i&&c.uPeriod&&Math.abs(Math.abs(n-y)-c.uPeriod/2)<.001){let e=r+b>0?1:-1,a=c.pole(e);if(a!==void 0){let r=p(y,a),o=L(t.p,i.p),s=Math.max(0,Math.min(1,z(L(r,i.p),o)/(z(o,o)||1)));if(H(r,I(i.p,R(o,s)))<=.5*Math.hypot(...o)){let t=-e*l;t>0&&n<=y?n+=c.uPeriod:t<0&&n>=y&&(n-=c.uPeriod),m.push({p:r,u:y,v:a,line:!0},{p:r,u:n,v:a})}}}y=n,b=r,m.push({p:t.p,u:y,v:b}),e++;continue}let r=e+1;for(;r<i&&n[(a+r)%i].singular;)r++;let h=n[(a+r)%i],g=f(t.u,t.v);if(Math.hypot(g[6],g[7],g[8])<Math.hypot(g[3],g[4],g[5])){let n=W(t.u,y,c.uPeriod),i=(n>o?1:-1)*l,a=W(h.v,b,c.vPeriod);c.vPeriod&&(i>0&&a<=b+d?a+=c.vPeriod:i<0&&a>=b-d&&(a-=c.vPeriod)),Math.abs(a-b)>d?m.push({p:t.p,u:n,v:b,line:!0},{p:t.p,u:n,v:a}):m.push({p:t.p,u:n,v:b}),y=n,b=a,e=r;continue}let _=W(t.v,b,c.vPeriod),v=-(_>s?1:-1)*l,x=W(h.u,y,c.uPeriod);c.uPeriod&&(v>0&&x<=y+u?x+=c.uPeriod:v<0&&x>=y-u&&(x-=c.uPeriod)),Math.abs(x-y)>u?m.push({p:t.p,u:y,v:_,line:!0},{p:t.p,u:x,v:_}):m.push({p:t.p,u:y,v:_}),y=x,b=_,e=r}let x=c.uPeriod?Math.round((W(m[0].u,y,c.uPeriod)-m[0].u)/c.uPeriod):0,S=c.vPeriod?Math.round((W(m[0].v,b,c.vPeriod)-m[0].v)/c.vPeriod):0;x||S?_.push({points:m,ku:x,kv:S}):g.push(m)}let y=[];if(_.some(e=>e.ku&&e.kv))throw TypeError(`Unsupported STEP face #${e}: a bound wraps both ways round its surface; export the part again, or as AP242 tessellated geometry, to mesh this face`);let b=_.length>0&&!!_[0].kv,x=b?c.vPeriod:c.uPeriod,S=e=>b?e.v:e.u,C=e=>b?e.u:e.v,w=(e,t,n,r)=>b?{p:e,u:n,v:t,line:r}:{p:e,u:t,v:n,line:r},T=(t,n,r)=>{let i=b?t.kv:t.ku,a=t.points,o=a.length,s=i*x,c=-1,l=0,u=0,d=1/0;for(let e=0;e<o;e++){let t=a[e],i=a[(e+1)%o],f=S(t),p=S(i)+(e+1===o?s:0),m=W(n,(f+p)/2,x),h=x*1e-9;if(f===p||Math.min(m-Math.min(f,p),Math.max(f,p)-m)<-h||e+1<o&&Math.abs(m-p)<=h)continue;let g=Math.max(0,Math.min(1,(m-f)/(p-f))),_=r===void 0?0:Math.abs(C(t)+(C(i)-C(t))*g-r);if(_<d&&(d=_,c=e,l=g,u=m,r===void 0))break}if(c<0)throw TypeError(`STEP face #${e}: could not cut a wrapping bound at its seam; export the part again, or as AP242 tessellated geometry, to mesh this face`);let f=a[c],p=a[(c+1)%o],m=w(I(f.p,R(L(p.p,f.p),l)),u,C(f)+(C(p)-C(f))*l,f.line),h=[m];for(let e=1;e<=o;e++){let t=a[(c+e)%o];h.push(w(t.p,S(t)+(c+e>=o?s:0),C(t),t.line))}return h.push(w(m.p,u+s,C(m))),{run:Wt(h),k:i}},ee=e=>{let t=g.length?Ut(g.map(e=>{let t=e.map(S);return[Math.min(...t),Math.max(...t)]}),x):void 0;if(t===void 0)return S(e.points[0]);let n=S(e.points[0]),r=1/0;for(let i of e.points){let e=Math.abs(W(S(i),t,x)-t);e<r&&(r=e,n=S(i))}return n};if(_.length===2){if(Math.sign(b?_[1].kv:_[1].ku)===Math.sign(b?_[0].kv:_[0].ku)){let e=_[1].points;_[1]={points:e.map((t,n)=>({...e[e.length-1-n],line:e[(e.length-n)%e.length].line})),ku:-_[1].ku,kv:-_[1].kv}}let[e,t,n,r]=Ht(_[0].points,_[1].points,g,ee(_[0]),S,C,x),i=T(_[0],e,t),a=T(_[1],n,r),o=i.run[i.run.length-1],s=Math.round((S(o)-S(a.run[0]))/x)*x,u=b?c.uPeriod:c.vPeriod,d=a.run.map(e=>w(e.p,S(e)+s,C(e),e.line));if(u){let e=Math.sign(Bt([...i.run,...d]));if(e&&e!==l){let e=C(d[0])<C(i.run[0])?u:-u;d=d.map(t=>w(t.p,S(t),C(t)+e,t.line))}}o.line=!0,d[d.length-1].line=!0,y.push([...i.run,...d])}else if(_.length===1&&b){let{run:t,k:n}=T(_[0],ee(_[0])),r=-Math.sign(n)*l,i=c.uPole?.(r)??(v.length?c.parameters(v[0],[t[0].u,t[0].v])[0]:void 0);if(i===void 0)throw TypeError(`STEP face #${e}: a bound wraps round a surface that does not close at a pole; export the part again, or as AP242 tessellated geometry, to mesh this face`);let a=t[0].v,o=t[t.length-1].v,s=v[0]??p(i,a);t[t.length-1].line=!0,y.push([...t,{p:s,u:i,v:o,line:!0},{p:s,u:i,v:a,line:!0}])}else if(_.length===1){let{run:t,k:n}=T(_[0],ee(_[0])),r=Math.sign(n)*l,i=c.pole(r);if(i===void 0&&v.length&&(i=c.parameters(v[0],[t[0].u,t[0].v])[1]),i===void 0)throw TypeError(`STEP face #${e}: a bound wraps round a surface that does not close at a pole; export the part again, or as AP242 tessellated geometry, to mesh this face`);let a=t[0].u,o=t[t.length-1].u,s=v[0]??p(a,i);t[t.length-1].line=!0,y.push([...t,{p:s,u:o,v:i,line:!0},{p:s,u:a,v:i,line:!0}])}else if(_.length>2)throw TypeError(`Unsupported STEP face #${e}: three or more bounds wrap round it; export the part again, or as AP242 tessellated geometry, to mesh this face`);g.sort((e,t)=>Vt(t)-Vt(e));let E=!y.length&&g.length>0&&g.every(e=>Math.sign(Bt(e))===-l)&&!!c.uPeriod&&(!!c.vPeriod||c.pole(-1)!==void 0&&c.pole(1)!==void 0);if(!y.length&&(!g.length||E)){let t=g.map(zt),n=(n,r,i)=>{if(!t.length)return r;let a=Ut(t.map(e=>[e[i],e[i+1]]),n);if(a===void 0)throw TypeError(`STEP face #${e}: its holes cover a whole period of its surface; export the part again, or as AP242 tessellated geometry, to mesh this face`);return a},r=c.uPeriod?n(c.uPeriod,c.uDomain[0],0):c.uDomain[0],i=c.uPeriod?r+c.uPeriod:c.uDomain[1],a=c.vPeriod?n(c.vPeriod,c.vDomain[0],2):c.vDomain[0],o=c.vPeriod?a+c.vPeriod:c.vDomain[1];if(![r,i,a,o].every(Number.isFinite))throw TypeError(`Invalid STEP file: face #${e} has no bounds on an unbounded surface; export it again from the CAD tool`);let s=(e,t)=>({p:p(e,t),u:e,v:t,line:!0}),l=[s(r,a),s(i,a),s(i,o),s(r,o)];c.pole(-1)!==void 0&&H(l[0].p,l[1].p)<=h&&(l[1].p=l[0].p),c.pole(1)!==void 0&&H(l[2].p,l[3].p)<=h&&(l[3].p=l[2].p),y.push(l)}g.sort((e,t)=>Vt(t)-Vt(e));let te=y[0]??g[0],ne=zt(te);for(let e of g){if(e===te){y.push(e);continue}let t=zt(e),n=c.uPeriod?W((t[0]+t[1])/2,(ne[0]+ne[1])/2,c.uPeriod)-(t[0]+t[1])/2:0,r=c.vPeriod?W((t[2]+t[3])/2,(ne[2]+ne[3])/2,c.vPeriod)-(t[2]+t[3])/2:0;y.push(n||r?e.map(e=>({...e,u:e.u+n,v:e.v+r})):e)}let D=zt(y.flat()),re=f((D[0]+D[1])/2,(D[2]+D[3])/2),ie=Math.hypot(re[3],re[4],re[5])||1,ae=Lt(c),O=ae!==void 0,k=e=>ae?ae.turn(e):0,A=(O?(e=>{let t=(e[3]*e[6]+e[4]*e[7]+e[5]*e[8])/(e[3]*e[3]+e[4]*e[4]+e[5]*e[5]||1);return Math.hypot(e[6]-t*e[3],e[7]-t*e[4],e[8]-t*e[5])})(re):Math.hypot(re[6],re[7],re[8]))||1,[j,M]=c.steps(D,n.interior,n.interiorAngle),oe=e=>{let t=1e-9*(D[1]-D[0]),n=1e-9*(D[3]-D[2]);return e.u>D[0]+t&&e.u<D[1]-t&&e.v>D[2]+n&&e.v<D[3]-n},se=y.length>1||y.some(e=>e.some(oe)),ce=1,le=1;se&&Number.isFinite(j)!==Number.isFinite(M)&&(Number.isFinite(j)?(j*=.7,M=Math.max((D[3]-D[2])/8,j*ie/A),le=j*ie/(M*A)):(M*=.7,j=Math.max((D[1]-D[0])/8,M*A/ie),ce=M*A/(j*ie)));let ue=e=>ae?ae.along(e):e,de=e=>{if(!O)return Gt(e,ie*ce,A*le);let t=[];for(let n=0;n<e.length;n+=2)t.push((e[n]+k(e[n+1]))*ie*ce,ue(e[n+1])*le);return t},fe=e=>{let t=0,n=0;if(!O){for(let r of e)t+=N[r*2],n+=N[r*2+1];return[t/e.length,n/e.length]}for(let r of e)t+=N[r*2]+k(N[r*2+1]),n+=ue(N[r*2+1]);let r=ae?ae.at(n/e.length):n/e.length;return[t/e.length-k(r),r]},N=[],P=[],pe=[],me=/* @__PURE__ */ new Map,he=e=>`${Math.round(u(e.u)*1e8)},${Math.round(d(e.v)*1e8)}`,ge=Math.max(h,1e-300)*4,_e=/* @__PURE__ */ new Map,ve=e=>e.map(e=>Math.floor(e/ge)),ye=e=>{let[t,n,r]=ve(e);for(let i=-1;i<=1;i++)for(let a=-1;a<=1;a++)for(let o=-1;o<=1;o++)for(let s of _e.get(`${t+i},${n+a},${r+o}`)??[])if(H(e,s)<=h)return s;return e};for(let e of a)for(let t of e.points){let e=ve(t).join(`,`),n=_e.get(e);n?n.push(t):_e.set(e,[t])}for(let e of y){let t=[],n=(e,n,r)=>{t.push(N.length/2),N.push(n,r),P.push(ye(e))};e.forEach((t,r)=>{if(n(t.p,t.u,t.v),!t.line)return;let i=e[(r+1)%e.length],a=Math.min(1024,Math.ceil(Math.max(Math.abs(i.u-t.u)/j,Math.abs(i.v-t.v)/M)-1e-9));if(!(a>1))return;let o=he(t),s=he(i),c=o<s||o===s&&i.u-t.u+(i.v-t.v)>=0,l=c?`${o};${s};${a}`:`${s};${o};${a}`,u=me.get(l);if(!u){let[e,n]=c?[t,i]:[i,t],r=H(t.p,i.p)<=h&&H(p((t.u+i.u)/2,(t.v+i.v)/2),t.p)<=h;u=[];for(let i=1;i<a;i++)u.push(r?t.p:p(e.u+(n.u-e.u)*i/a,e.v+(n.v-e.v)*i/a));me.set(l,u)}for(let e=1;e<a;e++)n(u[c?e-1:a-1-e],t.u+(i.u-t.u)*e/a,t.v+(i.v-t.v)*e/a)}),pe.push(t)}let be=N.length/2;if(Number.isFinite(j)&&Number.isFinite(M)&&j>0&&M>0){let e=D[1]-D[0],t=D[3]-D[2],n=this.maxFaceVertices/4;for(;e/j*(t/M)>n;)j*=1.5,M*=1.5;let r=Kt(de(N),pe,.3*Math.min(j*ie*ce,O?(ue(D[3])-ue(D[2]))*M*le/t:M*A*le)),[i,a]=O?[ue(D[2]),ue(D[3])]:[D[2],D[3]],o=O?(a-i)*M/t:M,s=e=>ae?ae.at(e):e;for(let e=D[0]+j/2;e<D[1];e+=j)for(let t=i+o/2;t<a;t+=o){let n=s(t);(O?r((e+k(n))*ie*ce,t*le):r(e*ie*ce,n*A*le))||(N.push(e,n),P.push(p(e,n)))}}let F=Mt(de(N),pe);for(let e=0;e<6&&N.length/2<this.maxFaceVertices;e++){let e=[],t=/* @__PURE__ */ new Set,r=Nt(F,pe);for(let i=0;i<r.length;i+=2){let a=r[i],o=r[i+1];if(H(P[a],P[o])<n.minSize*2)continue;let[s,c]=fe([a,o]),l=H(f(s,c),R(I(P[a],P[o]),.5))>n.interior||Oe(m(N[a*2],N[a*2+1]),m(N[o*2],N[o*2+1]))>n.interiorAngle,u=`${s},${c}`;l&&!t.has(u)&&(t.add(u),e.push(s,c))}for(let r=0;r<F.length;r+=3){let i=F[r],a=F[r+1],o=F[r+2],s=H(P[i],P[a]),c=H(P[a],P[o]),l=H(P[o],P[i]);if(Math.min(s,c,l)<=h||Math.max(s,c,l)<n.minSize*2)continue;let[u,d]=fe([i,a,o]),p=R(I(I(P[i],P[a]),P[o]),1/3);if(H(f(u,d),p)<=n.interior)continue;let m=`${u},${d}`;t.has(m)||(t.add(m),e.push(u,d))}if(!e.length)break;for(let t=0;t<e.length&&N.length/2<this.maxFaceVertices;t+=2)N.push(e[t],e[t+1]),P.push(p(e[t],e[t+1]));F=Mt(de(N),pe)}let xe=/* @__PURE__ */ new Map,Se=e=>{let t=xe.get(e);return t===void 0&&xe.set(e,t=`${P[e][0]},${P[e][1]},${P[e][2]}`),t},Ce=e=>F[e]<be&&F[e+1]<be&&F[e+2]<be?[Se(F[e]),Se(F[e+1]),Se(F[e+2])].sort().join(`;`):void 0;for(let e=0;e<3&&this.rim.size;e++){let e=[];for(let t=0;t<F.length;t+=3){let n=Ce(t);if(n===void 0||!this.rim.has(n))continue;let[r,i,a]=[F[t],F[t+1],F[t+2]];e.push((N[r*2]+N[i*2]+N[a*2])/3,(N[r*2+1]+N[i*2+1]+N[a*2+1])/3)}if(!e.length)break;for(let t=0;t<e.length;t+=2)N.push(e[t],e[t+1]),P.push(p(e[t],e[t+1]));F=Mt(de(N),pe)}for(let e=0;e<F.length;e+=3){let t=Ce(e);t!==void 0&&this.rim.add(t)}if(P.some(e=>!Number.isFinite(e[0]+e[1]+e[2])))throw TypeError(`STEP face #${e}: its surface gave no point at some (u, v) of the face; export the part again, or as AP242 tessellated geometry, to mesh this face`);let we=s!==r,Te=N.length/2,Ee=[];for(let e=0;e<F.length;e+=3){let t=F[e],n=F[e+1],r=F[e+2];H(P[t],P[n])>h&&H(P[n],P[r])>h&&H(P[r],P[t])>h&&(we?Ee.push(t,n,r):Ee.push(t,r,n))}let B=new Int32Array(Te).fill(-1);for(let e of Ee)B[e]=0;let De=[],V=[],U=0;for(let e=0;e<Te;e++){if(B[e]<0)continue;B[e]=U++;let t=m(N[e*2],N[e*2+1]);De.push(P[e][0],P[e][1],P[e][2]),we?V.push(t[0],t[1],t[2]):V.push(-t[0],-t[1],-t[2])}return{positions:De,normals:V,indices:Ee.map(e=>B[e])}}tolerances(e){let t=this.options,n;if(t.deflection!==void 0)n=t.deflection/e.unit;else{let r=[1/0,1/0,1/0],i=[-1/0,-1/0,-1/0],a=e=>{for(let t=0;t<3;t++)r[t]=Math.min(r[t],e[t]),i[t]=Math.max(i[t],e[t])};for(let t of e.faces){let e=G(this.file.get(t).args[2]);if(e!==void 0&&this.file.has(e)){let t=this.file.get(e),n=t.type===`SPHERICAL_SURFACE`?Number(t.args[2]):t.type===`TOROIDAL_SURFACE`?Number(t.args[2])+Number(t.args[3]):NaN,r=G(t.args[1]);if(n>0&&r!==void 0&&this.file.has(r)){let e=Me(this.file,G(this.file.get(r).args[1]));a([e[0]-n,e[1]-n,e[2]-n]),a([e[0]+n,e[1]+n,e[2]+n])}}for(let e of q(this.file.get(t).args[1])){let t=G(this.file.get(G(e)??-1).args[1]);if(t===void 0)continue;let n=this.file.get(t).type;if(n===`VERTEX_LOOP`)a(this.vertex(G(this.file.get(t).args[1])));else if(n===`POLY_LOOP`)for(let e of q(this.file.get(t).args[1]))a(Me(this.file,G(e)));else if(n===`EDGE_LOOP`)for(let e of q(this.file.args(t,`EDGE_LOOP`)[1])){let t=G(this.file.args(G(e)??-1,`ORIENTED_EDGE`)[3]);if(t!==void 0)for(let e of this.file.args(t,`EDGE_CURVE`).slice(1,3))a(this.vertex(G(e)))}}}let o=H(r,i);n=(Number.isFinite(o)&&o>0?o:1)*(t.relativeDeflection??.001)}let r=t.interiorDeflection===void 0?n:t.interiorDeflection/e.unit;return{edge:n,interior:r,interiorAngle:t.interiorAngle??this.turn,minSize:t.minSize===void 0?Math.min(n,r)/10:t.minSize/e.unit}}findPoleCrossings(e,t){for(let n of e.faces){let r=G(this.file.get(n).args[2]);if(r===void 0)continue;let i;try{i=this.surface(r,e.angleUnit)}catch{continue}let a=[];for(let e of[1,-1]){let t=i.pole(e);t!==void 0&&a.push(i.at(i.uDomain[0],t).slice(0,3))}if(a.length||i.skewed)for(let e of q(this.file.get(n).args[1])){let n=G(this.file.get(G(e)??-1).args[1]);if(n!==void 0&&this.file.get(n).type===`EDGE_LOOP`)for(let e of q(this.file.args(n,`EDGE_LOOP`)[1])){let n=G(this.file.args(G(e)??-1,`ORIENTED_EDGE`)[3]),r=n===void 0?void 0:G(this.file.args(n,`EDGE_CURVE`)[3]);if(n===void 0||r===void 0||this.edges.has(n)||(i.skewed&&!this.skewedOn.get(n)?.includes(i)&&this.skewedOn.set(n,[...this.skewedOn.get(n)??[],i]),!a.length))continue;let o;try{o=this.curve(r)}catch{continue}for(let e of a){let r=o.parameter(e);H(o.at(r),e)<=t&&this.through.set(n,[...this.through.get(n)??[],r])}}}}}tessellatedBody(e){let t=this.file,n=[],r=[],i=[],a=[],o=[],s=t.get(e.id).type,c=s===`TESSELLATED_SOLID`||s===`TESSELLATED_SHELL`?q(t.get(e.id).args[1]).flatMap(e=>G(e)===void 0?[]:[G(e)]):[e.id],l=0,u=e=>q(e).map(e=>typeof e==`number`?e:NaN);for(let e of c)try{let o=t.get(e),s=o.args,c=o.type,d=c===`COMPLEX_TRIANGULATED_FACE`||c===`COMPLEX_TRIANGULATED_SURFACE_SET`,f=c===`TRIANGULATED_SURFACE_SET`||c===`COMPLEX_TRIANGULATED_SURFACE_SET`;if(!d&&c!==`TRIANGULATED_FACE`&&c!==`TRIANGULATED_SURFACE_SET`)throw TypeError(`Unsupported STEP tessellated item: #${e} ${c}; export it again from the CAD tool`);let p=q(t.args(G(s[1])??-1,`COORDINATES_LIST`)[2]).map(e=>q(e).map(e=>K(e))),m=q(s[3]).map(e=>q(e).map(e=>K(e))),h=u(s[f?4:5]),g=h.length?h.map(e=>p[e-1]):p;if(g.some(e=>!e||e.length!==3||!e.every(Number.isFinite)))throw TypeError(`Invalid STEP file: #${e} indexes outside its coordinates list; export it again from the CAD tool`);let _=[],v=(e,t,n)=>{l++,e!==t&&t!==n&&n!==e&&_.push(e-1,t-1,n-1)};if(d){for(let e of q(s[f?5:6]).map(u))for(let t=0;t+2<e.length;t++)t%2?v(e[t+1],e[t],e[t+2]):v(e[t],e[t+1],e[t+2]);for(let e of q(s[f?6:7]).map(u))for(let t=1;t+1<e.length;t++)v(e[0],e[t],e[t+1])}else for(let e of q(s[f?5:6]).map(u))v(e[0],e[1],e[2]);if(_.some(e=>!(e>=0&&e<g.length)))throw TypeError(`Invalid STEP file: #${e} has a triangle index outside its points; export it again from the CAD tool`);let y=n.length/3,b=i.length,x=new Float64Array(g.length*3);if(m.length===g.length)m.forEach((e,t)=>x.set(e,t*3));else if(m.length===1)for(let e=0;e<g.length;e++)x.set(m[0],e*3);else for(let e=0;e<_.length;e+=3){let[t,n,r]=[_[e],_[e+1],_[e+2]].map(e=>g[e]),i=B(L(n,t),L(r,t));for(let t of[_[e],_[e+1],_[e+2]])for(let e=0;e<3;e++)x[t*3+e]+=i[e]}for(let e=0;e<g.length;e++){let t=U([x[e*3],x[e*3+1],x[e*3+2]])??[0,0,1];n.push(g[e][0],g[e][1],g[e][2]),r.push(t[0],t[1],t[2])}for(let e of _)i.push(y+e);let S=this.faceColors.get(e);a.push({id:e,first:b,count:_.length,...S?{color:S}:{}})}catch(t){o.push({id:e,reason:t instanceof Error?t.message:String(t)})}return{id:e.id,positions:Float32Array.from(n),normals:Float32Array.from(r),indices:Uint32Array.from(i),faces:a,failures:o,unit:e.unit,deflection:0,facets:l}}body(e){if(e.kind===`tessellated`)return this.tessellatedBody(e);let t=this.tolerances(e),n=[],r=[],i=[],a=[],o=[];this.findPoleCrossings(e,t.edge*.001),this.rim=/* @__PURE__ */ new Set;let s=new Set(e.reversed);for(let c of e.faces){let l;try{l=this.face(c,e,t,s.has(c))}catch(e){o.push({id:c,reason:e instanceof Error?e.message:String(e)});continue}let u=n.length/3,d=i.length;for(let e of l.positions)n.push(e);for(let e of l.normals)r.push(e);for(let e of l.indices)i.push(u+e);let f=this.faceColors.get(c);a.push({id:c,first:d,count:l.indices.length,...f?{color:f}:{}})}return{id:e.id,positions:Float32Array.from(n),normals:Float32Array.from(r),indices:Uint32Array.from(i),faces:a,failures:o,unit:e.unit,deflection:t.edge}}};function It(e,t,n,r){let i=(e,t,n)=>n?t+((e-t)%n+n)%n:e,a=Lt(t),o=t=>e.at(t).slice(0,3),s=[t.parameters(o(n[0]))],c=Math.abs(n[n.length-1]-n[0]);for(let e=1;e<n.length;e++)s.push(t.parameters(o(n[e]),s[e-1]));for(let e=0;e+1<n.length&&n.length<4096;){let[l,u]=[s[e],s[e+1]],[d,f]=[n[e],n[e+1]],p=(d+f)/2;if(Math.abs(f-d)>c*1e-9&&!t.singular(l[0],l[1])&&!t.singular(u[0],u[1])){let c=W(u[0],l[0],t.uPeriod),m=W(u[1],l[1],t.vPeriod);if([.25,.5,.75].some(e=>{let[n,s]=[l[0]+(c-l[0])*e,l[1]+(m-l[1])*e];if(a){let[t,r]=[l[0]+a.turn(l[1]),c+a.turn(m)],[i,o]=[a.along(l[1]),a.along(m)];s=a.at(i+(o-i)*e),n=t+(r-t)*e-a.turn(s)}return H(t.at(i(n,t.uDomain[0],t.uPeriod),i(s,t.vDomain[0],t.vPeriod)).slice(0,3),o(d+(f-d)*e))>r})){n.splice(e+1,0,p),s.splice(e+1,0,t.parameters(o(p),l));continue}}e++}}function Lt(e){let{twist:t,meridian:n,meridianParameter:r}=e;if(!e.twisted?.()||!t||!n||!r)return;let i=t=>e.vPeriod?e.vDomain[0]+((t-e.vDomain[0])%e.vPeriod+e.vPeriod)%e.vPeriod:t;return{turn:n=>t.call(e,i(n)),along:t=>n.call(e,t),at:t=>r.call(e,t)}}function Rt(e){let t=[0,0,0];for(let n=0;n<e.length;n++){let r=e[n],i=e[(n+1)%e.length];t=I(t,[(r[1]-i[1])*(r[2]+i[2]),(r[2]-i[2])*(r[0]+i[0]),(r[0]-i[0])*(r[1]+i[1])])}let n=U(t)??[0,0,1],r=U(Math.abs(n[0])<.9?B([1,0,0],n):B([0,1,0],n))??[1,0,0],i=B(n,r),a=e[0]??[0,0,0];return{uPeriod:0,vPeriod:0,uDomain:[-1/0,1/0],vDomain:[-1/0,1/0],at:(e,t)=>[...I(a,I(R(r,e),R(i,t))),...r,...i],normal:()=>n,parameters:e=>{let t=L(e,a);return[t[0]*r[0]+t[1]*r[1]+t[2]*r[2],t[0]*i[0]+t[1]*i[1]+t[2]*i[2]]},steps:()=>[1/0,1/0],pole:()=>void 0,singular:()=>!1}}function zt(e){let t=[1/0,-1/0,1/0,-1/0];for(let n of e)t[0]=Math.min(t[0],n.u),t[1]=Math.max(t[1],n.u),t[2]=Math.min(t[2],n.v),t[3]=Math.max(t[3],n.v);return t}function Bt(e){let t=0;for(let n=0;n<e.length;n++){let r=e[n],i=e[(n+1)%e.length];t+=r.u*i.v-i.u*r.v}return t/2}function Vt(e){let t=zt(e);return(t[1]-t[0])*(t[3]-t[2])}function Ht(e,t,n,r,i,a,o){let s=(e,t)=>e.reduce((e,n)=>Math.abs(W(i(n),t,o)-t)<Math.abs(W(i(e),t,o)-t)?n:e),c=[];for(let r of[e,t,...n])for(let e=0;e<r.length;e++){let t=r[e],n=r[(e+1)%r.length];c.push([i(t),a(t),W(i(n),i(t),o),a(n)])}let l=(e,t,n,r)=>{let i=n-e,a=r-t,s=Math.hypot(i,a);if(s===0)return!1;for(let[n,r,l,u]of c)for(let c of o?[-o,0,o]:[0]){let o=l-n,d=u-r,f=n+c-e,p=r-t,m=i*d-a*o,h=s*Math.hypot(o,d);if(Math.abs(m)<=1e-12*h){if(Math.abs(i*p-a*f)>1e-9*s*(s+Math.hypot(o,d)))continue;let e=(f*i+p*a)/(s*s),t=((f+o)*i+(p+d)*a)/(s*s);if(Math.min(1,Math.max(e,t))-Math.max(0,Math.min(e,t))>1e-9)return!1;continue}let g=(f*d-p*o)/m,_=(f*a-p*i)/m;if(g>1e-9&&g<1-1e-9&&_>=-1e-9&&_<=1+1e-9)return!1}return!0},u=[...e].sort((e,t)=>Math.abs(W(i(e),r,o)-r)-Math.abs(W(i(t),r,o)-r));for(let e of u){let n=i(e),r=s(t,n);if(l(n,a(e),W(i(r),n,o),a(r)))return[n,a(e),i(r),a(r)]}return[r,void 0,i(s(t,r)),void 0]}function Ut(e,t){let n=e.map(([e,n])=>{let r=e-Math.floor(e/t)*t;return[r,r+n-e]}).sort((e,t)=>e[0]-t[0]),r=Math.max(n[0][1],...n.map(e=>e[1]-t)),i,a=0;for(let e=1;e<=n.length;e++){let o=e<n.length?n[e][0]:n[0][0]+t;o-r>a&&(a=o-r,i=(r+o)/2),e<n.length&&(r=Math.max(r,n[e][1]))}return i}function Wt(e){let t=1;for(let n of e)t=Math.max(t,Math.abs(n.u),Math.abs(n.v));return e.filter((n,r)=>!r||Math.abs(n.u-e[r-1].u)+Math.abs(n.v-e[r-1].v)>t*1e-12)}function Gt(e,t,n){return e.map((e,r)=>r%2?e*n:e*t)}function Kt(e,t,n){if(!(n>0))return()=>!1;let r=2*n,i=/* @__PURE__ */ new Map,a=[],o=1/0,s=1/0;for(let n of t)for(let t of n)o=Math.min(o,e[t*2]),s=Math.min(s,e[t*2+1]);o-=r*2,s-=r*2;let c=(e,t)=>Math.floor((e-o)/r)*1e7+Math.floor((t-s)/r);for(let n of t)for(let t=0;t<n.length;t++){let o=n[t],s=n[(t+1)%n.length],l=e[o*2],u=e[o*2+1],d=e[s*2],f=e[s*2+1],p=a.length/4,m=Math.min(1e5,Math.ceil(Math.hypot(d-l,f-u)/r));a.push(l,u,d,f);let h=NaN;for(let e=0;e<=m;e++){let t=c(l+(d-l)*e/(m||1),u+(f-u)*e/(m||1));if(t===h)continue;h=t;let n=i.get(t);n?n.push(p):i.set(t,[p])}}return(e,t)=>{let r=c(e,t);for(let o=-1;o<=1;o++)for(let s=-1;s<=1;s++)for(let c of i.get(r+o*1e7+s)??[]){let r=a[c*4],i=a[c*4+1],o=a[c*4+2]-r,s=a[c*4+3]-i,l=Math.max(0,Math.min(1,((e-r)*o+(t-i)*s)/(o*o+s*s||1)));if(Math.hypot(r+o*l-e,i+s*l-t)<n)return!0}return!1}}var Y=`node_id:d attributes_groups:p owner:p next:p previous:p geometric_owner:p sense:c`,qt=[[10,`ASSEMBLY`,`highest_node_id:d attributes_groups:p attribute_chains:p list:p surface:p curve:p point:p key:p res_size:f res_linear:f ref_instance:p next:p previous:p state:u owner:p type:u sub_instance:p`],[11,`INSTANCE`,`node_id:d attributes_groups:p type:u part:p transform:p assembly:p next_in_part:p prev_in_part:p next_of_part:p prev_of_part:p`],[12,`BODY`,`highest_node_id:d attributes_groups:p attribute_chains:p surface:p curve:p point:p key:p res_size:f res_linear:f ref_instance:p next:p previous:p state:u owner:p body_type:u nom_geom_state:u shell:p boundary_surface:p boundary_curve:p boundary_point:p region:p edge:p vertex:p`],[13,`SHELL`,`node_id:d attributes_groups:p body:p next:p face:p edge:p vertex:p region:p front_face:p`],[14,`FACE`,`node_id:d attributes_groups:p tolerance:f next:p previous:p loop:p shell:p surface:p sense:c next_on_surface:p previous_on_surface:p next_front:p previous_front:p front_shell:p`],[15,`LOOP`,`node_id:d attributes_groups:p fin:p face:p next:p`],[16,`EDGE`,`node_id:d attributes_groups:p tolerance:f fin:p previous:p next:p curve:p next_on_curve:p previous_on_curve:p owner:p`],[17,`FIN`,`attributes_groups:p loop:p forward:p backward:p vertex:p other:p edge:p curve:p next_at_vx:p sense:c`],[18,`VERTEX`,`node_id:d attributes_groups:p fin:p previous:p next:p point:p tolerance:f owner:p`],[19,`REGION`,`node_id:d attributes_groups:p body:p next:p previous:p shell:p type:c`],[29,`POINT`,`node_id:d attributes_groups:p owner:p next:p previous:p pvec:v`],[30,`LINE`,`${Y} pvec:v direction:v`],[31,`CIRCLE`,`${Y} centre:v normal:v x_axis:v radius:f`],[32,`ELLIPSE`,`${Y} centre:v normal:v x_axis:v major_radius:f minor_radius:f`],[38,`INTERSECTION`,`${Y} surface:p[2] chart:p start:p end:p`],[40,`CHART`,`base_parameter:f base_scale:f chart_count:d chordal_error:f angular_error:f parameter_error:f[2] hvec:h[]`],[41,`LIMIT`,`type:c hvec:h[]`],[45,`BSPLINE_VERTICES`,`vertices:f[]`],[50,`PLANE`,`${Y} pvec:v normal:v x_axis:v`],[51,`CYLINDER`,`${Y} pvec:v axis:v radius:f x_axis:v`],[52,`CONE`,`${Y} pvec:v axis:v radius:f sin_half_angle:f cos_half_angle:f x_axis:v`],[53,`SPHERE`,`${Y} centre:v radius:f axis:v x_axis:v`],[54,`TORUS`,`${Y} centre:v axis:v major_radius:f minor_radius:f x_axis:v`],[56,`BLENDED_EDGE`,`${Y} blend_type:c surface:p[2] spine:p range:f[2] thumb_weight:f[2] boundary:p[2] start:p end:p`],[59,`BLEND_BOUND`,`${Y} boundary:n blend:p`],[60,`OFFSET_SURF`,`${Y} check:c true_offset:l surface:p offset:f scale:f`],[67,`SWEPT_SURF`,`${Y} section:p sweep:v scale:f`],[68,`SPUN_SURF`,`${Y} profile:p base:v axis:v start:v end:v start_param:f end_param:f x_axis:v scale:f`],[70,`LIST`,`node_id:d owner:p next:p previous:p list_type:d list_length:d block_length:d size_of_entry:d list_block:p`],[74,`POINTER_LIS_BLOCK`,`n_entries:d next_block:p entries:p[]`],[79,`ATT_DEF_ID`,`string:c[]`],[80,`ATTRIB_DEF`,`next:p identifier:p type_id:d actions:u[8] field_names:p legal_owners:l[14] fields:u[]`],[81,`ATTRIBUTE`,`node_id:d definition:p owner:p next:p previous:p next_of_type:p previous_of_type:p fields:p[]`],[82,`INT_VALUES`,`values:d[]`],[83,`REAL_VALUES`,`values:f[]`],[84,`CHAR_VALUES`,`values:c[]`],[85,`POINT_VALUES`,`values:v[]`],[86,`VECTOR_VALUES`,`values:v[]`],[87,`AXIS_VALUES`,`values:v[]`],[88,`TAG_VALUES`,`values:d[]`],[89,`DIRECTION_VALUES`,`values:v[]`],[90,`GROUP`,`node_id:d attributes_groups:p owner:p next:p previous:p type:u first_member:p`],[91,`MEMBER_OF_GROUP`,`dummy_node_id:d owning_group:p owner:p next:p previous:p next_member:p previous_member:p`],[98,`UNICODE_VALUES`,`values:w[]`],[99,`FIELD_NAMES`,`names:p[]`],[100,`TRANSFORM`,`node_id:d owner:p next:p previous:p rotation_matrix:f[9] translation_vector:v scale:f flag:d perspective_vector:v`],[101,`WORLD`,`assembly:p attribute:p body:p transform:p surface:p curve:p point:p alive:l attrib_def:p highest_id:d current_id:d`],[102,`KEY`,`string:c[]`],[120,`PE_SURF`,`${Y} type:c data:p tf:p internal_geom:p[]`],[121,`INT_PE_DATA`,`geom_type:d real_array:p int_array:p`],[122,`EXT_PE_DATA`,`key:p real_array:p int_array:p`],[124,`B_SURFACE`,`${Y} nurbs:p data:p`],[125,`SURFACE_DATA`,`original_uint:i original_vint:i extended_uint:i extended_vint:i self_int:u original_u_start:c original_u_end:c original_v_start:c original_v_end:c extended_u_start:c extended_u_end:c extended_v_start:c extended_v_end:c analytic_form_type:c swept_form_type:c spun_form_type:c blend_form_type:c analytic_form:p swept_form:p spun_form:p blend_form:p`],[126,`NURBS_SURF`,`u_periodic:l v_periodic:l u_degree:n v_degree:n n_u_vertices:d n_v_vertices:d u_knot_type:u v_knot_type:u n_u_knots:d n_v_knots:d rational:l u_closed:l v_closed:l surface_form:u vertex_dim:n bspline_vertices:p u_knot_mult:p v_knot_mult:p u_knots:p v_knots:p`],[127,`KNOT_MULT`,`mult:n[]`],[128,`KNOT_SET`,`knots:f[]`],[130,`PE_CURVE`,`${Y} type:c data:p tf:p internal_geom:p[]`],[133,`TRIMMED_CURVE`,`${Y} basis_curve:p point_1:v point_2:v parm_1:f parm_2:f`],[134,`B_CURVE`,`${Y} nurbs:p data:p`],[135,`CURVE_DATA`,`self_int:u analytic_form:p`],[136,`NURBS_CURVE`,`degree:n n_vertices:d vertex_dim:n n_knots:d knot_type:u periodic:l closed:l rational:l curve_form:u bspline_vertices:p knot_mult:p knots:p`],[137,`SP_CURVE`,`${Y} surface:p b_curve:p original:p tolerance_to_original:f`],[141,`GEOMETRIC_OWNER`,`owner:p next:p previous:p shared_geometry:p`],[163,`HELIX_SU_FORM`,`axis_pt:v axis_dir:v hand:c turns:i pitch:f gap:f tol:f`],[184,`HELIX_CU_FORM`,`axis_pt:v axis_dir:v point:v hand:c turns:i pitch:f tol:f`]],Jt=e=>e.split(/\s+/).map(e=>{let[t,n]=e.split(`:`),r=/^(\w)(?:\[(\d*)\])?$/.exec(n);if(!r)throw TypeError(`Parasolid schema: field ${e} is not name:type[count]; fix the schema table`);return{name:t,type:r[1],count:r[2]===void 0?0:r[2]===``?1:Number(r[2])}});new Map(qt.map(([e,t,n])=>[e,{name:t,fields:Jt(n)}])),Jt(`node_id:d list_type:u notransmit:l owner:p next:p previous:p list_length:d block_length:d finger_index:d finger_block:p list_block:p`);var Yt=e=>{throw TypeError(e)},Xt=class{constructor(){this.lines=[],this.next=100,this.styled=[],this.reserved=/* @__PURE__ */ new Map}add(e){let t=`#${this.next++}`;return this.lines.push(`${t}=${e};`),t}reserve(){let e=`#${this.next++}`;return this.reserved.set(e,this.lines.push(``)-1),e}fill(e,t){let n=this.reserved.get(e);n===void 0&&Yt(`StepWriter: ${e} was not reserved`),this.lines[n]=`${e}=${t};`,this.reserved.delete(e)}draft(){return`ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('','',(''),(''),'','','');\nFILE_SCHEMA(('AUTOMOTIVE_DESIGN'));\nENDSEC;\nDATA;\n${this.lines.filter(Boolean).join(`
`)}\nENDSEC;\nEND-ISO-10303-21;\n`}real(e){Number.isFinite(e)||Yt(`Invalid model: a coordinate or size is not finite`);let t=e.toPrecision(17).replace(/(\.\d*?)0+(e|$)/,`$1$2`).replace(/\.(e|$)/,`.0$1`);return t.includes(`.`)?t.replace(`e`,`E`):`${t}.`}point(e){return this.add(`CARTESIAN_POINT('',(${e.map(e=>this.real(e)).join(`,`)}))`)}direction(e){return this.add(`DIRECTION('',(${e.map(e=>this.real(e)).join(`,`)}))`)}axis(e,t,n){let r=Math.hypot(t[0],t[1],t[2]);r>0||Yt(`Invalid model: an axis has zero length`);let i=t.map(e=>e/r),a=n[0]*i[0]+n[1]*i[1]+n[2]*i[2],o=[n[0]-a*i[0],n[1]-a*i[1],n[2]-a*i[2]],s=Math.hypot(o[0],o[1],o[2]),c=e=>{let t=Math.hypot(e[0],e[1],e[2]);return e.map(e=>e/t)},l=s>1e-12?o.map(e=>e/s):Math.abs(i[0])<.9?c([1-i[0]*i[0],-i[0]*i[1],-i[0]*i[2]]):c([-i[1]*i[0],1-i[1]*i[1],-i[1]*i[2]]);return this.add(`AXIS2_PLACEMENT_3D('',${this.point(e)},${this.direction(i)},${this.direction(l)})`)}spline(e,t){let n=e.degrees.length===2,r=e.points.map(e=>this.point(e)),i=e=>t?(this.fill(t,e),t):this.add(e);r.length!==e.counts.reduce((e,t)=>e*t,1)&&Yt(`Invalid model: a spline has the wrong number of points`);let a=t=>`(${Array.from({length:e.counts[0]},(n,r)=>`(${Array.from({length:e.counts[1]},(n,i)=>t(i*e.counts[0]+r)).join(`,`)})`).join(`,`)})`,o=n?a(e=>r[e]):`(${r.join(`,`)})`,s=e.knots.map(e=>`(${e.map(e=>this.real(e)).join(`,`)})`),c=e.multiplicities.map(e=>`(${e.join(`,`)})`);if(n){let t=`${e.degrees[0]},${e.degrees[1]},${o},.UNSPECIFIED.,.F.,.F.,.F.`,n=`${c[0]},${c[1]},${s[0]},${s[1]},.UNSPECIFIED.`;return e.weights?i(`(BOUNDED_SURFACE()B_SPLINE_SURFACE(${t})B_SPLINE_SURFACE_WITH_KNOTS(${n})GEOMETRIC_REPRESENTATION_ITEM()RATIONAL_B_SPLINE_SURFACE(${a(t=>this.real(e.weights[t]))})REPRESENTATION_ITEM('')SURFACE())`):i(`B_SPLINE_SURFACE_WITH_KNOTS('',${t},${n})`)}let l=`${e.degrees[0]},${o},.UNSPECIFIED.,.F.,.F.`,u=`${c[0]},${s[0]},.UNSPECIFIED.`;return e.weights?i(`(BOUNDED_CURVE()B_SPLINE_CURVE(${l})B_SPLINE_CURVE_WITH_KNOTS(${u})CURVE()GEOMETRIC_REPRESENTATION_ITEM()RATIONAL_B_SPLINE_CURVE((${e.weights.map(e=>this.real(e)).join(`,`)}))REPRESENTATION_ITEM(''))`):i(`B_SPLINE_CURVE_WITH_KNOTS('',${l},${u})`)}shape(e){let t=this.axis([0,0,0],[0,0,1],[1,0,0]),n=this.add(`ADVANCED_BREP_SHAPE_REPRESENTATION('',(${[...e,t].join(`,`)}),#10)`);return this.add(`REPRESENTATION_MAP(${t},${n})`)}place(e,t,n,r){return this.add(`MAPPED_ITEM('',${e},${this.axis(t,n,r)})`)}style(e,t){let n=this.add(`COLOUR_RGB('',${t.map(e=>this.real(e)).join(`,`)})`),r=this.add(`FILL_AREA_STYLE('',(${this.add(`FILL_AREA_STYLE_COLOUR('',${n})`)}))`),i=this.add(`SURFACE_SIDE_STYLE('',(${this.add(`SURFACE_STYLE_FILL_AREA(${r})`)}))`),a=this.add(`SURFACE_STYLE_USAGE(.BOTH.,${i})`),o=this.add(`PRESENTATION_STYLE_ASSIGNMENT((${a}))`);this.styled.push(this.add(`STYLED_ITEM('',(${o}),${e})`))}finish(e,{unit:t,source:n}){e.length||Yt(`Invalid model: no body with faces`);let r=this.add(`ADVANCED_BREP_SHAPE_REPRESENTATION('',(${e.join(`,`)},#12),#10)`);return this.add(`SHAPE_REPRESENTATION_RELATIONSHIP('','',#13,${r})`),this.styled.length&&this.add(`MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION('',(${this.styled.join(`,`)}),#10)`),`ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('converted from ${n.replace(/'/g,`''`)}'),'2;1');
FILE_NAME('model.stp','',(''),(''),'Margo kernel','','');
FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 3 1 1 }'));
ENDSEC;
DATA;
#1=APPLICATION_CONTEXT('automotive design');
#2=PRODUCT_CONTEXT('',#1,'mechanical');
#3=PRODUCT('part','part','',(#2));
#4=PRODUCT_DEFINITION_FORMATION('','',#3);
#5=PRODUCT_DEFINITION_CONTEXT('part definition',#1,'design');
#6=PRODUCT_DEFINITION('design','',#4,#5);
#7=PRODUCT_DEFINITION_SHAPE('','',#6);
#8=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(${t===`mm`?`.MILLI.`:`$`},.METRE.));
#9=(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.));
#10=(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNIT_ASSIGNED_CONTEXT((#8,#9))REPRESENTATION_CONTEXT('',''));
#11=CARTESIAN_POINT('',(0.,0.,0.));
#12=AXIS2_PLACEMENT_3D('',#11,$,$);
#13=SHAPE_REPRESENTATION('',(#12),#10);
#14=SHAPE_DEFINITION_REPRESENTATION(#7,#13);
${this.lines.filter(Boolean).join(`
`)}
ENDSEC;
END-ISO-10303-21;
`}},X=e=>{throw TypeError(`Invalid IGES file: ${e}; export it again from the CAD tool as IGES (fixed ASCII format)`)},Zt={1:25.4,2:1,4:304.8,5:1609344,6:1e3,7:1e6,8:.0254,9:.001,10:10,11:254e-7},Qt={IN:25.4,INCH:25.4,MM:1,FT:304.8,MI:1609344,M:1e3,KM:1e6,MIL:.0254,UM:.001,MICRON:.001,CM:10,UIN:254e-7},$t=/^[+-]?(\d+\.?\d*|\.\d+)([EeDd][+-]?\d+)?$/;function en(e,t,n,r,i){let a=[],o=e.length,s=t;for(;;){for(;s<o&&e[s]===` `;)s++;if(s>=o)return{values:a,end:-1};let t=e[s];if(t===n){a.push(null),s++;continue}if(t===r)return a.length&&a.push(null),{values:a,end:s+1};let c,l=s;for(;l<o&&e.charCodeAt(l)>=48&&e.charCodeAt(l)<=57;)l++;if(l>s&&l<o&&(e[l]===`H`||e[l]===`h`)){let t=Number(e.slice(s,l));for(l+1+t>o&&X(`${i}: a string of ${t} characters runs past the end`),c=e.slice(l+1,l+1+t),s=l+1+t;s<o&&e[s]===` `;)s++;s<o&&e[s]!==n&&e[s]!==r&&X(`${i}: text after the string ${JSON.stringify(c)}; check its character count`)}else{for(l=s;l<o&&e[l]!==n&&e[l]!==r;)l++;let t=e.slice(s,l).trim();c=t===``?null:$t.test(t)?Number(t.replace(/[Dd]/,`E`)):t,s=l}if(a.push(c),s>=o)return{values:a,end:-1};if(e[s]===r)return{values:a,end:s+1};s++}}var tn=e=>typeof e==`string`?e:``,nn=(e,t)=>typeof e==`number`?e:t;function rn(e){let t=e.split(/\r\n|\n|\r/);if(t.length<=2&&t[0].length>160&&t[0].length%80==0){let e=[];for(let n=0;n<t[0].length;n+=80)e.push(t[0].slice(n,n+80));t=e}return t}function an(e){let t=ae(e),n={S:[],G:[],D:[],P:[],T:[]},r=0,i=!1;for(let[e,a]of rn(t).entries()){if(i)break;if(a.trim()===``)continue;let t=a.length>=73?a[72]:``;e===0&&(t===`C`||t===`B`)&&X(`it is in the ${t===`C`?`Compressed`:`Binary`} Format, which the reader does not read`);let o=t?`SGDPT`.indexOf(t):-1;o<0&&X(`line ${e+1} has no section letter (S, G, D, P or T) in column 73; IGES lines are 80 columns wide`),o<r&&X(`line ${e+1}: the ${t} section comes after a later section`),r=o,n[t].push(a.padEnd(80,` `)),t===`T`&&(i=!0)}n.G.length||X(`no Global section (lines with G in column 73)`),n.D.length||X(`no Directory Entry section (lines with D in column 73)`),n.D.length%2&&X(`the Directory Entry section has ${n.D.length} lines; each entity has two`),i||X(`no Terminate line (T in column 73); the file may be cut short`);let a=n.G.map(e=>e.slice(0,72)).join(``),o=0;for(;a[o]===` `;)o++;let s=`,`,c=`;`;for(/^1[Hh]/.test(a.slice(o,o+2))&&(s=a[o+2],o+=3);a[o]===` `;)o++;for(a[o]!==s&&X(`the Global section's first field is not followed by its parameter delimiter ${s}`),o++;a[o]===` `;)o++;if(/^1[Hh]/.test(a.slice(o,o+2)))for(c=a[o+2],o+=3;a[o]===` `;)o++;s===c&&X(`the parameter and record delimiters are both ${s}`),(/[\d\s+\-.DEH]/i.test(s)||/[\d\s+\-.DEH]/i.test(c))&&X(`delimiter ${JSON.stringify(s)} or ${JSON.stringify(c)} is one the specification does not allow`);let l=[];a[o]===s?l=en(a,o+1,s,c,`Global section`).values:a[o]!==c&&X(`the Global section's second field is not followed by a delimiter`);let u=[s,c,...l],d=nn(u[13],1),f=tn(u[14]),p=d===3?Qt[f.trim().toUpperCase()]??1:Zt[d]??25.4,m={parameterDelimiter:s,recordDelimiter:c,sender:tn(u[2]),fileName:tn(u[3]),system:tn(u[4]),preprocessor:tn(u[5]),modelScale:nn(u[12],1)||1,unitsFlag:d,unitsName:f,millimetres:p,resolution:Math.abs(nn(u[18],0)),maxCoordinate:Math.abs(nn(u[19],0)),author:tn(u[20]),organization:tn(u[21]),version:nn(u[22],3),fields:u},h=n.P.map(e=>e.slice(0,64)).join(``),g=/* @__PURE__ */ new Map,_=(e,t)=>{let n=e.trim();return n===``?0:(/^[+-]?\d+$/.test(n)||X(`${t}: ${JSON.stringify(n)} is not an integer`),Number(n))};for(let e=0;e<n.D.length;e+=2){let t=n.D[e],r=n.D[e+1],i=e+1,a=`directory entry ${i}`,o=(e,t)=>e.slice(t*8,t*8+8),l=_(o(t,0),a);if(l===0)continue;let u=_(o(t,1),a),d=o(t,8).trim().padStart(8,`0`),f=_(o(r,3),a);_(o(r,0),a)!==l&&X(`${a}: its two lines give different entity types`),(u<1||u>n.P.length)&&X(`${a}: parameter data pointer ${u} is outside the Parameter Data section`);let p=en(h,(u-1)*64,s,c,`parameter data of entity ${i} (type ${l})`);p.end<0&&X(`parameter data of entity ${i} (type ${l}) has no record delimiter ${c}`),p.end>(u-1+Math.max(f,1))*64+64&&f>0&&X(`parameter data of entity ${i} runs past its ${f} lines; check its record delimiter`);let[m,...v]=p.values;m!==l&&X(`parameter data of entity ${i} starts with ${JSON.stringify(m)}, not its type ${l}`),g.set(i,{de:i,type:l,form:_(o(r,4),a),transform:_(o(t,6),a),color:_(o(r,2),a),level:_(o(t,4),a),blanked:d.slice(0,2)===`01`,subordinate:Number(d.slice(2,4))||0,use:Number(d.slice(4,6))||0,label:o(r,7).trim(),subscript:Number(o(r,8).trim())||0,params:v})}return{start:n.S.map(e=>e.slice(0,72).trimEnd()).join(`
`),global:m,entities:g}}var on={r:[1,0,0,0,1,0,0,0,1],t:[0,0,0]},sn=e=>({r:[e,0,0,0,e,0,0,0,e],t:[0,0,0]});function cn(e,t){let n=e.r,r=t.r,i=[];for(let e=0;e<3;e++)for(let t=0;t<3;t++)i.push(n[e*3]*r[t]+n[e*3+1]*r[3+t]+n[e*3+2]*r[6+t]);return{r:i,t:ln(e,t.t)}}var ln=(e,t)=>{let n=e.r;return[n[0]*t[0]+n[1]*t[1]+n[2]*t[2]+e.t[0],n[3]*t[0]+n[4]*t[1]+n[5]*t[2]+e.t[1],n[6]*t[0]+n[7]*t[1]+n[8]*t[2]+e.t[2]]},un=(e,t)=>{let n=e.r;return[n[0]*t[0]+n[1]*t[1]+n[2]*t[2],n[3]*t[0]+n[4]*t[1]+n[5]*t[2],n[6]*t[0]+n[7]*t[1]+n[8]*t[2]]},dn=e=>{let t=e.r;return t[0]*(t[4]*t[8]-t[5]*t[7])-t[1]*(t[3]*t[8]-t[5]*t[6])+t[2]*(t[3]*t[7]-t[4]*t[6])},fn=e=>Math.cbrt(Math.abs(dn(e))),Z=(e,t)=>[e[0]+t[0],e[1]+t[1],e[2]+t[2]],pn=(e,t)=>[e[0]-t[0],e[1]-t[1],e[2]-t[2]],Q=(e,t)=>[e[0]*t,e[1]*t,e[2]*t],mn=(e,t)=>e[0]*t[0]+e[1]*t[1]+e[2]*t[2],hn=(e,t)=>[e[1]*t[2]-e[2]*t[1],e[2]*t[0]-e[0]*t[2],e[0]*t[1]-e[1]*t[0]],gn=e=>Math.hypot(e[0],e[1],e[2]),_n=(e,t)=>Math.hypot(e[0]-t[0],e[1]-t[1],e[2]-t[2]),vn=e=>{let t=gn(e);return t>0?[e[0]/t,e[1]/t,e[2]/t]:[0,0,0]},yn=e=>vn(Math.abs(e[0])<.9?hn(e,[1,0,0]):hn(e,[0,1,0])),bn=e=>{let t=new Float64Array(e.P.length*4);return e.P.forEach((n,r)=>{let i=e.W?.[r]??1;t.set([n[0]*i,n[1]*i,n[2]*i,i],r*4)}),t},xn=/* @__PURE__ */ new WeakMap,Sn=(e,t)=>{let n=xn.get(e);return n||xn.set(e,n=bn(e)),F({degree:e.p,points:n,knots:e.U},t).slice(0,3)};function Cn(e){switch(e.kind){case`line`:return[0,1];case`conic`:return[e.t0,e.t1];case`nurbs`:return[e.n.t0,e.n.t1];case`poly`:return[0,Math.max(1,e.pts.length-1)];case`chain`:{let t=0;for(let n of e.parts){let[e,r]=Cn(n);t+=r-e}return[0,t]}}}function $(e,t){switch(e.kind){case`line`:return Z(e.a,Q(pn(e.b,e.a),t));case`conic`:return Z(e.c,Z(Q(e.X,Math.cos(t)),Q(e.Y,Math.sin(t))));case`nurbs`:return Sn(e.n,Math.min(Math.max(t,e.n.U[e.n.p]),e.n.U[e.n.U.length-1-e.n.p]));case`poly`:{let n=e.pts.length;if(n===1)return[...e.pts[0]];let r=Math.min(n-2,Math.max(0,Math.floor(t)));return Z(e.pts[r],Q(pn(e.pts[r+1],e.pts[r]),t-r))}case`chain`:{let n=t;for(let[t,r]of e.parts.entries()){let[i,a]=Cn(r);if(n<=a-i||t===e.parts.length-1)return $(r,i+Math.min(n,a-i));n-=a-i}return[0,0,0]}}}var wn=e=>$(e,Cn(e)[0]),Tn=e=>$(e,Cn(e)[1]);function En(e,t){switch(e.kind){case`line`:return{kind:`line`,a:ln(t,e.a),b:ln(t,e.b)};case`conic`:return{kind:`conic`,c:ln(t,e.c),X:un(t,e.X),Y:un(t,e.Y),t0:e.t0,t1:e.t1};case`nurbs`:return{kind:`nurbs`,n:{...e.n,P:e.n.P.map(e=>ln(t,e))}};case`poly`:return{kind:`poly`,pts:e.pts.map(e=>ln(t,e))};case`chain`:return{kind:`chain`,parts:e.parts.map(e=>En(e,t))}}}function Dn(e){if(e.kind===`chain`)return e.parts.reduce((e,t)=>e+Dn(t),0);if(e.kind===`line`)return _n(e.a,e.b);if(e.kind===`poly`)return e.pts.reduce((t,n,r)=>r?t+_n(n,e.pts[r-1]):0,0);let[t,n]=Cn(e),r=0,i=$(e,t);for(let a=1;a<=32;a++){let o=$(e,t+(n-t)*a/32);r+=_n(o,i),i=o}return r}function On(e,t){if(e.kind===`chain`)return e.parts.flatMap(e=>On(e,t));if(e.kind===`poly`){let n=[];for(let r=1;r<e.pts.length;r++)_n(e.pts[r],e.pts[r-1])>t&&n.push({kind:`line`,a:[...e.pts[r-1]],b:[...e.pts[r]]});return n}return Dn(e)>t?[e]:[]}function kn(e,t,n,r){let i=t.length-2;for(;i>e&&t[i]>r;)i--;let a=0;for(let e of t)e===r&&a++;let o=[];for(let s=0;s<=n.length;s++)if(s<=i-e)o.push(n[s]);else if(s<=i-a){let i=(r-t[s])/(t[s+e]-t[s]);o.push(n[s].map((e,t)=>i*e+(1-i)*n[s-1][t]))}else o.push(n[s-1]);return[[...t.slice(0,i+1),r,...t.slice(i+1)],o]}function An(e){let t=e.p,n=[...e.U],r=e.P.map((t,n)=>{let r=e.W?.[n]??1;return[t[0]*r,t[1]*r,t[2]*r,r]}),i=Math.max(e.t0,n[t]),a=Math.min(e.t1,n[n.length-1-t]),o=[i,...n.filter(e=>e>i&&e<a),a].filter((e,t,n)=>!t||e!==n[t-1]);for(let e of o){let i=n.filter(t=>t===e).length;for(;i<t;)[n,r]=kn(t,n,r,e),i++}let s=[],c=[i];for(let e=t;e<n.length-t-1;e++)!(n[e+1]>n[e])||n[e+1]<=i||n[e]>=a||(s.push(r.slice(e-t,e+1)),c.push(n[e+1]));return{p:t,segs:s,breaks:c}}var jn=e=>{let t=e.length-1,n=[e[0]];for(let r=1;r<=t;r++){let i=r/(t+1);n.push(e[r].map((t,n)=>i*e[r-1][n]+(1-i)*t))}return n.push(e[t]),n};function Mn(e,t){let n=[],r=[],i=e;for(;i.length;){n.push(i[0]),r.unshift(i[i.length-1]);let e=[];for(let n=0;n+1<i.length;n++)e.push(i[n].map((e,r)=>(1-t)*e+t*i[n+1][r]));i=e}return[n,r]}function Nn(e,t){return{p:t,breaks:e.breaks,segs:e.segs.map(e=>{let n=e;for(;n.length-1<t;)n=jn(n);return n})}}function Pn(e){let{p:t,segs:n,breaks:r}=e,i=[],a=[];for(let e=0;e<=t;e++)i.push(r[0]);n.forEach((e,o)=>{for(let n=+!!o;n<=t;n++)a.push(e[n]);for(let e=0;e<(o===n.length-1?t+1:t);e++)i.push(r[o+1])});let o=a.some(e=>Math.abs(e[3]-1)>1e-14);return{p:t,U:i,P:a.map(e=>[e[0]/e[3],e[1]/e[3],e[2]/e[3]]),...o?{W:a.map(e=>e[3])}:{},t0:r[0],t1:r[r.length-1]}}function Fn(e){let t=Math.max(1,Math.ceil((e.t1-e.t0)/(Math.PI/2)-1e-9)),n=(e.t1-e.t0)/t,r=Math.cos(n/2),i=[],a=[e.t0];for(let o=0;o<t;o++){let t=e.t0+o*n,s=t+n,c=(t+s)/2,l=$(e,t),u=$(e,s),d=Z(e.c,Q(Z(Q(e.X,Math.cos(c)),Q(e.Y,Math.sin(c))),1/r));i.push([[...l,1],[d[0]*r,d[1]*r,d[2]*r,r],[...u,1]]),a.push(s)}return{p:2,segs:i,breaks:a}}function In(e){switch(e.kind){case`line`:return{p:1,segs:[[[...e.a,1],[...e.b,1]]],breaks:[0,1]};case`poly`:return e.pts.length<2?void 0:{p:1,segs:e.pts.slice(1).map((t,n)=>[[...e.pts[n],1],[...t,1]]),breaks:e.pts.map((e,t)=>t)};case`conic`:return Fn(e);case`nurbs`:return An(e.n);case`chain`:{let t=e.parts.map(In);if(!t.length||t.some(e=>!e||!e.segs.length))return;let n=Math.max(...t.map(e=>e.p)),r=[],i=[0],a=0;for(let e of t){let t=Nn(e,n);for(let e=0;e<t.segs.length;e++)r.push(t.segs[e]),i.push(a+t.breaks[e+1]-t.breaks[0]);a+=t.breaks[t.breaks.length-1]-t.breaks[0]}return{p:n,segs:r,breaks:i}}}}function Ln(e){if(e.kind===`nurbs`)return e.n;let t=In(e);return t&&t.segs.length?Pn(t):void 0}function Rn(e,t,n,r,i=4){let a=n-t,o=a*1e-6,s=r=>r-o<t?Q(Z(Z(Q(e(r),-3),Q(e(r+o),4)),Q(e(r+2*o),-1)),1/(2*o)):r+o>n?Q(Z(Z(Q(e(r),3),Q(e(r-o),-4)),e(r-2*o)),1/(2*o)):Q(pn(e(r+o),e(r-o)),1/(2*o)),c=[],l=[t],u=(t,n,i,a,o,d,f)=>{let p=(a-t)/3,m=[n,Z(n,Q(i,p)),pn(o,Q(d,p)),o],h=e=>{let t=1-e;return Z(Z(Q(m[0],t*t*t),Q(m[1],3*t*t*e)),Z(Q(m[2],3*t*e*e),Q(m[3],e*e*e)))},g=0;for(let n of[.25,.5,.75])g=Math.max(g,_n(h(n),e(t+(a-t)*n)));if(g>r&&f<10&&c.length<2048){let r=(t+a)/2,c=e(r),l=s(r);u(t,n,i,r,c,l,f+1),u(r,c,l,a,o,d,f+1)}else c.push(m.map(e=>[...e,1])),l.push(a)},d=t,f=e(t),p=s(t);for(let r=1;r<=i;r++){let o=r===i?n:t+a*r/i,c=e(o),l=s(o);u(d,f,p,o,c,l,0),d=o,f=c,p=l}return Pn({p:3,segs:c,breaks:l})}var zn=/* @__PURE__ */ new WeakMap;function Bn(e,t,n){let r=zn.get(e);if(!r){r=new Float64Array(e.nu*e.nv*4);for(let t=0;t<e.nu;t++)for(let n=0;n<e.nv;n++){let i=n*e.nu+t,a=e.W?.[i]??1,o=e.P[i];r.set([o[0]*a,o[1]*a,o[2]*a,a],(t*e.nv+n)*4)}zn.set(e,r)}let i=Math.min(Math.max(t,e.U[e.pu]),e.U[e.U.length-1-e.pu]),a=Math.min(Math.max(n,e.V[e.pv]),e.V[e.V.length-1-e.pv]);return we({uDegree:e.pu,vDegree:e.pv,nu:e.nu,nv:e.nv,points:r,uKnots:e.U,vKnots:e.V},i,a).slice(0,3)}function Vn(e,t,n,r){let i=pn(e,t),a=Math.cos(r),o=Math.sin(r),s=mn(n,i);return Z(t,Z(Z(Q(i,a),Q(hn(n,i),o)),Q(n,s*(1-a))))}var Hn=Math.PI/180;function Un(e){switch(e.kind){case`plane`:return[-1/0,1/0,-1/0,1/0];case`cylinder`:case`cone`:return[0,360,-1/0,1/0];case`sphere`:return[0,360,-90,90];case`torus`:return[0,360,0,360];case`nurbs`:return[...e.dom];case`revolution`:return[...Cn(e.curve),e.sa,e.ta];case`extrusion`:return[0,1,0,1];case`offset`:return Un(e.base)}}function Wn(e,t,n){switch(e.kind){case`plane`:return e.x&&e.y?Z(e.o,Z(Q(e.x,t),Q(e.y,n))):void 0;case`cylinder`:return Z(e.o,Z(Q(Z(Q(e.x,Math.cos(t*Hn)),Q(e.y,Math.sin(t*Hn))),e.r),Q(e.z,n)));case`cone`:return Z(e.o,Z(Q(Z(Q(e.x,Math.cos(t*Hn)),Q(e.y,Math.sin(t*Hn))),e.r+n*Math.tan(e.r2)),Q(e.z,n)));case`sphere`:{let r=Math.cos(t*Hn),i=Math.sin(t*Hn),a=Math.cos(n*Hn),o=Math.sin(n*Hn);return Z(e.o,Q(Z(Q(Z(Q(e.x,r),Q(e.y,i)),a),Q(e.z,o)),e.r))}case`torus`:{let r=Math.cos(t*Hn),i=Math.sin(t*Hn),a=Math.cos(n*Hn),o=Math.sin(n*Hn);return Z(e.o,Z(Q(pn(Q(e.x,a),Q(e.y,o)),e.r+e.r2*r),Q(e.z,e.r2*i)))}case`nurbs`:return Bn(e.s,t,n);case`revolution`:return Vn($(e.curve,t),e.a,e.d,n);case`extrusion`:{let[r,i]=Cn(e.curve);return Z($(e.curve,r+t*(i-r)),Q(e.v,n))}case`offset`:{let r=Wn(e.base,t,n),i=Gn(e.base,t,n);return r&&i?Z(r,Q(i,e.d)):void 0}}}function Gn(e,t,n){if(e.kind===`plane`&&!(e.x&&e.y))return vn(e.n);let[r,i,a,o]=Un(e),s=Number.isFinite(i-r)?(i-r)*1e-6:1e-6,c=Number.isFinite(o-a)?(o-a)*1e-6:1e-6,l=Math.max(r,t-s),u=Math.min(i,t+s),d=Math.max(a,n-c),f=Math.min(o,n+c),p=Wn(e,l,n),m=Wn(e,u,n),h=Wn(e,t,d),g=Wn(e,t,f);if(!p||!m||!h||!g)return;let _=hn(pn(m,p),pn(g,h));return gn(_)>0?vn(_):void 0}function Kn(e,t){let n=fn(t),r=e=>vn(un(t,e));switch(e.kind){case`plane`:return{kind:`plane`,o:ln(t,e.o),n:e.x&&e.y?vn(hn(un(t,e.x),un(t,e.y))):r(e.n),...e.x&&e.y?{x:un(t,e.x),y:un(t,e.y)}:{}};case`cylinder`:case`cone`:case`sphere`:case`torus`:return{kind:e.kind,o:ln(t,e.o),x:r(e.x),y:r(e.y),z:r(e.z),r:e.r*n,r2:e.kind===`torus`?e.r2*n:e.r2};case`nurbs`:return{kind:`nurbs`,dom:e.dom,s:{...e.s,P:e.s.P.map(e=>ln(t,e))}};case`revolution`:return{kind:`revolution`,a:ln(t,e.a),d:Q(r(e.d),dn(t)<0?-1:1),curve:En(e.curve,t),sa:e.sa,ta:e.ta};case`extrusion`:return{kind:`extrusion`,curve:En(e.curve,t),v:un(t,e.v)};case`offset`:return{kind:`offset`,base:Kn(e.base,t),d:e.d*n}}}function qn(e,t,n,r,i){let[a,o,s,c,l,u]=e,d=Math.max(Math.abs(a),Math.abs(o),Math.abs(s))||1,f=(o*o-4*a*s)/(d*d),p=i===1||i===2||i===3?i:f<-1e-12?1:f>1e-12?2:3,m=(e,t)=>a*e*e+o*e*t+s*t*t+c*e+l*t+u;if(p===1){let e=4*a*s-o*o;if(!(Math.abs(e)>0))return;let i=(-2*s*c+o*l)/e,u=(o*c-2*a*l)/e,d=m(i,u),f=.5*Math.atan2(o,a-s),p=Math.cos(f),h=Math.sin(f),g=a*p*p+o*h*p+s*h*h,_=a*h*h-o*h*p+s*p*p,v=Math.sqrt(-d/g),y=Math.sqrt(-d/_);if(!(v>0&&y>0))return;let b=[p,h],x=[-h,p],S=e=>{let t=e[0]-i,n=e[1]-u;return Math.atan2((t*x[0]+n*x[1])/y,(t*b[0]+n*b[1])/v)},C=S(n),w=S(r);for(;w<=C+1e-12;)w+=2*Math.PI;return Math.hypot(r[0]-n[0],r[1]-n[1])<=1e-12*Math.max(v,y)&&(w=C+2*Math.PI),{kind:`conic`,c:[i,u,t],X:[v*b[0],v*b[1],0],Y:[y*x[0],y*x[1],0],t0:C,t1:w}}let h=e=>[2*a*e[0]+o*e[1]+c,o*e[0]+2*s*e[1]+l],g=[],_=(e,n,r)=>{let i=h(e),a=h(n),o=[-i[1],i[0]],s=[-a[1],a[0]],c=Math.hypot(o[0],o[1]),l=Math.hypot(s[0],s[1]),u=o[0]*s[1]-o[1]*s[0];if(!(Math.abs(u)>1e-14*c*l))return!1;let d=((n[0]-e[0])*s[1]-(n[1]-e[1])*s[0])/u,f=[e[0]+d*o[0],e[1]+d*o[1]],p=[(e[0]+n[0])/2,(e[1]+n[1])/2],v=[f[0]-p[0],f[1]-p[1]],y=m(p[0],p[1]),b=m(p[0]+v[0],p[1]+v[1]),x=m(p[0]-v[0],p[1]-v[1]),S=(b+x)/2-y,C=(b-x)/2,w=NaN;if(Math.abs(S)<=1e-15*(Math.abs(C)+Math.abs(y)))w=-y/C;else{let e=C*C-4*S*y;if(e<0)return!1;for(let t of[(-C-Math.sqrt(e))/(2*S),(-C+Math.sqrt(e))/(2*S)])t>0&&t<1&&!(w>0&&w<1)&&(w=t)}if(!(w>0&&w<1))return!1;if((o[0]*s[0]+o[1]*s[1])/(c*l)<-.17&&r<4){let t=[p[0]+w*v[0],p[1]+w*v[1]];return _(e,t,r+1)&&_(t,n,r+1)}let T=w/(1-w);return g.push([[e[0],e[1],t,1],[f[0]*T,f[1]*T,t*T,T],[n[0],n[1],t,1]]),!0};if(_(n,r,0)&&g.length)return{kind:`nurbs`,n:Pn({p:2,segs:g,breaks:[...g.map((e,t)=>t),g.length]})}}function Jn(e,t){let n=[];for(let r=0;r+1<e.length;r++){let i=e[r+1]-e[r],a=t[r];if(!(i>0)||!a)return;let o=[0,1,2,3].map(()=>[0,0,0,1]);for(let e=0;e<3;e++){let[t,n,r,s]=a.slice(e*4,e*4+4);o[0][e]=t,o[1][e]=t+n*i/3,o[2][e]=t+2*n*i/3+r*i*i/3,o[3][e]=t+n*i+r*i*i+s*i*i*i}n.push(o)}return n.length?{kind:`nurbs`,n:Pn({p:3,segs:n,breaks:[...e]})}:void 0}var Yn=[[1,0,0,0],[1,1/3,0,0],[1,2/3,1/3,0],[1,1,1,1]];function Xn(e,t,n){let r=e.length-1,i=t.length-1;if(r<1||i<1)return;for(let n of[e,t])for(let e=1;e<n.length;e++)if(!(n[e]>n[e-1]))return;let a=3*r+1,o=3*i+1,s=Array.from({length:a*o},()=>[0,0,0]),c=Array(a*o),l=Array(a*o).fill(0),u=0;for(let o=0;o<r;o++)for(let r=0;r<i;r++){let i=e[o+1]-e[o],d=t[r+1]-t[r],f=n(o,r);for(let e=0;e<=3;e++)for(let t=0;t<=3;t++){let n=[0,0,0];for(let r=0;r<=e;r++)for(let a=0;a<=t;a++){let o=Yn[e][r]*Yn[t][a]*i**r*d**a;for(let e=0;e<3;e++)n[e]+=o*f[16*e+4*a+r]}let p=(3*r+t)*a+3*o+e,m=c[p];m?u=Math.max(u,_n(m,n)):c[p]=n;for(let e=0;e<3;e++)s[p][e]+=n[e];l[p]++}}let d=e=>[e[0],...e.flatMap(e=>[e,e,e]),e[e.length-1]];return{surface:{pu:3,pv:3,U:d(e),V:d(t),nu:a,nv:o,P:s.map((e,t)=>Q(e,1/l[t]))},gap:u}}var Zn=e=>e.kind!==`conic`&&(e.kind!==`chain`||e.parts.every(Zn)),Qn=e=>e.kind===`conic`&&Math.abs(gn(e.X)-gn(e.Y))<=1e-9*gn(e.X)&&Math.abs(mn(e.X,e.Y))<=1e-9*mn(e.X,e.X);function $n(e){let t=e.breaks[0],n=e.breaks[e.breaks.length-1];return{p:e.p,segs:[...e.segs].reverse().map(e=>[...e].reverse()),breaks:[...e.breaks].reverse().map(e=>t+n-e)}}var er=e=>{let t=e.breaks[0],n=e.breaks[e.breaks.length-1];return{...e,breaks:e.breaks.map(e=>(e-t)/(n-t))}};function tr(e,t){let n=[],r=[e.breaks[0]];for(let i=0;i<e.segs.length;i++){let a=e.breaks[i+1],o=e.segs[i],s=e.breaks[i];for(let e of t)if(e>s+1e-12&&e<a-1e-12){let[t,i]=Mn(o,(e-s)/(a-s));n.push(t),r.push(e),o=i,s=e}n.push(o),r.push(a)}return{p:e.p,segs:n,breaks:r}}function nr(e,t,n,r){let i=e=>e.kind===`conic`?e.t1-e.t0:0;if(r?e.kind===`line`&&t.kind===`line`||Qn(e)&&Qn(t)&&Math.abs(i(e)-i(t))<1e-9:Zn(e)&&Zn(t)||e.kind===`conic`&&t.kind===`conic`&&Math.abs(i(e)-i(t))<1e-9){let r=In(e),i=In(t);if(r?.segs.length&&i?.segs.length){r=er(r),i=er(n?$n(i):i);let e=Math.max(r.p,i.p);r=Nn(r,e),i=Nn(i,e);let t=[...r.breaks,...i.breaks].sort((e,t)=>e-t),a=tr(r,t),o=tr(i,t);if(a.segs.length===o.segs.length&&a.segs.every((e,t)=>e.every((e,n)=>Math.abs(e[3]-o.segs[t][n][3])<=1e-12*Math.abs(e[3])))){let t=Pn(a),n=Pn(o);return{pu:e,pv:1,U:t.U,V:[0,0,1,1],nu:t.P.length,nv:2,P:[...t.P,...n.P],...t.W?{W:[...t.W,...t.W]}:{}}}}}let a=e=>e.kind===`chain`?e.parts.length:1,o=Math.min(256,16*Math.max(a(e),a(t))),s=(e,t)=>{let[n,i]=Cn(e);if(!r)return r=>$(e,t?i-r*(i-n):n+r*(i-n));let a=2048,o=[],s=[0],c=$(e,n);for(let t=0;t<=a;t++){let r=n+(i-n)*t/a,l=$(e,r);o.push(r),t&&s.push(s[t-1]+_n(l,c)),c=l}let l=s[a]||1;return n=>{let r=(t?1-n:n)*l,i=0,c=a;for(;c-i>1;){let e=i+c>>1;s[e]<=r?i=e:c=e}let u=s[c]>s[i]?(r-s[i])/(s[c]-s[i]):0;return $(e,o[i]+u*(o[c]-o[i]))}},c=[s(e,!1),s(t,n)].map(e=>{let t=1e-6,n=n=>{let r=Math.max(0,n-t),i=Math.min(1,n+t);return Q(pn(e(i),e(r)),1/(i-r))},r=[],i=[0];for(let t=0;t<o;t++){let a=t/o,s=(t+1)/o,c=e(a),l=e(s),u=(s-a)/3;r.push([c,Z(c,Q(n(a),u)),pn(l,Q(n(s),u)),l].map(e=>[...e,1])),i.push(s)}return Pn({p:3,segs:r,breaks:i})});return{pu:3,pv:1,U:c[0].U,V:[0,0,1,1],nu:c[0].P.length,nv:2,P:[...c[0].P,...c[1].P]}}var rr={1:[0,0,0],2:[1,0,0],3:[0,1,0],4:[0,0,1],5:[1,1,0],6:[1,0,1],7:[0,1,1],8:[1,1,1]};function ir(e){let n=an(e),r=n.global,i=r.millimetres/r.modelScale,a=sn(i),o=(r.maxCoordinate>0?r.maxCoordinate*i:1e3)||1e3,s=Math.max(1e-9*o,Math.min(r.resolution>0?r.resolution*i:1e-6*o,1e-4*o)),c=Math.max(1e-9*o,s*.01),l=new Xt,u=[],d=[],f=e=>{u.length<200&&u.push(e)},p=e=>/* @__PURE__ */ TypeError(`${e}; export the model again from the CAD tool`),m=e=>/* @__PURE__ */ TypeError(`${e}; export it as a B-spline curve or surface from the CAD tool`),h=e=>n.entities.get(e),g=(e,t,n=0)=>{let r=e.params[t];return typeof r==`number`?r:n},_=(e,t)=>{let n=g(e,t);return n>0?Math.trunc(n):0},v=(e,t)=>[g(e,t),g(e,t+1),g(e,t+2)],y=e=>`entity ${e.de} (type ${e.type}${e.form?` form ${e.form}`:``})`,b=(e,t)=>{if(e.params.length<t)throw p(`${y(e)} has ${e.params.length} parameters, fewer than the ${t} it needs`)},x=/* @__PURE__ */ new Map,S=(e,t=0)=>{if(!e)return on;let n=x.get(e);if(n)return n;let r=h(e);if(!r||r.type!==124||t>32)return f(`transformation matrix ${e} is missing or not a type 124 entity; ignored`),on;let i={r:[g(r,0),g(r,1),g(r,2),g(r,4),g(r,5),g(r,6),g(r,8),g(r,9),g(r,10)],t:[g(r,3),g(r,7),g(r,11)]},a=cn(S(r.transform,t+1),i);return x.set(e,a),a},C=(e,t)=>cn(t,S(e.transform)),w=(e,t,n=0)=>{let r=h(e);if(!r){f(`curve ${e} is missing`);return}if(n>16)throw p(`${y(r)}: curves nested too deeply`);let i=C(r,t),a=e=>e?En(e,i):void 0;switch(r.type){case 100:{b(r,7);let e=g(r,0),t=[g(r,1),g(r,2),e],n=[g(r,3),g(r,4),e],i=[g(r,5),g(r,6),e],o=_n(t,n);if(!(o>0))return;let s=Math.atan2(n[1]-t[1],n[0]-t[0]),c=Math.atan2(i[1]-t[1],i[0]-t[0]);for(;c<=s+1e-12;)c+=2*Math.PI;return _n(n,i)<=1e-12*o&&(c=s+2*Math.PI),a({kind:`conic`,c:t,X:[o,0,0],Y:[0,o,0],t0:s,t1:c})}case 102:{let e=g(r,0),t=[];for(let a=1;a<=e;a++){let e=h(_(r,a));if(!e||e.type===116||e.type===132)continue;let o=w(e.de,i,n+1);if(o)t.push(o);else throw p(`${y(r)}: its constituent ${e.de} (type ${e.type}) is not a curve`)}return t.length?t.length===1?t[0]:{kind:`chain`,parts:t}:void 0}case 104:{b(r,11);let e=qn([g(r,0),g(r,1),g(r,2),g(r,3),g(r,4),g(r,5)],g(r,6),[g(r,7),g(r,8)],[g(r,9),g(r,10)],r.form);if(!e)throw p(`${y(r)}: a degenerate conic`);return a(e)}case 106:{let e=g(r,0),t=g(r,1),n=[];if(r.form>=20&&r.form!==63)return;for(let i=0;i<t;i++)n.push(e===1?[g(r,3+2*i),g(r,4+2*i),g(r,2)]:e===2?v(r,2+3*i):v(r,2+6*i));return r.form===63&&n.length>2&&_n(n[0],n[n.length-1])>0&&n.push(n[0]),n.length>=2?a({kind:`poly`,pts:n}):void 0}case 110:return b(r,6),a({kind:`line`,a:v(r,0),b:v(r,3)});case 112:{let e=g(r,3),t=Array.from({length:e+1},(e,t)=>g(r,4+t)),n=Array.from({length:e},(t,n)=>Array.from({length:12},(t,i)=>g(r,5+e+12*n+i)));b(r,5+13*e);let i=Jn(t,n);if(!i)throw p(`${y(r)}: its breakpoints do not increase`);return a(i)}case 126:return a(T(r));case 130:{b(r,14);let e=w(_(r,0),i,n+1),t=g(r,1),a=g(r,5)*fn(i),o=g(r,7)*fn(i),s=g(r,6),l=g(r,8),u=vn(un(i,v(r,9))),d=g(r,12),f=g(r,13);if(!e)return;if(t===3)throw m(`${y(r)}: offsets given by a function curve are not supported`);if(!(gn(u)>0))throw p(`${y(r)}: no plane normal`);if(t===2&&g(r,4)===1)throw m(`${y(r)}: offsets varying with arc length are not supported`);let[h,x]=Cn(e),S=d<f?d:h,C=d<f?f:x,T=(C-S)*1e-6;return{kind:`nurbs`,n:Rn(n=>{let r=$(e,n),i=vn(pn($(e,Math.min(C,n+T)),$(e,Math.max(S,n-T)))),c=t===2&&l!==s?a+(o-a)*(n-s)/(l-s):a;return[r[0],r[1],r[2]].map((e,t)=>e+c*hn(u,i)[t])},S,C,c,8)}}case 142:{let e=_(r,3);return e?w(e,i,n+1):void 0}default:f(`${y(r)} is not a curve the converter reads; left out`);return}},T=e=>{let t=g(e,0),n=g(e,1),r=1+t-n+2*n;if(!(Number.isInteger(t)&&Number.isInteger(n)&&n>=1&&t>=n))throw p(`${y(e)}: upper index ${t} and degree ${n} do not make a B-spline`);b(e,15+r+4*t);let i=Array.from({length:r+1},(t,n)=>g(e,6+n)),a=g(e,4)===1,o=Array.from({length:t+1},(t,n)=>g(e,7+r+n,1)),s=Array.from({length:t+1},(n,i)=>v(e,8+r+t+3*i)),c=g(e,11+r+4*t),l=g(e,12+r+4*t);for(let t=1;t<i.length;t++)if(i[t]<i[t-1])throw p(`${y(e)}: its knots decrease`);if(o.some(e=>!(e>0)))throw p(`${y(e)}: a weight is not positive`);let u=i[n],d=i[t+1],f=!a&&o.some(e=>Math.abs(e-o[0])>1e-12*o[0]),m=c<l?Math.max(u,c):u,h=c<l?Math.min(d,l):d;return{kind:`nurbs`,n:{p:n,U:i,P:s,...f?{W:o}:{},t0:m,t1:h}}},ee=e=>w(e,on),E=(e,t)=>{let n=h(e);if(!n||n.type!==116)throw p(`point ${e} is missing or not a type 116 entity`);return ln(cn(t,S(n.transform)),v(n,0))},te=(e,t)=>{let n=h(e);if(!n||n.type!==123)throw p(`direction ${e} is missing or not a type 123 entity`);let r=vn(un(t,v(n,0)));if(!(gn(r)>0))throw p(`direction ${e} is zero`);return r},ne=(e,t,n=0)=>{let r=h(e);if(!r){f(`surface ${e} is missing`);return}if(n>8)throw p(`${y(r)}: surfaces nested too deeply`);let i=C(r,t),a=e=>Kn(e,i);switch(r.type){case 108:{b(r,4);let e=[g(r,0),g(r,1),g(r,2)],t=gn(e);if(!(t>0))throw p(`${y(r)}: its coefficients A, B and C are all zero`);return a({kind:`plane`,o:Q(e,g(r,3)/(t*t)),n:vn(e)})}case 114:{let e=g(r,2),t=g(r,3);if(!(Number.isInteger(e)&&Number.isInteger(t)&&e>=1&&t>=1))throw p(`${y(r)}: its segment counts ${e} and ${t} are not positive integers`);let n=(n,r)=>6+e+t+48*(n*(t+1)+r);b(r,n(e-1,t-1)+48);let o=Array.from({length:e+1},(e,t)=>g(r,4+t)),c=Array.from({length:t+1},(t,n)=>g(r,5+e+n)),l=Xn(o,c,(e,t)=>Array.from({length:48},(i,a)=>g(r,n(e,t)+a)));if(!l)throw p(`${y(r)}: its breakpoints do not increase`);let u=l.gap*fn(i);if(u>s)throw p(`${y(r)}: neighbouring patches are ${u} mm apart on their shared edge`);return a({kind:`nurbs`,s:l.surface,dom:[o[0],o[e],c[0],c[t]]})}case 118:{b(r,3);let e=w(_(r,0),i),t=w(_(r,1),i);if(!e||!t)throw p(`${y(r)}: a rail curve is missing`);return{kind:`nurbs`,s:nr(e,t,g(r,2)===1,r.form===0),dom:[0,1,0,1]}}case 120:{b(r,4);let e=w(_(r,0),i),t=w(_(r,1),i);if(!e||e.kind!==`line`)throw p(`${y(r)}: its axis is not a line`);if(!t)throw p(`${y(r)}: its generatrix is missing`);let n=vn(pn(e.b,e.a));if(!(gn(n)>0))throw p(`${y(r)}: its axis has no length`);return{kind:`revolution`,a:e.a,d:n,curve:t,sa:g(r,2),ta:g(r,3)}}case 122:{b(r,4);let e=w(_(r,0),i);if(!e)throw p(`${y(r)}: its directrix is missing`);return{kind:`extrusion`,curve:e,v:pn(ln(i,v(r,1)),wn(e))}}case 128:{let e=g(r,0),t=g(r,1),n=g(r,2),i=g(r,3),o=e-n+1+2*n,s=t-i+1+2*i,c=(1+e)*(1+t);if(!(n>=1&&i>=1&&e>=n&&t>=i&&Number.isInteger(e)&&Number.isInteger(t)))throw p(`${y(r)}: upper indices ${e}, ${t} and degrees ${n}, ${i} do not make a B-spline`);b(r,13+o+s+4*c);let l=Array.from({length:o+1},(e,t)=>g(r,9+t)),u=Array.from({length:s+1},(e,t)=>g(r,10+o+t)),d=Array.from({length:c},(e,t)=>g(r,11+o+s+t,1)),f=Array.from({length:c},(e,t)=>v(r,11+o+s+c+3*t)),m=11+o+s+4*c,h=g(r,6)===1;for(let e of[l,u])for(let t=1;t<e.length;t++)if(e[t]<e[t-1])throw p(`${y(r)}: its knots decrease`);if(d.some(e=>!(e>0)))throw p(`${y(r)}: a weight is not positive`);let _=!h&&d.some(e=>Math.abs(e-d[0])>1e-12*d[0]),[x,S,C,w]=[g(r,m),g(r,m+1),g(r,m+2),g(r,m+3)],T=[x<S?Math.max(x,l[n]):l[n],x<S?Math.min(S,l[e+1]):l[e+1],C<w?Math.max(C,u[i]):u[i],C<w?Math.min(w,u[t+1]):u[t+1]];return a({kind:`nurbs`,s:{pu:n,pv:i,U:l,V:u,nu:e+1,nv:t+1,P:f,..._?{W:d}:{}},dom:T})}case 140:{b(r,5);let e=ne(_(r,4),i,n+1);if(!e)throw p(`${y(r)}: its base surface is missing`);return{kind:`offset`,base:e,d:g(r,3)*fn(i)}}case 190:{let e=E(_(r,0),i),t=te(_(r,1),i);if(r.form===1&&_(r,2)){let n=te(_(r,2),i),a=vn(pn(n,Q(t,mn(n,t))));return{kind:`plane`,o:e,n:t,x:a,y:hn(t,a)}}return{kind:`plane`,o:e,n:t}}case 192:case 194:case 196:case 198:{let e=E(_(r,0),i),t=r.type===196,n=t?_(r,2)?te(_(r,2),i):[0,0,1]:te(_(r,1),i),a=r.type===192||r.type===196?3:4,o=r.form===1&&_(r,a)?te(_(r,a),i):yn(n),s=vn(pn(o,Q(n,mn(o,n)))),c=fn(i),l=(t?g(r,1):g(r,2))*c,u=r.type===194?g(r,3)*Math.PI/180:r.type===198?g(r,3)*c:0;if(!(l>0)&&r.type!==194)throw p(`${y(r)}: its radius is not positive`);return{kind:r.type===192?`cylinder`:r.type===194?`cone`:t?`sphere`:`torus`,o:e,x:s,y:hn(n,s),z:n,r:l,r2:u}}default:f(`${y(r)} is not a surface the converter reads; left out`);return}},D=e=>{let t=[],n=[];for(let r of e.U)t.length&&r===t[t.length-1]?n[n.length-1]++:(t.push(r),n.push(1));return l.spline({degrees:[e.p],counts:[e.P.length],knots:[t],multiplicities:[n],points:e.P,...e.W?{weights:e.W}:{}})},re=/* @__PURE__ */ new WeakMap,O=e=>{let t=re.get(e);if(t)return t;let n;if(e.kind===`line`){let t=pn(e.b,e.a);n=l.add(`LINE('',${l.point(e.a)},${l.add(`VECTOR('',${l.direction(vn(t))},${l.real(gn(t))})`)})`)}else if(e.kind===`conic`&&Math.abs(mn(e.X,e.Y))<=1e-12*mn(e.X,e.X)){let t=gn(e.X),r=gn(e.Y),i=l.axis(e.c,hn(e.X,e.Y),e.X);n=Math.abs(t-r)<=1e-12*t?l.add(`CIRCLE('',${i},${l.real(t)})`):l.add(`ELLIPSE('',${i},${l.real(t)},${l.real(r)})`)}else{let t=Ln(e);if(!t)throw p(`a curve with no points`);n=D(t)}return re.set(e,n),n},k=e=>{if(e.kind===`line`||e.kind===`nurbs`)return O(e);let t=Ln(e);if(!t)throw p(`a swept curve with no points`);return D(t)},A=[],j=/* @__PURE__ */ new WeakMap,M=e=>{let t=j.get(e);if(t)return t;let n;switch(e.kind){case`plane`:n=l.add(`PLANE('',${l.axis(e.o,e.n,e.x??yn(e.n))})`);break;case`cylinder`:n=l.add(`CYLINDRICAL_SURFACE('',${l.axis(e.o,e.z,e.x)},${l.real(e.r)})`);break;case`cone`:n=l.add(`CONICAL_SURFACE('',${l.axis(e.o,e.z,e.x)},${l.real(e.r)},${l.real(e.r2)})`);break;case`sphere`:n=l.add(`SPHERICAL_SURFACE('',${l.axis(e.o,e.z,e.x)},${l.real(e.r)})`);break;case`torus`:n=l.add(`TOROIDAL_SURFACE('',${l.axis(e.o,e.z,e.x)},${l.real(e.r)},${l.real(e.r2)})`);break;case`nurbs`:{let t=e=>{let t=[],n=[];for(let r of e)t.length&&r===t[t.length-1]?n[n.length-1]++:(t.push(r),n.push(1));return[t,n]},[r,i]=t(e.s.U),[a,o]=t(e.s.V);n=l.spline({degrees:[e.s.pu,e.s.pv],counts:[e.s.nu,e.s.nv],knots:[r,a],multiplicities:[i,o],points:e.s.P,...e.s.W?{weights:e.s.W}:{}});break}case`revolution`:{let t=k(e.curve);n=l.add(`SURFACE_OF_REVOLUTION('',${t},${l.add(`AXIS1_PLACEMENT('',${l.point(e.a)},${l.direction(e.d)})`)})`);break}case`extrusion`:{let t=k(e.curve);if(!(gn(e.v)>0))throw p(`a tabulated cylinder with no length`);n=l.add(`SURFACE_OF_LINEAR_EXTRUSION('',${t},${l.add(`VECTOR('',${l.direction(vn(e.v))},${l.real(gn(e.v))})`)})`);break}case`offset`:{let t=M(e.base);n=l.reserve(),A.push({id:n,baseId:t,base:e.base,d:e.d});break}}return j.set(e,n),n},oe=(e,t)=>{for(let n of e)if(_n(n.p,t)<=s)return n.id;let n=l.add(`VERTEX_POINT('',${l.point(t)})`);return e.push({p:t,id:n}),n},se=(e,t,n)=>{let r=[],i=[];for(let a of e){let e=wn(a.curve),o=Tn(a.curve),c=oe(t,e),u=oe(t,o);if(c===u&&Dn(a.curve)<=10*s)continue;let d=a.key?n.get(a.key):void 0;d||(d=l.add(`EDGE_CURVE('',${c},${u},${O(a.curve)},.T.)`),a.key&&n.set(a.key,d)),r.push(l.add(`ORIENTED_EDGE('',*,*,${d},${a.forward?`.T.`:`.F.`})`));let[f,p]=Cn(a.curve);for(let e=0;e<24;e++){let t=e/24;i.push($(a.curve,a.forward?f+(p-f)*t:p-(p-f)*t))}}if(r.length)return{loop:l.add(`EDGE_LOOP('',(${r.join(`,`)}))`),samples:i}},ce=(e,t=!1)=>{let n=On(e,s).map(e=>({curve:e,forward:!t}));return t?n.reverse():n},le=(e,t)=>On(e,0).map(e=>{let[n,r]=Cn(e);return{curve:{kind:`nurbs`,n:Rn(n=>{let r=$(e,n),i=Wn(t,r[0],r[1]);if(!i)throw p(`a parameter-space curve on a surface with no parameterization`);return i},n,r,c)},forward:!0}}),ue=e=>{let[t,n,r,i]=Un(e);if(![t,n,r,i].every(Number.isFinite))throw p(`an unbounded surface with no boundary`);let a=(t,n)=>Wn(e,t,n)??[0,0,0],o=(e,o)=>({kind:`nurbs`,n:o?Rn(t=>a(t,e),t,n,c):Rn(t=>a(e,t),r,i,c)}),l=e=>[.13,.5,.91].every(t=>_n(...e(t))<=s),u=l(e=>[a(t,r+(i-r)*e),a(n,r+(i-r)*e)]),d=l(e=>[a(t+(n-t)*e,r),a(t+(n-t)*e,i)]),f=o(r,!0),m=o(n,!1),h=d?f:o(i,!0),g=u?m:o(t,!1);return[{curve:f,forward:!0,key:d?`v`:void 0},{curve:m,forward:!0,key:u?`u`:void 0},{curve:h,forward:!1,key:d?`v`:void 0},{curve:g,forward:!1,key:u?`u`:void 0}]},de=(...e)=>{for(let t of e){if(!t||!t.color)continue;if(t.color>0){if(rr[t.color])return rr[t.color];continue}let e=h(-t.color);if(e?.type===314)return[g(e,0),g(e,1),g(e,2)].map(e=>Math.min(1,Math.max(0,e/100)))}},fe=[],N=(e,t,n,r)=>{let i={id:l.reserve(),surf:e,surfId:M(e),sign:t,bounds:[],color:r,where:n};return fe.push(i),i},P=(e,t,n)=>{let r=h(e);if(!r)throw p(`curve on surface ${e} is missing`);if(r.type!==142){let n=w(e,t);if(!n)throw p(`boundary ${e} is not a curve`);return ce(n)}let i=C(r,t),a=_(r,3)?w(_(r,3),i):void 0;if(a)return ce(a);let o=_(r,2)?ee(_(r,2)):void 0;if(!o)throw p(`${y(r)} has neither a model-space nor a parameter-space curve`);return le(o,n)},pe=(e,t)=>{let n=[],r=/* @__PURE__ */ new Map;for(let i of t){let t=se(i.segs,n,r);t&&e.bounds.push({loop:t.loop,outer:i.outer,samples:t.samples})}if(!e.bounds.length)throw p(`${e.where} has no boundary with any length`)},me=(e,t)=>{let n=C(e,t),r=ne(_(e,0),n);if(!r)throw p(`${y(e)}: its surface is missing`);let i=N(r,1,y(e),de(e,h(_(e,0)))),a=g(e,2),o=[{segs:g(e,1)===0||!_(e,3)?ue(r):P(_(e,3),n,r),outer:!0}];for(let t=0;t<a;t++)o.push({segs:P(_(e,4+t),n,r),outer:!1});pe(i,o)},he=(e,t)=>{let n=C(e,t),r=ne(_(e,1),n);if(!r)throw p(`${y(e)}: its surface is missing`);let i=N(r,1,y(e),de(e,h(_(e,1)))),a=[];for(let t=0;t<g(e,2);t++){let i=h(_(e,3+t));if(!i||i.type!==141)throw p(`${y(e)}: boundary ${_(e,3+t)} is not a type 141 entity`);let o=C(i,n),s=[],c=4;for(let e=0;e<g(i,3);e++){let e=_(i,c),t=g(i,c+1)===2,n=g(i,c+2),a=e?w(e,o):void 0;if(a)s.push(...ce(a,t));else if(n>0){let e=[];for(let t=0;t<n;t++){let n=ee(_(i,c+3+t));n&&e.push(...le(n,r))}s.push(...t?e.reverse().map(e=>({...e,forward:!e.forward})):e)}c+=3+n}a.push({segs:s})}pe(i,a)},ge=(e,t)=>{let n=C(e,t),r=ne(e.de,t),i=w(_(e,4),n);if(!r||!i)throw p(`${y(e)}: its boundary curve is missing`);pe(N(r,1,y(e),de(e)),[{segs:ce(i),outer:!0}])},_e=(e,t)=>{let n=ne(e.de,t);n&&pe(N(n,1,y(e),de(e)),[{segs:ue(n),outer:!0}])},ve=/* @__PURE__ */ new Map,ye=(e,t,n)=>{let r=`${e}:${t}`,i=ve.get(r);if(!i){let a=h(e);if(!a||a.type!==502)throw p(`vertex list ${e} is missing or not a type 502 entity`);if(!(t>=1&&t<=g(a,0)))throw p(`${y(a)} has no vertex ${t}`);let o=ln(n,v(a,1+3*(t-1)));i={id:l.add(`VERTEX_POINT('',${l.point(o)})`),p:o},ve.set(r,i)}return i},be=/* @__PURE__ */ new Map,F=(e,t,n)=>{let r=`${e}:${t}`,i=be.get(r);if(i)return i;let a=h(e);if(!a||a.type!==504)throw p(`edge list ${e} is missing or not a type 504 entity`);if(!(t>=1&&t<=g(a,0)))throw p(`${y(a)} has no edge ${t}`);let o=1+5*(t-1),c=w(_(a,o),n);if(!c)throw p(`${y(a)}: edge ${t} has no curve`);let u=ye(_(a,o+1),g(a,o+2),n),d=ye(_(a,o+3),g(a,o+4),n),f=On(c,s),m=[],v=u.id;return f.forEach((e,t)=>{let n=t===f.length-1?d.id:l.add(`VERTEX_POINT('',${l.point(Tn(e))})`);m.push(l.add(`EDGE_CURVE('',${v},${n},${O(e)},.T.)`)),v=n}),be.set(r,m),m},xe=(e,t)=>{let n=h(e);if(!n||n.type!==508)throw p(`loop ${e} is missing or not a type 508 entity`);let r=[],i,a=1;for(let e=0;e<g(n,0);e++){let e=g(n,a),o=_(n,a+1),s=g(n,a+2),c=g(n,a+3)!==0,u=g(n,a+4);if(e===1)i=ye(o,s,t).id;else{let e=F(o,s,t).map(e=>l.add(`ORIENTED_EDGE('',*,*,${e},${c?`.T.`:`.F.`})`));r.push(...c?e:e.reverse())}a+=5+2*u}return r.length?l.add(`EDGE_LOOP('',(${r.join(`,`)}))`):i?l.add(`VERTEX_LOOP('',${i})`):void 0},Se=(e,t,n,r)=>{let i=h(e);if(!i||i.type!==510)throw p(`face ${e} is missing or not a type 510 entity`);let a=ne(_(i,0),n);if(!a)throw p(`${y(i)}: its surface is missing`);let o=g(i,2)!==0,s=[];for(let e=0;e<g(i,1);e++){let r=xe(_(i,3+e),n);r&&s.push({loop:r,outer:e===0&&o,orientation:t>0})}if(!s.length)throw p(`${y(i)} has no loops`);let c=N(a,t,y(i),de(i,...r));return c.bounds.push(...s),c.id},Ce=(e,t,n,r)=>{let i=h(e);if(!i||i.type!==514)throw p(`shell ${e} is missing or not a type 514 entity`);let a=[];for(let e=0;e<g(i,0);e++){let o=g(i,2+2*e)!==0;try{a.push(Se(_(i,1+2*e),(o?1:-1)*(t?-1:1),n,[i,...r]))}catch(t){f(`face ${_(i,1+2*e)} of ${y(i)} left out: ${t instanceof Error?t.message:t}`)}}return{faces:a,closed:i.form!==2}},we=/* @__PURE__ */ new Set;for(let e of n.entities.values()){let t=(...e)=>e.forEach(e=>e>0&&we.add(e));switch(e.type){case 186:t(_(e,0),...Array.from({length:g(e,2)},(t,n)=>_(e,3+2*n)));break;case 144:t(_(e,0));break;case 143:t(_(e,1));break;case 510:case 141:t(_(e,e.type===510?0:2));break;case 142:t(_(e,1));break;case 140:t(_(e,4));break;case 308:t(...Array.from({length:g(e,2)},(t,n)=>_(e,3+n)))}}let Te=[],Ee=[],I=[],L=0,R=0;for(let e of n.entities.values()){if((e.type===408||e.type===412||e.type===414||e.type===430)&&R++,![186,514,144,143,108,114,118,120,122,128,140].includes(e.type)||we.has(e.de)||e.use===5||e.use===6||e.type===108&&e.form!==1)continue;if(e.blanked){L++;continue}let n=fe.length;try{if(e.type===186){let t=C(e,a),n=Ce(_(e,0),g(e,1)===0,t,[e]),r=Array.from({length:g(e,2)},(n,r)=>Ce(_(e,3+2*r),g(e,4+2*r)===0,t,[e]));n.faces.length&&Te.push({outer:n,voids:r.filter(e=>e.faces.length)})}else if(e.type===514){let t=Ce(e.de,!1,C(e,a),[]);t.faces.length&&Ee.push(t)}else e.type===144?me(e,a):e.type===143?he(e,a):e.type===108?ge(e,a):_e(e,a),I.push(...fe.slice(n).map(e=>e.id))}catch(r){fe.length=n,r instanceof t&&d.push(r),f(`${y(e)} left out: ${r instanceof Error?r.message:String(r)}`)}}L&&f(`${L} blanked (hidden) surfaces or solids left out`),R&&f(`${R} subfigure or solid instances left out; the converter does not place instances yet`);let z,B=/* @__PURE__ */ new Map,De=/* @__PURE__ */ new Map,V=()=>{z=new ie(ae(l.draft())),B.clear(),De.clear()},H=e=>{let t=B.get(e);if(!t){let n=z;B.set(e,t=lt(n,Number(e.slice(1)),1,e=>{let t=De.get(e);return t||De.set(e,t=Ge(n,e)),t}))}return t},U=(e,t)=>{let n=H(e),[r,i,a,c]=Un(t),l=(e,t,n)=>Number.isFinite(e)&&Number.isFinite(t)?e+(t-e)*n:Number.isFinite(e)?e+n:Number.isFinite(t)?t-n:n-.5;for(let[e,u]of[[.5,.5],[.31,.62],[.73,.27],[.12,.88]]){let d=l(r,i,e),f=l(a,c,u),p=t.kind===`plane`&&!t.x?t.o:Wn(t,d,f),m=Gn(t,d,f);if(!p||!m)continue;let[h,g]=n.parameters(p);if(_n(n.at(h,g),p)>Math.max(1e3*s,1e-6*o))continue;let _=mn(n.normal(h,g),m);if(Math.abs(_)>.5)return _>0?1:-1}return 1},Oe=(e,t,n)=>n?e+Math.round((t-e)/n)*n:e,W=(e,t)=>{let n,r=0,i=t.map(t=>{let[r,i]=e.parameters(t,n);return n&&(r=Oe(r,n[0],e.uPeriod),i=Oe(i,n[1],e.vPeriod)),n=[r,i],n}),a=i[0],o=i[i.length-1];if(!(e.uPeriod&&Math.abs(Oe(a[0],o[0],e.uPeriod)-a[0])>e.uPeriod/2||e.vPeriod&&Math.abs(Oe(a[1],o[1],e.vPeriod)-a[1])>e.vPeriod/2)){for(let e=0;e<i.length;e++){let t=i[e],n=i[(e+1)%i.length];r+=t[0]*n[1]-n[0]*t[1]}return r/2}};for(;A.length;){V();let e=new Set(A.map(e=>e.id)),t=A.filter(t=>!e.has(t.baseId));if(!t.length)break;for(let e of t)l.fill(e.id,`OFFSET_SURFACE('',${e.baseId},${l.real(e.d*U(e.baseId,e.base))},.F.)`),A.splice(A.indexOf(e),1)}fe.length&&V();for(let e of fe)if(e.bounds.length)try{let t=U(e.surfId,e.surf)*e.sign>0,n=H(e.surfId),r=e.bounds.map(e=>e.orientation===void 0&&e.samples?W(n,e.samples):void 0);if(e.bounds.some(e=>e.outer===void 0)){let t=-1;r.forEach((e,n)=>{e!==void 0&&(t<0||Math.abs(e)>Math.abs(r[t]))&&(t=n)}),e.bounds.forEach((e,n)=>{e.outer=n===(t<0?0:t)})}let i=e.bounds.map((e,n)=>{let i=r[n],a=i===void 0?void 0:i*(t?1:-1),o=e.orientation??(a===void 0||a===0?!0:e.outer?a>0:a<0);return l.add(`${e.outer?`FACE_OUTER_BOUND`:`FACE_BOUND`}('',${e.loop},${o?`.T.`:`.F.`})`)});l.fill(e.id,`ADVANCED_FACE('',(${i.join(`,`)}),${e.surfId},${t?`.T.`:`.F.`})`),e.color&&l.style(e.id,e.color),e.filled=!0}catch(t){f(`${e.where} left out: ${t instanceof Error?t.message:String(t)}`)}let ke=new Set(fe.filter(e=>e.filled).map(e=>e.id)),Ae=e=>e.filter(e=>ke.has(e)),G=[],K=0,q=0,je=0;for(let e of Te){let t=Ae(e.outer.faces);if(!t.length)continue;K+=t.length;let n=l.add(`CLOSED_SHELL('',(${t.join(`,`)}))`),r=e.voids.map(e=>Ae(e.faces)).filter(e=>e.length).map(e=>(K+=e.length,l.add(`ORIENTED_CLOSED_SHELL('',*,${l.add(`CLOSED_SHELL('',(${e.join(`,`)}))`)},.T.)`)));G.push(r.length?l.add(`BREP_WITH_VOIDS('',${n},(${r.join(`,`)}))`):l.add(`MANIFOLD_SOLID_BREP('',${n})`)),q++}for(let e of Ee){let t=Ae(e.faces);t.length&&(K+=t.length,e.closed?(G.push(l.add(`MANIFOLD_SOLID_BREP('',${l.add(`CLOSED_SHELL('',(${t.join(`,`)}))`)})`)),q++):(G.push(l.add(`SHELL_BASED_SURFACE_MODEL('',(${l.add(`OPEN_SHELL('',(${t.join(`,`)}))`)}))`)),je++))}let Me=Ae(I);if(Me.length&&(K+=Me.length,G.push(l.add(`SHELL_BASED_SURFACE_MODEL('',(${l.add(`OPEN_SHELL('',(${Me.join(`,`)}))`)}))`))),!G.length&&d.length)throw d[0];if(!G.length){let e=u.length?` (${u[0]})`:``;throw TypeError(`Invalid IGES file: no surfaces or solids to convert among its ${n.entities.size} entities${e}; export surfaces or solids, not only wireframe`)}return{step:l.finish(G,{unit:`mm`,source:`IGES ${r.system||r.preprocessor||r.sender}`.trim()}),global:r,unit:i,counts:{solids:q,shells:je,faces:K},warnings:u}}var ar=12,or=14,sr=514,cr=[],lr=0;for(let e=4;e<or;e++)cr[e]=lr,lr+=1<<(e>>1)-1;688+lr+16+sr+sr,Uint8Array.from({length:ar},(e,t)=>t<4?0:t<10?t-3:t-6),[[.5773502691896258,.6411923197284924,.5058722339651233],[-.4134217846547371,.7718923469342184,-.4829483254102233],[.8123659372189244,-.3348123480912773,.4775129834719122]].map(e=>U(e)),(()=>{let e=[],t=[];for(let n=1;n<=16;n++){let r=Math.cos(Math.PI*(n-.25)/16.5),i=0;for(let e=0;e<100;e++){let e=1,t=r;for(let n=2;n<=16;n++)[e,t]=[t,((2*n-1)*r*t-(n-1)*e)/n];i=16*(r*t-e)/(r*r-1);let n=t/i;if(r-=n,Math.abs(n)<1e-16)break}e.unshift(r),t.unshift(2/((1-r*r)*i*i))}return{x:e,w:t}})(),.5-Math.sqrt(.15),.5+Math.sqrt(.15),[[.6234898018587335,.5384693101056831,.5667004719618033],[-.3826834323650898,.8314696123025452,-.4029733920661247],[.7933533402912352,-.4067366430758002,.4524424391035483]].map(e=>U(e));var ur=2**-53;(7+56*ur)*ur;function dr(e,t={}){let n=new ie(ae(e));return{header:n.header,file:n,...N(n,t)}}function fr(e,t={}){let n=new Ft(e.file,e.faceColors,t);return e.bodies.map(e=>n.body(e))}function pr(e,t={}){let n=ir(e),r=dr(n.step,t);return{...r,warnings:[...n.warnings,...r.warnings]}}var mr=`ISO-10303-21;\r
HEADER;\r
FILE_DESCRIPTION(('test part'),'2;1');\r
FILE_NAME('part.stp','2026-10-17T12:00:00',('Margo'),('Margo'),'hand','margo tests','');\r
FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 3 1 1 }'));\r
ENDSEC;\r
DATA;\r
#1=APPLICATION_CONTEXT('automotive design');\r
#2=PRODUCT_CONTEXT('',#1,'mechanical');\r
#3=PRODUCT('P-100','Bracket \\X2\\00E9\\X0\\ ''A''','',(#2));\r
#4=PRODUCT_DEFINITION_FORMATION('','',#3);\r
#5=PRODUCT_DEFINITION_CONTEXT('part definition',#1,'design');\r
#6=PRODUCT_DEFINITION('design','',#4,#5);\r
#7=PRODUCT_DEFINITION_SHAPE('','',#6);\r
#8=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.));\r
#9=(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.));\r
#10=(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNIT_ASSIGNED_CONTEXT((#8,#9))REPRESENTATION_CONTEXT('',''));\r
#11=CARTESIAN_POINT('',(0.,0.,0.));\r
#12=AXIS2_PLACEMENT_3D('',#11,$,$);\r
#13=SHAPE_REPRESENTATION('',(#12),#10);\r
#14=SHAPE_DEFINITION_REPRESENTATION(#7,#13);\r
/* a triangle face on z = 0 */\r
#20=CARTESIAN_POINT('',(0.,0.,0.));\r
#21=CARTESIAN_POINT('',(10.,0.,0.));\r
#22=CARTESIAN_POINT('',(0.,10.,0.));\r
#23=VERTEX_POINT('',#20);\r
#24=VERTEX_POINT('',#21);\r
#25=VERTEX_POINT('',#22);\r
#26=DIRECTION('',(1.,0.,0.));\r
#27=VECTOR('',#26,1.);\r
#28=LINE('',#20,#27);\r
#29=EDGE_CURVE('',#23,#24,#28,.T.);\r
#30=DIRECTION('',(-0.7071067811865476,0.7071067811865476,0.));\r
#31=VECTOR('',#30,1.E0);\r
#32=LINE('',#21,#31);\r
#33=EDGE_CURVE('',#24,#25,#32,.T.);\r
#34=DIRECTION('',(0.,-1.,0.));\r
#35=VECTOR('',#34,1.);\r
#36=LINE('',#22,#35);\r
#37=EDGE_CURVE('',#25,#23,#36,.T.);\r
#38=ORIENTED_EDGE('',*,*,#29,.T.);\r
#39=ORIENTED_EDGE('',*,*,#33,.T.);\r
#40=ORIENTED_EDGE('',*,*,#37,.T.);\r
#41=EDGE_LOOP('',(#38,#39,#40));\r
#42=FACE_OUTER_BOUND('',#41,.T.);\r
#43=PLANE('',#12);\r
#44=ADVANCED_FACE('',(#42),#43,.T.);\r
#45=CLOSED_SHELL('',(#44));\r
#46=MANIFOLD_SOLID_BREP('Body 1',#45);\r
#47=ADVANCED_BREP_SHAPE_REPRESENTATION('',(#46,#12),#10);\r
#48=SHAPE_REPRESENTATION_RELATIONSHIP('','',#13,#47);\r
#50=COLOUR_RGB('',0.8,0.2,0.1);\r
#51=FILL_AREA_STYLE_COLOUR('',#50);\r
#52=FILL_AREA_STYLE('',(#51));\r
#53=SURFACE_STYLE_FILL_AREA(#52);\r
#54=SURFACE_SIDE_STYLE('',(#53));\r
#55=SURFACE_STYLE_USAGE(.BOTH.,#54);\r
#56=PRESENTATION_STYLE_ASSIGNMENT((#55));\r
#57=STYLED_ITEM('color',(#56),#46);\r
#60=PRODUCT('ASM-1','Assembly','',(#2));\r
#61=PRODUCT_DEFINITION_FORMATION('','',#60);\r
#62=PRODUCT_DEFINITION('design','',#61,#5);\r
#63=PRODUCT_DEFINITION_SHAPE('','',#62);\r
#64=CARTESIAN_POINT('',(100.,0.,0.));\r
#65=DIRECTION('',(0.,0.,1.));\r
#66=DIRECTION('',(0.,1.,0.));\r
#67=AXIS2_PLACEMENT_3D('',#64,#65,#66);\r
#68=SHAPE_REPRESENTATION('',(#12,#67),#10);\r
#69=SHAPE_DEFINITION_REPRESENTATION(#63,#68);\r
#70=NEXT_ASSEMBLY_USAGE_OCCURRENCE('1','Bracket','',#62,#6,$);\r
#71=PRODUCT_DEFINITION_SHAPE('','',#70);\r
#72=ITEM_DEFINED_TRANSFORMATION('','',#12,#67);\r
#73=(REPRESENTATION_RELATIONSHIP('','',#13,#68)REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION(#72)SHAPE_REPRESENTATION_RELATIONSHIP());\r
#74=CONTEXT_DEPENDENT_SHAPE_REPRESENTATION(#73,#71);\r
ENDSEC;
END-ISO-10303-21;
`,hr=`Margo brep test file, written from the IGES 5.3 specification.          S      1\r
1H,,1H;,10HMARGO-TEST,8Htest.igs,18HMargo engine tests,3H1.0,32,38,6,   G      1\r
308,15,10HMARGO-TEST,1,2,2HMM,1,0.01,15H20261024.120000,0.000001,100,   G      2\r
11HMargo tests,5HMargo,11,0,15H20261024.120000;                         G      3\r
     128       1       0       0       0       0       0       000010000D      1\r
     128       0               2       0                               0D      2\r
     124       3       0       0       0       0       0       000010000D      3\r
     124       0               1       0                               0D      4\r
     104       4       0       0       0       0       3       000010000D      5\r
     104       0               1       3                               0D      6\r
     124       5       0       0       0       0       0       000010000D      7\r
     124       0               1       0                               0D      8\r
     104       6       0       0       0       0       7       000010000D      9\r
     104       0               2       2                               0D     10\r
     110       8       0       0       0       0       0       000010000D     11\r
     110       0               1       0                               0D     12\r
     110       9       0       0       0       0       0       000010000D     13\r
     110       0               1       0                               0D     14\r
     102      10       0       0       0       0       0       000010000D     15\r
     102       0               1       0                               0D     16\r
     142      11       0       0       0       0       0       000010000D     17\r
     142       0               1       0                               0D     18\r
     144      12       0       0       0       0       0       000000000D     19\r
     144       0               1       0                               0D     20\r
128,1,1,1,1,0,0,1,0,0,0,0,1,1,0,0,1,1,1,1,1,1,-5,-5,0,15,-5,0,         1P      1\r
-5,15,0,15,15,0,0,1,0,1;                                               1P      2\r
124,1,0,0,5,0,1,0,12.5,0,0,1,0;                                        3P      3\r
104,0.1,0,0,0,1,0,0,5,-2.5,-5,-2.5;                                    5P      4\r
124,1,0,0,1.4142135623730951,0,1,0,5,0,0,1,0;                          7P      5\r
104,25,0,-1,0,0,-25,0,-1.4142135623730951,5,-1.4142135623730951,       9P      6\r
-5;                                                                    9P      7\r
110,0,0,0,10,0,0;                                                     11P      8\r
110,10,0,0,10,10,0;                                                   13P      9\r
102,4,11,13,5,9;                                                      15P     10\r
142,0,1,0,15,2;                                                       17P     11\r
144,1,1,0,17;                                                         19P     12\r
S      1G      3D     20P     12                                        T      1\r
`,gr=`Margo brep test file, written from the IGES 5.3 specification.          S      1\r
1H,,1H;,10HMARGO-TEST,8Htest.igs,18HMargo engine tests,3H1.0,32,38,6,   G      1\r
308,15,10HMARGO-TEST,1,2,2HMM,1,0.01,15H20261024.120000,0.000001,100,   G      2\r
11HMargo tests,5HMargo,11,0,15H20261024.120000;                         G      3\r
     186       1       0       0       0       0       0       000000000D      1\r
     186       0               1       0                               0D      2\r
     514       2       0       0       0       0       0       000010000D      3\r
     514       0               1       1                               0D      4\r
     502       3       0       0       0       0       0       000010000D      5\r
     502       0               1       1                               0D      6\r
     100       4       0       0       0       0       0       000010000D      7\r
     100       0               1       0                               0D      8\r
     100       5       0       0       0       0       0       000010000D      9\r
     100       0               1       0                               0D     10\r
     110       6       0       0       0       0       0       000010000D     11\r
     110       0               1       0                               0D     12\r
     504       7       0       0       0       0       0       000010000D     13\r
     504       0               1       1                               0D     14\r
     116       8       0       0       0       0       0       000010000D     15\r
     116       0               1       0                               0D     16\r
     123       9       0       0       0       0       0       000010000D     17\r
     123       0               1       0                               0D     18\r
     123      10       0       0       0       0       0       000010000D     19\r
     123       0               1       0                               0D     20\r
     192      11       0       0       0       0       0       000010000D     21\r
     192       0               1       1                               0D     22\r
     116      12       0       0       0       0       0       000010000D     23\r
     116       0               1       0                               0D     24\r
     123      13       0       0       0       0       0       000010000D     25\r
     123       0               1       0                               0D     26\r
     190      14       0       0       0       0       0       000010000D     27\r
     190       0               1       0                               0D     28\r
     116      15       0       0       0       0       0       000010000D     29\r
     116       0               1       0                               0D     30\r
     123      16       0       0       0       0       0       000010000D     31\r
     123       0               1       0                               0D     32\r
     190      17       0       0       0       0       0       000010000D     33\r
     190       0               1       0                               0D     34\r
     508      18       0       0       0       0       0       000010000D     35\r
     508       0               1       1                               0D     36\r
     510      19       0       0       0       0       0       000010000D     37\r
     510       0               1       1                               0D     38\r
     508      20       0       0       0       0       0       000010000D     39\r
     508       0               1       1                               0D     40\r
     510      21       0       0       0       0       0       000010000D     41\r
     510       0               1       1                               0D     42\r
     508      22       0       0       0       0       0       000010000D     43\r
     508       0               1       1                               0D     44\r
     510      23       0       0       0       0       0       000010000D     45\r
     510       0               1       1                               0D     46\r
186,3,1,0;                                                             1P      1\r
514,3,37,1,41,1,45,1;                                                  3P      2\r
502,2,5,0,0,5,0,8;                                                     5P      3\r
100,0,0,0,5,0,5,0;                                                     7P      4\r
100,8,0,0,5,0,5,0;                                                     9P      5\r
110,5,0,0,5,0,8;                                                      11P      6\r
504,3,7,5,1,5,1,9,5,2,5,2,11,5,1,5,2;                                 13P      7\r
116,0,0,0,0;                                                          15P      8\r
123,0,0,1;                                                            17P      9\r
123,1,0,0;                                                            19P     10\r
192,15,17,5,19;                                                       21P     11\r
116,0,0,0,0;                                                          23P     12\r
123,0,0,-1;                                                           25P     13\r
190,23,25;                                                            27P     14\r
116,0,0,8,0;                                                          29P     15\r
123,0,0,1;                                                            31P     16\r
190,29,31;                                                            33P     17\r
508,4,0,13,1,1,0,0,13,3,1,0,0,13,2,0,0,0,13,3,0,0;                    35P     18\r
510,21,1,1,35;                                                        37P     19\r
508,1,0,13,1,0,0;                                                     39P     20\r
510,27,1,1,39;                                                        41P     21\r
508,1,0,13,2,1,0;                                                     43P     22\r
510,33,1,1,43;                                                        45P     23\r
S      1G      3D     46P     23                                        T      1\r
`,_r=`ISO-10303-21;\r
HEADER;\r
FILE_DESCRIPTION(('Mounting plate, 80 x 50 x 8 mm'),'2;1');\r
FILE_NAME('plate.step','2026-10-25T00:00:00',('Margo Engine'),(''),'','','');\r
FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));\r
ENDSEC;\r
DATA;\r
#1=CARTESIAN_POINT('',(0.,0.,0.));\r
#2=CARTESIAN_POINT('',(80.,0.,0.));\r
#3=CARTESIAN_POINT('',(0.,50.,0.));\r
#4=CARTESIAN_POINT('',(80.,50.,0.));\r
#5=CARTESIAN_POINT('',(0.,0.,8.));\r
#6=CARTESIAN_POINT('',(80.,0.,8.));\r
#7=CARTESIAN_POINT('',(0.,50.,8.));\r
#8=CARTESIAN_POINT('',(80.,50.,8.));\r
#9=VERTEX_POINT('',#1);\r
#10=VERTEX_POINT('',#2);\r
#11=VERTEX_POINT('',#3);\r
#12=VERTEX_POINT('',#4);\r
#13=VERTEX_POINT('',#5);\r
#14=VERTEX_POINT('',#6);\r
#15=VERTEX_POINT('',#7);\r
#16=VERTEX_POINT('',#8);\r
#17=DIRECTION('',(0.,0.,-1.));\r
#18=DIRECTION('',(1.,0.,0.));\r
#19=AXIS2_PLACEMENT_3D('',#1,#17,#18);\r
#20=PLANE('',#19);\r
#21=DIRECTION('',(0.,1.,0.));\r
#22=VECTOR('',#21,50.);\r
#23=LINE('',#1,#22);\r
#24=EDGE_CURVE('',#9,#11,#23,.T.);\r
#25=ORIENTED_EDGE('',*,*,#24,.T.);\r
#26=DIRECTION('',(1.,0.,0.));\r
#27=VECTOR('',#26,80.);\r
#28=LINE('',#3,#27);\r
#29=EDGE_CURVE('',#11,#12,#28,.T.);\r
#30=ORIENTED_EDGE('',*,*,#29,.T.);\r
#31=DIRECTION('',(0.,1.,0.));\r
#32=VECTOR('',#31,50.);\r
#33=LINE('',#2,#32);\r
#34=EDGE_CURVE('',#10,#12,#33,.T.);\r
#35=ORIENTED_EDGE('',*,*,#34,.F.);\r
#36=DIRECTION('',(1.,0.,0.));\r
#37=VECTOR('',#36,80.);\r
#38=LINE('',#1,#37);\r
#39=EDGE_CURVE('',#9,#10,#38,.T.);\r
#40=ORIENTED_EDGE('',*,*,#39,.F.);\r
#41=EDGE_LOOP('',(#25,#30,#35,#40));\r
#42=FACE_OUTER_BOUND('',#41,.T.);\r
#43=ADVANCED_FACE('',(#42),#20,.T.);\r
#44=DIRECTION('',(0.,0.,1.));\r
#45=DIRECTION('',(1.,0.,0.));\r
#46=AXIS2_PLACEMENT_3D('',#5,#44,#45);\r
#47=PLANE('',#46);\r
#48=DIRECTION('',(1.,0.,0.));\r
#49=VECTOR('',#48,80.);\r
#50=LINE('',#5,#49);\r
#51=EDGE_CURVE('',#13,#14,#50,.T.);\r
#52=ORIENTED_EDGE('',*,*,#51,.T.);\r
#53=DIRECTION('',(0.,1.,0.));\r
#54=VECTOR('',#53,50.);\r
#55=LINE('',#6,#54);\r
#56=EDGE_CURVE('',#14,#16,#55,.T.);\r
#57=ORIENTED_EDGE('',*,*,#56,.T.);\r
#58=DIRECTION('',(1.,0.,0.));\r
#59=VECTOR('',#58,80.);\r
#60=LINE('',#7,#59);\r
#61=EDGE_CURVE('',#15,#16,#60,.T.);\r
#62=ORIENTED_EDGE('',*,*,#61,.F.);\r
#63=DIRECTION('',(0.,1.,0.));\r
#64=VECTOR('',#63,50.);\r
#65=LINE('',#5,#64);\r
#66=EDGE_CURVE('',#13,#15,#65,.T.);\r
#67=ORIENTED_EDGE('',*,*,#66,.F.);\r
#68=EDGE_LOOP('',(#52,#57,#62,#67));\r
#69=FACE_OUTER_BOUND('',#68,.T.);\r
#70=ADVANCED_FACE('',(#69),#47,.T.);\r
#71=DIRECTION('',(0.,-1.,0.));\r
#72=DIRECTION('',(1.,0.,0.));\r
#73=AXIS2_PLACEMENT_3D('',#1,#71,#72);\r
#74=PLANE('',#73);\r
#75=ORIENTED_EDGE('',*,*,#39,.T.);\r
#76=DIRECTION('',(0.,0.,1.));\r
#77=VECTOR('',#76,8.);\r
#78=LINE('',#2,#77);\r
#79=EDGE_CURVE('',#10,#14,#78,.T.);\r
#80=ORIENTED_EDGE('',*,*,#79,.T.);\r
#81=ORIENTED_EDGE('',*,*,#51,.F.);\r
#82=DIRECTION('',(0.,0.,1.));\r
#83=VECTOR('',#82,8.);\r
#84=LINE('',#1,#83);\r
#85=EDGE_CURVE('',#9,#13,#84,.T.);\r
#86=ORIENTED_EDGE('',*,*,#85,.F.);\r
#87=EDGE_LOOP('',(#75,#80,#81,#86));\r
#88=FACE_OUTER_BOUND('',#87,.T.);\r
#89=ADVANCED_FACE('',(#88),#74,.T.);\r
#90=DIRECTION('',(0.,1.,0.));\r
#91=DIRECTION('',(1.,0.,0.));\r
#92=AXIS2_PLACEMENT_3D('',#3,#90,#91);\r
#93=PLANE('',#92);\r
#94=DIRECTION('',(0.,0.,1.));\r
#95=VECTOR('',#94,8.);\r
#96=LINE('',#3,#95);\r
#97=EDGE_CURVE('',#11,#15,#96,.T.);\r
#98=ORIENTED_EDGE('',*,*,#97,.T.);\r
#99=ORIENTED_EDGE('',*,*,#61,.T.);\r
#100=DIRECTION('',(0.,0.,1.));\r
#101=VECTOR('',#100,8.);\r
#102=LINE('',#4,#101);\r
#103=EDGE_CURVE('',#12,#16,#102,.T.);\r
#104=ORIENTED_EDGE('',*,*,#103,.F.);\r
#105=ORIENTED_EDGE('',*,*,#29,.F.);\r
#106=EDGE_LOOP('',(#98,#99,#104,#105));\r
#107=FACE_OUTER_BOUND('',#106,.T.);\r
#108=ADVANCED_FACE('',(#107),#93,.T.);\r
#109=DIRECTION('',(-1.,0.,0.));\r
#110=DIRECTION('',(0.,1.,0.));\r
#111=AXIS2_PLACEMENT_3D('',#1,#109,#110);\r
#112=PLANE('',#111);\r
#113=ORIENTED_EDGE('',*,*,#85,.T.);\r
#114=ORIENTED_EDGE('',*,*,#66,.T.);\r
#115=ORIENTED_EDGE('',*,*,#97,.F.);\r
#116=ORIENTED_EDGE('',*,*,#24,.F.);\r
#117=EDGE_LOOP('',(#113,#114,#115,#116));\r
#118=FACE_OUTER_BOUND('',#117,.T.);\r
#119=ADVANCED_FACE('',(#118),#112,.T.);\r
#120=DIRECTION('',(1.,0.,0.));\r
#121=DIRECTION('',(0.,1.,0.));\r
#122=AXIS2_PLACEMENT_3D('',#2,#120,#121);\r
#123=PLANE('',#122);\r
#124=ORIENTED_EDGE('',*,*,#34,.T.);\r
#125=ORIENTED_EDGE('',*,*,#103,.T.);\r
#126=ORIENTED_EDGE('',*,*,#56,.F.);\r
#127=ORIENTED_EDGE('',*,*,#79,.F.);\r
#128=EDGE_LOOP('',(#124,#125,#126,#127));\r
#129=FACE_OUTER_BOUND('',#128,.T.);\r
#130=ADVANCED_FACE('',(#129),#123,.T.);\r
#131=CLOSED_SHELL('',(#43,#70,#89,#108,#119,#130));\r
#132=MANIFOLD_SOLID_BREP('Plate',#131);\r
#133=CARTESIAN_POINT('',(0.,0.,0.));\r
#134=DIRECTION('',(0.,0.,1.));\r
#135=DIRECTION('',(1.,0.,0.));\r
#136=AXIS2_PLACEMENT_3D('',#133,#134,#135);\r
#137=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.));\r
#138=(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.));\r
#139=(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT());\r
#140=UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-05),#137,'distance_accuracy_value','');\r
#141=(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#140))GLOBAL_UNIT_ASSIGNED_CONTEXT((#137,#138,#139))REPRESENTATION_CONTEXT('',''));\r
#142=ADVANCED_BREP_SHAPE_REPRESENTATION('Plate',(#136,#132),#141);\r
#143=APPLICATION_CONTEXT('automotive design');\r
#144=APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,#143);\r
#145=PRODUCT_CONTEXT('',#143,'mechanical');\r
#146=PRODUCT('Plate','Plate','',(#145));\r
#147=PRODUCT_DEFINITION_FORMATION('','',#146);\r
#148=PRODUCT_DEFINITION_CONTEXT('part definition',#143,'design');\r
#149=PRODUCT_DEFINITION('design','',#147,#148);\r
#150=PRODUCT_DEFINITION_SHAPE('','',#149);\r
#151=SHAPE_DEFINITION_REPRESENTATION(#150,#142);\r
ENDSEC;\r
END-ISO-10303-21;\r
`,vr=`Margo brep test file, written from the IGES 5.3 specification.          S      1\r
1H,,1H;,10HMARGO-TEST,8Htest.igs,18HMargo engine tests,3H1.0,32,38,6,   G      1\r
308,15,10HMARGO-TEST,1,2,2HMM,1,0.01,15H20261024.120000,0.000001,100,   G      2\r
11HMargo tests,5HMargo,11,0,15H20261024.120000;                         G      3\r
     128       1       0       0       0       0       0       000010000D      1\r
     128       0               2       0                               0D      2\r
     106       3       0       0       0       0       0       000010500D      3\r
     106       0               1      11                               0D      4\r
     142       4       0       0       0       0       0       000010000D      5\r
     142       0               1       0                               0D      6\r
     100       5       0       0       0       0       0       000010000D      7\r
     100       0               1       0                               0D      8\r
     142       6       0       0       0       0       0       000010000D      9\r
     142       0               1       0                               0D     10\r
     144       7       0       0       0       0       0       000000000D     11\r
     144       0       2       1       0                               0D     12\r
128,1,1,1,1,0,0,1,0,0,0,0,1,1,0,0,1,1,1,1,1,1,0,0,0,10,0,0,0,10,       1P      1\r
0,10,10,0,0,1,0,1;                                                     1P      2\r
106,1,5,0,0,0,1,0,1,1,0,1,0,0;                                         3P      3\r
142,0,1,3,0,1;                                                         5P      4\r
100,0,5,5,7,5,7,5;                                                     7P      5\r
142,0,1,0,7,2;                                                         9P      6\r
144,1,1,1,5,9;                                                        11P      7\r
S      1G      3D     12P      7                                        T      1\r
`,yr=`ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('converted from Margo modeler'),'2;1');
FILE_NAME('upright-bracket.step','',(''),(''),'Margo kernel','','');
FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 3 1 1 }'));
ENDSEC;
DATA;
#1=APPLICATION_CONTEXT('automotive design');
#2=PRODUCT_CONTEXT('',#1,'mechanical');
#3=PRODUCT('B-101','Milled mounting base','',(#2));
#4=PRODUCT_DEFINITION_FORMATION('','',#3);
#5=PRODUCT_DEFINITION_CONTEXT('part definition',#1,'design');
#6=PRODUCT_DEFINITION('design','',#4,#5);
#7=PRODUCT_DEFINITION_SHAPE('','',#6);
#8=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT($,.METRE.));
#9=(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.));
#10=(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNIT_ASSIGNED_CONTEXT((#8,#9))REPRESENTATION_CONTEXT('',''));
#11=CARTESIAN_POINT('',(0.,0.,0.));
#12=AXIS2_PLACEMENT_3D('',#11,$,$);
#13=SHAPE_REPRESENTATION('',(#12),#10);
#14=SHAPE_DEFINITION_REPRESENTATION(#7,#13);
#100=CARTESIAN_POINT('',(0.0,0.071999999999999995,0.0));
#101=VERTEX_POINT('Milled mounting base/vertex:-z:3',#100);
#102=CARTESIAN_POINT('',(0.0,0.0,0.0));
#103=VERTEX_POINT('Milled mounting base/vertex:-z:0',#102);
#104=CARTESIAN_POINT('',(0.0,0.071999999999999995,0.0));
#105=DIRECTION('',(0.0,-1.0,0.0));
#106=VECTOR('',#105,1.);
#107=LINE('',#104,#106);
#108=EDGE_CURVE('Milled mounting base/edge:-z:-x',#101,#103,#107,.T.);
#109=ORIENTED_EDGE('',*,*,#108,.F.);
#110=CARTESIAN_POINT('',(0.106,0.071999999999999995,0.0));
#111=VERTEX_POINT('Milled mounting base/vertex:-z:2',#110);
#112=CARTESIAN_POINT('',(0.106,0.071999999999999995,0.0));
#113=DIRECTION('',(-1.0,0.0,0.0));
#114=VECTOR('',#113,1.);
#115=LINE('',#112,#114);
#116=EDGE_CURVE('Milled mounting base/edge:-z:+y',#111,#101,#115,.T.);
#117=ORIENTED_EDGE('',*,*,#116,.F.);
#118=CARTESIAN_POINT('',(0.106,0.0,0.0));
#119=VERTEX_POINT('Milled mounting base/vertex:-z:1',#118);
#120=CARTESIAN_POINT('',(0.106,0.0,0.0));
#121=DIRECTION('',(0.0,1.0,0.0));
#122=VECTOR('',#121,1.);
#123=LINE('',#120,#122);
#124=EDGE_CURVE('Milled mounting base/edge:-z:+x',#119,#111,#123,.T.);
#125=ORIENTED_EDGE('',*,*,#124,.F.);
#126=CARTESIAN_POINT('',(0.0,0.0,0.0));
#127=DIRECTION('',(1.0,0.0,0.0));
#128=VECTOR('',#127,1.);
#129=LINE('',#126,#128);
#130=EDGE_CURVE('Milled mounting base/edge:-z:-y',#103,#119,#129,.T.);
#131=ORIENTED_EDGE('',*,*,#130,.F.);
#132=EDGE_LOOP('',(#109,#117,#125,#131));
#133=FACE_BOUND('',#132,.T.);
#134=CARTESIAN_POINT('',(0.0,0.0,0.0));
#135=DIRECTION('',(0.0,0.0,-1.0));
#136=DIRECTION('',(1.0,0.0,0.0));
#137=AXIS2_PLACEMENT_3D('',#134,#135,#136);
#138=PLANE('',#137);
#139=ADVANCED_FACE('Milled mounting base/face:-z',(#133),#138,.T.);
#140=CARTESIAN_POINT('',(0.0,0.0,0.010999999999999999));
#141=VERTEX_POINT('Milled mounting base/vertex:+z:0',#140);
#142=CARTESIAN_POINT('',(0.106,0.0,0.010999999999999999));
#143=VERTEX_POINT('Milled mounting base/vertex:+z:1',#142);
#144=CARTESIAN_POINT('',(0.0,0.0,0.010999999999999999));
#145=DIRECTION('',(1.0,0.0,0.0));
#146=VECTOR('',#145,1.);
#147=LINE('',#144,#146);
#148=EDGE_CURVE('Milled mounting base/edge:+z:-y',#141,#143,#147,.T.);
#149=ORIENTED_EDGE('',*,*,#148,.T.);
#150=CARTESIAN_POINT('',(0.106,0.071999999999999995,0.010999999999999999));
#151=VERTEX_POINT('Milled mounting base/vertex:+z:2',#150);
#152=CARTESIAN_POINT('',(0.106,0.0,0.010999999999999999));
#153=DIRECTION('',(0.0,1.0,0.0));
#154=VECTOR('',#153,1.);
#155=LINE('',#152,#154);
#156=EDGE_CURVE('Milled mounting base/edge:+z:+x',#143,#151,#155,.T.);
#157=ORIENTED_EDGE('',*,*,#156,.T.);
#158=CARTESIAN_POINT('',(0.0,0.071999999999999995,0.010999999999999999));
#159=VERTEX_POINT('Milled mounting base/vertex:+z:3',#158);
#160=CARTESIAN_POINT('',(0.106,0.071999999999999995,0.010999999999999999));
#161=DIRECTION('',(-1.0,0.0,0.0));
#162=VECTOR('',#161,1.);
#163=LINE('',#160,#162);
#164=EDGE_CURVE('Milled mounting base/edge:+z:+y',#151,#159,#163,.T.);
#165=ORIENTED_EDGE('',*,*,#164,.T.);
#166=CARTESIAN_POINT('',(0.0,0.071999999999999995,0.010999999999999999));
#167=DIRECTION('',(0.0,-1.0,0.0));
#168=VECTOR('',#167,1.);
#169=LINE('',#166,#168);
#170=EDGE_CURVE('Milled mounting base/edge:+z:-x',#159,#141,#169,.T.);
#171=ORIENTED_EDGE('',*,*,#170,.T.);
#172=EDGE_LOOP('',(#149,#157,#165,#171));
#173=FACE_BOUND('',#172,.T.);
#174=CARTESIAN_POINT('',(0.0,0.0,0.010999999999999999));
#175=DIRECTION('',(0.0,0.0,1.0));
#176=DIRECTION('',(1.0,0.0,0.0));
#177=AXIS2_PLACEMENT_3D('',#174,#175,#176);
#178=PLANE('',#177);
#179=ADVANCED_FACE('Milled mounting base/face:+z',(#173),#178,.T.);
#180=ORIENTED_EDGE('',*,*,#130,.T.);
#181=CARTESIAN_POINT('',(0.106,0.0,0.0));
#182=DIRECTION('',(0.0,0.0,1.0));
#183=VECTOR('',#182,1.);
#184=LINE('',#181,#183);
#185=EDGE_CURVE('Milled mounting base/edge:side:1',#119,#143,#184,.T.);
#186=ORIENTED_EDGE('',*,*,#185,.T.);
#187=ORIENTED_EDGE('',*,*,#148,.F.);
#188=CARTESIAN_POINT('',(0.0,0.0,0.0));
#189=DIRECTION('',(0.0,0.0,1.0));
#190=VECTOR('',#189,1.);
#191=LINE('',#188,#190);
#192=EDGE_CURVE('Milled mounting base/edge:side:0',#103,#141,#191,.T.);
#193=ORIENTED_EDGE('',*,*,#192,.F.);
#194=EDGE_LOOP('',(#180,#186,#187,#193));
#195=FACE_BOUND('',#194,.T.);
#196=CARTESIAN_POINT('',(0.0,0.0,0.0));
#197=DIRECTION('',(0.0,-1.0,0.0));
#198=DIRECTION('',(1.0,0.0,0.0));
#199=AXIS2_PLACEMENT_3D('',#196,#197,#198);
#200=PLANE('',#199);
#201=ADVANCED_FACE('Milled mounting base/face:-y',(#195),#200,.T.);
#202=ORIENTED_EDGE('',*,*,#124,.T.);
#203=CARTESIAN_POINT('',(0.106,0.071999999999999995,0.0));
#204=DIRECTION('',(0.0,0.0,1.0));
#205=VECTOR('',#204,1.);
#206=LINE('',#203,#205);
#207=EDGE_CURVE('Milled mounting base/edge:side:2',#111,#151,#206,.T.);
#208=ORIENTED_EDGE('',*,*,#207,.T.);
#209=ORIENTED_EDGE('',*,*,#156,.F.);
#210=ORIENTED_EDGE('',*,*,#185,.F.);
#211=EDGE_LOOP('',(#202,#208,#209,#210));
#212=FACE_BOUND('',#211,.T.);
#213=CARTESIAN_POINT('',(0.106,0.0,0.0));
#214=DIRECTION('',(1.0,0.0,0.0));
#215=DIRECTION('',(0.0,1.0,0.0));
#216=AXIS2_PLACEMENT_3D('',#213,#214,#215);
#217=PLANE('',#216);
#218=ADVANCED_FACE('Milled mounting base/face:+x',(#212),#217,.T.);
#219=ORIENTED_EDGE('',*,*,#116,.T.);
#220=CARTESIAN_POINT('',(0.0,0.071999999999999995,0.0));
#221=DIRECTION('',(0.0,0.0,1.0));
#222=VECTOR('',#221,1.);
#223=LINE('',#220,#222);
#224=EDGE_CURVE('Milled mounting base/edge:side:3',#101,#159,#223,.T.);
#225=ORIENTED_EDGE('',*,*,#224,.T.);
#226=ORIENTED_EDGE('',*,*,#164,.F.);
#227=ORIENTED_EDGE('',*,*,#207,.F.);
#228=EDGE_LOOP('',(#219,#225,#226,#227));
#229=FACE_BOUND('',#228,.T.);
#230=CARTESIAN_POINT('',(0.106,0.071999999999999995,0.0));
#231=DIRECTION('',(0.0,1.0,0.0));
#232=DIRECTION('',(-1.0,0.0,0.0));
#233=AXIS2_PLACEMENT_3D('',#230,#231,#232);
#234=PLANE('',#233);
#235=ADVANCED_FACE('Milled mounting base/face:+y',(#229),#234,.T.);
#236=ORIENTED_EDGE('',*,*,#108,.T.);
#237=ORIENTED_EDGE('',*,*,#192,.T.);
#238=ORIENTED_EDGE('',*,*,#170,.F.);
#239=ORIENTED_EDGE('',*,*,#224,.F.);
#240=EDGE_LOOP('',(#236,#237,#238,#239));
#241=FACE_BOUND('',#240,.T.);
#242=CARTESIAN_POINT('',(0.0,0.071999999999999995,0.0));
#243=DIRECTION('',(-1.0,0.0,0.0));
#244=DIRECTION('',(0.0,-1.0,0.0));
#245=AXIS2_PLACEMENT_3D('',#242,#243,#244);
#246=PLANE('',#245);
#247=ADVANCED_FACE('Milled mounting base/face:-x',(#241),#246,.T.);
#248=CLOSED_SHELL('',(#139,#179,#201,#218,#235,#247));
#249=MANIFOLD_SOLID_BREP('Milled mounting base',#248);
#250=ADVANCED_BREP_SHAPE_REPRESENTATION('',(#249,#12),#10);
#251=SHAPE_REPRESENTATION_RELATIONSHIP('','',#13,#250);
#252=APPLICATION_CONTEXT('automotive design');
#253=PRODUCT_CONTEXT('',#252,'mechanical');
#254=PRODUCT('B-114','Tapered upright','',(#253));
#255=PRODUCT_DEFINITION_FORMATION('','',#254);
#256=PRODUCT_DEFINITION_CONTEXT('part definition',#252,'design');
#257=PRODUCT_DEFINITION('design','',#255,#256);
#258=PRODUCT_DEFINITION_SHAPE('','',#257);
#259=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT($,.METRE.));
#260=(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.));
#261=(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNIT_ASSIGNED_CONTEXT((#259,#260))REPRESENTATION_CONTEXT('',''));
#262=CARTESIAN_POINT('',(0.,0.,0.));
#263=AXIS2_PLACEMENT_3D('',#262,$,$);
#264=SHAPE_REPRESENTATION('',(#263),#261);
#265=SHAPE_DEFINITION_REPRESENTATION(#258,#264);
#351=CARTESIAN_POINT('',(0.033000000000000002,0.0,0.0));
#352=VERTEX_POINT('Tapered upright/vertex:bottom:7',#351);
#353=CARTESIAN_POINT('',(0.0,0.0,0.0));
#354=VERTEX_POINT('Tapered upright/vertex:bottom:0',#353);
#355=CARTESIAN_POINT('',(0.033000000000000002,0.0,0.0));
#356=DIRECTION('',(-1.0,0.0,0.0));
#357=VECTOR('',#356,1.);
#358=LINE('',#355,#357);
#359=EDGE_CURVE('Tapered upright/edge:bottom:e7',#352,#354,#358,.T.);
#360=ORIENTED_EDGE('',*,*,#359,.F.);
#361=CARTESIAN_POINT('',(0.034000000000000002,0.0,0.0089999999999999993));
#362=VERTEX_POINT('Tapered upright/vertex:bottom:6',#361);
#363=CARTESIAN_POINT('',(0.034000000000000002,0.0,0.0089999999999999993));
#364=DIRECTION('',(-0.11043152607484666,0.0,-0.9938837346736189));
#365=VECTOR('',#364,1.);
#366=LINE('',#363,#365);
#367=EDGE_CURVE('Tapered upright/edge:bottom:e6',#362,#352,#366,.T.);
#368=ORIENTED_EDGE('',*,*,#367,.F.);
#369=CARTESIAN_POINT('',(0.023,0.0,0.02));
#370=VERTEX_POINT('Tapered upright/vertex:bottom:5',#369);
#371=CARTESIAN_POINT('',(0.023,0.0,0.02));
#372=DIRECTION('',(0.70710678118654757,0.0,-0.70710678118654746));
#373=VECTOR('',#372,1.);
#374=LINE('',#371,#373);
#375=EDGE_CURVE('Tapered upright/edge:bottom:e5',#370,#362,#374,.T.);
#376=ORIENTED_EDGE('',*,*,#375,.F.);
#377=CARTESIAN_POINT('',(0.02,0.0,0.052999999999999999));
#378=VERTEX_POINT('Tapered upright/vertex:bottom:4',#377);
#379=CARTESIAN_POINT('',(0.02,0.0,0.052999999999999999));
#380=DIRECTION('',(0.090535746042518517,0.0,-0.99589320646770396));
#381=VECTOR('',#380,1.);
#382=LINE('',#379,#381);
#383=EDGE_CURVE('Tapered upright/edge:bottom:e4',#378,#370,#382,.T.);
#384=ORIENTED_EDGE('',*,*,#383,.F.);
#385=CARTESIAN_POINT('',(0.016,0.0,0.068000000000000005));
#386=VERTEX_POINT('Tapered upright/vertex:bottom:3',#385);
#387=CARTESIAN_POINT('',(0.016,0.0,0.068000000000000005));
#388=DIRECTION('',(0.25766265056033222,0.0,-0.96623493960124629));
#389=VECTOR('',#388,1.);
#390=LINE('',#387,#389);
#391=EDGE_CURVE('Tapered upright/edge:bottom:e3',#386,#378,#390,.T.);
#392=ORIENTED_EDGE('',*,*,#391,.F.);
#393=CARTESIAN_POINT('',(0.0060000000000000001,0.0,0.073999999999999996));
#394=VERTEX_POINT('Tapered upright/vertex:bottom:2',#393);
#395=CARTESIAN_POINT('',(0.0060000000000000001,0.0,0.073999999999999996));
#396=DIRECTION('',(0.85749292571254465,0.0,-0.51449575542752601));
#397=VECTOR('',#396,1.);
#398=LINE('',#395,#397);
#399=EDGE_CURVE('Tapered upright/edge:bottom:e2',#394,#386,#398,.T.);
#400=ORIENTED_EDGE('',*,*,#399,.F.);
#401=CARTESIAN_POINT('',(0.0,0.0,0.067000000000000004));
#402=VERTEX_POINT('Tapered upright/vertex:bottom:1',#401);
#403=CARTESIAN_POINT('',(0.0,0.0,0.067000000000000004));
#404=DIRECTION('',(0.65079137345596894,0.0,0.75925660236529624));
#405=VECTOR('',#404,1.);
#406=LINE('',#403,#405);
#407=EDGE_CURVE('Tapered upright/edge:bottom:e1',#402,#394,#406,.T.);
#408=ORIENTED_EDGE('',*,*,#407,.F.);
#409=CARTESIAN_POINT('',(0.0,0.0,0.0));
#410=DIRECTION('',(0.0,0.0,1.0));
#411=VECTOR('',#410,1.);
#412=LINE('',#409,#411);
#413=EDGE_CURVE('Tapered upright/edge:bottom:e0',#354,#402,#412,.T.);
#414=ORIENTED_EDGE('',*,*,#413,.F.);
#415=EDGE_LOOP('',(#360,#368,#376,#384,#392,#400,#408,#414));
#416=FACE_BOUND('',#415,.T.);
#417=CARTESIAN_POINT('',(0.0,0.0,0.0));
#418=DIRECTION('',(0.0,-1.0,0.0));
#419=DIRECTION('',(0.0,0.0,1.0));
#420=AXIS2_PLACEMENT_3D('',#417,#418,#419);
#421=PLANE('',#420);
#422=ADVANCED_FACE('Tapered upright/face:bottom',(#416),#421,.T.);
#423=CARTESIAN_POINT('',(0.0,0.017999999999999999,0.0));
#424=VERTEX_POINT('Tapered upright/vertex:top:0',#423);
#425=CARTESIAN_POINT('',(0.0,0.017999999999999999,0.067000000000000004));
#426=VERTEX_POINT('Tapered upright/vertex:top:1',#425);
#427=CARTESIAN_POINT('',(0.0,0.017999999999999999,0.0));
#428=DIRECTION('',(0.0,0.0,1.0));
#429=VECTOR('',#428,1.);
#430=LINE('',#427,#429);
#431=EDGE_CURVE('Tapered upright/edge:top:e0',#424,#426,#430,.T.);
#432=ORIENTED_EDGE('',*,*,#431,.T.);
#433=CARTESIAN_POINT('',(0.0060000000000000001,0.017999999999999999,0.073999999999999996));
#434=VERTEX_POINT('Tapered upright/vertex:top:2',#433);
#435=CARTESIAN_POINT('',(0.0,0.017999999999999999,0.067000000000000004));
#436=DIRECTION('',(0.65079137345596894,0.0,0.75925660236529624));
#437=VECTOR('',#436,1.);
#438=LINE('',#435,#437);
#439=EDGE_CURVE('Tapered upright/edge:top:e1',#426,#434,#438,.T.);
#440=ORIENTED_EDGE('',*,*,#439,.T.);
#441=CARTESIAN_POINT('',(0.016,0.017999999999999999,0.068000000000000005));
#442=VERTEX_POINT('Tapered upright/vertex:top:3',#441);
#443=CARTESIAN_POINT('',(0.0060000000000000001,0.017999999999999999,0.073999999999999996));
#444=DIRECTION('',(0.85749292571254465,0.0,-0.51449575542752601));
#445=VECTOR('',#444,1.);
#446=LINE('',#443,#445);
#447=EDGE_CURVE('Tapered upright/edge:top:e2',#434,#442,#446,.T.);
#448=ORIENTED_EDGE('',*,*,#447,.T.);
#449=CARTESIAN_POINT('',(0.02,0.017999999999999999,0.052999999999999999));
#450=VERTEX_POINT('Tapered upright/vertex:top:4',#449);
#451=CARTESIAN_POINT('',(0.016,0.017999999999999999,0.068000000000000005));
#452=DIRECTION('',(0.25766265056033222,0.0,-0.96623493960124629));
#453=VECTOR('',#452,1.);
#454=LINE('',#451,#453);
#455=EDGE_CURVE('Tapered upright/edge:top:e3',#442,#450,#454,.T.);
#456=ORIENTED_EDGE('',*,*,#455,.T.);
#457=CARTESIAN_POINT('',(0.023,0.017999999999999999,0.02));
#458=VERTEX_POINT('Tapered upright/vertex:top:5',#457);
#459=CARTESIAN_POINT('',(0.02,0.017999999999999999,0.052999999999999999));
#460=DIRECTION('',(0.090535746042518517,0.0,-0.99589320646770396));
#461=VECTOR('',#460,1.);
#462=LINE('',#459,#461);
#463=EDGE_CURVE('Tapered upright/edge:top:e4',#450,#458,#462,.T.);
#464=ORIENTED_EDGE('',*,*,#463,.T.);
#465=CARTESIAN_POINT('',(0.034000000000000002,0.017999999999999999,0.0089999999999999993));
#466=VERTEX_POINT('Tapered upright/vertex:top:6',#465);
#467=CARTESIAN_POINT('',(0.023,0.017999999999999999,0.02));
#468=DIRECTION('',(0.70710678118654757,0.0,-0.70710678118654746));
#469=VECTOR('',#468,1.);
#470=LINE('',#467,#469);
#471=EDGE_CURVE('Tapered upright/edge:top:e5',#458,#466,#470,.T.);
#472=ORIENTED_EDGE('',*,*,#471,.T.);
#473=CARTESIAN_POINT('',(0.033000000000000002,0.017999999999999999,0.0));
#474=VERTEX_POINT('Tapered upright/vertex:top:7',#473);
#475=CARTESIAN_POINT('',(0.034000000000000002,0.017999999999999999,0.0089999999999999993));
#476=DIRECTION('',(-0.11043152607484666,0.0,-0.9938837346736189));
#477=VECTOR('',#476,1.);
#478=LINE('',#475,#477);
#479=EDGE_CURVE('Tapered upright/edge:top:e6',#466,#474,#478,.T.);
#480=ORIENTED_EDGE('',*,*,#479,.T.);
#481=CARTESIAN_POINT('',(0.033000000000000002,0.017999999999999999,0.0));
#482=DIRECTION('',(-1.0,0.0,0.0));
#483=VECTOR('',#482,1.);
#484=LINE('',#481,#483);
#485=EDGE_CURVE('Tapered upright/edge:top:e7',#474,#424,#484,.T.);
#486=ORIENTED_EDGE('',*,*,#485,.T.);
#487=EDGE_LOOP('',(#432,#440,#448,#456,#464,#472,#480,#486));
#488=FACE_BOUND('',#487,.T.);
#489=CARTESIAN_POINT('',(0.0,0.017999999999999999,0.0));
#490=DIRECTION('',(0.0,1.0,0.0));
#491=DIRECTION('',(0.0,0.0,1.0));
#492=AXIS2_PLACEMENT_3D('',#489,#490,#491);
#493=PLANE('',#492);
#494=ADVANCED_FACE('Tapered upright/face:top',(#488),#493,.T.);
#495=ORIENTED_EDGE('',*,*,#413,.T.);
#496=CARTESIAN_POINT('',(0.0,0.0,0.067000000000000004));
#497=DIRECTION('',(0.0,1.0,0.0));
#498=VECTOR('',#497,1.);
#499=LINE('',#496,#498);
#500=EDGE_CURVE('Tapered upright/edge:side:1',#402,#426,#499,.T.);
#501=ORIENTED_EDGE('',*,*,#500,.T.);
#502=ORIENTED_EDGE('',*,*,#431,.F.);
#503=CARTESIAN_POINT('',(0.0,0.0,0.0));
#504=DIRECTION('',(0.0,1.0,0.0));
#505=VECTOR('',#504,1.);
#506=LINE('',#503,#505);
#507=EDGE_CURVE('Tapered upright/edge:side:0',#354,#424,#506,.T.);
#508=ORIENTED_EDGE('',*,*,#507,.F.);
#509=EDGE_LOOP('',(#495,#501,#502,#508));
#510=FACE_BOUND('',#509,.T.);
#511=CARTESIAN_POINT('',(0.0,0.0,0.0));
#512=DIRECTION('',(-1.0,0.0,0.0));
#513=DIRECTION('',(0.0,0.0,1.0));
#514=AXIS2_PLACEMENT_3D('',#511,#512,#513);
#515=PLANE('',#514);
#516=ADVANCED_FACE('Tapered upright/face:e0',(#510),#515,.T.);
#517=ORIENTED_EDGE('',*,*,#407,.T.);
#518=CARTESIAN_POINT('',(0.0060000000000000001,0.0,0.073999999999999996));
#519=DIRECTION('',(0.0,1.0,0.0));
#520=VECTOR('',#519,1.);
#521=LINE('',#518,#520);
#522=EDGE_CURVE('Tapered upright/edge:side:2',#394,#434,#521,.T.);
#523=ORIENTED_EDGE('',*,*,#522,.T.);
#524=ORIENTED_EDGE('',*,*,#439,.F.);
#525=ORIENTED_EDGE('',*,*,#500,.F.);
#526=EDGE_LOOP('',(#517,#523,#524,#525));
#527=FACE_BOUND('',#526,.T.);
#528=CARTESIAN_POINT('',(0.0,0.0,0.067000000000000004));
#529=DIRECTION('',(-0.75925660236529624,0.0,0.65079137345596894));
#530=DIRECTION('',(0.65079137345596894,0.0,0.75925660236529624));
#531=AXIS2_PLACEMENT_3D('',#528,#529,#530);
#532=PLANE('',#531);
#533=ADVANCED_FACE('Tapered upright/face:e1',(#527),#532,.T.);
#534=ORIENTED_EDGE('',*,*,#399,.T.);
#535=CARTESIAN_POINT('',(0.016,0.0,0.068000000000000005));
#536=DIRECTION('',(0.0,1.0,0.0));
#537=VECTOR('',#536,1.);
#538=LINE('',#535,#537);
#539=EDGE_CURVE('Tapered upright/edge:side:3',#386,#442,#538,.T.);
#540=ORIENTED_EDGE('',*,*,#539,.T.);
#541=ORIENTED_EDGE('',*,*,#447,.F.);
#542=ORIENTED_EDGE('',*,*,#522,.F.);
#543=EDGE_LOOP('',(#534,#540,#541,#542));
#544=FACE_BOUND('',#543,.T.);
#545=CARTESIAN_POINT('',(0.0060000000000000001,0.0,0.073999999999999996));
#546=DIRECTION('',(0.5144957554275259,0.0,0.85749292571254443));
#547=DIRECTION('',(0.85749292571254443,0.0,-0.5144957554275259));
#548=AXIS2_PLACEMENT_3D('',#545,#546,#547);
#549=PLANE('',#548);
#550=ADVANCED_FACE('Tapered upright/face:e2',(#544),#549,.T.);
#551=ORIENTED_EDGE('',*,*,#391,.T.);
#552=CARTESIAN_POINT('',(0.02,0.0,0.052999999999999999));
#553=DIRECTION('',(0.0,1.0,0.0));
#554=VECTOR('',#553,1.);
#555=LINE('',#552,#554);
#556=EDGE_CURVE('Tapered upright/edge:side:4',#378,#450,#555,.T.);
#557=ORIENTED_EDGE('',*,*,#556,.T.);
#558=ORIENTED_EDGE('',*,*,#455,.F.);
#559=ORIENTED_EDGE('',*,*,#539,.F.);
#560=EDGE_LOOP('',(#551,#557,#558,#559));
#561=FACE_BOUND('',#560,.T.);
#562=CARTESIAN_POINT('',(0.016,0.0,0.068000000000000005));
#563=DIRECTION('',(0.96623493960124629,0.0,0.25766265056033222));
#564=DIRECTION('',(0.25766265056033222,0.0,-0.96623493960124629));
#565=AXIS2_PLACEMENT_3D('',#562,#563,#564);
#566=PLANE('',#565);
#567=ADVANCED_FACE('Tapered upright/face:e3',(#561),#566,.T.);
#568=ORIENTED_EDGE('',*,*,#383,.T.);
#569=CARTESIAN_POINT('',(0.023,0.0,0.02));
#570=DIRECTION('',(0.0,1.0,0.0));
#571=VECTOR('',#570,1.);
#572=LINE('',#569,#571);
#573=EDGE_CURVE('Tapered upright/edge:side:5',#370,#458,#572,.T.);
#574=ORIENTED_EDGE('',*,*,#573,.T.);
#575=ORIENTED_EDGE('',*,*,#463,.F.);
#576=ORIENTED_EDGE('',*,*,#556,.F.);
#577=EDGE_LOOP('',(#568,#574,#575,#576));
#578=FACE_BOUND('',#577,.T.);
#579=CARTESIAN_POINT('',(0.02,0.0,0.052999999999999999));
#580=DIRECTION('',(0.99589320646770374,0.0,0.090535746042518503));
#581=DIRECTION('',(0.090535746042518517,0.0,-0.99589320646770374));
#582=AXIS2_PLACEMENT_3D('',#579,#580,#581);
#583=PLANE('',#582);
#584=ADVANCED_FACE('Tapered upright/face:e4',(#578),#583,.T.);
#585=ORIENTED_EDGE('',*,*,#375,.T.);
#586=CARTESIAN_POINT('',(0.034000000000000002,0.0,0.0089999999999999993));
#587=DIRECTION('',(0.0,1.0,0.0));
#588=VECTOR('',#587,1.);
#589=LINE('',#586,#588);
#590=EDGE_CURVE('Tapered upright/edge:side:6',#362,#466,#589,.T.);
#591=ORIENTED_EDGE('',*,*,#590,.T.);
#592=ORIENTED_EDGE('',*,*,#471,.F.);
#593=ORIENTED_EDGE('',*,*,#573,.F.);
#594=EDGE_LOOP('',(#585,#591,#592,#593));
#595=FACE_BOUND('',#594,.T.);
#596=CARTESIAN_POINT('',(0.023,0.0,0.02));
#597=DIRECTION('',(0.70710678118654746,0.0,0.70710678118654757));
#598=DIRECTION('',(0.70710678118654757,0.0,-0.70710678118654746));
#599=AXIS2_PLACEMENT_3D('',#596,#597,#598);
#600=PLANE('',#599);
#601=ADVANCED_FACE('Tapered upright/face:e5',(#595),#600,.T.);
#602=ORIENTED_EDGE('',*,*,#367,.T.);
#603=CARTESIAN_POINT('',(0.033000000000000002,0.0,0.0));
#604=DIRECTION('',(0.0,1.0,0.0));
#605=VECTOR('',#604,1.);
#606=LINE('',#603,#605);
#607=EDGE_CURVE('Tapered upright/edge:side:7',#352,#474,#606,.T.);
#608=ORIENTED_EDGE('',*,*,#607,.T.);
#609=ORIENTED_EDGE('',*,*,#479,.F.);
#610=ORIENTED_EDGE('',*,*,#590,.F.);
#611=EDGE_LOOP('',(#602,#608,#609,#610));
#612=FACE_BOUND('',#611,.T.);
#613=CARTESIAN_POINT('',(0.034000000000000002,0.0,0.0089999999999999993));
#614=DIRECTION('',(0.9938837346736189,0.0,-0.11043152607484666));
#615=DIRECTION('',(-0.11043152607484666,0.0,-0.9938837346736189));
#616=AXIS2_PLACEMENT_3D('',#613,#614,#615);
#617=PLANE('',#616);
#618=ADVANCED_FACE('Tapered upright/face:e6',(#612),#617,.T.);
#619=ORIENTED_EDGE('',*,*,#359,.T.);
#620=ORIENTED_EDGE('',*,*,#507,.T.);
#621=ORIENTED_EDGE('',*,*,#485,.F.);
#622=ORIENTED_EDGE('',*,*,#607,.F.);
#623=EDGE_LOOP('',(#619,#620,#621,#622));
#624=FACE_BOUND('',#623,.T.);
#625=CARTESIAN_POINT('',(0.033000000000000002,0.0,0.0));
#626=DIRECTION('',(0.0,0.0,-1.0));
#627=DIRECTION('',(-1.0,0.0,0.0));
#628=AXIS2_PLACEMENT_3D('',#625,#626,#627);
#629=PLANE('',#628);
#630=ADVANCED_FACE('Tapered upright/face:e7',(#624),#629,.T.);
#631=CLOSED_SHELL('',(#422,#494,#516,#533,#550,#567,#584,#601,#618,#630));
#632=MANIFOLD_SOLID_BREP('Tapered upright',#631);
#633=ADVANCED_BREP_SHAPE_REPRESENTATION('',(#632,#263),#261);
#634=SHAPE_REPRESENTATION_RELATIONSHIP('','',#264,#633);
#635=APPLICATION_CONTEXT('automotive design');
#636=PRODUCT_CONTEXT('',#635,'mechanical');
#637=PRODUCT('B-122','Retaining pin','',(#636));
#638=PRODUCT_DEFINITION_FORMATION('','',#637);
#639=PRODUCT_DEFINITION_CONTEXT('part definition',#635,'design');
#640=PRODUCT_DEFINITION('design','',#638,#639);
#641=PRODUCT_DEFINITION_SHAPE('','',#640);
#642=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT($,.METRE.));
#643=(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.));
#644=(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNIT_ASSIGNED_CONTEXT((#642,#643))REPRESENTATION_CONTEXT('',''));
#645=CARTESIAN_POINT('',(0.,0.,0.));
#646=AXIS2_PLACEMENT_3D('',#645,$,$);
#647=SHAPE_REPRESENTATION('',(#646),#644);
#648=SHAPE_DEFINITION_REPRESENTATION(#641,#647);
#734=CARTESIAN_POINT('',(0.0057999999999999996,0.0,0.0));
#735=VERTEX_POINT('Retaining pin/vertex:-z:0',#734);
#736=CARTESIAN_POINT('',(0.0,0.0,0.0));
#737=DIRECTION('',(0.0,0.0,1.0));
#738=DIRECTION('',(1.0,0.0,0.0));
#739=AXIS2_PLACEMENT_3D('',#736,#737,#738);
#740=CIRCLE('',#739,0.0057999999999999996);
#741=EDGE_CURVE('Retaining pin/edge:-z:side',#735,#735,#740,.T.);
#742=ORIENTED_EDGE('',*,*,#741,.F.);
#743=EDGE_LOOP('',(#742));
#744=FACE_BOUND('',#743,.T.);
#745=CARTESIAN_POINT('',(0.0057999999999999996,0.0,0.0));
#746=DIRECTION('',(0.0,0.0,-1.0));
#747=DIRECTION('',(-1.0,0.0,0.0));
#748=AXIS2_PLACEMENT_3D('',#745,#746,#747);
#749=PLANE('',#748);
#750=ADVANCED_FACE('Retaining pin/face:-z',(#744),#749,.T.);
#751=CARTESIAN_POINT('',(0.0057999999999999996,0.0,0.017999999999999999));
#752=VERTEX_POINT('Retaining pin/vertex:+z:0',#751);
#753=CARTESIAN_POINT('',(0.0,0.0,0.017999999999999999));
#754=DIRECTION('',(0.0,0.0,1.0));
#755=DIRECTION('',(1.0,0.0,0.0));
#756=AXIS2_PLACEMENT_3D('',#753,#754,#755);
#757=CIRCLE('',#756,0.0057999999999999996);
#758=EDGE_CURVE('Retaining pin/edge:+z:side',#752,#752,#757,.T.);
#759=ORIENTED_EDGE('',*,*,#758,.T.);
#760=EDGE_LOOP('',(#759));
#761=FACE_BOUND('',#760,.T.);
#762=CARTESIAN_POINT('',(0.0057999999999999996,0.0,0.017999999999999999));
#763=DIRECTION('',(0.0,0.0,1.0));
#764=DIRECTION('',(1.0,0.0,0.0));
#765=AXIS2_PLACEMENT_3D('',#762,#763,#764);
#766=PLANE('',#765);
#767=ADVANCED_FACE('Retaining pin/face:+z',(#761),#766,.T.);
#768=ORIENTED_EDGE('',*,*,#741,.T.);
#769=CARTESIAN_POINT('',(0.0057999999999999996,0.0,0.0));
#770=DIRECTION('',(0.0,0.0,1.0));
#771=VECTOR('',#770,1.);
#772=LINE('',#769,#771);
#773=EDGE_CURVE('Retaining pin/edge:side:0',#735,#752,#772,.T.);
#774=ORIENTED_EDGE('',*,*,#773,.T.);
#775=ORIENTED_EDGE('',*,*,#758,.F.);
#776=ORIENTED_EDGE('',*,*,#773,.F.);
#777=EDGE_LOOP('',(#768,#774,#775,#776));
#778=FACE_BOUND('',#777,.T.);
#779=CARTESIAN_POINT('',(0.0,0.0,0.0));
#780=DIRECTION('',(0.0,0.0,1.0));
#781=DIRECTION('',(1.0,0.0,0.0));
#782=AXIS2_PLACEMENT_3D('',#779,#780,#781);
#783=CYLINDRICAL_SURFACE('',#782,0.0057999999999999996);
#784=ADVANCED_FACE('Retaining pin/face:side',(#778),#783,.T.);
#785=CLOSED_SHELL('',(#750,#767,#784));
#786=MANIFOLD_SOLID_BREP('Retaining pin',#785);
#787=ADVANCED_BREP_SHAPE_REPRESENTATION('',(#786,#646),#644);
#788=SHAPE_REPRESENTATION_RELATIONSHIP('','',#647,#787);
#789=PRODUCT('SHELF-01','Upright bracket assembly','',(#2));
#790=PRODUCT_DEFINITION_FORMATION('','',#789);
#791=PRODUCT_DEFINITION('design','',#790,#5);
#792=PRODUCT_DEFINITION_SHAPE('','',#791);
#793=DIRECTION('',(0.,0.,1.));
#794=CARTESIAN_POINT('',(0.000000,0.000000,0.000000));
#795=DIRECTION('',(1.000000,0.000000,0.000000));
#796=AXIS2_PLACEMENT_3D('',#794,#793,#795);
#797=CARTESIAN_POINT('',(0.014000,0.015000,0.011000));
#798=DIRECTION('',(1.000000,0.000000,0.000000));
#799=AXIS2_PLACEMENT_3D('',#797,#793,#798);
#800=CARTESIAN_POINT('',(0.092000,0.057000,0.011000));
#801=DIRECTION('',(-1.000000,0.000000,0.000000));
#802=AXIS2_PLACEMENT_3D('',#800,#793,#801);
#803=CARTESIAN_POINT('',(0.023000,0.052000,0.011000));
#804=DIRECTION('',(1.000000,0.000000,0.000000));
#805=AXIS2_PLACEMENT_3D('',#803,#793,#804);
#806=CARTESIAN_POINT('',(0.083000,0.020000,0.011000));
#807=DIRECTION('',(1.000000,0.000000,0.000000));
#808=AXIS2_PLACEMENT_3D('',#806,#793,#807);
#809=SHAPE_REPRESENTATION('',(#796,#799,#802,#805,#808),#10);
#810=SHAPE_DEFINITION_REPRESENTATION(#792,#809);
#811=NEXT_ASSEMBLY_USAGE_OCCURRENCE('1','Base datum','',#791,#6,$);
#812=PRODUCT_DEFINITION_SHAPE('','',#811);
#813=ITEM_DEFINED_TRANSFORMATION('','',#12,#796);
#814=(REPRESENTATION_RELATIONSHIP('','',#13,#809)REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION(#813)SHAPE_REPRESENTATION_RELATIONSHIP());
#815=CONTEXT_DEPENDENT_SHAPE_REPRESENTATION(#814,#812);
#816=NEXT_ASSEMBLY_USAGE_OCCURRENCE('2','Port upright','',#791,#257,$);
#817=PRODUCT_DEFINITION_SHAPE('','',#816);
#818=ITEM_DEFINED_TRANSFORMATION('','',#263,#799);
#819=(REPRESENTATION_RELATIONSHIP('','',#264,#809)REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION(#818)SHAPE_REPRESENTATION_RELATIONSHIP());
#820=CONTEXT_DEPENDENT_SHAPE_REPRESENTATION(#819,#817);
#821=NEXT_ASSEMBLY_USAGE_OCCURRENCE('3','Starboard upright','',#791,#257,$);
#822=PRODUCT_DEFINITION_SHAPE('','',#821);
#823=ITEM_DEFINED_TRANSFORMATION('','',#263,#802);
#824=(REPRESENTATION_RELATIONSHIP('','',#264,#809)REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION(#823)SHAPE_REPRESENTATION_RELATIONSHIP());
#825=CONTEXT_DEPENDENT_SHAPE_REPRESENTATION(#824,#822);
#826=NEXT_ASSEMBLY_USAGE_OCCURRENCE('4','Port pin','',#791,#640,$);
#827=PRODUCT_DEFINITION_SHAPE('','',#826);
#828=ITEM_DEFINED_TRANSFORMATION('','',#646,#805);
#829=(REPRESENTATION_RELATIONSHIP('','',#647,#809)REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION(#828)SHAPE_REPRESENTATION_RELATIONSHIP());
#830=CONTEXT_DEPENDENT_SHAPE_REPRESENTATION(#829,#827);
#831=NEXT_ASSEMBLY_USAGE_OCCURRENCE('5','Starboard pin','',#791,#640,$);
#832=PRODUCT_DEFINITION_SHAPE('','',#831);
#833=ITEM_DEFINED_TRANSFORMATION('','',#646,#808);
#834=(REPRESENTATION_RELATIONSHIP('','',#647,#809)REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION(#833)SHAPE_REPRESENTATION_RELATIONSHIP());
#835=CONTEXT_DEPENDENT_SHAPE_REPRESENTATION(#834,#832);
ENDSEC;
END-ISO-10303-21;
`;const br=[`upright`,`cylinder`,`mounting`,`trimmed`,`conics`,`fixture`],xr={upright:[yr,`step`],cylinder:[gr,`iges`],mounting:[_r,`step`],trimmed:[vr,`iges`],conics:[hr,`iges`],fixture:[mr,`step`]},Sr={100:`Circular arc`,102:`Composite curve`,104:`Conic arc`,106:`Copious data`,110:`Line`,116:`Point`,123:`Direction`,124:`Transformation`,128:`Rational B-spline surface`,142:`Curve on surface`,144:`Trimmed surface`,186:`Manifold solid`,190:`Plane surface`,192:`Cylindrical surface`,502:`Vertex list`,504:`Edge list`,508:`Loop`,510:`Face`,514:`Shell`};function Cr(e,t){let n=(t===`step`?dr:pr)(e),r=fr(n,{relativeDeflection:8e-4,angle:.12}),i=[...n.warnings],a=[1/0,1/0,1/0],o=[-1/0,-1/0,-1/0],s=n.instances.map(({body:e,matrix:t,occurrence:n})=>{let s=r[e],{unit:c,indices:l}=s,u=new Float32Array(s.positions.length),d=new Float32Array(u.length);for(let e=0;e<u.length;e+=3){let n=s.positions[e]*c,r=s.positions[e+1]*c,i=s.positions[e+2]*c;u[e]=t[0]*n+t[4]*r+t[8]*i+t[12],u[e+1]=t[2]*n+t[6]*r+t[10]*i+t[14],u[e+2]=-(t[1]*n+t[5]*r+t[9]*i+t[13]);let l=s.normals[e],f=s.normals[e+1],p=s.normals[e+2];d[e]=t[0]*l+t[4]*f+t[8]*p,d[e+1]=t[2]*l+t[6]*f+t[10]*p,d[e+2]=-(t[1]*l+t[5]*f+t[9]*p);for(let t=0;t<3;t++)a[t]=Math.min(a[t],u[e+t]),o[t]=Math.max(o[t],u[e+t])}return i.push(...s.failures.map(({id:e,reason:t})=>`Face #`+e+` `+t)),{xyz:u,normals:d,indices:l.slice(),occurrence:n,body:e,bodyId:s.id}}),c=n.occurrences.map(({product:e,parent:t},r)=>({parent:t,index:r,...n.products[e]})),l=t===`iges`?an(e):null,u=l?[...l.entities.values()].map(({de:e,type:t,form:n})=>({de:e,type:t,form:n,label:Sr[t]??`IGES entity`})):[];return{meshes:s,tree:c,directory:u,low:a,high:o,warnings:i,surfaces:n.census.surfaces,bodyCount:r.length,sourceCount:l?u.length:n.file.size,triangles:s.reduce((e,t)=>e+t.indices.length/3,0),schema:l?`IGES 5.3`:n.header.schema[0]?.startsWith(`AUTOMOTIVE_DESIGN`)?`STEP AP214`:`STEP Part 21`,units:l?l.global.unitsName:r.every(e=>e.unit===.001)?`mm`:`m`}}for(let e of br){let[t,n]=xr[e];try{let r=Cr(t,n),i=r.meshes.flatMap(({xyz:e,normals:t,indices:n})=>[e.buffer,t.buffer,n.buffer]);self.postMessage({id:e,sample:r},i)}catch(t){self.postMessage({id:e,error:t.message})}}