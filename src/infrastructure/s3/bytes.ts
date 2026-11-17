/** Reads a whole S3 object into memory (the REF04 and REF05 archives are small). */
export async function readAllBytes(stream: NodeJS.ReadableStream): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk as Uint8Array);
  return new Uint8Array(Buffer.concat(chunks));
}
