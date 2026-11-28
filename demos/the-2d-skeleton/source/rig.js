export const width=1080,height=640;
export const names={
  root:'floor',hips:'hips',body:'chest',head:'head',
  nearUpper:'lift-shoulder',nearFore:'lift-elbow',nearHand:'lift-wrist',lantern:'lantern',
  farUpper:'rest-shoulder',farFore:'rest-elbow',farHand:'rest-wrist',
  nearLeg:'near-boot',farLeg:'far-boot',hem:'coat-hem',
  scarf:'scarf-knot',scarfMid:'scarf-middle',scarfTip:'scarf-tip',
};

const n=names;
const definitions=[
  [n.root,null,519,537,0],
  [n.hips,n.root,-1,-126,0],
  [n.body,n.hips,4,-73,0],
  [n.head,n.body,8,-71,0],
  [n.nearUpper,n.body,34,-33,-17],
  [n.nearFore,n.nearUpper,0,65,-7],
  [n.nearHand,n.nearFore,0,58,-2],
  [n.lantern,n.nearHand,0,13,26],
  [n.farUpper,n.body,-31,-27,18],
  [n.farFore,n.farUpper,0,62,19],
  [n.farHand,n.farFore,0,49,-13],
  [n.nearLeg,n.root,19,-97,0],
  [n.farLeg,n.root,-24,-97,0],
  [n.hem,n.hips,0,-12,0],
  [n.scarf,n.body,-18,-59,0],
  [n.scarfMid,n.scarf,-58,8,0],
  [n.scarfTip,n.scarfMid,-54,16,0],
];

const bindMap=new Map();
for(const [name,parent,x,y] of definitions){
  const [u,v]=bindMap.get(parent)??[0,0];
  bindMap.set(name,[u+x,v+y]);
}
const boneId=name=>definitions.findIndex(item=>item[0]===name);

const slots=[
  ['silk',n.scarf],
  ['far_boot',n.farLeg],['near_boot',n.nearLeg],
  ['far_shoulder',n.farUpper],['far_forearm',n.farFore],['far_glove',n.farHand],
  ['hem',n.hem],['coat',n.body],['face',n.head],['knot',n.scarf],
  ['near_shoulder',n.nearUpper],['near_forearm',n.nearFore],['lantern',n.lantern],['near_glove',n.nearHand],
];

function ribbon(part){
  const columns=[0,.15,.31,.48,.64,.79,.93,1],rows=[0,.24,.51,.76,1];
  const vertices=[],uvs=[],triangles=[],weights=[];
  const [a,b,c]=[n.scarf,n.scarfMid,n.scarfTip];
  for(const [i,u] of columns.entries()){
    const ab=Math.max(0,Math.min(1,(u-.50)/.36));
    const bc=Math.max(0,Math.min(1,(u-.14)/.33));
    const influences=u>.48?[[a,ab],[b,1-ab]]:[[b,bc],[c,1-bc]];
    for(const [j,v] of rows.entries()){
      vertices.push(u*part.w-part.ox,v*part.h-part.oy);
      uvs.push(u,v);
      weights.push(influences.length,...influences.flatMap(([name,value])=>[boneId(name),value]));
      const k=i*rows.length+j;
      if(i<columns.length-1&&j<rows.length-1)triangles.push(k,k+rows.length,k+1,k+1,k+rows.length,k+rows.length+1);
    }
  }
  return {
    name:'silk',type:'mesh',path:'silk',width:part.w,height:part.h,vertices,uvs,triangles,weights,
    slotPose:[1,0,0,1,...bindMap.get(a)],
    bonePose:[a,b,c].flatMap(name=>[boneId(name),1,0,0,1,...bindMap.get(name)]),
  };
}

