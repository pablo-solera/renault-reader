import type { LabourRequest, RenaultQuery } from "./types.js";
import { config } from "./config.js";

type Json = Record<string, any>;

const joinUrl = (base: string, path: string) => {
  if (/^https?:\/\//i.test(path)) return path;
  return `${base.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
};

async function jsonResponse(response: Response, service: string): Promise<Json> {
  const text = await response.text();
  let body: any;
  try { body = text ? JSON.parse(text) : {}; } catch { throw new Error(`${service} returned invalid JSON`); }
  if (!response.ok) throw new Error(`${service} returned HTTP ${response.status}`);
  if (!body || typeof body !== "object") throw new Error(`${service} returned an invalid object`);
  return body;
}

export class RenaultClient {
  constructor(private readonly token: string) {}

  private async request(path: string, init: RequestInit = {}): Promise<Json> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    headers.set("Content-Type", "application/json");
    headers.set("Authorization", `Bearer ${this.token}`);
    return jsonResponse(await fetch(joinUrl(config.renaultApiBase, path), { ...init, headers }), path);
  }

  async applicability(email: string): Promise<Json> {
    return this.request(`v1/apigee/partnerApplicability/GIGYAUSER/${encodeURIComponent(email)}`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  }

  async profileData(commercialName: string): Promise<Json> {
    return this.request(`rest/v1/profile/getProfileData/${encodeURIComponent(commercialName)}`);
  }

  async queries(profileValue: string, role: string): Promise<Json> {
    return this.request(`rest/v1/query/get/profile/${encodeURIComponent(profileValue)}`, {
      method: "POST",
      body: JSON.stringify(role),
    });
  }

  async powertrainFamilies(vehicleFamilyList: unknown[], powertrainFamilyList: unknown[]): Promise<Json> {
    return this.request("rest/tapvmb/get/powerTrainfamilyValues", {
      method: "POST",
      body: JSON.stringify({ vehiclefamilyList: vehicleFamilyList, powertrainFamilyList }),
    });
  }

  async nonConfidentialFamilies(familyType: string, profile: string, brand: unknown): Promise<Json> {
    return this.request("rest/newDialo/getNonConfidentialFamily", {
      method: "POST",
      body: JSON.stringify({ familyType, profile, brand }),
    });
  }

  async status(query: RenaultQuery, payload: Json, fileName: string): Promise<Json> {
    return this.request("rest/v1/requestquery/get/status", {
      method: "POST",
      body: JSON.stringify({ ...payload, queryLabel: `${query.queryCode} - ${query.queryDesc}`, queryid: query.id, fileName }),
    });
  }

  async launch(query: RenaultQuery, payload: Json): Promise<void> {
    await this.request(query.queryService, { method: "POST", body: JSON.stringify(payload) });
  }

  async history(email: string): Promise<Json> {
    return this.request(`rest/v1/history/get/${encodeURIComponent(email)}`, {
      method: "POST",
      body: JSON.stringify({ headers: { "Content-Type": "application/json" } }),
    });
  }

  async downloadUrl(filePath: string, fileName: string, queryCode: string): Promise<Json> {
    return this.request("rest/s3/get/downloadURL", {
      method: "POST",
      body: JSON.stringify({ filePath, fileName, queryCode }),
    });
  }

  async download(url: string): Promise<Response> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Renault download returned HTTP ${response.status}`);
    return response;
  }
}

