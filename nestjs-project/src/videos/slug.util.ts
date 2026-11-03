import { randomBytes } from 'node:crypto';

const SLUG_ALPHABET =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const SLUG_LENGTH = 11;
// 248 is the largest multiple of the alphabet size (62) below 256, so
// `byte % 62` is uniform over the alphabet for every accepted byte.
const UNBIASED_BYTE_LIMIT = 248;

export function generateVideoSlug(): string {
  const slug: string[] = [];
  while (slug.length < SLUG_LENGTH) {
    for (const byte of randomBytes(SLUG_LENGTH)) {
      if (byte < UNBIASED_BYTE_LIMIT && slug.length < SLUG_LENGTH) {
        slug.push(SLUG_ALPHABET[byte % SLUG_ALPHABET.length]);
      }
    }
  }
  return slug.join('');
}
