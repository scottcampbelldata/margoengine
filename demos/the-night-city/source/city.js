import { Geometry, PbrMaterial } from '@margoengine/core';
import { generateCity } from '@margoengine/procedural/city';
import { generateBuilding } from '@margoengine/procedural/building-rules';
import { road } from '@margoengine/road';
import { LODSystem } from '@margoengine/lod';

const variation = (a, b = 1) => {
  const value = Math.sin(a * 371.51103 + b * 193.043) * 47215.33729;
  return value - Math.floor(value);
};
const mix = (a, b, f) => a + (b - a) * f;
const clamp = (value) => Math.min(1, Math.max(0, value));
const falloff = (x, z, cx, cz, radius) => Math.exp(-((x - cx) ** 2 + (z - cz) ** 2) / radius ** 2);
const flat = [0,1,0];
const basis = (x,z,angle=0) => {
  const c=Math.cos(angle),s=Math.sin(angle);
  const at=(px,y,pz)=>[x+px*c+pz*s,y,z-px*s+pz*c];
  at.axes=[[s,0,c],[-s,0,-c],[c,0,-s],[-c,0,s]];
  return at;
};

const finishes = {
  ground:{color:[.093,.108,.129],roughness:.73},
  foothills:{color:[.134,.169,.197],roughness:.91},
  asphalt:{color:[.105,.134,.153],roughness:.23},
  pavement:{color:[.278,.295,.298],roughness:.77},
  podium:{color:[.268,.302,.331],roughness:.67},
  brick:{color:[.307,.205,.172],roughness:.82},
  stone:{color:[.298,.278,.244],roughness:.73},
  pearl:{color:[.367,.360,.327],roughness:.67},
  violet:{color:[.207,.227,.291],roughness:.61},
  glass:{color:[.120,.207,.265],roughness:.114},
  midnight:{color:[.070,.122,.180],roughness:.083},
  bronzeGlass:{color:[.175,.139,.116],roughness:.124},
  smokedGlass:{color:[.061,.108,.148],roughness:.098},
  silverGlass:{color:[.149,.225,.271],roughness:.123},
  panel:{color:[.146,.197,.240],roughness:.49},
  trim:{color:[.380,.414,.432],roughness:.38,metalness:1},
  darkTrim:{color:[.104,.138,.168],roughness:.48},
  roof:{color:[.206,.236,.262],roughness:.90},
  copper:{color:[.380,.252,.173],roughness:.42,metalness:1},
  leaves:{color:[.087,.147,.108],roughness:.88},
  leavesLit:{color:[.108,.176,.122],roughness:.88},
  grass:{color:[.126,.164,.125],roughness:.84},
  pole:{color:[.107,.132,.160],roughness:.47,metalness:1},
  paint:{color:[.525,.546,.563],roughness:.74},
  centerline:{color:[.654,.458,.189],roughness:.81},
  path:{color:[.326,.284,.241],roughness:.73},
  silverCar:{color:[.38,.44,.49],roughness:.17,metalness:1},
  redCar:{color:[.39,.098,.080],roughness:.27},
};
const windowColors = [[2.95,1.72,.65],[1.81,2.08,2.71],[3.55,2.45,1.17],[2.4,2.89,2.76]];
const sidePoints = [
  {normal:[0,0,1], pos:(at,y,face)=>[at,y,face], dimension:0},
  {normal:[1,0,0], pos:(at,y,face)=>[face,y,-at], dimension:1},
  {normal:[0,0,-1], pos:(at,y,face)=>[-at,y,-face], dimension:0},
  {normal:[-1,0,0], pos:(at,y,face)=>[-face,y,at], dimension:1},
];

function data() { return { positions:[], normals:[], indices:[] }; }

function addQuad(target, a, b, c, d, normal) {
  const at = target.positions.length / 3;
  target.positions.push(...a,...b,...c,...d);
  target.normals.push(...normal,...normal,...normal,...normal);
  target.indices.push(at,at+1,at+2,at,at+2,at+3);
}

