// Typed shader nodes and the WGSL builder shared by the material, post and compute hosts.
import {nested} from './effects.js';
declare const GPUBufferUsage:{UNIFORM:number;COPY_DST:number};
type N=2|3|4;
export type Scalar='f32'|'i32'|'u32'|'bool';
export type Vector=`vec${N}${'f'|'i'|'u'}`|`vec${N}<bool>`;
export type Matrix='mat2x2f'|'mat3x3f'|'mat4x4f';
export type Type=Scalar|Vector|Matrix;
export type ScalarOf<T extends Type>=T extends 'f32'|`vec${N}f`|Matrix?'f32':T extends 'i32'|`vec${N}i`?'i32':T extends 'u32'|`vec${N}u`?'u32':'bool';
export type Size<T extends Type>=T extends `vec${infer K extends number}${string}`?K:1;
export type VecOf<S extends Scalar,K extends number>=K extends 1?S:S extends 'bool'?`vec${K&N}<bool>`:`vec${K&N}${S extends 'f32'?'f':S extends 'i32'?'i':'u'}`;
/** Result of `a op b` for + - * / %: equal types, scalar with vector or matrix, and matrix times vector. */
export type Arith<A extends Type,B extends Type>=A extends B?A:A extends ScalarOf<B>?B:B extends ScalarOf<A>?A:
  A extends `mat${infer K}x${string}`?(B extends `vec${K}f`?B:never):B extends `mat${infer K}x${string}`?(A extends `vec${K}f`?A:never):never;
type Bools<T extends Type>=Node<VecOf<'bool',Size<T>>>;
type Floats<T extends Type>=Node<VecOf<'f32',Size<T>>>;
type C='x'|'y'|'z'|'w';type R='r'|'g'|'b'|'a';
type Sw<X extends string>=X|`${X}${X}`|`${X}${X}${X}`|`${X}${X}${X}${X}`;
type Count<S extends string,A extends 0[]=[]>=S extends `${infer _}${infer Rest}`?Count<Rest,[...A,0]>:A['length'];
/** `.x`, `.xy`, `.rgb`, `.zyx` ... on vectors; on a scalar they splat (`f.xxx` is `vec3f(f)`). */
export type Swizzles<T extends Type>={readonly [K in Sw<C>|Sw<R>]:Node<VecOf<ScalarOf<T>,Count<K>>>};
export type Input<T extends Type=Type>=Node<T>|number;

/** Never bound to a `let`. */
export const LEAF=1;
/** A binary or unary operator: parenthesised when inlined into another operator. */
export const OP=2;
/** Writes statements and returns a variable name, once per scope. */
export const STMT=4;
export type Emit=(b:Builder,n:Node<any>)=>string;
let uid=0;
export const unique=():number=>uid++;

/** An immutable expression. Build them with the functions in this package; `key` plus `args` must determine `emit`. */
export class Node<T extends Type=Type> {
  constructor(readonly type:T,readonly key:string,readonly args:readonly Node[],readonly emit:Emit,readonly flags=0){}
}
export interface Node<T extends Type=Type> extends Swizzles<T> {
  add(b:number):Node<T>;add<U extends Type>(b:Node<U>):Node<Arith<T,U>>;
  sub(b:number):Node<T>;sub<U extends Type>(b:Node<U>):Node<Arith<T,U>>;
  mul(b:number):Node<T>;mul<U extends Type>(b:Node<U>):Node<Arith<T,U>>;
  div(b:number):Node<T>;div<U extends Type>(b:Node<U>):Node<Arith<T,U>>;
  mod(b:number):Node<T>;mod<U extends Type>(b:Node<U>):Node<Arith<T,U>>;
  negate():Node<T>;
  lessThan(b:Input<T>|Input<ScalarOf<T>>):Bools<T>;lessThanEqual(b:Input<T>|Input<ScalarOf<T>>):Bools<T>;
  greaterThan(b:Input<T>|Input<ScalarOf<T>>):Bools<T>;greaterThanEqual(b:Input<T>|Input<ScalarOf<T>>):Bools<T>;
  equal(b:Input<T>|Input<ScalarOf<T>>):Bools<T>;notEqual(b:Input<T>|Input<ScalarOf<T>>):Bools<T>;
  and(b:Node<T>):Node<T>;or(b:Node<T>):Node<T>;not():Node<T>;
  abs():Node<T>;sign():Node<T>;floor():Node<T>;ceil():Node<T>;round():Node<T>;trunc():Node<T>;fract():Node<T>;
  sin():Node<T>;cos():Node<T>;tan():Node<T>;asin():Node<T>;acos():Node<T>;atan():Node<T>;tanh():Node<T>;
  exp():Node<T>;exp2():Node<T>;log():Node<T>;log2():Node<T>;sqrt():Node<T>;inverseSqrt():Node<T>;saturate():Node<T>;
  normalize():Node<T>;radians():Node<T>;degrees():Node<T>;dpdx():Node<T>;dpdy():Node<T>;fwidth():Node<T>;oneMinus():Node<T>;
  length():Node<ScalarOf<T>>;distance(b:Input<T>):Node<ScalarOf<T>>;dot(b:Input<T>):Node<ScalarOf<T>>;cross(b:Node<'vec3f'>):Node<'vec3f'>;
  min(b:Input<T>|Input<ScalarOf<T>>):Node<T>;max(b:Input<T>|Input<ScalarOf<T>>):Node<T>;pow(b:Input<T>|Input<ScalarOf<T>>):Node<T>;
  clamp(low:Input<T>|Input<ScalarOf<T>>,high:Input<T>|Input<ScalarOf<T>>):Node<T>;step(edge:Input<T>|Input<ScalarOf<T>>):Node<T>;
  mix(b:Input<T>,t:Input<T>|Input<ScalarOf<T>>):Node<T>;reflect(n:Input<T>):Node<T>;
  /** Component `i` of a vector, column of a matrix. */
  element(i:Input<'i32'|'u32'>):Node<T extends Matrix?`vec${T extends `mat${infer K extends number}x${string}`?K:4}f`:ScalarOf<T>>;
  toFloat():Floats<T>;toInt():Node<VecOf<'i32',Size<T>>>;toUint():Node<VecOf<'u32',Size<T>>>;
}

