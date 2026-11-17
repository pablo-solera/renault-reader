import type { Json, RenaultQuery } from "../../domain/renault-query.js";

/** The ASMDOR calls the reader makes, already authenticated as the configured account. */
export interface RenaultApi {
  applicability(): Promise<Json>;
  profileData(commercialName: string): Promise<Json>;
  queries(profileValue: string, role: string): Promise<Json>;
  nonConfidentialFamilies(familyType: string, profile: string, brand: unknown): Promise<Json>;
  status(query: RenaultQuery, payload: Json, fileName: string): Promise<Json>;
  launch(query: RenaultQuery, payload: Json): Promise<void>;
  history(): Promise<Json>;
  downloadUrl(filePath: string, fileName: string, queryCode: string): Promise<Json>;
  download(url: string): Promise<{ bytes: Uint8Array; contentType: string | null }>;
}
