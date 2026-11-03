import { registerAs } from '@nestjs/config';

export const DEFAULT_UPLOAD_MAX_BYTES = 10737418240;

export default registerAs('upload', () => ({
  maxBytes: parseInt(
    process.env.UPLOAD_MAX_BYTES ?? String(DEFAULT_UPLOAD_MAX_BYTES),
    10,
  ),
  partSizeBytes: parseInt(process.env.UPLOAD_PART_SIZE_BYTES ?? '67108864', 10),
  urlTtlSeconds: parseInt(process.env.UPLOAD_URL_TTL_SECONDS ?? '3600', 10),
}));
