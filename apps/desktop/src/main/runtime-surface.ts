export type RuntimeSurface = "WORKSPACE" | "RITUAL_BUILDER";

export function resolveRuntimeSurface(
  arguments_: readonly string[],
): RuntimeSurface {
  return arguments_.includes("--browser-workspace")
    ? "WORKSPACE"
    : "RITUAL_BUILDER";
}
