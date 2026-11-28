export const scale=.12;
export const space=point=>point.map(v=>v*scale);

export const methods=[
  {kind:'catmull-rom',title:'Catmull–Rom',hint:'The curve passes through every brass point.'},
  {kind:'bezier',title:'Bézier',hint:'The curve passes through three anchors. The four smaller points pull its two spans.'},
  {kind:'hermite',title:'Hermite',hint:'The curve passes through seven anchors. The short copper rods set the tangents.'},
  {kind:'bspline',title:'B-spline',hint:'The ends are anchored. The other points pull the curve toward them.'},
];

export const knots=[
  [-2.20,.39,.63],[-1.63,.98,-.55],[-.93,.49,-1.04],
  [-.17,1.28,.36],[.73,.60,1.07],[1.38,.98,-.89],[2.21,.51,-.53],
].map(space);
export const tangents=[
  [.38,.82,-1.55],[1.15,.32,.06],[.56,-.17,.91],
  [1.03,-.60,.46],[.40,.13,-1.37],[.31,-.08,-1.13],[1.68,-.20,.73],
].map(space);
export const initialProbe=.675;
export const initialStation=.64;

export function probeAt(fraction) {
  return space([-2.21+4.42*fraction,1.51,.89]);
}

export function makeCurves(Spline, SplineFrames) {
  return methods.map(method=>{
    const options={kind:method.kind,divisions:1536};
    if(method.kind==='hermite')options.tangents=tangents;
    const spline=new Spline(knots,options);
    const frames=new SplineFrames(spline,{samples:256});
    return {spline,frames};
  });
}

export const add=(a,b)=>[a[0]+b[0],a[1]+b[1],a[2]+b[2]];
export const diff=(a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
export const mult=(a,k)=>[a[0]*k,a[1]*k,a[2]*k];
export const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
export const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
