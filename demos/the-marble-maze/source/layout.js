export const pitch=.159;
export const columns=6;
export const rows=5;
export const width=columns*pitch;
export const depth=rows*pitch;
export const pivot=[0,.185,0];
export const radius=.033;
export const fixed=1/90;
export const maximumTilt=11*Math.PI/180;
export const opening=.121;
export const railWidth=.019;
export const railHeight=.072;
export const cell=(x,z)=>[(x+.5)*pitch-width/2,(z+.5)*pitch-depth/2];
export const start=cell(0,4);
export const ballStart=[start[0],pivot[1]+radius+.0006,start[1]];
export const goal=cell(5,0);

const paths=[
  [[0,4],[1,4],[2,4],[2,3],[2,2],[3,2],[4,2],[4,1],[4,0],[5,0]],
  [[0,4],[0,3],[0,2],[0,1],[0,0],[1,0],[2,0],[2,1],[3,1],[3,0]],
  [[1,4],[1,3],[1,2],[1,1]],
  [[2,4],[3,4],[4,4],[5,4],[5,3],[5,2],[5,1]],
  [[3,2],[3,3],[4,3]],
];
const edge=(x,z,a,b)=>[z*columns+x,b*columns+a].sort((i,j)=>i-j).join('/');
const passages=new Set();
for(const path of paths)for(let i=1;i<path.length;i++)passages.add(edge(...path[i-1],...path[i]));

export function canPass(x,z,a,b){
  return [x,a].every(n=>n>=0&&n<columns)&&[z,b].every(n=>n>=0&&n<rows)&&passages.has(edge(x,z,a,b));
}

export const tray=[
  {size:[1.06,.080,.90],offset:[0,-.045,0]},
  {size:[.023,.091,.897],offset:[.536,-.007,0]},
  {size:[.023,.091,.897],offset:[-.536,-.007,0]},
  {size:[1.052,.091,.022],offset:[0,-.007,.441]},
  {size:[1.052,.091,.022],offset:[0,-.007,-.441]},
];

export const rails=[];
function course(transverse,line,length,solid){
  let first=0;
  while(first<length){
    if(!solid(first)){first++;continue;}
    let end=first+1;
    while(end<length&&solid(end))end++;
    const along=(first+end)*pitch/2-(transverse?width:depth)/2;
    const across=line*pitch-(transverse?depth:width)/2;
    const span=(end-first)*pitch+railWidth;
    const offset=transverse?[along,railHeight/2,across]:[across,railHeight/2,along];
    const size=transverse?[span,railHeight,railWidth]:[railWidth,railHeight,span];
    rails.push({offset,size,transverse,outer:line===0||line===(transverse?rows:columns)});
    first=end;
  }
}
for(let z=0;z<=rows;z++)course(true,z,columns,x=>!canPass(x,z-1,x,z));
for(let x=0;x<=columns;x++)course(false,x,rows,z=>!canPass(x-1,z,x,z));

export const deck=[];
function panel(x1,x2,z1,z2){
  deck.push({offset:[(x1+x2)/2,-.019,(z1+z2)/2],size:[x2-x1,.038,z2-z1]});
}
const half=opening/2;
const [gx,gz]=goal;
panel(-width/2,gx-half,-depth/2,depth/2);
panel(gx+half,width/2,-depth/2,depth/2);
panel(gx-half,gx+half,-depth/2,gz-half);
panel(gx-half,gx+half,gz+half,depth/2);

export function rotate([x,y,z],[a,b,c,w]){
  const i=2*(b*z-c*y),j=2*(c*x-a*z),k=2*(a*y-b*x);
  return [x+w*i+b*k-c*j,y+w*j+c*i-a*k,z+w*k+a*j-b*i];
}
export function inverse([x,y,z,w]){return [-x,-y,-z,w];}
export function toBoard(position,q){return rotate(position.map((v,i)=>v-pivot[i]),inverse(q));}
export function boardTurn(x,z){
  const a=z*maximumTilt/2,b=-x*maximumTilt/2;
  return [Math.sin(a)*Math.cos(b),-Math.sin(a)*Math.sin(b),Math.cos(a)*Math.sin(b),Math.cos(a)*Math.cos(b)];
}
