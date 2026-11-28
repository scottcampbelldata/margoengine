const side=24;
const size=side*side;
const tau=Math.PI*2;
const A=Float32Array.from({length:size},(_,i)=>{
  const y=Math.floor(i/side)-11.5,x=i%side-11.5;
  return Math.cos(.42*x+.62*y)*Math.exp(-((x-y)**2)/95)+.28*Math.sin(.67*x-.33*y);
});
const B=Float32Array.from({length:size},(_,i)=>{
  const y=Math.floor(i/side)-11.5,x=i%side-11.5;
  return Math.sin(.31*x-.52*y+.025*x*y)*Math.exp(-((x+.52*y)**2)/160)+.31*Math.cos(.21*x+.74*y);
});
const signal=Float32Array.from({length:128},(_,i)=>Math.sin(tau*7*i/128)+.58*Math.cos(tau*23*i/128));
let seed=8108521;
const samples=Float32Array.from({length:128},(_,i)=>{
  seed=(Math.imul(seed,1664525)+1013904223)>>>0;
  return .94*(seed/2147483648-1)+.37*Math.sin(i*.219);
});

export const fixtures={
  A:{data:A,shape:[side,side]},B:{data:B,shape:[side,side]},
  signal:{data:signal,shape:[signal.length]},samples:{data:samples,shape:[samples.length]},
};
export const examples=[
  {label:'Matrix multiply',expression:'A @ B'},
  {label:'FFT',expression:'fft(signal)'},
  {label:'Sort',expression:'sort(samples)'},
];
