export function normalizeAxCode(value: string): string {
  return value.replaceAll(" ", "");
}

export function normalizeEdition(value: string): string {
  const edition = value.toUpperCase().replaceAll(" ", "");
  if (!/^\d{2}\/\d$/.test(edition)) throw new Error("La edición de IMC tiene que seguir el formato 01/0");
  return edition;
}

export function normalizeDescription(value: string): string {
  return value.replaceAll(" ", "").replaceAll("&", "_").replaceAll("/", "-").replaceAll("%", "_");
}

export function normalizeManufacturer(value: string): string {
  return value.replaceAll("BRAND", "").replaceAll("TRUCKS", "").trim();
}
