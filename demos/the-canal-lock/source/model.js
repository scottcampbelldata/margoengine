import { createMesh, Material } from '@margoengine/materials';
import { box, cyclorama, merge, MeshData, mix, pigment, rng, round, waterSurface } from './geometry.js';
import { chamber } from './lockage.js';

const station = chamber.length / 2;
const width = chamber.width / 2;
const length = 20.8;
const plinth = -1.07;
const masonry = ['#9d8e75','#b2a487','#a49982','#8d816b','#9b8d76','#a89b84'].map(pigment);
const bricks = ['#a38b72','#a78e78','#b49881','#967a66'].map(pigment);
const hullTones = ['#354744','#3b5550','#9b5a47','#2d3a3b'].map(pigment);
const paint = '#bb864a';

function mason(add, materials) {
  const cut = new MeshData();
  const rock = new MeshData();
  const lower = new MeshData();
  const random = rng(111287);
  add(cyclorama(), materials.sweep, 'Sage grey studio cove', 'receive');
  add(box(43.2,.72,15.6,[0,-1.52,-4.0],.23), materials.base, 'Fumed wood exhibition base', 'static');
  add(box(42.7,.09,15.0,[0,-1.115,-4.0],.039), materials.engrave, 'Cast bronze outline along the plinth');
  add(box(42.3,.27,14.75,[0,-.91,-4.0],.071), materials.cut, 'Foundation slab', 'static');

  const ground = new MeshData();
  ground.shape(box(41.6,.37,8.2,[0,3.28,-7.0],.05), pigment('#747965'));
  ground.shape(box(41.6,4.19,8.28,[0,1.12,-7.10],.039), pigment('#817767'));
  ground.shape(box(41.4,.26,2.53,[0,3.52,-3.94],.045), pigment('#a39b86'));
  add(ground.data, materials.stone, 'Towpath foundation and rear banks', 'static');

  for (let row = 0; row < 8; row++) {
    const y = -.55 + row * .52;
    for (let col = 0; col < 26; col++) {
      const blockX = -20.75 + (col + (row % 2 ? .47 : .03)) * 1.60;
      const start = Math.max(-20.79, blockX);
      const end = Math.min(20.79, blockX + 1.587);
      if (end - start < .05) continue;
      const tint = masonry[Math.floor(random() * masonry.length)];
      rock.shape(box(end-start,.489,.44,[.5*(start+end),y,-2.66],.034), y > .86 ? tint : mix(tint,pigment('#77755e'),.20));
    }
  }
  for (let col = 0; col < 36; col++) {
    const x = -20.83 + (col + .50) * 41.66 / 36;
    rock.shape(box(1.10,.16,.78,[x,3.66,-2.72],.045), masonry[2 + col % 4]);
    cut.shape(box(1.12,.17,.54,[x,.20,2.53],.031), masonry[3 + col % 3]);
  }
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 33; col++) {
      const x = -20.9 + (col + .5) * 41.8 / 33;
      cut.shape(box(1.221,.455,1.06,[x,-.58 + .493 * row,2.82],.038), masonry[(col + row * 3) % masonry.length]);
    }
  }
  add(box(41.6,.12,1.02,[0,.280,2.81],.030), materials.cut, 'Sawcut outer towpath cap', 'static');
  add(cut.data, materials.stone, 'Capped front cutaway ashlar masonry', 'static');
  add(rock.data, materials.stone, 'Wet ashlar lock and reach walls', 'static');

  lower.shape(box(2 * length,.21,4.78,[0,-.21,0],.019), pigment('#6a6253'));
  lower.shape(box(length-station-.03,1.65,4.79,[(station+length)/2,.59,0],.036), pigment('#746658'));
  for (const x of [-station,station]) {
    const sillHeight = x < 0 ? .18 : 1.53;
    lower.shape(box(.97,.19,4.85,[x-.08,sillHeight,0],.026), pigment('#938b73'));
    for (const z of [-2.34,2.40]) {
      const height = z > 0 ? 1.23 : 2.98;
      lower.shape(box(.76,height,.59,[x,.37+height/2,z],.051), pigment('#8d8873'));
      lower.shape(box(.84,.15,.68,[x,.37+height,z],.032), pigment('#a9a18a'));
    }
  }
  add(lower.data, materials.stone, 'Lower invert, chamber bed and upper sill', 'static');

  const railing = [];
  const metal = [];
  const spurs = [];
  const pave = new MeshData();
  for (let i = 0; i < 38; i++) {
    const x = -20.4 + i * 1.087;
    for (let row = 0; row < 3; row++) {
      const z = -3.17 - row * .612;
      pave.shape(box(1.052,.035,.574,[x+(row % 2 ? .17 : 0),3.666,z],.009),
        mix(masonry[(i+row*2) % masonry.length],pigment('#b4ad95'),.36));
    }
  }
  add(pave.data, materials.stone, 'Staggered cut-stone footway', 'static');
  for (const [start,end] of [[-20.0,-10.4],[-7.5,7.8],[11.1,20.1]]) {
    railing.push(box(end-start,.090,.075,[(start+end)/2,4.33,-3.05],.021));
    railing.push(box(end-start,.049,.053,[(start+end)/2,4.00,-3.05],.014));
    for (let x = start; x <= end + .05; x += 1.25) {
      railing.push(round(.037,.73,[x,4.01,-3.05]));
      metal.push(round(.095,.062,[x,3.70,-3.05]));
    }
  }
  for (const x of [-18.3,-14.5,-8.0,-4.5,2.9,7.7,12.3,16.4,19.8]) {
    metal.push(round(.116,.090,[x,3.71,-2.59]));
    metal.push(round(.088,.40,[x,3.88,-2.59]));
    railing.push(round(.143,.068,[x,4.11,-2.59]));
  }
  add(merge(railing), materials.iron, 'Green painted towpath guardrails and bollards', 'static');
  add(merge(metal), materials.iron, 'Bollard mountings and toe flanges', 'static');
  add(box(.44,2.85,.09,[-3.97,1.95,-2.402],.034), materials.iron, 'Cast-iron chamber level gauge', 'static');
  const gauge = [];
  for (let mark = 0; mark < 13; mark++) {
    const important = mark === 1 || mark === 11;
    gauge.push(box(important ? .315 : .177,.036,.024,[-3.97, .74 + mark*.18,-2.350],.01));
  }
  add(merge(gauge),materials.lightTimber,'Water-level gauge graduations');

  for (const x of [-15,-5,3,12]) {
    for (const k of [x-.15,x+.15]) spurs.push(box(.10,.47,.083,[k,-.17,3.38],.018));
  }
  add(merge(spurs), materials.iron, 'Exposed culvert cover clamps', 'static');
  const route = [];
  route.push(box(38.55,.21,.098,[0,-.17,3.377],.034));
  for (const x of [-17.8,-8.4,-5.7,-2.8,0,2.8,5.7,8.4,17.75]) {
    route.push(box(.178,.451,.097,[x,.002,3.377],.031));
  }
  add(merge(route), materials.culvert, 'Culvert routing revealed in the section');
}

