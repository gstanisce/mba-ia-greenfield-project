// Requires RustFS, Redis and Postgres. The presigned PUT URLs carry the
// S3_PUBLIC_ENDPOINT host, so inside the nestjs-api container set
// S3_PUBLIC_ENDPOINT=http://rustfs:9000 for the test run.
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import type { ConfigType } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import type { Queue } from 'bullmq';
import request from 'supertest';
import type { Response } from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { MailService } from '../src/mail/mail.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import storageConfig from '../src/config/storage.config';
import { DEFAULT_UPLOAD_MAX_BYTES } from '../src/config/upload.config';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { clearPrefix, ensureBucket } from '../src/test/minio';
import { Video } from '../src/videos/entities/video.entity';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
} from '../src/video-processing/video-processing.constants';

const ONE_MIB = 1024 * 1024;
const PASSWORD = 'password123';
const SLUG_PATTERN = /^[0-9A-Za-z]{11}$/;

interface ErrorBody {
  error?: string;
}

interface InitiateBody {
  slug: string;
  processingStatus: string;
  publicationStatus: string;
  partCount: number;
  partSizeBytes: number;
  maxBytes: number;
  urlTtlSeconds: number;
}

interface SignedBody {
  parts: { partNumber: number; url: string }[];
  expiresAt: string;
}

interface ListBody {
  parts: { partNumber: number; etag: string; sizeBytes: number }[];
}

