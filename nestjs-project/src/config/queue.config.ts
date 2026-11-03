import { registerAs } from '@nestjs/config';

export default registerAs('queue', () => ({
  host: process.env.REDIS_HOST ?? 'redis',
  port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
  // BullMQ key prefix. The worker inherits it from the registered queue, so producer and worker always agree.
  prefix: process.env.QUEUE_PREFIX || 'bull',
}));
