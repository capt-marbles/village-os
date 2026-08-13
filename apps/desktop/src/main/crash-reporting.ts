export const diagnosticFieldAllowlist = [
  "component",
  "code",
  "retriable",
] as const;

export type DiagnosticComponent =
  "SESSION_ERASURE" | "BROWSER_HOST" | "CONTROL_TRANSFER";

export interface LocalDiagnostic {
  component: DiagnosticComponent;
  code: string;
  retriable: boolean;
}

export class CrashReporter {
  private readonly entries: LocalDiagnostic[] = [];

  /** Upload transport is deliberately absent from the alpha default. */
  capture(input: LocalDiagnostic): {
    upload: "DISABLED";
    preview: LocalDiagnostic;
  } {
    if (
      !input ||
      typeof input !== "object" ||
      Object.keys(input).some(
        (key) => !diagnosticFieldAllowlist.includes(key as never),
      ) ||
      !["SESSION_ERASURE", "BROWSER_HOST", "CONTROL_TRANSFER"].includes(
        input.component,
      ) ||
      !/^[A-Z][A-Z0-9_]{0,63}$/.test(input.code) ||
      typeof input.retriable !== "boolean"
    ) {
      throw new Error("DIAGNOSTIC_FIELD_DENIED");
    }
    const preview = {
      component: input.component,
      code: input.code,
      retriable: input.retriable,
    };
    this.entries.push(preview);
    if (this.entries.length > 50) this.entries.shift();
    return {
      upload: "DISABLED",
      preview,
    };
  }

  snapshot(): readonly LocalDiagnostic[] {
    return this.entries.map((entry) => ({
      component: entry.component,
      code: entry.code,
      retriable: entry.retriable,
    }));
  }
}
