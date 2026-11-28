import { Surface, material } from './mesh.js';

const z=-1.94;
const cx=-1.77, cy=2.32;
const shades=[
  {color:'#df9a37',pass:[.88,.46,.11]},
  {color:'#e17a43',pass:[.88,.23,.062]},
  {color:'#ba534c',pass:[.71,.091,.11]},
  {color:'#a04762',pass:[.51,.055,.23]},
  {color:'#4b77b0',pass:[.072,.26,.71]},
  {color:'#4d9caa',pass:[.095,.52,.69]},
  {color:'#668f83',pass:[.18,.47,.34]},
  {color:'#d7c082',pass:[.78,.64,.27]},
];
const brass=material('#81694b',.42,.22);
const lead=material('#3d4342',.63,.18);
const oak=material('#59443b',.77);

function location(r,angle,depth=z){
  return [cx+r*Math.cos(angle),cy+r*Math.sin(angle),depth];
}
function panel(surface,r0,r1,a,b){
  const corners=[location(r0,a,z+.010),location(r1,a,z+.010),location(r1,b,z+.010),location(r0,b,z+.010)];
  const opposite=corners.map(([x,y])=>[x,y,z-.010]);
  surface.face(...corners);
  surface.face(...opposite.toReversed());
  for(let i=0;i<4;i++){
    const j=(i+1)%4;
    surface.face(corners[j],corners[i],opposite[i],opposite[j]);
  }
}

export function buildGlass({mesh,beam},opaque){
  const groups=shades.map(()=>new Surface());
  const rim=new Surface(), solder=new Surface();
  const centre=.185, radii=[centre,.54,.90,1.325], sectors=16;
  for(let sector=0;sector<sectors;sector++){
    const a=sector*Math.PI*2/sectors, b=(sector+1)*Math.PI*2/sectors;
    for(let band=0;band<3;band++){
      const radial=radii[band], tip=radii[band+1], spread=.014/(radial+.13);
      const tone=(Math.floor(sector/2)+[0,2,3][band])%shades.length;
      panel(groups[tone],radial+.008,tip-.008,a+spread,b-spread);
      const [u,v]=[location(radial,a),location(radial,b)];
      solder.cylinder(u,v,.0125,.0125,6);
    }
    for(let j=0;j<3;j++){
      const a1=a+(b-a)*j/3, b1=a+(b-a)*(j+1)/3;
      for(const radius of [1.367,1.405]){
        const u=location(radius,a1,z+.022), v=location(radius,b1,z+.022);
        rim.cylinder(u,v,radius<1.39?.045:.031,radius<1.39?.045:.031,8);
      }
    }
    solder.cylinder(location(centre,a),location(1.35,a),.016,.017,7);
  }
  const central=new Surface();
  central.cylinder([cx,cy,z-.031],[cx,cy,z+.031],centre,centre,38);
  opaque.push(mesh('Bronze central boss',central.geometry(),brass));
  opaque.push(mesh('Spiral copper surround',rim.geometry(),brass));
  opaque.push(mesh('Cast came and concentric joints',solder.geometry(),lead));
  for(const x of [cx-1.41,cx+1.41]){
    opaque.push(beam('Tall bronze mullion',brass,x,1.82,z,.100,3.58,.110));
    opaque.push(beam('Wall-screen pedestal foot',oak,x,.16,z,.344,.22,.53));
    beam('Mullion foot collar',lead,x,.31,z,.157,.09,.165);
  }
  opaque.push(beam('Screen header',brass,cx,3.72,z,2.97,.076,.101));
  const glass=groups.map((group,i)=>{
    const spec=shades[i], part=mesh('Hand-cut colored glass '+(i+1),group.geometry(),material(spec.color,.37));
    part.receiveShadow=false;
    return { part, pass:spec.pass.map(Math.sqrt), clear:[.955,.955,.955] };
  });
  return glass;
}
