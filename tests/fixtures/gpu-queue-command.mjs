// CPU-only bounded job: expose admission, then wait for the test owner to release it.
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [folder, label] = process.argv.slice(2);
writeFileSync(join(folder, `${label}-started`), process.env.MARGO_GPU_LOCK_NESTED_MODE);
for (const deadline = Date.now() + 60_000; !existsSync(join(folder, `${label}-finish`)); ) {
  if (Date.now() > deadline) throw new Error('CPU-only queue fixture exceeded its hard limit');
  await new Promise((done) => setTimeout(done, 10));
}
console.log(`finished ${label}`);
