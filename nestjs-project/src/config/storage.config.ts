import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  endpoint: process.env.S3_ENDPOINT ?? '',
  publicEndpoint: process.env.S3_PUBLIC_ENDPOINT ?? '',
  region: process.env.S3_REGION ?? 'us-east-1',
  accessKeyId: process.env.S3_ACCESS_KEY ?? '',
  secretAccessKey: process.env.S3_SECRET_KEY ?? '',
  bucket: process.env.S3_BUCKET ?? '',
}));
