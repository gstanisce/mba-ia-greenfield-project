import { RangeNotSatisfiableException } from '../common/exceptions/domain.exception';

export interface ByteRange {
  start: number;
  end: number;
}

// One range only: "bytes=a-b", "bytes=a-" or "bytes=-n". Multiple ranges do not match.
const SINGLE_RANGE = /^bytes=(\d*)-(\d*)$/;

export function parseRange(
  header: string | undefined,
  totalBytes: number,
): ByteRange | undefined {
  if (header === undefined) {
    return undefined;
  }

  const match = SINGLE_RANGE.exec(header.trim());
  if (!match || (match[1] === '' && match[2] === '')) {
    throw new RangeNotSatisfiableException(totalBytes);
  }
  const [, first, last] = match;

  // Suffix range: the last N bytes of the object.
  if (first === '') {
    const suffixLength = Number(last);
    if (suffixLength === 0 || totalBytes === 0) {
      throw new RangeNotSatisfiableException(totalBytes);
    }
    return {
      start: Math.max(0, totalBytes - suffixLength),
      end: totalBytes - 1,
    };
  }

  const start = Number(first);
  if (start >= totalBytes) {
    throw new RangeNotSatisfiableException(totalBytes);
  }
  if (last === '') {
    return { start, end: totalBytes - 1 };
  }
  const requestedEnd = Number(last);
  if (requestedEnd < start) {
    throw new RangeNotSatisfiableException(totalBytes);
  }
  return { start, end: Math.min(requestedEnd, totalBytes - 1) };
}
