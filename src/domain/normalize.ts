export function normalizeAxCode(value: string): string {
  return value.replaceAll(" ", "");
}

export function normalizeEdition(value: string): string {
  const edition = value.toUpperCase().replaceAll(" ", "");
  if (!/^\d{2}\/\d$/.test(edition)) throw new Error("edition must use the NN/N format, for example 01/0");
  return edition;
}

export function normalizeDescription(value: string): string {
  return value.replaceAll(" ", "").replaceAll("&", "_").replaceAll("/", "-").replaceAll("%", "_");
}

export function normalizeManufacturer(value: string): string {
  return value.replaceAll("BRAND", "").replaceAll("TRUCKS", "").trim();
}

/** Renault answers `zip` instead of a MIME type for its archives. */
export function normalizeContentType(contentType: string | null | undefined): string {
  return contentType && contentType.includes("/") ? contentType : "application/zip";
}

export const yyyymmdd = (date: Date) => date.toISOString().slice(0, 10).replaceAll("-", "");
