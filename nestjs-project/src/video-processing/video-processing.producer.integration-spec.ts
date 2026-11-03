import { randomUUID } from 'node:crypto';
import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import {
  PROCESS_VIDEO_JOB,
  PROCESS_VIDEO_JOB_OPTIONS,
  VIDEO_PROCESSING_QUEUE,
} from './video-processing.constants';
import { VideoProcessingQueueModule } from './video-processing-queue.module';
import { VideoProcessingProducer } from './video-processing.producer';

describe('VideoProcessingProducer (integration, Redis)', () => {
  let moduleRef: TestingModule;
  let producer: VideoProcessingProducer;
  let queue: Queue;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        VideoProcessingQueueModule,
      ],
      providers: [VideoProcessingProducer],
    }).compile();
    producer = moduleRef.get(VideoProcessingProducer);
    queue = moduleRef.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(async () => {
    await queue.obliterate({ force: true });
  });

  it('should keep the test queue under the "test" prefix, apart from the worker queue', () => {
    expect(queue.opts.prefix).toBe('test');
  });

  it('should enqueue a process-video job with { videoId } as data and videoId as job id', async () => {
    const videoId = randomUUID();

    await producer.enqueue(videoId);
    const job = await queue.getJob(videoId);

    expect(job?.name).toBe(PROCESS_VIDEO_JOB);
    expect(job?.data).toEqual({ videoId });
    expect(job?.id).toBe(videoId);
  });

  it('should apply 3 attempts and exponential backoff of 5000 ms', async () => {
    const videoId = randomUUID();

    await producer.enqueue(videoId);
    const job = await queue.getJob(videoId);

    expect(job?.opts.attempts).toBe(PROCESS_VIDEO_JOB_OPTIONS.attempts);
    expect(job?.opts.backoff).toEqual(PROCESS_VIDEO_JOB_OPTIONS.backoff);
  });

  it('should keep a single waiting job when the same videoId is enqueued twice', async () => {
    const videoId = randomUUID();

    await producer.enqueue(videoId);
    await producer.enqueue(videoId);

    expect(await queue.getJobCounts('waiting')).toEqual({ waiting: 1 });
  });
});
