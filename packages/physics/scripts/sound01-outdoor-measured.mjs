// Run with built Physics: node packages/physics/scripts/sound01-outdoor-measured.mjs
//
// Karsten Bo Rasmussen (1994), Model experiments related to outdoor
// propagation over an earth berm, JASA 96, 3617–3620.
// https://doi.org/10.1121/1.411404
// https://backend.orbit.dtu.dk/ws/files/4415609/Rasmussen.pdf
// PDF SHA256 ab096424b976d4165be0576a31c73f7828ae3aecc628a4a7cb7833243565a855.
//
// Geometry is independently given in §I, Fig. 1 and the figure captions.
// The chamber used still homogeneous air, a 1:25 scale, a hard 90° plywood
// crest, and canvas over a hard floor (equivalent grass flow resistivity
// 500 kN s m^-4 at full scale). Exact room atmosphere and transducer
// uncertainty are unspecified. Use fixed engine defaults (20 °C, 50% RH,
// 101325 Pa) and its rigid plane as the baseline. The reflection-off
// control shows the effect of the plane approximation. Neither uses
// measured levels to set any input.
//
// Below are sparse factual estimates read from the solid, measured curves.
// The held-out observable is the full-record response. Read the
// four standard engine centre frequencies in the plotted range 250–2000 Hz.
// The x-axis uses the 100 and 1000 Hz labels on a log scale. The y-axis is
// linear in dB relative to a same-distance free-field experiment. At 160 dpi,
// scale and crop uncertainty of about two pixels horizontally and a few
// vertically is allowed, with wider intervals on steep or obscured traces.
// These rounded intervals describe figure reading only. §III notes possible
// weak measurement nonlinearity, with no uncertainty for each frequency.
// The PDF and raw traces are not redistributed.
//
// Model geometry and frequency are in full-scale coordinates, so geometry
// relative to wavelength is the same. Normalizing to free field removes
// the common propagation and source level. Atmospheric absorption does not
// scale exactly (§I). The reported curves came from 16 averaged impulses
// at 600 kHz, 1024 FFT points, or nominal 23.4375 Hz bin spacing at full
// scale. The plotted line is a spectral estimate at a tone frequency.
// Figures 7–9 are edited windows indexed by sample. The paper does not
// establish a shared trigger offset, so scoring uses the spectrum.
//
// Alternatives examined: White & Gilbert (1989), Application of the
// parabolic equation to the outdoor propagation of sound,
// https://doi.org/10.1016/0003-682X(89)90062-5, uses a separately reconstructed
// mean effective-speed profile and finite impedance. Farina & Maffei (1995),
// Sound propagation outdoors: comparison between numerical previsions and
// experimental results,
// https://www.witpress.com/Secure/elibrary/papers/COMAC95/COMAC95007FU.pdf,
// measured with MLS near buildings, including facade geometry and source
// directivity. The simpler reported berm geometry isolates the current
// solver's terrain and ground response.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { TerrainBed } from '../dist/earth.js';
import { OUTDOOR_SOUND_BANDS, OutdoorSound } from '../dist/outdoor-sound.js';
import { PhysicsWorld } from '../dist/world.js';

const frequencies = [250, 500, 1000, 2000];
const references = [
  {
    figure: 3,
    receiverHeight: 0.5,
    observedDb: [
      [-16.5, 0.7],
      [-14.4, 0.8],
      [-19.3, 0.6],
      [-18.6, 2],
    ],
  },
  {
    figure: 4,
    receiverHeight: 1.25,
    observedDb: [
      [-20.7, 0.9],
      [-15.5, 0.8],
      [-14.5, 1.2],
      [-21.6, 2.5],
    ],
  },
  {
    figure: 5,
    receiverHeight: 10,
    observedDb: [
      [-10.8, 0.7],
      [-5.9, 0.8],
      [-7.9, 1.2],
      [-12.3, 1.8],
    ],
  },
  {
    figure: 6,
    receiverHeight: 15,
    observedDb: [
      [-1.9, 2],
      [0.6, 0.8],
      [-0.9, 1],
      [-0.6, 1],
    ],
  },
];

const sourceHeight = 1.25;
const distanceX = 52.5;
const crestX = 17.5;
const crestHeight = 5;
const crest = (x) => Math.max(0, crestHeight - Math.abs(x - crestX));
const scale = 25;
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } });
const bed = new TerrainBed();
world.add(bed, {
  columns: 21,
  rows: 1,
  width: distanceX,
  depth: 2.4 * scale,
  centre: [distanceX / 2, 0],
  elevations: crest,
});
const links = references.map(({ receiverHeight }) => ({
  source: [0, sourceHeight, 0],
  listener: [distanceX, receiverHeight, 0],
}));
const free = new OutdoorSound('rasmussen-free');
const berm = new OutdoorSound('rasmussen-berm');
const noReflection = new OutdoorSound('rasmussen-no-reflection');
world.add(free, { links });
world.add(berm, { links, bed: bed.bed, groundY: 0 });
world.add(noReflection, { links, bed: bed.bed, groundY: 0, groundReflection: 0 });
world.advance(1);

const results = references.map(({ figure, receiverHeight, observedDb }, row) => {
  const direct = free.read(row);
  const received = berm.read(row);
  const groundOff = noReflection.read(row);
  const directRayHeight = sourceHeight + ((receiverHeight - sourceHeight) * crestX) / distanceX;
  assert.equal(received.blocked, directRayHeight < crestHeight, 'The model must intersect the stated berm geometry.');
  assert.equal(direct.blocked, false);
  const specularX = (sourceHeight * distanceX) / (sourceHeight + receiverHeight);
  const specularRayHeight = (Math.abs(crestX - specularX) * (sourceHeight + receiverHeight)) / distanceX;
  return {
    figure,
    receiverHeight,
    directRayHeightAtCrestMetres: directRayHeight,
    geometricalGroundRayHeightAtCrestMetres: specularRayHeight,
    geometricalGroundRayIsOccludedAtCrest: specularRayHeight < crestHeight,
    predictedBlocked: received.blocked,
    predictedExcessDelaySeconds: received.delaySeconds - direct.delaySeconds,
    spectrum: frequencies.map((frequency, i) => {
      const band = OUTDOOR_SOUND_BANDS.indexOf(frequency);
      assert.notEqual(band, -1, 'The band centre must remain an exact model frequency.');
      const [measuredDb, figureReadingHalfRangeDb] = observedDb[i];
      const predictedDb = received.gainDb[band] - direct.gainDb[band];
      const differenceDb = predictedDb - measuredDb;
      return {
        frequency,
        measuredDb,
        figureReadingHalfRangeDb,
        predictedDb,
        differenceDb,
        withinFigureReadingRange: Math.abs(differenceDb) <= figureReadingHalfRangeDb,
        reflectionOffDb: groundOff.gainDb[band] - direct.gainDb[band],
      };
    }),
  };
});

const entry = new URL('../dist/outdoor-sound.js', import.meta.url);
const entryBytes = await readFile(entry);
const linkedName = /from ["'](\.\/outdoor-sound-[^"']+\.js)["']/.exec(entryBytes.toString())?.[1];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
console.log(
  JSON.stringify(
    {
      geometry: { sourceHeight, distanceX, crestX, crestHeight, scale },
      source: 'Rasmussen 1994, Figs. 3–6, measured solid curve relative to free field',
      entrySha256: hash(entryBytes),
      ...(linkedName && { linkedSha256: hash(await readFile(new URL(linkedName, entry))) }),
      results,
    },
    null,
    2,
  ),
);
