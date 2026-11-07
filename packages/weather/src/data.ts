// Real weather into a WeatherState: a reader of METAR and SPECI reports (the aerodrome routine and special
// observations of WMO-No. 306 Manual on Codes, Volume I.1, code forms FM 15 and FM 16, as ICAO Annex 3 specifies them,
// with the United States variant of FMH-1: statute miles, inches of mercury, CLR) and a mapping from a report to the
// nine numbers of a weather state. Written from those specifications; no other reader was consulted.
import type { WeatherState } from './state.js';
import { wrapAngle } from './state.js';

/** One present-weather group, such as `-SHRA` or `+TSRAGR`. */
export interface MetarWeather {
  /** `'light'` (-), `'moderate'`, `'heavy'` (+) or `'vicinity'` (VC). */
  intensity: 'light' | 'moderate' | 'heavy' | 'vicinity';
  /** Descriptor: MI, BC, PR, DR, BL, SH, TS or FZ, if any. */
  descriptor?: string;
  /** Phenomena in order: DZ, RA, SN, SG, PL, GR, GS, UP, IC, BR, FG, FU, VA, DU, SA, HZ, PY, PO, SQ, FC, SS, DS. */
  phenomena: string[];
  /** The group as written. */
  text: string;
}

/** One cloud layer. */
export interface MetarCloud {
  /** FEW (1-2 oktas), SCT (3-4), BKN (5-7) or OVC (8). */
  cover: 'FEW' | 'SCT' | 'BKN' | 'OVC';
  /** Height of the base above the aerodrome in metres, or undefined when not given (///). */
  height?: number;
  /** CB (cumulonimbus) or TCU (towering cumulus), if given. */
  type?: 'CB' | 'TCU';
}

/** A decoded METAR or SPECI. Units: metres, metres per second, degrees Celsius, hectopascals. */
export interface Metar {
  /** 'METAR' or 'SPECI'. */
  kind: 'METAR' | 'SPECI';
  /** ICAO location indicator, such as 'EGLL'. */
  station: string;
  /** Day of the month and UTC time of the observation. */
  time: { day: number; hour: number; minute: number };
  /** Fully automated observation (AUTO). */
  auto: boolean;
  /** Corrected report (COR). */
  corrected: boolean;
  /** Wind: the direction it blows from in degrees true (undefined when variable, VRB), its mean speed and gusts. */
  wind?: { from?: number; speed: number; gust?: number; variable?: readonly [number, number] };
  /** Prevailing visibility in metres (10,000 means 10 km or more, as reported); undefined when not given. */
  visibility?: number;
  /** Ceiling and visibility OK: visibility 10 km or more, no cloud below 1,500 m or the highest sector altitude, no CB or TCU, no significant weather. */
  cavok: boolean;
  /** Present weather groups. */
  weather: MetarWeather[];
  /** Cloud layers, lowest first. */
  clouds: MetarCloud[];
  /** Vertical visibility in metres when the sky is obscured (VV), or undefined. */
  verticalVisibility?: number;
  /** No cloud: SKC, CLR, NSC or NCD reported. */
  clear: boolean;
  /** Air temperature in degrees Celsius. */
  temperature?: number;
  /** Dew point in degrees Celsius. */
  dewPoint?: number;
  /** Pressure (QNH, or altimeter setting converted from inches of mercury) in hectopascals. */
  pressure?: number;
  /** Recent weather (RE groups), such as 'RERA'. */
  recent: string[];
  /** Everything after RMK, as written. */
  remarks?: string;
  /** Trend groups (NOSIG, BECMG, TEMPO) as written. */
  trend?: string;
  /** Groups the reader did not recognise, as written; empty for a clean report. */
  unknown: string[];
}

const DESCRIPTORS = ['MI', 'BC', 'PR', 'DR', 'BL', 'SH', 'TS', 'FZ'];
const PHENOMENA = [
  'DZ',
  'RA',
  'SN',
  'SG',
  'PL',
  'GR',
  'GS',
  'UP',
  'IC',
  'BR',
  'FG',
  'FU',
  'VA',
  'DU',
  'SA',
  'HZ',
  'PY',
  'PO',
  'SQ',
  'FC',
  'SS',
  'DS',
];
const KNOT = 1852 / 3600;
const FOOT = 0.3048;
const STATUTE_MILE = 1609.344;
const INCH_HG = 33.8639;