function addBox(target, move, x,y,z,w,h,d) {
  const xa=x-w/2,xb=x+w/2,ya=y-h/2,yb=y+h/2,za=z-d/2,zb=z+d/2;
  const a=move(xa,ya,za),b=move(xb,ya,za),c=move(xb,yb,za),d0=move(xa,yb,za);
  const e=move(xa,ya,zb),f=move(xb,ya,zb),g=move(xb,yb,zb),j=move(xa,yb,zb);
  const [front,back,right,left]=move.axes;
  addQuad(target,e,f,g,j,front);
  addQuad(target,b,a,d0,c,back);
  addQuad(target,f,b,c,g,right);
  addQuad(target,a,e,j,d0,left);
  addQuad(target,j,g,c,d0,flat);
  addQuad(target,a,b,f,e,[0,-1,0]);
}

function addPolygon(target, polygon, elevation) {
  const start = target.positions.length/3;
  let signed=0;
  for(let i=0;i<polygon.length;i++) {
    const [x,z]=polygon[i],next=polygon[(i+1)%polygon.length];
    signed+=x*next[1]-z*next[0];
    target.positions.push(x,elevation,z);
    target.normals.push(...flat);
  }
  for(let i=1;i+1<polygon.length;i++) {
    if(signed>0) target.indices.push(start,start+i+1,start+i);
    else target.indices.push(start,start+i,start+i+1);
  }
}

function mergeData(target, source) {
  const at=target.positions.length/3;
  for(const value of source.positions) target.positions.push(value);
  for(const value of source.normals) target.normals.push(value);
  for(const value of source.indices) target.indices.push(at+value);
}

function appendGeometry(target, geometry) {
  const at=target.positions.length/3;
  for(let i=0;i<geometry.vertices.length;i+=6) {
    target.positions.push(geometry.vertices[i],geometry.vertices[i+1],geometry.vertices[i+2]);
    target.normals.push(geometry.vertices[i+3],geometry.vertices[i+4],geometry.vertices[i+5]);
  }
  for(const index of geometry.indices) target.indices.push(at+index);
}

function straight(a,b) {
  const x=b[0]-a[0],z=b[1]-a[1],length=Math.hypot(x,z);
  return {length,closed:false,atDistance(distance,out) {
    const t=distance/length;
    out[0]=a[0]+x*t; out[1]=.037; out[2]=a[1]+z*t;
    return out;
  }};
}

function nearestIndex(positions, x, z) {
  let nearest=0,dist=Infinity;
  for(let i=0;i<positions.length;i++) {
    const [px,pz]=positions[i],gap=(x-px)**2+(z-pz)**2;
    if(gap<dist) { nearest=i; dist=gap; }
  }
  return nearest;
}

function terrain(target) {
  const count=46, span=3200, stride=count+1;
  const height=(x,z)=>{
    const shape=36+22*Math.sin(x*.008+z*.0045)+26*Math.sin(-x*.0043+z*.0078)+15*Math.cos(z*.014+x*.010);
    const side=clamp((Math.hypot(x*.90,z)-470)/220);
    return -2+side*side*(36+shape*.72+60*falloff(x,z,-530,-680,278));
  };
  for(let j=0;j<=count;j++) for(let i=0;i<=count;i++) {
    const x=(i/count-.5)*span,z=(j/count-.5)*span;
    const p=(height(x-2,z)-height(x+2,z))/4,q=(height(x,z-2)-height(x,z+2))/4;
    const length=Math.hypot(p,1,q);
    target.positions.push(x,height(x,z),z);
    target.normals.push(p/length,1/length,q/length);
    if(i&&j) {
      const at=j*stride+i;
      target.indices.push(at-stride-1,at-1,at-stride,at-stride,at-1,at);
    }
  }
}

