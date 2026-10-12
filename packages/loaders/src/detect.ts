import {LoaderError, type LoadedGeometry} from './types.js';
import {latin1, toBytes, type BinaryInput} from './util.js';
import {parsePLY, type PLYOptions} from './ply.js';
import {parse3MF, type ThreeMFOptions} from './threemf.js';
import {parsePCD, type PCDOptions} from './pcd.js';
import {parseOFF, type OFFOptions} from './off.js';
import {parseXYZ, type XYZOptions} from './xyz.js';
import {parseVTK, type VTKOptions} from './vtk.js';
import {parseUSDA,parseUSDZ,type USDOptions} from './usdz.js';

export type LoaderFormat = 'ply' | '3mf' | 'pcd' | 'off' | 'xyz' | 'vtk' | 'usda' | 'usdz';
const EXTENSIONS: Record<string, LoaderFormat> = {ply: 'ply', '3mf': '3mf', pcd: 'pcd', off: 'off', xyz: 'xyz', pts: 'xyz', txt: 'xyz', vtk: 'vtk',usda:'usda',usd:'usda',usdz:'usdz'};

/** Guesses the format from the file's first bytes, then from `name`'s extension. Returns null when unknown. */
export function detectFormat(input: BinaryInput, name?: string): LoaderFormat | null {
  const bytes = toBytes(input, 'detect'), head = latin1(bytes, 0, Math.min(bytes.length, 512));
  if (/^ply\r?\n/.test(head)) return 'ply';
  if(head.startsWith('#usda 1.0'))return 'usda';
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4) {
    const rootName=bytes.length>=30?latin1(bytes,30,Math.min(bytes.length,30+new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint16(26,true))):'';
    return name&&/\.usdz(?:[?#].*)?$/i.test(name)||/\.(usd|usda|usdc)$/i.test(rootName)?'usdz':'3mf';
  }
  if (head.startsWith('# vtk DataFile Version')) return 'vtk';
  if (/^(#[^\n]*\n|\s)*(VERSION|FIELDS)\s/.test(head) || /^#\s*\.PCD/.test(head)) return 'pcd';
  if (/^(#[^\n]*\n|\s)*(ST)?C?N?4?n?OFF\b/.test(head)) return 'off';
  const extension = name?.toLowerCase().match(/\.([a-z0-9]+)(?:[?#].*)?$/)?.[1];
  if (extension && EXTENSIONS[extension]) return EXTENSIONS[extension];
  if (/^(\s*(#|\/\/)[^\n]*\n)*\s*[-+]?(\d|\.\d)/.test(head)) return 'xyz';
  return null;
}

export type AnyOptions = PLYOptions & ThreeMFOptions & PCDOptions & OFFOptions & XYZOptions & VTKOptions & USDOptions & {name?: string; format?: LoaderFormat};

/** Detects the format (or uses `options.format`) and parses with the matching loader. Imports every parser. */
export async function parseAny(input: BinaryInput, options: AnyOptions = {}): Promise<LoadedGeometry> {
  const format = options.format ?? detectFormat(input, options.name);
  switch (format) {
    case 'ply': return parsePLY(input, options);
    case '3mf': return parse3MF(input, options);
    case 'pcd': return parsePCD(input, options);
    case 'off': return parseOFF(input, options);
    case 'xyz': return parseXYZ(input, options);
    case 'vtk': return parseVTK(input, options);
    case 'usda': return parseUSDA(input,options);
    case 'usdz': return parseUSDZ(input,options);
    default: throw new LoaderError('detect', 'unsupported', `unrecognized format${options.name ? ` for ${options.name.slice(0, 128)}` : ''}`);
  }
}
