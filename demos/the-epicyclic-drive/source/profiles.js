import { moduleSize, pressureAngle } from './mechanism.js';

const tau=Math.PI*2;
const pitchInvolute=Math.tan(pressureAngle)-pressureAngle;
const point=(radius,t)=>[radius*Math.cos(t),radius*Math.sin(t)];
const clearance=.00019;
const divisions=7;

function involute(base,radius) {
  const sweep=Math.acos(Math.min(1,base/radius));
  return Math.tan(sweep)-sweep;
}

// Start each tooth halfway through the preceding gap and trace CCW.
export function gearOutline(count,internal=false) {
  const pitch=count*moduleSize*.5, base=pitch*Math.cos(pressureAngle);
  const step=tau/count, root=pitch+(internal?1:-1)*1.27*moduleSize;
  const tip=pitch+(internal?-1:1)*moduleSize;
  const start=internal?root:Math.max(root,base);
  const sign=internal?1:-1;
  const half=(r)=>Math.PI/(2*count)-clearance/(2*pitch)+sign*(involute(base,r)-pitchInvolute);
  const edge=Array.from({length:divisions+1},(_,i)=>start+(tip-start)*i/divisions);
  const pattern=[];
  pattern.push([root,-step*.5]);
  if(start!==root) pattern.push([root,-half(start)-step*.024]);
  for(const r of edge) pattern.push([r,-half(r)]);
  pattern.push([tip,0]);
  for(let i=edge.length-1;i>=0;i--) pattern.push([edge[i],half(edge[i])]);
  if(start!==root) pattern.push([root,half(start)+step*.024]);
  return Array.from({length:count},(_,i)=>pattern.map(([r,a])=>point(r,a+i*step))).flat();
}
