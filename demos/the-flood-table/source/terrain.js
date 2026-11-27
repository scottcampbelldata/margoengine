import { boxGeometry, cylinderGeometry, icosahedronGeometry, sphereGeometry } from '@margoengine/geometry';
import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { createMesh, Material, Texture } from '@margoengine/materials';

export const bounds = { x: -26, z: -15, width: 52, length: 30 };
export const grid = { columns: 104, rows: 60 };
export const damX = -13;
export const levees = [
  { name: 'Upper bend', x: -7, z: -1, halfLength: 4.5, crest: 1.62 },
  { name: 'Below the bridge', x: 3.2, z: 2.4, halfLength: 5.2, crest: 1.23 },
  { name: 'Village edge', x: 12.2, z: 1.4, halfLength: 6, crest: 1.04 },
];
export const houses = [
  [11.5, 6.4, .13, '#b77b56'], [14, 6.1, -.1, '#b2825e'], [16.3, 7.3, -.04, '#867761'],
  [18.8, 7.05, .08, '#a46a52'], [14.5, 9.3, -.28, '#7d5142'], [17.7, 10.1, .15, '#8e704d'],
  [20.9, 8.3, .04, '#b37553'], [19.3, 11, .06, '#a67b4e'],
];
const clamp = (t) => Math.max(0, Math.min(1, t));
const mix = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, t) => { const v = clamp((t - a) / (b - a)); return v * v * (3 - 2 * v); };
export const channel = (x) => 1.1 + 2.2 * Math.sin((x + 2) / 7.5) + 0.65 * Math.sin(x / 2.8);
const hash = (x, z) => {
  const v = Math.sin(x * 127.1 + z * 311.7) * 43758.5453123;
  return v - Math.floor(v);
};
function noise(x, z) {
  const i = Math.floor(x), j = Math.floor(z);
  const a = smooth(0, 1, x - i), b = smooth(0, 1, z - j);
  return mix(mix(hash(i, j), hash(i + 1, j), a), mix(hash(i, j + 1), hash(i + 1, j + 1), a), b);
}
export function ground(x, z) {
  const fromRiver = Math.abs(z - channel(x));
  const upstream = 1 - smooth(-18, -12.4, x);
  const reservoir = upstream * (1.8 + 0.55 * Math.cos(x * 0.31));
  const floor = -1.24 - x * .030;
  const inner = 2.2 + reservoir + .45 * noise(x * .3, z * .3);
  const floodplain = 1.32 * smooth(inner, inner + 3.8, fromRiver);
  const ridge = smooth(inner + 3, 12.6, fromRiver) * (1.25 + 2.5 * noise(x * .115, z * .19) + .42 * Math.sin(z * .58 - x * .26));
  const flank = smooth(2.1, 7.5, fromRiver);
  const grain = (.67 * noise(x * .36, z * .40) + .33 * noise(x * .9, z * .9) - .5) * mix(.3, 1, flank);
  const shoal = .33 * Math.exp(-(((x-6.8)/3.8)**2)) * Math.exp(-(((z-channel(x)+1.8)/.76)**2));
  const oxbow = .22 * Math.exp(-(((x-15.8)/4.5)**2)) * Math.exp(-(((z-channel(x)-3.05)/1.18)**2));
  return floor + reservoir * .3 + floodplain + ridge + grain + shoal - oxbow;
}
function groundTint(x, z) {
  const d = Math.abs(z - channel(x)), upstream = 1 - smooth(-18, -12.4, x);
  const mixColor = (a, b, t) => a.map((c, i) => mix(c, b[i], t));
  const pattern = noise(x * .25, z * .31), grain = noise(x * 2.3, z * 2.3);
  const path = Math.abs(z - (7.8 + .56 * Math.sin(x * .28)));
  const sand = mixColor([.302, .204, .112], [.405, .319, .191], pattern);
  const moss = mixColor([.053, .111, .058], [.198, .266, .106], pattern);
  const inland = mixColor(sand, moss, smooth(2.7 + upstream * 2.5, 5.1 + upstream * 2.5, d) *
    (.66 + .34 * noise(x * .84, z * .84)));
  const trail = x > -.5 ? (1 - smooth(.24, .65, path)) * smooth(-.5, 3.5, x) : 0;
  return mixColor(inland, [.39, .28, .145], .76 * trail).map((c) => c * (.82 + .31 * grain));
}

