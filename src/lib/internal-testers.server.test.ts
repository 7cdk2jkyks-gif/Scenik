import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shouldExposeInternalDiagnostics } from "./internal-testers.server";

describe("internal diagnostics visibility", () => {
  it("hides diagnostics from a normal production user", () => {
    assert.equal(
      shouldExposeInternalDiagnostics({
        internalTester: false,
        diagnosticsFlag: "true",
        nodeEnv: "production",
      }),
      false,
    );
  });

  it("hides production diagnostics from an internal tester without the flag", () => {
    assert.equal(
      shouldExposeInternalDiagnostics({ internalTester: true, nodeEnv: "production" }),
      false,
    );
  });

  it("shows explicitly enabled production diagnostics to an internal tester", () => {
    assert.equal(
      shouldExposeInternalDiagnostics({
        internalTester: true,
        diagnosticsFlag: "true",
        nodeEnv: "production",
      }),
      true,
    );
  });

  it("shows development diagnostics only to an internal tester", () => {
    assert.equal(
      shouldExposeInternalDiagnostics({ internalTester: true, nodeEnv: "development" }),
      true,
    );
  });
});