export async function gigyaLogin(email: string, password: string): Promise<{ token: string; uid: string }> {
  if (!config.gigyaApiKey) throw new Error("GIGYA_API_KEY is required");
  const form = new URLSearchParams({
    apiKey: config.gigyaApiKey,
    loginID: email.trim().toLowerCase(),
    password,
    sessionExpiration: "600",
    pageURL: "https://asmdor.renault.com/",
  });
  const response = await fetch(`${config.gigyaApiBase}/accounts.login`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  const body = await jsonResponse(response, "Gigya login");
  if (body.errorCode !== 0 || body.status === "FAIL") throw new Error(`Gigya rejected login (${body.errorCode ?? "unknown"})`);
  if (body.isActive !== true) throw new Error("Gigya account is not active");
  const proof = { UID: body.UID, UIDSignature: body.UIDSignature, signatureTimestamp: body.signatureTimestamp };
  if (Object.values(proof).some((value) => typeof value !== "string" || !value)) throw new Error("Gigya did not return a valid signed identity");

  const exchange = await fetch(joinUrl(config.renaultApiBase, "v1/user/gigya/accessToken"), {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(proof),
  });
  const exchanged = await jsonResponse(exchange, "ASMDOR token exchange");
  if (typeof exchanged.accessToken !== "string" || !exchanged.accessToken) throw new Error("ASMDOR did not return accessToken");
  return { token: exchanged.accessToken, uid: body.UID };
}

export function buildFileName(query: RenaultQuery, input: LabourRequest, profileValue: string): string {
  const source = query.queryDownloadPath.split("/")[1];
  if (!source) throw new Error("TM01 queryDownloadPath has no file name");
  const dot = source.indexOf(".");
  const base = dot >= 0 ? source.slice(0, dot) : source;
  const familyPart = query.familyFilter ? (input.family === "All" ? "All" : input.family) : "All";
  let name = `${base}_${familyPart}_${profileValue.toLowerCase()}`;
  if (query.language) name += `_${input.language}`;
  if (input.publishedAfter) name += `_after${input.publishedAfter.replaceAll("-", "")}`;
  return `${name}${input.format.includes(".") ? input.format : `.${input.format}`}`;
}

export function getPartnerFamilies(applicability: Json, query: RenaultQuery, range: string): Json[] {
  if (!["active", "old", "future"].includes(range)) throw new Error(`Unsupported range ${range}; use active, old or future`);
  const collection = query.familyType === "VEHICLE" ? "vehicleFamilyList" : query.familyType === "POWERTRAIN" ? "powertrainFamilyList" : query.familyType === "All" ? "allfamilyList" : null;
  if (!collection) throw new Error(`Unsupported TM01 familyType ${String(query.familyType)}`);
  const source = applicability.responseData?.[collection];
  if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error(`Renault response has no ${collection} object`);
  if (!(range in source)) throw new Error(`${collection} has no ${range} range; available: ${Object.keys(source).join(", ") || "none"}`);
  const list = source[range];
  if (list === null) throw new Error(`${collection}.${range} is null`);
  if (!Array.isArray(list)) throw new Error(`${collection}.${range} is not an array`);
  if (list.length === 0) throw new Error(`${collection}.${range} is empty`);
  return list.filter((item) => item && typeof item === "object").sort((a, b) => String(a.value).localeCompare(String(b.value)));
}

export function getEditorFamilies(response: Json, query: RenaultQuery): Json[] {
  const list = response.responseData;
  if (!Array.isArray(list)) throw new Error(`Renault returned no non-confidential families for ${String(query.familyType)}`);
  if (list.length === 0) throw new Error(`Renault returned an empty non-confidential family list for ${String(query.familyType)}`);
  return list.filter((item) => item && typeof item === "object").sort((a, b) => String(a.value).localeCompare(String(b.value)));
}

export async function discoverLabourOptions(client: RenaultClient, email: string, range: string) {
  const applicability = await client.applicability(email);
  const data = applicability.responseData;
  if (applicability.status !== "Success" || !data?.commercialName) throw new Error("Renault returned no valid partner applicability");
  if (!data.asomSubscriptions?.applicabilitySubscriptions?.applicabilities?.length) throw new Error("Renault account has no applicability subscription");
  const profiles = await client.profileData(data.commercialName);
  const profile = Array.isArray(profiles.responseData) ? profiles.responseData[0] : null;
  if (!profile?.value) throw new Error("Renault returned no AUDATEX profile");
  const role = data.accountType === "Partner" ? "a5m_partner" : String(profile.role ?? "EDITOR");
  const queryResponse = await client.queries(profile.value, role);
  const query = queryResponse.responseData?.find((item: RenaultQuery) => item.queryCode === "TM01") as RenaultQuery | undefined;
  if (!query) throw new Error("TM01 is not available for this profile");
  let families: Json[] = [];
  if (query.familyFilter) {
    if (data.accountType === "Partner") {
      families = getPartnerFamilies(applicability, query, range);
    } else if (data.accountType === "Publisher of technical information") {
      families = getEditorFamilies(await client.nonConfidentialFamilies(String(query.familyType), String(profile.value), profile.brand), query);
    } else {
      throw new Error(`Unsupported Renault accountType ${String(data.accountType)}`);
    }
  }
  const languages = query.language == null ? null : [...new Set([...query.language, ...(data.applicabilitiesLanguage ?? []).filter(Boolean).map((item: string) => item.toLowerCase())])].sort();
  const formats = query.formatList?.map((item) => item.value) ?? ["csv", "json"];
  return { query, profile, applicability, families, languages, formats, range };
}

export function buildLabourPayload(query: RenaultQuery, profile: Json, input: LabourRequest, selectedFamily?: Json): Json {
  const family = selectedFamily ?? (input.family === "All" ? { value: "All", criteria: "All" } : { value: input.family, criteria: input.family });
  return {
    queryLabel: `${query.queryCode} - ${query.queryDesc}`,
    queryid: query.id,
    family: family.value,
    criteria: family.criteria,
    exportType: query.familyFilter ? (input.family === "All" ? "F" : "P") : query.exportType,
    exportFormat: input.format,
    profile: String(profile.value).toLowerCase(),
    commercialName: profile.user,
    brand: family.brand ?? profile.brand,
    applicabilityFilter: [],
    editorApplicabilityFilter: [],
    contentFormat: typeof query.selectedContentFormat === "string" ? query.selectedContentFormat : null,
    language: input.language,
    publishedDate: input.publishedAfter?.replaceAll("-", "") ?? "",
    countryCode: null,
    interpretModEvent: profile.interpretModEvent,
    userFilterId: null,
    range: input.range,
    role: null,
    ecu: null,
  };
}
