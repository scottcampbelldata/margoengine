import { Surface, lathe, material, noiseGenerator } from './mesh.js';

const base=[1.68,.10,-.45];
const trunk=material('#675141',.89);
const greens=[
  {surface:'#63743b',pass:[.10,.38,.034]},
  {surface:'#7a8c47',pass:[.13,.48,.046]},
  {surface:'#4b743b',pass:[.064,.29,.026]},
  {surface:'#9a9b4d',pass:[.16,.52,.064]},
];
const vase=material('#74665f',.53), lip=material('#a38b79',.51);
const clay=lathe([[0,.38],[.035,.41],[.07,.418],[.62,.505],[.68,.515],[.72,.491],[.73,.47],[.69,.446],[.57,.43]],40);
const soil=lathe([[0,0],[.006,.42],[.018,.444]],36);
const ring=lathe([[0,.416],[.020,.425],[.041,.438],[.047,.436]],44);
const chart=[
  [0,0],[-.07,.26],[-.39,.19],[-.32,.44],[-.77,.48],[-.45,.68],[-.57,.93],
  [-.22,.78],[0,1.20],[.225,.77],[.56,.92],[.45,.68],[.77,.47],[.32,.43],[.39,.19],[.07,.26],
];

function leaf(geometry,center,length,angle,roll) {
  const side=[Math.cos(angle),0,Math.sin(angle)], forward=[-Math.sin(angle)*.78,.625*Math.sin(roll),Math.cos(angle)*.78];
  const tip=([x,y])=>[center[0]+length*(side[0]*x+forward[0]*y),center[1]+length*(forward[1]*y-.20*x*x+.21*y*(1-y)),
    center[2]+length*(side[2]*x+forward[2]*y)];
  const ridge=tip([0,.55]);
  ridge[1]+=.033*length;
  const ring=chart.map(tip);
  for(let i=0;i<ring.length;i++)geometry.face(ridge,ring[i],ring[(i+1)%ring.length]);
}

export function buildMaple({mesh},opaque){
  const twig=new Surface(), blades=greens.map(()=>new Surface()), random=noiseGenerator(20280918);
  const at=([x,y,z])=>[x+base[0],y+base[1],z+base[2]];
  const branches=[
    [[0,.64,0],[.07,1.35,.04],[-.06,2.08,0],[-.21,2.87,-.14],[-.46,3.15,-.24]],
    [[-.085,1.46,.02],[-.34,1.92,.15],[-.81,2.19,.16],[-1.13,2.45,.43]],
    [[.022,1.51,.05],[.43,1.88,.17],[.77,2.17,.33],[1.02,2.34,.41]],
    [[-.06,1.78,.024],[.25,2.17,-.26],[.62,2.43,-.61],[.85,2.67,-.83]],
    [[-.12,2.25,-.041],[-.44,2.56,-.24],[-.83,2.82,-.57],[-1.02,2.88,-.73]],
    [[-.06,1.99,.043],[-.43,2.24,.31],[-.54,2.57,.64],[-.77,2.82,.80]],
    [[-.15,2.58,-.10],[.20,2.72,.16],[.46,2.96,.49],[.66,3.04,.61]],
    [[.044,1.35,.03],[.08,1.64,-.45],[-.16,1.88,-.72],[-.28,2.12,-.91]],
    [[-.16,2.65,-.11],[.05,2.93,-.31],[.15,3.18,-.40],[.30,3.28,-.44]],
    [[-.06,1.70,.06],[-.31,1.83,.36],[-.39,2.01,.61],[-.55,2.20,.82]],
    [[.038,1.46,.04],[.41,1.47,-.22],[.84,1.68,-.26],[.91,1.94,-.30]],
    [[.01,1.59,.04],[.21,1.74,.41],[.37,2.00,.71],[.52,2.04,.90]],
  ];
  branches.forEach((flight,index)=>{
    const main=index===0, stages=flight.length-1;
    for(let i=0;i<stages;i++){
      const f=1-i/stages, width=main?.065:.025;
      twig.cylinder(at(flight[i]),at(flight[i+1]),width*f+.002,width*(1-(i+1)/stages)+.001,main?11:8);
    }
    const target=flight.at(-1), lead=flight.at(-2);
    for(let i=0;i<8;i++){
      const p=.32+.68*random(), spread=i%2===0?1:-1;
      const off=(.05+.24*random())*spread;
      const node=lead.map((x,j)=>x+p*(target[j]-x));
      const end=[node[0]+off,node[1]+.02+.10*random(),node[2]+(random()-.47)*.45];
      twig.cylinder(at(node),at(end),.0039,.0013,6);
      for(let k=0;k<3;k++){
        const rotate=random()*Math.PI*2;
        const center=at([end[0]+(.075+.062*k)*Math.cos(rotate),end[1]+.042*k,end[2]+(.092+.045*k)*Math.sin(rotate)]);
        const tone=(index+i+k)%greens.length;
        leaf(blades[tone],center,.087+.087*random(),rotate,3.4*random()-1.7);
      }
    }
  });
  opaque.push(mesh('Hand-thrown maple vessel',clay,vase,base));
  opaque.push(mesh('Pot topsoil',soil,material('#484033',.99),at([0,.603,0])));
  mesh('Slip-cast top collar',ring,lip,at([0,.650,0]),[1.16,1.4,1.16]);
  opaque.push(mesh('Tapered trunk and woody stems',twig.geometry(),trunk));
  return blades.map((geometry,i)=>{
    const spec=greens[i];
    return {part:mesh('Thin lobed maple leaves '+(i+1),geometry.geometry(),material(spec.surface,.81)),pass:spec.pass};
  });
}
