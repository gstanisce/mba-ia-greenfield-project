export const MAX_SLUG_ATTEMPTS = 5 as const;
export const SLUG_COLUMN = 'slug' as const;
export const UPLOAD_SIZE_MISMATCH_REASON =
  'Uploaded file size exceeds the declared size' as const;

export const VIDEO_SLUG_PATTERN = /^[0-9A-Za-z]{11}$/;

export const VIDEO_CONTENT_TYPES = [
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-matroska',
] as const;

export type VideoContentType = (typeof VIDEO_CONTENT_TYPES)[number];

export const originalStorageKey = (videoId: string): string =>
  `videos/${videoId}/original`;

export const thumbnailStorageKey = (videoId: string): string =>
  `videos/${videoId}/thumbnail.jpg`;
