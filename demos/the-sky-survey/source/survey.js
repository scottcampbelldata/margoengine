import { parseFITS } from '@margoengine/sciviz/fits';
import surveyURL from './assets/fermi-4fgl-v35.fits.gz.bin?url';
import detailURL from './assets/fermi-4fgl-identifications.fits.gz.bin?url';

const rad = Math.PI / 180;

async function table(url, name, signal) {
  const response = await fetch(url, {signal});
  if (!response.ok || !response.body) throw new Error('The Fermi catalog could not be loaded.');
  const bytes = await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  signal.throwIfAborted();
  const {hdus} = parseFITS(new Uint8Array(bytes),{maxBytes:512000,signal});
  const extension = hdus.find(hdu => hdu.kind==='table' && hdu.header.EXTNAME===name);
  if (!extension || extension.rows!==7195) throw new Error('The Fermi catalog does not contain all 7,195 rows.');
  return Object.fromEntries(extension.columns.map(({name,values}) => [name,values]));
}

export function direction(longitude, latitude) {
  const lon = longitude * rad, lat = latitude * rad, horizontal = Math.cos(lat);
  return [horizontal * Math.sin(lon), Math.sin(lat), horizontal * Math.cos(lon)];
}

export async function loadSurvey(signal) {
  const raw = await table(surveyURL,'SURVEY_DIRECTIONS',signal);
  return raw.GLON.map((lon,i) => {
    const lat=raw.GLAT[i], significance=raw.Signif_Avg[i], type=raw.CLASS1[i];
    const pulsar=['psr','msp'].includes(type.toLowerCase());
    return {lon,lat,significance,type,pulsar,direction:direction(lon,lat)};
  });
}

export function loadDetails(signal) {
  return table(detailURL,'SURVEY_IDENTIFICATIONS',signal);
}

export const catalogFilters = {
  all: () => true,
  plane: source => Math.abs(source.lat)<=10,
  pulsars: source => source.pulsar,
};
