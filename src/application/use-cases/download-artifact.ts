import { NotDownloadableError, NotFoundError, NotReadyError } from "@pablosla/core-reader/domain/errors";
import type { RenaultRequestState, Resource } from "../../domain/request.js";
import { requestArtifacts, type ObjectLocator } from "../../interfaces/http/state-mapper.js";

export type DownloadArtifactDependencies = ObjectLocator & {
  getState(requestId: string): Promise<RenaultRequestState | null>;
  exists(key: string): Promise<boolean>;
  signDownload(key: string, filename?: string): Promise<string>;
};

/** A labour request has one primary file (its raw export); a parts request has one file and one manifest per unit, chosen by name. */
export async function downloadArtifactUseCase(resource: Resource, requestId: string, artifactName: string | undefined, dependencies: DownloadArtifactDependencies): Promise<string> {
  const state = await dependencies.getState(requestId);
  if (!state || state.resource !== resource) throw new NotFoundError("Request not found", { requestId });
  const artifacts = requestArtifacts(state, dependencies);
  const artifact = artifactName ? artifacts.find(item => item.name === artifactName) : artifacts.find(item => item.primary);
  if (!artifactName && !artifact) throw new NotReadyError(state.resource === "parts" ? "Parts requests do not have a single primary file" : "The export is not stored yet", { status: state.status, artifacts });
  if (!artifact) throw new NotFoundError("Artifact not found", { requestId, artifact: artifactName });
  if (artifact.kind === "prefix") throw new NotDownloadableError("S3 prefixes cannot be downloaded as a single file", { artifact: artifact.name });
  if (!await dependencies.exists(artifact.location.key)) throw new NotReadyError("Artifact is not ready", { status: state.status, artifact: artifact.name });
  return dependencies.signDownload(artifact.location.key, artifact.name);
}
