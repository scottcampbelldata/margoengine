import { boxGeometry, cylinderGeometry } from '@margoengine/geometry';
import { createMesh, PbrMaterial } from '@margoengine/materials';
import { materialPlugin } from '@margoengine/materials/plugins';
import { Shadows } from '@margoengine/shadows';

export const shore = 1.68;
export const stones = [
  { x: .21, z: -1.33, top: .16, radius: .29 },
  { x: -.13, z: -.78, top: .21, radius: .32 },
  { x: .23, z: -.18, top: .29, radius: .33 },
  { x: -.18, z: .43, top: .17, radius: .31 },
  { x: .18, z: 1.02, top: .22, radius: .34 },
  { x: -.17, z: 1.54, top: .11, radius: .31 },
];
export const movableStone = 2;

const TAU = Math.PI * 2;
const rgb = (r,g,b) => [r,g,b];
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const mix = (a, b, t) => a + (b - a) * t;
function noise(a, b = 0) {
  const p = Math.sin(a * 123.17 + b * 49.71 + 73.53) * 43758.5453;
  return p - Math.floor(p);
}
function edge(x, side) {
  return side * (shore + .08 * Math.sin(1.23 * x) + .12 * Math.sin(.68 * x + side));
}
export function landHeight(x, z) {
  const side = Math.sign(z) || 1;
  const u = Math.max(0, side * (z - edge(x, side)));
  const ridge = Math.max(0,u-3.1) * (.17+.11*Math.cos(x*.46+side*.83));
  return .055 + .062 * u + ridge + .040 * Math.sin(x * 2.2 + z * 1.56) + .032 * Math.sin(x * 4.4 - z * 2.7);
}
function bank(side) {
  const positions = [], normals = [], colors = [], indices = [];
  const stepsX = 132, stepsZ = 44;
  for (let j = 0; j <= stepsZ; j++) {
    for (let i = 0; i <= stepsX; i++) {
      const x = -20 + i * 40 / stepsX, z = edge(x, side) + side * (j * 9.6 / stepsZ - .21);
      const y = landHeight(x, z) - .22 * Math.max(0, 1 - j * .75);
      positions.push(x, y, z);
      normals.push((landHeight(x - .04, z) - landHeight(x + .04, z)) / .08, 1,
        (landHeight(x, z - .04) - landHeight(x, z + .04)) / .08);
      const base = .72 + .33 * noise(i,j) + .19 * Math.sin(x * 4.2 + z);
      const moss = clamp(.5 + .5 * Math.sin(x * 1.43 + z * 1.15) - .14 * Math.sin(x * 5.3), 0, 1);
      colors.push(base * mix(.109,.070,moss), base * mix(.078,.113,moss), base * mix(.046,.031,moss));
      if (i && j) {
        const d = j * (stepsX + 1) + i, c = d - 1, b = d - stepsX - 1, a = b - 1;
        indices.push(...(side > 0 ? [a,c,b,b,c,d] : [a,b,c,b,d,c]));
      }
    }
  }
  return { positions, normals, indices, colors };
}

function basalt(seed, width, length, height) {
  const positions = [], normals = [], colors = [], indices = [];
  const count = 14;
  const layers = [[.74, -height], [1, -height * .58], [.92, -.047], [.78, -.012], [.51, 0]];
  for (let row = 0; row < layers.length; row++) {
    const [scale, y] = layers[row];
    for (let i = 0; i < count; i++) {
      const a = i / count * TAU + (noise(i, seed + 5) - .5) * .13;
      const shape = mix(.80, 1.15, noise(i,seed)) * (1 + .12*Math.cos(a*2.0+seed));
      const x = Math.cos(a), z = Math.sin(a);
      const lift = row > 2 ? (.007 * (noise(i, seed + row) - .5)) : (.034 * (noise(i,seed + row)- .5));
      positions.push(x * shape * scale * width, y + lift, z * shape * scale * length);
      const slope = [.10, .03, .48, 1.25, 6][row];
      normals.push(x / width, slope / Math.sqrt(width * length), z / length);
      const mineral = noise(i + row * .12, seed + 7);
      const moss = row === 0 || row >= 4 ? 0 : noise(i, seed + 13) > .76 ? .055 : 0;
      const value = [.45,.66,.79,1.04,1.25][row] * mix(.64,1.34,mineral);
      colors.push(value * .129 + moss * .5, value * .143 + moss, value * .147 + moss * .15);
      const next = (i+1) % count;
      if (row) {
        const low = (row-1)*count, high = row*count;
        indices.push(low+i,high+i,low+next, low+next,high+i,high+next);
      }
    }
  }
  const center = positions.length / 3;
  positions.push(0,0,0);
  normals.push(0,1,0);
  colors.push(.172,.188,.186);
  for (let i=0; i<count; i++) indices.push(center, count*4+(i+1)%count, count*4+i);
  const bottom = positions.length / 3;
  positions.push(0,-height,0);
  normals.push(0,-1,0);
  colors.push(.052,.060,.059);
  for (let i=0; i<count; i++) indices.push(bottom,i,(i+1)%count);
  return { positions, normals, indices, colors };
}

