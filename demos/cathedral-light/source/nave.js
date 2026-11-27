import { Geometry, PbrMaterial } from '@margoengine/core';

export const halfWidth = 5.65;
export const bayCenters = [-14, -8.4, -2.8, 2.8, 8.4, 14];
export const windowFoot = 3.55;
export const windowSpring = 7.15;
export const windowRise = 2.22;
export const windowHalf = 1.36;
export const windowCenterHeight = 6.05;
const length = 36;
const wallOuter = 6.27;
const vaultStart = 9.74;
const vaultRise = 6.51;
const vaultHalf = halfWidth;
const tau = Math.PI * 2;
const roseY = 7.7;
const roseRadius = 2.26;
const roseZ = -17.95;

const delta = (b,a) => b.map((v,i) => v - a[i]);
const cross = (a,b) => [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const dot = (a,b) => a.reduce((total,v,i) => total + v*b[i],0);
const unit = (v) => { const n = Math.hypot(...v); return v.map(value => value / n); };
const between = (a,b,t) => a+(b-a)*t;
const pointBetween = (a,b,t) => a.map((coord,i) => between(coord,b[i],t));

const stoneColors = {
  limestone: ['#9b8c7b', .84],
  shade: ['#82786c', .92],
  light: ['#b7a692', .81],
  vault: ['#a39888', .91],
  chalk: ['#c3af98', .76],
  seam: ['#87786b', .92],
  mortar: ['#55504d', .95],
  tileA: ['#837771', .68],
  tileB: ['#8d8176', .70],
  tileC: ['#776f6d', .73],
  limestoneFloor: ['#a79a86', .73],
  mosaic: ['#69524a', .80],
  ink: ['#51545c', .64],
  oak: ['#584236', .60],
  walnut: ['#3b302a', .62],
  bronze: ['#988169', .36, 1],
};

export function pointed(z, width, rise) {
  const offset = (rise*rise - width*width) / (2*width);
  const radius = width + offset;
  return Math.sqrt(Math.max(0,radius*radius - (Math.abs(z)+offset)**2));
}

class Masonry {
  positions = [];
  normals = [];
  indexes = [];

  face(points, toward) {
    const [a,b,c] = points;
    let n = cross(delta(b,a),delta(c,a));
    if(Math.hypot(...n) < 1e-8)return;
    if(toward && dot(n,toward) < 0) {
      points = [a,...points.slice(1).reverse()];
      n = n.map(v => -v);
    }
    const start = this.positions.length / 3;
    const normal = unit(n);
    for(const p of points) {
      this.positions.push(...p);
      this.normals.push(...normal);
    }
    if(points.length === 3)this.indexes.push(start,start+1,start+2);
    else this.indexes.push(start,start+1,start+2,start,start+2,start+3);
  }

  box([x,y,z],[width,height,depth],bevel=0) {
    const r = Math.min(bevel,width*.22,height*.20,depth*.20);
    const levels = r ? [[-height/2,r],[-height/2+r,0],[height/2-r,0],[height/2,r]]
      : [[-height/2,0],[height/2,0]];
    const rings = levels.map(([at,inset]) => {
      const hw=width/2-inset, hd=depth/2-inset;
      const corner=Math.max(.0001,r*.75);
      return [[-hw+corner,-hd],[hw-corner,-hd],[hw,-hd+corner],[hw,hd-corner],
        [hw-corner,hd],[-hw+corner,hd],[-hw,hd-corner],[-hw,-hd+corner]]
        .map(([a,b]) => [x+a,y+at,z+b]);
    });
    for(let layer=1;layer<rings.length;layer++) {
      const low=rings[layer-1], high=rings[layer];
      for(let i=0;i<8;i++) {
        const j=(i+1)%8;
        this.face([low[i],low[j],high[j],high[i]],[low[i][0]+low[j][0]-2*x,0,low[i][2]+low[j][2]-2*z]);
      }
    }
    const caps=[rings[0],rings.at(-1)];
    caps.forEach((ring,i)=>{
      for(let j=1;j<7;j++)this.face([ring[0],ring[j],ring[j+1]],[0,i===0?-1:1,0]);
    });
  }

  pier(x,z,profile,sides=12,rotation=0) {
    const rings=profile.map(([y,r]) => Array.from({length:sides},(_,i)=>{
      const angle=tau*i/sides+rotation;
      return [x+r*Math.cos(angle),y,z+r*Math.sin(angle)];
    }));
    for(let row=1;row<rings.length;row++) {
      const [a,b]=[rings[row-1],rings[row]];
      for(let i=0;i<sides;i++) {
        const j=(i+1)%sides;
        const [p,q]=[a[i],a[j]];
        const toward=[p[0]+q[0]-2*x,0,p[2]+q[2]-2*z];
        this.face([p,q,b[j],b[i]],toward);
      }
    }
    for(let i=1;i<sides-1;i++) {
      const low=rings[0], high=rings.at(-1);
      this.face([low[0],low[i],low[i+1]],[0,-1,0]);
      this.face([high[0],high[i],high[i+1]],[0,1,0]);
    }
  }

  rail(points,radius,reference=[0,0,1],sides=8) {
    const rings=points.map((p,i)=>{
      const tangent=unit(delta(points[Math.min(i+1,points.length-1)],points[Math.max(0,i-1)]));
      const side=unit(cross(tangent,reference));
      const up=cross(tangent,side);
      return Array.from({length:sides},(_,j)=>{
        const angle=tau*(j+.5)/sides;
        return p.map((value,k)=>value+radius*(side[k]*Math.cos(angle)+up[k]*Math.sin(angle)));
      });
    });
    for(let i=1;i<rings.length;i++) {
      const a=rings[i-1], b=rings[i];
      for(let j=0;j<sides;j++) {
        const k=(j+1)%sides;
        const toward=a[j].map((v,axis)=>v+a[k][axis]-2*points[i-1][axis]);
        this.face([a[j],a[k],b[k],b[j]],toward);
      }
    }
    for(let j=1;j<sides-1;j++){
      this.face([rings[0][0],rings[0][j],rings[0][j+1]],delta(points[0],points[1]));
      const end = rings.at(-1);
      this.face([end[0],end[j],end[j+1]],delta(points.at(-1),points.at(-2)));
    }
  }

  geometry() { return new Geometry(this.positions,this.normals,this.indexes); }
}

function archSamples(width, count=28) {
  return Array.from({length:count+1},(_,i)=>-width*Math.cos(Math.PI*i/count));
}

function windowWall(sets,xIn,xOut,z,halfBay) {
  const [outer,lining] = [sets.limestone,sets.shade];
  const wallHeight = vaultStart;
  const cut = archSamples(windowHalf,24);
  const center = (xIn+xOut)/2;
  const depth = Math.abs(xOut-xIn);
  outer.box([center,windowFoot/2,z],[depth,windowFoot,2*halfBay]);
  const stumpWidth = halfBay - windowHalf;
  for(const side of [-1,1]) {
    outer.box([center,(windowFoot+wallHeight)/2,z+side*(windowHalf+stumpWidth/2)],
      [depth,wallHeight-windowFoot,stumpWidth]);

  }
  for(let i=0;i<cut.length-1;i++) {
    const a=cut[i], b=cut[i+1];
    const ya=windowSpring+pointed(a,windowHalf,windowRise);
    const yb=windowSpring+pointed(b,windowHalf,windowRise);
    for(const x of [xIn,xOut]){
      outer.face([[x,ya,z+a],[x,wallHeight,z+a],[x,wallHeight,z+b],[x,yb,z+b]],[x-center,0,0]);
    }
    lining.face([[xIn,ya,z+a],[xIn,yb,z+b],[xOut,yb,z+b],[xOut,ya,z+a]],[0,-1,0]);
    outer.face([[xIn,wallHeight,z+a],[xOut,wallHeight,z+a],[xOut,wallHeight,z+b],[xIn,wallHeight,z+b]],[0,1,0]);
  }
  lining.box([center,windowFoot+.055,z],[depth+.21,.11,2*windowHalf+.31],.035);
}

function windowDress(sets,side,z) {
  const x = side*(halfWidth-.12);
  for(let i=0;i<3;i++){
    const half = windowHalf+.06+i*.14;
    const start = windowSpring-.026;
    const reach = windowRise+.066+i*.14;
    const path = archSamples(half,24).map(k=>[x+side*i*.039,start+pointed(k,half,reach),z+k]);
    path.unshift([path[0][0],windowFoot-.01,z-half]);
    path.push([path[0][0],windowFoot-.01,z+half]);
    sets[i===1?'shade':'light'].rail(path,i===0?.068:.061,[1,0,0],8);
  }
  sets.chalk.box([x-.04*side,windowFoot-.12,z],[.35,.13,3.24],.022);
  sets.light.box([x+.01*side,windowFoot-.27,z],[.30,.13,3.08],.027);
  for(const offset of [-.48,0,.48]){
    const y=windowSpring+pointed(offset,windowHalf,windowRise)-.12;
    sets.light.box([side*(wallOuter-.27),(windowFoot+y)/2,z+offset],[.19,y-windowFoot,.085],.019);
  }
  const diskY=7.49;
  const loop=Array.from({length:37},(_,i)=>{
    const angle=tau*i/36;
    return [side*(wallOuter-.30),diskY+.48*Math.sin(angle),z+.48*Math.cos(angle)];
  });
  sets.light.rail(loop,.044,[1,0,0]);
  for(const shift of [-.74,.74]) {
    const y0=3.81,y1=6.77;
    sets.chalk.box([side*(wallOuter-.25),(y0+y1)/2,z+shift],[.22,y1-y0,.060],.013);
  }
  for(let course=0;course<5;course++){
    const elevation=.54+course*.578;
    const jx=side*(halfWidth-.0025);
    sets.seam.box([jx,elevation,z],[.009,.012,5.60]);
    for(const seam of [-1.88,-.74,.40,1.54]){
      const along=z+seam+(course%2)*.416;
      sets.seam.box([jx,elevation+.289,along],[.009,.575,.011]);
    }
  }
  const frieze = [x-side*.17,2.14,z];
  sets.shade.box(frieze,[.15,.21,4.07],.025);
  for(const dz of [-1.05,0,1.05]){
    const width=.44,y=1.58;
    const arch = archSamples(width,12).map(k=>[x-side*.205,y+pointed(k,width,.48),z+dz+k]);
    arch.unshift([arch[0][0],.66,arch[0][2]]);
    arch.push([arch[0][0],.66,arch.at(-1)[2]]);
    sets.shade.rail(arch,.064,[1,0,0]);
  }
}

function barrel(sets) {
  const along=archSamples(vaultHalf,36);
  const walls=[-18.025,-16.8,-11.2,-5.6,0,5.6,11.2,16.8,18.025];
  for(let j=0;j<walls.length-1;j++){
    const z0=walls[j],z1=walls[j+1], center=(z0+z1)/2;
    for(let i=0;i<along.length-1;i++){
      const x0=along[i], x1=along[i+1];
      const y0=vaultStart+pointed(x0,vaultHalf,vaultRise);
      const y1=vaultStart+pointed(x1,vaultHalf,vaultRise);
      const cap = x=>.14*Math.cos(x/vaultHalf*Math.PI*.5);
      const layer=sets[i%9===0?'limestone':'vault'];
      layer.face([[x0,y0,z0],[x1,y1,z0],[x1,y1+cap(x1),center],[x0,y0+cap(x0),center]],[0,-1,0]);
      layer.face([[x0,y0+cap(x0),center],[x1,y1+cap(x1),center],[x1,y1,z1],[x0,y0,z1]],[0,-1,0]);
    }
  }
  for(let j=0;j<walls.length;j++){
    const z=walls[j];
    const profile=along.map(x=>[x,vaultStart+pointed(x,vaultHalf,vaultRise)-.09,z]);
    sets.shade.rail(profile,.251,[0,0,1],10);
    sets.light.rail(profile.map(([x,y,z])=>[x*.993,y-.130,z]),.139,[0,0,1],10);
    sets.chalk.rail(profile.map(([x,y,z])=>[x*.991,y-.243,z]),.055,[0,0,1],6);
    if(j>=walls.length-1)continue;
    for(const direction of [-1,1]) {
      const diagonal=along.map((x,i)=>[x,vaultStart+pointed(x,vaultHalf,vaultRise)-.069,
        between(z,walls[j+1],direction===1?i/(along.length-1):1-i/(along.length-1))]);
      sets.light.rail(diagonal,.101,[0,0,1],8);
    }
    sets.chalk.pier(0,(z+walls[j+1])/2,[[vaultStart+vaultRise-.35,.094],[vaultStart+vaultRise-.27,.19],
      [vaultStart+vaultRise-.12,.255],[vaultStart+vaultRise+.008,.22]],10);
  }
}

function endWall(sets) {
  const arc=archSamples(roseRadius,30);
  for(let i=0;i<arc.length-1;i++){
    const a=arc[i],b=arc[i+1];
    const y1=Math.sqrt(Math.max(0,roseRadius**2-a*a));
    const y2=Math.sqrt(Math.max(0,roseRadius**2-b*b));
    const upper=[roseY+y1,roseY+y2];
    const lower=[roseY-y1,roseY-y2];
    for(const z of [roseZ,roseZ-.58]){
      const n=[0,0,z===roseZ?1:-1];
      sets.limestone.face([[a,upper[0],z],[b,upper[1],z],
        [b,vaultStart+pointed(b,vaultHalf,vaultRise),z],[a,vaultStart+pointed(a,vaultHalf,vaultRise),z]],n);
      sets.limestone.face([[a,0,z],[b,0,z],[b,lower[1],z],[a,lower[0],z]],n);
    }
    for(const [y,normal] of [[upper,-1],[lower,1]])sets.shade.face([[a,y[0],roseZ],[b,y[1],roseZ],
      [b,y[1],roseZ-.58],[a,y[0],roseZ-.58]],[0,normal,0]);
  }
  for(const side of [-1,1]){

    const x=archSamples(vaultHalf,34).filter(v=>Math.sign(v)===side && Math.abs(v)>roseRadius);
    const sidePoints=(side>0?[roseRadius,...x]:[...x,-roseRadius]);
    for(let i=0;i<sidePoints.length-1;i++){
      const [a,b]=[sidePoints[i],sidePoints[i+1]];
      sets.limestone.face([[a,0,roseZ],[b,0,roseZ],[b,vaultStart+pointed(b,vaultHalf,vaultRise),roseZ],
        [a,vaultStart+pointed(a,vaultHalf,vaultRise),roseZ]],[0,0,1]);
    }
    sets.shade.box([side*3.96,2.86,roseZ+.075],[1.25,5.70,.35],.071);
    sets.light.box([side*4.12,5.52,roseZ+.20],[1.49,.20,.56],.030);
  }
  for(const [r,width,type] of [[2.20,.081,'chalk'],[2.38,.102,'light'],[2.57,.093,'shade'],[2.69,.071,'light'],
    [.43,.046,'shade'],[1.43,.039,'shade']]){
    const path=Array.from({length:65},(_,i)=>{
      const p=tau*i/64;return [r*Math.cos(p),roseY+r*Math.sin(p),roseZ+.24];
    });
    sets[type].rail(path,width,[0,0,1]);
  }
  for(let i=0;i<12;i++){
    const p=tau*i/12;
    const a=[.28*Math.cos(p),roseY+.28*Math.sin(p),roseZ+.17];
    const b=[2.19*Math.cos(p),roseY+2.19*Math.sin(p),roseZ+.17];
    sets.shade.rail([a,b],.035,[0,0,1],6);
  }
  for(const side of [-1,1]) {
    const arch=archSamples(.66,16).map(x=>[side*1.25+x,3.48+pointed(x,.66,1.09),roseZ+.21]);
    arch.unshift([arch[0][0],.75,arch[0][2]]);
    arch.push([arch.at(-1)[0],.75,roseZ+.21]);
    sets.light.rail(arch,.094,[0,0,1],8);
  }
}

function paving(sets) {
  sets.mortar.box([0,-.14,0],[2*halfWidth+.10,.23,length],.028);
  const tiles=[sets.tileA,sets.tileB,sets.tileC,sets.limestoneFloor];
  let row=0,seed=8374;
  const roll=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  for(let z=-17.5;z<18;z+=.815,row++){
    for(let x=-5.22;x<5.6;x+=.722) {
      const offset=row%2===0 ? 0 : .191;
      if(x > 4.9 && offset)continue;
      const mat=Math.abs(x)<1.09 ? (roll()<.60?tiles[3]:tiles[1]) : tiles[Math.floor(roll()*3)];
      mat.box([x+offset,-.024+(roll()-.50)*.005,z],[.713,.039,.803],.006);
    }
    for(const side of [-1,1]) {
      sets.mosaic.box([side*1.48,-.002,z],[.098,.019,.799],.005);
      sets.ink.box([side*1.64,-.002,z],[.041,.019,.799],.004);
    }
  }
  for(let i=0;i<4;i++) {
    sets[i%2===0?'light':'limestone'].box([0,.058+i*.127,-15.55-i*.50],[6.57-i*.38,.127,4.21-i*.13],.023);
  }
  sets.chalk.box([0,.985,-15.1],[2.44,.14,.91],.045);
  sets.shade.box([0,.711,-15.1],[1.93,.57,.68],.048);
  sets.light.box([0,.46,-15.1],[2.28,.13,.87],.030);
  sets.bronze.box([0,1.22,-15.23],[.043,.37,.041],.009);
  sets.bronze.box([0,1.31,-15.23],[.235,.039,.05],.009);
  for(const side of [-1,1]){
    const x=side*1.83;
    for(let i=0;i<3;i++){
      const q=x+side*i*.082;
      sets.bronze.pier(q,-15.13+i*.22,[[.477,.11],[.507,.12],[.538,.084],[.55,.047],[.74,.021],[.797,.052]],12);
    }
  }
}

function furnishings(sets) {
  for(const side of [-1,1]){
    for(const z of [-10.75,-7.32,-3.86,-.40,3.06,6.52,9.98,13.44]) {
      const x=side*3.33;
      sets.oak.box([x,.449,z],[2.62,.085,.42],.022);
      sets.walnut.box([x,.739,z-.18],[2.58,.388,.063],.024);
      sets.oak.box([x,1.00,z-.18],[2.68,.077,.092],.023);
      for(const offset of [-1.23,1.23]){
        const at=x+offset;
        sets.walnut.box([at,.427,z],[.119,.831,.449],.028);
        sets.oak.box([at,.861,z-.10],[.152,.178,.29],.030);
        sets.oak.box([at+.075,.71,z+.187],[.034,.096,.038],.008);
      }
    }
    for(const z of [-16.8,-11.2,-5.6,0,5.6,11.2,16.8]){
      const x=side*(halfWidth-.08);
      sets.shade.box([side*(halfWidth-.01),5.14,z],[.58,10.27,.90],.075);
      sets.shade.box([x-side*.4,.18,z],[1.09,.26,1.11],.048);
      sets.light.pier(x-side*.38,z,[[.29,.57],[.36,.53],[.42,.46],[.52,.48],[.63,.35],[8.73,.32],
        [8.80,.43],[8.91,.47],[9.08,.52],[9.15,.55],[9.27,.55],[9.40,.40],[9.56,.37],[9.74,.42]],14);
      for(const offset of [-.315,.315]){
        sets.limestone.pier(x-side*.53,z+offset,[[.52,.13],[.60,.112],[8.55,.101],[8.66,.141],
          [8.80,.173],[9.09,.155],[9.42,.13]],10);
      }
    }
    const bands=[[.25,.19,.23,'shade'],[2.06,.28,.14,'light'],[3.24,.14,.13,'shade'],
      [9.47,.18,.21,'shade'],[9.65,.17,.24,'light']];
    for(const [y,d,h,c] of bands)sets[c].box([side*(halfWidth-d*.33),y,0],[d,h,35.5],.038);
  }
}

export function createNave(engine, lights) {
  const sets=Object.fromEntries(Object.keys(stoneColors).map(key=>[key,new Masonry()]));
  for(const side of [-1,1]){
    for(const z of bayCenters){
      windowWall(sets,side*halfWidth,side*wallOuter,z,2.80);
      windowDress(sets,side,z);
    }
    for(const z of [-17.4,17.4])sets.limestone.box([side*(halfWidth+wallOuter)/2,vaultStart/2,z],
      [wallOuter-halfWidth,vaultStart,1.2]);
  }
  barrel(sets);
  endWall(sets);
  sets.limestone.box([0,4.86,18.28],[2*halfWidth,9.72,.52],.039);
  // Inset end bay engages the vault at the springing line and closes sunlight behind the camera.
  const roofline=archSamples(vaultHalf,20);
  for(let i=0;i<roofline.length-1;i++){
    const wall=sets.limestone;
    const [x,right]=[roofline[i],roofline[i+1]];
    const y0=vaultStart+pointed(x,vaultHalf,vaultRise);
    const y1=vaultStart+pointed(right,vaultHalf,vaultRise);
    wall.face([[x,vaultStart,18.00],[right,vaultStart,18.00],[right,y1,18.00],[x,y0,18.00]],[0,0,-1]);
  }
  paving(sets);
  furnishings(sets);
  const pieces=[];
  let triangles=0;
  for(const [key,set] of Object.entries(sets)){
    const [color,roughness,metalness=0]=stoneColors[key];
    const geometry=set.geometry();
    triangles+=geometry.indices.length/3;
    const mesh=engine.createMesh().setGeometry(geometry).setMaterial(new PbrMaterial({color,roughness,metalness}));
    pieces.push(mesh);
    if(lights && !['tileA','tileB','tileC','limestoneFloor','mosaic','ink','mortar','bronze'].includes(key)){
      lights.addShadowCaster(mesh);
    }
  }
  return {pieces,triangles};
}

export const glazed = { wallX:wallOuter-.045, roseY, roseZ:roseZ-.47, roseRadius };