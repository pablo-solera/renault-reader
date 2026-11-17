export interface ArtifactStore {
  objectKey(...parts: string[]): string;
  putObject(key: string, body: string | Uint8Array, contentType: string): Promise<void>;
  putJson(key: string, value: unknown): Promise<void>;
  getJsonIfExists<T>(key: string): Promise<T | undefined>;
  getBytes(key: string): Promise<Uint8Array>;
}
