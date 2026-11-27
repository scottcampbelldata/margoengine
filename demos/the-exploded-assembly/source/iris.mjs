const tau=2*Math.PI;
export const leaves=8;
export const styles={
  frame:{color:'#25545f',roughness:.39,metalness:0},
  outer:{color:'#386d78',roughness:.34,metalness:0},
  bronze:{color:'#aa774b',roughness:.32,metalness:.58},
  steel:{color:'#7e9698',roughness:.34,metalness:.34},
  blade:{color:'#7b9ca0',roughness:.48,metalness:.14},
  pin:{color:'#9c8d77',roughness:.37,metalness:.40},
};
const ring=(outer,inner,height,bevel)=>({outer,inner,height,bevel});
export const profiles=[
  {id:'mount',label:'Bayonet mount',style:'frame',shape:ring(.061,.045,.009,.0014),origin:[0,-.020,0],offset:[0,-.033,0]},
  {id:'carrier',label:'Leaf carrier',style:'steel',shape:ring(.055,.0325,.005,.0009),origin:[0,-.0108,0],offset:[0,-.016,0]},
  {id:'racer',label:'Cam ring',style:'bronze',shape:ring(.053,.0352,.004,.0007),origin:[0,.0032,0],offset:[0,.035,0]},
  {id:'washer',label:'Thrust washer',style:'steel',shape:ring(.056,.040,.0032,.00062),origin:[0,.0076,0],offset:[0,.060,0]},
  {id:'housing',label:'Retaining housing',style:'outer',shape:ring(.064,.046,.0088,.0018),origin:[0,.012,0],offset:[0,.094,0]},
  {id:'bezel',label:'Front bezel',style:'frame',shape:ring(.060,.039,.0042,.0008),origin:[0,.022,0],offset:[0,.123,0]},
];
const angular=(angle,length)=>[Math.cos(angle)*length,0,Math.sin(angle)*length];
export const parts=[
  ...profiles,
  ...Array.from({length:leaves},(_,i)=>{
    const angle=i*tau/leaves;
    const across=angular(angle+.21,.031);
    return {id:'leaf',label:'Iris leaf '+(i+1),style:'blade',angle,origin:[0,-.0017+i*.00024,0],
      offset:[across[0],.018+i*.0018,across[2]]};
  }),
  ...Array.from({length:leaves},(_,i)=>{
    const angle=i*tau/leaves;
    const at=angular(angle-.34,.0446), slide=angular(angle+.21,.036);
    return {id:'drive-pin',label:'Leaf pin '+(i+1),style:'pin',origin:[at[0],-.0015+i*.00024,at[2]],
      offset:[slide[0],.036+i*.0018,slide[2]]};
  }),
];
export const fullSpread=Math.max(...parts.map(p=>p.offset[1]))-Math.min(...parts.map(p=>p.offset[1]));
