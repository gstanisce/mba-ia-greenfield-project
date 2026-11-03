import { ApiProperty } from '@nestjs/swagger';
import {
  VideoProcessingStatus,
  VideoPublicationStatus,
} from '../entities/video.entity';

export class InitiateUploadResponseDto {
  @ApiProperty({ example: 'Ab3dE5fG7hI', minLength: 11, maxLength: 11 })
  slug: string;

  @ApiProperty({ enum: VideoProcessingStatus, example: 'uploading' })
  processingStatus: VideoProcessingStatus;

  @ApiProperty({ enum: VideoPublicationStatus, example: 'draft' })
  publicationStatus: VideoPublicationStatus;

  @ApiProperty({ example: 67108864, description: 'Part size in bytes' })
  partSizeBytes: number;

  @ApiProperty({ example: 1, description: 'ceil(sizeBytes / partSizeBytes)' })
  partCount: number;

  @ApiProperty({ example: 10737418240, description: 'Maximum upload size' })
  maxBytes: number;

  @ApiProperty({ example: 3600, description: 'Lifetime of presigned URLs' })
  urlTtlSeconds: number;
}

export class UploadPartUrlDto {
  @ApiProperty({ example: 1 })
  partNumber: number;

  @ApiProperty({
    example:
      'http://localhost:9000/streamtube/videos/.../original?X-Amz-Signature=...',
    description: 'Presigned URL; PUT the part bytes directly to it',
  })
  url: string;
}

export class SignUploadPartsResponseDto {
  @ApiProperty({ type: () => [UploadPartUrlDto] })
  parts: UploadPartUrlDto[];

  @ApiProperty({
    example: '2026-11-03T13:00:00.000Z',
    description: 'Instant after which the presigned URLs stop working',
  })
  expiresAt: string;
}

export class UploadedPartDto {
  @ApiProperty({ example: 1 })
  partNumber: number;

  @ApiProperty({ example: '"9bb58f26192e4ba00f01e2e7b136dbd4"' })
  etag: string;

  @ApiProperty({ example: 67108864 })
  sizeBytes: number;
}

export class ListUploadedPartsResponseDto {
  @ApiProperty({ type: () => [UploadedPartDto] })
  parts: UploadedPartDto[];
}

export class CompleteUploadResponseDto {
  @ApiProperty({ example: 'Ab3dE5fG7hI' })
  slug: string;

  @ApiProperty({ enum: VideoProcessingStatus, example: 'processing' })
  processingStatus: VideoProcessingStatus;
}
