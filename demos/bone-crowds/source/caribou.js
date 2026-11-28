const TAU = Math.PI * 2;
export const bones = 14;
const duration = 1.28;
const strideLength = 1.43;
const stance = .64;
const legs = [
  {root:[.56,1.13,.227], upper:.565, lower:.557, knee:1, phase:.18},
  {root:[.56,1.13,-.227], upper:.565, lower:.557, knee:1, phase:.68},
  {root:[-.58,1.13,.222], upper:.565, lower:.557, knee:-1, phase:0},
  {root:[-.58,1.13,-.222], upper:.565, lower:.557, knee:-1, phase:.5},
];
const body = [
  [-.89,1.17,0,.13,.16],[-.76,1.17,0,.27,.25],[-.48,1.17,0,.34,.36],
  [-.10,1.15,0,.34,.37],[.26,1.15,0,.299,.358],[.56,1.18,0,.28,.371],[.75,1.25,0,.20,.28],[.85,1.31,0,.073,.12]
];
const neck = [
  [.46,1.19,0,.245,.31],[.61,1.32,0,.22,.28],[.74,1.49,0,.181,.22],[.86,1.69,0,.131,.18],[.96,1.82,0,.108,.13]
];
const head = [
  [.83,1.80,0,.08,.12],[.95,1.805,0,.149,.188],[1.13,1.785,0,.149,.16],[1.27,1.748,0,.105,.096],
  [1.386,1.729,0,.083,.076],[1.455,1.75,0,.032,.048]
];
const geomMath = {
  sub:(a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]],
  cross:(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]],
  scale:(a,s)=>[a[0]*s,a[1]*s,a[2]*s],
  unit:a=>{const n=Math.hypot(...a);return a.map(v=>v/n);},
};
function kneeBetween(upper, lower, root, foot, knee) {
  const dx=foot[0]-root[0],dy=foot[1]-root[1],span=Math.min(Math.hypot(dx,dy),upper+lower-.001);
  const ux=dx/Math.hypot(dx,dy),uy=dy/Math.hypot(dx,dy);
  const along=(upper*upper-lower*lower+span*span)/(2*span);
  const outward=Math.sqrt(Math.max(0,upper*upper-along*along))*knee;
  return [root[0]+along*ux-outward*uy,root[1]+along*uy+outward*ux,root[2]];
}
for(const leg of legs){
  leg.foot=[leg.root[0]+(leg.knee<0?.045:-.045),.12,leg.root[2]];
  leg.mid=kneeBetween(leg.upper,leg.lower,leg.root,leg.foot,leg.knee);
}
const headPivot=[.93,1.72,0];
function transform(origin, target, angle=0) {
  const c=Math.cos(angle),s=Math.sin(angle);
  return [c,-s,0,target[0]-c*origin[0]+s*origin[1],s,c,0,target[1]-s*origin[0]-c*origin[1],0,0,1,target[2]-origin[2]];
}
function segmentRotation(a,b,c,d) {
  return Math.atan2(d[1]-c[1],d[0]-c[0])-Math.atan2(b[1]-a[1],b[0]-a[0]);
}
export function poseAt(progress, fast) {
  const cycle=progress*TAU, bob = -(.024+(.012*fast))*Math.cos(cycle*2) - .015;
  const pose=[transform([0,0,0],[0,bob,0]),transform(headPivot,[headPivot[0],headPivot[1]+bob,0],.062*Math.sin(cycle-.8))];
  const ordinaryLength=strideLength*.93;
  for(const leg of legs){
    const time=(progress+leg.phase)%1;
    let along, lift;
    if(time<stance){
      along=ordinaryLength*(stance*.5-time);
      lift=0;
    }else{
      const t=(time-stance)/(1-stance);
      const curve=t*t*(3-2*t);
      along=ordinaryLength*stance*(curve-.5);
      lift=(.16+fast*.04)*Math.sin(Math.PI*t)**1.45;
    }
    const r=leg.root, ankle=leg.foot;
    const root=[r[0],r[1]+bob, r[2]];
    const foot=[ankle[0]+along,ankle[1]+lift,ankle[2]];
    const mid=kneeBetween(leg.upper,leg.lower,root,foot,leg.knee);
    pose.push(transform(r,root,segmentRotation(r,leg.mid,root,mid)));
    pose.push(transform(leg.mid,mid,segmentRotation(leg.mid,ankle,mid,foot)));
    pose.push(transform(ankle,foot,-.82*lift));
  }
  return pose;
}
export function clipBake(level) {
  const vertex=[], joints=[], weights=[], indices=[], uvs=[];
  const {cross,sub,scale,unit}=geomMath;
  function ringTube(path,sides,material,skin){
    const start=vertex.length/6;
    for(let ring=0;ring<path.length;ring++){
      const [x,y,z,ry,rz]=path[ring];
      const tangent=unit(sub(path[Math.min(path.length-1,ring+1)],path[Math.max(0,ring-1)]));
      const guide=Math.abs(tangent[2])<.96?[0,0,1]:[1,0,0];
      const n=unit(cross(guide,tangent)), b=unit(cross(tangent,n));
      for(let side=0;side<sides;side++){
        const a=TAU*side/sides,c=Math.cos(a),s=Math.sin(a),p=scale(n,c*ry),q=scale(b,s*rz);
        const normal=unit(n.map((v,i)=>v*c+b[i]*s));
        vertex.push(x+p[0]+q[0],y+p[1]+q[1],z+p[2]+q[2],...normal);
        const index=material(ring,c,s);
        uvs.push((index+.5)/8,.5);
        const [joint,other=0,t=0]=skin(ring);
        joints.push(joint,other,0,0,0,0,0,0); weights.push(1-t,t,0,0,0,0,0,0);
      }
    }
    for(let i=0;i+1<path.length;i++) for(let side=0;side<sides;side++){
      const a=start+i*sides+side,b=start+i*sides+(side+1)%sides;
      indices.push(a,b,a+sides,b,b+sides,a+sides);
    }
    for(let i=1;i+1<sides;i++){
      const last=start+(path.length-1)*sides;
      indices.push(start,start+i+1,start+i,last,last+i,last+i+1);
    }
  }
  const tiers = level==='near';
  const pick=arr=>tiers?arr:arr.filter((_,i)=>i===0||i===arr.length-1||i%2===0);
  const root=()=>[0], face=()=>[1];
  ringTube(pick(body),tiers?15:7,(i,c)=>c<-.47?2:i<2?1:c>.42?0:1,root);
  ringTube(pick(neck),tiers?12:6,(i,c)=>c>-.14?3:i>1?1:2,i=>[0,1,tierBlend(i)]);
  ringTube(pick(head),tiers?12:6,(i,c)=>i===(tiers?5:3)?5:c>.7?0:3,face);
  function tierBlend(i){return Math.min(1,i/(tiers?4:2));}
  for(const sign of [-1,1]){
    const z=sign;
    ringTube([[.98,1.9,.104*z,.047,.047],[.87,1.976,.227*z,.076,.042],[.793,2.056,.314*z,.019,.017]],tiers?6:4,()=>3,face);
    const branch=[[.981,1.918,.088*z,.026,.025],[.904,2.096,.137*z,.031,.029],[.778,2.27,.045*z,.025,.024],
      [.747,2.48,.126*z,.015,.022],[.884,2.62,.21*z,.004,.006]];
    ringTube(pick(branch),tiers?6:4,()=>6,face);
    const prongs=[
      [[.893,2.145,.109*z,.022,.017],[1.072,2.223,.179*z,.022,.017],[1.19,2.335,.244*z,.003,.004]],
      [[.79,2.28,.05*z,.023,.017],[.65,2.367,.172*z,.017,.014],[.57,2.47,.27*z,.003,.004]],
      [[.766,2.425,.105*z,.022,.02],[.665,2.527,.21*z,.014,.019],[.628,2.642,.24*z,.003,.003]],
      [[.823,2.555,.169*z,.016,.015],[.959,2.56,.24*z,.011,.011],[1.024,2.655,.275*z,.003,.003]],
    ];
    for(const prong of prongs.slice(0,tiers?4:2)) ringTube(tiers?prong:[prong[0],prong[2]],tiers?5:3,()=>6,face);
    if(tiers)ringTube([[1.143,1.833,.127*z,.019,.009],[1.184,1.837,.139*z,.012,.009]],6,()=>5,face);
  }
  for(const [i,leg] of legs.entries()){
    const main=2+i*3, shin=main+1, hoof=main+2;
    const [x,y,z]=leg.root,[mx,my,mz]=leg.mid,[fx,fy,fz]=leg.foot;
    const rings=[[x,y,z,.131,.085],[(x+mx)*.5,(y+my)*.5,z,.089,.069],
      [mx,my,mz,.061,.056],[(mx+fx)*.5,(my+fy)*.5,z,.039,.038],[fx,fy,fz,.035,.039]];
    ringTube(pick(rings),tiers?9:5,(r)=>r===0?1:r<(tiers?3:2)?2:4,r=>{
      const index=tiers?r:r*2;
      return index<2?[main]:index===2?[main,shin,.52]:[shin];
    });
    ringTube([[fx,fy+.071,fz,.035,.042],[fx+.025,.037,fz,.062,.052],[fx+.031,.018,fz,.067,.049]],
      tiers?9:5,()=>5,()=>[hoof]);
  }
  ringTube([[-.79,1.19,0,.065,.06],[-.91,1.10,0,.067,.063],[-.973,1.00,0,.013,.018]],tiers?9:5,()=>2,root);

  const frames=tiers?30:9,rows=frames+1,width=192;
  const texels=new Float32Array(Math.ceil(rows*bones*3/width)*width*4);
  for(let i=0;i<=frames;i++){
    const all=poseAt((i%frames)/frames,0);
    for(let j=0;j<bones;j++)texels.set(all[j],(i*bones+j)*12);
  }
  return {bones,rows,width,texels,vertexCount:vertex.length/6,vertices:new Float32Array(vertex),
    joints:new Uint32Array(joints),weights:new Float32Array(weights),indices:new Uint32Array(indices),
    uvs:new Float32Array(uvs), clips:[{name:'River walk',start:0,frames,duration,loop:true}]};
}
export const walkSpeed=strideLength*.93/duration;
