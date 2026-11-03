import { ApiProperty } from '@nestjs/swagger';
import {
  VideoProcessingStatus,
  VideoPublicationStatus,
} from '../entities/video.entity';

export class VideoDetailsResponseDto {
  @ApiProperty({ example: 'Ab3dE5fG7hI' })
  slug: string;

  @ApiProperty({ example: 'clip.mp4' })
  title: string;

  @ApiProperty({ example: 'clip.mp4' })
  originalFileName: string;

  @ApiProperty({ example: 'video/mp4' })
  contentType: string;

  @ApiProperty({ example: 1048576 })
  sizeBytes: number;

  @ApiProperty({ enum: VideoProcessingStatus, example: 'ready' })
  processingStatus: VideoProcessingStatus;

  @ApiProperty({ enum: VideoPublicationStatus, example: 'draft' })
  publicationStatus: VideoPublicationStatus;

  @ApiProperty({ example: 2, nullable: true, type: Number })
  durationSeconds: number | null;

  @ApiProperty({
    nullable: true,
    type: Object,
    example: {
      formatName: 'mov,mp4',
      bitRate: 100000,
      width: 320,
      height: 240,
      videoCodec: 'h264',
      audioCodec: null,
      frameRate: 25,
    },
  })
  metadata: Record<string, unknown> | null;

  @ApiProperty({ example: true })
  hasThumbnail: boolean;

  @ApiProperty({ nullable: true, type: String, example: null })
  processingError: string | null;

  @ApiProperty({ example: '2026-11-03T13:00:00.000Z' })
  createdAt: string;

  @ApiProperty({
    nullable: true,
    type: String,
    example: '2026-11-03T13:01:00.000Z',
  })
  processedAt: string | null;
}
