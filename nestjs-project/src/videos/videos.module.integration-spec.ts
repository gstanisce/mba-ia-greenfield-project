import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import uploadConfig from '../config/upload.config';
import { Channel } from '../channels/entities/channel.entity';
import { createTestDataSource } from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { VideosController } from './videos.controller';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

// Opens Postgres and Redis connections, so it runs against the test services.
describe('VideosModule (integration)', () => {
  let moduleRef: TestingModule;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig, uploadConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        VideosModule,
      ],
    }).compile();
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  it('should compile with the controller and the service wired', () => {
    expect(moduleRef.get(VideosController)).toBeInstanceOf(VideosController);
    expect(moduleRef.get(VideosService)).toBeInstanceOf(VideosService);
  });
});