function bodyOf<T>(res: Response): T {
  return res.body as T;
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

describe('Videos upload (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let queue: Queue;
  let throttlerStorage: ThrottlerStorageService;
  let bucket: string;
  let ownerToken: string;

  beforeAll(async () => {
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
  });

  afterAll(async () => {
    await app.close();
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

  async function initiateUpload(
    token: string,
    sizeBytes = ONE_MIB,
  ): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/videos/uploads')
      .set('Authorization', `Bearer ${token}`)
      .send({ fileName: 'clip.mp4', contentType: 'video/mp4', sizeBytes })
      .expect(201);
    return bodyOf<InitiateBody>(res).slug;
  }

  async function uploadFirstPart(
    token: string,
    slug: string,
    bytes: Buffer,
  ): Promise<string> {
    const signed = await request(app.getHttpServer())
      .post(`/videos/${slug}/upload/parts`)
      .set('Authorization', `Bearer ${token}`)
      .send({ partNumbers: [1] })
      .expect(200);
    return putPart(bodyOf<SignedBody>(signed).parts[0].url, bytes);
  }

  describe('POST /videos/uploads', () => {
    it('returns 201 with a draft in uploading status and a single part', async () => {
      const res = await request(app.getHttpServer())
        .post('/videos/uploads')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          fileName: 'clip.mp4',
          contentType: 'video/mp4',
          sizeBytes: ONE_MIB,
        })
        .expect(201);

      const body = bodyOf<InitiateBody>(res);
      expect(body.slug).toMatch(SLUG_PATTERN);
      expect(body).toMatchObject({
        processingStatus: 'uploading',
        publicationStatus: 'draft',
        partCount: 1,
      });
      expect(body.partSizeBytes).toBeGreaterThan(0);
      expect(body.maxBytes).toBeGreaterThan(0);
      expect(body.urlTtlSeconds).toBeGreaterThan(0);

      const video = await dataSource
        .getRepository(Video)
        .findOneByOrFail({ slug: body.slug });
      expect(video.upload_id).not.toBeNull();
    });

    it('returns 400 VALIDATION_ERROR for a disallowed content type and for a size above the maximum', async () => {
      const maxBytes = Number(
        process.env.UPLOAD_MAX_BYTES ?? DEFAULT_UPLOAD_MAX_BYTES,
      );

      const wrongType = await request(app.getHttpServer())
        .post('/videos/uploads')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          fileName: 'clip.png',
          contentType: 'image/png',
          sizeBytes: ONE_MIB,
        })
        .expect(400);
      const tooBig = await request(app.getHttpServer())
        .post('/videos/uploads')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          fileName: 'clip.mp4',
          contentType: 'video/mp4',
          sizeBytes: maxBytes + 1,
        })
        .expect(400);

      expect(bodyOf<ErrorBody>(wrongType).error).toBe('VALIDATION_ERROR');
      expect(bodyOf<ErrorBody>(tooBig).error).toBe('VALIDATION_ERROR');
      expect(await dataSource.getRepository(Video).count()).toBe(0);
    });

    it('returns 401 without an Authorization header', async () => {
      await request(app.getHttpServer())
        .post('/videos/uploads')
        .send({
          fileName: 'clip.mp4',
          contentType: 'video/mp4',
          sizeBytes: ONE_MIB,
        })
        .expect(401);
    });
  });

  describe('parts, complete and abort', () => {
    const PART_BYTES = Buffer.alloc(ONE_MIB, 7);

    it('signs a part, uploads it to storage and lists it back', async () => {
      const slug = await initiateUpload(ownerToken);

      const signed = await request(app.getHttpServer())
        .post(`/videos/${slug}/upload/parts`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ partNumbers: [1] })
        .expect(200);
      const signedBody = bodyOf<SignedBody>(signed);
      expect(signedBody.parts).toHaveLength(1);
      expect(signedBody.parts[0].partNumber).toBe(1);
      expect(new URL(signedBody.parts[0].url).protocol).toMatch(/^https?:$/);
      expect(Date.parse(signedBody.expiresAt)).toBeGreaterThan(Date.now());

      const etag = await putPart(signedBody.parts[0].url, PART_BYTES);

      const listed = await request(app.getHttpServer())
        .get(`/videos/${slug}/upload/parts`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);
      expect(bodyOf<ListBody>(listed).parts).toEqual([
        { partNumber: 1, etag, sizeBytes: ONE_MIB },
      ]);
    });

    it('completes the upload with 202 and enqueues a process-video job', async () => {
      const slug = await initiateUpload(ownerToken);
      const etag = await uploadFirstPart(ownerToken, slug, PART_BYTES);

      const res = await request(app.getHttpServer())
        .post(`/videos/${slug}/upload/complete`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ parts: [{ partNumber: 1, etag }] })
        .expect(202);

      expect(bodyOf<{ slug: string; processingStatus: string }>(res)).toEqual({
        slug,
        processingStatus: 'processing',
      });
      const video = await dataSource
        .getRepository(Video)
        .findOneByOrFail({ slug });
      expect(video).toMatchObject({
        processing_status: 'processing',
        upload_id: null,
        size_bytes: ONE_MIB,
      });
      const job = await queue.getJob(video.id);
      expect(job?.name).toBe(PROCESS_VIDEO_JOB);
      expect(job?.data).toEqual({ videoId: video.id });
    });

    it('returns 400 INVALID_UPLOAD_PARTS for a wrong ETag and enqueues nothing', async () => {
      const slug = await initiateUpload(ownerToken);
      await uploadFirstPart(ownerToken, slug, PART_BYTES);

      const res = await request(app.getHttpServer())
        .post(`/videos/${slug}/upload/complete`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ parts: [{ partNumber: 1, etag: '"0000"' }] })
        .expect(400);

      expect(bodyOf<ErrorBody>(res).error).toBe('INVALID_UPLOAD_PARTS');
      const video = await dataSource
        .getRepository(Video)
        .findOneByOrFail({ slug });
      expect(video.processing_status).toBe('uploading');
      expect(await queue.getJob(video.id)).toBeUndefined();
    });

    it('aborts the upload with 204, after which the video is not found', async () => {
      const slug = await initiateUpload(ownerToken);

      await request(app.getHttpServer())
        .delete(`/videos/${slug}/upload`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(204);

      const listed = await request(app.getHttpServer())
        .get(`/videos/${slug}/upload/parts`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(404);
      expect(bodyOf<ErrorBody>(listed).error).toBe('VIDEO_NOT_FOUND');
      expect(
        await dataSource.getRepository(Video).findOneBy({ slug }),
      ).toBeNull();
    });

    it('returns 409 UPLOAD_NOT_IN_PROGRESS for sign and abort once the upload is complete', async () => {
      const slug = await initiateUpload(ownerToken);
      const etag = await uploadFirstPart(ownerToken, slug, PART_BYTES);
      await request(app.getHttpServer())
        .post(`/videos/${slug}/upload/complete`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ parts: [{ partNumber: 1, etag }] })
        .expect(202);

      const signed = await request(app.getHttpServer())
        .post(`/videos/${slug}/upload/parts`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ partNumbers: [1] })
        .expect(409);
      const aborted = await request(app.getHttpServer())
        .delete(`/videos/${slug}/upload`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(409);

      expect(bodyOf<ErrorBody>(signed).error).toBe('UPLOAD_NOT_IN_PROGRESS');
      expect(bodyOf<ErrorBody>(aborted).error).toBe('UPLOAD_NOT_IN_PROGRESS');
    });
  });

  describe('isolation between owners and malformed slugs', () => {
    it('answers 404 VIDEO_NOT_FOUND to another user on all four slug routes and leaves the owner video intact', async () => {
      const slug = await initiateUpload(ownerToken);
      const otherToken = await createConfirmedUser('other@example.com');
      const auth = { Authorization: `Bearer ${otherToken}` };

      const responses = await Promise.all([
        request(app.getHttpServer())
          .post(`/videos/${slug}/upload/parts`)
          .set(auth)
          .send({ partNumbers: [1] }),
        request(app.getHttpServer())
          .get(`/videos/${slug}/upload/parts`)
          .set(auth),
        request(app.getHttpServer())
          .post(`/videos/${slug}/upload/complete`)
          .set(auth)
          .send({ parts: [{ partNumber: 1, etag: '"e"' }] }),
        request(app.getHttpServer()).delete(`/videos/${slug}/upload`).set(auth),
      ]);

      for (const res of responses) {
        expect(res.status).toBe(404);
        expect(bodyOf<ErrorBody>(res).error).toBe('VIDEO_NOT_FOUND');
      }
      const video = await dataSource
        .getRepository(Video)
        .findOneByOrFail({ slug });
      expect(video.processing_status).toBe('uploading');
      expect(video.upload_id).not.toBeNull();
    });

    it('answers 404 VIDEO_NOT_FOUND for slugs that are malformed', async () => {
      const short = await request(app.getHttpServer())
        .get('/videos/abc/upload/parts')
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(404);
      const badChar = await request(app.getHttpServer())
        .get('/videos/AAAAAAAAAA!/upload/parts')
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(404);

      expect(bodyOf<ErrorBody>(short).error).toBe('VIDEO_NOT_FOUND');
      expect(bodyOf<ErrorBody>(badChar).error).toBe('VIDEO_NOT_FOUND');
    });
  });
});
