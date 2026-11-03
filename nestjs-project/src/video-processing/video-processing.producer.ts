import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import {
  PROCESS_VIDEO_JOB,
  PROCESS_VIDEO_JOB_OPTIONS,
  VIDEO_PROCESSING_QUEUE,
} from './video-processing.constants';
import type { ProcessVideoJobData } from './video-processing.constants';

@Injectable()
export class VideoProcessingProducer {
  constructor(
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly queue: Queue<ProcessVideoJobData>,
  ) {}

  async enqueue(videoId: string): Promise<void> {
    const data: ProcessVideoJobData = { videoId };
    // jobId = videoId makes a repeated enqueue a no-op: BullMQ ignores a job whose id already exists.
    await this.queue.add(PROCESS_VIDEO_JOB, data, {
      ...PROCESS_VIDEO_JOB_OPTIONS,
      jobId: videoId,
    });
  }
}
