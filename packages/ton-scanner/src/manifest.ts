import { z } from "zod";
import type { Result } from "@tonshield/shared";
import { err, ok } from "@tonshield/shared";
import { parseJson } from "./utils.ts";

const tonConnectManifestSchema = z.object({
  url: z.url(),
  name: z.string().min(1),
  iconUrl: z.url(),
  termsOfUseUrl: z.url().optional(),
  privacyPolicyUrl: z.url().optional(),
});

export interface TonConnectManifest {
  readonly url: URL;
  readonly name: string;
  readonly iconUrl: URL;
  readonly termsOfUseUrl: URL | null;
  readonly privacyPolicyUrl: URL | null;
}

export interface ManifestIdentityCheck {
  readonly manifestOrigin: string;
  readonly declaredAppOrigin: string;
  readonly hasOriginMismatch: boolean;
}

export type ManifestParseError = "invalid_json" | "invalid_manifest";

export const parseTonConnectManifest = (
  rawJson: string,
): Result<TonConnectManifest, ManifestParseError> => {
  const json = parseJson(rawJson);

  if (!json.ok) {
    return err("invalid_json");
  }

  const parsed = tonConnectManifestSchema.safeParse(json.value);

  if (!parsed.success) {
    return err("invalid_manifest");
  }

  return ok({
    url: new URL(parsed.data.url),
    name: parsed.data.name,
    iconUrl: new URL(parsed.data.iconUrl),
    termsOfUseUrl:
      parsed.data.termsOfUseUrl === undefined ? null : new URL(parsed.data.termsOfUseUrl),
    privacyPolicyUrl:
      parsed.data.privacyPolicyUrl === undefined ? null : new URL(parsed.data.privacyPolicyUrl),
  });
};

export const checkManifestIdentity = (
  manifestUrl: URL,
  manifest: TonConnectManifest,
): ManifestIdentityCheck => ({
  manifestOrigin: manifestUrl.origin,
  declaredAppOrigin: manifest.url.origin,
  hasOriginMismatch: manifestUrl.origin !== manifest.url.origin,
});
