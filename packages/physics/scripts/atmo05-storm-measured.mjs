import { StormVortex, VortexForcing, stormWaterDrag } from '@margoengine/physics/vortices';
import { PhysicsWorld, regionWords } from '@margoengine/physics/world';

// NOAA/NHC historical ATCF B-deck for AL132003, BEST records 2003091312, 2003091318 and 2003091400.
// https://ftp.nhc.noaa.gov/atcf/archive/2003/bal132003.dat.gz
// https://science.nrlmry.navy.mil/atcf/docs/database/new/abrdeck.html
// POUTER (pressure of outermost closed isobar) is the ambient proxy. RMW is in nautical miles.
// Use 1800 UTC for the nominal storm and the adjacent values to show variation during the sampling window.
// No best-track wind speed or observed dropsonde speed is used as a model input.
const track = [
  { utc: '2003-09-13T12:00Z', latitude: 22.1, centralHPa: 935, outerHPa: 1013, radiusNmi: 20 },
  { utc: '2003-09-13T18:00Z', latitude: 22.5, centralHPa: 932, outerHPa: 1013, radiusNmi: 20 },
  { utc: '2003-09-14T00:00Z', latitude: 22.9, centralHPa: 935, outerHPa: 1013, radiusNmi: 25 },
];

// Montgomery, Bell, Aberson & Black (2006), Hurricane Isabel (2003), Part I. Fig. 4a–b.
// https://doi.org/10.1175/BAMS-87-10-1335
// https://tropical.colostate.edu/Publications/papers/Montgomery_etal_BAMS2006.pdf
// Sparse rounded readings from the observed storm-relative curves for 1600–2300 UTC on Sep 13.
// At 205 dpi the axes have about 4.36 pixels/(m/s) in (a), 9.25 in (b), and 5.38 m/pixel vertically.
// The colored line and axis alignment permit comparison within about 1 m/s and 15 m in readout.
// The paper gives no error bars for Fig. 4. The separate Fig. 7 eyewall statistic is 76 ± 6 m/s (1 SD).
const profiles = [
  {
    name: 'eyewall',
    radialBandKm: [40, 50],
    readings: [
      [100, 61.4, -25.3],
      [500, 73.6, -13.5],
      [1000, 77.2, -2.4],
      [1500, 72.0, 1.7],
    ],
  },
  {
    name: 'outer core',
    radialBandKm: [150, 250],
    readings: [
      [100, 20.6, -12.6],
      [500, 25.4, -10.1],
      [1000, 27.3, -4.1],
      [1500, 26.9, -2.1],
    ],
  },
];

function range(values) {
  return [Math.min(...values), Math.max(...values)];
}

function probeWind({ latitude, centralHPa, outerHPa, radiusNmi }, probes) {
  const vortex = new StormVortex({
    kind: 'cyclone',
    latitude,
    radius: radiusNmi * 1852,
    ambientPressure: outerHPa * 100,
    pressureDrop: (outerHPa - centralHPa) * 100,
  });
  const forcing = new VortexForcing();
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(forcing, { vortex, probes });
  world.advance(1);
  const { region } = world.fields.port(forcing.probeField.name);
  const words = regionWords(world.memory, region);
  // Along +X, cyclonic tangential flow in the Northern Hemisphere points toward −Z; outward radial is +X.
  return probes.map((_, i) => ({ tangential: -words[6 * i + 2], radial: words[6 * i] }));
}

const isabelProfiles = profiles.map(({ name, radialBandKm: [inner, outer], readings }) => {
  const mid = (inner + outer) / 2;
  const radii = Array.from({ length: outer - inner + 1 }, (_, i) => inner + i);
  const probes = readings.flatMap(([height]) => radii.map((r) => [r * 1000, height, 0]));
  const values = track.map((entry) => probeWind(entry, probes));
  return {
    name,
    radialBandKm: [inner, outer],
    samples: readings.map(([heightM, tangential, radial], i) => {
      const start = i * radii.length;
      const sampled = values.flatMap((rows) => rows.slice(start, start + radii.length));
      const predicted = values[1][start + mid - inner];
      return {
        heightM,
        observed: { tangential, radial },
        predictedAtMidRadius: predicted,
        difference: { tangential: predicted.tangential - tangential, radial: predicted.radial - radial },
        trackAndRadialBandSensitivity: {
          tangential: range(sampled.map((wind) => wind.tangential)),
          radial: range(sampled.map((wind) => wind.radial)),
        },
      };
    }),
  };
});

// Powell, Vickery & Reinhold (2003), "Reduced drag coefficient for high wind speeds in tropical cyclones",
// Nature 422, 279–283, Fig. 3c, 10–150 m profile fits (open squares and the bars at the same x coordinate).
// https://doi.org/10.1038/nature01481
// The field estimates infer drag and U10 jointly from GPS sonde shear; this checks the bulk law conditional
// on U10. None of the coefficients is taken from the secondary reference curves above/below their points.
// Each row is approximate U10 in m/s, 1000 Cd, and the plotted 95% confidence band.
// Production cap provenance: Curcic & Haus (2020), new independent wind-wave tank measurements.
// https://doi.org/10.1029/2020GL087647
const dragBins = [
  [27.31, 1.96, 1.78, 2.169],
  [32.97, 2.145, 1.972, 2.342],
  [40.92, 1.86, 1.622, 2.155],
  [50.8, 1.499, 1.338, 1.691],
];
const drag = dragBins.map(([u10, estimatedCd, lo, hi]) => {
  const predictedCd = 1e3 * stormWaterDrag(u10);
  return { u10, estimatedCd, plotted95: [lo, hi], predictedCd, difference: predictedCd - estimatedCd };
});

console.log(
  JSON.stringify(
    {
      isabel: {
        units: 'm/s in the storm-relative frame, outward-positive radial',
        track,
        traceReadout: { speedMps: 1, heightM: 15 },
        profiles: isabelProfiles,
        reportedEyewallJet: { heightM: 1000, radiusKm: 42, mean: 76, standardDeviation: 6 },
        modeledEyewallJet: probeWind(track[1], [[42000, 1000, 0]])[0],
      },
      drag: {
        units: 'm/s for U10; 1000 times dimensionless neutral drag coefficient',
        traceReadout: { speedMps: 0.1, scaledCd: 0.03 },
        bins: drag,
      },
    },
    null,
    2,
  ),
);
