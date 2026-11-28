export const atomScale = .255;
export const bondRadius = .135;
export const symbols = ['C','N','O','S','SE'];
export const colors = {
  C:'#91bbca', N:'#9f92e3', O:'#f59084', S:'#e7bd65', SE:'#e7bd65', CRO:'#c4ed80',
};
export const modeTitles = ['Ball and stick','Space filling','Chromophore'];

const rgb=hex=>[1,3,5].map(start=>parseInt(hex.slice(start,start+2),16)/255);

export function structureView(file) {
  const low=[Infinity,Infinity,Infinity], high=[-Infinity,-Infinity,-Infinity];
  const chromophore=[];
  const displayColors=new Float32Array(file.colors);
  for(let i=0;i<file.atoms.length;i++) {
    const atom=file.atoms[i];
    const key=atom.residue==='CRO'&&atom.element==='C'?'CRO':atom.element;
    if(colors[key])displayColors.set(rgb(colors[key]),i*3);
    if(atom.residue==='CRO')chromophore.push(i);
    for(let k=0;k<3;k++) {
      const value=file.positions[i*3+k];
      low[k]=Math.min(low[k],value);
      high[k]=Math.max(high[k],value);
    }
  }
  const middleLow=[Infinity,Infinity,Infinity],middleHigh=[-Infinity,-Infinity,-Infinity];
  for(const index of chromophore)for(let k=0;k<3;k++){
    const value=file.positions[3*index+k];
    middleLow[k]=Math.min(middleLow[k],value);
    middleHigh[k]=Math.max(middleHigh[k],value);
  }
  const center=middleLow.map((v,k)=>(v+middleHigh[k])*.5);
  const limits=low.flatMap((v,k)=>[v-2.2,high[k]+2.2]);
  const spans=low.map((v,k)=>high[k]-v+4.4);
  const span=Math.max(...spans);
  const aspect=spans.map(v=>1.21*v/span);
  const residueCount=new Set(file.atoms.map(a=>a.chain+':'+(a.residueId??a.sequence)+':'+a.insertionCode)).size;
  const selected=new Set(chromophore);
  let chromophoreBonds=0;
  for(let i=0;i<file.bonds.length;i+=2)
    if(selected.has(file.bonds[i])&&selected.has(file.bonds[i+1]))chromophoreBonds++;
  return {molecule:{...file,colors:displayColors},chromophore,chromophoreBonds,center,limits,aspect,span,residueCount};
}

export const position=(matrix, point)=>[
  matrix[0]*point[0]+matrix[4]*point[1]+matrix[8]*point[2]+matrix[12],
  matrix[1]*point[0]+matrix[5]*point[1]+matrix[9]*point[2]+matrix[13],
  matrix[2]*point[0]+matrix[6]*point[1]+matrix[10]*point[2]+matrix[14],
];