/** Speed in m/s from a METAR value and its unit. */
const speed = (value: number, unit: string): number =>
  unit === 'KT' ? value * KNOT : unit === 'KMH' ? value / 3.6 : value;

/** Parses a present weather group, or returns undefined when `group` is not one. */
function weatherGroup(group: string): MetarWeather | undefined {
  let rest = group,
    intensity: MetarWeather['intensity'] = 'moderate';
  if (rest.startsWith('+')) (intensity = 'heavy'), (rest = rest.slice(1));
  else if (rest.startsWith('-')) (intensity = 'light'), (rest = rest.slice(1));
  else if (rest.startsWith('VC')) (intensity = 'vicinity'), (rest = rest.slice(2));
  let descriptor: string | undefined;
  if (DESCRIPTORS.includes(rest.slice(0, 2))) (descriptor = rest.slice(0, 2)), (rest = rest.slice(2));
  const phenomena: string[] = [];
  while (rest.length >= 2 && PHENOMENA.includes(rest.slice(0, 2)))
    phenomena.push(rest.slice(0, 2)), (rest = rest.slice(2));
  if (rest.length || (!phenomena.length && descriptor !== 'TS' && descriptor !== 'SH')) return undefined;
  return { intensity, descriptor, phenomena, text: group };
}

/** A visibility in statute miles, `10SM`, `1/2SM`, `M1/4SM` or the two groups `1 1/2SM`, in metres. */
function miles(text: string): number | undefined {
  const m = /^(M|P)?(\d+)?(?:\s?(\d+)\/(\d+))?SM$/.exec(text);
  if (!m || (m[2] === undefined && m[3] === undefined)) return undefined;
  const whole = m[2] === undefined ? 0 : Number(m[2]),
    part = m[3] === undefined ? 0 : Number(m[3]) / Number(m[4]);
  return (whole + part) * STATUTE_MILE;
}

/**
 * Reads one METAR or SPECI. Leading 'METAR'/'SPECI' is optional (data feeds often drop it), a trailing '=' and repeated
 * spaces are ignored. Groups it does not recognise go to `unknown` rather than throwing, so a station's local practice
 * never loses the rest of a report.
 * @throws TypeError when `text` is not a string, SyntaxError when it has no location indicator and time.
 */
