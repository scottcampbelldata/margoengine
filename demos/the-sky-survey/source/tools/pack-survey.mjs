import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

const [input, destination] = process.argv.slice(2);
const engine = process.env.MARGO_ENGINE_CHECKOUT;
if (!input || !destination || !engine) throw new Error('Set MARGO_ENGINE_CHECKOUT and pass the input FITS and output folder.');
const { parseFITS } = await import(pathToFileURL(resolve(engine, 'packages/sciviz/dist/fits.js')));
const original = await readFile(input);
const hash = createHash('sha256').update(original).digest('hex');
if (hash !== 'e3b3ea278412b7bda4c259ab558f00b76605be59eb84e44086a862a179ffc3e6') throw new Error('Expected the FSSC v35 release.');
const { hdus } = parseFITS(original);
const catalog = hdus.find(hdu => hdu.header.EXTNAME === 'LAT_Point_Source_Catalog');
if (!catalog || catalog.rows !== 7195) throw new Error('The catalog did not contain all 7,195 source rows.');

const sourceColumn = name => {
  const column = catalog.columns.find(c => c.name === name);
  if (!column) throw new Error('Missing catalog column ' + name);
  return column;
};

function header(values) {
  const cards = values.map(([key,value]) => {
    const field = typeof value === 'string' ? "'" + value + "'" : (typeof value === 'boolean' ? (value ? 'T' : 'F') : String(value)).padStart(20);
    return (key.padEnd(8) + '= ' + field).padEnd(80);
  });
  return Buffer.from((cards.join('') + 'END'.padEnd(80)).padEnd(Math.ceil((cards.length + 1) / 36) * 2880), 'ascii');
}

function extract(extname, fields, file) {
  const columns=fields.map(sourceColumn);
  const sizes=columns.map(({format}) => format === 'E' ? 4 : Number(format.match(/^(\d*)A$/)?.[1] || 1));
  const stride=sizes.reduce((a,b)=>a+b);
  const primary=header([['SIMPLE',true],['BITPIX',8],['NAXIS',0],['EXTEND',true]]);
  const extension=header([
    ['XTENSION','BINTABLE'],['BITPIX',8],['NAXIS',2],['NAXIS1',stride],['NAXIS2',catalog.rows],
    ['PCOUNT',0],['GCOUNT',1],['EXTNAME',extname],['TFIELDS',fields.length],
    ...columns.flatMap(({name,format,unit},i) => {
      const axis=i+1;
      const tags=[['TTYPE'+axis,name],['TFORM'+axis,format]];
      if(unit)tags.push(['TUNIT'+axis,unit]);
      return tags;
    }),
  ]);
  const body=Buffer.alloc(Math.ceil(stride*catalog.rows / 2880) * 2880);
  for(let row=0;row<catalog.rows;row++){
    let cursor=row*stride;
    for(const [i,{values,format}] of columns.entries()){
      if(format==='E')body.writeFloatBE(values[row],cursor);
      else body.write(String(values[row]).padEnd(sizes[i]),cursor,sizes[i],'ascii');
      cursor+=sizes[i];
    }
  }
  const result=gzipSync(Buffer.concat([primary,extension,body]),{level:9});
  console.log(file, result.length);
  return writeFile(resolve(destination,file),result);
}
await Promise.all([
  extract('SURVEY_DIRECTIONS',['GLON','GLAT','Signif_Avg','CLASS1'],'fermi-4fgl-v35.fits.gz.bin'),
  extract('SURVEY_IDENTIFICATIONS',['Source_Name','ASSOC1','Energy_Flux100'],'fermi-4fgl-identifications.fits.gz.bin'),
]);
