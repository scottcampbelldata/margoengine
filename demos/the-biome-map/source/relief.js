export const size = [20480, 17408];
export const reliefScale = 3950;
export const sceneSize = [12.65, 10.75];
export const fieldSize = 112;
export const biomeKeys = ['temperate', 'savanna', 'tundra', 'desert'];

const clip = (v, low = 0, high = 1) => Math.max(low, Math.min(high, v));
const mix = (a, b, w) => a + (b - a) * w;
function hash(x, z) {
  let state = Math.imul(x + 2077, 0x45d9f3b) ^ Math.imul(z + 5841, 0x32f652f7);
  state = Math.imul(state ^ state >>> 16, 0x85ebca6b);
  return ((state ^ state >>> 15) >>> 0) / 4294967295;
}
function noise(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const u = x - ix, v = z - iz;
  const sx = u*u*(3 - 2*u), sz = v*v*(3 - 2*v);
  return mix(mix(hash(ix, iz), hash(ix+1, iz), sx),
    mix(hash(ix, iz+1), hash(ix+1, iz+1), sx), sz);
}
function ellipsoid(x, z, cx, cz, rx, rz, angle) {
  const a = x - cx, b = z - cz, c = Math.cos(angle), s = Math.sin(angle);
  return 1 - ((c*a + s*b)/rx)**2 - ((-s*a + c*b)/rz)**2;
}

/** Continuous land elevation and coastal bathymetry in model metres. */
export function relief(u, v) {
  const x = (u-.5)*2;
  const z = (v-.5)*2;
  const bendX = x + .092*(noise(x*3.1 + 3.0, z*3.9) -.5);
  const bendZ = z + .183*(noise(x*2.9 - 7.2, z*4.1 + 8.4) -.5);
  const main = Math.max(
    ellipsoid(bendX,bendZ,-.30,-.41,.52,.35,-.55),
    ellipsoid(bendX,bendZ,-.12,-.12,.58,.54,.24),
    ellipsoid(bendX,bendZ,.22,.22,.57,.41,-.54),
    ellipsoid(bendX,bendZ,.34,.49,.31,.30,.4),
    ellipsoid(bendX,bendZ,.43,.61,.16,.28,-.58),
    ellipsoid(bendX,bendZ,-.66,.03,.11,.20,-.34),
    ellipsoid(bendX,bendZ,.60,.67,.115,.17,.28) - .12,
    ellipsoid(bendX,bendZ,.71,.79,.048,.11,-.55),
  );
  const coastDetail = .28 * (noise(x*7+1.3,z*7+10) -.53)
    + .108*(noise(x*18-4,z*18) -.5) + .045*(noise(x*43,z*43+3)-.5);
  const cove = .42*Math.exp(-(((x+.37)/.22)**2) - ((z-.36)/.17)**2)
    + .32*Math.exp(-(((x-.45)/.23)**2) - ((z+.45)/.15)**2)
    + .54*Math.exp(-(((x+.67)/.16)**2) - ((z-.22)/.12)**2);
  const shore = main + coastDetail - cove;
  if (shore <= 0) return -Math.min(1100, -shore*705 + 52*shore*shore);

  const ridgeX = -.31 + .23*(z+.53) + .074*Math.sin(5.7*z+.61);
  const spine = Math.exp(-(((x-ridgeX)/.23)**2)) * Math.exp(-(((z+.10)/.69)**2));
  const north = .76*Math.exp(-(((x+.40)/.34)**2) - ((z+.49)/.33)**2);
  const mesa = .69*Math.exp(-(((x-.32)/.33)**2) - ((z-.31)/.21)**2);
  const mountain = Math.max(spine, north, mesa*.57);
  const gorge = Math.abs(noise(x*3.8 + 1.5, z*3.8+7.2) -.51);
  const folds = Math.min(1, gorge*2.6)**.72;
  const ridges = .56*folds + .28*Math.abs(noise(x*10,z*10-2)-.5)*2
    + .16*Math.abs(noise(x*25,z*25+3)-.5)*2;
  const apron = clip(shore * 3.1);
  return apron*(62 + 183*shore + 420*mesa + 2770 * mountain * (.43 + 1.26*ridges))
    + 68 * apron * noise(x*39+7,z*39-3);
}