function roof(add, materials) {
  const building = new MeshData();
  const wood = [];
  const glazing = [];
  const trim = [];
  const roofTiles = new MeshData();
  const turf = new MeshData();
  const x0 = 12.80;
  const z0 = -7.75;
  const w = 5.58;
  const d = 3.44;
  const bottom = 3.47;
  const eave = 5.42;
  const ridge = 6.42;
  const random = rng(58229);
  building.shape(box(w, eave-bottom, d,[x0,(bottom+eave)/2,z0],.045), pigment('#ad9580'));
  building.shape(box(w+.22,.265,d+.22,[x0,bottom+.11,z0],.059), pigment('#938674'));
  const l = x0-w/2;
  const r = x0+w/2;
  building.triangle([l,eave,z0+d/2], [l,ridge,z0], [l,eave,z0-d/2], pigment('#9c8574'));
  building.triangle([r,eave,z0-d/2], [r,ridge,z0], [r,eave,z0+d/2], pigment('#9c8574'));
  const colors = ['#8d5f4e','#9c6650','#a57562','#8d6556','#a06655'].map(pigment);
  for (const side of [-1,1]) {
    for (let across = 0; across < 6; across++) {
      const fraction = across/6;
      const outer = (across + 1)/6;
      const y = ridge + .03 + (eave - ridge) * fraction;
      const floor = ridge + .03 + (eave - ridge) * outer;
      const z = z0 + side * (d/2+.26) * fraction;
      const edge = z0 + side * (d/2+.26) * outer;
      for (let i = 0; i < 13; i++) {
        const x = x0 - w/2 - .25 + (w+.50) * i/13;
        const end = x + (w+.5)/13 - .026;
        const height = .018 + random() * .024;
        const corners = [[x,y+height,z],[x,floor+height,edge],[end,floor+height,edge],[end,y+height,z]];
        if (side < 0) corners.reverse();
        roofTiles.quad(...corners, colors[Math.floor(random()*colors.length)]);
      }
    }
  }
  trim.push(box(w+.56,.088,.145,[x0,ridge+.037,z0],.033));
  building.shape(box(.57,1.55,.56,[x0+1.48,5.90,z0-.63],.025), pigment('#a17c66'));
  building.shape(box(.67,.18,.64,[x0+1.48,6.69,z0-.63],.036), pigment('#72685f'));
  const front = z0 + d/2;
  for (const x of [x0-1.72,x0+1.58]) {
    trim.push(box(.97,.946,.087,[x,4.56,front+.035],.036));
    glazing.push(box(.751,.730,.093,[x,4.56,front+.082],.014));
    trim.push(box(.054,.72,.097,[x,4.56,front+.134],.01));
    trim.push(box(.747,.045,.097,[x,4.56,front+.134],.012));
    trim.push(box(1.03,.085,.148,[x,4.13,front+.094],.018));
  }
  wood.push(box(.89,1.38,.13,[x0,4.18,front+.053],.033));
  trim.push(box(1.034,.092,.20,[x0,3.585,front+.111],.027));
  for (let i = 0; i < 13; i++) {
    const y = 3.72 + i*.122;
    for (let j = 0; j < 15; j++) {
      const x = x0 - 2.71 + j*.373 + (i%2 ? .10 : 0);
      if (Math.abs(x-x0) < .56 || (Math.abs(x-(x0-1.72))<.56 || Math.abs(x-(x0+1.58))<.56) && y>4.02 && y<5.09) continue;
      building.shape(box(.314,.075,.03,[x,y,front+.008],.01), bricks[(i+j*2)%bricks.length]);
    }
  }
  add(building.data, materials.stone, 'Canal keeper brick cottage', 'static');
  add(roofTiles.data, materials.stone, 'Warm terracotta cottage roofing', 'static');
  add(merge(trim), materials.lightTimber, 'Painted cottage joinery', 'static');
  add(merge(wood), materials.iron, 'Cottage timber door', 'static');
  add(merge(glazing), materials.window, 'Smoked cottage window panes');
  for (let i = 0; i < 36; i++) {
    const x=-19.5+39*random();
    const z=-5.4-5.5*random();
    if (Math.abs(x-x0)<3.7 && Math.abs(z-z0)<2.52) continue;
    const w=.2+random()*.58;
    turf.shape(round(w,.05,[x,3.489,z],8), mix(pigment('#726f50'),pigment('#899276'),random()));
  }
  for (const [treeX,treeZ,size] of [[-15.9,-8.3,2.35],[-13.5,-8.9,1.62],[-18.0,-6.9,1.79],[-7.5,-9.8,2.18],[2.7,-8.4,2.39],[19.5,-9.2,1.88]]) {
    turf.shape(round(.065,size*.75,[treeX,3.48+size*.37,treeZ],7), pigment('#5b4b3c'));
    for (let i = 0; i < 7; i++) {
      const angle = 2.4*i;
      const dr = .36*size;
      const radius = size * (.25 - i*.009);
      const x=treeX+Math.sin(angle)*dr*.67;
      const z=treeZ+Math.cos(angle)*dr*.45;
      const y=3.54+size*(.60+random()*.27);
      const leaf= mix(pigment('#596856'),pigment('#879473'),random());
      const k=7;
      for (let j = 0; j < k; j++) {
        const a=j*2*Math.PI/k, b=(j+1)*2*Math.PI/k;
        const left=[x+Math.sin(a)*radius, y, z+Math.cos(a)*radius];
        const right=[x+Math.sin(b)*radius, y, z+Math.cos(b)*radius];
        turf.triangle(left,right,[x+.11,y+radius*1.03,z-.04],leaf);
        turf.triangle(right,left,[x-.04,y-radius*.68,z],mix(leaf,pigment('#56634e'),.43));
      }
    }
  }
  add(turf.data,materials.stone,'Sculpted bankside shrubs and rowan crowns','static');
}

