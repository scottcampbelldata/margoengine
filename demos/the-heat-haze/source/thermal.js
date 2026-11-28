export const ambient=307.15;
const cellSize=[.73,.115,3.20];
const dimensions=[12,10,46];
const origin=[-4.38,.067,-137.2];
const phaseA=new Float32Array(dimensions.reduce((total,n)=>total*n,1));
const phaseB=new Float32Array(phaseA.length);
const envelope=new Float32Array(phaseA.length);

let index=0;
for(let z=0;z<dimensions[2];z++){
  for(let y=0;y<dimensions[1];y++){
    const height=(y+.5)*cellSize[1];
    for(let x=0;x<dimensions[0];x++,index++){
      const lateral=(x+.5)*cellSize[0]+origin[0];
      const fade=Math.max(0,1-(Math.abs(lateral)/4.46)**6);
      const end=Math.min(1,(z+.5)/4,(dimensions[2]-z-.5)/2.6);
      envelope[index]=Math.exp(-height/.302)*fade*end;
      phaseA[index]=z*.74+x*1.63+y*.83+.71*Math.sin(z*.93+x*.72);
      phaseB[index]=z*.93-x*.85+y*2.13+.68*Math.sin(z*.61-y*.85+x*.42);
    }
  }
}

export function airLayer(){
  const kelvin=new Float32Array(phaseA.length), volume={origin,dimensions,cellSize,kelvin,pressure:98600};
  return {
    volume,
    set(contrast,time){
      const angle=time*4.15;
      for(let i=0;i<kelvin.length;i++){
        const eddies=.70+.21*Math.sin(phaseA[i]-angle)+.09*Math.cos(phaseB[i]+angle*.73);
        kelvin[i]=ambient+contrast*envelope[i]*eddies;
      }
    },
  };
}