const vectorRe=/^vec([234])(f|i|u|<bool>)$/,matrixRe=/^mat([234])x\1f$/;
export const scalarOf=(t:Type):Scalar=>matrixRe.test(t)?'f32':(vectorRe.exec(t)?.[2]==='<bool>'?'bool':({f:'f32',i:'i32',u:'u32'} as Record<string,Scalar>)[vectorRe.exec(t)?.[2]??'']??t as Scalar);
export const sizeOf=(t:Type):number=>+(vectorRe.exec(t)?.[1]??1);
export const isMatrix=(t:Type):boolean=>matrixRe.test(t);
export const vecOf=(s:Scalar,n:number):Type=>(n===1?s:s==='bool'?`vec${n}<bool>`:`vec${n}${s[0]}`) as Type;
const fail=(message:string):never=>{throw new TypeError(message);};

function literal(v:number|boolean,t:Scalar):string {
  if(t==='bool')return String(!!v);
  if(typeof v!=='number'||!Number.isFinite(v))return fail(`Shader constant must be a finite number, got ${String(v)}`);
  if(t!=='f32'){if(!Number.isInteger(v)||t==='u32'&&v<0)fail(`${v} is not a valid ${t} constant`);return v+t[0];}
  const s=String(v);return /[.e]/.test(s)?s:s+'.0';
}
/** A constant (`float(0.5)`) or the conversion of a node (`float(intNode)`). */
export function constant<T extends Type>(value:number|boolean,type:T):Node<T> {
  const s=scalarOf(type),text=literal(value,s);
  return new Node(type,'l'+text,[],()=>type===s?text:`${type}(${text})`,LEAF|(text[0]==='-'?OP:0));
}
/** Lifts a number to `type` (scalars splat into vectors) and checks a node already has it. */
export function cast<T extends Type>(x:Input|boolean,type:T,label='value'):Node<T> {
  if(!(x instanceof Node))return constant(x,type);
  if(x.type===type)return x as Node<T>;
  if(sizeOf(x.type)===1&&!isMatrix(x.type)&&scalarOf(x.type)===scalarOf(type)&&!isMatrix(type))return splat(x,type);
  return fail(`${label} must be ${type}, got ${x.type}`);
}
const splat=<T extends Type>(x:Node,type:T):Node<T>=>new Node(type,'s',[x],(b,n)=>`${type}(${b.expr(n.args[0])})`);
const node=(x:Input|boolean):Node=>x instanceof Node?x:constant(x,typeof x==='boolean'?'bool':'f32');
/** Widest of several operands: numbers adopt the nodes' scalar type, scalars splat to the vector size. */
function unify(name:string,args:(Input|boolean)[]):Node[] {
  const nodes=args.filter(a=>a instanceof Node) as Node[],first=nodes[0]?.type??'f32';
  const target:Type=nodes.reduce<Type>((t,n)=>sizeOf(n.type)>sizeOf(t)||isMatrix(n.type)?n.type:t,first);
  if(nodes.some(n=>scalarOf(n.type)!==scalarOf(target)||n.type!==target&&sizeOf(n.type)!==1))fail(`${name}(${args.map(a=>a instanceof Node?a.type:typeof a).join(', ')}): operand types do not match`);
  return args.map((a,i)=>cast(a,target,`${name} argument ${i+1}`));
}
/** A WGSL built-in or user function call; `rule` picks the result type from the unified arguments. */
export function call<T extends Type>(name:string,args:Node[],type:T,wgsl=name):Node<T> {
  return new Node(type,'c'+wgsl,args,(b,n)=>`${wgsl}(${n.args.map(a=>b.expr(a)).join(', ')})`);
}
const same=(name:string,wgsl=name)=>(...a:Input[]):Node<any>=>{const u=unify(name,a);return call(name,u,u[0].type,wgsl);};
const reduce=(name:string)=>(...a:Input[]):Node<any>=>{const u=unify(name,a);return call(name,u,scalarOf(u[0].type),name);};
const unary=(op:string,x:Node):Node<any>=>new Node(x.type,'u'+op,[x],(b,n)=>op+b.wrap(n.args[0]),OP);