function gate(add, materials, x, side) {
  const lower = x < 0 ? .20 : 1.54;
  const opening = 3.43 - lower;
  const leaf = 2.432;
  const boards = new MeshData();
  const iron = [];
  const pins = [];
  const facing = side > 0 ? 1 : -1;
  for (let i = 0; i < 10; i++) {
    const tint = pigment(i % 3 === 0 ? '#77564b' : i % 3 === 1 ? '#61463c' : '#6e4b42');
    boards.shape(box(leaf/10-.012,opening,.189,[.125+i*leaf/10,opening/2,0],.027),tint);
  }
  for (const y of [.12,.48*opening,opening-.16]) {
    iron.push(box(leaf,.102,.232,[leaf/2,y,0],.024));
    for (let i = 0; i < 8; i++) {
      pins.push(box(.059,.058,.038,[.17+i*.28,y,.130*facing],.010));
    }
  }
  iron.push(round(.168,opening+.19,[0,opening/2,0],16));
  iron.push(box(.11,opening+.076,.235,[leaf-.023,opening/2,0],.024));
  const handle = [];
  handle.push(box(1.39,.132,.158,[.54,opening+.086,0],.038));
  handle.push(round(.109,.045,[0,opening+.163,0],16));
  const objects = [
    add(boards.data,materials.stone,'Miter gate leaf with individually clad timber'),
    add(merge(iron),materials.iron,'Gate hinge seals and wrought bands'),
    add(merge(pins),materials.hardware,'Gate rivet pattern'),
    add(merge(handle),materials.hardware,'Counterweighted operating lever'),
  ];
  return (open) => {
    const closed = Math.asin(width / leaf);
    for (const {root} of objects) {
      root.setPosition([x,lower,side*width]);
      root.setRotation([0,side*(closed*(1-open)+.022*open),0]);
    }
  };
}

