import test from 'node:test';
import assert from 'node:assert/strict';
import { getSelectionRects } from '@margoengine/text/selection';
import { layoutText, caretRect } from '../dist/index.js';
const m = { advance: s => [...s].length * 0.5, kerning: () => 0, metrics: () => ({ascent:0.8,descent:0.2}) };
const layout = (s,o={}) => layoutText(s,o,m);
test('UTF-16 selection spans lines and reversed ranges without mutation',()=>{
 const l=layout('abcd\nefgh'); const before=JSON.stringify(l);
 const r=getSelectionRects(l,2,7);
 assert.deepEqual(r.map(x=>[x.line,x.left,x.right]),[[0,1,2],[1,0,1]]);
 assert.deepEqual(getSelectionRects(l,7,2),r);assert.equal(JSON.stringify(l),before);
 assert.deepEqual(getSelectionRects(l,4,4),[]);
 assert.throws(()=>getSelectionRects(l,NaN,1),RangeError);
});
test('bidi ranges preserve visual holes and RTL reading edges',()=>{
 const l=layout('ab \u05d0\u05d1\u05d2 cd');
 const r=getSelectionRects(l,1,5);
 assert.equal(r.length,2);
 assert.deepEqual(r.map(x=>[x.left,x.right]),[[0.5,1.5],[2,3]]);
 const rtl=layout('\u05d0\u05d1\u05d2',{direction:'rtl'});
 assert.deepEqual(getSelectionRects(rtl,0,1).map(x=>[x.left,x.right]),[[1,1.5]]);
});
test('grapheme and internal shaping caret stops bound partial selections',()=>{
 const emoji=layout('a\ud83d\ude00b');
 assert.deepEqual(getSelectionRects(emoji,2,3).map(x=>[x.left,x.right]),[[0.5,1]]);
 const l=layout('office',{ligatures:true});
 const r=getSelectionRects(l,2,4)[0];
 assert.equal(r.left,caretRect(l,2).x); assert.equal(r.right,caretRect(l,4).x);
 const rtl=layout('\u0633\u0644\u0627\u0645');
 const rr=getSelectionRects(rtl,1,3)[0];
 assert.equal(rr.left,caretRect(rtl,3).x); assert.equal(rr.right,caretRect(rtl,1).x);
});
test('anchors, justify, wrap, clipping and empty layouts compose',()=>{
 const l=layout('ab cd ef',{maxWidth:2.5,textAlign:'justify',anchorX:'center',anchorY:'middle'});
 const all=getSelectionRects(l,-100,100);
 assert.equal(all.length,l.lines.length);
 l.clipRect=[-0.5,-0.2,0.5,0.2];
 assert.ok(getSelectionRects(l,0,100).every(r=>r.left>=-0.5&&r.right<=0.5&&r.top<=0.2&&r.bottom>=-0.2));
 assert.deepEqual(getSelectionRects(layout(''),0,1),[]);
});

test('selected neighbors include letter-spacing gaps and collapsed fractional ranges stay empty',()=>{
 const l=layout('abc',{letterSpacing:0.2});
 assert.equal(getSelectionRects(l,0,3).length,1);
 assert.equal(getSelectionRects(l,0,3)[0].right,l.bounds.right);
 assert.deepEqual(getSelectionRects(l,0.5,0.5),[]);
});
