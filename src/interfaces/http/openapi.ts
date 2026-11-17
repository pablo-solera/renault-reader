import { generateOpenApiV1 } from "@pablosla/core-reader/contract/openapi";
import { swaggerDocsHtml } from "@pablosla/core-reader/interfaces/http/express/docs";
import { labourSelectionSchema, partsSelectionSchema } from "../../domain/validation.js";
import { PARTS_EXPORT_CODES } from "../../domain/exports.js";

export const docsHtml = swaggerDocsHtml("Renault Reader API v1");

export function buildRenaultOpenApi(port: number) {
  return generateOpenApiV1({
    title: "Renault Reader API",
    version: "1.0.0",
    serverUrl: `http://localhost:${port}`,
    selectionSchemas: { RenaultLabourSelection: labourSelectionSchema, RenaultPartsSelection: partsSelectionSchema },
    paths: {
      "/v1/models/options": { get: {
        tags: ["Models"],
        summary: "Discover the families an ASMDOR account may extract",
        description: "Renault has no model catalogue: the authorised families, formats and languages of one export are returned. With the default exportType TM01 each family carries a ready labour selection.",
        parameters: [
          { name: "manufacturer", in: "query", schema: { type: "string" }, description: "Brand to echo in the response." },
          { name: "range", in: "query", schema: { type: "string", enum: ["active", "old", "future"], default: "active" } },
          { name: "exportType", in: "query", schema: { type: "string", enum: ["TM01", ...PARTS_EXPORT_CODES], default: "TM01" } },
          { name: "includeRaw", in: "query", schema: { type: "boolean", default: false } },
        ],
        responses: {
          "200": { description: "Authorised families, formats and languages.", content: { "application/json": { schema: { $ref: "#/components/schemas/ModelOptions" } } } },
          "400": { description: "Invalid filters." },
          "422": { description: "The export or family is not available for this account." },
          "502": { description: "The ASMDOR API failed." },
          "503": { description: "Renault login failed or the API is unavailable." },
        },
      } },
    },
  });
}
