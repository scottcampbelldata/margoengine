export const lunarSpeed = 28.9841042;
export const solarSpeed = 30;
export const lunarAmplitude = .88;
export const solarAmplitude = .39;
export const beatHours = 360 / (solarSpeed - lunarSpeed);
export const hours = 24;
const rad = Math.PI / 180;
const m = lunarSpeed * rad;
const s = solarSpeed * rad;

function at(time) {
  const lunar = lunarAmplitude * Math.cos(m * time);
  const solar = solarAmplitude * Math.cos(s * time);
  return {
    lunar, solar,
    height: lunar + solar,
    rate: -m * lunarAmplitude * Math.sin(m * time) - s * solarAmplitude * Math.sin(s * time),
  };
}

function epoch(mode) {
  return mode === 'neap' ? beatHours / 2 : 0;
}

export function tide(mode, hour) {
  return at(epoch(mode) + Math.max(0, Math.min(hours, hour)));
}

export function dailyRange(mode) {
  const start = epoch(mode);
  const end = start + hours;
  const values = [at(start).height, at(end).height];
  let previous = at(start).rate;
  for (let i = 1; i <= 192; i++) {
    const right = start + i / 8;
    const next = at(right).rate;
    if (next === 0) values.push(at(right).height);
    else if (previous * next < 0) {
      let a = right - .125;
      let b = right;
      for (let j = 0; j < 28; j++) {
        const mid = (a + b) / 2;
        if (Math.sign(at(mid).rate) === Math.sign(previous)) a = mid;
        else b = mid;
      }
      values.push(at((a + b) / 2).height);
    }
    previous = next;
  }
  const low = Math.min(...values);
  const high = Math.max(...values);
  return { high, low, range: high - low };
}

export function clock(hour) {
  const minute = Math.round(hour * 60);
  return String(Math.floor(minute / 60)).padStart(2, '0') + ':' + String(minute % 60).padStart(2, '0');
}