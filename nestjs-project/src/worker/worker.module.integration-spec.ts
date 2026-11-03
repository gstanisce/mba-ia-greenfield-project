import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { VideoProcessingProcessor } from '../video-processing/video-processing.processor';
import { Video } from '../videos/entities/video.entity';
import { WorkerModule } from './worker.module';

// Connects to Postgres and Redis, so it runs against the test services.
// Imports only what the worker imports: importing AppModule here would register
// every entity in this test process and hide missing forFeature registrations.
describe('WorkerModule (integration)', () => {
  let moduleRef: TestingModule;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  it('should compile with the processor wired', () => {
    expect(moduleRef.get(VideoProcessingProcessor)).toBeInstanceOf(
      VideoProcessingProcessor,
    );
  });

  it('should initialize the database with the relation metadata Video needs', () => {
    const dataSource = moduleRef.get(DataSource);
    const videoMetadata = dataSource.getMetadata(Video);

    expect(dataSource.isInitialized).toBe(true);
    expect(videoMetadata.relations.map((r) => r.propertyName)).toContain(
      'channel',
    );
  });
});
