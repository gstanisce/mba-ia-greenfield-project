import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import type { ConfigType } from '@nestjs/config';
import queueConfig from '../config/queue.config';
import { VIDEO_PROCESSING_QUEUE } from './video-processing.constants';

@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [queueConfig.KEY],
      useFactory: (config: ConfigType<typeof queueConfig>) => ({
        connection: { host: config.host, port: config.port },
      }),
    }),
    BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
  ],
  exports: [BullModule],
})
export class VideoProcessingQueueModule {}
