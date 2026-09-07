export type CriteriaLabel = { HTC?: unknown; htc?: unknown; objectOriginCode?: unknown; active?: unknown };

export function buildCriteriaIndex(records: CriteriaLabel[]): Map<string, number> {
  const index = new Map<string, number>();
  for (const record of records) {
    const htc = String(record.HTC ?? record.htc ?? "").trim();
    const code = Number(record.objectOriginCode);
    const active = record.active;
    if (htc && Number.isFinite(code) && active !== false && active !== 0 && active !== "0") index.set(htc, code);
  }
  return index;
}

export function buildCriteriaCodeIndex(records: Record<string, unknown>[]): Map<string, number> {
  const index = new Map<string, number>();
  for (const record of records) {
    const htc = String(record.id ?? record.HTC ?? record.htc ?? "").trim();
    const code = Number(record.objectOriginCode);
    if (htc && Number.isFinite(code)) index.set(htc, code);
  }
  return index;
}

export function criteriaCode(token: string, index: Map<string, number>): number | undefined {
  const normalized = token.trim();
  if (/^BRA\d\d$/i.test(normalized)) return 336;
  return index.get(normalized);
}
