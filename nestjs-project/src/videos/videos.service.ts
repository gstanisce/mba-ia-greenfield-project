import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { ConfigType } from '@nestjs/config';
import { Repository } from 'typeorm';
import uploadConfig from '../config/upload.config';
import { isPgUniqueViolationOnColumn } from '../common/database/pg-unique-violation.util';
import {
  ChannelNotFoundException,
  InvalidPartNumbersException,
  UploadNotInProgressException,
  UploadSizeMismatchException,
  VideoNotFoundException,
  VideoNotReadyException,
} from '../common/exceptions/domain.exception';
import { ChannelsService } from '../channels/channels.service';
import { StorageService } from '../storage/storage.service';
import type { UploadedPart, StoredPart } from '../storage/storage.service';
import { VideoProcessingProducer } from '../video-processing/video-processing.producer';
import { generateVideoSlug } from './slug.util';
import { parseRange } from './range.util';
import type { ByteRange } from './range.util';
import {
  Video,
  VideoProcessingStatus,
  VideoPublicationStatus,
} from './entities/video.entity';
import {
  MAX_SLUG_ATTEMPTS,
  SLUG_COLUMN,
  UPLOAD_SIZE_MISMATCH_REASON,
  originalStorageKey,
} from './videos.constants';

export interface InitiateUploadInput {
  fileName: string;
  contentType: string;
  sizeBytes: number;
}

export interface InitiateUploadResult {
  slug: string;
  processingStatus: VideoProcessingStatus;
  publicationStatus: VideoPublicationStatus;
  partSizeBytes: number;
  partCount: number;
  maxBytes: number;
  urlTtlSeconds: number;
}

export interface SignedUploadParts {
  parts: { partNumber: number; url: string }[];
  expiresAt: string;
}

export interface UploadedPartSummary {
  partNumber: number;
  etag: string;
  sizeBytes: number;
}

export interface OriginalStream {
  body: Readable;
  contentLength: number;
  contentType: string;
  fileName: string;
  totalBytes: number;
  range: ByteRange | undefined;
}