function boat(add, materials) {
  const shape = new MeshData();
  const sections = [
    [-3.10,.17,.20],[-2.88,.49,.23],[-2.39,.75,.28],[-1.78,.82,.28], [1.85,.82,.28],[2.43,.68,.30],[2.85,.37,.38],[3.12,.11,.45],
  ];
  const profile = [[-.96,.43],[-1,.22],[-.94,0],[-.64,-.29],[0,-.43],[.64,-.29],[.94,0],[1,.22],[.96,.43]];
  const ring = ([x,w,y]) => profile.map(([z,v]) => [x,v + Math.max(0,v)*y*.26,z*w]);
  for (let i=1;i<sections.length;i++) {
    const a=ring(sections[i-1]), b=ring(sections[i]);
    for (let j=0;j<a.length-1;j++) {
      const tint = j===0 || j===7 ? hullTones[2] : j===1 || j===6 ? hullTones[1] : hullTones[3];
      shape.quad(a[j],b[j],b[j+1],a[j+1],tint);
    }
    shape.quad(a[0],a.at(-1),b.at(-1),b[0],hullTones[0]);
  }
  for (const [i,j] of [[0,-1],[sections.length-1,1]]) {
    const row=ring(sections[i]);
    const center=[sections[i][0],.10,0];
    for (let k=0;k<row.length-1;k++) shape.triangle(row[k],j>0?row[k+1]:center,j>0?center:row[k+1],hullTones[3]);
  }
  const painted = [];
  const shade = [];
  const brass = [];
  const bright = [];
  const roof = [];
  painted.push(box(3.73,.803,1.36,[-.49,.897,0],.085));
  roof.push(box(3.91,.146,1.49,[-.49,1.317,0],.059));
  painted.push(box(.93,.134,1.15,[2.14,.479,0],.041));
  roof.push(box(.28,.116,.73,[2.16,.561,0],.046));
  for (const z of [-.711,.711]) {
    const s = Math.sign(z);
    for (const x of [-1.77,-.97,-.15,.67]) {
      bright.push(box(.500,.46,.057,[x,1.015,z],.035));
      shade.push(box(.405,.363,.059,[x,1.015,z+s*.033],.039));
      bright.push(box(.031,.371,.069,[x,1.016,z+s*.057],.012));
    }
    brass.push(box(3.38,.024,.036,[-.52,.56,z+s*.02],.009));
  }
  for (const x of [-2.84,2.78]) {
    shade.push(round(.082,.20,[x,.58,0],12));
    brass.push(round(.12,.048,[x,.69,0],14));
  }
  shade.push(round(.073,.328,[-1.82,1.53,-.39],20));
  brass.push(round(.090,.048,[-1.82,1.706,-.39],20));
  const sectionsOut = [
    add(shape.data,materials.stone,'Welded narrowboat hull, sealed bow and stern'),
    add(merge(painted),materials.iron,'Bristol green narrowboat cabin'),
    add(merge(roof),materials.coach,'"Coach roof and foredeck hatch'),
    add(merge(bright),materials.lightTimber,'Painted narrowboat window casings'),
    add(merge(shade),materials.window,'Window glazing and narrowboat flue'),
    add(merge(brass),materials.hardware,'Narrowboat trim and mooring cleats'),
  ];
  return (x,y) => {
    for (const {root} of sectionsOut) root.setPosition([x,y,0]);
  };
}

