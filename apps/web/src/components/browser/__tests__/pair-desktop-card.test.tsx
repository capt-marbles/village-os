import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PairDesktopCard } from "../PairDesktopCard.js";

describe("pair desktop card", () => {
  it("starts with a public-only, accessible pairing ceremony", () => {
    const html = renderToStaticMarkup(<PairDesktopCard />);
    expect(html).toContain("Add desktop");
    expect(html).toContain("Public pairing request");
    expect(html).toContain("no password, cookies, or private key");
    expect(html).toContain("Review desktop");
    expect(html).not.toContain("pairing secret");
  });
});
