// SPDX-FileCopyrightText: 2026 Ben Senescu
// SPDX-License-Identifier: MIT
// Village-Provenance: Downy 26bb2e24699966569f6990a2d941de66db997ae4 src/lib/mobile-panel.ts
import { useSyncExternalStore } from "react";

let panelOpen = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

export function useMobilePanel(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => panelOpen,
    () => false,
  );
}

export function setMobilePanel(next: boolean): void {
  if (panelOpen === next) return;
  panelOpen = next;
  emit();
}
