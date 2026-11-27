import { sphereGeometry } from '@margoengine/geometry';

const clamp=(x)=>Math.min(1,Math.max(0,x));
const mix=(a,b,t)=>a.map((v,i)=>v+(b[i]-v)*clamp(t));
const rad=180/Math.PI;
const coastlines=[
  // Painted major land masses on the instrument globe.
  [[-168,66],[-137,59],[-128,50],[-119,34],[-105,21],[-89,18],[-83,22],[-90,30],[-81,29],[-74,43],[-57,49],[-61,60],[-92,78],[-132,71]],
  [[-81,10],[-69,13],[-53,6],[-35,-7],[-47,-24],[-64,-56],[-74,-48],[-72,-22],[-81,-7]],
  [[-18,16],[-10,32],[12,37],[35,32],[44,13],[51,10],[42,-14],[30,-34],[18,-35],[9,-22],[-2,5],[-15,5]],
  [[-10,36],[-9,45],[9,57],[9,69],[35,70],[60,74],[97,79],[149,70],[170,65],[151,53],[143,43],[122,31],[109,17],[106,3],[99,10],[92,23],[81,8],[74,14],[69,25],[56,27],[49,13],[36,18],[36,29],[32,45],[20,40],[17,47],[2,44]],
  [[113,-22],[114,-31],[125,-35],[140,-37],[152,-28],[149,-15],[143,-11],[138,-19],[125,-14]],
  [[-73,61],[-42,60],[-22,72],[-22,80],[-47,84],[-64,80]],
  [[47,-12],[51,-18],[48,-25],[43,-24],[44,-16]],
  [[130,31],[138,35],[144,44],[140,46],[136,39],[130,33]],
];

function inside(poly,x,y) {
  let hit=false;
  for(let i=0,j=poly.length-1;i<poly.length;j=i++) {
    const [ax,ay]=poly[i],[bx,by]=poly[j];
    if((ay>y)!==(by>y) && x<(bx-ax)*(y-ay)/(by-ay)+ax) hit=!hit;
  }
  return hit;
}

const grain=(x,y,z)=>.50+.17*Math.sin(19*x+17*y+12*z)*Math.sin(13*y-21*z)
  +.13*Math.cos(31*x-25*y+14*z)*Math.sin(21*x+11*z)
  +.20*Math.sin(8*x+3*y)*Math.cos(10*y+2*z);

const carves=[
  [-.60,.35,.719,.17],[.19,.615,-.765,.12],[.661,.16,.733,.16],
  [-.06,-.70,.711,.22],[.331,-.38,-.864,.14],[-.052,.77,.635,.14],
  [-.288,-.454,-.843,.14],[.39,.44,.81,.10],[-.78,-.35,.52,.09],
];

function globeColor(id,x,y,z) {
  const pattern=grain(x,y,z);
  switch(id) {
    case 'earth': {
      const lat=Math.asin(y)*rad;
      const shift=Math.atan2(-z,x)*rad+100;
      const longitude=((shift+540)%360)-180;
      const land=coastlines.some((coast)=>inside(coast,longitude,lat));
      const ocean=mix([.024,.125,.22],[.071,.42,.66],pattern);
      const soil=mix([.079,.238,.161],[.49,.50,.23],pattern*.93);
      const frost=Math.max(clamp((Math.abs(lat)-67)/16),clamp((pattern-.73)*2.5)*.44);
      return mix(land?soil:ocean,[.76,.85,.81],frost);
    }
    case 'venus': {
      const stripe=.54+.30*Math.sin(14*y+1.6*Math.sin(4*z-3*x)+.8*Math.sin(11*x));
      return mix([.41,.276,.146],[.94,.79,.48],(stripe+pattern)*.55);
    }
    case 'mars': {
      const rock=.55*pattern+.23+.21*Math.sin(4*x+5*y)*Math.cos(5*z-2*y);
      const iron=mix([.33,.071,.041],[.91,.46,.223],rock);
      return mix(iron,[.73,.67,.53],clamp((Math.abs(y)-.88)*7));
    }
    case 'mercury': {
      let value=pattern;
      for(const [a,b,c,r] of carves) {
        const d=Math.hypot(x-a,y-b,z-c)/r;
        value+=clamp(1-d)*-.32+clamp(1-Math.abs(d-1)*5)*.16;
      }
      return mix([.156,.163,.168],[.66,.65,.60],value);
    }
    default: {
      const swirl=.61+.25*Math.sin(12*y+1.8*Math.sin(4*x-6*z)+2.2*pattern);
      return mix([.58,.22,.044],[1,.78,.33],clamp(swirl+.30*pattern));
    }
  }
}

export function paintedGlobe(id,radius) {
  const mesh=sphereGeometry(radius,id==='earth'?64:48,id==='earth'?40:32);
  const colors=new Float32Array(mesh.positions.length);
  for(let i=0;i<mesh.positions.length;i+=3) {
    const [x,y,z]=mesh.normals.subarray(i,i+3);
    colors.set(globeColor(id,x,Math.min(1,Math.max(-1,y)),z),i);
  }
  return {...mesh,colors};
}
