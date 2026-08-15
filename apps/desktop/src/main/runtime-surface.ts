export type RuntimeSurface = "WORKSPACE" | "RITUAL_BUILDER";

export function resolveRuntimeSurface(
  arguments_: readonly string[],
): RuntimeSurface {
  return arguments_.includes("--ritual-builder")
    ? "RITUAL_BUILDER"
    : "WORKSPACE";
}