export function parseMetar(text: string): Metar {
  if (typeof text !== 'string')
    throw new TypeError('parseMetar needs the report as a string, such as "METAR EGLL 071150Z ..."');
  const body = text.replace(/=\s*$/, '').trim(),
    [main, remarks] = body.split(/\sRMK\s?/, 2) as [string, string | undefined],
    groups = main.split(/\s+/).filter(Boolean);
  let i = 0;
  let kind: Metar['kind'] = 'METAR';
  if (groups[i] === 'METAR' || groups[i] === 'SPECI') kind = groups[i++] as Metar['kind'];
  let corrected = false;
  if (groups[i] === 'COR') (corrected = true), i++;
  const station = groups[i++],
    stamp = /^(\d\d)(\d\d)(\d\d)Z$/.exec(groups[i++] ?? '');
  if (!station || !/^[A-Z][A-Z0-9]{3}$/.test(station) || !stamp)
    throw new SyntaxError(
      `Not a METAR: "${text.slice(0, 40)}" has no location indicator and DDHHMMZ time; pass one report such as "EGLL 071150Z 24012KT 9999 FEW030 12/07 Q1015"`,
    );
  const report: Metar = {
    kind,
    station,
    time: { day: Number(stamp[1]), hour: Number(stamp[2]), minute: Number(stamp[3]) },
    auto: false,
    corrected,
    cavok: false,
    weather: [],
    clouds: [],
    clear: false,
    recent: [],
    remarks: remarks?.trim() || undefined,
    unknown: [],
  };
  for (; i < groups.length; i++) {
    const g = groups[i];
    let m: RegExpExecArray | null;
    if (g === 'AUTO') report.auto = true;
    else if (g === 'COR') report.corrected = true;
    else if (g === 'NIL') break;
    else if (g === 'NOSIG' || g === 'BECMG' || g === 'TEMPO') {
      report.trend = groups.slice(i).join(' ');
      break;
    } else if ((m = /^(\d{3}|VRB|\/\/\/)(\d{2,3}|\/\/)(?:G(\d{2,3}))?(KT|MPS|KMH)$/.exec(g))) {
      if (m[2] === '//') continue;
      report.wind = {
        from: m[1] === 'VRB' || m[1] === '///' ? undefined : Number(m[1]) % 360,
        speed: speed(Number(m[2]), m[4]),
        gust: m[3] === undefined ? undefined : speed(Number(m[3]), m[4]),
      };
    } else if ((m = /^(\d{3})V(\d{3})$/.exec(g)) && report.wind) report.wind.variable = [Number(m[1]), Number(m[2])];
    else if (g === 'CAVOK') (report.cavok = true), (report.visibility = 10000);
    else if ((m = /^(\d{4})(NDV)?$/.exec(g)) && report.visibility === undefined)
      report.visibility = Number(m[1]) === 9999 ? 10000 : Number(m[1]);
    else if (/^\d{4}(N|NE|E|SE|S|SW|W|NW)?$/.test(g))
      continue; // minimum visibility, with or without its direction
    else if (/^\d+$/.test(g) && /^(M|P)?\d\/\dSM$/.test(groups[i + 1] ?? '')) {
      report.visibility = miles(`${g} ${groups[++i]}`);
    } else if (/SM$/.test(g) && miles(g) !== undefined) report.visibility = miles(g);
    else if (/^R\d{2}[LCR]?\//.test(g) || /^\d{2}[LCR]?\/[MP]?\d{4}(V[MP]?\d{4})?(FT)?[UDN]?$/.test(g))
      continue; // runway visual range (some stations drop its R) and runway state
    else if (/^(SKC|CLR|NSC|NCD)$/.test(g)) report.clear = true;
    else if ((m = /^(FEW|SCT|BKN|OVC)(\d{3}|\/\/\/)(CB|TCU|\/\/\/)?$/.exec(g)))
      report.clouds.push({
        cover: m[1] as MetarCloud['cover'],
        height: m[2] === '///' ? undefined : Number(m[2]) * 100 * FOOT,
        type: m[3] === 'CB' || m[3] === 'TCU' ? m[3] : undefined,
      });
    else if ((m = /^VV(\d{3}|\/\/\/)$/.exec(g)))
      report.verticalVisibility = m[1] === '///' ? 0 : Number(m[1]) * 100 * FOOT;
    else if ((m = /^(M?\d{2}|\/\/)\/(M?\d{2}|\/\/)?$/.exec(g))) {
      const t = (s?: string) => (!s || s === '//' ? undefined : s.startsWith('M') ? -Number(s.slice(1)) : Number(s));
      report.temperature = t(m[1]);
      report.dewPoint = t(m[2]);
    } else if ((m = /^Q(\d{4})$/.exec(g))) report.pressure = Number(m[1]);
    else if ((m = /^A(\d{4})$/.exec(g))) report.pressure = (Number(m[1]) / 100) * INCH_HG;
    else if (/^RE[A-Z]{2,}$/.test(g)) report.recent.push(g);
    else if (/^WS$/.test(g)) {
      // Wind shear: WS R27 or WS ALL RWY.
      while (i + 1 < groups.length && /^(R\d{2}[LCR]?|ALL|RWY)$/.test(groups[i + 1])) i++;
    } else if (/^W(M?\d{2}|\/\/)\/(S\d|H\d+)$/.test(g))
      continue; // sea surface temperature and state
    else if (/^\/+(CB|TCU)?$/.test(g) || /^[QA]\/{4}$/.test(g))
      continue; // not observed (an automatic station's slashes)
    else {
      const w = weatherGroup(g);
      if (w) report.weather.push(w);
      else report.unknown.push(g);
    }
  }
  return report;
}

/** {@link metarState} settings. */
export interface MetarStateOptions {
  /** Where north is in the world, in radians from -Z toward +X. Default 0: north is -Z and east +X, as `@margoengine/sky/astro` has them. */
  north?: number;
}

const AMOUNT = { light: 0.3, moderate: 0.6, heavy: 0.95, vicinity: 0 } as const;
const COVER = { FEW: 1.5 / 8, SCT: 3.5 / 8, BKN: 6 / 8, OVC: 1 } as const;

/**
 * The weather state a report describes, for driving the sky, the weather machine and the effects of this package.
 * Wind: the mean speed, gusts as the gust's excess over the mean (a 10 m/s wind gusting 15 is `gust` 0.5) and the
 * direction it blows toward. Rain, snow and hail: 0.3, 0.6 and 0.95 for light, moderate and heavy (drizzle at half
 * that), ice pellets as half rain, half snow, small hail (GS) at half. Lightning: thunderstorm 0.6, heavy 0.9, in the
 * vicinity 0.3. Cloud: the greatest layer's oktas over 8 (FEW 1.5, SCT 3.5, BKN 6, OVC 8; VV a full sky). Fog: from
 * the visibility through Koschmieder's law (extinction = 3 / visibility for the 5 percent contrast threshold that
 * defines meteorological optical range), so that `fogDensity` of the state gives back that extinction, less what the
 * precipitation already adds.
 */
export function metarState(report: Metar, options: MetarStateOptions = {}): WeatherState {
  const north = options.north ?? 0;
  let rain = 0,
    snow = 0,
    hail = 0,
    lightning = 0;
  for (const w of report.weather) {
    const a = AMOUNT[w.intensity];
    if (w.descriptor === 'TS')
      lightning = Math.max(lightning, w.intensity === 'vicinity' ? 0.3 : w.intensity === 'heavy' ? 0.9 : 0.6);
    for (const p of w.phenomena) {
      if (p === 'RA') rain = Math.max(rain, a);
      else if (p === 'DZ') rain = Math.max(rain, a / 2);
      else if (p === 'SN' || p === 'SG') snow = Math.max(snow, p === 'SG' ? a / 2 : a);
      else if (p === 'PL') (rain = Math.max(rain, a / 2)), (snow = Math.max(snow, a / 2));
      else if (p === 'GR') hail = Math.max(hail, a);
      else if (p === 'GS') hail = Math.max(hail, a / 2);
      else if (p === 'UP') rain = Math.max(rain, a / 2);
    }
  }
  const wind = report.wind?.speed ?? 0,
    gust = report.wind?.gust !== undefined && wind > 0 ? Math.min(1, (report.wind.gust - wind) / wind) : 0;
  // Toward-bearing b = from + 180 degrees; a bearing b points along (sin b, -cos b) in world (x, z) with north -Z, and
  // the state's direction theta along (sin theta, cos theta), so theta = pi - b = -from, and a world
  // whose north is turned by n toward +X turns every bearing by n: theta = -from - n.
  const from = report.wind?.from;
  const windDirection = from === undefined ? 0 : wrapAngle(-(from * Math.PI) / 180 - north);
  let cloud = 0;
  for (const layer of report.clouds) cloud = Math.max(cloud, COVER[layer.cover]);
  if (report.verticalVisibility !== undefined) cloud = 1;
  const precip = Math.max(rain, snow, hail),
    visibility = report.visibility ?? 10000,
    extinction = 3 / Math.max(1, visibility),
    thickness = Math.log(extinction / 0.0002) / Math.log(100),
    fog = Math.min(1, Math.max(0, thickness - 0.15 * precip));
  return {
    rain,
    snow,
    hail,
    wind: Math.min(60, wind),
    gust: Math.max(0, gust),
    windDirection,
    cloud,
    fog,
    lightning,
  };
}

/** Reads a report and returns its state in one call: `metarState(parseMetar(text), options)`. */
export function weatherFromMetar(text: string, options?: MetarStateOptions): WeatherState {
  return metarState(parseMetar(text), options);
}
