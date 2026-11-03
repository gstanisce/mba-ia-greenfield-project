import { Readable } from 'node:stream';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { QueryFailedError } from 'typeorm';
import uploadConfig from '../config/upload.config';
import {
  ChannelNotFoundException,
  InvalidPartNumbersException,
  UploadNotInProgressException,
  UploadSizeMismatchException,
  VideoNotFoundException,
  VideoNotReadyException,
} from '../common/exceptions/domain.exception';
import { ChannelsService } from '../channels/channels.service';
import { StorageService } from '../storage/storage.service';
import { VideoProcessingProducer } from '../video-processing/video-processing.producer';
import {
  Video,
  VideoProcessingStatus,
  VideoPublicationStatus,
} from './entities/video.entity';
import { UPLOAD_SIZE_MISMATCH_REASON } from './videos.constants';
import { VideosService } from './videos.service';

const MIB = 1024 * 1024;
const USER_ID = 'user-1';
const CHANNEL_ID = 'channel-1';
const OTHER_CHANNEL_ID = 'channel-2';
const SLUG = 'abcdefghijk';
const UPLOAD_ID = 'upload-1';
const UPLOAD_CONFIG = {
  maxBytes: 10 * 1024 * MIB,
  partSizeBytes: 64 * MIB,
  urlTtlSeconds: 3600,
};

function makeVideo(overrides: Partial<Video> = {}): Video {
  return {
    id: 'video-1',
    slug: SLUG,
    channel_id: CHANNEL_ID,
    title: 'clip.mp4',
    original_file_name: 'clip.mp4',
    content_type: 'video/mp4',
    size_bytes: 150 * MIB,
    processing_status: VideoProcessingStatus.UPLOADING,
    publication_status: VideoPublicationStatus.DRAFT,
    storage_key: 'videos/video-1/original',
    upload_id: UPLOAD_ID,
    ...overrides,
  } as Video;
}

function savedEntityAt(save: jest.Mock, call: number): Partial<Video> {
  return (save.mock.calls[call] as [Partial<Video>])[0];
}

