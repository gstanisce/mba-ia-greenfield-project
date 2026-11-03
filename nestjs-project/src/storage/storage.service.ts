import { Inject, Injectable } from '@nestjs/common';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { ConfigType } from '@nestjs/config';
import type { Readable } from 'node:stream';
import storageConfig from '../config/storage.config';
import { InvalidUploadPartsException } from '../common/exceptions/domain.exception';
import { S3_INTERNAL_CLIENT, S3_PUBLIC_CLIENT } from './storage.constants';

const INVALID_PART_ERRORS = ['InvalidPart', 'InvalidPartOrder', 'NoSuchUpload'];

export interface UploadedPart {
  partNumber: number;
  etag: string;
}

export interface StoredPart {
  partNumber: number;
  etag: string;
  size: number;
}

export interface ObjectHead {
  contentLength: number;
  contentType?: string;
}

export interface ObjectStream {
  body: Readable;
  contentLength: number;
  contentRange?: string;
  contentType?: string;
}

@Injectable()
export class StorageService {
  constructor(
    @Inject(S3_INTERNAL_CLIENT)
    private readonly internalClient: S3Client,
    @Inject(S3_PUBLIC_CLIENT)
    private readonly publicClient: S3Client,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {}

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    const res = await this.internalClient.send(
      new CreateMultipartUploadCommand({
        Bucket: this.config.bucket,
        Key: key,
        ContentType: contentType,
      }),
    );
    if (!res.UploadId) {
      throw new Error(`CreateMultipartUpload returned no UploadId for ${key}`);
    }
    return res.UploadId;
  }

  async listParts(key: string, uploadId: string): Promise<StoredPart[]> {
    const res = await this.internalClient.send(
      new ListPartsCommand({
        Bucket: this.config.bucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
    return (res.Parts ?? []).map((part) => ({
      partNumber: part.PartNumber ?? 0,
      etag: part.ETag ?? '',
      size: part.Size ?? 0,
    }));
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: UploadedPart[],
  ): Promise<void> {
    try {
      await this.internalClient.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.config.bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: parts.map((part) => ({
              PartNumber: part.partNumber,
              ETag: part.etag,
            })),
          },
        }),
      );
    } catch (error) {
      if (error instanceof Error && INVALID_PART_ERRORS.includes(error.name)) {
        throw new InvalidUploadPartsException();
      }
      throw error;
    }
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.internalClient.send(
      new AbortMultipartUploadCommand({
        Bucket: this.config.bucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
  }

  async presignUploadParts(
    key: string,
    uploadId: string,
    partNumbers: number[],
    expiresIn: number,
  ): Promise<Record<number, string>> {
    const entries = await Promise.all(
      partNumbers.map(
        async (partNumber) =>
          [
            partNumber,
            await getSignedUrl(
              this.publicClient,
              new UploadPartCommand({
                Bucket: this.config.bucket,
                Key: key,
                UploadId: uploadId,
                PartNumber: partNumber,
              }),
              { expiresIn },
            ),
          ] as const,
      ),
    );
    return Object.fromEntries(entries);
  }

  async presignGetObject(key: string, expiresIn: number): Promise<string> {
    return getSignedUrl(
      this.internalClient,
      new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
      { expiresIn },
    );
  }

  async headObject(key: string): Promise<ObjectHead> {
    const res = await this.internalClient.send(
      new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }),
    );
    return {
      contentLength: res.ContentLength ?? 0,
      contentType: res.ContentType,
    };
  }

  async getObjectStream(key: string, range?: string): Promise<ObjectStream> {
    const res = await this.internalClient.send(
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Range: range,
      }),
    );
    if (!res.Body) {
      throw new Error(`GetObject returned no body for ${key}`);
    }
    return {
      body: res.Body as Readable,
      contentLength: res.ContentLength ?? 0,
      contentRange: res.ContentRange,
      contentType: res.ContentType,
    };
  }

  async putObject(
    key: string,
    body: Buffer | Readable,
    contentType: string,
  ): Promise<void> {
    await this.internalClient.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async deleteObject(key: string): Promise<void> {
    await this.internalClient.send(
      new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }),
    );
  }
}
