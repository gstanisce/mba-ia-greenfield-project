import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import { VIDEO_PROCESSING_QUEUE } from './video-processing.constants';
import { VideoProcessingQueueModule } from './video-processing-queue.module';

// Opens a real BullMQ connection, so it runs against the Redis service.
describe('VideoProcessingQueueModule (integration)', () => {
  let moduleRef: TestingModule;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        VideoProcessingQueueModule,
      ],
    }).compile();
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  it('should resolve the video-processing queue through getQueueToken', () => {
    const queue = moduleRef.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));

    expect(queue).toBeInstanceOf(Queue);
    expect(queue.name).toBe(VIDEO_PROCESSING_QUEUE);
  });

  it('should register the queue under the configured BullMQ prefix', () => {
    const queue = moduleRef.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));

    expect(queue.opts.prefix).toBe(queueConfig().prefix);
  });
});
