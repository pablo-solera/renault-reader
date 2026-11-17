import type { UnitSummary } from "./request.js";

/** Share of finished units; stays below 100 until the request itself completes and never goes backwards when units are appended. */
export function requestProgress(units: UnitSummary[], previous = 0): number {
  if (!units.length) return previous;
  const done = units.filter(unit => unit.status === "completed").length;
  return Math.max(previous, Math.min(99, Math.floor((done / units.length) * 100)));
}

/** Index of the first unit that still has to run, or the unit count when every one is completed. */
export function resumableUnitIndex(units: UnitSummary[]): number {
  const index = units.findIndex(unit => unit.status !== "completed");
  return index < 0 ? units.length : index;
}
