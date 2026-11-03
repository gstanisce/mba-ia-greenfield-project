import { Module } from '@nestjs/common';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import databaseConfig from '../config/database.config';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { buildTypeOrmOptions } from '../database/typeorm-options';
import { MediaProbeService } from '../media/media-probe.service';
import { StorageModule } from '../storage/storage.module';
import { VideoProcessingProcessor } from '../video-processing/video-processing.processor';
import { VideoProcessingQueueModule } from '../video-processing/video-processing-queue.module';
import { Channel } from '../channels/entities/channel.entity';
import { User } from '../users/entities/user.entity';
import { Video } from '../videos/entities/video.entity';

// The worker runs as its own process: it registers the processor, which the API never does.
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [databaseConfig, storageConfig, queueConfig],
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [databaseConfig.KEY],
      useFactory: (dbConfig: ConfigType<typeof databaseConfig>) =>
        buildTypeOrmOptions(dbConfig),
    }),
    // Video's relations point at Channel, and Channel at User: TypeORM needs all three
    // registered for the relation metadata, even though the worker only uses Video.
    TypeOrmModule.forFeature([Video, Channel, User]),
    StorageModule,
    VideoProcessingQueueModule,
  ],
  providers: [MediaProbeService, VideoProcessingProcessor],
})
export class WorkerModule {}