const seconds=4.5;
const frameRate=60;
const rotation={
  [n.body]:[[0,0],[.32,4],[.65,2],[1.52,-4.5],[1.86,-5.4],[2.45,-4],[3.41,.8],[4.15,-.6],[4.5,0]],
  [n.head]:[[0,0],[.28,5],[.66,8],[1.37,-9],[1.81,-14],[2.27,-10],[2.86,-6],[3.62,2],[4.5,0]],
  [n.nearUpper]:[[0,0],[.36,12],[.61,7],[1.45,-65],[1.78,-69],[2.11,-62],[2.62,-61],[3.40,-10],[3.98,4],[4.5,0]],
  [n.nearFore]:[[0,0],[.27,-7],[.59,-12],[1.06,-29],[1.56,-72],[1.91,-70],[2.27,-65],[2.79,-54],[3.45,-16],[4.14,1],[4.5,0]],
  [n.nearHand]:[[0,0],[.38,7],[.70,11],[1.42,-8],[1.84,-11],[2.17,-4],[2.74,-4],[3.30,5],[4.21,-1],[4.5,0]],
  [n.lantern]:[[0,0],[.37,-8],[.67,2],[1.06,57],[1.50,139],[1.83,158],[2.11,135],[2.41,139],
    [2.77,123],[3.25,61],[3.72,10],[4.06,-12],[4.33,4],[4.5,0]],
  [n.farUpper]:[[0,0],[.43,4],[1.24,-6],[1.94,-9],[2.69,-5],[3.76,3],[4.5,0]],
  [n.farFore]:[[0,0],[.37,-3],[.93,5],[1.78,8],[2.36,5],[3.55,-3],[4.5,0]],
  [n.hem]:[[0,0],[.54,2],[1.56,-5],[2.10,-6],[2.79,-3],[3.54,2],[4.13,-1],[4.5,0]],
  [n.scarf]:[[0,0],[.36,-3],[.77,7],[1.56,-10],[2.00,-11],[2.54,-5],[3.17,2],[3.88,-4],[4.5,0]],
  [n.scarfMid]:[[0,0],[.46,4],[.93,-4],[1.77,8],[2.26,-7],[2.87,7],[3.46,-7],[4.13,2],[4.5,0]],
  [n.scarfTip]:[[0,0],[.53,-5],[1.14,8],[1.68,-12],[2.22,14],[2.67,-9],[3.28,11],[3.84,-7],[4.5,0]],
};
const pelvis=[[0,0,0],[.34,2,4],[.69,1,3],[1.54,8,-5],[2.06,10,-4],[2.68,6,-2],[3.54,2,3],[4.5,0,0]];
function channel(poses,values){
  return poses.map(([t,...v],i)=>{
    const rest=i===poses.length-1?0:Math.round(frameRate*poses[i+1][0])-Math.round(frameRate*t);
    return {duration:rest,curve:[.42,0,.58,1],...values(v)};
  });
}
export function documentFor(parts){
  const bone=definitions.map(([name,parent,x,y,angle])=>({name,...(parent?{parent}:{}),transform:{x,y,skX:angle,skY:angle}}));
  const animationBones=Object.entries(rotation).map(([name,poses])=>({name,rotateFrame:channel(poses,([rotate])=>({rotate}))}));
  animationBones.push({name:n.hips,translateFrame:channel(pelvis,([x,y])=>({x,y}))});
  return {name:'Glasshouse signal',version:'5.5',compatibleVersion:'5.5',frameRate,armature:[{
    name:'Keeper',bone,slot:slots.map(([name,parent])=>({name,parent})),
    skin:[{name:'',slot:slots.map(([name])=>{
      const part=parts.get(name);
      return {name,display:[name==='silk'?ribbon(part):{
        name,type:'image',pivot:{x:part.ox/part.w,y:part.oy/part.h},
      }]};
    })}],
    animation:[{name:'signal',duration:seconds*frameRate,playTimes:1,bone:animationBones}],
  }]};
}

export const inspected=[n.body,n.head,n.nearUpper,n.nearFore,n.nearHand,n.lantern,n.scarf,n.scarfMid,n.scarfTip];