function binary(op:string,a:Input|boolean,b:Input|boolean,compare:boolean):Node<any> {
  let x=node(a),y=node(b);
  if(!(a instanceof Node))x=cast(a,scalarOf(y.type));
  if(!(b instanceof Node))y=cast(b,scalarOf(x.type));
  let type:Type|undefined;const s=scalarOf(x.type);
  if(compare||op==='&&'||op==='||'){[x,y]=unify(op,[x,y]);type=vecOf('bool',sizeOf(x.type));if(!compare&&s!=='bool')fail(`${op} needs bool operands`);}
  else if(x.type===y.type)type=x.type;
  else if(s===scalarOf(y.type)&&(sizeOf(x.type)===1&&!isMatrix(x.type)||sizeOf(y.type)===1&&!isMatrix(y.type)))type=sizeOf(x.type)===1&&!isMatrix(x.type)?y.type:x.type;
  else if(op==='*'&&isMatrix(x.type)&&y.type===`vec${x.type[3]}f`)type=y.type;
  else if(op==='*'&&isMatrix(y.type)&&x.type===`vec${y.type[3]}f`)type=x.type;
  if(!type||s==='bool'&&!compare&&op!=='&&'&&op!=='||')return fail(`${x.type} ${op} ${y.type}: operand types do not combine`);
  return new Node(type,'o'+op,[x,y],(b,n)=>`${b.wrap(n.args[0])} ${op} ${b.wrap(n.args[1])}`,OP);
}
export const add=(a:Input,b:Input):Node<any>=>binary('+',a,b,false);
export const sub=(a:Input,b:Input):Node<any>=>binary('-',a,b,false);
export const mul=(a:Input,b:Input):Node<any>=>binary('*',a,b,false);
export const div=(a:Input,b:Input):Node<any>=>binary('/',a,b,false);
export const mod=(a:Input,b:Input):Node<any>=>binary('%',a,b,false);

/** WGSL built-ins. Scalars and numbers splat to the widest argument, so `mix(a, b, 0.5)` and `clamp(v, 0, 1)` work for vectors. */
export const abs=same('abs'),sign=same('sign'),floor=same('floor'),ceil=same('ceil'),round=same('round'),trunc=same('trunc'),fract=same('fract');
export const sin=same('sin'),cos=same('cos'),tan=same('tan'),asin=same('asin'),acos=same('acos'),atan=same('atan'),tanh=same('tanh'),atan2=same('atan2');
export const exp=same('exp'),exp2=same('exp2'),log=same('log'),log2=same('log2'),sqrt=same('sqrt'),inverseSqrt=same('inverseSqrt'),saturate=same('saturate');
export const normalize=same('normalize'),radians=same('radians'),degrees=same('degrees'),dpdx=same('dpdx'),dpdy=same('dpdy'),fwidth=same('fwidth');
export const min=same('min'),max=same('max'),pow=same('pow'),clamp=same('clamp'),step=same('step'),smoothstep=same('smoothstep'),mix=same('mix'),reflect=same('reflect'),cross=same('cross');
export const length=reduce('length'),distance=reduce('distance'),dot=reduce('dot');
export const refract=(i:Input<'vec3f'>,n:Input<'vec3f'>,eta:Input<'f32'>):Node<'vec3f'>=>call('refract',[cast(i,'vec3f'),cast(n,'vec3f'),cast(eta,'f32')],'vec3f');
export const oneMinus=<T extends Type>(x:Node<T>):Node<T>=>binary('-',1,x,false);
export const negate=<T extends Type>(x:Node<T>):Node<T>=>unary('-',x);
export const not=<T extends Type>(x:Node<T>):Node<T>=>scalarOf(x.type)==='bool'?unary('!',x):fail('not() needs bool');
/** `cond ? ifTrue : ifFalse` per component (both sides are evaluated). */
export function select<T extends Type>(cond:Node<'bool'|`vec${N}<bool>`>|boolean,ifTrue:Input<T>,ifFalse:Input<T>):Node<T> {
  const [t,f]=unify('select',[ifTrue,ifFalse]),c=cast(cond,sizeOf(cond instanceof Node?cond.type:'bool')===1?'bool':vecOf('bool',sizeOf(t.type)),'select condition');
  return call('select',[f,t,c],t.type as T);
}
/** Discards the fragment where `condition` holds and is `value` elsewhere: `colorNode: discard(texture(map).a.lessThan(0.5), texture(map))`.
 * NodeMaterial fragment nodes and NodePass nodes only (a discarded NodePass pixel stays the cleared transparent black). */
