import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  dispatchPersonalAgentTask,
  PersonalAgentTaskCard,
} from "../src/renderer/PersonalAgentTaskCard.js";

describe("personal agent task card", () => {
  it("presents an honest first-task workflow", () => {
    const html = renderToStaticMarkup(
      <PersonalAgentTaskCard
        state={{ state: "IDLE" }}
        pending={false}
        onSubmit={() => undefined}
      />,
    );
    expect(html).toContain("Ask Village");
    expect(html).toContain("Check whether I’m signed in");
    expect(html).toContain("LinkedIn actions remain human-only");
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
