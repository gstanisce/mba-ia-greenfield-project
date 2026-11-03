import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';

const testS3Client = new S3Client({
  endpoint: process.env.S3_ENDPOINT ?? 'http://rustfs:9000',
  region: process.env.S3_REGION ?? 'us-east-1',
  forcePathStyle: true,
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY ?? '',
    secretAccessKey: process.env.S3_SECRET_KEY ?? '',
  },
});

export async function ensureBucket(bucket: string): Promise<void> {
  try {
    await testS3Client.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await testS3Client.send(new CreateBucketCommand({ Bucket: bucket }));
  }
}

export async function clearPrefix(
  bucket: string,
  prefix: string,
): Promise<void> {
  let continuationToken: string | undefined;
  do {
    const list = await testS3Client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );
    const objects = (list.Contents ?? []).flatMap((object) =>
      object.Key ? [{ Key: object.Key }] : [],
    );
    if (objects.length > 0) {
      await testS3Client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: objects },
        }),
      );
    }
    continuationToken = list.NextContinuationToken;
  } while (continuationToken);
}