export interface ThumbnailStream {
  body: Readable;
  contentLength: number;
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storage: StorageService,
    private readonly producer: VideoProcessingProducer,
    @Inject(uploadConfig.KEY)
    private readonly upload: ConfigType<typeof uploadConfig>,
  ) {}

  async initiateUpload(
    userId: string,
    input: InitiateUploadInput,
  ): Promise<InitiateUploadResult> {
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new ChannelNotFoundException();
    }

    const id = randomUUID();
    const storageKey = originalStorageKey(id);
    const uploadId = await this.storage.createMultipartUpload(
      storageKey,
      input.contentType,
    );

    const video = await this.saveDraftOrAbort(
      {
        id,
        channel_id: channel.id,
        title: input.fileName,
        original_file_name: input.fileName,
        content_type: input.contentType,
        size_bytes: input.sizeBytes,
        storage_key: storageKey,
        upload_id: uploadId,
        processing_status: VideoProcessingStatus.UPLOADING,
        publication_status: VideoPublicationStatus.DRAFT,
      },
      storageKey,
      uploadId,
    );

    return {
      slug: video.slug,
      processingStatus: video.processing_status,
      publicationStatus: video.publication_status,
      partSizeBytes: this.upload.partSizeBytes,
      partCount: this.partCount(input.sizeBytes),
      maxBytes: this.upload.maxBytes,
      urlTtlSeconds: this.upload.urlTtlSeconds,
    };
  }

  async signUploadParts(
    userId: string,
    slug: string,
    partNumbers: number[],
  ): Promise<SignedUploadParts> {
    const video = await this.findOwnedUploadingVideo(userId, slug);
    this.assertPartNumbersInRange(
      partNumbers,
      this.partCount(video.size_bytes),
    );

    const urls = await this.storage.presignUploadParts(
      video.storage_key,
      this.requireUploadId(video),
      partNumbers,
      this.upload.urlTtlSeconds,
    );
    return {
      parts: partNumbers.map((partNumber) => ({
        partNumber,
        url: urls[partNumber],
      })),
      expiresAt: new Date(
        Date.now() + this.upload.urlTtlSeconds * 1000,
      ).toISOString(),
    };
  }

  async listUploadedParts(
    userId: string,
    slug: string,
  ): Promise<UploadedPartSummary[]> {
    const video = await this.findOwnedUploadingVideo(userId, slug);
    const parts: StoredPart[] = await this.storage.listParts(
      video.storage_key,
      this.requireUploadId(video),
    );

    return parts.map((part) => ({
      partNumber: part.partNumber,
      etag: part.etag,
      sizeBytes: part.size,
    }));
  }

  async completeUpload(
    userId: string,
    slug: string,
    parts: UploadedPart[],
  ): Promise<void> {
    const video = await this.findOwnedUploadingVideo(userId, slug);
    await this.storage.completeMultipartUpload(
      video.storage_key,
      this.requireUploadId(video),
      parts,
    );

    const head = await this.storage.headObject(video.storage_key);
    if (head.contentLength > video.size_bytes) {
      await this.storage.deleteObject(video.storage_key);
      await this.videoRepository.update(
        { id: video.id },
        {
          processing_status: VideoProcessingStatus.FAILED,
          processing_error: UPLOAD_SIZE_MISMATCH_REASON,
          upload_id: null,
        },
      );
      throw new UploadSizeMismatchException();
    }

    await this.videoRepository.update(
      { id: video.id },
      {
        size_bytes: head.contentLength,
        upload_id: null,
        processing_status: VideoProcessingStatus.PROCESSING,
      },
    );
    await this.producer.enqueue(video.id);
  }

  async abortUpload(userId: string, slug: string): Promise<void> {
    const video = await this.findOwnedUploadingVideo(userId, slug);
    await this.storage.abortMultipartUpload(
      video.storage_key,
      this.requireUploadId(video),
    );
    await this.videoRepository.delete({ id: video.id });
  }

  async getOwnedVideo(userId: string, slug: string): Promise<Video> {
    return this.findOwnedVideo(userId, slug);
  }

  async getReadyVideo(userId: string, slug: string): Promise<Video> {
    const video = await this.findOwnedVideo(userId, slug);
    if (video.processing_status !== VideoProcessingStatus.READY) {
      throw new VideoNotReadyException();
    }
    return video;
  }

  async openOriginal(
    userId: string,
    slug: string,
    rangeHeader: string | undefined,
  ): Promise<OriginalStream> {
    const video = await this.getReadyVideo(userId, slug);
    const range = parseRange(rangeHeader, video.size_bytes);
    const object = await this.storage.getObjectStream(
      video.storage_key,
      range ? `bytes=${range.start}-${range.end}` : undefined,
    );
    return {
      body: object.body,
      contentLength: object.contentLength,
      contentType: video.content_type,
      fileName: video.original_file_name,
      totalBytes: video.size_bytes,
      range,
    };
  }

  async openThumbnail(userId: string, slug: string): Promise<ThumbnailStream> {
    const video = await this.getReadyVideo(userId, slug);
    if (video.thumbnail_key === null) {
      throw new VideoNotReadyException();
    }
    const object = await this.storage.getObjectStream(video.thumbnail_key);
    return { body: object.body, contentLength: object.contentLength };
  }

  private partCount(sizeBytes: number): number {
    return Math.ceil(sizeBytes / this.upload.partSizeBytes);
  }

  private assertPartNumbersInRange(
    partNumbers: number[],
    partCount: number,
  ): void {
    const outOfRange = partNumbers.some(
      (partNumber) => partNumber < 1 || partNumber > partCount,
    );
    if (outOfRange) {
      throw new InvalidPartNumbersException();
    }
  }

  private async findOwnedVideo(userId: string, slug: string): Promise<Video> {
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new VideoNotFoundException();
    }

    const video = await this.videoRepository.findOneBy({
      slug,
      channel_id: channel.id,
    });
    if (!video) {
      throw new VideoNotFoundException();
    }
    return video;
  }

  private async findOwnedUploadingVideo(
    userId: string,
    slug: string,
  ): Promise<Video> {
    const video = await this.findOwnedVideo(userId, slug);
    if (video.processing_status !== VideoProcessingStatus.UPLOADING) {
      throw new UploadNotInProgressException();
    }
    return video;
  }

  private requireUploadId(video: Video): string {
    if (video.upload_id === null) {
      throw new UploadNotInProgressException();
    }
    return video.upload_id;
  }

  // The multipart upload exists in storage before the row does; if the row
  // cannot be saved, the multipart is aborted so no orphan upload is left behind.
  private async saveDraftOrAbort(
    fields: Partial<Video>,
    storageKey: string,
    uploadId: string,
  ): Promise<Video> {
    try {
      return await this.saveWithUniqueSlug(fields);
    } catch (error) {
      await this.storage.abortMultipartUpload(storageKey, uploadId);
      throw error;
    }
  }

  private async saveWithUniqueSlug(fields: Partial<Video>): Promise<Video> {
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
      try {
        return await this.videoRepository.save(
          this.videoRepository.create({ ...fields, slug: generateVideoSlug() }),
        );
      } catch (error) {
        if (!isPgUniqueViolationOnColumn(error, SLUG_COLUMN)) {
          throw error;
        }
        lastError = error;
      }
    }
    throw lastError;
  }
}
