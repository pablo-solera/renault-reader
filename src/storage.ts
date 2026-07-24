import { GetObjectCommand, S3Client, HeadBucketCommand, CreateBucketCommand, S3ServiceException } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Upload } from "@aws-sdk/lib-storage";
import { Readable } from "node:stream";
import { config } from "./config.js";

const client = new S3Client({
  region: config.s3Region,
  endpoint: config.s3Endpoint,
  forcePathStyle: config.s3ForcePathStyle,
  credentials: config.s3AccessKey ? { accessKeyId: config.s3AccessKey, secretAccessKey: config.s3SecretKey } : undefined,
});

export async function ensureBucket() {
  if (!config.s3Endpoint || !config.s3AccessKey || !config.s3SecretKey || !config.s3Bucket) {
    throw new Error("S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_ACCESS_KEY and S3_BUCKET are required");
  }
  try {
    await client.send(new HeadBucketCommand({ Bucket: config.s3Bucket }));
  } catch (error) {
    const status = error instanceof S3ServiceException ? error.$metadata.httpStatusCode : undefined;
    if (config.s3AutoCreateBucket && status === 404) {
      await client.send(new CreateBucketCommand({ Bucket: config.s3Bucket }));
      return;
    }
    throw new Error(status === 403 ? "S3 credentials cannot access the configured bucket" : `Cannot access S3 bucket (HTTP ${status ?? "unknown"})`);
  }
}

export async function uploadObject(key: string, body: ReadableStream<Uint8Array>, contentType = "application/zip") {
  const upload = new Upload({
    client,
    params: {
      Bucket: config.s3Bucket,
      Key: key,
      Body: Readable.fromWeb(body as any),
      ContentType: contentType,
    },
    partSize: 5 * 1024 * 1024,
    queueSize: 4,
    leavePartsOnError: false,
  });
  await upload.done();
}

export async function signedDownload(key: string) {
  return getSignedUrl(client, new GetObjectCommand({ Bucket: config.s3Bucket, Key: key }), { expiresIn: 900 });
}
