import { describe, expect, it } from "vitest";
import {
  quoteIdentifier,
  quoteSqlLiteral,
  validateRoleName,
} from "../scripts/provision-app-role.js";

describe("application role provisioning helpers", () => {
  it("accepts a simple PostgreSQL role name and quotes it", () => {
    expect(validateRoleName("vennek_app")).toBe("vennek_app");
    expect(quoteIdentifier("vennek_app")).toBe('"vennek_app"');
  });

  it("rejects names that could target an owner or system role", () => {
    expect(() => validateRoleName("postgres")).toThrow(/role name/i);
    expect(() => validateRoleName("vennek-app")).toThrow(/role name/i);
    expect(() => validateRoleName("pg_catalog")).toThrow(/role name/i);
  });

  it("quotes a password without exposing SQL syntax", () => {
    expect(quoteSqlLiteral("a'b\\c12345678901234567890")).toBe("E'a\\'b\\\\c12345678901234567890'");
  });
});
