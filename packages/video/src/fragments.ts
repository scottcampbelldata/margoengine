import { fault } from '../../shared/errors.js';
import type { FragmentInput, Sample } from './mp4.js';

const invalid = (): never => {
  throw fault('failed', 'Invalid MP4 fragment; provide complete initialization and media segments');
};
const unsupported = (): never => {
  throw fault(
    'unsupported',
    'Encrypted or changing MP4 sample descriptions are unsupported; use one unencrypted AVC track',
  );
};

/** Package-local ISO fragment table reader; sizes and times stay in native ticks until readMP4 applies edits. */
export function readFragments(r: FragmentInput): Sample[] {
  const { bytes, roots, moov, trackID, children, one, uint, wide, version } = r;
  const defaults = new Map<number, number[]>(),
    clocks = new Map<number, number>(),
    samples: Sample[] = [];
  for (const trex of children(one(moov, 'mvex')).filter((b) => b.type === 'trex')) {
    version(trex, [0]);
    const id = uint(trex.start + 4, trex.end);
    if (defaults.has(id)) invalid();
    defaults.set(
      id,
      [8, 12, 16, 20].map((n) => uint(trex.start + n, trex.end)),
    );
  }
  const media = roots.filter((b) => b.type === 'mdat');
  for (const moof of roots.filter((b) => b.type === 'moof')) {
    let implicitBase = moof.offset;
    for (const traf of children(moof).filter((b) => b.type === 'traf')) {
      const parts = children(traf),
        head = one(parts, 'tfhd');
      version(head, [0]);
      const flags = uint(head.start, head.end) & 0xffffff,
        id = uint(head.start + 4, head.end),
        fallback = defaults.get(id);
      if (!fallback) return invalid();
      let cursor = head.start + 8;
      const field = (bit: number, value: number): number => {
        if (!(flags & bit)) return value;
        const n = uint(cursor, head.end);
        cursor += 4;
        return n;
      };
      const base = flags & 1 ? wide(cursor, head.end) : flags & 0x20000 ? moof.offset : implicitBase;
      if (flags & 1) cursor += 8;
      const description = field(2, fallback[0]!),
        duration = field(8, fallback[1]!),
        size = field(16, fallback[2]!),
        sampleFlags = field(32, fallback[3]!);
      if (id === trackID && (description !== 1 || parts.some((b) => ['senc', 'saiz', 'saio'].includes(b.type))))
        unsupported();
      const tfdt = parts.filter((b) => b.type === 'tfdt');
      if (tfdt.length > 1) invalid();
      let dts = tfdt.length
        ? version(tfdt[0]!, [0, 1])
          ? wide(tfdt[0]!.start + 4, tfdt[0]!.end)
          : uint(tfdt[0]!.start + 4, tfdt[0]!.end)
        : (clocks.get(id) ?? 0);
      if (dts < (clocks.get(id) ?? 0)) invalid();
      let end = base;
      for (const run of parts.filter((b) => b.type === 'trun')) {
        const v = version(run, [0, 1]),
          f = uint(run.start, run.end) & 0xffffff,
          count = uint(run.start + 4, run.end);
        if (count > bytes.length || (flags & 0x10000 && count) || (f & 4 && f & 0x400)) invalid();
        let p = run.start + 8;
        const take = (): number => {
          const n = uint(p, run.end);
          p += 4;
          return n;
        };
        let offset = f & 1 ? base + (take() | 0) : end;
        const first = f & 4 ? take() : sampleFlags;
        const stride = [0x100, 0x200, 0x400, 0x800].filter((bit) => f & bit).length * 4;
        if (count * stride > run.end - p) invalid();
        for (let i = 0; i < count; i++) {
          const delta = f & 0x100 ? take() : duration,
            length = f & 0x200 ? take() : size,
            bits = f & 0x400 ? take() : i === 0 ? first : sampleFlags,
            raw = f & 0x800 ? take() : 0,
            pts = dts + (v ? raw | 0 : raw);
          if (
            !delta ||
            !length ||
            !Number.isSafeInteger(pts) ||
            !media.some((b) => offset >= b.start && offset + length <= b.end)
          )
            invalid();
          if (id === trackID)
            samples.push({
              offset,
              size: length,
              pts,
              duration: delta,
              key: !(bits & 0x10000) && ((bits >>> 24) & 3) !== 1,
            });
          offset += length;
          dts += delta;
          if (!Number.isSafeInteger(dts)) invalid();
        }
        if (p !== run.end) invalid();
        end = offset;
      }
      clocks.set(id, dts);
      implicitBase = end;
    }
  }
  return samples;
}
