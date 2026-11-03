import type { Video } from './entities/video.entity';
import type { VideoDetailsResponseDto } from './dto/video-details-response.dto';

export function toVideoDetails(video: Video): VideoDetailsResponseDto {
  return {
    slug: video.slug,
    title: video.title,
    originalFileName: video.original_file_name,
    contentType: video.content_type,
    sizeBytes: video.size_bytes,
    processingStatus: video.processing_status,
    publicationStatus: video.publication_status,
    durationSeconds:
      video.duration_seconds === null ? null : Number(video.duration_seconds),
    metadata: video.metadata,
    hasThumbnail: video.thumbnail_key !== null,
    processingError: video.processing_error,
    createdAt: video.created_at.toISOString(),
    processedAt: video.processed_at?.toISOString() ?? null,
  };
}
