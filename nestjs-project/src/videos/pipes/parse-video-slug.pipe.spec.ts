import { VideoNotFoundException } from '../../common/exceptions/domain.exception';
import { ParseVideoSlugPipe } from './parse-video-slug.pipe';

describe('ParseVideoSlugPipe', () => {
  const pipe = new ParseVideoSlugPipe();

  it('should accept an 11-character base62 slug', () => {
    expect(pipe.transform('Ab3dE5fG7hI')).toBe('Ab3dE5fG7hI');
  });

  it.each([
    ['too short', 'abc'],
    ['too long', 'abcdefghijkl'],
    ['character outside the base62 alphabet', 'AAAAAAAAAA!'],
    ['empty', ''],
  ])('should reject a %s value with VIDEO_NOT_FOUND', (_label, value) => {
    expect(() => pipe.transform(value)).toThrow(VideoNotFoundException);
  });
});
