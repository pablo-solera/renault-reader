import { UpstreamError } from "@pablosla/core-reader/domain/errors";
import { TokenError, type AccessTokenProvider, type TokenResponse } from "@pablosla/core-reader/infrastructure/auth/token-pool";
import type { RenaultApi } from "../../application/ports/renault-api.js";
import type { Json, RenaultQuery } from "../../domain/renault-query.js";

export type RenaultClientSettings = {
  apiBase: string;
  gigyaBase: string;
  gigyaApiKey: string;
  email: string;
  password: string;
  timeoutMs: number;
  downloadTimeoutMs: number;
  tokenTtlSeconds: number;
};

export class RenaultApiError extends UpstreamError {
  constructor(message: string, readonly status?: number) {
    super(message, status === undefined ? undefined : { status });
    this.name = "RenaultApiError";
  }
}

const joinUrl = (base: string, path: string) => /^https?:\/\//i.test(path) ? path : `${base.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;

async function jsonResponse(response: Response, service: string): Promise<Json> {
  const text = await response.text();
  let body: any;
  try { body = text ? JSON.parse(text) : {}; } catch { throw new RenaultApiError(`${service} returned invalid JSON`, response.status); }
  if (!response.ok) {
    const detail = typeof body?.message === "string" ? `: ${body.message}` : typeof body?.errorMessage === "string" ? `: ${body.errorMessage}` : body && Object.keys(body).length ? `: ${JSON.stringify(body).slice(0, 300)}` : "";
    throw new RenaultApiError(`${service} returned HTTP ${response.status}${detail}`, response.status);
  }
  if (!body || typeof body !== "object") throw new RenaultApiError(`${service} returned an invalid object`, response.status);
  return body;
}

const network = (service: string) => (error: unknown): never => {
  throw new RenaultApiError(`${service} request failed: ${error instanceof Error ? error.message : String(error)}`);
};

const asTokenError = (error: unknown) => new TokenError(error instanceof Error ? error.message : String(error), error instanceof RenaultApiError ? error.status : undefined);

/**
 * Gigya login followed by the ASMDOR token exchange. The result fits core's `AccessTokenPool` (its request function),
 * but it is not OAuth client-credentials: the account's e-mail and password are signed in with Gigya first.
 * A rejected login is permanent (`TokenError` with a 4xx status); network problems are transient.
 */
export function createGigyaTokenRequest(settings: RenaultClientSettings, fetcher: typeof fetch = fetch) {
  return async function requestToken(): Promise<TokenResponse> {
    if (!settings.gigyaApiKey) throw new TokenError("GIGYA_API_KEY is required", 400);
    if (!settings.email || !settings.password) throw new TokenError("RENAULT_EMAIL and RENAULT_PASSWORD are required", 400);
    const form = new URLSearchParams({
      apiKey: settings.gigyaApiKey,
      loginID: settings.email.trim().toLowerCase(),
      password: settings.password,
      sessionExpiration: "600",
      pageURL: "https://asmdor.renault.com/",
    });
    const response = await fetcher(`${settings.gigyaBase}/accounts.login`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
      signal: AbortSignal.timeout(settings.timeoutMs),
    }).catch(error => { throw new TokenError(`Gigya login request failed: ${error instanceof Error ? error.message : String(error)}`); });
    const body = await jsonResponse(response, "Gigya login").catch(error => { throw asTokenError(error); });
    if (body.errorCode !== 0 || body.status === "FAIL") throw new TokenError(`Gigya rejected login (${body.errorCode ?? "unknown"})`, 403);
    if (body.isActive !== true) throw new TokenError("Gigya account is not active", 403);
    const proof = { UID: body.UID, UIDSignature: body.UIDSignature, signatureTimestamp: body.signatureTimestamp };
    if (Object.values(proof).some(value => typeof value !== "string" || !value)) throw new TokenError("Gigya did not return a valid signed identity", 502);

    const exchange = await fetcher(joinUrl(settings.apiBase, "v1/user/gigya/accessToken"), {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(proof),
      signal: AbortSignal.timeout(settings.timeoutMs),
    }).catch(error => { throw new TokenError(`ASMDOR token exchange failed: ${error instanceof Error ? error.message : String(error)}`); });
    const exchanged = await jsonResponse(exchange, "ASMDOR token exchange").catch(error => { throw asTokenError(error); });
    if (typeof exchanged.accessToken !== "string" || !exchanged.accessToken) throw new TokenError("ASMDOR did not return accessToken", 502);
    // ASMDOR does not state how long the token lives: the configured lifetime decides when it is replaced (a 401 replaces it sooner).
    return { access_token: exchanged.accessToken, expires_in: settings.tokenTtlSeconds };
  };
}

