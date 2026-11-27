export const count = 16_384;
export const flockCenter = [0,11.4,0];
export const seed = 551524;
export const flightOptions = {
  count, seed, preset:'bird',
  bounds:{shape:'box',center:flockCenter,halfSize:[30,10.4,12.2]}, boundsMargin:3.4,boundsStrength:8.1,
  neighborRadius:2.05,separationRadius:.68,visionAngle:5.08,maxNeighbors:16,
  separation:1.7,alignment:1.84,cohesion:1.22,minSpeed:4.5,maxSpeed:9,
  maxForce:15,maxTurnAccel:12,bankStrength:.72,flapAmplitude:.47,flapFrequency:7.6,
};
export function flightInfluences(time) {
  const t=time*.27;
  return [
    {position:[10.5*Math.cos(t),flockCenter[1]+2.2*Math.sin(t),4.2*Math.sin(t)],strength:1.6,radius:22},
    {position:[-9*Math.cos(t*.88),flockCenter[1]-.5*Math.sin(t),-3.5*Math.sin(t)],strength:1.4,radius:22},
    {position:flockCenter,strength:.8,radius:0},
  ];
}

export function randomFrom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

// The seed is a pair of passing ribbons. The simulation replaces this arrangement from its first step.
export function openingFormation(seed) {
  const random = randomFrom(seed), boids = new Float32Array(count * 8);
  const scatter = () => random() + random() + random() - 1.5;
  for (let i = 0; i < count; i++) {
    const t = random() * Math.PI * 2;
    const lane = i < count * .53 ? -1 : 1;
    const s = Math.sin(t), c = Math.cos(t);
    const height = Math.sin(t * 2) * 3.3;
    const offset = i * 8;
    boids[offset] = 18 * c + scatter() * 3.4;
    boids[offset + 1] = flockCenter[1] + height + s * 2.7 + lane * 1.5 + scatter() * 3.3;
    boids[offset + 2] = 7 * s + scatter() * 4.1;
    boids[offset + 3] = random() * Math.PI * 2;
    const velocity = [-18 * s, 6.6 * Math.cos(t * 2) + 2.7 * c, 7 * c];
    const multiplier = (5.1 + random() * 3.7) / Math.hypot(...velocity);
    for (let axis = 0; axis < 3; axis++) boids[offset + 4 + axis] = velocity[axis] * multiplier;
  }
  return { count, steps:0, boids };
}

// Starling planform from below, +Z towards the beak. Only the wings receive flap weights.
export function starling() {
  const positions=[], normals=[], indices=[], weights=[];
  function triangle(a,b,c,wa=0,wb=0,wc=0) {
    const ux=b[0]-a[0], uy=b[1]-a[1], uz=b[2]-a[2];
    const vx=c[0]-a[0], vy=c[1]-a[1], vz=c[2]-a[2];
    const normal=[uy*vz-uz*vy,uz*vx-ux*vz,ux*vy-uy*vx];
    const length=Math.hypot(...normal);
    const n=indices.length;
    positions.push(...a,...b,...c);
    for(let i=0;i<3;i++)normals.push(...normal.map(v=>v/length));
    indices.push(n,n+1,n+2);
    weights.push(wa,wb,wc);
  }
  const neck=[0,.10,.50], chest=[0,-.12,.20], back=[0,.13,-.18], tail=[0,.02,-.60];
  for (const side of [-1,1]) {
    const shoulder=[side*.14,.018,.18], rump=[side*.085,.02,-.28];
    const wrist=[side*.53,.033,.10], tip=[side,0,-.24], outer=[side*.72,-.016,-.30];
    const trailing=[side*.30,-.025,-.19];
    const oriented = (a,b,c,wa=0,wb=0,wc=0) => {
      if (side > 0) triangle(a,b,c,wa,wb,wc);
      else triangle(a,c,b,wa,wc,wb);
    };
    oriented(shoulder,neck,back);
    oriented(shoulder,back,rump);
    oriented(chest,shoulder,rump);
    oriented(chest,rump,tail);
    oriented(shoulder,wrist,trailing,0,.58,.26);
    oriented(wrist,outer,trailing,.58,.76,.26);
    oriented(wrist,tip,outer,.58,1,.76);
    oriented(rump,tail,[side*.16,0,-.55]);
  }
  return {positions:new Float32Array(positions), normals:new Float32Array(normals),
    weights:new Float32Array(weights), indices:new Uint32Array(indices)};
}
