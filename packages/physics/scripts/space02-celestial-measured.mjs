// Quaglia, Irwin, Pessi, Kafka & Emmanouilidis (2023), ATSE2023: Using Photodiode Loggers
// to Estimate the Eclipse Solar Radius, Journal for Occultation Astronomy 2023-4 pp. 16–22,
// https://iota-es.de/JOA/JOA2023_4.pdf, p. 16 (site), and p. 20 (manual UTC flash-spectrum contacts).
// Quaglia, Irwin & Pessi (2024), Experimentally Assessing the Accuracy of Eclipse Path Maps,
// Journal for Occultation Astronomy 2024-4 pp. 3–12, https://iota-es.de/JOA/JOA2024_4.pdf.
// Stephenville GPS clock measurements are on p. 7, and the independent camera windows on p. 8.
// The observers' map appendix (https://www.besselianelements.com/eclipse-maps-accuracy/) gives
// the marked location in its Jubier local-circumstances image. Only its coordinates are used.
// Gunter's surveyed site and photographs are on p. 9. No photographs or inferred solar radius are reused.
// Independent Earth orientation: https://maia.usno.navy.mil/ser7/finals2000A.all (final Bulletin B columns).
// Run: node scripts/run-with-timeout.mjs --max=1 -- node packages/physics/scripts/space02-celestial-measured.mjs

import assert from 'node:assert/strict';
import { CelestialSolver } from '../dist/celestial.js';
import { PhysicsWorld, worldMemory } from '../dist/world.js';

const rate = { num: 60, den: 1 };
const j2000NominalNoon = Date.parse('2000-01-01T12:00:00Z');
const ttMinusUTC = 69.184; // TAI − UTC = 37 s since 2017-01-01, TT − TAI = 32.184 s.
const radians = (degrees) => (degrees * Math.PI) / 180;
const dms = (degrees, minutes, seconds) => degrees + minutes / 60 + seconds / 3600;

const events = [
  {
    date: '2023-04-20',
    window: ['03:00:00', '04:00:00'],
    // USNO / IERS finals2000A.all, final Bulletin B fields, MJD 60054 and 60055.
    eop: [
      [0.005723, 0.450456, -0.0333578],
      [0.00743, 0.452633, -0.0339749],
    ],
    sites: [
      {
        name: 'Cape Range Site 1, Western Australia',
        latitudeDeg: -dms(22, 0, 22.5),
        longitudeDeg: dms(113, 56, 14.7),
        height: -1,
        observed: { c2: '03:29:38.400', c3: '03:29:56.500', duration: 18.1 },
        limit:
          'GPS timestamp recording, human flash-spectrum threshold and reaction time. Reporting to 0.1 s does not quantify those errors.',
      },
    ],
  },
  {
    date: '2024-04-08',
    window: ['18:00:00', '19:15:00'],
    // Same independently measured Earth orientation series, MJD 60408 and 60409.
    eop: [
      [-0.00909, 0.356351, -0.0158648],
      [-0.009231, 0.358857, -0.0167891],
    ],
    sites: [
      {
        name: 'Stephenville City Park, Texas',
        latitudeDeg: dms(32, 12, 58.24),
        longitudeDeg: -dms(98, 12, 9.69),
        height: 397,
        observed: {
          c2: '18:39:06.600',
          c3: '18:39:20.300',
          duration: 13.7,
          cameraC2: ['18:39:04.600', '18:39:07.600'],
          cameraC3: ['18:39:17.500', '18:39:20.500'],
        },
        limit:
          'Marked map point and mapped elevation. Camera intervals come from photospheric continuum visibility. The event timer used a GPS clock and a human observer.',
      },
      {
        name: 'Gunter City Park, Texas',
        latitudeDeg: dms(33, 26, 39.8),
        longitudeDeg: -dms(96, 44, 43.2),
        height: 185,
        observed: { beadsVisibleThroughMaximum: true },
        limit:
          'Independent photographs span 16 seconds around peak; beads remained visible. No precisely timed contacts are inferred.',
      },
    ],
  },
];

const iso = (date, hms) => Date.parse(`${date}T${hms}Z`);
const localSite = ({ latitudeDeg, longitudeDeg, height }) => ({
  latitude: radians(latitudeDeg),
  longitude: radians(longitudeDeg),
  height,
});
const bracketMidpoint = ([before, after]) => (before + after) / 2;
const utcMidpoint = (bracket) => new Date(bracketMidpoint(bracket)).toISOString();
const utcBracket = (bracket) => bracket.map((time) => new Date(time).toISOString());

