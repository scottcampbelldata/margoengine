import test from 'node:test';
import assert from 'node:assert/strict';
import {WFC} from '../dist/index.js';
const neighborLists = tile => Array.from({length: 6}, () => [tile]);
test('3D constraints propagate pins, seed replay is stable and contradictions fail explicitly', () => {
  const tiles = [{neighbors: neighborLists(1)}, {neighbors: neighborLists(0)}], wfc = new WFC([5, 4, 3], tiles), pins = [{position: [0, 0, 0], tile: 0}];
  const result = wfc.solve(123, pins); assert.deepEqual(wfc.solve(123, pins), result);
  for (let z = 0; z < 3; z++) for (let y = 0; y < 4; y++) for (let x = 0; x < 5; x++) assert.equal(result[x + 5 * (y + 4 * z)], (x + y + z) % 2);
  assert.throws(() => wfc.solve(1, [...pins, {position: [1, 0, 0], tile: 0}], 1), /contradicted/);
  assert.throws(() => new WFC([1, 1, 1], [{neighbors: neighborLists(1)}]), /reciprocal/);
});

test('weighted entropy reuses tile constants without changing seeded results', () => {
  const tiles=[1,2,4].map(weight=>({weight,neighbors:Array.from({length:6},()=>[0,1,2])})),wfc=new WFC([4,2,1],tiles);
  const log=Math.log;let tileLogs=0,result;
  try{Math.log=value=>{if([1,2,4].includes(value))tileLogs++;return log(value);};result=wfc.solve(123);}finally{Math.log=log;}
  assert.deepEqual([...result],[1,2,2,2,1,2,2,1]);assert.equal(tileLogs,0,'Tile weights are constant across entropy scans');
  tiles[0].weight=100;assert.deepEqual(wfc.solve(123),result);
});

test('thirty-two tile types solve instead of propagating forever', async () => {
  // Bit 31 used to make the propagation mask negative, so it never compared equal and the solve never returned.
  const {spawnSync} = await import('node:child_process');
  const code = `import {WFC} from ${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)};
    const all = Array.from({length: 32}, (_, i) => i), wfc = new WFC([4, 2, 2], all.map(() => ({neighbors: Array.from({length: 6}, () => all)})));
    const result = wfc.solve(7, [{position: [0, 0, 0], tile: 31}]); console.log(result.length, result[0], Math.max(...result) < 32);`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', code], {encoding: 'utf8', timeout: 20000});
  assert.equal(run.error, undefined, 'solve did not return'); assert.equal(run.stdout.trim(), '16 31 true', run.stderr);
});
