export const soundSpeed = 343.2;
export const source = [-3, 3.4, -26];
export const walls = [-46, 46];

export function measure(listenerX) {
  const receiver = [listenerX, 3.4, 32];
  const distance = (a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2]);
  const directLength = distance(source, receiver);
  const direct = { points: [source, receiver], length: directLength, time: directLength / soundSpeed, gain: 1 };
  const reflected = walls.map((wall, index) => {
    const mirror = [2*wall-source[0], source[1], source[2]];
    const fraction = (wall-receiver[0])/(mirror[0]-receiver[0]);
    const bounce = [wall, receiver[1]+fraction*(mirror[1]-receiver[1]), receiver[2]+fraction*(mirror[2]-receiver[2])];
    const length = distance(mirror, receiver);
    return { wall, points: [source,bounce,receiver], length, time: length / soundSpeed,
      delay: (length-directLength)/soundSpeed, gain: [.77,.71][index]*directLength/length };
  });
  return { receiver, direct, reflected };
}

export function pointAlong(points, distance) {
  for(let i=1;i<points.length;i++){
    const a=points[i-1],b=points[i];
    const span=Math.hypot(...b.map((value,axis)=>value-a[axis]));
    if(distance<=span)return a.map((value,axis)=>value+(b[axis]-value)*distance/span);
    distance-=span;
  }
  return points.at(-1);
}

