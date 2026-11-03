import { generateVideoSlug } from './slug.util';

const SLUG_PATTERN = /^[0-9A-Za-z]{11}$/;
const SAMPLE_SIZE = 10_000;

describe('generateVideoSlug', () => {
  const samples = Array.from({ length: SAMPLE_SIZE }, () =>
    generateVideoSlug(),
  );

  it('should generate 11-character slugs made only of [0-9A-Za-z]', () => {
    const allValid = samples.every((slug) => SLUG_PATTERN.test(slug));

    expect(allValid).toBe(true);
  });

  it('should not repeat any slug across 10 000 generations', () => {
    const uniqueSlugs = new Set(samples);

    expect(uniqueSlugs.size).toBe(SAMPLE_SIZE);
  });
});
