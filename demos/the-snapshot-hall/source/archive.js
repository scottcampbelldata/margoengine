import {panel,cylinder,arch,medallion} from './shapes.js';

const bases={stone:panel(0),edge:panel(.038),pipe:cylinder(22),post:cylinder(60,1),arch:arch(),disc:medallion()};
const parts=Object.fromEntries(Object.keys(bases).map(name=>[name,[]]));
const rgba=hex=>[0,2,4].map(i=>parseInt(hex.slice(i,i+2),16)/255);
const weather=(rgb,k)=>rgb.map(c=>c*k);
const P={
  slate:rgba('48494c'),silver:rgba('5d5852'),warmstone:rgba('73675d'),blue:rgba('425762'),
  dark:rgba('252226'),oak:rgba('6c432e'),brown:rgba('8d5436'),mahogany:rgba('563333'),
  brass:rgba('a17a43'),steel:rgba('53676e'),white:rgba('c8af85'),lamp:rgba('ffce8d'),
  teal:rgba('507582'),azure:rgba('63a5ac'),ivory:rgba('b9af86'),rug:rgba('704d46'),
};
function place(kind,p,scale,color,finish=0,yaw=0){
  parts[kind].push(...p,...scale,Math.sin(yaw),Math.cos(yaw),finish,...color);
}
const block=(p,s,color,finish=0)=>place('stone',p,s,color,finish);
const bevel=(p,s,color,finish=0)=>place('edge',p,s,color,finish);
const rod=(p,s,color,finish=1)=>place('pipe',p,s,color,finish);
const arc=(p,s,color,finish=0)=>place('arch',p,s,color,finish);
const face=(p,s,color,finish=1)=>place('disc',p,s,color,finish);

function floor(){
  const length=38.3;
  block([0,-.147,-12.9],[10.8,.22,length+1.6],P.dark);
  for(let row=0;row<30;row++)for(let col=0;col<10;col++){
    const k=(col+row)%3;
    const x=(col-4.5)*1.03,z=5.9-row*1.27;
    block([x,-.021,z],[1.014,.069,1.254],k===0?P.silver:k===1?P.slate:P.warmstone);
  }
  block([0,.021,-12.7],[2.33,.012,37.0],P.rug,6);
  for(const x of [-1.13,-1.05,1.05,1.13]){
    block([x,.028,-12.7],[.018,.004,36.96],P.brass,1);
  }
  for(let i=0;i<32;i++){
    const z=5.22-i*1.16;
    rod([0,.029,z],[.184,.003,.184],weather(P.brass,.79),1);
    bevel([0,.029,z],[1.92,.006,.016],weather(P.brass,.72),1);
  }
}

function shell(){
  for(const side of [-1,1]){
    block([side*4.99,2.12,-12.4],[.37,4.64,39.0],P.dark);
    bevel([side*4.59,3.52,-12.4],[.98,.19,39.0],P.oak,2);
    bevel([side*4.63,3.78,-12.4],[.79,.112,39.0],P.brass,1);
    bevel([side*4.71,.182,-12.4],[.48,.31,39.0],P.mahogany,2);
  }
  for(let bay=0;bay<=10;bay++){
    const z=5.35-bay*3.39;
    arc([0,3.70,z-1.68],[4.91,3.17,3.405],weather(P.blue,1-(bay%3)*.06));
    arc([0,3.65,z],[4.94,3.18,.245],P.oak,2);
    arc([0,3.58,z+.103],[4.88,3.16,.055],P.brass,1);
    arc([0,3.59,z-.102],[4.88,3.16,.052],P.brass,1);
    const inlay=weather(P.steel,.83+(bay%4)*.06);
    for(let band=1;band<=3;band++){
      arc([0,3.698,z-band*.847],[4.774,3.077,.034],inlay,1);
    }
    for(let k=0;k<12;k++){
      const theta=(k+.5)*Math.PI/12;
      const x=4.79*Math.cos(theta),y=3.69+3.065*Math.sin(theta);
      const cross=[.011+.021*Math.abs(Math.cos(theta)),.012+.021*Math.sin(theta),3.16];
      block([x,y,z-1.724],cross,weather(P.steel,.93),1);
    }
    if(bay===0||bay===3||bay===6||bay===9){
      const pendant=z-1.28;
      rod([0,5.84,pendant],[.041,1.61,.041],P.steel);
      rod([0,5.081,pendant],[.42,.053,.42],P.brass);
      rod([0,4.954,pendant],[.30,.203,.30],P.lamp,4);
      rod([0,4.840,pendant],[.225,.029,.225],P.brass);
    }
    if(bay===10)continue;
    for(const side of [-1,1]){
      const x=side*3.99;
      place('post',[x,1.83,z],[.22,3.38,.22],P.oak,2);
      rod([x,.16,z],[.39,.30,.39],P.mahogany,2);
      rod([x,.337,z],[.30,.048,.30],P.brass);
      rod([x,3.50,z],[.41,.16,.39],P.mahogany,2);
      rod([x,3.59,z],[.44,.064,.42],P.brass);
      bevel([side*3.70,3.10,z],[.20,.32,.25],P.mahogany,2);
      rod([side*3.64,2.94,z],[.107,.39,.107],P.brass);
      rod([side*3.59,3.015,z],[.168,.196,.172],P.lamp,4);
      rod([side*3.596,3.124,z],[.196,.031,.195],P.brass);
      rod([side*3.596,2.902,z],[.185,.035,.182],P.brass);
    }
  }
}