function water(add, materials) {
  const nearLip = new MeshData();
  const bottom = -.092;
  const outline = pigment('#41656a');
  const light = pigment('#4c787a');
  nearLip.quad([-1,0,width], [1,0,width], [1,1,width],[-1,1,width], outline);
  const cross = add(nearLip.data,materials.waterCut,'Water prism cutaway face');
  const ranges = [[-length,-station],[-station,station],[station,length]];
  const heights = [chamber.lower,chamber.lower,chamber.upper];
  const levels = ranges.map(([a,b], i) => {
    const result = add(waterSurface(a,b,width,9321+i*123),materials.water,'Water reach with finite open boundaries');
    result.root.setPosition([0,heights[i],0]);
    const lip = add(box(b-a,.010,.033,[(a+b)/2,0,width]), materials.wave,'Exposed meniscus line');
    lip.root.setPosition([0,heights[i]+.007,0]);
    return {result,lip};
  });
  const front = new MeshData();
  for (const [i,[a,b]] of [ranges[0],ranges[2]].entries()) {
    const current = i === 0 ? chamber.lower : chamber.upper;
    front.quad([a,bottom,width],[b,bottom,width],[b,current,width],[a,current,width],mix(outline,light,.12+i*.15));
  }
  add(front.data,materials.waterCut,'Permanent water section in the outer reaches');
  cross.root.setPosition([0,bottom,0]);
  const ripples = (from, to, count, random) => {
    const marks = new MeshData();
    for (let i=0;i<count;i++) {
      const x=from+.48+random()*(to-from-.96);
      const z=(random()-.50)*4.34;
      const size=.05+random()**1.3*.41;
      const y=.019;
      marks.quad([x-size,y,z],[x-size*.34,y,z+.039],[x+size,y,z+.014],[x+size*.42,y,z-.019],
        mix(pigment('#587f80'),pigment('#94b1ad'),.14+.33*random()));
    }
    return marks.data;
  };
  const random = rng(48072);
  const licks=add(ripples(-station,station,105,random),materials.wave,'Waterline highlights in the moving chamber');
  const lowerRipple=add(ripples(-length,-station,54,random),materials.wave,'Quiet lower reach ripples');
  const upperRipple=add(ripples(station,length,57,random),materials.wave,'Quiet upper reach ripples');
  lowerRipple.root.setPosition([0,chamber.lower,0]);
  upperRipple.root.setPosition([0,chamber.upper,0]);
  const flowMarkers=Array.from({length:13}, () => add(box(.28,.011,.063,[0,0,0],.008),materials.flow,'Culvert flow trace'));
  return (model,now) => {
    levels[1].result.root.setPosition([0,model.level,0]);
    levels[1].lip.root.setPosition([0,model.level+.007,0]);
    cross.root.setScale([station,model.level-bottom,1]);
    licks.root.setPosition([0,model.level,0]);
    for (const [i,marker] of flowMarkers.entries()) {
      const advance=(now*.68 + i*.21)%1;
      const x=-7.8 + 15.6*((i*.618033+.15)%1);
      const z=model.flow > 0 ? -2.045+advance*1.62 : -.43-advance*1.62;
      marker.root.setPosition([x + .38 * advance,model.flow ? model.level+.027 : -300,z]);
      marker.root.setScale([Math.max(.19,Math.abs(model.flow)/4.2),1,1]);
      marker.root.setRotation([0,-.59,0]);
    }
  };
}

