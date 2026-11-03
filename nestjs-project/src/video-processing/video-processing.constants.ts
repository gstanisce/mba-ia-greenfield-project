import type { JobsOptions } from 'bullmq';

export const VIDEO_PROCESSING_QUEUE = 'video-processing' as const;
export const PROCESS_VIDEO_JOB = 'process-video' as const;

export type ProcessVideoJobData = { videoId: string };

export const PROCESS_VIDEO_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: true,
  removeOnFail: false,
} as const satisfies JobsOptions;

export const PROCESSING_URL_TTL_SECONDS = 900 as const;
export const THUMBNAIL_POSITION_RATIO = 0.1 as const;
export const THUMBNAIL_CONTENT_TYPE = 'image/jpeg' as const;
