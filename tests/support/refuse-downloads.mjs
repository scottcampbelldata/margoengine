// Preloaded (node --import) into a download script under test: every way to reach the network, start another program or
// change a file is refused and reported on stderr, so a script that ignores its arguments fails the test and can
// neither download nor overwrite a fixture while it does.
import childProcess from 'node:child_process';
import dns from 'node:dns';
import fs, { writeSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';

const refuse = (what) => () => {
  writeSync(2, `REFUSED ${what}\n`);
  throw new Error(`REFUSED ${what}`);
};

globalThis.fetch = refuse('fetch');
net.Socket.prototype.connect = refuse('socket connect');
dns.lookup = refuse('DNS lookup');
dns.promises.lookup = refuse('DNS lookup');
for (const name of ['exec', 'execFile', 'execFileSync', 'execSync', 'fork', 'spawn', 'spawnSync'])
  childProcess[name] = refuse(`child_process.${name}`);
for (const name of ['appendFile', 'copyFile', 'mkdir', 'rename', 'rm', 'unlink', 'writeFile']) {
  fs.promises[name] = refuse(`fs.promises.${name}`);
  fs[name] = refuse(`fs.${name}`);
  fs[`${name}Sync`] = refuse(`fs.${name}Sync`);
}
syncBuiltinESMExports();
