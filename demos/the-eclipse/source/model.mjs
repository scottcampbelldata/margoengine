import { table } from './ephemeris.mjs';

export const totalSeconds = 10800;
export const utc = Date.UTC(2024, 3, 8, 17, 15, 0);
const radians = Math.PI / 180;
const limit = (n, a, b) => Math.max(a, Math.min(b, n));
const dot = (a,b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
const cross = (a,b) => [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const normalize = v => { const n = Math.hypot(...v); return v.map(x => x/n); };

// Horizons azimuth is east from north. Margo uses east +X, up +Y, north -Z.
function direction(azimuth, elevation) {
  const az = azimuth*radians, el = elevation*radians, h = Math.cos(el);
  return [h*Math.sin(az), Math.sin(el), -h*Math.cos(az)];
}

export function geometry(seconds) {
  const offset = limit(seconds,0,totalSeconds) / 180;
  const lower = Math.floor(offset), blend = offset - lower;
  const row = table[lower].map((value,i) => value + ((table[lower+1]?.[i] ?? value)-value)*blend);
  const sun = direction(row[0],row[1]), moon = direction(row[3],row[4]);
  const forward = dot(sun,moon);
  const right = normalize(cross(sun,[0,1,0])), up = cross(right,sun);
  const sx = dot(right,moon)/forward, sy = dot(up,moon)/forward;
  return {
    second:seconds, sun, moon, azimuth:row[0], elevation:row[1],
    distance:Math.atan2(Math.hypot(...cross(sun,moon)),forward),
    sunRadius:row[2]*radians/7200, moonRadius:row[5]*radians/7200,
    moonX:sx, moonY:sy,
  };
}

function obscured(d, r, R) {
  if (d >= r+R) return 0;
  if (d <= R-r) return 1;
  if (d <= r-R) return (R*R)/(r*r);
  const area = r*r*Math.acos(limit((d*d+r*r-R*R)/(2*d*r),-1,1))
    + R*R*Math.acos(limit((d*d+R*R-r*r)/(2*d*R),-1,1))
    - .5*Math.sqrt(Math.max(0,(-d+r+R)*(d+r-R)*(d-r+R)*(d+r+R)));
  return limit(area/(Math.PI*r*r),0,1);
}

// Mean photospheric intensity on annuli, I(mu)=1-u(1-mu), u=0.60.
function visibleFlux(d,r,R,cover) {
  if (cover === 0 || cover === 1) return 1-cover;
  let all = 0, visible = 0;
  for (let i = 0; i < 192; i++) {
    const a = (i+.5)/192, s = r*a;
    const weight = (.4+.6*Math.sqrt(1-a*a))*a;
    const arc = Math.acos(limit((s*s+d*d-R*R)/(2*s*d),-1,1))/Math.PI;
    all += weight;
    visible += weight*(1-arc);
  }
  return visible/all;
}

export function eclipse(seconds) {
  const g = geometry(seconds);
  const cover = obscured(g.distance,g.sunRadius,g.moonRadius);
  const flux = visibleFlux(g.distance,g.sunRadius,g.moonRadius,cover);
  return { ...g, cover, flux, phase:cover === 1 ? 'Totality' : cover > 0 ? 'Partial eclipse' : 'Full sunlight' };
}

function residual(time, internal) {
  const g = geometry(time);
  return g.distance - (internal ? g.moonRadius-g.sunRadius : g.moonRadius+g.sunRadius);
}

function crossing(a,b,internal) {
  const positive = residual(a,internal) > 0;
  for (let i=0; i<40; i++) {
    const m = (a+b)/2;
    if ((residual(m,internal)>0) === positive) a=m;
    else b=m;
  }
  return (a+b)/2;
}

let low=0, high=totalSeconds;
for(let i=0; i<50; i++){
  const m=low+(high-low)/3, n=high-(high-low)/3;
  if(geometry(m).distance<geometry(n).distance) high=n;
  else low=m;
}
const peak = (low+high)/2;
export const contacts = {
  start:crossing(0,peak,false), total:crossing(0,peak,true), peak,
  exit:crossing(peak,totalSeconds,true), end:crossing(peak,totalSeconds,false),
};
export const initial = Math.round(peak-15*60);

export function clock(second) {
  return new Date(utc + Math.round(second)*1000 - 5*3600000).toISOString().slice(11,19);
}
