export const columns=513;
export const extent=2048;
export const spacing=extent/(columns-1);
export const origin=[-1024,-1024];
export const cave={x:8,z:-26,radius:25.8};
const clamp=n=>Math.max(0,Math.min(1,n));
const peak=(x,z,cx,cz,rx,rz)=>Math.exp(-(((x-cx)/rx)**2+((z-cz)/rz)**2));

function noise(x,z,seed){
  const ix=Math.floor(x),iz=Math.floor(z),u=x-ix,v=z-iz;
  const smooth=t=>t*t*(3-2*t),h=(a,b)=>{
    let n=Math.imul(a,1597334677)^Math.imul(b,3812015801)^seed;
    n=Math.imul(n^(n>>>16),73244475);
    return (n>>>0)/4294967296;
  };
  const s=smooth(u),t=smooth(v),a=h(ix,iz),b=h(ix,iz+1);
  const north=a+(h(ix+1,iz)-a)*s,south=b+(h(ix+1,iz+1)-b)*s;
  return north+(south-north)*t;
}

export function elevation(x,z){
  const channel=x-33*Math.sin((z+50)*.011)+z*.067;
  const valley=-20*Math.exp(-((channel/60)**2))*(.51+.49*Math.cos((z+85)*.00145)**2);
  const shear=1.1*Math.sin(x*.083+z*.071)+.9*Math.sin(z*.123-x*.044)+.55*Math.sin(x*.17+z*.156);
  const major=103*peak(x,z,-134,-172,67,144)+98*peak(x,z,156,-243,76,157)
    +44*peak(x,z,-193,-12,102,122)+48*peak(x,z,193,7,106,113);
  const far=158*peak(x,z,-256,-484,140,132)+136*peak(x,z,301,-475,155,192)
    +113*peak(x,z,3,-615,198,134)+90*peak(x,z,-580,-857,220,236)
    +77*peak(x,z,628,-755,257,248);
  const plain=15+5.5*Math.cos(x*.028-z*.017)+5.2*Math.sin(z*.030+x*.011)
    +2.1*Math.sin(x*.070-z*.034);
  const rift=10.8*peak(x,z,-31,-25,49,40)-7.0*peak(x,z,42,-71,46,74);
  const rough=major*.087*Math.sin(x*.099+z*.039)*Math.sin(z*.092-x*.121)
    +far*.047*Math.sin(z*.056+x*.09);
  const plateau=peak(x,z,cave.x,cave.z,49,39)*.76;
  const ground=plain+valley+major+far+rift+shear+rough;
  return ground+(4.25+.033*(x-cave.x)+.016*(z-cave.z)-ground)*plateau;
}
export function caveBoundary(){
  const outline=[];
  for(let i=0;i<28;i++){
    const a=i*Math.PI/14;
    const r=cave.radius*(1+.078*Math.sin(a*3+.72)+.067*Math.cos(a*5));
    outline.push([cave.x+Math.cos(a)*r,cave.z+Math.sin(a)*r*.73]);
  }
  return outline;
}

export function generateField(){
  const heights=new Float32Array(columns*columns),weights=new Uint8Array(columns*columns*4);
  for(let row=0;row<columns;row++){
    const z=origin[1]+row*spacing;
    for(let col=0;col<columns;col++)heights[row*columns+col]=elevation(origin[0]+col*spacing,z);
  }
  for(let row=0;row<columns;row++){
    const z=origin[1]+row*spacing;
    for(let col=0;col<columns;col++){
      const x=origin[0]+col*spacing,i=row*columns+col,y=heights[i];
      const dx=(heights[row*columns+Math.min(columns-1,col+1)]-heights[row*columns+Math.max(0,col-1)])/(2*spacing);
      const dz=(heights[Math.min(columns-1,row+1)*columns+col]-heights[Math.max(0,row-1)*columns+col])/(2*spacing);
      const slope=Math.hypot(dx,dz);
      const mottled=.48*noise(x*.031,z*.031,7911)+.31*noise(x*.069,z*.069,5239)+.21*noise(x*.121,z*.121,9196);
      const cliff=clamp((slope-.19)*1.34);
      const mossPatch=clamp(.45+(mottled-.39)*1.25+slope*.53-(Math.max(0,y-125))*.0068);
      const ochre=(peak(x,z,64,-57,28,75)*.53+peak(x,z,-83,-208,42,61)*.28)*(.55+mottled*.42);
      const ash=clamp(.11+.21*(1-mottled)+.22*peak(x,z,-38,-81,88,71));
      const basalt=.43+cliff*.67+(1-mossPatch)*.30;
      const moss=mossPatch*(1-cliff*.83)*.86;
      const total=basalt+moss+ochre+ash;
      weights[i*4]=Math.round(255*basalt/total);
      weights[i*4+1]=Math.round(255*moss/total);
      weights[i*4+2]=Math.round(255*ochre/total);
      weights[i*4+3]=255-weights[i*4]-weights[i*4+1]-weights[i*4+2];
    }
  }
  return {heights,weights};
}
