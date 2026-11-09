// A live mutex owner can be busy in synchronous code. Keep its directory fresh for older clients that only
// inspect mtime, independently of the main thread. Identity-aware clients never reclaim a live owner by age.
import { utimesSync } from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';

setInterval(() => {
  try {
    const now = new Date();
    utimesSync(workerData, now, now);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error; // there is no directory between critical sections
  }
}, 1_000);
parentPort.postMessage('ready');
