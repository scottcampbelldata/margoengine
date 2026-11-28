const tileSize=512;
const wrap=x=>x-Math.floor(x);
const clip=(x,a=0,b=1)=>Math.max(a,Math.min(b,x));
const mix=(a,b,t)=>a+(b-a)*t;
const ramp=x=>{x=clip(x);return x*x*(3-2*x);};

function lattice(x,y,seed){
  let k=(Math.imul(x+1,0x1b873593)^Math.imul(y+1,0x85ebca6b)^seed)>>>0;
  k=Math.imul(k^(k>>>16),0x7feb352d);
  k=Math.imul(k^(k>>>15),0x846ca68b);
  return ((k^(k>>>16))>>>0)/4294967295;
}
function noise(u,v,span,seed){
  const a=u*span,b=v*span,x=Math.floor(a),y=Math.floor(b);
  const s=ramp(a-x),t=ramp(b-y);
  const x0=(x%span+span)%span,y0=(y%span+span)%span,x1=(x0+1)%span,y1=(y0+1)%span;
  return mix(mix(lattice(x0,y0,seed),lattice(x1,y0,seed),s),mix(lattice(x0,y1,seed),lattice(x1,y1,seed),s),t);
}
function handmade(u,v,stone){
  const broad=noise(u,v,4,8347);
  const grain=noise(u,v,36,251),grit=noise(u,v,104,771);
  const width=stone?4:5, height=stone?5:10;
  const row=Math.floor(v*height)%height;
  const x=u*width+.5*(row%2)+.057*(noise(u,v,17,52)-.5);
  const y=v*height+.089*(noise(u,v,15,1007)-.5);
  const col=(Math.floor(x)+width)%width;
  const variation=lattice(col,row,5201)*2-1;
  const vx=wrap(x),vy=wrap(y);
  const dx=Math.min(vx,1-vx),dy=Math.min(vy,1-vy);
  const cut=Math.min(dx,dy*(stone?1:.92))-.013*(grain-.5);
  const inside=ramp((cut-(stone?.044:.039))/(stone?.109:.077));
  const chips=clip((.34-grain)*2.0,0,.52)*(.4+.6*grit);
  const face=stone?.69+.105*broad+.13*variation:.81+.12*variation;
  const relief=mix(.14+.064*grit,face+.077*grain-.20*chips,inside);
  const body=stone?[.62,.555,.439]:[.58,.311,.219];
  const mortar=stone?[.333,.321,.276]:[.272,.233,.195];
  const washes=(broad-.5)*.27+(grain-.5)*.11+(grit-.5)*.11+variation*(stone?.11:.09);
  const mineral=stone?.103*noise(u,v,63,56)*Math.sin(v*211+noise(u,v,17,214)*8):.044*noise(u,v,61,56);
  return {relief,rgb:body.map((color,i)=>mix(mortar[i]+.089*(grit-.5),color+washes+mineral,inside))};
}
const index=(x,y)=>((y+tileSize)%tileSize)*tileSize+(x+tileSize)%tileSize;

export function masonryMaps(stone){
  const np=tileSize*tileSize;
  const elevation=new Float32Array(np),albedo=new Uint8Array(np*4);
  const height=stone?null:new Uint8Array(np*4),normal=new Uint8Array(np*4);
  for(let y=0;y<tileSize;y++)for(let x=0;x<tileSize;x++){
    const id=index(x,y),at=id*4;
    const surface=handmade((x+.5)/tileSize,(y+.5)/tileSize,stone);
    elevation[id]=surface.relief;
    for(let c=0;c<3;c++)albedo[at+c]=Math.round(255*clip(surface.rgb[c]));
    albedo[at+3]=255;
    if(height){
      height[at]=height[at+1]=height[at+2]=Math.round(255*clip(surface.relief));
      height[at+3]=255;
    }
  }
  for(let y=0;y<tileSize;y++)for(let x=0;x<tileSize;x++){
    const u=(elevation[index(x-1,y)]-elevation[index(x+1,y)])*6.1;
    const v=(elevation[index(x,y+1)]-elevation[index(x,y-1)])*6.1;
    const length=Math.hypot(u,v,1),at=index(x,y)*4;
    normal[at]=Math.round((.5+.5*u/length)*255);
    normal[at+1]=Math.round((.5+.5*v/length)*255);
    normal[at+2]=Math.round((.5+.5/length)*255);
    normal[at+3]=255;
  }
  return {albedo,height,normal,size:tileSize};
}
