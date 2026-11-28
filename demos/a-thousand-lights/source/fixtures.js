export const lightCount = 1000;
export const shadowCount = 6;
const tau = Math.PI*2;
const palette = [
  [.047,.65,1], [.20,.29,1], [.54,.19,1], [1,.15,.46], [1,.39,.10], [1,.69,.31],
];
const shadow={near:.15,far:17};

function chroma(offset,color){
  const ramp=(.5+.5*Math.sin(offset))*5;
  const lower=Math.min(4,Math.floor(ramp)), t=ramp-lower;
  const a=palette[lower],b=palette[lower+1];
  for(let i=0;i<3;i++) color[i]=a[i]+(b[i]-a[i])*t;
}

export function createFixtures(){
  const lenses=new Float32Array(lightCount*7);
  const lights=Array.from({length:lightCount},(_,i)=>{
    const light = {position:[0,0,0],color:[0,0,0],range:3.2,intensity:1};
    if(i<shadowCount) Object.assign(light,{
      direction:[0,-1,0], innerAngle:.36, outerAngle:.79,
      range:17,
    });
    return light;
  });
  function update(value, shadowsEnabled){
    const phase=value/100*tau;
    for(let i=0;i<lights.length;i++){
      const light=lights[i], level=Math.floor(i/100), point=i%100;
      const theta=point/100*tau+level*.391+phase+.072*level*Math.sin(phase);
      const wave=.58*Math.sin(theta*2.0+phase*2-level*.37);
      const radial=6.77+wave+.37*Math.cos(theta*5-level*.75);
      const y=.84+level*.733+.46*Math.sin(theta*2.0-phase+level*.382);
      const p=light.position;
      p[0]=Math.cos(theta)*radial;
      p[1]=y;
      p[2]=Math.sin(theta)*(radial+3.10)-2.15;
      const matching=point%5===0;
      chroma(theta*1.80+level*.57-phase*2,light.color);
      light.intensity=1.95+.96*(.5+.5*Math.sin(theta*5+level*.87+phase*2))+(matching?.75:0);
      let size=.057+(matching?.030:0);
      if(i<shadowCount){
        const t=i/shadowCount*tau+phase-1.08*Math.sin(phase);
        p[0]=4.3*Math.sin(t);
        p[1]=6.14+.95*Math.sin(t*2+phase);
        p[2]=4.2*Math.cos(t);
        light.direction[0]=.36*Math.cos(theta)-p[0];
        light.direction[1]=1.65-p[1];
        light.direction[2]=.42*Math.sin(theta)-p[2];
        chroma(t-phase*.7,light.color);
        light.intensity=46+i*3;
        light.shadow=shadowsEnabled?shadow:false;
        size=.098;
      }
      lenses.set(p,i*7);
      lenses.set(light.color,i*7+3);
      lenses[i*7+6]=size;
    }
    return lights;
  }
  return {lenses,update};
}
