// Seeded save migration fuzz. No rival package does this job. A version-1 document is migrated (rename a
// component, add a field), encoded, decoded, parsed, and migrated again. The two results must be deep-equal
// and validation must be empty.
import { pathToFileURL } from 'node:url';
import { decodeSave, encodeSave, Migrations, parseSave, validateSave } from '../dist/index.js';

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function documentAt(seed) {
  const rand = mulberry32(seed);
  const count = 1 + Math.floor(rand() * 8);
  const entities = [];
  for (let i = 0; i < count; i++) {
    const entity = {
      id: `e${i}`,
      components: { health: { hp: Math.floor(rand() * 10), tag: 'old' } },
    };
    if (i > 0 && rand() < 0.5) entity.parent = `e${Math.floor(rand() * i)}`;
    if (rand() < 0.5) entity.components.note = { who: { $ref: `e${Math.floor(rand() * count)}` } };
    entities.push(entity);
  }
  return { format: 'margo-save', version: 1, entities };
}

function migrations() {
  return new Migrations(2).register(1, (document) => {
    const next = structuredClone(document);
    next.version = 2;
    for (const entity of next.entities) {
      if (entity.components?.health) {
        entity.components.vitals = { ...entity.components.health, max: 10 };
        delete entity.components.health;
      }
    }
    return next;
  });
}

/** One document: migrate, validate, encode, decode, parse, migrate again. Throws when anything disagrees. */
export async function roundTrip(seed) {
  const source = documentAt(seed);
  const steps = migrations();
  const migrated = steps.migrate(source);
  const issues = validateSave(migrated);
  if (issues.length) throw new Error(`seed ${seed} validate: ${JSON.stringify(issues)}`);
  const bytes = await encodeSave(migrated);
  const decoded = parseSave(await decodeSave(bytes));
  const again = steps.migrate(decoded);
  if (JSON.stringify(again) !== JSON.stringify(migrated)) throw new Error(`seed ${seed} round trip differed`);
  if (JSON.stringify(steps.migrate(source)) !== JSON.stringify(migrated))
    throw new Error(`seed ${seed} migrate was not repeatable`);
  return bytes.byteLength;
}

export async function roundTrips(seed, count) {
  let bytes = 0;
  for (let i = 0; i < count; i++) bytes += await roundTrip(seed + i);
  return { count, bytes };
}

const main = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (main) {
  const count = 200;
  const t0 = performance.now();
  const result = await roundTrips(167, count);
  const ms = performance.now() - t0;
  console.log('no save-migration rival');
  console.log(
    `${count} seeded documents, ${result.bytes} bytes, ${(ms / count).toFixed(3)} ms each (busy machine, one run)`,
  );
}
