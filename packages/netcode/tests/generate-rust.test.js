import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRandom } from '@margoengine/math/mathutils';
import { defineSchema } from '../dist/index.js';
import { generateRust } from '../dist/generate-rust.js';
import { generateTypeScript } from '../dist/generate.js';
import { every, generator } from './values.js';

const hex = (bytes) => Buffer.from(bytes).toString('hex');
const vec = (bytes) => `vec![${[...bytes].join(',')}]`;
function literal(field, value, schema) {
  switch (field.type) {
    case 'struct':
      return `Msg${field.name}{${Object.entries(schema.json.types[field.name])
        .map(([key, f]) => `f_${key}:${literal(f, value[key], schema)}`)
        .join(',')}}`;
    case 'enum':
      return String(field.values.indexOf(value));
    case 'string':
      return `${JSON.stringify(value).replace(/\\u([a-fA-F0-9]{4})/g, '\\u{$1}')}.to_owned()`;
    case 'bytes':
      return vec(value);
    case 'array':
      return `vec![${value.map((value) => literal(field.of, value, schema)).join(',')}]`;
    case 'map':
      return `[${[...value].map(([id, value]) => `(${id}u32,${literal(field.of, value, schema)})`).join(',')}].into_iter().collect()`;
    case 'optional':
      return value === undefined ? 'None' : `Some(Box::new(${literal(field.of, value, schema)}))`;
    case 'bool':
      return String(value);
    case 'f32':
      return `(${Object.is(value, -0) ? '-0.0' : value}f64 as f32)`;
    case 'f64':
    case 'quantized':
      return `${Object.is(value, -0) ? '-0.0' : value}f64`;
    default:
      return String(value);
  }
}
test('standalone Rust compiles and matches runtime and generated TS full/delta bytes and malformed input', {
  timeout: 120000,
}, async () => {
  const folder = resolve('test-results/batch256', `rust-${crypto.randomUUID()}`);
  mkdirSync(folder, { recursive: true });
  try {
    writeFileSync(resolve(folder, 'protocol.rs'), generateRust(JSON.parse(JSON.stringify(every.json))));
    writeFileSync(resolve(folder, 'protocol.ts'), generateTypeScript(every));
    const ts = await import(pathToFileURL(resolve(folder, 'protocol.ts')).href);
    const random = createRandom(256),
      { struct, mutate } = generator(every, random);
    const checks = [],
      input = [],
      expected = [];
    for (let n = 0; n < 100; n++) {
      const value = struct('All'),
        full = every.encode('All', value),
        base = every.decode('All', full);
      const next = mutate('All', base),
        delta = every.encodeDelta('All', next, base);
      assert.equal(hex(ts.encodeAll(value)), hex(full));
      assert.equal(hex(ts.encodeAllDelta(next, base)), hex(delta));
      if (n < 25)
        checks.push(`{
let v=${literal({ type: 'struct', name: 'All' }, value, every)};
assert_eq!(v.encode().unwrap(),${vec(full)},"full ${n}");
let base=MsgAll::decode(&${vec(full)}).unwrap();
assert!(v.same(&base));
let next=${literal({ type: 'struct', name: 'All' }, next, every)};
assert_eq!(next.encode_delta(&base).unwrap(),${vec(delta)},"delta ${n}");
assert_eq!(MsgAll::decode_delta(&${vec(delta)},&base).unwrap().encode().unwrap(),${vec(every.encode('All', next))});
}`);
      input.push(`f ${hex(full)}`, `d ${hex(full)} ${hex(delta)}`);
      expected.push(hex(full), hex(every.encode('All', next)));
      for (let i = 0; i < 10; i++) {
        const bytes = (i & 1 ? delta : full).slice();
        bytes[Math.floor(random() * bytes.length)] = Math.floor(random() * 256);
        const cut = bytes.subarray(0, Math.floor(random() * (bytes.length + 1)));
        let runtime = 'err',
          generated = 'err';
        try {
          runtime = hex(every.encode('All', i & 1 ? every.decodeDelta('All', cut, base) : every.decode('All', cut)));
        } catch (error) {
          assert.ok(error instanceof RangeError);
        }
        try {
          generated = hex(every.encode('All', i & 1 ? ts.decodeAllDelta(cut, base) : ts.decodeAll(cut)));
        } catch (error) {
          assert.ok(error instanceof RangeError);
        }
        assert.equal(generated, runtime);
        input.push(i & 1 ? `d ${hex(full)} ${hex(cut)}` : `f ${hex(cut)}`);
        expected.push(runtime);
      }
    }
    writeFileSync(
      resolve(folder, 'main.rs'),
      `include!("protocol.rs");
use std::io::{self,BufRead};
fn unhex(s:&str)->Vec<u8>{s.as_bytes().chunks(2).map(|c|u8::from_str_radix(std::str::from_utf8(c).unwrap(),16).unwrap()).collect()}
fn hex(b:&[u8])->String{b.iter().map(|b|format!("{b:02x}")).collect()}
fn main(){ assert_eq!(SCHEMA_HASH,${every.hash}); ${checks.join('\n')}
for line in io::stdin().lock().lines(){let line=line.unwrap();let p=line.split(' ').collect::<Vec<_>>();let result=if p[0]=="f"{MsgAll::decode(&unhex(p[1]))}else{let base=MsgAll::decode(&unhex(p[1])).unwrap();MsgAll::decode_delta(&unhex(p[2]),&base)};println!("{}",match result.and_then(|v|v.encode()){Ok(bytes)=>hex(&bytes),Err(_)=>"err".to_owned()});}}
`,
    );
    const binary = resolve(folder, process.platform === 'win32' ? 'codec.exe' : 'codec');
    const compiled = spawnSync('rustc', ['--edition=2021', resolve(folder, 'main.rs'), '-o', binary], {
      encoding: 'utf8',
      timeout: 90000,
      maxBuffer: 16 << 20,
    });
    assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
    const run = spawnSync(binary, [], {
      input: input.join('\n') + '\n',
      encoding: 'utf8',
      timeout: 20000,
      maxBuffer: 16 << 20,
    });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.deepEqual(run.stdout.trimEnd().split(/\r?\n/), expected);
  } finally {
    rmSync(folder, { recursive: true });
  }
});