export function discard<T extends Type>(condition:Input<'bool'>|boolean,value:Input<T>):Node<T> {
  const v=node(value) as Node<T>;
  return new Node(v.type,'d',[cast(condition,'bool','discard condition'),v],(b,n)=>{
    if(b.stage.kind!=='fragment'&&b.stage.kind!=='post')fail(`discard() is not available in ${b.stage.kind} nodes`);
    b.line(`if (${b.expr(n.args[0])}) { discard; }`);const name=b.name();b.line(`let ${name} = ${b.expr(n.args[1])};`);return name;
  },STMT);
}
function convert<T extends Type>(x:Input|boolean,type:T):Node<T> {
  if(!(x instanceof Node))return constant(x,type);
  if(x.type===type)return x as Node<T>;
  if(isMatrix(type)||isMatrix(x.type)||sizeOf(x.type)!==1&&sizeOf(x.type)!==sizeOf(type))fail(`Cannot convert ${x.type} to ${type}`);
  return new Node(type,'v',[x],(b,n)=>`${type}(${b.expr(n.args[0])})`);
}
/** Builds a vector or matrix from scalars and smaller vectors (`vec4(rgb, 1)`), or splats one scalar. */
function construct<T extends Type>(type:T,parts:(Input|boolean)[]):Node<T> {
  const s=scalarOf(type),total=isMatrix(type)?(+type[3])**2:sizeOf(type);
  if(parts.length===1&&!(isMatrix(type)&&parts[0] instanceof Node&&parts[0].type===type))return convert(parts[0],type);
  const args=parts.map(p=>{const n=p instanceof Node?p:constant(p,s);return scalarOf(n.type)===s?n:convert(n,vecOf(s,sizeOf(n.type)));});
  const count=args.reduce((sum,a)=>sum+(isMatrix(a.type)?total:sizeOf(a.type)),0);
  if(count!==total)fail(`${type} needs ${total} components, got ${count}`);
  return new Node(type,'k',args,(b,n)=>`${type}(${n.args.map(a=>b.expr(a)).join(', ')})`);
}
type Part=Input|boolean;
export const float=(x:Part):Node<'f32'>=>convert(x,'f32'),int=(x:Part):Node<'i32'>=>convert(x,'i32'),uint=(x:Part):Node<'u32'>=>convert(x,'u32'),bool=(x:Part):Node<'bool'>=>convert(x,'bool');
export const vec2=(...p:Part[]):Node<'vec2f'>=>construct('vec2f',p),vec3=(...p:Part[]):Node<'vec3f'>=>construct('vec3f',p),vec4=(...p:Part[]):Node<'vec4f'>=>construct('vec4f',p);
export const ivec2=(...p:Part[]):Node<'vec2i'>=>construct('vec2i',p),ivec3=(...p:Part[]):Node<'vec3i'>=>construct('vec3i',p),ivec4=(...p:Part[]):Node<'vec4i'>=>construct('vec4i',p);
export const uvec2=(...p:Part[]):Node<'vec2u'>=>construct('vec2u',p),uvec3=(...p:Part[]):Node<'vec3u'>=>construct('vec3u',p),uvec4=(...p:Part[]):Node<'vec4u'>=>construct('vec4u',p);
/** Column-major: three vec3 columns or nine numbers. */
export const mat3=(...p:Part[]):Node<'mat3x3f'>=>construct('mat3x3f',p),mat4=(...p:Part[]):Node<'mat4x4f'>=>construct('mat4x4f',p);
export type ColorValue=string|number|readonly number[];
/** `'#rrggbb'` or `0xrrggbb` (sRGB) or linear `[r, g, b]`, as linear RGB. */
export function linearColor(c:ColorValue):number[] {
  const hex=typeof c==='number'?c:typeof c==='string'&&/^#[0-9a-f]{6}$/i.test(c)?parseInt(c.slice(1),16):undefined;
  const v=hex!==undefined&&hex>=0&&hex<=0xffffff?[16,8,0].map(k=>{const x=(hex>>k&255)/255;return x<=0.04045?x/12.92:((x+0.055)/1.055)**2.4;}):Array.isArray(c)&&c.length===3?[...c as number[]]:fail('Expected a #rrggbb or 0xrrggbb colour or [r, g, b]');
  return v.map(x=>Math.round(x*1e6)/1e6);
}
export const color=(c:ColorValue):Node<'vec3f'>=>construct('vec3f',linearColor(c));

const swizzle=(x:Node,s:string):Node=>{
  const index=[...s].map(c=>'xyzwrgba'.indexOf(c)%4),size=sizeOf(x.type),type=vecOf(scalarOf(x.type),s.length),xyzw=index.map(i=>'xyzw'[i]).join('');
  if(isMatrix(x.type))fail(`.${s} is not valid on ${x.type}`);
  if(size===1)return index.some(i=>i)?fail(`.${s} is not valid on a scalar`):s.length===1?x:splat(x,type);
  if(index.some(i=>i>=size))fail(`.${s} is out of range for ${x.type}`);
  return new Node(type,'.'+xyzw,[x],(b,n)=>{
    // A host builtin such as `i.uv.xy` composes (`i.uv.y`); user expressions never do.
    const inner=b.wrap(n.args[0]),m=b.program.canon(n.args[0]).key[0]==='b'&&/^([\w.]+)\.([xyzw]{1,4})$/.exec(inner);
    return m?`${m[1]}.${index.map(i=>m[2][i]).join('')}`:`${inner}.${xyzw}`;
  });
};
const P=Node.prototype as any,combos=(chars:string,n:number):string[]=>n?combos(chars,n-1).flatMap(p=>[...chars].map(c=>p+c)):[''];
for(const chars of ['xyzw','rgba'])for(let n=1;n<5;n++)for(const k of combos(chars,n))Object.defineProperty(P,k,{get(){return swizzle(this,k);}});
for(const [name,op] of [['add','+'],['sub','-'],['mul','*'],['div','/'],['mod','%'],['and','&&'],['or','||']])P[name]=function(b:Input){return binary(op,this,b,false);};
for(const [name,op] of [['lessThan','<'],['lessThanEqual','<='],['greaterThan','>'],['greaterThanEqual','>='],['equal','=='],['notEqual','!=']])P[name]=function(b:Input){return binary(op,this,b,true);};
const methods:Record<string,(...a:any[])=>Node<any>>={abs,sign,floor,ceil,round,trunc,fract,sin,cos,tan,asin,acos,atan,tanh,exp,exp2,log,log2,sqrt,inverseSqrt,saturate,normalize,radians,degrees,dpdx,dpdy,fwidth,
  min,max,pow,clamp,step,mix,reflect,cross,length,distance,dot,oneMinus,negate,not,toFloat:(x:Node)=>convert(x,vecOf('f32',sizeOf(x.type))),toInt:(x:Node)=>convert(x,vecOf('i32',sizeOf(x.type))),toUint:(x:Node)=>convert(x,vecOf('u32',sizeOf(x.type)))};
