import { productIdentity } from "@village/contracts";

export interface DesktopBootstrap {
  product: typeof productIdentity;
  controlPlaneUrl: URL;
}

export function createDesktopBootstrap(
  controlPlaneUrl: string,
): DesktopBootstrap {
  return {
    product: productIdentity,
    controlPlaneUrl: new URL(controlPlaneUrl),
  };
}
