export type AccessDateParts = { day: number; month: number; year: number };

/** Access receives YYYYMMDD and legacy MODYYMM values. */
export function parseAccessDate(value: unknown): AccessDateParts | null {
  const raw = String(value ?? "").trim();
  if (/^\d{8}$/.test(raw)) {
    return { year: Number(raw.slice(0, 4)), month: Number(raw.slice(4, 6)), day: Number(raw.slice(6, 8)) };
  }
  if (/^MOD\d{4}$/i.test(raw)) {
    return { year: 2000 + Number(raw.slice(3, 5)), month: Number(raw.slice(5, 7)), day: 1 };
  }
  return null;
}

export function accessDateText(value: unknown): string {
  const date = parseAccessDate(value);
  if (!date) return "";
  return `${String(date.day).padStart(2, "0")}/${String(date.month).padStart(2, "0")}/${date.year}`;
}

export function accessDateValue(value: unknown): Date | null {
  const date = parseAccessDate(value);
  if (!date || date.month < 1 || date.month > 12 || date.day < 1 || date.day > 31) return null;
  return new Date(Date.UTC(date.year, date.month - 1, date.day));
}