for(const name in methods)P[name]=function(...a:any[]){return methods[name](this,...a);};
P.element=function(this:Node,i:Input<'i32'|'u32'>){
  const m=isMatrix(this.type);if(!m&&sizeOf(this.type)===1)fail('element() needs a vector or matrix');
  const index=i instanceof Node?i:constant(i,'i32');return new Node(m?vecOf('f32',+this.type[3]):scalarOf(this.type),'[]',[this,index],(b,n)=>`${b.wrap(n.args[0])}[${b.expr(n.args[1])}]`);
};

/** A per-stage built-in such as `uv()` or `normalWorld`; the host stage decides what it reads. */
export const builtin=<T extends Type>(name:string,type:T):Node<T>=>new Node(type,'b'+name,[],b=>b.builtin(name),LEAF);
export const uv=():Node<'vec2f'>=>builtin('uv','vec2f');
export const vertexColor=():Node<'vec4f'>=>builtin('vertexColor','vec4f');
export const positionLocal=/*@__PURE__*/builtin('positionLocal','vec3f'),positionWorld=/*@__PURE__*/builtin('positionWorld','vec3f');
export const normalLocal=/*@__PURE__*/builtin('normalLocal','vec3f'),normalWorld=/*@__PURE__*/builtin('normalWorld','vec3f');
/** Unit vector from the surface to the camera. */
export const viewDirection=/*@__PURE__*/builtin('viewDirection','vec3f'),cameraPosition=/*@__PURE__*/builtin('cameraPosition','vec3f');
/** Framebuffer pixel coordinate and its 0-1 UV (origin top left). */
export const screenCoordinate=/*@__PURE__*/builtin('screenCoordinate','vec2f'),screenUV=/*@__PURE__*/builtin('screenUV','vec2f');
const frame=<T extends Type>(name:string,type:T):Node<T>=>new Node(type,'f'+name,[],b=>b.frame(name,type),LEAF);
/** Seconds since the page loaded, the last frame's duration and the target size in pixels; uniforms the host fills each frame. */
export const time=/*@__PURE__*/frame('time','f32'),deltaTime=/*@__PURE__*/frame('deltaTime','f32'),resolution=/*@__PURE__*/frame('resolution','vec2f');

/** Interpolates a vertex-stage value to the fragment stage (material nodes only; elsewhere it is the value itself). */
export function varying<T extends Type>(x:Node<T>):Node<T> {
  if(scalarOf(x.type)==='bool'||isMatrix(x.type))fail('varying() needs a numeric scalar or vector');
  return new Node(x.type,'y',[x],(b,n)=>b.stage.varying?b.stage.varying(b,n.args[0]):b.expr(n.args[0]),LEAF);
}
const param=<T extends Type>(type:T):Node<T>=>new Node(type,'p'+unique(),[],(b,n)=>b.param(n),LEAF);
/** A bounded fold: `loop(8, init, (i, acc) => next)` runs `acc = next` for i = 0..count-1 and returns the final `acc`. */
export function loop<T extends Type>(count:Input<'i32'|'u32'>,init:Input<T>,body:(i:Node<'i32'>,acc:Node<T>)=>Input<T>):Node<T> {
  const start=node(init) as Node<T>,i=param('i32'),acc=param(start.type),next=cast(nested(()=>body(i,acc)),start.type,'loop body result');
  const n=count instanceof Node?(count.type==='i32'?count:convert(count,'i32')):constant(count,'i32');
  return new Node(start.type,'r'+unique(),[n,start,next],(b,x)=>{
    const limit=b.expr(x.args[0]),first=b.expr(x.args[1]),a=b.name(),k=b.name();
    b.line(`var ${a} = ${first};`);b.bind(i,k);b.bind(acc,a);b.push();const value=b.expr(x.args[2]),lines=b.pop();
    b.line(`for (var ${k} = 0i; ${k} < ${limit}; ${k}++) {`);for(const l of lines)b.line('  '+l);b.line(`  ${a} = ${value};`);b.line('}');return a;
  },STMT);
}
interface Spec {name:string;id:number;params:Node[];result:Node}
/** A reusable WGSL function. Annotate parameters (`(a: Node<'vec3f'>, t: Node<'f32'>) => ...`); each argument-type signature
 * emits one function, named `name` (then `name_1`, ...) in each shader. Stage inputs such as `uv()` must be passed in as arguments. */