export function heightmap() {
  const values = new Float32Array(grid.columns * grid.rows);
  for (let j = 0; j < grid.rows; j++) {
    for (let i = 0; i < grid.columns; i++) {
      values[j * grid.columns + i] = ground(bounds.x + (i + .5) * bounds.width / grid.columns,
        bounds.z + (j + .5) * bounds.length / grid.rows);
    }
  }
  return values;
}

function landGeometry() {
  const columns = 156, rows = 90;
  const positions = [], normals = [], colors = [], uvs = [], indices = [];
  const stepX = bounds.width / columns, stepZ = bounds.length / rows;
  for (let j = 0; j <= rows; j++) {
    for (let i = 0; i <= columns; i++) {
      const x = bounds.x + i * stepX, z = bounds.z + j * stepZ;
      positions.push(x, ground(x, z), z);
      normals.push((ground(x - .14, z) - ground(x + .14, z)) / .28, 1,
        (ground(x, z - .14) - ground(x, z + .14)) / .28);
      colors.push(...groundTint(x, z));
      uvs.push(x*.17,z*.17);
      if (j && i) {
        const p = j * (columns + 1) + i;
        indices.push(p - columns - 2, p - 1, p - columns - 1, p - columns - 1, p - 1, p);
      }
    }
  }
  return { positions, normals, colors, uvs, indices };
}
function sectionGeometry() {
  const positions = [], normals = [], colors = [], indices = [];
  const corners = [[-26, -15], [-26, 15], [26, 15], [26, -15]];
  const tones = [[.18,.108,.062],[.32,.213,.113],[.23,.142,.074],[.40,.309,.185],[.24,.174,.103],[.30,.237,.135]];
  for (let s = 0; s < 4; s++) {
    const a = corners[s], b = corners[(s + 1) % 4], dx = b[0] - a[0], dz = b[1] - a[1];
    const q = Math.hypot(dx, dz), base = positions.length / 3, columns = 96;
    for (let i = 0; i <= columns; i++) {
      const x = a[0] + dx * i / columns, z = a[1] + dz * i / columns;
      const h = ground(x, z);
      for (let k = 0; k < tones.length; k++) {
        const t = k / (tones.length - 1), n = noise(x * .77 + k, z * .82);
        const y = k === tones.length - 1 ? h : mix(-2.42, h, t) + (n - .5) * .22 * t;
        positions.push(x, y, z);
        normals.push(-dz / q, 0, dx / q);
        colors.push(...tones[k].map((c) => c * (.76 + n * .45)));
        if (i && k) {
          const p = base + i * tones.length + k;
          indices.push(p - tones.length - 1, p - 1, p - tones.length, p - tones.length, p - 1, p);
        }
      }
    }
  }
  return { positions, normals, colors, indices };
}
function batch() {
  const positions = [], normals = [], colors = [], indices = [];
  return {
    add(geom, point, scale, yaw, color) {
      const c = Math.cos(yaw), s = Math.sin(yaw), start = positions.length / 3;
      for (let i = 0; i < geom.positions.length; i += 3) {
        const x = geom.positions[i] * scale[0], z = geom.positions[i + 2] * scale[2];
        positions.push(point[0] + c * x + s * z, point[1] + geom.positions[i + 1] * scale[1], point[2] - s * x + c * z);
        const nx = geom.normals[i] / scale[0], nz = geom.normals[i + 2] / scale[2];
        normals.push(c * nx + s * nz, geom.normals[i + 1] / scale[1], -s * nx + c * nz);
        const v = .88 + .19 * hash(i, start);
        colors.push(...color.map((channel) => channel * v));
      }
      const count = geom.indices?.length ?? geom.positions.length / 3;
      for (let i = 0; i < count; i++) indices.push(start + (geom.indices?.[i] ?? i));
    },
    geometry: { positions, normals, colors, indices },
  };
}
function color(hex) {
  return hex.match(/\w\w/g).map((pair) => {
    const n = parseInt(pair, 16) / 255;
    return n < .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4;
  });
}
function shelves() {
  const kit = batch();
  const slab = icosahedronGeometry(1, 1);
  const stone = ['#929184','#716c59','#a6a184','#7a8373','#5f665c'];
  for (let j = 0; j < 78; j++) {
    const x = mix(-24.8, 25, hash(j, 191));
    const z = -13.85 + 3.45 * hash(j, 182) + .55 * Math.sin(x * .19);
    const size = .24 + hash(j, 189) ** 2 * 1.57, yaw = hash(j, 195) * 6.28;
    const y = ground(x,z);
    kit.add(slab, [x,y + size*.18,z], [size,.32*size,.59*size], yaw, color(stone[j % stone.length]));
  }
  for (let j=0;j<31;j++) {
    const x=-12.5+(j%9)*.64;
    const z=channel(x)+3.5+.90*hash(j,235);
    const size=.19+.37*hash(j,229);
    kit.add(slab,[x,ground(x,z)+.065,z],[size,.27,.56*size],j*1.63,color(stone[j % stone.length]));
  }
  return kit.geometry;
}

