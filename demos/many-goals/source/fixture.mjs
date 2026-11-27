export const jointAngles=[1.02,-.70,-.57,.40,0,0,0,0];
export const links=[.84,.74,.59,.43];
export const contacts=[
  {name:'Brace',frame:5,color:'#e58f67',calibrated:[1.35,-.92,-.54,.40]},
  {name:'Gauge',frame:6,color:'#8cd3c8',calibrated:[.86,-.98,.03,.65]},
  {name:'Probe',frame:7,color:'#dbc785',calibrated:[1.10,-.62,-.42,.49]},
];
export const startOffset=.75;
export const weights=[[28,5,1],[1,28,5],[5,1,28],[1,1,1]];
export function fixture(Solver) {
  const hinge=(parent,position,value,min,max)=>({type:'revolute',parent,position,value,min,max,axis:[0,0,1]});
  const fixed=(parent,position)=>({type:'fixed',parent,position});
  const solver=new Solver([
    hinge(-1,[-1.40,.53,0],jointAngles[0],-.20,1.85),
    hinge(0,[links[0],0,0],jointAngles[1],-2.0,1.10),
    hinge(1,[links[1],0,0],jointAngles[2],-1.85,1.55),
    hinge(2,[links[2],0,0],jointAngles[3],-1.70,1.65),
    fixed(3,[links[3],0,0]),
    fixed(1,[.24,-.15,.135]),
    fixed(2,[.32,.115,.135]),
    fixed(3,[links[3],0,.135]),
  ],{iterations:80,candidates:2,positionTolerance:.0003,damping:.018,maxStep:.22});
  const initial=solver.evaluate();
  const spread=contacts.map(({frame,calibrated})=>solver.evaluate([...calibrated,0,0,0,0])[frame].position);
  return {
    evaluate(values){return solver.evaluate(values);},
    solve(choice,offset) {
      const ranks=weights[choice];
      const targets=contacts.map(({frame},i)=>initial[frame].position.map((value,axis)=>value+(spread[i][axis]-value)*offset));
      const result=solver.solve({
        goals:contacts.map(({frame},i)=>({frame:{joint:frame},position:targets[i],positionWeight:ranks[i]})),
      });
      return {...result,targets};
    },
  };
}
