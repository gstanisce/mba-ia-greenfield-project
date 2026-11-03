import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { S3Client } from '@aws-sdk/client-s3';
import storageConfig from '../config/storage.config';
import { S3_INTERNAL_CLIENT, S3_PUBLIC_CLIENT } from './storage.constants';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

describe('StorageModule', () => {
  it('should compile with two S3 clients and export StorageService', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();

    expect(moduleRef.get(S3_INTERNAL_CLIENT)).toBeInstanceOf(S3Client);
    expect(moduleRef.get(S3_PUBLIC_CLIENT)).toBeInstanceOf(S3Client);
    expect(moduleRef.get(StorageService)).toBeInstanceOf(StorageService);
  });
});
