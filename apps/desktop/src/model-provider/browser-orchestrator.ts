import {
  OWNED_FIXTURE_ORIGIN,
  authorizeSiteCommand,
  type ModelProvider,
  type ModelProviderResult,
  type SanitizedModelContext,
} from "@village/contracts";

/**
 * The only model-driven orchestration enabled in the alpha. LinkedIn is
 * intentionally absent: its browser remains human-only.
 */
export async function requestOwnedFixtureAction(
  provider: ModelProvider,
  context: SanitizedModelContext,
): Promise<ModelProviderResult> {
  if (context.observation.canonicalOrigin !== OWNED_FIXTURE_ORIGIN) {
    return { status: "waiting", reason: "SITE_POLICY_DENIED" };
  }
  const result = await provider.nextAction(context);
  if (result.status !== "action") return result;
  const authorization = authorizeSiteCommand("OWNED_FIXTURE", result.command);
  return authorization.ok
    ? result
    : { status: "waiting", reason: "SITE_POLICY_DENIED" };
}
