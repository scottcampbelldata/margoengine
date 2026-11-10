import { defineSchema, type FieldType, type NormalizedField, type NormalizedSchema } from './schema.js';

/** Options for standalone Rust generation. */
export interface GenerateRustOptions {
  /** Optional source label, sanitized to one comment line. */
  source?: string;
}
const RUNTIME = String.raw`
/// Checked codec support. Generated types use only Rust's standard library.
#[allow(dead_code)]
pub mod margo_wire {
use std::collections::BTreeMap;
/// Invalid value, malformed bytes or unsupported nesting. Never a partial decode.
#[derive(Debug, Clone, PartialEq)] pub struct Error(pub &'static str);
impl std::fmt::Display for Error { fn fmt(&self,f:&mut std::fmt::Formatter<'_>)->std::fmt::Result { write!(f,"Schema codec: {}; use validated values and matching schema bytes (https://margoengine.com/docs/errors)",self.0) } }
impl std::error::Error for Error {}
pub type Result<T> = std::result::Result<T,Error>;
#[derive(Clone,Debug)] pub(super) enum V { U(u32), I(i32), N(f64), B(bool), S(String), Bytes(Vec<u8>), E(u32), A(Vec<V>), O(Option<Box<V>>), M(BTreeMap<u32,V>), T(Vec<V>) }
pub(super) enum F { U(usize), I(usize), Uint, Int, Float(usize), Bool, Quant(f64,f64,u32), Text(usize), Bytes(usize), Enum(u32), Array(&'static F,usize), Optional(&'static F), Map(&'static F,usize), Struct(usize) }
fn err<T>(s:&'static str)->Result<T> { Err(Error(s)) }
fn var(w:&mut Vec<u8>,mut n:u32) { while n>127 { w.push((n as u8 & 127)|128); n>>=7; } w.push(n as u8); }
fn count_write(w:&mut Vec<u8>,n:usize,max:usize)->Result<()> { if n>max || n>u32::MAX as usize {return err("count exceeds schema limit");} var(w,n as u32); Ok(()) }
struct R<'a> { b:&'a [u8], at:usize }
impl<'a> R<'a> {
fn raw(&mut self,n:usize)->Result<&'a [u8]> { if n>self.b.len()-self.at {return err("truncated input");} let at=self.at;self.at+=n;Ok(&self.b[at..self.at]) }
fn byte(&mut self)->Result<u8> {Ok(self.raw(1)?[0])}
fn uint(&mut self,n:usize)->Result<u32> { let mut v=0u32; for (i,b) in self.raw(n)?.iter().enumerate() {v|=(*b as u32)<<(8*i);} Ok(v) }
fn var(&mut self)->Result<u32> { let mut n=0; for i in 0..5 {let b=self.byte()?; if i==4 && b>15 {return err("varint exceeds 32 bits");} n|=((b&127) as u32)<<(7*i);if b<128 {return Ok(n);}} err("invalid varint") }
fn count(&mut self,max:usize)->Result<usize> {let n=self.var()? as usize;if n>max || n>self.b.len()-self.at {return err("count exceeds schema or remaining input");}Ok(n)}
fn ids(&mut self,max:usize)->Result<Vec<u32>> {let n=self.count(max)?;let mut out=Vec::new();let mut next=0u64;for _ in 0..n {let id=next+self.var()? as u64;if id>u32::MAX as u64 {return err("entity id overflow");}out.push(id as u32);next=id+1;}Ok(out)}
}
fn ids(w:&mut Vec<u8>,keys:&[u32]) {var(w,keys.len() as u32);let mut next=0u64;for key in keys {var(w,(*key as u64-next) as u32);next=*key as u64+1;}}
fn q(v:f64,min:f64,max:f64,bits:u32)->u32 {((v-min)*(((1u64<<bits)-2) as f64/(max-min))).round() as u32}
pub(super) fn same(f:&F,a:&V,b:&V)->bool { match (f,a,b) {
(F::Float(4),V::N(a),V::N(b))=>(*a as f32)==(*b as f32),
(F::Quant(min,max,bits),V::N(a),V::N(b))=>q(*a,*min,*max,*bits)==q(*b,*min,*max,*bits),
(_,V::U(a),V::U(b))=>a==b,(_,V::I(a),V::I(b))=>a==b,(_,V::N(a),V::N(b))=>a==b,(_,V::B(a),V::B(b))=>a==b,(_,V::S(a),V::S(b))=>a==b,(_,V::Bytes(a),V::Bytes(b))=>a==b,(_,V::E(a),V::E(b))=>a==b,
(F::Array(f,_),V::A(a),V::A(b))=>a.len()==b.len()&&a.iter().zip(b).all(|(a,b)|same(f,a,b)),
(F::Optional(f),V::O(a),V::O(b))=>match(a,b){(Some(a),Some(b))=>same(f,a,b),(None,None)=>true,_=>false},
(F::Map(f,_),V::M(a),V::M(b))=>a.len()==b.len()&&a.iter().all(|(id,a)|b.get(id).is_some_and(|b|same(f,a,b))),
(F::Struct(i),V::T(a),V::T(b))=>a.len()==b.len()&&super::__TYPES[*i].iter().zip(a.iter().zip(b)).all(|(f,(a,b))|same(f,a,b)),_=>false } }
fn write(f:&F,v:&V,w:&mut Vec<u8>,depth:usize)->Result<()> {if depth>256{return err("nesting exceeds 256");}match(f,v){
(F::U(n),V::U(v))=>{if *n<4 && *v>=(1u32<<(8*n)){return err("unsigned integer out of range");}w.extend_from_slice(&v.to_le_bytes()[..*n]);},
(F::I(n),V::I(v))=>{if *n<4 {let top=1i32<<(8*n-1);if *v< -top || *v>=top{return err("signed integer out of range");}}w.extend_from_slice(&v.to_le_bytes()[..*n]);},
(F::Uint,V::U(v))=>var(w,*v),(F::Int,V::I(v))=>var(w,((*v as u32)<<1)^((*v>>31) as u32)),
(F::Float(n),V::N(v))=>{if !v.is_finite() || (*n==4 && !(*v as f32).is_finite()){return err("non-finite float");}if *n==4{w.extend_from_slice(&(*v as f32).to_le_bytes());}else{w.extend_from_slice(&v.to_le_bytes());}},
(F::Bool,V::B(v))=>w.push(u8::from(*v)),
(F::Quant(min,max,bits),V::N(v))=>{if !(*v>=*min && *v<=*max){return err("quantized value outside range");}let n=q(*v,*min,*max,*bits);w.extend_from_slice(&n.to_le_bytes()[..(*bits as usize).div_ceil(8)]);},
(F::Text(max),V::S(v))=>{count_write(w,v.len(),*max)?;w.extend_from_slice(v.as_bytes());},
(F::Bytes(max),V::Bytes(v))=>{count_write(w,v.len(),*max)?;w.extend_from_slice(v);},
(F::Enum(max),V::E(v))=>{if v>=max{return err("enum index outside schema");}var(w,*v);},
(F::Array(f,max),V::A(v))=>{count_write(w,v.len(),*max)?;for v in v{write(f,v,w,depth+1)?;}},
(F::Optional(f),V::O(v))=>{w.push(u8::from(v.is_some()));if let Some(v)=v{write(f,v,w,depth+1)?;}},
(F::Map(f,max),V::M(v))=>{if v.len()>*max{return err("map exceeds limit");}ids(w,&v.keys().copied().collect::<Vec<_>>());for v in v.values(){write(f,v,w,depth+1)?;}},
(F::Struct(i),V::T(v))=>{let fields=super::__TYPES[*i];if fields.len()!=v.len(){return err("struct shape differs");}for(f,v) in fields.iter().zip(v){write(f,v,w,depth+1)?;}},_=>return err("value does not match schema")};Ok(())}
fn read(f:&F,r:&mut R<'_>,depth:usize)->Result<V>{if depth>256{return err("nesting exceeds 256");}Ok(match f{
F::U(n)=>V::U(r.uint(*n)?),F::I(n)=>{let u=r.uint(*n)?;let shift=32-8*n;V::I(((u<<shift) as i32)>>shift)},F::Uint=>V::U(r.var()?),F::Int=>{let u=r.var()?;V::I(((u>>1) as i32)^-((u&1) as i32))},
F::Float(n)=>{let v=if *n==4 {f32::from_le_bytes(r.raw(4)?.try_into().map_err(|_|Error("truncated float"))?) as f64}else{f64::from_le_bytes(r.raw(8)?.try_into().map_err(|_|Error("truncated float"))?)};if !v.is_finite(){return err("non-finite float");}V::N(v)},
F::Bool=>{let b=r.byte()?;if b>1{return err("invalid bool");}V::B(b==1)},
F::Quant(min,max,bits)=>{let v=r.uint((*bits as usize).div_ceil(8))?;let top=(1u64<<bits)-2;if v as u64>top{return err("quantized step outside range");}V::N(min+(max-min)*(v as f64/top as f64))},
F::Text(max)=>{let n=r.count(*max)?;V::S(std::str::from_utf8(r.raw(n)?).map_err(|_|Error("invalid UTF-8"))?.to_owned())},
F::Bytes(max)=>{let n=r.count(*max)?;V::Bytes(r.raw(n)?.to_vec())},F::Enum(max)=>{let n=r.var()?;if n>=*max{return err("invalid enum index");}V::E(n)},
F::Array(f,max)=>{let n=r.count(*max)?;let mut v=Vec::new();for _ in 0..n{v.push(read(f,r,depth+1)?);}V::A(v)},
F::Optional(f)=>{let b=r.byte()?;if b>1{return err("invalid optional flag");}V::O(if b==1{Some(Box::new(read(f,r,depth+1)?))}else{None})},
F::Map(f,max)=>{let keys=r.ids(*max)?;let mut v=BTreeMap::new();for id in keys{v.insert(id,read(f,r,depth+1)?);}V::M(v)},
F::Struct(i)=>V::T(super::__TYPES[*i].iter().map(|f|read(f,r,depth+1)).collect::<Result<_>>()?)})}
fn delta_write(f:&F,v:&V,base:&V,w:&mut Vec<u8>,depth:usize)->Result<()> {if depth>256{return err("nesting exceeds 256");}match(f,v,base){
(F::Struct(i),V::T(v),V::T(base))=>{let fields=super::__TYPES[*i];let mut mask=vec![0u8;fields.len().div_ceil(8)];for(i,((f,v),b))in fields.iter().zip(v).zip(base).enumerate(){if !same(f,v,b){mask[i/8]|=1<<(i%8);}}w.extend_from_slice(&mask);for(i,((f,v),b))in fields.iter().zip(v).zip(base).enumerate(){if mask[i/8]&(1<<(i%8))!=0{delta_write(f,v,b,w,depth+1)?;}}},
(F::Map(f,max),V::M(v),V::M(base))=>{if v.len()>*max{return err("map exceeds limit");}let removed=base.keys().filter(|id|!v.contains_key(id)).copied().collect::<Vec<_>>();let changed=v.iter().filter(|(id,v)|base.get(id).is_none_or(|b|!same(f,v,b))).map(|(id,_)|*id).collect::<Vec<_>>();ids(w,&removed);ids(w,&changed);for id in changed{let value=&v[&id];if let Some(b)=base.get(&id){delta_write(f,value,b,w,depth+1)?;}else{write(f,value,w,depth+1)?;}}},
_=>write(f,v,w,depth+1)?};Ok(())}
fn delta_read(f:&F,r:&mut R<'_>,base:&V,depth:usize)->Result<V>{if depth>256{return err("nesting exceeds 256");}match(f,base){
(F::Struct(i),V::T(base))=>{let fields=super::__TYPES[*i];let mask=r.raw(fields.len().div_ceil(8))?.to_vec();if fields.len()%8!=0 && mask[mask.len()-1]>>(fields.len()%8)!=0{return err("change mask past struct fields");}let mut out=Vec::new();for(i,(f,b))in fields.iter().zip(base).enumerate(){out.push(if mask[i/8]&(1<<(i%8))!=0{delta_read(f,r,b,depth+1)?}else{b.clone()});}Ok(V::T(out))},
(F::Map(f,max),V::M(base))=>{let removed=r.ids(base.len())?;for id in &removed{if !base.contains_key(id){return err("removed entity absent in baseline");}}let changed=r.ids(*max)?;let mut out=base.clone();for id in &removed{out.remove(id);}for id in changed{if removed.binary_search(&id).is_ok(){return err("entity removed and changed");}let v=if let Some(b)=out.get(&id){delta_read(f,r,b,depth+1)?}else{read(f,r,depth+1)?};out.insert(id,v);}if out.len()>*max{return err("delta map exceeds limit");}Ok(V::M(out))},_=>read(f,r,depth+1)}}
pub(super) fn encode(i:usize,v:&V,base:Option<&V>)->Result<Vec<u8>>{let mut w=Vec::new();if let Some(b)=base{delta_write(&F::Struct(i),v,b,&mut w,0)?;}else{write(&F::Struct(i),v,&mut w,0)?;}Ok(w)}
pub(super) fn decode(i:usize,b:&[u8],base:Option<&V>)->Result<V>{let mut r=R{b,at:0};let v=if let Some(base)=base{delta_read(&F::Struct(i),&mut r,base,0)?}else{read(&F::Struct(i),&mut r,0)?};if r.at!=b.len(){return err("trailing bytes");}Ok(v)}
}
`;

