export const domain=1.2;
export const resolution=64;
export const maxSamples=144;
export const hiddenSize=10;

function generator(seed) {
  let value=seed>>>0;
  return () => {
    value^=value<<13;
    value^=value>>>17;
    value^=value<<5;
    return (value>>>0)/4294967296;
  };
}

export function makeSamples(name) {
  const random=generator(name==='rings'?5943:8181);
  const noise=magnitude=>(random()+random()-1)*magnitude;
  const samples=[];
  for(let i=0;i<38;i++){
    if(name==='rings'){
      const angle=i/38*Math.PI*2;
      for(const label of [0,1]){
        const turn=angle+noise(.11)+(label?.082:0);
        const radius=(label?.80:.34)+noise(.14);
        samples.push([Math.cos(turn)*radius+noise(.025),Math.sin(turn)*radius+noise(.025),label]);
      }
    }else{
      const turn=.13+i/37*(Math.PI-.26);
      samples.push([-.33+.67*Math.cos(turn)+noise(.060),-.20+.65*Math.sin(turn)+noise(.072),0]);
      samples.push([.33-.67*Math.cos(turn)+noise(.060),.19-.65*Math.sin(turn)+noise(.072),1]);
    }
  }
  return samples;
}