function geometryBatch() {
  const geometry = { positions: [], normals: [], colors: [], indices: [] };
  return {
    geometry,
    add(mesh, x, y, z, turn = 0, tint = [1,1,1]) {
      const base = geometry.positions.length / 3;
      const c = Math.cos(turn), s = Math.sin(turn);
      for (let i=0; i<mesh.positions.length; i+=3) {
        const [px, py, pz] = [mesh.positions[i], mesh.positions[i+1], mesh.positions[i+2]];
        const [nx, ny, nz] = [mesh.normals[i], mesh.normals[i+1], mesh.normals[i+2]];
        geometry.positions.push(x + c*px + s*pz, y + py, z - s*px + c*pz);
        geometry.normals.push(c*nx+s*nz, ny, -s*nx+c*nz);
        geometry.colors.push(
          tint[0] * (mesh.colors?.[i] ?? 1), tint[1] * (mesh.colors?.[i+1] ?? 1),
          tint[2] * (mesh.colors?.[i+2] ?? 1),
        );
      }
      for (const index of mesh.indices) geometry.indices.push(base + index);
    },
  };
}

function leaf(g, root, tip, width, tint) {
  const [x,y,z] = root, [tx,ty,tz] = tip;
  const d = Math.hypot(tx-x,tz-z) || 1;
  const dx = (tz-z)*width/d, dz = (x-tx)*width/d;
  const cx = mix(x,tx,.42), cy = mix(y,ty,.42), cz = mix(z,tz,.42);
  const i = g.positions.length/3;
  g.positions.push(x,y,z, cx+dx,cy-.013,cz+dz, tx,ty,tz, cx-dx,cy-.013,cz-dz, cx,cy+.012,cz);
  g.normals.push(0,1,0, .09,.93,.15, 0,1,0, -.09,.93,-.15, 0,1,0);
  for (const t of [.74,.94,1.13,.82,1.22]) g.colors.push(tint[0]*t,tint[1]*t,tint[2]*t);
  g.indices.push(i,i+1,i+4, i+1,i+2,i+4, i+2,i+3,i+4, i+3,i,i+4);
}

function flora() {
  const g = { positions:[], normals:[], colors:[], indices:[] };
  for (let k=0; k<80; k++) {
    const side = k % 2 ? 1 : -1;
    const x = -7 + 14*noise(k,301);
    const z = edge(x,side) + side*(.27+3.3*noise(k,302));
    if (Math.abs(x)<.59 && Math.abs(z)<2.59) continue;
    const y = landHeight(x,z), radius = .14 + .19 * noise(k,303);
    for (let j=0; j<9; j++) {
      const a = j * 2.399 + noise(k,305), len = radius * (1.04 + .85*noise(j,k));
      const tip = [x+Math.cos(a)*len*.73, y+len*(.85 + .33 * noise(k,j)), z+Math.sin(a)*len*.73];
      leaf(g,[x,y,z],tip,len*(.056+.035*noise(j,k)), [.094,.185 + .07 * noise(k,j+9),.044]);
    }
  }
  for (let k=0; k<23; k++) {
    const x = -.46 + (k % 2 ? 1 : -1) * (1.18 + noise(k,307) * 5);
    const side = k < 12 ? -1 : 1, z = edge(x, side) + side*(.57+2.2*noise(k,311));
    const y = landHeight(x,z);
    const span = .28 + .25*noise(k,313);
    for (let p=0;p<6;p++) {
      const a = p * 1.07 + noise(k,316), dx=Math.cos(a), dz=Math.sin(a);
      for(let pair=0; pair<7; pair++) {
        const u=(pair+.75)/8;
        const crown=[x+span*u*dx,y+span*(.50*u+.53*Math.sin(u*Math.PI*.88)),z+span*u*dz];
        const v = span*.31*(1-u)*(Math.sin(u*Math.PI*.83)+.35);
        for(const flip of [-1,1]) {
          leaf(g,crown,[crown[0]+v*(.42*dx-flip*dz),crown[1]+v*.12,crown[2]+v*(.42*dz+flip*dx)],
            Math.max(.008,v*.23), [.053 + u*.03,.138 + u*.08,.033]);
        }
      }
    }
  }
  return g;
}

