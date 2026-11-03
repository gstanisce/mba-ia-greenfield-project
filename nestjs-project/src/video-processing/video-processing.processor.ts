import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import type { Job } from 'bullmq';
import { Repository } from 'typeorm';
import { MediaProbeService } from '../media/media-probe.service';
import { StorageService } from '../storage/storage.service';
import { Video, VideoProcessingStatus } from '../videos/entities/video.entity';
import { thumbnailStorageKey } from '../videos/videos.constants';
import {
  PROCESSING_URL_TTL_SECONDS,
  THUMBNAIL_CONTENT_TYPE,
  THUMBNAIL_POSITION_RATIO,
  VIDEO_PROCESSING_QUEUE,
} from './video-processing.constants';
import type { ProcessVideoJobData } from './video-processing.constants';

@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessingProcessor extends WorkerHost {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storage: StorageService,
    private readonly mediaProbe: MediaProbeService,
  ) {
    super();
  }

  async process(job: Job<ProcessVideoJobData>): Promise<void> {
    const video = await this.videoRepository.findOneBy({
      id: job.data.videoId,
    });
    // A missing video has nothing left to process; a ready one is already done (idempotent re-enqueue).
    if (!video || video.processing_status === VideoProcessingStatus.READY) {
      return;
    }

    try {
      await this.transcode(video);
    } catch (error) {
      if (job.attemptsMade + 1 >= (job.opts.attempts ?? 1)) {
        await this.markFailed(video.id, error);
      }
      throw error;
    }
  }

  private async transcode(video: Video): Promise<void> {
    const sourceUrl = await this.storage.presignGetObject(
      video.storage_key,
      PROCESSING_URL_TTL_SECONDS,
    );
    const probe = await this.mediaProbe.probe(sourceUrl);
    const thumbnail = await this.mediaProbe.extractThumbnail(
      sourceUrl,
      probe.durationSeconds * THUMBNAIL_POSITION_RATIO,
    );

    const key = thumbnailStorageKey(video.id);
    await this.storage.putObject(key, thumbnail, THUMBNAIL_CONTENT_TYPE);

    // save() rather than update(): TypeORM's update() typing rejects the nullable JSON metadata.
    video.processing_status = VideoProcessingStatus.READY;
    video.processing_error = null;
    video.duration_seconds = String(probe.durationSeconds);
    video.metadata = probe.metadata;
    video.thumbnail_key = key;
    video.processed_at = new Date();
    await this.videoRepository.save(video);
  }

  private async markFailed(videoId: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await this.videoRepository.update(
      { id: videoId },
      {
        processing_status: VideoProcessingStatus.FAILED,
        processing_error: message,
      },
    );
  }
}
