const tau=2*Math.PI;
export const groundStroke=.021;
export const naturalHz=1.20;
export const damping=.21;
export const windowSeconds=3.6;
const omega0=tau*naturalHz;
const decay=damping*omega0;
const freeOmega=omega0*Math.sqrt(1-damping*damping);

export function transfer(frequency) {
  const ratio=frequency/naturalHz, p=1-ratio*ratio, q=2*damping*ratio;
  const denominator=p*p+q*q;
  return {re:ratio*ratio*p/denominator,im:-ratio*ratio*q/denominator,
    gain:ratio*ratio/Math.hypot(p,q)};
}

function section(t0,frequency,phase,relative=null,velocity=null) {
  const {re,im}=transfer(frequency);
  const omega=tau*frequency;
  const sin=Math.sin(phase),cos=Math.cos(phase);
  const a=relative===null?0:relative-groundStroke*(re*sin+im*cos);
  const v=velocity===null?0:velocity-omega*groundStroke*(re*cos-im*sin);
  return {t0,frequency,phase,omega,re,im,a,b:(v+decay*a)/freeOmega};
}

function angleAt(s,t) { return s.phase+s.omega*(t-s.t0); }

function sample(s,t) {
  const dt=t-s.t0;
  const phase=angleAt(s,t),sin=Math.sin(phase),cos=Math.cos(phase);
  // The initial, unforced residual is exactly zero, including during the prefilled steady-state record.
  const hasTail=s.a!==0||s.b!==0;
  const free=hasTail?Math.exp(-decay*dt):0;
  const c=hasTail?Math.cos(freeOmega*dt):0;
  const q=hasTail?Math.sin(freeOmega*dt):0;
  const transient=s.a*c+s.b*q;
  const ground=groundStroke*sin;
  const relative=groundStroke*(s.re*sin+s.im*cos)+free*transient;
  const groundVelocity=groundStroke*s.omega*cos;
  const relativeVelocity=groundStroke*s.omega*(s.re*cos-s.im*sin)
    +free*(freeOmega*(-s.a*q+s.b*c)-decay*transient);
  return {ground,relative,groundVelocity,relativeVelocity};
}

export function recorder(initialFrequency) {
  const sections=[section(0,initialFrequency,.55)];
  return {
    frequency(frequency,t) {
      const now=sections.at(-1);
      if(frequency===now.frequency) return;
      const previous=sample(now,t);
      const phase=angleAt(now,t) % tau;
      // The base displacement and mass momentum stay continuous when the drive speed changes.
      const groundVelocity=groundStroke*tau*frequency*Math.cos(phase);
      const relativeVelocity=previous.groundVelocity+previous.relativeVelocity-groundVelocity;
      sections.push(section(t,frequency,phase,previous.relative,relativeVelocity));
      while(sections.length>1&&sections[1].t0<t-windowSeconds) sections.shift();
    },
    pose(t) { return sample(sections.at(-1),t); },
    trace(t,out,span=windowSeconds) {
      const first=t-span;
      let s=0;
      for(let i=0;i<out.length;i++) {
        const at=first+span*i/(out.length-1);
        while(s<sections.length-1&&sections[s+1].t0<=at) s++;
        out[i]=sample(sections[s],at).relative;
      }
    },
  };
}
