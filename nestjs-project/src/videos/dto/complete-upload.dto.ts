import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class CompletedPartDto {
  /** Part number as returned by the sign step, from 1 to 10000. */
  @IsInt()
  @Min(1)
  @Max(10000)
  partNumber: number;

  /** ETag header returned by the storage for that part's PUT. */
  @IsString()
  @IsNotEmpty()
  etag: string;
}

export class CompleteUploadDto {
  /** Uploaded parts, one entry per partNumber, from 1 to 10000 items. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10000)
  @ArrayUnique((part: CompletedPartDto) => part.partNumber)
  @ValidateNested({ each: true })
  @Type(() => CompletedPartDto)
  parts: CompletedPartDto[];
}
