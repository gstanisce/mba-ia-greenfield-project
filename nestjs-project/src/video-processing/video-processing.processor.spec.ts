import { getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import type { Job } from 'bullmq';
import { MediaProbeService } from '../media/media-probe.service';
import { StorageService } from '../storage/storage.service';
import { Video, VideoProcessingStatus } from '../videos/entities/video.entity';
import type { ProcessVideoJobData } from './video-processing.constants';
import { VideoProcessingProcessor } from './video-processing.processor';

const VIDEO_ID = 'video-1';
const STORAGE_KEY = 'videos/video-1/original';
const METADATA = {
  formatName: 'mov,mp4',
  bitRate: 100000,
  width: 320,
  height: 240,
  videoCodec: 'h264',
  audioCodec: null,
  frameRate: 25,
};

function makeVideo(status: VideoProcessingStatus): Video {
  return {
    id: VIDEO_ID,
    storage_key: STORAGE_KEY,
    processing_status: status,
  } as Video;
}

function makeJob(attemptsMade: number, attempts = 3): Job<ProcessVideoJobData> {
  return {
    data: { videoId: VIDEO_ID },
    attemptsMade,
    opts: { attempts },
  } as unknown as Job<ProcessVideoJobData>;
}

describe('VideoProcessingProcessor', () => {
  let moduleRef: TestingModule;
  let processor: VideoProcessingProcessor;
  let videoRepository: {
    findOneBy: jest.Mock;
    update: jest.Mock;
    save: jest.Mock;
  };
  let storage: { presignGetObject: jest.Mock; putObject: jest.Mock };
  let mediaProbe: { probe: jest.Mock; extractThumbnail: jest.Mock };

  beforeEach(async () => {
    videoRepository = {
      findOneBy: jest
        .fn()
        .mockResolvedValue(makeVideo(VideoProcessingStatus.UPLOADING)),
      update: jest.fn(),
      save: jest.fn(),
    };
    storage = {
      presignGetObject: jest.fn().mockResolvedValue('https://storage/original'),
      putObject: jest.fn(),
    };
    mediaProbe = {
      probe: jest
        .fn()
        .mockResolvedValue({ durationSeconds: 2, metadata: METADATA }),
      extractThumbnail: jest.fn().mockResolvedValue(Buffer.from([0xff, 0xd8])),
    };

    moduleRef = await Test.createTestingModule({
      providers: [
        VideoProcessingProcessor,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: StorageService, useValue: storage },
        { provide: MediaProbeService, useValue: mediaProbe },
      ],
    }).compile();
    processor = moduleRef.get(VideoProcessingProcessor);
  });

  afterEach(async () => {
    await moduleRef.close();
  });

  it('should skip a video that is already ready, without probing it again', async () => {
    videoRepository.findOneBy.mockResolvedValue(
      makeVideo(VideoProcessingStatus.READY),
    );

    await processor.process(makeJob(0));

    expect(mediaProbe.probe).not.toHaveBeenCalled();
    expect(videoRepository.update).not.toHaveBeenCalled();
  });

  it('should store the thumbnail and mark the video ready with its probed metadata', async () => {
    await processor.process(makeJob(0));

    expect(mediaProbe.extractThumbnail).toHaveBeenCalledWith(
      'https://storage/original',
      0.2,
    );
    expect(storage.putObject).toHaveBeenCalledWith(
      'videos/video-1/thumbnail.jpg',
      expect.any(Buffer),
      'image/jpeg',
    );
    expect(videoRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        processing_status: VideoProcessingStatus.READY,
        processing_error: null,
        duration_seconds: '2',
        metadata: METADATA,
        thumbnail_key: 'videos/video-1/thumbnail.jpg',
        processed_at: expect.any(Date) as Date,
      }),
    );
  });

  it('should mark the video failed and rethrow on the final attempt', async () => {
    mediaProbe.probe.mockRejectedValue(new Error('invalid data'));

    await expect(processor.process(makeJob(2))).rejects.toThrow('invalid data');
    expect(videoRepository.update).toHaveBeenCalledWith(
      { id: VIDEO_ID },
      {
        processing_status: VideoProcessingStatus.FAILED,
        processing_error: 'invalid data',
      },
    );
  });

  it('should rethrow without marking failed on a non-final attempt', async () => {
    mediaProbe.probe.mockRejectedValue(new Error('invalid data'));

    await expect(processor.process(makeJob(0))).rejects.toThrow('invalid data');
    expect(videoRepository.update).not.toHaveBeenCalled();
  });
});
