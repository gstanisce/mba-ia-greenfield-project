import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsInt,
  Min,
} from 'class-validator';

export class SignUploadPartsDto {
  // partNumber <= partCount is checked in the service, since it depends on the stored video.
  /** Part numbers to sign, unique, from 1 to partCount. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  partNumbers: number[];
}
