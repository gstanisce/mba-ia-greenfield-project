import { Module } from '@nestjs/common';
import { S3Client } from '@aws-sdk/client-s3';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { S3_INTERNAL_CLIENT, S3_PUBLIC_CLIENT } from './storage.constants';
import { StorageService } from './storage.service';

const createS3Client = (
  endpoint: string,
  config: ConfigType<typeof storageConfig>,
): S3Client =>
  new S3Client({
    endpoint,
    region: config.region,
    forcePathStyle: true,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });

@Module({
  providers: [
    {
      provide: S3_INTERNAL_CLIENT,
      inject: [storageConfig.KEY],
      useFactory: (config: ConfigType<typeof storageConfig>): S3Client =>
        createS3Client(config.endpoint, config),
    },
    {
      provide: S3_PUBLIC_CLIENT,
      inject: [storageConfig.KEY],
      useFactory: (config: ConfigType<typeof storageConfig>): S3Client =>
        createS3Client(config.publicEndpoint, config),
    },
    StorageService,
  ],
  exports: [StorageService],
})
export class StorageModule {}
