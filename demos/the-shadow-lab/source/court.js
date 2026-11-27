import { Surface, lathe, material, noiseGenerator, workshop } from './mesh.js';
import { buildGlass } from './stained-glass.js';
import { buildMaple } from './maple.js';

const limestone=material('#cec1ab',.88);
const faces=['#c0b098','#c9baaa','#cabaa4','#c4b39b','#c4b7a3'].map(c=>material(c,.86));
const mortar=material('#70615e',.91);
const edge=material('#918479',.69);
const dark=material('#57514c',.74);
const bronze=material('#9b775c',.44,.27);
const brass=material('#c3976a',.47,.19);
const black=material('#51504a',.59);
const earth=material('#363c4a',.88);
const cedar=material('#6c5147',.74);
const pin=lathe([[0,0],[.001,.017],[.015,.021],[.026,.016],[.029,.007]],14);

function buildFins(kit,opaque){
  const {mesh,beam}=kit, r=new Surface();
  const x=-2.45,z=.96;
  opaque.push(beam('Oxidized baffle foot',dark,x,.152,z,1.80,.205,.59));
  opaque.push(beam('Machine plate',brass,x,.26,z,1.76,.041,.53));
  for (const side of [-1,1]) {
    opaque.push(beam('Calibration fin support',bronze,x+side*.78,.54,z,.070,.60,.104));
    for(const p of [-.205,.205])mesh('Baffle shoulder fastener',pin,black,[x+side*.75,.281,z+p]);
  }
  for(let fin=0;fin<9;fin++){
    const y=.55+fin*.171, p=fin/8, x0=x-.77+p*.14, x1=x+.80-p*p*.36, z0=z-.18+.132*p, z1=z+.19-.10*p;
    const plate=beam('Folded test fin '+fin,fin%3===0?brass:bronze,(x0+x1)/2,y,(z0+z1)/2,x1-x0,.038,z1-z0);
    plate.setRotation([-.04-.18*p,0,-.075*p]);
    opaque.push(plate);
  }
  r.cylinder([x-.77,.45,z],[x-.66,1.88,z],.040,.032,10);
  r.cylinder([x+.78,.45,z],[x+.45,1.94,z],.040,.027,10);
  opaque.push(mesh('Sloped welded baffle spines',r.geometry(),black));
}

export function buildCourt(engine){
  const kit=workshop(engine), {beam}=kit, opaque=[];
  beam('Court grounding plane',earth,0,-.322,0,188,.20,188);
  beam('Limestone base',edge,0,-.097,.46,9.94,.26,7.5);
  beam('Perimeter mortared bed',mortar,0,.044,.46,9.83,.078,7.39);
  const random=noiseGenerator(1321741), rows=10, cols=14;
  for(let i=0;i<rows;i++)for(let j=0;j<cols;j++){
    const sizeX=9.79/cols,sizeZ=7.33/rows;
    beam('Honed limestone slab',faces[Math.floor(random()*faces.length)],(j+.5-cols/2)*sizeX,.108,.46+(i+.5-rows/2)*sizeZ,sizeX-.009,.065,sizeZ-.008);
  }
  beam('Front limestone apron',limestone,0,-.044,4.22,9.96,.25,.17);
  beam('Front apron joint',mortar,0,-.101,4.317,9.86,.011,.015);
  beam('Rear apron curb',limestone,0,.339,-3.05,9.84,.39,.38);
  beam('Rear apron coping',edge,0,.557,-3.05,9.90,.059,.435);
  for(const side of [-1,1]){
    beam('Raised perimeter reveal',edge,side*4.882,.252,.31,.14,.21,6.65);
    for(let i=0;i<4;i++){
      const z=-2.87+i*2.05;
      beam('Corner pier shoe',dark,side*4.878,.238,z,.205,.138,.186);
    }
  }
  for(let i=0;i<8;i++){
    const y=.66+i*.079;
    beam('Screening oak louver',cedar,2.25,y,-2.91,2.87,.041,.112);
  }
  for(const x of [.87,3.63]){
    opaque.push(beam('Screen end post',dark,x,.757,-2.92,.11,.93,.13));
  }
  for(let i=0;i<6;i++){
    const z=3.08+i*.104;
    beam('Bench oiled cedar slat',cedar,2.56,.535,z,2.23,.064,.082);
  }
  for(const x of [1.67,3.43])opaque.push(beam('Bench terrazzo support',edge,x,.330,3.34,.232,.37,.60));
  buildFins(kit,opaque);
  const glass=buildGlass(kit,opaque);
  const leaves=buildMaple(kit,opaque);
  return {opaque,glass,leaves};
}
