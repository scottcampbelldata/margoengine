export const radians = Math.PI / 180;
export const designWavelength = 526;
const film = [2.20,1.47];
const substrate = 1.52;
const layers = 16;

function admittance(index, sine0, polarization) {
  const cos = Math.sqrt(1-(sine0/index)**2);
  return polarization === 's' ? index*cos : index/cos;
}

function polarizationReflectance(wavelength, theta, polarization) {
  const sine = Math.sin(theta);
  const incident = admittance(1,sine,polarization);
  const final = admittance(substrate,sine,polarization);
  let a=1,b=0,c=0,d=1;
  for(let i=0;i<layers;i++){
    const index=film[i%2];
    const phase=Math.PI*designWavelength*Math.sqrt(1-(sine/index)**2)/(2*wavelength);
    const eta=admittance(index,sine,polarization);
    const p=Math.cos(phase), q=Math.sin(phase);
    const upper=q/eta, lower=q*eta;
    [a,b,c,d]=[a*p-b*lower,a*upper+b*p,c*p+d*lower,d*p-c*upper];
  }
  const x=incident*a, y=incident*b*final, u=d*final, v=c;
  return ((x-u)**2+(y-v)**2)/((x+u)**2+(y+v)**2);
}

export function reflectance(wavelength, degrees) {
  const theta=degrees*radians;
  return .5*(polarizationReflectance(wavelength,theta,'s')+polarizationReflectance(wavelength,theta,'p'));
}

export function reflectionDirection(degrees) {
  return [Math.sin(2*degrees*radians),0,Math.cos(2*degrees*radians)];
}

function bell(w,c,lower,upper) {
  const distance=w-c;
  return Math.exp(-.5*(distance*(distance<0?lower:upper))**2);
}

function matching(w) {
  return [
    .362*bell(w,442,.0624,.0374)+1.056*bell(w,599.8,.0264,.0323)-.065*bell(w,501.1,.049,.0382),
    .821*bell(w,568.8,.0213,.0247)+.286*bell(w,530.9,.0613,.0322),
    1.217*bell(w,437,.0845,.0278)+.681*bell(w,459,.0385,.0725),
  ];
}

function rgb(x,y,z) {
  return [3.2406*x-1.5372*y-.4986*z,-.9689*x+1.8758*y+.0415*z,.0557*x-.2040*y+1.0570*z];
}

const spectrum=Array.from({length:91},(_,i)=>{
  const wavelength=380+i*4;
  const power=(550/wavelength)**5/Math.expm1(1.438776877e7/(6504*wavelength));
  const edge=i===0||i===90?.5:1;
  return {wavelength,weight:matching(wavelength).map((channel)=>channel*power*edge)};
});
const white=spectrum.reduce((sum,{weight})=>sum.map((value,i)=>value+weight[i]),[0,0,0]);
const reference=rgb(...white);
const color=(xyz)=>rgb(...xyz).map((value,i)=>Math.max(0,Math.min(1,value/reference[i])));

export function splitSpectrum(degrees) {
  const reflected=[0,0,0];
  for(const {wavelength,weight} of spectrum){
    const r=reflectance(wavelength,degrees);
    for(let i=0;i<3;i++)reflected[i]+=r*weight[i];
  }
  return {
    reflected:color(reflected),
    transmitted:color(white.map((value,i)=>value-reflected[i])),
    fraction:reflected[1]/white[1],
  };
}