function evaluate(event, sites, step, measuredOrientation = true) {
  const from = iso(event.date, event.window[0]);
  const to = iso(event.date, event.window[1]);
  const frames = (to - from) / (1000 * step);
  assert.ok(Number.isInteger(frames));
  const midDayFraction = ((from + to) / 2 - iso(event.date, '00:00:00')) / 86_400_000;
  // The daily Bulletin B values are linearly interpolated to the window midpoint and held there.
  // The drift across each window is much less than 0.001 s in UT1 and 0.001 arcsecond in pole position.
  const [xp, yp, dut1] = event.eop[0].map((value, i) => value + midDayFraction * (event.eop[1][i] - value));
  const time = (from - j2000NominalNoon) / 1000;
  const solver = new CelestialSolver();
  const world = new PhysicsWorld({ rate, memory: worldMemory(false) }).add(solver, {
    epoch: { ut1Seconds: time + (measuredOrientation ? dut1 : 0), ttSeconds: time + ttMinusUTC },
    orientation: measuredOrientation ? { polarX: radians(xp / 3600), polarY: radians(yp / 3600) } : undefined,
    timeScale: step * rate.num,
  });
  const coords = sites.map(localSite);
  const tracks = coords.map((site) => ({
    last: solver.insolation(site).eclipse,
    phases: new Set(),
    peaks: [],
    contacts: [],
  }));
  for (let frame = 0; frame <= frames; frame++) {
    world.advance(frame);
    const when = from + 1000 * frame * step;
    for (const [i, site] of coords.entries()) {
      const track = tracks[i];
      const { eclipse, obscuration } = solver.insolation(site);
      track.phases.add(eclipse);
      if (track.peaks.length === 0 || obscuration > track.peaks[1]) track.peaks = [when, obscuration];
      if ((track.last === 'total') !== (eclipse === 'total')) track.contacts.push([when - step * 1000, when]);
      track.last = eclipse;
    }
  }
  return tracks.map(({ contacts, peaks, phases }) => {
    assert.ok(peaks[1] > 0.9, 'The scan window must capture the center of the event.');
    assert.ok(contacts.length === 0 || contacts.length === 2, 'The scan must contain both totality boundaries.');
    return { contacts, peaks, phases: [...phases] };
  });
}

function result(track, event, site) {
  const [c2, c3] = track.contacts;
  const duration = c2 ? (bracketMidpoint(c3) - bracketMidpoint(c2)) / 1000 : 0;
  return {
    phases: track.phases,
    peakObscuration: track.peaks[1],
    firstPeakUtc: new Date(track.peaks[0]).toISOString(),
    durationSeconds: duration,
    ...(c2 && {
      c2: utcMidpoint(c2),
      c3: utcMidpoint(c3),
      contactBrackets: [utcBracket(c2), utcBracket(c3)],
    }),
    ...(site.observed.c2 && {
      durationErrorSeconds: duration - site.observed.duration,
      c2ErrorSeconds: c2 ? (bracketMidpoint(c2) - iso(event.date, site.observed.c2)) / 1000 : null,
      c3ErrorSeconds: c3 ? (bracketMidpoint(c3) - iso(event.date, site.observed.c3)) / 1000 : null,
    }),
  };
}

const horizontalShiftDeg = 0.001;
const heightShiftM = 50;
const cases = events.flatMap((event) => {
  const coarse = evaluate(event, event.sites, 2);
  const fine = evaluate(event, event.sites, 0.25);
  const zeroEop = evaluate(event, event.sites, 0.25, false);
  return event.sites.map((site, i) => {
    const { cameraC2, cameraC3 } = site.observed;
    const cameraDuration = cameraC2 && [
      (iso(event.date, cameraC3[0]) - iso(event.date, cameraC2[1])) / 1000,
      (iso(event.date, cameraC3[1]) - iso(event.date, cameraC2[0])) / 1000,
    ];
    return {
      date: event.date,
      ...site,
      observed: { ...site.observed, ...(cameraDuration && { cameraDurationEnvelopeSeconds: cameraDuration }) },
      analytic: result(fine[i], event, site),
      coarse: result(coarse[i], event, site),
      ut1EqualsUtcAndZeroPolarMotion: result(zeroEop[i], event, site),
    };
  });
});
const texas = events[1];
const stephenville = texas.sites[0];
// ±0.001° horizontally and ±50 m in height are declared perturbations, not position confidence limits.
const diagonalShifts = [-1, 1].flatMap((north) =>
  [-1, 1].map((east) => ({
    ...stephenville,
    latitudeDeg: stephenville.latitudeDeg + north * horizontalShiftDeg,
    longitudeDeg: stephenville.longitudeDeg + east * horizontalShiftDeg,
  })),
);
const positions = diagonalShifts.flatMap((site) =>
  [-1, 1].map((sign) => ({ ...site, height: site.height + sign * heightShiftM })),
);
const perturbed = evaluate(texas, positions, 0.25).map(
  (track, i) => result(track, texas, positions[i]).durationSeconds,
);

console.log(
  JSON.stringify(
    {
      scope:
        'Analytic CelestialSolver circular-disc contacts against telescope or flash-spectrum observations. No fitted radius, ephemeris, clock offset or brightness adjustments.',
      clock:
        'USNO/IERS finals2000A.all Bulletin B UT1 and polar motion. TDB defaults to TT with a sub-2-ms distinction here. Each modeled contact lies in a 0.25-s scan bracket.',
      stephenvillePositionSensitivity: {
        horizontalShiftDeg,
        heightShiftM,
        durationRangeSeconds: [Math.min(...perturbed), Math.max(...perturbed)],
      },
      cases,
    },
    null,
    2,
  ),
);
