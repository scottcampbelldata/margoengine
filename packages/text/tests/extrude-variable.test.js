import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {parseFontOutlines, extrudeText} from '@margoengine/text/extrude';
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
