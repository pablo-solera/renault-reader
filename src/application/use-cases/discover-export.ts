import { ApplicationError, NotAvailableError } from "@pablosla/core-reader/domain/errors";
import type { RenaultApi } from "../ports/renault-api.js";
import { getEditorFamilies, getPartnerFamilies, type Json, type RenaultQuery } from "../../domain/renault-query.js";

export type DiscoveredExport = {
  query: RenaultQuery;
  profile: Json;
  applicability: Json;
  families: Json[];
  languages: string[] | null;
  formats: string[];
  range: string;
};

/**
 * Applicability -> profile -> query catalogue -> authorised families, languages and formats of one export (`TM01`, `REF04`...).
 * The authorisation rules (partner vs editor accounts) are the ones of the legacy ASMDOR flow.
 */
export async function discoverExport(api: RenaultApi, range: string, queryCode: string): Promise<DiscoveredExport> {
  const applicability = await api.applicability();
  const data = applicability.responseData;
  if (applicability.status !== "Success" || !data?.commercialName) throw new NotAvailableError("Renault returned no valid partner applicability");
  if (!data.asomSubscriptions?.applicabilitySubscriptions?.applicabilities?.length) throw new NotAvailableError("Renault account has no applicability subscription");
  const profiles = await api.profileData(data.commercialName);
  const profile = Array.isArray(profiles.responseData) ? profiles.responseData[0] : null;
  if (!profile?.value) throw new NotAvailableError("Renault returned no AUDATEX profile");
  const role = data.accountType === "Partner" ? "a5m_partner" : String(profile.role ?? "EDITOR");
  const queryResponse = await api.queries(profile.value, role);
  const query = queryResponse.responseData?.find((item: RenaultQuery) => item.queryCode === queryCode) as RenaultQuery | undefined;
  if (!query) throw new NotAvailableError(`${queryCode} is not available for this profile`);
  let families: Json[] = [];
  if (query.familyFilter) {
    try {
      if (data.accountType === "Partner") {
        families = getPartnerFamilies(applicability, query, range);
      } else if (data.accountType === "Publisher of technical information") {
        families = getEditorFamilies(await api.nonConfidentialFamilies(String(query.familyType), String(profile.value), profile.brand), query);
      } else {
        throw new NotAvailableError(`Unsupported Renault accountType ${String(data.accountType)}`);
      }
    } catch (error) {
      if (error instanceof ApplicationError || !(error instanceof Error)) throw error;
      throw new NotAvailableError(error.message);
    }
  }
  const languages = query.language == null ? null : [...new Set([...query.language, ...(data.applicabilitiesLanguage ?? []).filter(Boolean).map((item: string) => item.toLowerCase())])].sort();
  const formats = query.formatList?.map(item => item.value) ?? [query.queryDownloadPath.toLowerCase().endsWith(".tar.gz") ? "tar.gz" : "zip"];
  return { query, profile, applicability, families, languages, formats, range };
}
