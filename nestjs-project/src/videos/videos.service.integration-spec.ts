// Requires RustFS, Redis and Postgres. The presigned PUT URLs carry the
// S3_PUBLIC_ENDPOINT host, so inside the nestjs-api container set
// S3_PUBLIC_ENDPOINT=http://rustfs:9000 for the test run.
import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import type { ConfigType } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import uploadConfig from '../config/upload.config';
import { UploadSizeMismatchException } from '../common/exceptions/domain.exception';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { ensureBucket } from '../test/minio';
import { User } from '../users/entities/user.entity';
import { StorageService } from '../storage/storage.service';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
} from '../video-processing/video-processing.constants';
import { Video, VideoProcessingStatus } from './entities/video.entity';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

async function putPart(url: string, bytes: Buffer): Promise<string> {
  const res = await fetch(url, { method: 'PUT', body: new Uint8Array(bytes) });
  if (!res.ok) {
    throw new Error(`PUT to presigned URL failed with ${res.status}`);
  }
  const etag = res.headers.get('etag');
  if (!etag) {
    throw new Error('PUT response had no ETag header');
  }
  return etag;
}

describe('VideosService (integration, RustFS + Redis + Postgres)', () => {
  let moduleRef: TestingModule;
  let service: VideosService;
  let storage: StorageService;
  let dataSource: DataSource;
  let queue: Queue;
  let userCounter = 0;

  beforeAll(async () => {
    const config = {
      isGlobal: true,
      load: [storageConfig, queueConfig, uploadConfig],
    };
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot(config),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        VideosModule,
      ],
    }).compile();

    service = moduleRef.get(VideosService);
    storage = moduleRef.get(StorageService);
    dataSource = moduleRef.get(DataSource);
    queue = moduleRef.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    const storageSettings = moduleRef.get<ConfigType<typeof storageConfig>>(
      storageConfig.KEY,
    );
    await ensureBucket(storageSettings.bucket);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true });
  });

  async function createOwner(): Promise<{ userId: string }> {
    const userRepository = dataSource.getRepository(User);
    const channelRepository = dataSource.getRepository(Channel);
    const user = await userRepository.save(
      userRepository.create({
        email: `video_svc_${++userCounter}@example.com`,
        password: 'hashed',
      }),
    );
    await channelRepository.save(
      channelRepository.create({
        name: `Video Owner ${userCounter}`,
        nickname: `video_owner_${userCounter}`,
        user_id: user.id,
      }),
    );
    return { userId: user.id };
  }

  it('persists an uploading/draft video with upload_id and reports one part for a small file', async () => {
    const { userId } = await createOwner();

    const result = await service.initiateUpload(userId, {
      fileName: 'clip.mp4',
      contentType: 'video/mp4',
      sizeBytes: 1024,
    });

    const video = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ slug: result.slug });
    expect(result).toMatchObject({
      processingStatus: VideoProcessingStatus.UPLOADING,
      partCount: 1,
    });
    expect(video.upload_id).not.toBeNull();
    expect(
      await storage.listParts(video.storage_key, video.upload_id ?? ''),
    ).toEqual([]);
  });

  it('completes the upload into processing and enqueues a process-video job', async () => {
    const { userId } = await createOwner();
    const bytes = Buffer.alloc(1024, 1);
    const { slug } = await service.initiateUpload(userId, {
      fileName: 'clip.mp4',
      contentType: 'video/mp4',
      sizeBytes: bytes.length,
    });
    const { parts } = await service.signUploadParts(userId, slug, [1]);
    const etag = await putPart(parts[0].url, bytes);

    await service.completeUpload(userId, slug, [{ partNumber: 1, etag }]);

    const video = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ slug });
    expect(video).toMatchObject({
      processing_status: VideoProcessingStatus.PROCESSING,
      upload_id: null,
      size_bytes: bytes.length,
    });
    const job = await queue.getJob(video.id);
    expect(job?.name).toBe(PROCESS_VIDEO_JOB);
    expect(job?.id).toBe(video.id);
  });

  it('deletes the object and fails the video when the stored size exceeds the declared size', async () => {
    const { userId } = await createOwner();
    const { slug } = await service.initiateUpload(userId, {
      fileName: 'clip.mp4',
      contentType: 'video/mp4',
      sizeBytes: 1024,
    });
    const { parts } = await service.signUploadParts(userId, slug, [1]);
    const etag = await putPart(parts[0].url, Buffer.alloc(2048, 2));

    await expect(
      service.completeUpload(userId, slug, [{ partNumber: 1, etag }]),
    ).rejects.toBeInstanceOf(UploadSizeMismatchException);

    const video = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ slug });
    expect(video.processing_status).toBe(VideoProcessingStatus.FAILED);
    await expect(storage.headObject(video.storage_key)).rejects.toThrow();
    expect(await queue.getJob(video.id)).toBeUndefined();
  });

  it('removes the video row and the multipart upload on abort', async () => {
    const { userId } = await createOwner();
    const { slug } = await service.initiateUpload(userId, {
      fileName: 'clip.mp4',
      contentType: 'video/mp4',
      sizeBytes: 1024,
    });
    const video = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ slug });

    await service.abortUpload(userId, slug);

    expect(
      await dataSource.getRepository(Video).findOneBy({ slug }),
    ).toBeNull();
    await expect(
      storage.listParts(video.storage_key, video.upload_id ?? ''),
    ).rejects.toThrow();
  });
});
