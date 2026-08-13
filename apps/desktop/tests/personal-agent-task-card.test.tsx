import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  dispatchPersonalAgentTask,
  mergePersonalAgentTaskActivity,
  PersonalAgentTaskCard,
} from "../src/renderer/PersonalAgentTaskCard.js";

describe("personal agent task card", () => {
  it("presents an honest first-task workflow", () => {
    const html = renderToStaticMarkup(
      <PersonalAgentTaskCard
        state={{ state: "IDLE" }}
        pending={false}
        activity={[]}
        onSubmit={() => undefined}
      />,
    );
    expect(html).toContain("Ask Village");
    expect(html).toContain("Check whether I’m signed in");
    expect(html).toContain("LinkedIn actions remain human-only");
  });

  it("renders a fixed, accessible activity timeline without detail fields", () => {
    const html = renderToStaticMarkup(
      <PersonalAgentTaskCard
        state={{ state: "IDLE" }}
        pending
        activity={[
          { sequence: 1, stage: "CLASSIFYING_BROWSER" },
          { sequence: 2, stage: "CONSULTING_CHATGPT" },
        ]}
        onSubmit={() => undefined}
      />,
    );

    expect(html).toContain("Village activity");
    expect(html).toContain("Checking the visible browser route");
    expect(html).toContain("Asking ChatGPT for the allowed read-only check");
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain("linkedin.com");
  });

  it("does not claim a failed or declined stage succeeded", () => {
    const html = renderToStaticMarkup(
      <PersonalAgentTaskCard
        state={{ state: "NEEDS_HUMAN", reason: "ACCOUNT_CONFIRMATION" }}
        pending={false}
        activity={[
          { sequence: 1, stage: "CLASSIFYING_BROWSER" },
          { sequence: 2, stage: "CONSULTING_CHATGPT" },
          { sequence: 3, stage: "VERIFYING_BROWSER" },
          { sequence: 4, stage: "WAITING_FOR_OWNER" },
        ]}
        onSubmit={() => undefined}
      />,
    );

    expect(html).toContain("Waiting for your account confirmation");
    expect(html).toContain("Village needs you to confirm the account");
    expect(html).not.toContain("✓");
  });

  it("deduplicates events and resets the timeline when a new run starts", () => {
    const first = { sequence: 1, stage: "CLASSIFYING_BROWSER" as const };
    const second = { sequence: 2, stage: "CONSULTING_CHATGPT" as const };
    expect(mergePersonalAgentTaskActivity([first], second)).toEqual([
      first,
      second,
    ]);
    const current = [first, second];
    expect(mergePersonalAgentTaskActivity(current, second)).toBe(current);
    expect(mergePersonalAgentTaskActivity([first, second], first)).toEqual([
      first,
    ]);
  });

  it("dispatches only the bounded request shape", async () => {
    const runPersonalAgentTask = vi.fn(async () => ({
      state: "COMPLETED" as const,
      outcome: "NOT_AUTHENTICATED" as const,
      evidence: "LOCAL_PREDICATE" as const,
    }));
    await expect(
      dispatchPersonalAgentTask({ runPersonalAgentTask }),
    ).resolves.toMatchObject({ outcome: "NOT_AUTHENTICATED" });
    expect(runPersonalAgentTask).toHaveBeenCalledWith({
      task: "CHECK_LINKEDIN_SIGN_IN",
    });
  });
});
