import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {parseFontOutlines, extrudeText} from '@margoengine/text/extrude';
import {ttf,tables as fontTables,sfnt,simple,u16 as be16,u32 as be32} from './extrude-fixtures.js';
const reference=JSON.parse(readFileSync(new URL('./fixtures/fonts/variable-reference.json',import.meta.url),'utf8'));
const close=(a,b,epsilon=1e-7)=>assert.ok(Math.abs(a-b)<=epsilon,`${a} vs ${b}`);
for(const extension of ['ttf','otf']) test(`variable ${extension} outlines and widths match independent public font oracle`,()=>{
 const bytes=readFileSync(new URL(`./fixtures/fonts/SourceSans3VF-Upright.${extension}`,import.meta.url));
 const ref=reference.fonts[extension];
 assert.equal(createHash('sha256').update(bytes).digest('hex'),ref.sha256);
 const font=parseFontOutlines(bytes);
 assert.deepEqual(font.variationAxes,ref.axes);
 for(const sample of ref.samples) {
  const instance=font.withVariations({wght:sample.weight});
  assert.equal(instance.glyphIndex(sample.char),sample.index);
  close(instance.glyphAdvance(sample.index),sample.advance);
  const points=instance.getGlyphContours(sample.index,12).flat();
  const bounds=[Math.min(...points.map(p=>p[0])),Math.min(...points.map(p=>p[1])),Math.max(...points.map(p=>p[0])),Math.max(...points.map(p=>p[1]))];
  bounds.forEach((v,i)=>close(v,sample.bounds[i]));
 }
});
test('variation axes clamp, reject unknown/nonfinite values and preserve the default instance',()=>{
 const bytes=readFileSync(new URL('./fixtures/fonts/SourceSans3VF-Upright.otf',import.meta.url));
 const font=parseFontOutlines(bytes),i=font.glyphIndex('A');
 assert.equal(font.withVariations({wght:10000}).glyphAdvance(i),font.withVariations({wght:900}).glyphAdvance(i));
 assert.throws(()=>font.withVariations({nope:1}),e=>e.code==='failed');
 assert.throws(()=>font.withVariations({wght:NaN}),e=>e.code==='failed');
 const mesh=extrudeText('AV',{font:font.withVariations({wght:650}),curveSegments:12});
 assert.ok(mesh.indices.length>0&&mesh.positions.every(Number.isFinite));
});
const shaping=JSON.parse(readFileSync(new URL('./fixtures/fonts/shaping-reference.json',import.meta.url),'utf8'));
for(const fixture of shaping.cases) test(`shaped ${fixture.font} extrusion matches independent positioned outline bounds`,()=>{
 const bytes=readFileSync(new URL(`./fixtures/fonts/${fixture.font}`,import.meta.url));
 assert.equal(createHash('sha256').update(bytes).digest('hex'),fixture.sha256);
 const geometry=extrudeText(fixture.text,{font:bytes,variations:fixture.variations,shapedRuns:fixture.shapedRuns,depth:0.2,curveSegments:12});
 const b=geometry.boundingBox;
 [b.min[0],b.min[1],b.max[0],b.max[1]].forEach((v,i)=>close(v,fixture.bounds[i],1e-6));
 assert.ok(geometry.indices.length>0&&geometry.positions.every(Number.isFinite));
});
test('shaped advances, offsets, vertical placement, cluster spacing and the FontLike provider compose',()=>{
 const base={unitsPerEm:1,glyphIndex:()=>1,glyphAdvance:()=>1,getGlyphContours:()=>[[[0,0],[1,0],[1,1],[0,1]]]};
 const runs=[{glyphs:[{glyphIndex:1,xAdvance:1,yAdvance:0.5,xOffset:0.25,yOffset:0.2,cluster:0},
  {glyphIndex:1,xAdvance:1,yOffset:0.1,cluster:0},{glyphIndex:1,xAdvance:1,cluster:1}]}];
 const geometry=extrudeText('ab',{font:base,shapedRuns:runs,letterSpacing:0.3,size:2});
 close(geometry.boundingBox.min[0],0.5);close(geometry.boundingBox.max[0],6.6);close(geometry.boundingBox.max[1],3.2);
 const provider={...base,shape:text=>{assert.equal(text,'ab');return runs;}};
 assert.deepEqual(extrudeText('ab',{font:provider}).positions,extrudeText('ab',{font:base,shapedRuns:runs}).positions);
 for(const bad of [{glyphs:[{glyphIndex:-1,xAdvance:1}]},{line:1,glyphs:[]},{glyphs:[{glyphIndex:1,xAdvance:NaN}]}])
  assert.throws(()=>extrudeText('a',{font:base,shapedRuns:[bad]}),e=>e.code==='failed');
});
function table(bytes,tag) {
 const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
 for(let i=0;i<v.getUint16(4);i++) {
  const at=12+i*16;
  if(String.fromCharCode(...bytes.subarray(at,at+4))===tag)return {offset:v.getUint32(at+8),length:v.getUint32(at+12)};
 }
 throw new Error(`fixture lacks ${tag}`);
}
test('null HVAR variation subtables mean no width adjustment and malformed axes reject',()=>{
 const original=readFileSync(new URL('./fixtures/fonts/SourceSans3VF-Upright.otf',import.meta.url));
 const bytes=Uint8Array.from(original),v=new DataView(bytes.buffer),hvar=table(bytes,'HVAR');
 const store=hvar.offset+v.getUint32(hvar.offset+4),count=v.getUint16(store+6);
 for(let i=0;i<count;i++)v.setUint32(store+8+4*i,0);
 const varied=parseFontOutlines(bytes,{variations:{wght:900}}),base=parseFontOutlines(bytes);
 close(varied.glyphAdvance(varied.glyphIndex('A')),base.glyphAdvance(base.glyphIndex('A')));
 const invalid=Uint8Array.from(original),f=table(invalid,'fvar'),data=new DataView(invalid.buffer);
 const axes=f.offset+data.getUint16(f.offset+4);
 data.setInt32(axes+4,1000*65536);
 assert.throws(()=>parseFontOutlines(invalid),e=>e.code==='failed');
 const cff=table(original,'CFF2'),truncated=Uint8Array.from(original);
 new DataView(truncated.buffer).setUint32(cff.offset+new DataView(original.buffer,original.byteOffset,original.byteLength).getUint8(cff.offset+2)+new DataView(original.buffer,original.byteOffset,original.byteLength).getUint16(cff.offset+3),0x7fffffff);
 assert.throws(()=>parseFontOutlines(truncated),e=>e.code==='failed');
 const shortStore=Uint8Array.from(original);
 new DataView(shortStore.buffer).setUint16(cff.offset+reference.fonts.otf.variationStoreOffset,1);
 assert.throws(()=>parseFontOutlines(shortStore),e=>e.code==='failed');
});
// Clean-room variable TrueType fixtures from the OpenType 1.9.1 fvar, gvar and avar chapters and the common
// variation formats (tuple variation headers, packed point numbers, packed deltas).
const square=simple([[0,0,1],[100,0,1],[100,100,1],[0,100,1]]);
const f2=(v)=>be16(Math.round(v*16384)&0xffff);
const fvarTable=()=>[...be16(1),...be16(0),...be16(16),...be16(2),...be16(1),...be16(20),...be16(0),...be16(8),
 ...Array.from('wght',c=>c.charCodeAt(0)),...be32(100*65536),...be32(400*65536),...be32(900*65536),...be16(0),...be16(256)];
