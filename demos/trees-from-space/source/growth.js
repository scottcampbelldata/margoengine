export const barriers = {
  crown: {min: [-1.57,1.60,-.50], max: [-.31,1.92,.48]},
  roots: {min: [-.75,-1.46,-.57], max: [.78,-.68,.53]},
};
const exclusion = {crown:.10, roots:.13};
const soil = -.035;

function random(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

function distance(a,b) {
  return Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2]);
}
export function intersects(a,b,region,padding=0) {
  let enter = 0, leave = 1;
  for (let axis=0; axis<3; axis++) {
    const low = region.min[axis]-padding, high = region.max[axis]+padding;
    const span = b[axis]-a[axis];
    if (Math.abs(span) < 1e-10) {
      if (a[axis] < low || a[axis] > high) return false;
      continue;
    }
    const from = (low-a[axis])/span, to = (high-a[axis])/span;
    enter = Math.max(enter,Math.min(from,to));
    leave = Math.min(leave,Math.max(from,to));
    if (leave < enter) return false;
  }
  return true;
}

const radius = {
  crown: [{center:[-1.36,2.55,.40],size:[.95,.49,.60]}, {center:[.10,3.12,-.12],size:[.96,.72,.63]},
    {center:[1.10,2.53,.26],size:[.79,.48,.56]}, {center:[.54,2.79,-.77],size:[.79,.55,.39]},
    {center:[-1.06,2.87,-.51],size:[.78,.42,.45]}],
  roots: [{center:[-1.32,-1.95,.34],size:[.80,.49,.56]}, {center:[1.21,-1.74,.12],size:[.72,.63,.58]},
    {center:[-.25,-2.21,-.59],size:[1.1,.44,.49]}, {center:[.28,-.86,.78],size:[1.4,.60,.31]}],
};
const guides = {
  crown: [
    {stem:1.23, open:[[-.72,1.74,.08],[-1.33,2.43,.29]], blocked:[[-.07,1.37,.70],[-.44,1.55,.72],[-1.10,2.04,.70],[-1.33,2.39,.41]]},
    {stem:2.17, open:[[.16,2.80,-.13]]},
    {stem:1.43, open:[[.73,1.92,.18],[1.08,2.36,.26]]},
    {stem:1.62, open:[[.40,2.21,-.65],[.58,2.60,-.77]]},
    {stem:1.81, open:[[-.46,2.31,-.50],[-.93,2.70,-.49]], blocked:[[-.24,2.16,-.69],[-.87,2.62,-.59]]},
  ],
  roots: [
    {open:[[-.37,-.84,.18],[-1.09,-1.74,.34]], blocked:[[-1.01,-.34,.27],[-1.10,-1.49,.33],[-1.24,-1.88,.34]]},
    {open:[[.34,-.79,.15],[1.02,-1.45,.18]], blocked:[[1.02,-.34,.05],[1.13,-1.45,.13]]},
    {open:[[.04,-1.18,-.23],[-.21,-2.03,-.55]], blocked:[[.01,-.36,-.85],[-.15,-1.43,-.86],[-.25,-2.01,-.65]]},
    {open:[[.11,-.35,.41],[.29,-.71,.75]], blocked:[[.21,-.28,.52],[.29,-.67,.82]]},
  ],
};

function cloud(center,size,count,rng,kind,blocked) {
  const positions = [];
  while (positions.length < count*3) {
    const x=rng()*2-1,y=rng()*2-1,z=rng()*2-1;
    if (x*x+y*y+z*z > 1) continue;
    const p=[center[0]+x*size[0],center[1]+y*size[1],center[2]+z*size[2]];
    if (kind==='roots'&&p[1]>soil-.06) continue;
    if (blocked&&intersects(p,p,barriers[kind],exclusion[kind])) continue;
    positions.push(...p);
  }
  return new Float64Array(positions);
}

function assemble(generator,kind,blocked) {
  const nodes = [{p: [0,kind==='crown'?0:soil,0], parent:-1, path:0, shoots:0}];
  const tipList = [], obstacle = barriers[kind];
  const valid = (a,b) => !blocked || !intersects(a,b,obstacle,exclusion[kind]);
  let attempts=0, reached=0, distanceTests=0, discarded=0;
  function grow(from, points, step, nodesMax, iterations, kill, influence) {
    const data = generator.generate({
      root:nodes[from].p, attractionPoints:points, segmentLength:step, killRadius:kill, influenceRadius:influence,
      maxNodes:nodesMax, maxIterations:iterations,
    });
    attempts++;
    distanceTests += data.distanceTests;
    reached += points.length/3 - data.remainingAttractions;
    const taken = [from], fresh = [];
    for (let n=1;n<data.parents.length;n++) {
      const parent=taken[data.parents[n]];
      const p=Array.from(data.positions.subarray(n*3,n*3+3));
      if (parent===undefined || !valid(nodes[parent].p,p)) {
        discarded++;
        continue;
      }
      taken[n]=nodes.length;
      fresh.push(nodes.length);
      nodes[parent].shoots++;
      nodes.push({p,parent,path:nodes[parent].path+distance(nodes[parent].p,p),shoots:0});
    }
    return fresh;
  }
  function relay(from, targets) {
    for (const target of targets) {
      const newNodes=grow(from,new Float64Array(target),.092,85,82,.055,5);
      let best=from;
      for (const index of newNodes) {
        if (distance(nodes[index].p,target)<distance(nodes[best].p,target)) best=index;
      }
      if (best===from || distance(nodes[best].p,target)>.096) throw new Error(kind + ' route could not reach ' + target.join(',') + ' from ' + nodes[from].p.map(v=>v.toFixed(2)).join(','));
      from=best;
    }
    return from;
  }
  if (kind==='crown') relay(0,[[.04,.82,.04],[.15,1.65,-.08],[.22,2.53,-.17]]);
  const upright = nodes.slice();
  const rng=random(kind==='crown'?7834:9130);
  for (let zone=0;zone<guides[kind].length;zone++) {
    const guide=guides[kind][zone], profile=radius[kind][zone];
    let from=0;
    if (guide.stem!==undefined) {
      for (let n=1;n<upright.length;n++) {
        if (Math.abs(nodes[n].p[1]-guide.stem)<Math.abs(nodes[from].p[1]-guide.stem)) from=n;
      }
    }
    const start=relay(from,blocked&&guide.blocked?guide.blocked:guide.open);
    const inputs=cloud(profile.center,profile.size,kind==='crown'?101:115,rng,kind,blocked);
    const grown=grow(start,inputs,kind==='crown'?.105:.092,510,43,kind==='crown'?.16:.15,1.12);
    for (const n of grown) {
      if (!nodes[n].shoots) tipList.push({index:n,zone});
    }
  }
  // Record both anatomical samples and the geometric audit basis for the two obstacle volumes.
  const hits=nodes.reduce((n,node)=>n+(node.parent>=0&&intersects(nodes[node.parent].p,node.p,obstacle)?1:0),0);
  if (blocked&&hits) throw new Error('Colonisation crossed a barrier.');
  return {nodes,tipList,attempts,reached,distanceTests,discarded,hits};
}

export function simulate(generator, blocked) {
  return {crown:assemble(generator,'crown',blocked),roots:assemble(generator,'roots',blocked)};
}