function archive(){
  for(let bay=0;bay<10;bay++){
    const base=3.655-bay*3.39;
    for(const side of [-1,1]){
      const x=side*4.27;
      bevel([x,1.713,base],[.68,3.22,2.925],P.mahogany,2);
      bevel([side*3.93,.245,base],[.234,.24,2.95],P.dark);
      bevel([side*3.95,3.323,base],[.26,.127,3.01],P.oak,2);
      bevel([side*3.81,3.335,base],[.031,.031,2.94],P.brass,1);
      for(const a of [-1,1]){
        bevel([side*3.878,1.74,base+a*1.441],[.111,2.961,.106],P.mahogany,2);
        bevel([side*3.81,1.74,base+a*1.455],[.013,2.955,.014],P.brass,1);
      }
      for(let row=0;row<9;row++){
        const y=.580+row*.305;
        for(let col=0;col<6;col++){
          const z=base+(col-2.5)*.452;
          const shade=.79+.19*((17*bay+11*row+7*col+(side+1)*3)%9)/8;
          const pigment=weather((row*7+col+bay)%6===0?P.brown:P.oak,shade);
          bevel([side*3.868,y,z],[.135,.267,.407],pigment,2);
          bevel([side*3.790,y+.049,z],[.022,.066,.126],P.brass,1);
          block([side*3.776,y+.049,z],[.007,.041,.087],weather(P.white,.91),3);
          bevel([side*3.768,y-.039,z],[.064,.023,.126],P.brass,1);
        }
      }
      for(let row=0;row<=3;row++)bevel([side*3.78,.442+row*.915,base],[.012,.014,2.775],P.brass,1);
    }
  }
}

function endWall(){
  const z=-29.66;
  block([0,3.5,z-.48],[10.4,7.19,.47],P.blue);
  for(const side of [-1,1]){
    bevel([side*2.58,2.75,z],[.21,5.34,.279],P.mahogany,2);
    bevel([side*2.83,2.76,z+.04],[.048,5.28,.128],P.brass,1);
    bevel([side*3.45,2.57,z-.11],[.84,4.90,.14],P.slate);
    for(let i=0;i<5;i++)bevel([side*(3.17+i*.14),2.57,z+.02],[.021,4.798,.05],P.steel,1);
  }
  const y=2.83;
  face([0,y,z+.11],[3.90,3.90,.18],P.dark);
  face([0,y,z+.23],[3.70,3.70,.18],P.brass,1);
  face([0,y,z+.334],[3.575,3.575,.122],P.steel,1);
  face([0,y,z+.402],[3.425,3.425,.106],P.teal,5);
  face([0,y,z+.466],[2.892,2.892,.084],P.azure,5);
  face([0,y,z+.516],[1.618,1.618,.063],P.steel,1);
  face([0,y,z+.554],[.818,.818,.057],P.white,4);
  for(let k=0;k<12;k++){
    const t=k*Math.PI/6,x=Math.cos(t),h=Math.sin(t);
    face([1.23*x,y+1.23*h,z+.564],[.219,.219,.058],P.brass,1);
    face([1.23*x,y+1.23*h,z+.600],[.139,.139,.035],P.lamp,4);
    face([1.535*x,y+1.535*h,z+.499],[.073,.073,.054],P.ivory,4);
  }
  bevel([0,.245,z+.48],[3.67,.17,1.03],P.brown,2);
  for(let i=0;i<4;i++)bevel([0,.07+i*.077,z+.89-i*.19],[4.02-i*.14,.075,.38],P.steel);
}

export function makeHall(){
  for(const list of Object.values(parts))list.length=0;
  floor();shell();archive();endWall();
  const vertices=[],index=[],instances=[],ranges=[];
  for(const [name,{data,indices}] of Object.entries(bases)){
    const first=index.length,base=vertices.length/6,start=instances.length/12,items=parts[name];
    vertices.push(...data);
    for(const i of indices)index.push(base+i);
    for(const x of items)instances.push(x);
    const count=items.length/12;
    ranges.push({first,length:indices.length,start,count});
  }
  return {vertices:new Float32Array(vertices),indices:new Uint32Array(index),
    instances:new Float32Array(instances),ranges,parts:instances.length/12,
    triangles:ranges.reduce((sum,{length,count})=>sum+length*count/3,0)};
}