function village() {
  const kit = batch(), cube = boxGeometry(1, 1, 1);
  const roof = cylinderGeometry(1, 1, 1, 3, 1);
  for (let i = 0; i < houses.length; i++) {
    const [x, z, yaw, shade] = houses[i], y = ground(x, z), scale = i === 0 ? 1.2 : .81 + hash(i, 1) * .37;
    const add = (geometry, lx, yOffset, lz, dims, tint, turn = yaw) => kit.add(geometry,
      [x + lx * Math.cos(yaw) + lz * Math.sin(yaw), y + yOffset * scale, z - lx * Math.sin(yaw) + lz * Math.cos(yaw)],
      dims.map((d) => d * scale), turn, color(tint));
    add(cube, 0, .33, 0, [1.42, .78, 1.22], '#bfab8c');
    add(cube, 0, .07, 0, [1.49, .15, 1.30], '#756e61');
    // A separate gable roof with two continuous eaves.
    const gable = {positions: [], normals: [], indices: []};
    for (const [a,b,c,n] of [
      [[-.79,0,.70],[0,.62,.70],[.79,0,.70],[0,0,1]], [[.79,0,-.70],[0,.62,-.70],[-.79,0,-.70],[0,0,-1]],
      [[0,.62,-.70],[0,.62,.70],[.79,0,.70],[.62,.79,0]], [[-.79,0,-.70],[-.79,0,.70],[0,.62,.70],[-.62,.79,0]],
    ]) {
      const start = gable.positions.length / 3;
      const four = n[2] === 0 ? [a,b,c,[c[0],c[1],-.70]] : [a,c,b];
      if (n[0] < 0) { four[3] = [0,.62,-.70]; }
      gable.positions.push(...four.flat());
      for (let j=0;j<four.length;j++) gable.normals.push(...n);
      gable.indices.push(start,start+1,start+2);
      if (four.length===4) gable.indices.push(start,start+2,start+3);
    }
    add(gable, 0, .72, 0, [1, 1, 1], shade);
    add(cube, -.24, 1.18, -.19, [.17, .38, .20], '#6e493d');
    add(cube, .05, .27, .617, [.19, .47, .035], '#26312d');
    for (const v of [-.43,.47]) {
      add(cube, v, .44, .618, [.18, .23, .04], '#293e40');
      add(cube, v, .31, .642, [.23, .035, .066], '#dad2b6');
    }
    add(cube, .715, .45, -.22, [.033,.24,.18], '#2e3e3b');
  }
  const bridgeX = -.7, middle = channel(bridgeX);
  const add = (shape, x,y,z,dims,tone) => kit.add(shape, [x,y,z], dims, 0, color(tone));
  for (let j = 0; j < 23; j++) {
    add(cube, bridgeX, .68 + .28 * Math.sin(j * Math.PI / 22), middle - 4.2 + .38 * j, [1.72,.14,.36], j % 3 ? '#98654a' : '#b17f55');
  }
  for (const xOffset of [-.73,.73]) for (let j = 0; j < 23; j++) {
    const z = middle - 4.2 + .38 * j, y = .68 + .28 * Math.sin(j * Math.PI / 22);
    add(cube, bridgeX + xOffset, y + .46, z, [.09,.08,.39], '#594436');
    if (j % 3 === 0) add(cube, bridgeX + xOffset, y + .23, z, [.10,.53,.12], '#655141');
  }
  for (const z of [middle-2.7,middle+2.7]) add(roof, bridgeX, -.22, z, [.35,1.55,.38], '#868178');
  return kit.geometry;
}
function woodland() {
  const kit = batch(), oak = sphereGeometry(1, 10, 6), pine = cylinderGeometry(.018, 1, 1, 8, 1);
  const trunk = cylinderGeometry(.45, 1, 1, 7, 1);
  const wood = color('#6e542f');
  for (let i = 0; i < 325; i++) {
    const x = mix(-25.2, 25.2, hash(i, 19)), z = mix(-14.1, 14.1, hash(i, 17));
    const d = Math.abs(z - channel(x)), h = ground(x, z);
    if (d < (x < damX ? 7.0 : 5.7) || hash(i, 21) < .25 || (x > 8 && z > 3.6)) continue;
    const cluster = noise(x * .31, z * .31);
    if (cluster < .32 && h < 2) continue;
    const height = .72 + hash(i, 4) * 1.36;
    const yaw = i * 2.39;
    const cool = hash(i, 7);
    const leaf = color(cool > .55 ? '#557448' : cool > .23 ? '#38533f' : '#758554');
    kit.add(trunk, [x, h + .28 * height, z], [.075,.58 * height,.075], yaw, wood);
    if (cool < .61) {
      for (let j = 0; j < 3; j++) {
        const span = (.40 - j * .083) * height;
        kit.add(pine, [x, h + height * (.63 + j * .21), z],
          [span, height * (.62 - j * .072), span], yaw, leaf.map((c) => c * (1 + j * .17)));
      }
    } else {
      for (let j = 0; j < 4; j++) {
        const a = j * 2.399 + yaw, radius = .23 + hash(i, j + 108) * .25;
        kit.add(oak, [x + Math.sin(a) * radius, h + height * (.71 + hash(j, i) * .28), z + Math.cos(a) * radius],
          [.42,.43,.39], yaw, leaf.map((c) => c * (.85 + .35 * hash(j, i + 1))));
      }
    }
  }
  for (let i = 0; i < 138; i++) {
    const x = mix(-25.2, 25.2, hash(i, 95)), z = channel(x) + (hash(i, 83) > .5 ? 1 : -1) * mix(1.85, 8.2, hash(i, 90));
    const span = .12 + .59 * hash(i, 91) ** 2;
    kit.add(oak, [x, ground(x, z) + span * .22, z], [span, span * .51, span * .77], i * .618,
      color(i % 3 ? '#a29878' : '#655d4e'));
  }
  return kit.geometry;
}

