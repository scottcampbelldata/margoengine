const rad=Math.PI/180;
const tau=2*Math.PI;
export const dayMilliseconds=86400000;
export const start=Date.UTC(2026,0,1);
export const duration=730;

// JPL Solar System Dynamics, Table 1. a, e, I, L, longitude of perihelion and ascending node.
export const planets=[
  {id:'mercury',name:'Mercury',radius:.0165,
    epoch:[.38709927,.20563593,7.00497902,252.25032350,77.45779628,48.33076593],
    rate:[.00000037,.00001906,-.00594749,149472.67411175,.16047689,-.12534081]},
  {id:'venus',name:'Venus',radius:.026,
    epoch:[.72333566,.00677672,3.39467605,181.97909950,131.60246718,76.67984255],
    rate:[.00000390,-.00004107,-.00078890,58517.81538729,.00268329,-.27769418]},
  {id:'earth',name:'Earth',radius:.028,
    epoch:[1.00000261,.01671123,-.00001531,100.46457166,102.93768193,0],
    rate:[.00000562,-.00004392,-.01294668,35999.37244981,.32327364,0]},
  {id:'mars',name:'Mars',radius:.019,
    epoch:[1.52371034,.09339410,1.84969142,-4.55343205,-23.94362959,49.55953891],
    rate:[.00001847,.00007882,-.00813131,19140.30268499,.44441088,-.29257343]},
];

function elements(planet,day) {
  const jd=(start+day*dayMilliseconds)/dayMilliseconds+2440587.5;
  const centuries=(jd-2451545)/36525;
  const [a,e,inclination,longitude,perihelion,node]=planet.epoch.map((value,i)=>value+planet.rate[i]*centuries);
  const m=(longitude-perihelion)*rad;
  return {a,e,inclination:inclination*rad,omega:(perihelion-node)*rad,node:node*rad,mean:Math.atan2(Math.sin(m),Math.cos(m))};
}

function inEcliptic({a,e,inclination,omega,node},anomaly) {
  const x=a*(Math.cos(anomaly)-e);
  const y=a*Math.sqrt(1-e*e)*Math.sin(anomaly);
  const u=x*Math.cos(omega)-y*Math.sin(omega);
  const v=x*Math.sin(omega)+y*Math.cos(omega);
  const inPlane=v*Math.cos(inclination);
  return [u*Math.cos(node)-inPlane*Math.sin(node),
    u*Math.sin(node)+inPlane*Math.cos(node),v*Math.sin(inclination)];
}

export function position(planet,day) {
  const orbit=elements(planet,day);
  let eccentric=orbit.mean;
  for(let i=0;i<6;i++) {
    eccentric-=(eccentric-orbit.e*Math.sin(eccentric)-orbit.mean)/(1-orbit.e*Math.cos(eccentric));
  }
  return inEcliptic(orbit,eccentric);
}

export function orbitTrack(planet,segmentCount=144) {
  const orbit=elements(planet,duration/2);
  return Array.from({length:segmentCount},(_,i)=>inEcliptic(orbit,i*tau/segmentCount));
}