// One glyph's variation data: tuple headers [{peak,start,end,data}] with private point numbers in each data block.
function gvarTable(tuples) {
 const headers=[],data=[];
 for(const t of tuples){
  headers.push(...be16(t.data.length),...be16(0x8000|0x2000|(t.start!==undefined?0x4000:0)),...f2(t.peak));
  if(t.start!==undefined)headers.push(...f2(t.start),...f2(t.end));
  data.push(...t.data);
 }
 const glyph=[...be16(tuples.length),...be16(4+headers.length),...headers,...data];
 if(glyph.length%2)glyph.push(0);
 return [...be16(1),...be16(0),...be16(1),...be16(0),...be32(20),...be16(1),...be16(0),...be32(24),...be16(0),...be16(glyph.length/2),...glyph];
}
function variableSquare(tuples,extra=new Map()) {
 const entries=fontTables(ttf([square]));
 entries.set('fvar',fvarTable());
 entries.set('gvar',gvarTable(tuples));
 for(const [tag,bytes] of extra)entries.set(tag,bytes);
 return parseFontOutlines(sfnt(new Map([...entries].sort(([a],[b])=>a<b?-1:1))));
}
const xs=(font)=>font.getGlyphContours(0,1).flat().map(p=>p[0]);
test('gvar: an intermediate region whose start passes its peak ignores that axis (OpenType region scalar)',()=>{
 // All points (private count 0), x deltas 10 on the four outline points, zero y deltas.
 const font=variableSquare([{peak:0.5,start:0.8,end:1,data:[0,0x07,10,10,10,10,0,0,0,0,0x87]}]);
 // Every axis of the region is ignored, so its scalar is 1: the outline moves by the full 10 units.
 assert.deepEqual(xs(font.withVariations({wght:900})).map(x=>Math.round(x*font.unitsPerEm*1e6)/1e6),[10,110,110,10]);
});
test('gvar: a repeated point number applies each of its deltas cumulatively (OpenType packed point numbers)',()=>{
 // Points 0, 0, 1 (one run of three byte deltas: 0, 0, 1); x deltas 5 and 7 on point 0 and 12 on point 1.
 const font=variableSquare([{peak:1,data:[3,0x02,0,0,1,0x02,5,7,12,0x82]}]);
 const base=xs(font),varied=xs(font.withVariations({wght:900}));
 varied.forEach((x,i)=>close(x-base[i],12/font.unitsPerEm,1e-12));
});
test('avar: a segment map without its required -1, 0, +1 maps, or with none, leaves that axis unmodified',()=>{
 const gvar=[{peak:1,data:[0,0x07,100,100,100,100,0,0,0,0,0x87]}];
 const plain=xs(variableSquare(gvar).withVariations({wght:650}));
 const avar=(maps)=>[...be16(1),...be16(0),...be16(0),...be16(1),...be16(maps.length),...maps.flatMap(([a,b])=>[...f2(a),...f2(b)])];
 for(const maps of [[],[[-1,-1],[0,0.25],[1,1]],[[-1,-1],[1,1]]]) {
  const font=variableSquare(gvar,new Map([['avar',avar(maps)]]));
  assert.deepEqual(xs(font.withVariations({wght:650})),plain,JSON.stringify(maps));
 }
 // A valid map still applies: 0.5 maps to 0.25, so a quarter of the delta.
 const mapped=variableSquare(gvar,new Map([['avar',avar([[-1,-1],[0,0],[0.5,0.25],[1,1]])]]));
 const base=xs(mapped);
 xs(mapped.withVariations({wght:650})).forEach((x,i)=>close(x-base[i],25/mapped.unitsPerEm,1e-12));
});
