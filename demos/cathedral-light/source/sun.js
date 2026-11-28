import { bayCenters, halfWidth, windowCenterHeight } from './nave.js';

export const firstMinute = 8 * 60;
export const lastMinute = 17 * 60;
export const defaultMinute = 9 * 60 + 38;
const radians = Math.PI / 180;
const latitude = 48.2 * radians;
const declination = -4.0 * radians;
const openingOrigin = [halfWidth,windowCenterHeight,-2.8];

export function sunlight(minutes) {
  const hourAngle = (minutes/60-12)*15*radians;
  const east = -Math.cos(declination)*Math.sin(hourAngle);
  const south = Math.sin(latitude)*Math.cos(declination)*Math.cos(hourAngle)
    - Math.cos(latitude)*Math.sin(declination);
  const up = Math.sin(latitude)*Math.sin(declination)
    + Math.cos(latitude)*Math.cos(declination)*Math.cos(hourAngle);
  const direction=[south,up,-east];
  const elevation=Math.asin(up)/radians;
  const azimuth=(Math.atan2(east,-south)/radians+360)%360;
  const distance=windowCenterHeight/up;
  const floor=openingOrigin.map((value,i)=>value-direction[i]*distance);
  const fall=halfWidth-floor[0];
  const direct=Math.max(0,Math.min(1,(up-.055)/.40));
  const warmth=Math.max(0,1-up*1.64);
  return {direction,azimuth,elevation,floor,direct,warmth,fall};
}

export function lightsFor(sun) {
  const {direction,direct,warmth}=sun;
  const distance=35;
  const points=bayCenters.map((center,i) => {
    const filtered=i%3===0?[1,.70,.43]:i%3===1?[1,.84,.61]:[.79,.82,.77];
    const color=[filtered[0],filtered[1]*(1-warmth*.16),filtered[2]*(1-warmth*.32)];
    const opening=[halfWidth+.025,windowCenterHeight,center];
    return {
      position:opening.map((value,k)=>value+direction[k]*distance),
      direction:direction.map(v=>-v),
      color, range:180, decay:0, intensity:direct*(i%3===2?21.0:29.1),
      innerAngle:.074, outerAngle:.105,
      shadow:{near:9,far:100},
    };
  });
  points.push(
    { position:[.1,8.2,-15.8],color:[.46,.55,.69],range:18,intensity:4.4 },
    { position:[-.4,3.3,-14.18],color:[.97,.52,.25],range:8,intensity:7.5 },
    { position:[-3.7,8.0,8.9],color:[.44,.54,.71],range:22,intensity:4.5 },
  );
  return points;
}

export function formatTime(minutes) {
  return Math.floor(minutes/60).toString().padStart(2,'0')+':'+(minutes%60).toString().padStart(2,'0');
}
