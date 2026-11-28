import { barriers, intersects } from './growth.js';

const vec = (a,b,f) => a.map((v,i) => f(v,b[i]));
const add = (a,b) => vec(a,b,(x,y)=>x+y);
const sub = (a,b) => vec(a,b,(x,y)=>x-y);
const cross = (a,b) => [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const scale = (a,s) => a.map(v=>v*s);
const unit = a => scale(a,1/Math.max(1e-8,Math.hypot(...a)));
const mix = (a,b,w) => vec(a,b,(x,y)=>x+(y-x)*w);

const colors = {
  crown: [[.30,.163,.101],[.47,.298,.155],[.65,.462,.247]],
  roots: [[.391,.224,.135],[.74,.465,.25],[.98,.755,.478]],
  leaves: [[.46,.51,.248],[.62,.64,.287],[.521,.596,.274],[.718,.667,.291],[.326,.446,.247],[.589,.665,.404]],
};
const hash = n => {
  let s = Math.imul(n, 0x48ddc761);
  s ^= s >>> 16;
  return (s >>> 0) / 4294967295;
};
class Surface {
  positions = [];
  normals = [];
  colors = [];
  births = [];
  vertex(p,n,c,birth) {
    this.positions.push(...p);
    this.normals.push(...n);
    this.colors.push(...c);
    this.births.push(birth);
  }
  triangle(a,b,c,paint,birth) {
    const normal=unit(cross(sub(b,a),sub(c,a)));
    this.vertex(a,normal,paint,birth);
    this.vertex(b,normal,paint,birth);
    this.vertex(c,normal,paint,birth);
  }
  export() {
    return Object.fromEntries(['positions','normals','colors','births'].map(key=>[key,new Float32Array(this[key])]));
  }
}

function rings(nodes, radii) {
  const strongest = new Int32Array(nodes.length).fill(-1);
  for (let i=1;i<nodes.length;i++) {
    const parent=nodes[i].parent, prior=strongest[parent];
    if (prior<0 || radii[i]>radii[prior]) strongest[parent]=i;
  }
  const sides=9;
  return nodes.map((node,index)=>{
    const parent=node.parent<0?null:nodes[node.parent];
    const child=strongest[index]<0?null:nodes[strongest[index]];
    const arriving=parent?unit(sub(node.p,parent.p)):null;
    const leaving=child?unit(sub(child.p,node.p)):null;
    const tangent=arriving&&leaving?unit(add(arriving,leaving)):(arriving??leaving??[0,1,0]);
    const across=unit(cross([.06,.24,.969],tangent));
    const normal=Math.hypot(...across)>.4?across:unit(cross([1,0,0],tangent));
    const bitangent=cross(tangent,normal);
    return Array.from({length:sides},(_,side)=>{
      const angle=side/sides*Math.PI*2;
      const n=add(scale(normal,Math.cos(angle)),scale(bitangent,Math.sin(angle)));
      return {p:add(node.p,scale(n,radii[index])),n};
    });
  });
}

function tube(surface,a,b,one,two,birth1,birth2) {
  for (let i=0;i<a.length;i++) {
    const j=(i+1)%a.length;
    const a0=a[i],a1=a[j],b0=b[i],b1=b[j];
    const grain=.85+.15*hash(i*13+764);
    const c0=scale(one,grain),c1=scale(two,grain);
    surface.vertex(a0.p,a0.n,c0,birth1);surface.vertex(a1.p,a1.n,c0,birth1);surface.vertex(b1.p,b1.n,c1,birth2);
    surface.vertex(a0.p,a0.n,c0,birth1);surface.vertex(b1.p,b1.n,c1,birth2);surface.vertex(b0.p,b0.n,c1,birth2);
  }
}

function edgeRadii(nodes,kind) {
  const counts = new Float32Array(nodes.length);
  for (let n=nodes.length-1;n>=0;n--) {
    counts[n] = Math.max(1,counts[n]);
    if (nodes[n].parent>=0) counts[nodes[n].parent] += counts[n];
  }
  return counts.map((count,n)=> {
    const main = Math.pow(count/counts[0],.55);
    const bias=kind==='crown'?.009:.0052;
    return n===0&&kind==='crown'?.160: bias + (kind==='crown'?.142:.113)*main;
  });
}

function segments(data,kind,blocked) {
  const body=new Surface(), limbs=data.nodes;
  const radii=edgeRadii(limbs,kind);
  const longest=Math.max(...limbs.map(n=>n.path))*1.05;
  const boundaries=rings(limbs,radii);
  const [near,mid,far]=colors[kind];
  const paint=t=>t<.48?mix(near,mid,t/.48):mix(mid,far,(t-.48)/.52);
  let sweptHits=0;
  for (let n=1;n<limbs.length;n++) {
    const node=limbs[n],parent=limbs[node.parent],start=radii[node.parent],end=radii[n];
    // The branch skin lies inside the capsule of maximum end radius around its centerline.
    if (intersects(parent.p,node.p,barriers[kind],Math.max(start,end))) sweptHits++;
    const t=node.path/longest;
    const previous=parent.path/longest;
    tube(body,boundaries[node.parent],boundaries[n],paint(previous),paint(t),previous,t);
  }
  if (blocked&&sweptHits) throw new Error('A displayed branch overlaps the ' + kind + ' barrier.');
  return {body:body.export(),longest,sweptHits,radii};
}

function leaf(surface,anchor,length,width,vector,palette,birth) {
  const lateral=unit(cross(Math.abs(vector[1])>.91?[1,0,0]:[0,1,0],vector));
  const raised=unit(cross(vector,lateral));
  const ridge=add(add(anchor,scale(vector,length*.50)),scale(raised,width*.34));
  const tip=add(anchor,scale(vector,length));
  const one=add(add(anchor,scale(vector,length*.42)),scale(lateral,width));
  const two=add(add(anchor,scale(vector,length*.52)),scale(lateral,-width));
  surface.triangle(anchor,one,ridge,palette,birth);
  surface.triangle(ridge,one,tip,scale(palette,1.06),birth);
  surface.triangle(anchor,ridge,two,scale(palette,.87),birth);
  surface.triangle(ridge,tip,two,scale(palette,.92),birth);
}

function leaves(crown,longest,blocked) {
  const surface=new Surface();
  for (const {index,zone} of crown.tipList) {
    const end=crown.nodes[index], start=crown.nodes[end.parent];
    const toward=unit(sub(end.p,start.p));
    for (let j=0;j<13;j++) {
      const key=index*257+j*31+983*zone;
      const theta=hash(key)*6.283;
      const rise=(hash(key+7)-.5)*1.51;
      const blade=unit([Math.cos(theta)*.85+toward[0]*.48,rise+toward[1]*.40,Math.sin(theta)*.85+toward[2]*.48]);
      const spread=[(hash(key+15)-.5)*.31,(hash(key+27)-.5)*.16,(hash(key+41)-.5)*.34];
      const anchor=add(mix(start.p,end.p,.29+.81*hash(key+37)),spread);
      if (blocked && intersects(anchor,anchor,barriers.crown,.23)) continue;
      const paint=colors.leaves[Math.floor(hash(key+73)*colors.leaves.length)];
      const length=.102+.097*hash(key+69), width=length*(.25+hash(key+5)*.23);
      leaf(surface,anchor,length,width,blade,paint,Math.min(.985,end.path/longest+.035));
    }
  }
  return surface.export();
}

export function renderGrowth(simulation,blocked) {
  const {crown,roots}=simulation;
  const upper=segments(crown,'crown',blocked),lower=segments(roots,'roots',blocked);
  const canopy=leaves(crown,upper.longest,blocked);
  const stats={
    crownNodes:crown.nodes.length,rootNodes:roots.nodes.length,
    crownTips:crown.tipList.length,rootTips:roots.tipList.length,
    crownHits:crown.hits,rootHits:roots.hits,crownSweep:upper.sweptHits,rootSweep:lower.sweptHits,
    reached:crown.reached+roots.reached,distanceTests:crown.distanceTests+roots.distanceTests,
    operations:crown.attempts+roots.attempts,
  };
  return {upper: upper.body,lower:lower.body,canopy,stats};
}