function soilTexture() {
  const size=128, data=new Uint8Array(size*size*4);
  const pattern=(x,y)=>{
    const a=x*2*Math.PI/size,b=y*2*Math.PI/size;
    return .38*Math.sin(a*8+b*5+.42*Math.sin(b*3))
      +.24*Math.sin(a*21-b*19)*Math.cos(a*18+b*4)
      +.19*Math.sin(a*37+b*29)+.09*Math.sin(a*37-b*51);
  };
  for(let j=0;j<size;j++){
    for(let i=0;i<size;i++){
      const nx=(pattern(i-1,j)-pattern(i+1,j))*.41, ny=(pattern(i,j-1)-pattern(i,j+1))*.41;
      const l=Math.hypot(nx,ny,1);
      data.set([Math.round((nx/l+1)*127.5),Math.round((ny/l+1)*127.5),Math.round((1/l+1)*127.5),255],
        (j*size+i)*4);
    }
  }
  return new Texture({width:size,height:size,data},{colorSpace:'linear',wrapS:'repeat',wrapT:'repeat'});
}

export function table(engine, shadows) {
  const build = (geo, material, name, position, cast = true) => {
    const mesh = createMesh(engine, geo, material);
    mesh.root.name = name;
    if (position) mesh.root.setPosition(position);
    if (cast) shadows.add(mesh, { static: !/Sluice rib|Reservoir sluice/.test(name) });
    return mesh;
  };
  const colored = new Material({ color: '#ffffff', roughness: .89 });
  const charcoal = new Material({ color: '#17241d', roughness: .63, metalness: .12 });
  const lacquer = new Material({ color: '#414d3e', roughness: .49, metalness: .19 });
  const brass = new Material({ color: '#c38c4f', roughness: .31, metalness: .57 });
  const damConcrete = new Material({ color: '#9e9984', roughness: .86 });
  const gateSteel = new Material({ color: '#a67a52', roughness: .37, metalness: .50 });
  const soilNormal=soilTexture();
  const soil=new Material({color:'#ffffff',roughness:.90,normalMap:soilNormal,normalScale:.52});
  build(landGeometry(), soil, 'Eroded Hawthorn valley');
  build(sectionGeometry(), colored, 'Cutaway earth strata');
  build(woodland(), colored, 'Woodlands and river stones');
  build(shelves(), colored, 'Eroded hillside outcrops');
  build(village(), colored, 'Hawthorn village and footbridge');
  build(roundedBoxGeometry(53.25, .89, 31.25, 3, .41), lacquer, 'Lacquered edge', [0,-2.67,0]);
  build(roundedBoxGeometry(54.7, .88, 32.8, 3, .42), charcoal, 'Cast base', [0,-3.43,0]);
  build(roundedBoxGeometry(9.6,.13,1.25,3,.065), brass, 'Brass survey rules', [-18,-2.18,15.72]);
  for (let i = 0; i < 17; i++) build(boxGeometry(.023,.018,i % 4 ? .2 : .45), charcoal,
    'Etched division', [-22.3 + i * .53, -2.10,15.72], false);
  build(boxGeometry(480,.2,480), new Material({ color: '#1e2a24', roughness: .94 }),
    'Studio surface', [0,-3.98,0]);
  const z = channel(damX);
  for (const side of [-1,1]) {
    build(roundedBoxGeometry(1.3,4.1,1.1,2,.13), damConcrete, 'Gate abutment', [damX,.05,z + 4.4*side]);
    build(boxGeometry(1.45,.21,1.23), charcoal, 'Abutment cap', [damX,2.17,z + 4.4*side]);
    build(roundedBoxGeometry(.32,5.1,.30,2,.035), charcoal, 'Slotted hoist column', [damX+.31,2.55,z+3.97*side]);
    build(boxGeometry(.18,4.87,.11), brass, 'Phosphor-bronze gate guide', [damX+.43,2.54,z+3.74*side]);
    build(roundedBoxGeometry(.51,.20,.63,2,.039), gateSteel, 'Hoist pedestal', [damX+.31,4.99,z+3.97*side]);
  }
  const gate = build(roundedBoxGeometry(.40,4.12,7.8,2,.12), gateSteel, 'Reservoir sluice', [damX,.08,z]);
  build(boxGeometry(.86,.20,8.36), damConcrete, 'Sluice walkway', [damX,2.22,z]);
  build(roundedBoxGeometry(.55,.235,8.22,2,.054), charcoal, 'Cross-braced hoist beam', [damX+.31,5.22,z]);
  for (const sign of [-1,1]) {
    build(cylinderGeometry(.24,.24,.24,18,1), brass, 'Lift drum', [damX+.31,5.45,z+2.83*sign])
      .root.setRotation([Math.PI/2,0,0]);
  }
  const reinforcement = [];
  for (let i=0;i<9;i++) reinforcement.push(build(boxGeometry(.12,3.73,.12), brass, 'Sluice rib',
    [damX+.23,.08,z-3.5+i*.875]));
  const wallModels = levees.map(({x,z,halfLength,crest}) => {
    const wall = build(roundedBoxGeometry(.48,crest+2.1,halfLength*2,2,.13), brass, 'Removable floodwall',
      [x,-100,z], false);
    return wall;
  });
  return {
    dispose() { soil.dispose(); soilNormal.dispose(); },
    setWall(index) {
      wallModels.forEach((wall,i) => { const {x,z,crest} = levees[i]; wall.root.setPosition([x, i===index ? (crest-2.1)/2 : -100, z]); });
    },
    setGate(t) {
      const y = .08 + 2.99 * t;
      gate.root.setPosition([damX,y,z]);
      reinforcement.forEach((rib,i) => rib.root.setPosition([damX+.23,y,z-3.5+i*.875]));
    },
  };
}
