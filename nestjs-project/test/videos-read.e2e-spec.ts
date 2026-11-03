// Requires RustFS, Redis and Postgres plus the FFmpeg binaries. Inside the nestjs-api
// container set S3_PUBLIC_ENDPOINT=http://rustfs:9000 so the PUT to presigned URLs works.
import { readFile } from 'node:fs/promises';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import type { ConfigType } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import type { Job, Queue } from 'bullmq';
import request from 'supertest';
import type { Response } from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { MailService } from '../src/mail/mail.service';
import { MediaProbeService } from '../src/media/media-probe.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import storageConfig from '../src/config/storage.config';
import { StorageModule } from '../src/storage/storage.module';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { clearPrefix, ensureBucket } from '../src/test/minio';
import { createVideoFixtures } from '../src/test/video-fixtures';
import type { VideoFixtures } from '../src/test/video-fixtures';
import {
  Video,
  VideoProcessingStatus,
} from '../src/videos/entities/video.entity';
import { VideoProcessingProcessor } from '../src/video-processing/video-processing.processor';
import {
  VIDEO_PROCESSING_QUEUE,
  type ProcessVideoJobData,
} from '../src/video-processing/video-processing.constants';

const PASSWORD = 'password123';

interface ErrorBody {
  error?: string;
}

interface InitiateBody {
  slug: string;
}

interface SignedBody {
  parts: { partNumber: number; url: string }[];
}

interface DetailsBody {
  processingStatus: string;
  durationSeconds: number | null;
  metadata: { width: number; height: number } | null;
  hasThumbnail: boolean;
  sizeBytes: number;
  processingError: string | null;
}

function bodyOf<T>(res: Response): T {
  return res.body as T;
}

// Collects a binary response body into a Buffer, so tests can compare bytes.
// superagent hands the parser the raw Node response stream at runtime, which its
// Response type does not describe; the cast is limited to this helper.
function collectBinary(
  response: Response,
  callback: (err: Error | null, body: Buffer) => void,
): void {
  const stream = response as unknown as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  stream.on('end', () => callback(null, Buffer.concat(chunks)));
}

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

