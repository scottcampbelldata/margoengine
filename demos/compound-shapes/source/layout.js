const z90=[Math.sin(Math.PI/4),0,0,Math.cos(Math.PI/4)];
const boxPart=(name,offset,half,finish)=>({name,shape:'box',offset,halfExtents:half,finish});
const cylinder=(name,offset,radius,halfHeight,finish,rotation)=>({name,shape:'cylinder',offset,radius,halfHeight,finish,rotation});
const sphere=(name,offset,radius,finish)=>({name,shape:'sphere',offset,radius,finish});
const spin=(angle)=>[0,0,Math.sin(angle/2),Math.cos(angle/2)];

export const fixed=1/60;
export const deck={size:[2.36,.10,2.15],position:[0,-.05,0]};
export const ramp={size:[2.14,.065,1.23],position:[0,.153,-.40],angle:.235};
export const specimens=[
  {
    id:'fork',label:'Fork',density:2700,position:[-.58,.945,-.53],rotation:spin(.21),
    parts:[
      boxPart('Crossbar',[0,-.145,0],[.320,.037,.054],'teal'),
      boxPart('Tall cheek',[-.265,.010,0],[.039,.118,.054],'teal'),
      boxPart('Short cheek',[.264,-.022,0],[.044,.086,.054],'teal'),
      sphere('Large crown',[-.265,.233,0],.105,'pewter'),
      cylinder('Socket',[.264,.120,0],.079,.056,'brass'),
      sphere('Small crown',[.264,.240,0],.064,'pewter'),
      cylinder('Trunnion',[0,-.145,.114],.061,.060,'brass',z90),
    ],
  },
  {
    id:'elbow',label:'Elbow',density:7650,position:[.55,.970,-.53],rotation:spin(-.26),
    parts:[
      boxPart('Stile',[-.213,0,0],[.038,.240,.056],'oxide'),
      boxPart('Sill',[.061,-.199,0],[.236,.041,.056],'oxide'),
      cylinder('Lower vessel',[.248,-.080,0],.081,.078,'bronze'),
      sphere('Forward crown',[.248,.103,0],.105,'pewter'),
      cylinder('Long trunnion',[-.213,.108,.147],.063,.091,'bronze',z90),
      sphere('Trunnion crown',[-.213,.108,.314],.076,'pewter'),
      cylinder('Foot',[-.213,.272,0],.067,.032,'bronze'),
    ],
  },
];
