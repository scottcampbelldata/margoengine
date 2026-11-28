// Room coordinates are X (width), Y (height), Z (length), in metres.
export const room = Object.freeze({ width: 4.8, height: 2.8, length: 6.2 });
export const source = Object.freeze([-1.53, 0.47, -2.20]);
export const listener = Object.freeze([0, 1.15, 1.26]);
export const speedOfSound = 343;
const inverseQ = 1 / 24;
const modalLimit = 160;

export function modeFrequency(x, y, z) {
  return (speedOfSound / 2) * Math.hypot(x / room.width, y / room.height, z / room.length);
}

function axisValue(order, position, size, origin) {
  return Math.cos(order * Math.PI * (position - origin) / size);
}

function shape({ x, y, z }, point) {
  return axisValue(x, point[0], room.width, -room.width / 2)
    * axisValue(y, point[1], room.height, 0)
    * axisValue(z, point[2], room.length, -room.length / 2);
}

const modes = [];
for (let x = 0; x <= Math.floor(2 * modalLimit * room.width / speedOfSound); x++) {
  for (let y = 0; y <= Math.floor(2 * modalLimit * room.height / speedOfSound); y++) {
    for (let z = 0; z <= Math.floor(2 * modalLimit * room.length / speedOfSound); z++) {
      const frequency = modeFrequency(x, y, z);
      if (!frequency || frequency > modalLimit) continue;
      const mode = { x, y, z, frequency };
      // Integral of cos² over an axis is half its length for every nonzero order.
      const norm = 2 ** (Number(x !== 0) + Number(y !== 0) + Number(z !== 0));
      modes.push({ ...mode, drive: norm * shape(mode, source) });
    }
  }
}

export const presets = [
  { label: 'Length', frequency: modeFrequency(0, 0, 1) },
  { label: 'Length + width', frequency: modeFrequency(1, 0, 1) },
  { label: 'Height', frequency: modeFrequency(0, 1, 0) },
  { label: 'Width + height', frequency: modeFrequency(1, 1, 0) },
].map(({ label, frequency }) => Object.freeze({ label, frequency: Number(frequency.toFixed(1)) }));

function sampleAxis(points, axis, size, origin, order) {
  const max = Math.max(...modes.map((mode) => mode[order]));
  return Array.from({ length:max+1 },(_,i) => Float32Array.from(points,(p) => axisValue(i,p[axis],size,origin)));
}

export function createRoomResponse(points) {
  const xs = sampleAxis(points,0,room.width,-room.width/2,'x');
  const ys = sampleAxis(points,1,room.height,0,'y');
  const zs = sampleAxis(points,2,room.length,-room.length/2,'z');
  const basis = modes.map(({ x,y,z }) => xs[x].map((value,i) => value*ys[y][i]*zs[z][i]));
  const signed = new Float32Array(points.length);
  const real = new Float32Array(points.length);
  const imaginary = new Float32Array(points.length);
  return (frequency) => {
    const forced = frequency * frequency;
    const coefficients = modes.map((mode) => {
      const stiffness = mode.frequency ** 2 - forced;
      const resistance = mode.frequency * frequency * inverseQ;
      const scale = mode.drive * forced / (stiffness ** 2 + resistance ** 2);
      return { real: scale * stiffness, imaginary: -scale * resistance, mode };
    });
    const rank = (coefficient) => coefficient.real ** 2 + coefficient.imaginary ** 2;
    const strongest = coefficients.reduce((best, value) => rank(value) > rank(best) ? value : best);
    const phase = Math.atan2(strongest.imaginary, strongest.real);
    const phaseReal = Math.cos(phase), phaseImaginary = Math.sin(phase);
    real.fill(0);
    imaginary.fill(0);
    for (let m = 0; m < coefficients.length; m++) {
      const color = coefficients[m], samples = basis[m];
      for (let i = 0; i < samples.length; i++) {
        real[i] += color.real * samples[i];
        imaginary[i] += color.imaginary * samples[i];
      }
    }
    let peak = 0;
    for (let i = 0; i < signed.length; i++) {
      signed[i] = real[i] * phaseReal + imaginary[i] * phaseImaginary;
      peak = Math.max(peak, Math.hypot(real[i], imaginary[i]));
    }
    const scale = Math.max(peak, Number.EPSILON);
    for (let i = 0; i < signed.length; i++) signed[i] /= scale;
    return {
      signed,
      strongest: strongest.mode,
      level: 20 * Math.log10(Math.max(0.00001, Math.hypot(real.at(-1), imaginary.at(-1)) / scale)),
    };
  };
}
