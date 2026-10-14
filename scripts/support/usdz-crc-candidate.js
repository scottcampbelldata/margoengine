import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {stripTypeScriptTypes} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const exec=promisify(execFile);

/** One private arithmetic substitution. Archive layout, formatting, scene validation and API are untouched. */
export async function usdzCRCSources(variant='crc') {
  // Pin the actual baseline so a later branchless adoption cannot turn A into B.
  const [baseline,current]=await Promise.all([exec('git',['show','5fc55a0:packages/exporters/src/usdz.ts'],{encoding:'utf8'}),readFile('packages/exporters/src/usdz.ts','utf8')]);
  const original = baseline.stdout.replace(/\r\n/g, '\n');
  const before = 'crc=crc&1?0xedb88320^(crc>>>1):crc>>>1;';
  assert.equal(original.split(before).length, 2, 'USDZ CRC source changed before comparison');
  const adopted=original.replace(before,'crc=(crc>>>1)^(-(crc&1)&0xedb88320);');
  assert.ok([original,adopted].includes(current.replace(/\r\n/g,'\n')),'Current USDZ source changed outside the isolated CRC candidate');
  assert.ok(['crc', 'tuples', 'crc-tuples'].includes(variant));
  let candidate = variant==='tuples' ? original : original.replace(before, 'crc=(crc>>>1)^(-(crc&1)&0xedb88320);');
  if(variant!=='crc') {
    const tupleBefore="result.push(`(${Array.from({length:size},(_,k)=>num(values[i+k])).join(', ')})`);";
    assert.equal(candidate.split(tupleBefore).length,2,'USDZ tuple source changed before comparison');
    // Every actual tuple caller is size 3, and inputs have already been normalized.
    const tupleCalls=['tuples([...min,...max],3)','tuples(positions,3)','tuples(normals,3)','tuples(material.color.slice(0,3),3)'];
    assert.equal([...candidate.matchAll(/\btuples\(/g)].length,tupleCalls.length);
    for(const call of tupleCalls)assert.ok(candidate.includes(call),'USDZ tuple call contract changed');
    candidate=candidate.replace(tupleBefore,"result.push(`(${num(values[i])}, ${num(values[i+1])}, ${num(values[i+2])})`);");
    candidate=candidate.replace('const tuples=(values:ArrayLike<number>,size:number):string=>','const tuples=(values:ArrayLike<number>):string=>')
      .replace('i+=size','i+=3');
    for(const call of tupleCalls)candidate=candidate.replace(call,call.slice(0,-3)+')');
  }
  return {original, candidate};
}

export async function importUSDZCRCSource(source,sceneSource) {
  const sceneURL=sceneSource===undefined?pathToFileURL(resolve('packages/exporters/dist/scene.js')).href:
    'data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(sceneSource,{mode:'transform'})
      .replaceAll("'@margoengine/core/extension'",JSON.stringify(pathToFileURL(resolve('packages/core/dist/extension.js')).href))).toString('base64');
  const code = stripTypeScriptTypes(source, {mode: 'transform'})
    .replaceAll("'./scene.js'", JSON.stringify(sceneURL));
  // The extra export exists only in this data module, never in a measured/package build.
  return import('data:text/javascript;base64,' + Buffer.from(code + '\nexport {crc32};\n').toString('base64'));
}
