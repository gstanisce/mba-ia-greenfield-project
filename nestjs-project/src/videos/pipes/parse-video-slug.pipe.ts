import { Injectable } from '@nestjs/common';
import type { PipeTransform } from '@nestjs/common';
import { VideoNotFoundException } from '../../common/exceptions/domain.exception';
import { VIDEO_SLUG_PATTERN } from '../videos.constants';

// A malformed slug can never match a video, so it answers like a missing one.
@Injectable()
export class ParseVideoSlugPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!VIDEO_SLUG_PATTERN.test(value)) {
      throw new VideoNotFoundException();
    }
    return value;
  }
}
