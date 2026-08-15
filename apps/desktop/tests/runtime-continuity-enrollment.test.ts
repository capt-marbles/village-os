import { describe, expect, it, vi } from "vitest";
import {
  classifyContinuityEnrollmentError,
  startNonBlockingContinuityEnrollment,
} from "../src/main/runtime-continuity-enrollment.js";

describe("runtime continuity enrollment", () => {
  it("returns the Village window before a configured enrollment rejects and handles the rejection", async () => {
    const diagnostic = vi.fn();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const villageWindow = { reportLocalDiagnostic: diagnostic };

    try {
      const returned = startNonBlockingContinuityEnrollment(
        villageWindow,
        async () => {
          throw new Error("CONTINUITY_CONTROL_PLANE_TIMEOUT");
        },
      );

      expect(returned).toBe(villageWindow);
      await vi.waitFor(() =>
        expect(diagnostic).toHaveBeenCalledWith({
          component: "CONTINUITY",
          code: "ENROLLMENT_NETWORK_UNAVAILABLE",
          retriable: true,
        }),
      );
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("classifies conflicts as explicit owner recovery instead of endless retry", () => {
    expect(
      classifyContinuityEnrollmentError(
        new Error("CONTINUITY_RECIPIENT_KEY_CONFLICT"),
      ),
    ).toEqual({
      component: "CONTINUITY",
      code: "RECIPIENT_KEY_CONFLICT_OWNER_RECOVERY_REQUIRED",
      retriable: false,
    });
  });

  it.each([
    "RECIPIENT_KEY_CORRUPT",
    "RECIPIENT_KEY_UNSAFE_PATH",
    "RECIPIENT_KEY_PERMISSIONS_TOO_BROAD",
    "SECURE_RECIPIENT_KEY_STORAGE_UNAVAILABLE",
  ])("classifies %s as local storage recovery", (code) => {
    expect(classifyContinuityEnrollmentError(new Error(code))).toEqual({
      component: "CONTINUITY",
      code: "RECIPIENT_KEY_STORAGE_RECOVERY_REQUIRED",
      retriable: false,
    });
  });
});
