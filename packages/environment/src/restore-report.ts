// A rebuild whose GPU device is lost while it runs (its SH readback rejects) fails with lostRebuild(). Core restores onto
// a new device and every plugin's onDeviceRestored rebuilds there, as it does after any loss it recovers from without a
// report, so the plugins that started the rebuild pass reportRestore() their failures and that one is not reported.
// The mark is a registered symbol, so every bundled copy of this file sees it.
import { MargoError } from '@margoengine/math/errors';

const LOST = Symbol.for('@margoengine/environment lost rebuild'),
  REPORTED = Symbol.for('@margoengine/environment restore reported');

/** The rejection of a rebuild whose device was lost while it ran. */
export function lostRebuild(): MargoError {
  return Object.assign(
    new MargoError(
      'failed',
      'Environment rebuild stopped: its GPU device was lost; the restore onto the next device rebuilds it; see https://margoengine.com/errors#gpu-lost',
    ),
    { [LOST]: true },
  );
}

/**
 * Reports a failed restore to `engine.onError` once: an Environment and the EnvironmentLighting over it share one
 * restore, and both pass its rejection here. Not at all when its device was lost while it ran (core restores again).
 */
export function reportRestore(engine: { onError(error: unknown): void }, error: unknown): void {
  const mark = error as { [LOST]?: boolean; [REPORTED]?: boolean } | null;
  if (mark?.[LOST] || mark?.[REPORTED]) return;
  if (mark && typeof mark === 'object') Object.defineProperty(mark, REPORTED, { value: true });
  engine.onError(error);
}