export function prepareCity(signal) {
  const city=generateCity({
    layout:'grid',width:840,depth:704,blockWidth:78,blockDepth:68,angle:.075,seed:42,
    irregularity:.28,streetWidth:10,avenueWidth:19,avenueEvery:4,sidewalk:3.1,
    lotFrontage:23,lotDepth:26,downtownRadius:174,minStoreys:3,maxStoreys:34,
    centre:[29,-55],parks:.105,industry:.08,treeSpacing:0,lampSpacing:6.4,signal,
  });
  const batches=new Map(),emit=[],windows=[],fixtures=[],roofUnits=[];
  const blockCenters=city.blocks.map((block)=>block.centre);
  const rank=city.blocks.map(({centre:[x,z]},i)=>{
    const order=clamp(.41+.32*x/390+.25*z/310+variation(i,42)*.16);
    return 1079+Math.floor(order*94);
  });
  const group=(name)=>{
    if(!batches.has(name)) batches.set(name,data());
    return batches.get(name);
  };
  function addLightPane([p,q,,s],color,on) {
    emit.push(...p,q[0]-p[0],q[1]-p[1],q[2]-p[2],s[0]-p[0],s[1]-p[1],s[2]-p[2],...color,on);
  }
  function blockBox(name,move,x,y,z,w,h,d) { addBox(group(name),move,x,y,z,w,h,d); }

  blockBox('ground',basis(0,0),0,-1.62,0,1000,2,930);
  terrain(group('foothills'));
  addPolygon(group('asphalt'),city.edge,0);
  for(const [i,block] of city.blocks.entries()) {
    const {polygon,inner,centre:[x,z],use}=block;
    addPolygon(group('pavement'),polygon,.19);
    for(let s=0;s<polygon.length;s++) {
      const [ax,az]=polygon[s],[bx,bz]=polygon[(s+1)%polygon.length];
      const length=Math.hypot(bx-ax,bz-az);
      if(length>5) blockBox('podium',basis((ax+bx)/2,(az+bz)/2,Math.atan2(bx-ax,bz-az)),0,.10,0,.16,.20,length);
    }
    if(use!=='park'&&i%11!==0) continue;
    addPolygon(group('grass'),inner,.221);
    const axis=inner[0], opposite=inner[Math.floor(inner.length/2)];
    const dx=opposite[0]-axis[0],dz=opposite[1]-axis[1];
    const crossing=basis(x,z,Math.atan2(dx,dz));
    const length=Math.min(41,Math.hypot(dx,dz)*.79);
    blockBox('path',crossing,0,.232,0,2.6,.028,length);
    blockBox('path',crossing,0,.235,0,length*.78,.035,2.6);
    blockBox('stone',crossing,0,.266,0,9.3,.11,9.3);
    for(let j=0;j<6;j++) {
      const at=inner[j%inner.length];
      const f=.40+.22*variation(i,j+91);
      const px=mix(x,at[0],f),pz=mix(z,at[1],f);
      const move=basis(px,pz,variation(i,j+31)*Math.PI);
      const tall=2.5+variation(i,j+21)*2.3;
      blockBox('darkTrim',move,0,tall*.37,0,.32,tall*.78,.30);
      blockBox('leaves',move,0,tall*.83,0,2.38,tall*.54,2.61);
      blockBox('leavesLit',move,.3,tall*1.13,.2,1.67,1.32,1.55);
    }
  }

  for(const [i,edge] of city.roads.entries()) {
    const from=city.nodes[edge.from],to=city.nodes[edge.to],length=edge.length;
    if(length<19) continue;
    const x=(from[0]+to[0])/2,z=(from[1]+to[1])/2;
    const forward=Math.atan2(to[0]-from[0],to[1]-from[1]);
    const move=basis(x,z,forward);
    const avenue=edge.kind==='avenue';
    const laneOffset=avenue?.42:0;
    for(let p=-length/2+9;p<length/2-9;p+=10.8) {
      blockBox(avenue?'centerline':'paint',move,laneOffset,.028,p,.17,.046,2.8);
      if(avenue) blockBox('centerline',move,-laneOffset,.028,p,.17,.046,2.8);
    }
    if(avenue) {
      for(const side of [-1,1]) {
        const a=move(side*(edge.width*.31),0,-length*.43);
        const b=move(side*(edge.width*.31),0,length*.43);
        const {geometry}=road(straight([a[0],a[2]],[b[0],b[2]]),{segments:1,crossSection:[[-.086,0],[.086,0]]});
        appendGeometry(group('paint'),geometry);
      }
      for(const side of [-1,1]) {
        const at=side*(length/2-5.25);
        for(let j=-5;j<=5;j++) blockBox('paint',move,j*1.04,.029,at,.54,.048,2.75);
      }
    }
    if(i%5===0) {
      const position=(variation(i,106)-.5)*(length-17),offset=edge.width*.24*(i%2?1:-1);
      blockBox(i%4===0?'redCar':'silverCar',move,offset,.68,position,1.81,1.26,4.31);
      blockBox('midnight',move,offset,1.40,position+.14,1.65,.27,2.62);
      for(const side of [-1,1]) {
        const a=move(offset+side*.72,.54,position-2.17);
        const b=move(offset+side*.18,.54,position-2.17);
        const c=move(offset+side*.18,.73,position-2.17);
        const d=move(offset+side*.72,.73,position-2.17);
        addLightPane([a,b,c,d],[3.2,.20,.09],1095+Math.floor(variation(i)*42));
      }
    }
  }

  const landmarkPositions=city.buildings.map(({options:{origin:[x,_,z]}})=>[x,z]);
  const signature = new Map([
    [nearestIndex(landmarkPositions,80,-78),{height:183,style:'glazed',material:'bronzeGlass',step:true,spire:true}],
    [nearestIndex(landmarkPositions,22,-108),{height:143,style:'glazed',material:'midnight',step:true}],
    [nearestIndex(landmarkPositions,-115,-48),{height:136,style:'glazed',material:'glass',step:true}],
    [nearestIndex(landmarkPositions,130,-158),{height:128,style:'glazed',material:'glass',step:true}],
    [nearestIndex(landmarkPositions,-35,17),{height:112,style:'glazed',material:'glass',step:true}],
  ]);
  for(const [i,building] of city.buildings.entries()) {
    const o=building.options,[x,_,z]=o.origin;
    const wake=falloff(x,z,38,-82,189),old=falloff(x,z,-154,-41,119),hills=falloff(x,z,105,-226,120);
    const core=Math.max(wake,old*.68,hills*.68);
    const block=city.lots[building.lot].block,start=rank[block];
    const near=Math.hypot(x-100,z-85)<190;
    const landmark=signature.get(i);
    const w=o.width*(.83+.07*variation(i,23)),d=o.depth*(.84+.065*variation(i,12));
    const move=basis(x,z,o.yaw);
    if(!landmark&&near&&core<.61&&i%17===0) {
      const house=generateBuilding({style:'western-1910-brick',width:w,depth:d,origin:[x,.23,z],yaw:o.yaw,seed:o.seed,
        storeys:[4.2,3.5,3.5,3.4],detail:'far',interior:'none',roof:'flat',parapet:.65,window:[1.8,2.05],
        bayWidth:3.05,bands:true,cornice:true,windowKind:'double-hung',gutters:false});
      const mapping={walls:'brick',base:'stone',trim:'pearl',frames:'darkTrim',roof:'roof',glass:'bronzeGlass',doors:'darkTrim'};
      for(const [part,geometry] of Object.entries(house.parts)) mergeData(group(mapping[part]??'podium'),geometry);
      continue;
    }
    const floor=3.05+variation(i,31)*1.1;
    const bias=variation(i,25)**1.7;
    const scripted=core**2*(19+bias*96);
    const base=o.storeys.reduce((sum,value)=>sum+value,0);
    const height=landmark?.height??Math.min(143,Math.max(8.5,base*.40+8+scripted));
    const glazed=landmark?.style==='glazed'||(height>40&&variation(i,110)>.31);
    const wall=landmark?.material??(glazed?['glass','midnight','glass','bronzeGlass'][i%4]:['stone','violet','brick','pearl'][i%4]);
    const lobby=height>39?7.4:4.2;
    const cap=height>32?(landmark?7.5:3.3):1.6;
    const sectionCount=height>60&&(landmark?.step||i%3===0)?2:1;
    blockBox('podium',move,0,lobby/2+.23,0,w*1.02,lobby,d*1.02);
    blockBox('darkTrim',move,0,lobby+.48,0,w*1.04,.72,d*1.036);
    for(let s=0;s<sectionCount;s++) {
      const level=s===0?lobby+.9:height*.64;
      const top=s===sectionCount-1?height:height*.64;
      const width=w*(s===0?1:.79),depth=d*(s===0?1:.79);
      blockBox(wall,move,0,(level+top)/2,0,width,top-level,depth);
      const floors=Math.max(1,Math.round((top-level-.7)/floor));
      const dy=(top-level-.7)/floors;
      for(const [sideIndex,side] of sidePoints.entries()) {
        const along=side.dimension===0?width:depth;
        const boundary=side.dimension===0?depth/2:width/2;
        const bays=Math.max(2,Math.round(along/(glazed?3.10:3.75)));
        const dx=along/bays;
        const point=(a,y,b)=>move(...side.pos(a,y,b));
        const origin=move(0,0,0),normal=move(...side.normal).map((value,j)=>value-origin[j]);
        if(glazed) {
          const bin=group('panel');
          for(let j=0;j<=bays;j++) {
            const at=(j-bays/2)*dx;
            addQuad(bin,point(at-.095,level,boundary+.034),point(at+.095,level,boundary+.034),
              point(at+.095,top,boundary+.034),point(at-.095,top,boundary+.034),normal);
          }
        }
        for(let k=0;k<floors;k++) {
          const y=level+(k+.48)*dy+.22;
          if(glazed&&k%2===0) {
            addQuad(group('panel'),point(-along*.5,y-dy*.46,boundary+.035),point(along*.5,y-dy*.46,boundary+.035),
              point(along*.5,y-dy*.33,boundary+.035),point(-along*.5,y-dy*.33,boundary+.035),normal);
          }
          for(let j=0;j<bays;j++) {
            const a=(j+.5-bays/2)*dx;
            const division=(i+sideIndex*5+k*3+s*11)*97+j;
            const bayW=dx*(glazed?.81:.56+.12*variation(division,8));
            const paneH=dy*(glazed?.60:.57);
            const pane=(b)=>[
              point(a-bayW/2,y-paneH/2,b),point(a+bayW/2,y-paneH/2,b),
              point(a+bayW/2,y+paneH/2,b),point(a-bayW/2,y+paneH/2,b),
            ];
            if(!glazed) addQuad(group('midnight'),...pane(boundary+.023),normal);
            else if(variation(division,32)>.42) {
              addQuad(group(variation(division,44)>.55?'silverGlass':'smokedGlass'),...pane(boundary+.023),normal);
            }
            if(variation(division,19)>.63||variation(k+i*41+s*7,41)>.95) continue;
            const delay=start+Math.floor(variation(division,27)*19)+(glazed?0:12);
            const color=windowColors[Math.floor(variation(division,29)*windowColors.length)];
            addLightPane(pane(boundary+.051),color,delay);
            windows.push(delay);
          }
        }
        if(s===0&&near) {
          for(let j=0;j<bays;j++) {
            const a=(j+.5-bays/2)*dx;
            const b=boundary+.065;
            const q=[point(a-dx*.37,1.23,b),point(a+dx*.37,1.23,b),
              point(a+dx*.37,lobby-.62,b),point(a-dx*.37,lobby-.62,b)];
            addQuad(group('midnight'),...q,normal);
            if(j%3!==0) {
              const delay=start+9+i%8;
              const glow=q.map(([x,y,z])=>[x+normal[0]*.038,y,z+normal[2]*.038]);
              addLightPane(glow,[1.65,1.13,.58],delay);
              windows.push(delay);
            }
          }
        }
      }
      blockBox(i%5===0?'copper':'trim',move,0,top-.08,0,width*1.027,.50,depth*1.023);
      blockBox('roof',move,0,top+.13,0,width*.986,.64,depth*.982);
      if(s===sectionCount-1) {
        blockBox('panel',move,0,top+cap/2,0,width*.49,cap,depth*.51);
        blockBox('trim',move,0,top+cap+.3,0,width*.53,.63,depth*.56);
        if(height>38&&roofUnits.length<65) roofUnits.push([x+d*.11,top+.67,z-w*.19,o.yaw]);
        if(landmark?.spire) {
          blockBox('bronzeGlass',move,0,top+cap+5.2,0,width*.39,11,depth*.35);
          blockBox('copper',move,0,top+cap+13.5,0,width*.26,8,depth*.23);
          blockBox('trim',move,0,top+cap+25,0,1.35,24,1.35);
          const b=depth*.177;
          addLightPane([move(-width*.18,top+cap+9,b),move(width*.18,top+cap+9,b),
            move(width*.18,top+cap+9.46,b),move(-width*.18,top+cap+9.46,b)],[2.2,1.00,.33],1105);
        }
      }
    }
  }

  for(const [i,lamp] of city.lamps.entries()) {
    const [x,,z]=lamp.position,move=basis(x,z,lamp.yaw);
    const block=nearestIndex(blockCenters,x,z),delay=rank[block]-7;
    const avenue=i%6===0, y=avenue?7.6:5.4, arm=avenue?1.73:.87;
    blockBox('pole',move,0,.54,0,.37,.91,.37);
    blockBox('pole',move,0,y/2,0,.18,y,.18);
    blockBox('pole',move,0,y-.043,arm*.46,.19,.19,arm);
    blockBox('trim',move,0,y-.075,arm,.42,.19,.68);
    const lip=y-.198;
    addLightPane([move(-.19,lip,arm-.29),move(.19,lip,arm-.29),move(.19,lip,arm+.29),move(-.19,lip,arm+.29)],[6.2,3.77,1.36],delay);
    addLightPane([move(-.191,lip,arm+.343),move(.191,lip,arm+.343),move(.191,lip+.136,arm+.343),move(-.191,lip+.136,arm+.343)],[4.2,2.89,1.23],delay);
    fixtures.push({delay,position:move(0,lip-.10,arm),range:avenue?18:13,
      direction:[0,-1,0],innerAngle:.77,outerAngle:1.18,color:avenue?[1,.78,.50]:[1,.67,.34],intensity:avenue?167:96});
  }
  windows.sort((a,b)=>a-b);
  fixtures.sort((a,b)=>a.delay-b.delay);

  const approaches=city.roads.flatMap((lane)=>{
    const a=city.nodes[lane.from],b=city.nodes[lane.to],z=(a[1]+b[1])*.5,x=(a[0]+b[0])*.5;
    if(lane.kind!=='avenue'||Math.abs(a[1]-b[1])<lane.length*.9||z<60||z>260) return [];
    const [near,far]=a[1]>b[1]?[a,b]:[b,a];
    return [{score:Math.abs(x-41)*1.3+Math.abs(z-156)*.7,near,far}];
  }).sort((a,b)=>a.score-b.score);
  const {near,far}=approaches[0];
  const streetEye=[mix(near[0],far[0],.25),13.7,mix(near[1],far[1],.25)];
  const dx=far[0]-near[0],dz=far[1]-near[1],length=Math.hypot(dx,dz);
  const streetTarget=[streetEye[0]+dx/length*213,48,streetEye[2]+dz/length*213];
  const solid=Array.from(batches,([name,raw])=>[name,new Geometry(raw.positions,raw.normals,raw.indices)]);
  return {emissions:Float32Array.from(emit),fixtures,windows,streetEye,streetTarget,
    buildingCount:city.buildings.length,blockCount:city.blocks.length,
    mount(engine) {
      const materials=new Map(Object.entries(finishes).map(([name,settings])=>[name,new PbrMaterial({...settings,doubleSided:false})]));
      for(const [name,geometry] of solid) {
        const mesh=engine.createMesh().setGeometry(geometry).setMaterial(materials.get(name));
        mesh.name=name;
      }
      const lod=LODSystem.attach(engine,{hysteresis:.13});
      const detail=data(),coarse=data();
      addBox(coarse,basis(0,0),0,.77,0,3.4,1.50,4.6);
      const distant=new Geometry(coarse.positions,coarse.normals,coarse.indices);
      mergeData(detail,coarse);
      for(let i=0;i<5;i++) addBox(detail,basis(0,0),0,1.59,-1.54+i*.78,3.35,.26,.25);
      const near=new Geometry(detail.positions,detail.normals,detail.indices);
      for(const [x,y,z] of roofUnits) {
        const mesh=engine.createMesh().setGeometry(near).setMaterial(materials.get('podium')).setPosition([x,y,z]);
        lod.add(mesh,[{object:near},{object:distant,distance:172}]);
      }
    }};
}