export function Fn<P extends Type[],R extends Type>(body:(...args:{[K in keyof P]:Node<P[K]>})=>Node<R>,name='func'):(...args:{[K in keyof P]:Input<P[K]>})=>Node<R> {
  if(!/^[a-zA-Z]\w*$/.test(name)||name.startsWith('nd')||name==='fn')fail('Fn names are WGSL identifiers not starting with nd');
  const specs=new Map<string,Spec>();
  return (...input)=>{
    const args=input.map(a=>node(a as Input)),sig=args.map(a=>a.type).join();let spec=specs.get(sig);
    if(!spec){const params=args.map(a=>param(a.type));spec={name,id:unique(),params,result:node(nested(()=>(body as any)(...params)))};specs.set(sig,spec);}
    const s=spec;return new Node(s.result.type as R,'n'+s.id,args,(b,n)=>`${b.fn(s)}(${n.args.map(a=>b.expr(a)).join(', ')})`);
  };
}
/** Wraps hand-written WGSL: the first `fn name(a: T, ...) -> R` is the one called; further functions in `code` come along. */
export function wgslFn<R extends Type=Type>(code:string):(...args:Input[])=>Node<R> {
  const m=/fn\s+(\w+)\s*\(([^)]*)\)\s*->\s*([\w<>]+)/.exec(code)??fail('wgslFn needs "fn name(params) -> type"');
  const params=m[2].split(',').filter(p=>p.trim()).map(p=>p.split(':')[1]?.trim() as Type);
  return (...args)=>{
    if(args.length!==params.length)fail(`${m[1]} takes ${params.length} arguments, got ${args.length}`);
    return new Node(m[3] as R,'w'+code,args.map((a,i)=>cast(a,params[i],`${m[1]} argument ${i+1}`)),(b,n)=>{b.declare(code,code);return `${m[1]}(${n.args.map(a=>b.expr(a)).join(', ')})`;});
  };
}

/** A value that changes without recompiling: assign `.value` any time; the host uploads it with each frame. */
export class UniformNode<T extends Type=Type> extends Node<T> {
  private data:number[];
  constructor(value:number|ColorValue,type:T,readonly name?:string){
    super(type,'u'+unique(),[],(b,n)=>b.uniform(n as UniformNode),LEAF);
    if(scalarOf(type)==='bool')fail('Uniforms cannot be bool; use u32');
    if(name!==undefined&&(!/^[a-zA-Z]\w*$/.test(name)||/^(alias|break|case|const|const_assert|continue|continuing|default|diagnostic|discard|else|enable|false|fn|for|if|let|loop|override|requires|return|struct|switch|true|var|while|[fiu]32|f16|bool|vec\d\w*|mat\d\w*|array|atomic|ptr|sampler\w*|texture\w*)$/.test(name)))fail(`Uniform name ${name} is not a usable WGSL identifier`);
    this.data=[];this.value=value as never;
  }
  get value():T extends Scalar?number:number[] {return (this.data.length===1?this.data[0]:[...this.data]) as never;}
  set value(v:T extends Scalar?number:number[]|ColorValue) {
    const size=isMatrix(this.type)?(+this.type[3])**2:sizeOf(this.type),d=typeof v==='number'&&size===1?[v]:typeof v==='string'||typeof v==='number'?linearColor(v):Array.from(v as ArrayLike<number>);
    if(d.length!==size||d.some(x=>!Number.isFinite(x)))fail(`Uniform ${this.name??''} needs ${size} finite numbers`);
    this.data=d;
  }
  /** @internal */
  write(out:DataView,offset:number):void {
    const s=scalarOf(this.type),rows=isMatrix(this.type)?+this.type[3]:0;
    this.data.forEach((v,i)=>{const at=offset+(rows?Math.floor(i/rows)*(rows===2?8:16)+i%rows*4:i*4);s==='f32'?out.setFloat32(at,v,true):s==='i32'?out.setInt32(at,v,true):out.setUint32(at,v,true);});
  }
}
/** A live value; the type follows the value (number f32, colour string vec3f, 2/3/4 numbers vecNf, 9 mat3x3f, 16 mat4x4f) or `type` (`uniform(3, {type: 'u32'})` is a `UniformNode<'u32'>`, e.g. a live `perlin3` seed). */
export function uniform(value:number,options?:{type?:'f32';name?:string}):UniformNode<'f32'>;
export function uniform(value:string,options?:{name?:string}):UniformNode<'vec3f'>;
export function uniform(value:readonly [number,number],options?:{type?:'vec2f'|'vec2i'|'vec2u';name?:string}):UniformNode<'vec2f'>;
export function uniform(value:readonly [number,number,number],options?:{type?:'vec3f'|'vec3i'|'vec3u';name?:string}):UniformNode<'vec3f'>;
export function uniform(value:readonly [number,number,number,number],options?:{type?:'vec4f'|'vec4i'|'vec4u'|'mat2x2f';name?:string}):UniformNode<'vec4f'>;
export function uniform<T extends Type>(value:number|ColorValue,options:{type:T;name?:string}):UniformNode<T>;
export function uniform(value:number|ColorValue,options:{type?:Type;name?:string}={}):UniformNode<any> {
  const n=typeof value==='string'?3:typeof value==='number'?1:(value as number[]).length;
  return new UniformNode(value,options.type??({1:'f32',2:'vec2f',3:'vec3f',4:'vec4f',9:'mat3x3f',16:'mat4x4f'} as Record<number,Type>)[n]??fail('Unsupported uniform value'),options.name);
}