function sheet() {
  const width=40, depth=4.3, nx=80, nz=20;
  const positions=[], normals=[], colors=[], indices=[];
  for(let j=0;j<=nz;j++)for(let i=0;i<=nx;i++){
    const x=-width/2+i*width/nx,z=-depth/2+j*depth/nz;
    positions.push(x,-.035,z);
    normals.push(0,1,0);
    const shaded=.75+.25*noise(i,j)+.19*Math.sin(z*3.1+x*.64);
    colors.push(.027*shaded,.074*shaded,.068*shaded);
    if(i&&j){
      const d=j*(nx+1)+i,c=d-1,b=d-nx-1,a=b-1;
      indices.push(a,c,b,b,c,d);
    }
  }
  return { positions,normals,colors,indices };
}

export function makeCreek(engine) {
  const sun = Shadows.attach(engine, {
    resolution: 1024, bounds: {min:[-8,-1,-6],max:[8,6,6]},
    filter:'pcf', samples:8, lightSize:.30, normalBias:.013,
  });
  const texture = 'fn mineralHash(p:vec3f)->f32 { return fract(sin(dot(p,vec3f(127.1,311.7,74.7)))*43758.5453); }';
  const stoneMaterial = new PbrMaterial({
    name:'Wet basalt', roughness:.57, diffuseRoughness:.44,
    features:[materialPlugin({
      name:'mineral',
      declarations:texture,
      surface:'let p=i.position; let fractures=smoothstep(0.86,0.98,sin(p.y*49.0+p.x*11.0+sin(p.z*17.0)*0.72)); let grit=mineralHash(floor(p*193.0)); let grain=0.79+0.20*grit+fractures*0.10; s.base=vec4f(s.base.rgb*grain,s.base.a); s.roughness=0.47+grit*0.14;',
    })],
  });
  const bankMaterial = new PbrMaterial({
    name:'Soil and moss', roughness:.92,
    features:[materialPlugin({
      name:'bankGrain',
      declarations:'fn bankGrainHash(p:vec2f)->f32 { return fract(sin(dot(p,vec2f(161.2,197.4)))*41314.7953); }',
      surface:'let specks=bankGrainHash(floor(i.position.xz*143.0)); let loam=0.81+0.23*specks; let exposed=smoothstep(0.35,0.68,sin(i.position.x*11.0+sin(i.position.z*6.1)*1.5)*sin(i.position.z*8.8)); s.base=vec4f(s.base.rgb*(loam+exposed*0.14),1.0);',
    })],
  });
  for (const side of [-1,1]) sun.add(createMesh(engine, bank(side), bankMaterial));
  const gravel = geometryBatch();
  for(let k=0;k<160;k++){
    const side=k%2?1:-1, x=-8.8+17.6*noise(k,50);
    const inland=.04+noise(k,51)**2*1.52, z=edge(x,side)+side*inland;
    if(Math.abs(x)<.75 && Math.abs(z)<2.65 && inland>.20)continue;
    const w=.036+.29*noise(k,52)**2;
    const y=landHeight(x,z)+.036+w*.28;
    gravel.add(basalt(k,w,w*(.65+.50*noise(k,53)),w*.72),x,y,z,noise(k,54)*TAU,
      rgb(.85+noise(k,55)*.33,.86+noise(k,57)*.35,.80+noise(k,59)*.3));
  }
  for(let k=0;k<18;k++){
    const x=-8.0+noise(k,15)*16, side=k%2?-1:1;
    const z=edge(x,side)+side*(1.08+3.4*noise(k,19));
    if(Math.abs(x)<1.45&&Math.abs(z)<3)continue;
    const w=.48+noise(k,16)*1.12;
    const y=landHeight(x,z)+w*(.26+.21*noise(k,17));
    gravel.add(basalt(200+k,w,w*.7,w*.62),x,y,z,noise(k,18)*TAU,[.63,.74,.68]);
  }
  const rockBanks=createMesh(engine,gravel.geometry,stoneMaterial);
  sun.add(rockBanks);
  const leaves=createMesh(engine,flora(),new PbrMaterial({name:'Sedge and fern fronds',roughness:.72,doubleSided:true}));
  sun.add(leaves);
  const timber=geometryBatch();
  const thicket={positions:[],normals:[],colors:[],indices:[]};
  for(let k=0;k<45;k++){
    const side=k%2?1:-1, x=-18.4+24.4*noise(k,491), z=edge(x,side)+side*(2.50+6.7*noise(k,494));
    if (Math.abs(x)<1.60 && Math.abs(z)<4.9) continue;
    const h=3.6+3.2*noise(k,496), r=.09+.18*noise(k,497), y=landHeight(x,z);
    const trunk=cylinderGeometry(r*.60,r,h,10,1);
    const lean=(noise(k,493)-.5)*.18;
    for(let i=0;i<trunk.positions.length;i+=3)trunk.positions[i]+=lean*(trunk.positions[i+1]+h*.5);
    timber.add(trunk,x,y+h*.45,z,noise(k,498)*TAU,[.056,.077,.057]);
    const crown= .68+1.05*noise(k,500), xCrown=x+lean*h*.73;
    for(let j=0;j<38;j++){
      const angle=j*2.399+3.0*noise(k,501), layer=Math.floor(j/8), radius=crown*(1-layer*.117)*(.78+noise(j,k)*.57);
      const baseY=y+h*.68+layer*h*.058;
      const px=xCrown+Math.cos(angle)*radius*.39, pz=z+Math.sin(angle)*radius*.39;
      const dy=(.12+noise(j,k+3)*.29)*radius;
      const vision=.79+.21*noise(j,k+13)+layer*.04;
      leaf(thicket,[px,baseY,pz],[xCrown+Math.cos(angle)*radius,baseY+dy,z+Math.sin(angle)*radius],
        radius*(.16+.13*noise(j,k+21)), [.043*vision,.099*vision,.061*vision]);
    }
  }
  sun.add(createMesh(engine,timber.geometry,new PbrMaterial({
    name:'Alder bark',roughness:.91,
    features:[materialPlugin({
      name:'bark',
      surface:'let p=i.position; let ridges=0.85+0.14*sin(p.x*81.0+sin(p.y*18.9)*0.29)*sin(p.z*42.0+sin(p.y*1.9)); s.base=vec4f(s.base.rgb*ridges,s.base.a);',
    })],
  })));
  createMesh(engine,thicket,new PbrMaterial({name:'Creek canopy',roughness:.82,doubleSided:true}));
  const current=materialPlugin({
    name:'current',
    uniforms:{seconds:0},
    declarations:'fn currentHash(p:vec2f)->f32 { return fract(sin(dot(p,vec2f(127.1,311.7)))*43758.5453); } fn currentNoise(p:vec2f)->f32 { let q=floor(p); let r=fract(p); let u=r*r*(3.0-2.0*r); return mix(mix(currentHash(q),currentHash(q+vec2f(1.0,0.0)),u.x),mix(currentHash(q+vec2f(0.0,1.0)),currentHash(q+vec2f(1.0,1.0)),u.x),u.y); }',
    surface:'let p=i.position.xz; let t=current.seconds; let advected=vec2f(p.x-0.42*t,p.y); let bends=currentNoise(advected*vec2f(2.3,4.1)); let flow=sin(advected.y*54.1+advected.x*3.13+bends*7.2+t*0.9); let ripples=sin(advected.x*9.1+advected.y*29.6+bends*6.5); let bars=currentNoise(advected*vec2f(4.0,13.0)); let sheen=pow(max(0.0,flow*0.55+ripples*0.45),5.0)*smoothstep(0.35,0.84,bars); let edge=smoothstep(0.74,1.8,abs(p.y)); s.n=normalize(vec3f(ripples*0.041,1.0,flow*0.072)); s.base=vec4f(mix(s.base.rgb,vec3f(0.069,0.102,0.070),edge*0.52)*(0.93+bars*0.15)+vec3f(0.032,0.054,0.043)*sheen,1.0); s.roughness=0.22+bars*0.11;',
    light:'color += vec3f(0.021,0.077,0.084)*pow(1.0-max(dot(s.n,v),0.0),3.0);',
  });
  createMesh(engine,sheet(),new PbrMaterial({name:'Shallow current',roughness:.28,features:[current]}));
  const steps=stones.map((stone,i)=>{
    const mesh=createMesh(engine,basalt(91+i,stone.radius,stone.radius*.92,stone.top+.13),stoneMaterial);
    mesh.root.setPosition([stone.x,stone.top,stone.z]);
    mesh.root.setRotation([0,(i%3-1)*.38,0]);
    sun.add(mesh);
    return mesh.root;
  });
  const a=stones[movableStone];
  const survey = new PbrMaterial({name:'Survey marker',color:'#d49854',metallic:.40,roughness:.57});
  const tack=createMesh(engine,boxGeometry(.075,.012,.025),survey);
  const align=(offset)=>{
    steps[movableStone].setPosition([a.x+offset,a.top,a.z]);
    tack.root.setPosition([a.x+offset+.13,a.top+.007,a.z-.055]);
  };
  align(0);
  return { sun, animate(seconds){current.uniforms.seconds=seconds;}, setStoneOffset:align };
}
