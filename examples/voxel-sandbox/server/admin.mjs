// The operator's tool, run over SSH on the Plaza server. It talks to the running router over a local socket that nginx
// cannot reach and only the service's user can open.
//   node server/admin.mjs status --data=DIR
//   node server/admin.mjs snapshots --data=DIR --shard=N
//   node server/admin.mjs rollback --data=DIR --shard=N --to=HH:MM [--area=x,z]
// --to is UTC, the newest time of day not in the future; the world goes back to the newest snapshot at or before it.
// --area is any block column: its 3 x 3 chunk column areas roll back, and take no edits for 5 minutes. Without --area
// the whole world rolls back.
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { adminPath } from './router.mjs';

/** The latest moment at or before `now` whose UTC time of day is `text` (HH:MM). */
export function timeOfDay(text, now = Date.now()) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(text ?? '');
  if (!match) throw new RangeError(`--to=${text}; pass a UTC time as HH:MM, such as 14:30`);
  const day = new Date(now);
  let at = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), Number(match[1]), Number(match[2]));
  if (at > now) at -= 86_400_000;
  return at;
}

/** Sends one command to the router of `dataDir` and resolves its answer. Rejects when the router is not running. */
export function adminRequest(dataDir, command, timeoutMs = 70_000) {
  return new Promise((resolve, reject) => {
    const socket = connect(adminPath(dataDir));
    let text = '';
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      reject(new Error(`The router did not answer within ${timeoutMs} ms`));
    });
    socket.on('error', (error) => reject(new Error(`Cannot reach the router: ${error.message}`)));
    socket.on('connect', () => socket.write(`${JSON.stringify(command)}\n`));
    socket.on('data', (part) => {
      text += part;
    });
    socket.on('end', () => {
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error(`The router sent something unreadable: ${text.slice(0, 200)}`));
      }
    });
  });
}

/** The command that the arguments of this tool ask for. */
export function commandFrom(argv, now = Date.now()) {
  const arg = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3),
    name = argv[0],
    shard = Number(arg('shard'));
  if (name === 'status') return { name };
  if (name !== 'snapshots' && name !== 'rollback')
    throw new TypeError('Pass status, snapshots --shard=N, or rollback --shard=N --to=HH:MM [--area=x,z]');
  if (!Number.isInteger(shard) || shard < 0) throw new RangeError(`--shard=${arg('shard')}; pass the shard's number`);
  if (name === 'snapshots') return { name, shard };
  const area = arg('area')?.split(',').map(Number);
  if (area && (area.length !== 2 || !area.every(Number.isFinite)))
    throw new RangeError(`--area=${arg('area')}; pass a block column as x,z`);
  return { name, shard, at: timeOfDay(arg('to'), now), area };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2),
    data = argv.find((a) => a.startsWith('--data='))?.slice(7);
  try {
    if (!data) throw new TypeError('Pass --data=DIR, the same folder the router runs with');
    const answer = await adminRequest(data, commandFrom(argv));
    console.log(JSON.stringify(answer, null, 2));
    if (answer.error) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
