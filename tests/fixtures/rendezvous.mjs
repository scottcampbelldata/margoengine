// Starts, then waits until `count` copies of itself have started in `dir`; prints ok, or alone after 20 s.
import { mkdirSync, readdirSync } from 'node:fs';
const [dir, count] = process.argv.slice(2);
mkdirSync(`${dir}/${process.pid}`, { recursive: true });
const begun = Date.now();
let alone = false;
while (!alone && readdirSync(dir).length < Number(count)) {
  alone = Date.now() - begun > 20_000;
  if (!alone) await new Promise((done) => setTimeout(done, 20));
}
console.log(alone ? 'alone' : 'ok');
if (alone) process.exitCode = 3;
