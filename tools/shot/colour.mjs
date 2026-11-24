// Colour difference for the master encode's checks (P3): 8-bit sRGB to CIELAB (D65) and the CIEDE2000 difference.
// Sources: IEC 61966-2-1:1999 (sRGB and its matrix to XYZ); CIE 15:2004 (CIELAB); G. Sharma, W. Wu and E. N. Dalal,
// "The CIEDE2000 color-difference formula: implementation notes, supplementary test data, and mathematical
// observations", Color Research and Application 30(1), 2005 (the formula as implemented here, and its test pairs in
// tests/shot-encode.test.js).

// The white of the IEC matrix below (its rows' sums), so sRGB white is a = b = 0 exactly.
const D65 = [0.9505, 1, 1.089];
const decode = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);

/** 8-bit sRGB to CIELAB under D65: [L, a, b]. */
export function srgbToLab(r, g, b) {
  const [R, G, B] = [r, g, b].map((c) => decode(c / 255));
  const X = 0.4124 * R + 0.3576 * G + 0.1805 * B,
    Y = 0.2126 * R + 0.7152 * G + 0.0722 * B,
    Z = 0.0193 * R + 0.1192 * G + 0.9505 * B;
  const [fx, fy, fz] = [X / D65[0], Y / D65[1], Z / D65[2]].map(f);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** The CIEDE2000 colour difference of two CIELAB colours (kL = kC = kH = 1). */
export function deltaE2000([L1, a1, b1], [L2, a2, b2]) {
  const rad = Math.PI / 180,
    C1 = Math.hypot(a1, b1),
    C2 = Math.hypot(a2, b2),
    Cbar7 = ((C1 + C2) / 2) ** 7,
    G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + 25 ** 7))),
    ap1 = (1 + G) * a1,
    ap2 = (1 + G) * a2,
    Cp1 = Math.hypot(ap1, b1),
    Cp2 = Math.hypot(ap2, b2),
    hue = (b, a) => (b === 0 && a === 0 ? 0 : ((Math.atan2(b, a) / rad) % 360 + 360) % 360),
    hp1 = hue(b1, ap1),
    hp2 = hue(b2, ap2),
    dL = L2 - L1,
    dC = Cp2 - Cp1;
  let dh = 0;
  if (Cp1 * Cp2 !== 0) {
    dh = hp2 - hp1;
    if (dh > 180) dh -= 360;
    else if (dh < -180) dh += 360;
  }
  const dH = 2 * Math.sqrt(Cp1 * Cp2) * Math.sin((dh / 2) * rad),
    Lbar = (L1 + L2) / 2,
    Cbar = (Cp1 + Cp2) / 2;
  let hbar = hp1 + hp2;
  if (Cp1 * Cp2 !== 0) {
    if (Math.abs(hp1 - hp2) <= 180) hbar /= 2;
    else hbar = hp1 + hp2 < 360 ? (hbar + 360) / 2 : (hbar - 360) / 2;
  }
  const T =
      1 -
      0.17 * Math.cos((hbar - 30) * rad) +
      0.24 * Math.cos(2 * hbar * rad) +
      0.32 * Math.cos((3 * hbar + 6) * rad) -
      0.2 * Math.cos((4 * hbar - 63) * rad),
    dTheta = 30 * Math.exp(-(((hbar - 275) / 25) ** 2)),
    Cbar7p = Cbar ** 7,
    RC = 2 * Math.sqrt(Cbar7p / (Cbar7p + 25 ** 7)),
    SL = 1 + (0.015 * (Lbar - 50) ** 2) / Math.sqrt(20 + (Lbar - 50) ** 2),
    SC = 1 + 0.045 * Cbar,
    SH = 1 + 0.015 * Cbar * T,
    RT = -Math.sin(2 * dTheta * rad) * RC;
  return Math.sqrt((dL / SL) ** 2 + (dC / SC) ** 2 + (dH / SH) ** 2 + RT * (dC / SC) * (dH / SH));
}

/**
 * Mean and largest CIEDE2000 difference between two RGB images of one size (`a` and `b` with `channels` bytes a
 * pixel, 3 or 4), over every `step`-th pixel in both directions.
 */
export function imageDeltaE(a, b, { width, height, channelsA = 4, channelsB = 3, step = 1 }) {
  let sum = 0,
    max = 0,
    count = 0;
  for (let y = 0; y < height; y += step)
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * channelsA,
        j = (y * width + x) * channelsB,
        e = deltaE2000(srgbToLab(a[i], a[i + 1], a[i + 2]), srgbToLab(b[j], b[j + 1], b[j + 2]));
      sum += e;
      if (e > max) max = e;
      count++;
    }
  return { mean: sum / count, max };
}

/** The Laplacian of an RGB image's luma (BT.709 weights on the 8-bit values), 0 on the border: its finest detail. */
export function fineDetail(rgb, { width, height, channels = 3 }) {
  const luma = new Float32Array(width * height),
    out = new Float32Array(width * height);
  for (let p = 0; p < width * height; p++)
    luma[p] = 0.2126 * rgb[p * channels] + 0.7152 * rgb[p * channels + 1] + 0.0722 * rgb[p * channels + 2];
  for (let y = 1; y < height - 1; y++)
    for (let x = 1; x < width - 1; x++) {
      const p = y * width + x;
      out[p] = 4 * luma[p] - luma[p - 1] - luma[p + 1] - luma[p - width] - luma[p + width];
    }
  return out;
}

/**
 * The share of an image's fine detail (thin rain, single-pixel sparks, foam: what a platform's recompression smooths
 * away first) that a copy keeps: the copy's Laplacian projected on the original's, so blocking and ringing the copy
 * adds do not count as detail. 1 is all of it; an image with no fine detail keeps all of it.
 */
export function detailKept(original, copy, size) {
  const a = fineDetail(original, size),
    b = fineDetail(copy, size);
  let dot = 0,
    norm = 0;
  for (let p = 0; p < a.length; p++) {
    dot += a[p] * b[p];
    norm += a[p] * a[p];
  }
  return norm ? dot / norm : 1;
}
