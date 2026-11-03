import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsInt, IsString, Length, Max, Min } from 'class-validator';
import { DEFAULT_UPLOAD_MAX_BYTES } from '../../config/upload.config';
import {
  VIDEO_CONTENT_TYPES,
  type VideoContentType,
} from '../videos.constants';

// Read when this module loads: the container gets UPLOAD_MAX_BYTES through env_file.
const MAX_UPLOAD_BYTES = Number(
  process.env.UPLOAD_MAX_BYTES ?? DEFAULT_UPLOAD_MAX_BYTES,
);

export class InitiateUploadDto {
  /** Original file name; becomes the draft title. */
  @IsString()
  @Length(1, 255)
  fileName: string;

  // Explicit enum: the Swagger plugin cannot infer an enum from @IsIn.
  @ApiProperty({ enum: VIDEO_CONTENT_TYPES, example: 'video/mp4' })
  @IsIn(VIDEO_CONTENT_TYPES)
  contentType: VideoContentType;

  /** File size in bytes, from 1 up to UPLOAD_MAX_BYTES. */
  @IsInt()
  @Min(1)
  @Max(MAX_UPLOAD_BYTES)
  sizeBytes: number;
}
