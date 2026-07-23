import { describe, expect, it } from "vitest";

describe("web workspace", () => {
  it("has a deterministic baseline", () => {
    expect("Mindmark".toLowerCase()).toBe("mindmark");
  });
});

