export type DesktopRendererMode = "WORKSPACE" | "PAIRING" | "RITUAL_BUILDER";

export function resolveDesktopRendererMode(url: URL): DesktopRendererMode {
  switch (url.searchParams.get("mode")) {
    case "pairing":
      return "PAIRING";
    case "ritual-builder":
      return "RITUAL_BUILDER";
    default:
      return "WORKSPACE";
  }
}