describe('Videos read (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let queue: Queue;
  let processor: VideoProcessingProcessor;
  let throttlerStorage: ThrottlerStorageService;
  let bucket: string;
  let fixtures: VideoFixtures;
  let fixtureBytes: Buffer;
  let ownerToken: string;

  beforeAll(async () => {
    fixtures = await createVideoFixtures();
    fixtureBytes = await readFile(fixtures.validVideoPath);

    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    queue = moduleFixture.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
    bucket = moduleFixture.get<ConfigType<typeof storageConfig>>(
      storageConfig.KEY,
    ).bucket;
    await ensureBucket(bucket);

    // The worker's processor, built without its queue module: no BullMQ worker
    // connects, so each test runs the job explicitly and deterministically.
    const workerModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
      providers: [
        VideoProcessingProcessor,
        MediaProbeService,
        {
          provide: getRepositoryToken(Video),
          useValue: dataSource.getRepository(Video),
        },
      ],
    }).compile();
    processor = workerModule.get(VideoProcessingProcessor);
  });

  afterAll(async () => {
    await app.close();
    await fixtures.cleanup();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await clearPrefix(bucket, 'videos/');
    await queue.obliterate({ force: true });
    throttlerStorage.storage.clear();
    ownerToken = await createConfirmedUser('owner@example.com');
  });

  async function createConfirmedUser(email: string): Promise<string> {
    let confirmationToken = '';
    jest
      .spyOn(app.get(MailService), 'sendConfirmationEmail')
      .mockImplementationOnce((_e: string, _n: string, t: string) => {
        confirmationToken = t;
        return Promise.resolve();
      });
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: PASSWORD })
      .expect(201);
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token: confirmationToken })
      .expect(204);
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    return bodyOf<{ access_token: string }>(login).access_token;
  }

  // Runs the real upload flow (initiate, sign, PUT, complete); the video stays in processing.
  async function uploadToProcessing(token: string): Promise<string> {
    const init = await request(app.getHttpServer())
      .post('/videos/uploads')
      .set('Authorization', `Bearer ${token}`)
      .send({
        fileName: 'clip.mp4',
        contentType: 'video/mp4',
        sizeBytes: fixtureBytes.length,
      })
      .expect(201);
    const { slug } = bodyOf<InitiateBody>(init);

    const signed = await request(app.getHttpServer())
      .post(`/videos/${slug}/upload/parts`)
      .set('Authorization', `Bearer ${token}`)
      .send({ partNumbers: [1] })
      .expect(200);
    const etag = await putPart(
      bodyOf<SignedBody>(signed).parts[0].url,
      fixtureBytes,
    );

    await request(app.getHttpServer())
      .post(`/videos/${slug}/upload/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ parts: [{ partNumber: 1, etag }] })
      .expect(202);
    return slug;
  }

  // Runs the worker's processor once on the queued job, the way the worker would.
  async function processVideo(slug: string): Promise<void> {
    const video = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ slug });
    const job = {
      data: { videoId: video.id },
      attemptsMade: 0,
      opts: { attempts: 3 },
    } as unknown as Job<ProcessVideoJobData>;
    await processor.process(job);
  }

  async function uploadReadyVideo(token: string): Promise<string> {
    const slug = await uploadToProcessing(token);
    await processVideo(slug);
    return slug;
  }

  describe('ready video', () => {
    it('returns the metadata with processingStatus ready and the thumbnail flag', async () => {
      const slug = await uploadReadyVideo(ownerToken);

      const res = await request(app.getHttpServer())
        .get(`/videos/${slug}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);

      const body = bodyOf<DetailsBody>(res);
      expect(body).toMatchObject({
        processingStatus: 'ready',
        hasThumbnail: true,
        sizeBytes: fixtureBytes.length,
      });
      expect(body.durationSeconds).toBeGreaterThan(0);
      expect(body.metadata).toMatchObject({ width: 320, height: 240 });
    });

    it('streams the first 1024 bytes with 206 and Content-Range for a Range request', async () => {
      const slug = await uploadReadyVideo(ownerToken);

      const res = await request(app.getHttpServer())
        .get(`/videos/${slug}/stream`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set('Range', 'bytes=0-1023')
        .buffer(true)
        .parse(collectBinary)
        .expect(206);

      expect(res.headers['content-range']).toBe(
        `bytes 0-1023/${fixtureBytes.length}`,
      );
      expect(res.headers['content-length']).toBe('1024');
      expect(res.headers['accept-ranges']).toBe('bytes');
      expect(res.headers['content-type']).toBe('video/mp4');
      expect((res.body as Buffer).equals(fixtureBytes.subarray(0, 1024))).toBe(
        true,
      );
    });

    it('streams the whole video with 200 and the full Content-Length without a Range', async () => {
      const slug = await uploadReadyVideo(ownerToken);

      const res = await request(app.getHttpServer())
        .get(`/videos/${slug}/stream`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .buffer(true)
        .parse(collectBinary)
        .expect(200);

      expect(res.headers['content-length']).toBe(String(fixtureBytes.length));
      expect(res.headers['accept-ranges']).toBe('bytes');
      expect((res.body as Buffer).equals(fixtureBytes)).toBe(true);
    });

    it('answers 416 RANGE_NOT_SATISFIABLE for a start at the size and for multiple ranges', async () => {
      const slug = await uploadReadyVideo(ownerToken);

      const past = await request(app.getHttpServer())
        .get(`/videos/${slug}/stream`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set('Range', `bytes=${fixtureBytes.length}-`)
        .expect(416);
      const multiple = await request(app.getHttpServer())
        .get(`/videos/${slug}/stream`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set('Range', 'bytes=0-10,20-30')
        .expect(416);

      expect(past.headers['content-range']).toBe(
        `bytes */${fixtureBytes.length}`,
      );
      expect(bodyOf<ErrorBody>(past).error).toBe('RANGE_NOT_SATISFIABLE');
      expect(bodyOf<ErrorBody>(multiple).error).toBe('RANGE_NOT_SATISFIABLE');
    });

    it('downloads as an attachment named after the original file, and resumes with 206', async () => {
      const slug = await uploadReadyVideo(ownerToken);

      const full = await request(app.getHttpServer())
        .get(`/videos/${slug}/download`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);
      const resumed = await request(app.getHttpServer())
        .get(`/videos/${slug}/download`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set('Range', 'bytes=100-199')
        .expect(206);

      expect(full.headers['content-disposition']).toBe(
        'attachment; filename="clip.mp4"',
      );
      expect(resumed.headers['content-range']).toBe(
        `bytes 100-199/${fixtureBytes.length}`,
      );
      expect(resumed.headers['content-disposition']).toBe(
        'attachment; filename="clip.mp4"',
      );
    });

    it('returns the thumbnail as image/jpeg whose body starts with the JPEG magic bytes', async () => {
      const slug = await uploadReadyVideo(ownerToken);

      const res = await request(app.getHttpServer())
        .get(`/videos/${slug}/thumbnail`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .buffer(true)
        .parse(collectBinary)
        .expect(200);

      expect(res.headers['content-type']).toBe('image/jpeg');
      expect(
        (res.body as Buffer).subarray(0, 2).equals(Buffer.from([0xff, 0xd8])),
      ).toBe(true);
    });
  });

  describe('video that is not ready', () => {
    it('blocks stream, download and thumbnail with 409 VIDEO_NOT_READY while processing', async () => {
      const slug = await uploadToProcessing(ownerToken);

      const responses = await Promise.all([
        request(app.getHttpServer())
          .get(`/videos/${slug}/stream`)
          .set('Authorization', `Bearer ${ownerToken}`),
        request(app.getHttpServer())
          .get(`/videos/${slug}/download`)
          .set('Authorization', `Bearer ${ownerToken}`),
        request(app.getHttpServer())
          .get(`/videos/${slug}/thumbnail`)
          .set('Authorization', `Bearer ${ownerToken}`),
      ]);

      for (const res of responses) {
        expect(res.status).toBe(409);
        expect(bodyOf<ErrorBody>(res).error).toBe('VIDEO_NOT_READY');
      }
    });

    it('blocks media on a failed video and still returns its metadata with the processing error', async () => {
      const slug = await uploadToProcessing(ownerToken);
      await dataSource.getRepository(Video).update(
        { slug },
        {
          processing_status: VideoProcessingStatus.FAILED,
          processing_error: 'forced failure',
        },
      );

      const media = await request(app.getHttpServer())
        .get(`/videos/${slug}/stream`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(409);
      const details = await request(app.getHttpServer())
        .get(`/videos/${slug}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);

      expect(bodyOf<ErrorBody>(media).error).toBe('VIDEO_NOT_READY');
      expect(bodyOf<DetailsBody>(details)).toMatchObject({
        processingStatus: 'failed',
      });
      expect(bodyOf<DetailsBody>(details).processingError).not.toBe('');
    });
  });

  describe('isolation between owners', () => {
    it('answers 404 VIDEO_NOT_FOUND to another user on all four read routes, and 401 without a token', async () => {
      const slug = await uploadReadyVideo(ownerToken);
      const otherToken = await createConfirmedUser('other@example.com');
      const auth = { Authorization: `Bearer ${otherToken}` };

      const responses = await Promise.all([
        request(app.getHttpServer()).get(`/videos/${slug}`).set(auth),
        request(app.getHttpServer()).get(`/videos/${slug}/stream`).set(auth),
        request(app.getHttpServer()).get(`/videos/${slug}/download`).set(auth),
        request(app.getHttpServer()).get(`/videos/${slug}/thumbnail`).set(auth),
      ]);
      const anonymous = await request(app.getHttpServer())
        .get(`/videos/${slug}`)
        .expect(401);

      for (const res of responses) {
        expect(res.status).toBe(404);
        expect(bodyOf<ErrorBody>(res).error).toBe('VIDEO_NOT_FOUND');
      }
      expect(anonymous.status).toBe(401);
    });
  });
});
