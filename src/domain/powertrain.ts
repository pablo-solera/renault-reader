
const value = (record: any, ...keys: string[]) => {
  for (const key of keys) {
    if (record?.[key] != null) return String(record[key]).trim();
  }
  return "";
};

export function selectPowertrain(records: unknown[], models: unknown[]): unknown[] {
  const selectedModels = models as any[];
  if (!selectedModels.length) return [];
  return (records as any[]).filter((record) => selectedModels.some((model) => {
    const family = value(record, "familyVehicle", "family");
    const body = value(record, "bodyType");
    const engine = value(record, "engineType");
    const modelFamily = value(model, "familyVehicle", "family");
    const modelBody = value(model, "bodyType");
    const modelEngine = value(model, "engineType");
    if (!modelFamily || family !== modelFamily || (modelBody && body !== modelBody)) return false;
    if (!modelEngine) return true;
    return modelEngine.split(",").map((item) => item.trim()).filter(Boolean).includes(engine);
  }));
}

export function deriveFamilies(records: unknown[]): string[] {
  const families = new Set<string>();
  for (const key of ["familyVehicle", "familyEngine", "familyGearbox", "familyBattery"]) {
    for (const record of records as any[]) {
      const family = value(record, key);
      if (family) families.add(family);
    }
  }
  return [...families];
}
