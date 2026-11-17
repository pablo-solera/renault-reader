import type { ErrorCode, RequestStatus } from "@pablosla/core-reader/contract/v1";
import type { ExportSwitches } from "./exports.js";

export type Resource = "labours" | "parts";

type CommonInput = {
  manufacturer: string;
  /** YYYYMMDD of the day the request was created; it names the S3 folder even when the request is resumed later. */
  date: string;
  axCode?: string;
  edition?: string;
  language?: string;
};

export type LabourInput = CommonInput & {
  resource: "labours";
  family: string;
  format: string;
  range: string;
  publishedAfter?: string;
};

export type PartsInput = CommonInput & {
  resource: "parts";
  axCode: string;
  edition: string;
  description: string;
  /** Model family: it names the S3 folder and is the family sent for the base exports. */
  family: string;
  modelIds: string[];
  range: string;
  format?: string;
  exports?: ExportSwitches;
};

export type RequestInput = LabourInput | PartsInput;

type UnitStatus = "pending" | "running" | "completed" | "failed";

/** One Renault export: one file stored raw in S3 plus its manifest. */
export type UnitSummary = {
  unit: string;
  queryCode: string;
  /** Family sent to Renault for this export. */
  family: string;
  path: string;
  status: UnitStatus;
  fileName?: string;
  reused?: boolean;
  remoteStatus?: string;
  error?: string;
};

/** Persisted JSON state of one extraction request. `status` is core-reader's RequestStatus. */
export type RenaultRequestState = {
  requestId: string;
  resource: Resource;
  status: RequestStatus;
  stage: string;
  progress: number;
  input: RequestInput;
  units: UnitSummary[];
  /** True until the PR08/PR03 units have been derived from the stored REF04 and REF05. */
  familiesPending: boolean;
  families?: string[];
  queueJobId?: string;
  runId?: string;
  error?: string;
  /** Code of the failure (core `ApplicationError.code`); INTERNAL_ERROR when it was not one. */
  errorCode?: ErrorCode;
  createdAt: string;
  updatedAt: string;
};

export type RequestListFilters = { status?: string[]; manufacturer?: string; axCode?: string; edition?: string };
