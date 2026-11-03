import { DataSource, Repository } from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { User } from '../../users/entities/user.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import {
  Video,
  VideoProcessingStatus,
  VideoPublicationStatus,
} from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
const TEN_GIB_BYTES = 10737418240;
const UNIQUE_VIOLATION = '23505';

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    ++counter;
    const user = await userRepository.save(
      userRepository.create({
        email: `video_user_${counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `Channel ${counter}`,
        nickname: `video_channel_${counter}`,
        user_id: user.id,
      }),
    );
  }

  function buildVideo(
    channelId: string,
    overrides: Partial<Video> = {},
  ): Partial<Video> {
    const slug = `vid${String(counter).padStart(8, '0')}`;
    return {
      slug,
      channel_id: channelId,
      title: 'my-video.mp4',
      original_file_name: 'my-video.mp4',
      content_type: 'video/mp4',
      size_bytes: 1024,
      storage_key: `videos/${slug}/original`,
      ...overrides,
    };
  }

  it('should default processing_status to uploading and publication_status to draft', async () => {
    const channel = await createChannel();
    const saved = await videoRepository.save(
      videoRepository.create(buildVideo(channel.id)),
    );

    const video = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(video.processing_status).toBe(VideoProcessingStatus.UPLOADING);
    expect(video.publication_status).toBe(VideoPublicationStatus.DRAFT);
  });

  it('should reject a duplicate slug with a unique violation', async () => {
    const channel = await createChannel();
    const base = buildVideo(channel.id, { slug: 'duplicate01' });
    await videoRepository.save(videoRepository.create(base));

    await expect(
      videoRepository.save(
        videoRepository.create({
          ...base,
          storage_key: 'videos/other/original',
        }),
      ),
    ).rejects.toMatchObject({ driverError: { code: UNIQUE_VIOLATION } });
  });

  it('should delete the channel videos when the channel is deleted', async () => {
    const channel = await createChannel();
    const saved = await videoRepository.save(
      videoRepository.create(buildVideo(channel.id)),
    );

    await channelRepository.delete({ id: channel.id });

    expect(await videoRepository.findOneBy({ id: saved.id })).toBeNull();
  });

  it('should round-trip size_bytes above 2^31 as a number', async () => {
    const channel = await createChannel();
    const saved = await videoRepository.save(
      videoRepository.create(
        buildVideo(channel.id, { size_bytes: TEN_GIB_BYTES }),
      ),
    );

    const video = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(video.size_bytes).toBe(TEN_GIB_BYTES);
    expect(typeof video.size_bytes).toBe('number');
  });
});