test('Rust generator validates JSON, preserves hash and safely prefixes Rust keyword names', () => {
  assert.throws(() => generateRust({}), /schema.json/);
  const schema = defineSchema({ types: { Self: { self: 'u8', type: 'bool' } } });
  const source = generateRust(schema, { source: 'label\nfn injected() {}' });
  assert.match(source, /pub struct MsgSelf/);
  assert.match(source, /pub f_self:u8/);
  assert.match(source, /pub f_type:bool/);
  assert.match(source, new RegExp(`SCHEMA_HASH:u32=${schema.hash}`));
  assert.ok(source.split('\n')[0].includes('label fn injected() {}'));
});

test('generated Rust checks hostile scalars, limits, masks, id overflow and 32-bit quantization', {
  timeout: 120000,
}, () => {
  const folder = resolve('test-results/batch256', `rust-edge-${crypto.randomUUID()}`);
  mkdirSync(folder, { recursive: true });
  try {
    const schema = defineSchema({
      types: {
        Self: { self: 'u8', type: 'bool' },
        Flag: { value: 'bool' },
        Opt: { value: { type: 'optional', of: 'u8' } },
        Text: { value: { type: 'string', maxLength: 2 } },
        Enum: { value: { type: 'enum', values: ['one', 'two'] } },
        Quant: { value: { type: 'quantized', min: -1, max: 1, bits: 32 } },
        Small: { value: { type: 'quantized', min: -1, max: 1, bits: 2 } },
        Var: { value: 'uint' },
        Float: { value: 'f64' },
        Map: { value: { type: 'map', of: 'u8', maxSize: 2 } },
        Node: { next: { type: 'optional', of: 'Node' } },
      },
    });
    const malformed = [
      ['Flag', [2]],
      ['Opt', [2]],
      ['Text', [2, 0xc0, 0x80]],
      ['Text', [3, 65, 66, 67]],
      ['Enum', [2]],
      ['Small', [3]],
      ['Quant', [255, 255, 255, 255]],
      ['Var', [255, 255, 255, 255, 16]],
      ['Var', [128]],
      ['Float', [0, 0, 0, 0, 0, 0, 240, 127]],
      ['Map', [2, 255, 255, 255, 255, 15, 0, 1, 2]],
    ];
    const checks = malformed.map(([name, bytes]) => {
      assert.throws(() => schema.decode(name, Uint8Array.from(bytes)), RangeError);
      return `assert!(Msg${name}::decode(&${vec(bytes)}).is_err());`;
    });
    for (const value of [-1, -0.75, -0, 0.25, 1])
      checks.push(
        `assert_eq!(MsgQuant{f_value:${value}f64}.encode().unwrap(),${vec(schema.encode('Quant', { value }))});`,
      );
    const base = { value: new Map([[1, 9]]) };
    const badDelta = [1, 1, 1, 1, 1, 10];
    assert.throws(() => schema.decodeDelta('Map', Uint8Array.from(badDelta), base), RangeError);
    writeFileSync(
      resolve(folder, 'main.rs'),
      `${generateRust(schema)}
fn main(){${checks.join('\n')}
assert!(MsgFlag::decode_delta(&[128],&MsgFlag{f_value:false}).is_err());
assert!(MsgEnum{f_value:3}.encode().is_err());
assert!(MsgText{f_value:"long".to_owned()}.encode().is_err());
assert!(MsgFloat{f_value:f64::NAN}.encode().is_err());
assert!(MsgQuant{f_value:2.0}.encode().is_err());
let base=MsgMap::decode(&${vec(schema.encode('Map', base))}).unwrap();
assert!(MsgMap::decode_delta(&${vec(badDelta)},&base).is_err());
let mut node=MsgNode{f_next:None};for _ in 0..300{node=MsgNode{f_next:Some(Box::new(node))};}assert!(node.encode().is_err());
assert_eq!(MsgSelf{f_self:3,f_type:true}.encode().unwrap(),vec![3,1]);}
`,
    );
    const binary = resolve(folder, process.platform === 'win32' ? 'codec.exe' : 'codec');
    const compiled = spawnSync('rustc', ['--edition=2021', resolve(folder, 'main.rs'), '-o', binary], {
      encoding: 'utf8',
      timeout: 90000,
      maxBuffer: 16 << 20,
    });
    assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
    const run = spawnSync(binary, [], { encoding: 'utf8', timeout: 20000 });
    assert.equal(run.status, 0, run.stdout + run.stderr);
  } finally {
    rmSync(folder, { recursive: true });
  }
});
