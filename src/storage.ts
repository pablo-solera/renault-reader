import { AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand, GetObjectCommand, S3Client, HeadBucketCommand, CreateBucketCommand, S3ServiceException, UploadPartCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "./config.js";

const client = new S3Client({
  region: config.s3Region,
  endpoint: config.s3Endpoint,
  forcePathStyle: config.s3ForcePathStyle,
  credentials: config.s3AccessKey ? { accessKeyId: config.s3AccessKey, secretAccessKey: config.s3SecretKey } : undefined,
});

export class S3UploadError extends Error {
  constructor(
    message: string,
    readonly details: {
      operation: string;
      bucket: string;
      key: string;
      status?: number;
      code?: string;
      requestId?: string;
    },
  ) {
    super(message);
    this.name = "S3UploadError";
  }
}

export function normalizeUploadContentType(contentType: string): string {
  return contentType.includes("/") ? contentType : "application/zip";
}

function s3Failure(error: unknown, operation: string, key: string): S3UploadError {
  const source = error as any;
  const details = {
    operation,
    bucket: config.s3Bucket,
    key,
    status: source?.$metadata?.httpStatusCode,
    code: source?.Code ?? source?.name,
    requestId: source?.$metadata?.requestId,
  };
  console.error(JSON.stringify({ event: "s3_error", ...details }));
  return new S3UploadError(`${operation} failed: ${details.code ?? "S3 error"}`, details);
}

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
  const normalizedContentType = normalizeUploadContentType(contentType);
  let uploadId: string | undefined;
  const parts: Array<{ ETag?: string; PartNumber: number }> = [];
  let operation = "CreateMultipartUpload";
  try {
    const multipart = await client.send(new CreateMultipartUploadCommand({
      Bucket: config.s3Bucket,
      Key: key,
      ContentType: normalizedContentType,
    }));
    uploadId = multipart.UploadId;
    if (!uploadId) throw new Error("S3 did not return a multipart upload ID");

    const reader = body.getReader();
    const partSize = 5 * 1024 * 1024;
    let buffers: Uint8Array[] = [];
    let bufferedLength = 0;
    let partNumber = 1;

    const uploadPart = async (bytes: Uint8Array) => {
      operation = `UploadPart#${partNumber}`;
      const result = await client.send(new UploadPartCommand({
        Bucket: config.s3Bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
        Body: bytes,
      }));
      if (!result.ETag) throw new Error(`S3 did not return an ETag for part ${partNumber}`);
      parts.push({ ETag: result.ETag, PartNumber: partNumber });
      partNumber += 1;
    };

    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (!next.value?.length) continue;
      buffers.push(next.value);
      bufferedLength += next.value.length;
      if (bufferedLength >= partSize) {
        await uploadPart(Buffer.concat(buffers, bufferedLength));
        buffers = [];
        bufferedLength = 0;
      }
    }
    if (bufferedLength > 0) await uploadPart(Buffer.concat(buffers, bufferedLength));
    if (!parts.length) throw new Error("S3 upload body was empty");
    operation = "CompleteMultipartUpload";
    await client.send(new CompleteMultipartUploadCommand({
      Bucket: config.s3Bucket,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: { Parts: parts },
    }));
  } catch (error) {
    if (uploadId) {
      await client.send(new AbortMultipartUploadCommand({ Bucket: config.s3Bucket, Key: key, UploadId: uploadId })).catch((abortError) => {
        const source = abortError as any;
        console.error(JSON.stringify({
          event: "s3_abort_error",
          operation: "AbortMultipartUpload",
          bucket: config.s3Bucket,
          key,
          status: source?.$metadata?.httpStatusCode,
          code: source?.Code ?? source?.name,
          requestId: source?.$metadata?.requestId,
        }));
      });
    }
    if (error instanceof S3UploadError) throw error;
    throw s3Failure(error, operation, key);
  }
}

export async function signedDownload(key: string) {
  return getSignedUrl(client, new GetObjectCommand({ Bucket: config.s3Bucket, Key: key }), { expiresIn: 900 });
}