export class RenaultClient implements RenaultApi {
  constructor(private readonly settings: RenaultClientSettings, private readonly tokens: AccessTokenProvider, private readonly fetcher: typeof fetch = fetch) {}

  private async request(path: string, init: RequestInit = {}): Promise<Json> {
    let token = await this.tokens.getAccessToken();
    for (let attempt = 0; ; attempt++) {
      const headers = new Headers(init.headers);
      headers.set("Accept", "application/json");
      headers.set("Content-Type", "application/json");
      headers.set("Authorization", `Bearer ${token}`);
      const response = await this.fetcher(joinUrl(this.settings.apiBase, path), { ...init, headers, signal: AbortSignal.timeout(this.settings.timeoutMs) }).catch(network(path));
      if (response.status === 401 && attempt === 0) {
        await response.body?.cancel();
        token = await this.tokens.renewAccessToken(token);
        continue;
      }
      return jsonResponse(response, path);
    }
  }

  applicability() {
    return this.request(`v1/apigee/partnerApplicability/GIGYAUSER/${encodeURIComponent(this.settings.email)}`, { method: "POST", body: JSON.stringify({}) });
  }

  profileData(commercialName: string) {
    return this.request(`rest/v1/profile/getProfileData/${encodeURIComponent(commercialName)}`);
  }

  queries(profileValue: string, role: string) {
    return this.request(`rest/v1/query/get/profile/${encodeURIComponent(profileValue)}`, { method: "POST", body: JSON.stringify(role) });
  }

  nonConfidentialFamilies(familyType: string, profile: string, brand: unknown) {
    return this.request("rest/newDialo/getNonConfidentialFamily", { method: "POST", body: JSON.stringify({ familyType, profile, brand }) });
  }

  async status(query: RenaultQuery, payload: Json, fileName: string): Promise<Json> {
    try {
      return await this.request("rest/v1/requestquery/get/status", {
        method: "POST",
        body: JSON.stringify({ ...payload, queryLabel: `${query.queryCode} - ${query.queryDesc}`, queryid: query.id, fileName }),
      });
    } catch (error) {
      if (error instanceof RenaultApiError && error.status === 500) return { status: "STATUS_ERROR", errorMessage: error.message };
      throw error;
    }
  }

  async launch(query: RenaultQuery, payload: Json): Promise<void> {
    await this.request(query.queryService, { method: "POST", body: JSON.stringify(payload) });
  }

  history() {
    return this.request(`rest/v1/history/get/${encodeURIComponent(this.settings.email)}`, { method: "POST", body: JSON.stringify({ headers: { "Content-Type": "application/json" } }) });
  }

  downloadUrl(filePath: string, fileName: string, queryCode: string) {
    return this.request("rest/s3/get/downloadURL", { method: "POST", body: JSON.stringify({ filePath, fileName, queryCode }) });
  }

  /** A direct GET to the presigned URL: it must not receive the ASMDOR bearer token. */
  async download(url: string) {
    const response = await this.fetcher(url, { signal: AbortSignal.timeout(this.settings.downloadTimeoutMs) }).catch(network("Renault download"));
    if (!response.ok) throw new RenaultApiError(`Renault download returned HTTP ${response.status}`, response.status);
    return { bytes: new Uint8Array(await response.arrayBuffer()), contentType: response.headers.get("content-type") };
  }
}