/** Host-side inputs a resource or frame uniform reads when bindings are built. */
export interface Host {width:number;height:number;delta?:number;[key:string]:unknown}
/** A bound GPU resource (texture, buffer, frame input). `declare` writes its WGSL variables; `entries` returns one resource per binding. */
export interface Resource {readonly prefix:string;readonly bindings:number;declare(name:string,group:number,binding:number,compute:boolean):string;entries(device:GPUDevice,host:Host):GPUBindingResource[]}
export interface Stage {readonly kind:'vertex'|'fragment'|'post'|'compute';readonly builtins:Readonly<Record<string,string|((b:Builder)=>string)>>;varying?(b:Builder,x:Node):string}
const align=(t:Type)=>isMatrix(t)?(t[3]==='2'?8:16):[4,8,16,16][sizeOf(t)-1],bytes=(t:Type)=>isMatrix(t)?(t[3]==='2'?16:+t[3]*16):sizeOf(t)*4;

/** One compiled shader: shared uniforms, resources and functions for one or more stages. Output text is stable for equal graphs. */
export class Program {
  /** Uniform block members in first-use order. */
  readonly members:{name:string;type:Type;offset:number;node?:UniformNode;frame?:string}[]=[];
  readonly resources:{resource:Resource;name:string;binding:number}[]=[];
  readonly varyings:Node[]=[];
  /** @internal Fn specialisation key to WGSL name. */ readonly functions=new Map<string,string>();
  private readonly declarations=new Map<string,string>();private readonly canonical=new Map<string,Node>();private readonly canonOf=new Map<Node,Node>();
  private readonly ids=new Map<Node,number>();private readonly refs=new Map<Node,number>();
  private size=16;private counter=0;private next:number;private block?:{resource:Resource;name:string;binding:number};
  private readonly buffers=new WeakMap<GPUDevice,{buffer:GPUBuffer;view:DataView;bytes:Uint8Array;last:number}>();
  constructor(readonly base=0,readonly compute=false){this.next=base;}
  /** Compiles `outputs` for one stage; returns its statements and one expression per output. */
  stage(stage:Stage,outputs:readonly Node[]):{lines:string[];values:string[]} {
    for(const o of outputs)this.count(o);
    const b=new Builder(this,stage),values=outputs.map(o=>b.expr(o));return {lines:b.pop(),values};
  }
  /** Module-scope WGSL: uniform struct, resource bindings and functions. */
  declare(group:number):string {
    const out:string[]=[];
    for(const r of this.resources){
      if(r===this.block)out.push(`struct NdUniforms {\n${this.members.map(m=>`  ${m.name}:${m.type},`).join('\n')}\n}\n@group(${group}) @binding(${r.binding}) var<uniform> ndu:NdUniforms;`);
      else out.push(r.resource.declare(r.name,group,r.binding,this.compute));
    }
    return [...out,...this.declarations.values()].join('\n');
  }
  /** Bind group entries; uploads uniforms (and frame values) first. */
  entries(device:GPUDevice,host:Host):GPUBindGroupEntry[] {
    return this.resources.flatMap(r=>(r===this.block?[{buffer:this.upload(device,host)}]:r.resource.entries(device,host)).map((resource,i)=>({binding:r.binding+i,resource})));
  }
  private upload(device:GPUDevice,host:Host):GPUBuffer {
    let u=this.buffers.get(device);const now=performance.now()/1000;
    if(!u){const data=new ArrayBuffer(this.size);u={buffer:device.createBuffer({label:'shader:uniforms',size:this.size,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),view:new DataView(data),bytes:new Uint8Array(data),last:now};this.buffers.set(device,u);}
    for(const m of this.members){
      if(m.node){m.node.write(u.view,m.offset);continue;}
      const v=m.frame==='time'?[now]:m.frame==='deltaTime'?[host.delta??now-u.last]:[host.width,host.height];v.forEach((x,i)=>u.view.setFloat32(m.offset+i*4,x,true));
    }
    u.last=now;device.queue.writeBuffer(u.buffer,0,u.bytes as Uint8Array<ArrayBuffer>);return u.buffer;
  }
  /** @internal */ name():string {return 'nd'+this.counter++;}
  /** @internal */ canon(n:Node):Node {
    let c=this.canonOf.get(n);if(c)return c;
    if(!(n instanceof Node))fail('Expected a shader node');
    const key=n.type+n.key+'('+n.args.map(a=>this.ids.get(this.canon(a))).join()+')';c=this.canonical.get(key);
    if(!c){c=n;this.canonical.set(key,n);this.ids.set(n,this.ids.size);}this.canonOf.set(n,c);return c;
  }
  /** @internal */ count(n:Node):void {const c=this.canon(n),r=(this.refs.get(c)??0)+1;this.refs.set(c,r);if(r===1)for(const a of c.args)this.count(a);}
  /** @internal */ shared(c:Node):boolean {return (this.refs.get(c)??0)>1;}
  /** @internal */ declareOnce(key:string,code:()=>string):void {if(!this.declarations.has(key)){this.declarations.set(key,'');this.declarations.set(key,code());}}
  /** @internal */ resource(resource:Resource):string {
    let r=this.resources.find(x=>x.resource===resource);
    if(!r){r={resource,name:resource.prefix+this.resources.length,binding:this.next};this.next+=resource.bindings;this.resources.push(r);}
    return r.name;
  }
  /** @internal */ member(type:Type,name:string,node?:UniformNode,frame?:string):string {
    let m=this.members.find(x=>node?x.node===node:x.frame===frame);
    if(!m){
      if(!this.block)this.block={resource:{prefix:'ndu',bindings:1,declare:()=>'',entries:()=>[]},name:'ndu',binding:this.next++},this.resources.push(this.block);
      let unique=name,k=1;while(this.members.some(x=>x.name===unique))unique=name+k++;
      const offset=Math.ceil((this.members.length?this.members.at(-1)!.offset+bytes(this.members.at(-1)!.type):0)/align(type))*align(type);
      m={name:unique,type,offset,node,frame};this.members.push(m);this.size=Math.max(16,Math.ceil((offset+bytes(type))/16)*16);
    }
    return 'ndu.'+m.name;
  }
}

/** True when two entry lists bind the same resources (a uniform `{buffer}` compares by buffer). */
export const sameEntries=(a:readonly GPUBindGroupEntry[],b:readonly GPUBindGroupEntry[]):boolean=>a.length===b.length&&a.every((e,i)=>{const x=e.resource as any,y=b[i].resource as any;return e.binding===b[i].binding&&(x===y||!!x?.buffer&&x.buffer===y?.buffer&&x.offset===y.offset&&x.size===y.size);});
/** Emits one stage. Expressions referenced more than once become `let ndN`; everything else is inlined. */
export class Builder {
  inFn=false;
  private scopes:string[][]=[[]];private readonly memo=new Map<Node,{name:string;scope:string[]}>();private readonly params=new Map<Node,string>();
  constructor(readonly program:Program,readonly stage:Stage){}
  expr(n:Node):string {
    const c=this.program.canon(n),m=this.memo.get(c);
    if(m&&this.scopes.includes(m.scope))return m.name;
    const code=c.emit(this,c),scope=this.scopes.at(-1)!;
    if(c.flags&STMT){this.memo.set(c,{name:code,scope});return code;}
    if(c.flags&LEAF||!this.program.shared(c))return code;
    const name=this.program.name();this.line(`let ${name} = ${code};`);this.memo.set(c,{name,scope});return name;
  }
  /** The expression, parenthesised when it is an inlined operator. */
  wrap(n:Node):string {const s=this.expr(n);return this.program.canon(n).flags&OP&&!/^[\w.]+$/.test(s)?`(${s})`:s;}
  line(code:string):void {this.scopes.at(-1)!.push(code);}
  push():void {this.scopes.push([]);}
  pop():string[] {return this.scopes.pop()!;}
  name():string {return this.program.name();}
  bind(param:Node,name:string):void {this.params.set(this.program.canon(param),name);}
  param(n:Node):string {return this.params.get(n)??fail('A loop or Fn parameter was used outside its body');}
  /** A stage-local expression (reads entry-point inputs), refused inside Fn bodies. */
  local(code:string):string {return this.inFn?fail('Stage inputs such as uv() cannot be read inside Fn; pass them as arguments'):code;}
  builtin(name:string):string {
    const v=this.stage.builtins[name];if(v===undefined)fail(`${name} is not available in ${this.stage.kind} nodes`);
    return typeof v==='string'?this.local(v):v(this);
  }
  resource(r:Resource):string {return this.program.resource(r);}
  uniform(u:UniformNode):string {return this.program.member(u.type,u.name??'u',u);}
  frame(name:string,type:Type):string {return this.program.member(type,name,undefined,name);}
  declare(key:string,code:string):void {this.program.declareOnce(key,()=>code);}
  /** Declares a Fn specialisation once per program and returns its WGSL name. */
  fn(spec:Spec):string {
    const key='fn#'+spec.id,names=this.program.functions;let name=names.get(key);if(name)return name;
    name=spec.name;for(let k=1;[...names.values()].includes(name);k++)name=spec.name+'_'+k;names.set(key,name);
    const b=new Builder(this.program,this.stage);b.inFn=true;spec.params.forEach((p,i)=>b.bind(p,'p'+i));this.program.count(spec.result);
    this.program.declareOnce(key,()=>{const value=b.expr(spec.result),lines=b.pop();
      return `fn ${name}(${spec.params.map((p,i)=>`p${i}:${p.type}`).join(', ')}) -> ${spec.result.type} {\n${lines.map(l=>'  '+l+'\n').join('')}  return ${value};\n}`;});
    return name;
  }
}
