import { describe, expect, it } from "vitest";
import { AGENT_PACKAGE_VERSION } from "@vennek/cardano-agent";

describe("cardano agent package", () => {
  it("exports its package contract", () => {
    expect(AGENT_PACKAGE_VERSION).toBe("1");
  });
});
