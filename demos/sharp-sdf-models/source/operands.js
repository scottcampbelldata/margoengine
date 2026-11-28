export const openingWidth=118;
export const resolution=38;
const box=(center,halfSize)=>({type:'box',center,halfSize});
const join=(a,b)=>({type:'union',a,b});

const casting=[
  box([-.003,.042,.014],[.337,.042,.273]),
  box([-.033,.216,-.032],[.279,.185,.210]),
  box([-.150,.423,-.081],[.155,.125,.179]),
  box([.222,.166,-.027],[.108,.138,.247]),
  box([-.262,.302,-.040],[.079,.054,.226]),
  box([.187,.324,-.191],[.110,.108,.073]),
].reduce(join);

function tool(width){
  const w=width/2000;
  return [
    box([.029,.213,.169],[w,.106,.232]),
    box([-.059,.369,-.068],[w,.243,.088]),
    box([.161,.216,-.048],[.260,.062,w]),
    {type:'sphere',center:[-.097,.201,-.131],radius:.083},
  ].reduce(join);
}
export function operation(mode,width){
  return {type:mode,a:casting,b:tool(width)};
}
function boxField({center,halfSize},x,y,z){
  const qx=Math.abs(x-center[0])-halfSize[0],qy=Math.abs(y-center[1])-halfSize[1],
    qz=Math.abs(z-center[2])-halfSize[2];
  return Math.hypot(Math.max(0,qx),Math.max(0,qy),Math.max(0,qz))+Math.min(0,Math.max(qx,qy,qz));
}
export function evaluator(shape){
  if(shape.type==='box')return (x,y,z)=>boxField(shape,x,y,z);
  if(shape.type==='sphere'){
    const [cx,cy,cz]=shape.center;
    return (x,y,z)=>Math.hypot(x-cx,y-cy,z-cz)-shape.radius;
  }
  const a=evaluator(shape.a),b=evaluator(shape.b);
  if(shape.type==='union')return (x,y,z)=>Math.min(a(x,y,z),b(x,y,z));
  if(shape.type==='intersection')return (x,y,z)=>Math.max(a(x,y,z),b(x,y,z));
  return (x,y,z)=>Math.max(a(x,y,z),-b(x,y,z));
}
