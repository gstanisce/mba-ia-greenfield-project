import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { createVideoFixtures } from '../test/video-fixtures';
import type { VideoFixtures } from '../test/video-fixtures';
import { MediaProbeService } from './media-probe.service';

// Runs the real ffprobe and ffmpeg binaries from the worker image.
describe('MediaProbeService (integration, FFmpeg)', () => {
  let moduleRef: TestingModule;
  let service: MediaProbeService;
  let fixtures: VideoFixtures;

  beforeAll(async () => {
    fixtures = await createVideoFixtures();
    moduleRef = await Test.createTestingModule({
      providers: [MediaProbeService],
    }).compile();
    service = moduleRef.get(MediaProbeService);
  });

  afterAll(async () => {
    await moduleRef.close();
    await fixtures.cleanup();
  });

  it('should report a 2-second duration and 320x240 dimensions for a valid video', async () => {
    const result = await service.probe(fixtures.validVideoPath);

    expect(result.durationSeconds).toBeCloseTo(2, 0);
    expect(result.metadata).toMatchObject({
      width: 320,
      height: 240,
      videoCodec: 'h264',
    });
  });

  it('should extract a thumbnail that starts with the JPEG magic bytes', async () => {
    const thumbnail = await service.extractThumbnail(
      fixtures.validVideoPath,
      0.2,
    );

    expect(thumbnail.subarray(0, 2).equals(Buffer.from([0xff, 0xd8]))).toBe(
      true,
    );
  });

  it('should reject a file that is not a video, with the ffprobe stderr in the error', async () => {
    await expect(service.probe(fixtures.notAVideoPath)).rejects.toThrow(
      /ffprobe exited with code/,
    );
  });
});
