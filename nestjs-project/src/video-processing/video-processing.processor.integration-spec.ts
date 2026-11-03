// Requires RustFS, Postgres and the FFmpeg binaries. The processor is built through
// DI without VideoProcessingQueueModule, so no BullMQ worker connects to Redis.
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ConfigModule } from '@nestjs/config';
import type { ConfigType } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { Job } from 'bullmq';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import { MediaProbeService } from '../media/media-probe.service';
import { StorageService } from '../storage/storage.service';
import { StorageModule } from '../storage/storage.module';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { clearPrefix, ensureBucket } from '../test/minio';
import { createVideoFixtures } from '../test/video-fixtures';
import type { VideoFixtures } from '../test/video-fixtures';
import { User } from '../users/entities/user.entity';
import { Video, VideoProcessingStatus } from '../videos/entities/video.entity';
import type { ProcessVideoJobData } from './video-processing.constants';
import { VideoProcessingProcessor } from './video-processing.processor';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
const PREFIX = 'videos/';

function makeJob(
  videoId: string,
  attemptsMade: number,
): Job<ProcessVideoJobData> {
  return {
    data: { videoId },
    attemptsMade,
    opts: { attempts: 3 },
  } as unknown as Job<ProcessVideoJobData>;
}

describe('VideoProcessingProcessor (integration, FFmpeg + RustFS + Postgres)', () => {
  let moduleRef: TestingModule;
  let processor: VideoProcessingProcessor;
  let storage: StorageService;
  let dataSource: DataSource;
  let fixtures: VideoFixtures;
  let bucket: string;
  let userCounter = 0;

  beforeAll(async () => {
    fixtures = await createVideoFixtures();
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video]),
        StorageModule,
      ],
      providers: [VideoProcessingProcessor, MediaProbeService],
    }).compile();

    processor = moduleRef.get(VideoProcessingProcessor);
    storage = moduleRef.get(StorageService);
    dataSource = moduleRef.get(DataSource);
    bucket = moduleRef.get<ConfigType<typeof storageConfig>>(
      storageConfig.KEY,
    ).bucket;
    await ensureBucket(bucket);
  });

  afterAll(async () => {
    await moduleRef.close();
    await fixtures.cleanup();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await clearPrefix(bucket, PREFIX);
  });

  // Creates a draft video whose original object already sits in storage.
  async function createVideoWithOriginal(bytes: Buffer): Promise<Video> {
    const userRepository = dataSource.getRepository(User);
    const channelRepository = dataSource.getRepository(Channel);
    const videoRepository = dataSource.getRepository(Video);

    userCounter += 1;
    const user = await userRepository.save(
      userRepository.create({
        email: `proc_${userCounter}@example.com`,
        password: 'hashed',
      }),
    );
    await channelRepository.save(
      channelRepository.create({
        name: `Processor ${userCounter}`,
        nickname: `processor_${userCounter}`,
        user_id: user.id,
      }),
    );
    const channel = await channelRepository.findOneByOrFail({
      user_id: user.id,
    });
    const id = randomUUID();
    const storageKey = `videos/${id}/original`;
    const video = await videoRepository.save(
      videoRepository.create({
        id,
        slug: `proc${String(userCounter).padStart(7, '0')}`,
        channel_id: channel.id,
        title: 'clip.mp4',
        original_file_name: 'clip.mp4',
        content_type: 'video/mp4',
        size_bytes: bytes.length,
        storage_key: storageKey,
        processing_status: VideoProcessingStatus.PROCESSING,
      }),
    );
    await storage.putObject(storageKey, bytes, 'video/mp4');
    return video;
  }

  it('should mark a valid video ready with duration, metadata and a JPEG thumbnail in storage', async () => {
    const video = await createVideoWithOriginal(
      await readFile(fixtures.validVideoPath),
    );

    await processor.process(makeJob(video.id, 0));

    const ready = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: video.id });
    expect(ready.processing_status).toBe(VideoProcessingStatus.READY);
    expect(Number(ready.duration_seconds)).toBeGreaterThan(0);
    expect(ready.metadata).toMatchObject({ width: 320, height: 240 });
    expect(ready.thumbnail_key).toBe(`videos/${video.id}/thumbnail.jpg`);
    expect(ready.processed_at).not.toBeNull();
    const thumbnail = await storage.headObject(ready.thumbnail_key ?? '');
    expect(thumbnail.contentType).toBe('image/jpeg');
  });

  it('should keep a non-video in processing on a non-final attempt', async () => {
    const video = await createVideoWithOriginal(
      await readFile(fixtures.notAVideoPath),
    );

    await expect(processor.process(makeJob(video.id, 0))).rejects.toThrow();

    const after = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: video.id });
    expect(after.processing_status).toBe(VideoProcessingStatus.PROCESSING);
    expect(after.processing_error).toBeNull();
  });

  it('should mark a non-video failed with a processing_error on the final attempt', async () => {
    const video = await createVideoWithOriginal(
      await readFile(fixtures.notAVideoPath),
    );

    await expect(processor.process(makeJob(video.id, 2))).rejects.toThrow();

    const failed = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: video.id });
    expect(failed.processing_status).toBe(VideoProcessingStatus.FAILED);
    expect(failed.processing_error).toEqual(expect.any(String));
    expect(failed.processing_error).not.toBe('');
  });

  it('should leave a ready video untouched when its job is enqueued again', async () => {
    const video = await createVideoWithOriginal(
      await readFile(fixtures.validVideoPath),
    );
    await processor.process(makeJob(video.id, 0));
    const before = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: video.id });

    await processor.process(makeJob(video.id, 0));

    const after = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: video.id });
    expect(after.duration_seconds).toBe(before.duration_seconds);
    expect(after.metadata).toEqual(before.metadata);
    expect(after.thumbnail_key).toBe(before.thumbnail_key);
  });
});
