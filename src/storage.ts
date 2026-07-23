import { GetObjectCommand, PutObjectCommand, S3Client, HeadBucketCommand, CreateBucketCommand } from "@aws-sdk/client-s3";
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
  try { await client.send(new HeadBucketCommand({ Bucket: config.s3Bucket })); }
  catch { await client.send(new CreateBucketCommand({ Bucket: config.s3Bucket })); }
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
