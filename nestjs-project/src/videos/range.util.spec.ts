import { RangeNotSatisfiableException } from '../common/exceptions/domain.exception';
import { parseRange } from './range.util';

const TOTAL = 1000;

describe('parseRange', () => {
  it('should return undefined when there is no Range header', () => {
    expect(parseRange(undefined, TOTAL)).toBeUndefined();
  });

  it('should parse a closed range "bytes=a-b"', () => {
    expect(parseRange('bytes=0-99', TOTAL)).toEqual({ start: 0, end: 99 });
  });

  it('should parse an open range "bytes=a-" up to the last byte', () => {
    expect(parseRange('bytes=100-', TOTAL)).toEqual({ start: 100, end: 999 });
  });

  it('should parse a suffix range "bytes=-n" as the last n bytes', () => {
    expect(parseRange('bytes=-50', TOTAL)).toEqual({ start: 950, end: 999 });
  });

  it('should cap the end at the last byte when it is past the total', () => {
    expect(parseRange('bytes=900-5000', TOTAL)).toEqual({
      start: 900,
      end: 999,
    });
  });

  it.each([
    ['multiple ranges', 'bytes=0-10,20-30'],
    ['start at the total size', `bytes=${TOTAL}-`],
    ['start past the total size', 'bytes=5000-'],
    ['an invalid format', 'items=0-10'],
    ['an empty range', 'bytes=-'],
    ['an end before the start', 'bytes=50-10'],
    ['a zero-length suffix', 'bytes=-0'],
  ])('should reject %s with RANGE_NOT_SATISFIABLE', (_label, header) => {
    expect(() => parseRange(header, TOTAL)).toThrow(
      RangeNotSatisfiableException,
    );
  });

  it('should carry the total size in the 416 Content-Range header', () => {
    try {
      parseRange(`bytes=${TOTAL}-`, TOTAL);
      throw new Error('expected parseRange to throw');
    } catch (error) {
      expect((error as RangeNotSatisfiableException).responseHeaders).toEqual({
        'Content-Range': `bytes */${TOTAL}`,
      });
    }
  });
});