/**
 * Generate standalone Rust 2021 structs and full/delta codecs from schema.json or a compiled schema.
 * Types are Msg<Name>, fields f_<name>, enums their u32 wire indices and optionals boxed.
 * @throws TypeError for invalid schema input; schema validation errors retain their original type and field context.
 */
export function generateRust(
  input: NormalizedSchema | { json: NormalizedSchema },
  options: GenerateRustOptions = {},
): string {
  const json = input && 'json' in input ? input.json : input;
  if (!json?.types || typeof json.types !== 'object')
    throw new TypeError('generateRust needs schema.json; pass a normalized schema or defineSchema result');
  const restore = (f: NormalizedField): FieldType => {
    if (f.type === 'bool') return 'bool';
    if (f.type === 'struct') return f.name;
    if (f.type === 'array' || f.type === 'map' || f.type === 'optional')
      return { ...f, of: restore(f.of) } as FieldType;
    return f;
  };
  const types: Record<string, Record<string, FieldType>> = {};
  for (const [name, fields] of Object.entries(json.types))
    types[name] = Object.fromEntries(Object.entries(fields).map(([key, f]) => [key, restore(f)]));
  const schema = defineSchema({ version: json.version, types }),
    names = Object.keys(schema.json.types);
  const native = (f: NormalizedField): string => {
    switch (f.type) {
      case 'struct':
        return `Msg${f.name}`;
      case 'array':
        return `Vec<${native(f.of)}>`;
      case 'map':
        return `std::collections::BTreeMap<u32,${native(f.of)}>`;
      case 'optional':
        return `Option<Box<${native(f.of)}>>`;
      case 'enum':
      case 'uint':
        return 'u32';
      case 'int':
        return 'i32';
      case 'string':
        return 'String';
      case 'bytes':
        return 'Vec<u8>';
      case 'quantized':
        return 'f64';
      default:
        return f.type;
    }
  };
  const float = (v: number) => `${JSON.stringify(v)}f64`;
  const field = (f: NormalizedField): string => {
    switch (f.type) {
      case 'struct':
        return `margo_wire::F::Struct(${names.indexOf(f.name)})`;
      case 'array':
        return `margo_wire::F::Array(&${field(f.of)},${f.maxLength})`;
      case 'map':
        return `margo_wire::F::Map(&${field(f.of)},${f.maxSize})`;
      case 'optional':
        return `margo_wire::F::Optional(&${field(f.of)})`;
      case 'enum':
        return `margo_wire::F::Enum(${f.values.length})`;
      case 'string':
        return `margo_wire::F::Text(${f.maxLength})`;
      case 'bytes':
        return `margo_wire::F::Bytes(${f.maxLength})`;
      case 'quantized':
        return `margo_wire::F::Quant(${float(f.min)},${float(f.max)},${f.bits})`;
      case 'bool':
        return 'margo_wire::F::Bool';
      case 'uint':
        return 'margo_wire::F::Uint';
      case 'int':
        return 'margo_wire::F::Int';
      default:
        return `margo_wire::F::${f.type[0] === 'f' ? 'Float' : f.type[0].toUpperCase()}(${Number(f.type.slice(1)) / 8})`;
    }
  };
  const toValue = (f: NormalizedField, v: string): string => {
    switch (f.type) {
      case 'struct':
        return `margo_wire::V::from(${v})`;
      case 'array':
        return `margo_wire::V::A((${v}).iter().map(|v|${toValue(f.of, 'v')}).collect())`;
      case 'map':
        return `margo_wire::V::M((${v}).iter().map(|(id,v)|(*id,${toValue(f.of, 'v')})).collect())`;
      case 'optional':
        return `margo_wire::V::O((${v}).as_ref().map(|v|Box::new(${toValue(f.of, 'v.as_ref()')})))`;
      case 'enum':
        return `margo_wire::V::E(*(${v}))`;
      case 'string':
        return `margo_wire::V::S((${v}).clone())`;
      case 'bytes':
        return `margo_wire::V::Bytes((${v}).clone())`;
      case 'bool':
        return `margo_wire::V::B(*(${v}))`;
      case 'f32':
      case 'f64':
      case 'quantized':
        return `margo_wire::V::N(*(${v}) as f64)`;
      default:
        return `margo_wire::V::${f.type[0] === 'u' ? 'U' : 'I'}(*(${v}) as ${f.type[0] === 'u' ? 'u32' : 'i32'})`;
    }
  };
  const helpers: string[] = [];
  const fromValue = (f: NormalizedField): string => {
    const fn = `__from_${helpers.length}`;
    helpers.push('');
    const at = helpers.length - 1;
    let expr: string;
    switch (f.type) {
      case 'struct':
        expr = `return Msg${f.name}::__from(v);`;
        break;
      case 'array':
        expr = `if let margo_wire::V::A(v)=v{return v.into_iter().map(${fromValue(f.of)}).collect();}`;
        break;
      case 'map':
        expr = `if let margo_wire::V::M(v)=v{return v.into_iter().map(|(id,v)|Ok((id,${fromValue(f.of)}(v)?))).collect();}`;
        break;
      case 'optional':
        expr = `if let margo_wire::V::O(v)=v{return v.map(|v|${fromValue(f.of)}(*v).map(Box::new)).transpose();}`;
        break;
      default: {
        const variant =
          f.type === 'bool'
            ? 'B'
            : f.type === 'string'
              ? 'S'
              : f.type === 'bytes'
                ? 'Bytes'
                : f.type === 'enum'
                  ? 'E'
                  : ['f32', 'f64', 'quantized'].includes(f.type)
                    ? 'N'
                    : f.type[0] === 'u'
                      ? 'U'
                      : 'I';
        expr = `if let margo_wire::V::${variant}(v)=v{return Ok(v${['B', 'S', 'Bytes'].includes(variant) ? '' : ` as ${native(f)}`});}`;
      }
    }
    helpers[at] =
      `fn ${fn}(v:margo_wire::V)->margo_wire::Result<${native(f)}>{${expr}Err(margo_wire::Error("decoded field shape differs"))}`;
    return fn;
  };
  const out = [
    `// Generated from ${String(options.source ?? 'schema.json').replace(/[\r\n]/g, ' ')} by @margoengine/netcode/generate-rust.`,
    RUNTIME,
    `/// FNV-1a hash of normalized schema JSON.\npub const SCHEMA_HASH:u32=${schema.hash};`,
    `const __TYPES:&[&[margo_wire::F]]=&[${names.map((name) => `&[${Object.values(schema.json.types[name]).map(field).join(',')}]`).join(',')}];`,
  ];
  for (const [index, name] of names.entries()) {
    const fields = Object.entries(schema.json.types[name]);
    out.push(
      `#[derive(Clone,Debug,PartialEq)]\npub struct Msg${name}{${fields.map(([key, f]) => `pub f_${key}:${native(f)}`).join(',')}}`,
      `impl From<&Msg${name}> for margo_wire::V{fn from(v:&Msg${name})->Self{Self::T(vec![${fields.map(([key, f]) => toValue(f, `&v.f_${key}`)).join(',')}])}}`,
      `impl Msg${name}{
fn __from(v:margo_wire::V)->margo_wire::Result<Self>{if let margo_wire::V::T(v)=v{let mut fields=v.into_iter();Ok(Self{${fields.map(([key, f]) => `f_${key}:${fromValue(f)}(fields.next().ok_or(margo_wire::Error("missing field"))?)?`).join(',')}})}else{Err(margo_wire::Error("not a struct"))}}
/// Encode this complete value, validating bounds.
pub fn encode(&self)->margo_wire::Result<Vec<u8>>{margo_wire::encode(${index},&self.into(),None)}
/// Decode all bytes, refusing malformed/truncated input.
pub fn decode(bytes:&[u8])->margo_wire::Result<Self>{Self::__from(margo_wire::decode(${index},bytes,None)?)}
/// Encode the change from a matching decoded baseline.
pub fn encode_delta(&self,base:&Self)->margo_wire::Result<Vec<u8>>{margo_wire::encode(${index},&self.into(),Some(&base.into()))}
/// Apply a change without mutating the baseline.
pub fn decode_delta(bytes:&[u8],base:&Self)->margo_wire::Result<Self>{Self::__from(margo_wire::decode(${index},bytes,Some(&base.into()))?)}
/// Schema equality, including float/quantized wire precision.
pub fn same(&self,other:&Self)->bool{margo_wire::same(&margo_wire::F::Struct(${index}),&self.into(),&other.into())}
}`,
    );
  }
  return `${out.join('\n')}\n${helpers.join('\n')}\n`;
}
