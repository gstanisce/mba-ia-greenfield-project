// Requires RustFS reachable through S3_ENDPOINT. The presigned URLs carry the
// S3_PUBLIC_ENDPOINT host, so that host must also be reachable from the test
// process. Inside the nestjs-api container set S3_PUBLIC_ENDPOINT=http://rustfs:9000
// for the test run; the browser-facing value stays http://localhost:9000 in .env.
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { ConfigModule } from '@nestjs/config';
import type { ConfigType } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { InvalidUploadPartsException } from '../common/exceptions/domain.exception';
import { clearPrefix, ensureBucket } from '../test/minio';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

const PREFIX = 'videos/';
const URL_TTL_SECONDS = 300;
const PART_SIZE = 5 * 1024 * 1024;

const uploadPart = async (url: string, bytes: Buffer): Promise<string> => {
  const res = await fetch(url, { method: 'PUT', body: new Uint8Array(bytes) });
  if (!res.ok) {
    throw new Error(`PUT to presigned URL failed with ${res.status}`);
  }
  const etag = res.headers.get('etag');
  if (!etag) {
    throw new Error('PUT response had no ETag header');
  }
  return etag;
};

const readAll = async (body: Readable): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
};

describe('StorageService (integration, RustFS)', () => {
  let moduleRef: TestingModule;
  let service: StorageService;
  let config: ConfigType<typeof storageConfig>;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();
    service = moduleRef.get(StorageService);
    config = moduleRef.get(storageConfig.KEY);
    await ensureBucket(config.bucket);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(async () => {
    await clearPrefix(config.bucket, PREFIX);
  });

  it('should complete a two-part upload into an object whose size is the sum of the parts', async () => {
    const key = `${PREFIX}${randomUUID()}/original`;
    const uploadId = await service.createMultipartUpload(key, 'video/mp4');
    const urls = await service.presignUploadParts(
      key,
      uploadId,
      [1, 2],
      URL_TTL_SECONDS,
    );
    const first = Buffer.alloc(PART_SIZE, 1);
    const second = Buffer.from('tail');

    const etag1 = await uploadPart(urls[1], first);
    const etag2 = await uploadPart(urls[2], second);
    await service.completeMultipartUpload(key, uploadId, [
      { partNumber: 1, etag: etag1 },
      { partNumber: 2, etag: etag2 },
    ]);

    const head = await service.headObject(key);
    expect(head.contentLength).toBe(first.length + second.length);
  });

  it('should list exactly the parts that were uploaded', async () => {
    const key = `${PREFIX}${randomUUID()}/original`;
    const uploadId = await service.createMultipartUpload(key, 'video/mp4');
    const [url] = Object.values(
      await service.presignUploadParts(key, uploadId, [1], URL_TTL_SECONDS),
    );
    await uploadPart(url, Buffer.alloc(PART_SIZE, 2));

    const parts = await service.listParts(key, uploadId);

    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ partNumber: 1, size: PART_SIZE });
  });

  it('should reject completion with a wrong ETag as INVALID_UPLOAD_PARTS', async () => {
    const key = `${PREFIX}${randomUUID()}/original`;
    const uploadId = await service.createMultipartUpload(key, 'video/mp4');
    const [url] = Object.values(
      await service.presignUploadParts(key, uploadId, [1], URL_TTL_SECONDS),
    );
    await uploadPart(url, Buffer.alloc(PART_SIZE, 3));

    await expect(
      service.completeMultipartUpload(key, uploadId, [
        { partNumber: 1, etag: '"0000000000000000000000000000000000"' },
      ]),
    ).rejects.toBeInstanceOf(InvalidUploadPartsException);
  });

  it('should return only the requested byte range with its Content-Range', async () => {
    const key = `${PREFIX}${randomUUID()}/original`;
    const bytes = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));
    await service.putObject(key, bytes, 'video/mp4');

    const stream = await service.getObjectStream(key, 'bytes=0-99');
    const received = await readAll(stream.body);

    expect(received.equals(bytes.subarray(0, 100))).toBe(true);
    expect(stream.contentRange).toBe('bytes 0-99/1000');
  });

  it('should remove the upload so listParts fails after abort', async () => {
    const key = `${PREFIX}${randomUUID()}/original`;
    const uploadId = await service.createMultipartUpload(key, 'video/mp4');

    await service.abortMultipartUpload(key, uploadId);

    await expect(service.listParts(key, uploadId)).rejects.toThrow();
  });

  it('should presign uploads against the public endpoint and downloads against the internal one', async () => {
    const key = `${PREFIX}${randomUUID()}/original`;
    const uploadId = await service.createMultipartUpload(key, 'video/mp4');
    const [uploadUrl] = Object.values(
      await service.presignUploadParts(key, uploadId, [1], URL_TTL_SECONDS),
    );
    const downloadUrl = await service.presignGetObject(key, URL_TTL_SECONDS);

    expect(new URL(uploadUrl).origin).toBe(
      new URL(config.publicEndpoint).origin,
    );
    expect(new URL(downloadUrl).origin).toBe(new URL(config.endpoint).origin);
    await service.abortMultipartUpload(key, uploadId);
  });
});
