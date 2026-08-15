import type { LocalDiagnostic } from "./crash-reporting.js";

type ContinuityDiagnosticTarget = {
  reportLocalDiagnostic(diagnostic: LocalDiagnostic): void;
};

const storageRecoveryCodes = new Set([
  "RECIPIENT_KEY_ALREADY_EXISTS",
  "RECIPIENT_KEY_CORRUPT",
  "RECIPIENT_KEY_PERMISSIONS_TOO_BROAD",
  "RECIPIENT_KEY_UNSAFE_PATH",
  "SECURE_RECIPIENT_KEY_STORAGE_UNAVAILABLE",
]);

export function classifyContinuityEnrollmentError(
  error: unknown,
): LocalDiagnostic {
  const code = error instanceof Error ? error.message : "";
  if (code === "CONTINUITY_RECIPIENT_KEY_CONFLICT") {
    return {
      component: "CONTINUITY",
      code: "RECIPIENT_KEY_CONFLICT_OWNER_RECOVERY_REQUIRED",
      retriable: false,
    };
  }
  if (storageRecoveryCodes.has(code)) {
    return {
      component: "CONTINUITY",
      code: "RECIPIENT_KEY_STORAGE_RECOVERY_REQUIRED",
      retriable: false,
    };
  }
  if (
    code === "CONTINUITY_CONTROL_PLANE_TIMEOUT" ||
    code === "CONTINUITY_CONTROL_PLANE_REJECTED" ||
    error instanceof TypeError
  ) {
    return {
      component: "CONTINUITY",
      code: "ENROLLMENT_NETWORK_UNAVAILABLE",
      retriable: true,
    };
  }
  return {
    component: "CONTINUITY",
    code: "ENROLLMENT_OWNER_RECOVERY_REQUIRED",
    retriable: false,
  };
}

export function startNonBlockingContinuityEnrollment<
  Window extends ContinuityDiagnosticTarget,
>(window: Window, enroll?: () => Promise<unknown>): Window {
  if (enroll) {
    void Promise.resolve()
      .then(enroll)
      .catch((error: unknown) => {
        window.reportLocalDiagnostic(classifyContinuityEnrollmentError(error));
      });
  }
  return window;
}