export function buildLock(engine, shadows) {
  const materials = {
    sweep: new Material({color:'#e8e4d7',roughness:.91}),
    stone: new Material({color:'#ece7de',roughness:.83}),
    base: new Material({color:'#414848',roughness:.62}),
    cut: new Material({color:'#837a68',roughness:.78}),
    iron: new Material({color:'#344f4a',roughness:.54}),
    engrave: new Material({color:'#a78761',roughness:.39}),
    hardware: new Material({color:paint,roughness:.51}),
    coach: new Material({color:'#ded6b2',roughness:.66}),
    lightTimber: new Material({color:'#c8bba2',roughness:.67}),
    window: new Material({color:'#344d56',roughness:.31}),
    culvert: new Material({color:'#4f7269',roughness:.68}),
    waterCut: new Material({color:'#afc6c2',roughness:.79}),
    water: new Material({color:'#ccdcd0',roughness:.28,metalness:.02}),
    wave: new Material({color:'#789a99',roughness:.44}),
    flow: new Material({color:'#91c2b0',roughness:.41,emissive:'#71a08b',emissiveIntensity:.22}),
  };
  const owned = [];
  const add = (geometry,material,name,role) => {
    const mesh = createMesh(engine,geometry,material);
    mesh.root.name = name;
    owned.push(mesh);
    if (role === 'static') shadows.add(mesh,{static:true});
    if (role === 'receive') shadows.add(mesh,{static:true,castShadow:false});
    return mesh;
  };
  mason(add,materials);
  roof(add,materials);
  const gates = [-station, station].flatMap(x => [-1, 1].map(side => gate(add, materials, x, side)));
  const navigate = boat(add,materials);
  const adjustWater=water(add,materials);
  return {
    update(model,seconds) {
      gates[0](model.lowerGate);
      gates[1](model.lowerGate);
      gates[2](model.upperGate);
      gates[3](model.upperGate);
      navigate(model.boat,model.level);
      adjustWater(model,seconds);
    },
    dispose() {
      for (const mesh of owned.reverse()) mesh.dispose();
      for (const material of Object.values(materials)) material.dispose();
    },
  };
}