describe('VideosService', () => {
  let moduleRef: TestingModule;
  let service: VideosService;
  let videoRepository: {
    create: jest.Mock;
    save: jest.Mock;
    findOneBy: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
  };
  let channelsService: { findByUserId: jest.Mock };
  let storage: {
    createMultipartUpload: jest.Mock;
    abortMultipartUpload: jest.Mock;
    presignUploadParts: jest.Mock;
    listParts: jest.Mock;
    completeMultipartUpload: jest.Mock;
    headObject: jest.Mock;
    deleteObject: jest.Mock;
    getObjectStream: jest.Mock;
  };
  let producer: { enqueue: jest.Mock };

  beforeEach(async () => {
    videoRepository = {
      create: jest.fn((fields: Partial<Video>) => fields),
      save: jest.fn((entity: Partial<Video>) => Promise.resolve(entity)),
      findOneBy: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    };
    channelsService = {
      findByUserId: jest.fn().mockResolvedValue({ id: CHANNEL_ID }),
    };
    storage = {
      createMultipartUpload: jest.fn().mockResolvedValue(UPLOAD_ID),
      abortMultipartUpload: jest.fn(),
      presignUploadParts: jest.fn().mockResolvedValue({
        1: 'https://url/1',
        3: 'https://url/3',
      }),
      listParts: jest.fn(),
      completeMultipartUpload: jest.fn(),
      headObject: jest.fn(),
      deleteObject: jest.fn(),
      getObjectStream: jest.fn(),
    };
    producer = { enqueue: jest.fn() };

    moduleRef = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: ChannelsService, useValue: channelsService },
        { provide: StorageService, useValue: storage },
        { provide: VideoProcessingProducer, useValue: producer },
        { provide: uploadConfig.KEY, useValue: UPLOAD_CONFIG },
      ],
    }).compile();
    service = moduleRef.get(VideosService);
  });

  afterEach(async () => {
    await moduleRef.close();
  });

  describe('initiateUpload', () => {
    it('persists an uploading/draft video with upload_id and reports 3 parts for 150 MiB', async () => {
      const result = await service.initiateUpload(USER_ID, {
        fileName: 'clip.mp4',
        contentType: 'video/mp4',
        sizeBytes: 150 * MIB,
      });

      const saved = savedEntityAt(videoRepository.save, 0);
      expect(result.partCount).toBe(3);
      expect(saved).toMatchObject({
        channel_id: CHANNEL_ID,
        upload_id: UPLOAD_ID,
        processing_status: VideoProcessingStatus.UPLOADING,
        publication_status: VideoPublicationStatus.DRAFT,
      });
    });

    it('retries the slug when it collides with an existing one (23505)', async () => {
      const driverError = Object.assign(new Error('duplicate key'), {
        code: '23505',
        detail: 'Key (slug)=(taken) already exists.',
      });
      const collision = new QueryFailedError('INSERT', [], driverError);
      videoRepository.save
        .mockRejectedValueOnce(collision)
        .mockImplementationOnce((entity: Partial<Video>) =>
          Promise.resolve(entity),
        );

      const result = await service.initiateUpload(USER_ID, {
        fileName: 'clip.mp4',
        contentType: 'video/mp4',
        sizeBytes: 1024,
      });

      expect(videoRepository.save).toHaveBeenCalledTimes(2);
      expect(result.slug).toBe(savedEntityAt(videoRepository.save, 1).slug);
      expect(storage.abortMultipartUpload).not.toHaveBeenCalled();
    });

    it('aborts the multipart upload when the draft cannot be saved', async () => {
      videoRepository.save.mockRejectedValueOnce(new Error('db down'));

      await expect(
        service.initiateUpload(USER_ID, {
          fileName: 'clip.mp4',
          contentType: 'video/mp4',
          sizeBytes: 1024,
        }),
      ).rejects.toThrow('db down');
      expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
        expect.stringMatching(/^videos\/.+\/original$/),
        UPLOAD_ID,
      );
    });

    it('throws CHANNEL_NOT_FOUND and starts no upload for a user without a channel', async () => {
      channelsService.findByUserId.mockResolvedValue(null);

      await expect(
        service.initiateUpload(USER_ID, {
          fileName: 'clip.mp4',
          contentType: 'video/mp4',
          sizeBytes: 1024,
        }),
      ).rejects.toBeInstanceOf(ChannelNotFoundException);
      expect(storage.createMultipartUpload).not.toHaveBeenCalled();
    });
  });

  describe('signUploadParts', () => {
    it('throws VIDEO_NOT_FOUND when the video belongs to another channel', async () => {
      channelsService.findByUserId.mockResolvedValue({ id: OTHER_CHANNEL_ID });
      videoRepository.findOneBy.mockResolvedValue(null);

      await expect(
        service.signUploadParts(USER_ID, SLUG, [1]),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it('rejects part numbers outside 1..partCount with VALIDATION_ERROR', async () => {
      videoRepository.findOneBy.mockResolvedValue(makeVideo());

      await expect(
        service.signUploadParts(USER_ID, SLUG, [0]),
      ).rejects.toBeInstanceOf(InvalidPartNumbersException);
      await expect(
        service.signUploadParts(USER_ID, SLUG, [4]),
      ).rejects.toBeInstanceOf(InvalidPartNumbersException);
    });

    it('delegates to presignUploadParts with the configured TTL', async () => {
      videoRepository.findOneBy.mockResolvedValue(makeVideo());

      const result = await service.signUploadParts(USER_ID, SLUG, [1, 3]);

      expect(storage.presignUploadParts).toHaveBeenCalledWith(
        'videos/video-1/original',
        UPLOAD_ID,
        [1, 3],
        UPLOAD_CONFIG.urlTtlSeconds,
      );
      expect(result.parts).toEqual([
        { partNumber: 1, url: 'https://url/1' },
        { partNumber: 3, url: 'https://url/3' },
      ]);
    });

    it('returns expiresAt in the future, at the configured TTL', async () => {
      videoRepository.findOneBy.mockResolvedValue(makeVideo());
      const before = Date.now();

      const result = await service.signUploadParts(USER_ID, SLUG, [1]);

      const expiresAt = Date.parse(result.expiresAt);
      expect(expiresAt).toBeGreaterThanOrEqual(
        before + UPLOAD_CONFIG.urlTtlSeconds * 1000,
      );
    });
  });

  describe('upload not in progress', () => {
    it.each([
      [
        'signUploadParts',
        (s: VideosService) => s.signUploadParts(USER_ID, SLUG, [1]),
      ],
      [
        'listUploadedParts',
        (s: VideosService) => s.listUploadedParts(USER_ID, SLUG),
      ],
      [
        'completeUpload',
        (s: VideosService) =>
          s.completeUpload(USER_ID, SLUG, [{ partNumber: 1, etag: '"e"' }]),
      ],
      ['abortUpload', (s: VideosService) => s.abortUpload(USER_ID, SLUG)],
    ])(
      '%s throws UPLOAD_NOT_IN_PROGRESS for a video already processing',
      async (_name, call) => {
        videoRepository.findOneBy.mockResolvedValue(
          makeVideo({ processing_status: VideoProcessingStatus.PROCESSING }),
        );

        await expect(call(service)).rejects.toBeInstanceOf(
          UploadNotInProgressException,
        );
      },
    );
  });

  describe('completeUpload', () => {
    it('deletes the object, fails the video and throws UPLOAD_SIZE_MISMATCH when the object is larger', async () => {
      videoRepository.findOneBy.mockResolvedValue(
        makeVideo({ size_bytes: 1024 }),
      );
      storage.headObject.mockResolvedValue({ contentLength: 2048 });

      await expect(
        service.completeUpload(USER_ID, SLUG, [{ partNumber: 1, etag: '"e"' }]),
      ).rejects.toBeInstanceOf(UploadSizeMismatchException);
      expect(storage.deleteObject).toHaveBeenCalledWith(
        'videos/video-1/original',
      );
      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: 'video-1' },
        {
          processing_status: VideoProcessingStatus.FAILED,
          processing_error: UPLOAD_SIZE_MISMATCH_REASON,
          upload_id: null,
        },
      );
      expect(producer.enqueue).not.toHaveBeenCalled();
    });

    it('moves the video to processing with the real size and enqueues the job', async () => {
      videoRepository.findOneBy.mockResolvedValue(
        makeVideo({ size_bytes: 1024 }),
      );
      storage.headObject.mockResolvedValue({ contentLength: 1000 });

      await service.completeUpload(USER_ID, SLUG, [
        { partNumber: 1, etag: '"e"' },
      ]);

      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: 'video-1' },
        {
          size_bytes: 1000,
          upload_id: null,
          processing_status: VideoProcessingStatus.PROCESSING,
        },
      );
      expect(producer.enqueue).toHaveBeenCalledWith('video-1');
    });
  });

  describe('abortUpload', () => {
    it('aborts the multipart upload and deletes the video row', async () => {
      videoRepository.findOneBy.mockResolvedValue(makeVideo());

      await service.abortUpload(USER_ID, SLUG);

      expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
        'videos/video-1/original',
        UPLOAD_ID,
      );
      expect(videoRepository.delete).toHaveBeenCalledWith({ id: 'video-1' });
    });
  });

  describe('read access', () => {
    it.each([
      ['uploading', VideoProcessingStatus.UPLOADING],
      ['processing', VideoProcessingStatus.PROCESSING],
      ['failed', VideoProcessingStatus.FAILED],
    ])(
      'getReadyVideo throws VIDEO_NOT_READY for a %s video',
      async (_label, status) => {
        videoRepository.findOneBy.mockResolvedValue(
          makeVideo({ processing_status: status }),
        );

        await expect(
          service.getReadyVideo(USER_ID, SLUG),
        ).rejects.toBeInstanceOf(VideoNotReadyException);
      },
    );

    it('getReadyVideo returns a ready video', async () => {
      videoRepository.findOneBy.mockResolvedValue(
        makeVideo({ processing_status: VideoProcessingStatus.READY }),
      );

      const video = await service.getReadyVideo(USER_ID, SLUG);

      expect(video.processing_status).toBe(VideoProcessingStatus.READY);
    });

    it('getOwnedVideo throws VIDEO_NOT_FOUND for another channel', async () => {
      channelsService.findByUserId.mockResolvedValue({ id: OTHER_CHANNEL_ID });
      videoRepository.findOneBy.mockResolvedValue(null);

      await expect(service.getOwnedVideo(USER_ID, SLUG)).rejects.toBeInstanceOf(
        VideoNotFoundException,
      );
    });

    it('openOriginal forwards the normalized range to storage and reports it', async () => {
      videoRepository.findOneBy.mockResolvedValue(
        makeVideo({
          processing_status: VideoProcessingStatus.READY,
          size_bytes: 2048,
        }),
      );
      storage.getObjectStream.mockResolvedValue({
        body: Readable.from([Buffer.alloc(1024)]),
        contentLength: 1024,
      });

      const original = await service.openOriginal(
        USER_ID,
        SLUG,
        'bytes=0-1023',
      );

      expect(storage.getObjectStream).toHaveBeenCalledWith(
        'videos/video-1/original',
        'bytes=0-1023',
      );
      expect(original.range).toEqual({ start: 0, end: 1023 });
      expect(original.totalBytes).toBe(2048);
    });

    it('openOriginal without a Range asks storage for the whole object', async () => {
      videoRepository.findOneBy.mockResolvedValue(
        makeVideo({
          processing_status: VideoProcessingStatus.READY,
          size_bytes: 2048,
        }),
      );
      storage.getObjectStream.mockResolvedValue({
        body: Readable.from([Buffer.alloc(2048)]),
        contentLength: 2048,
      });

      const original = await service.openOriginal(USER_ID, SLUG, undefined);

      expect(storage.getObjectStream).toHaveBeenCalledWith(
        'videos/video-1/original',
        undefined,
      );
      expect(original.range).toBeUndefined();
    });
  });
});
