import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { InternalRouteDiagnostics } from "./InternalRouteDiagnostics";
import {
  copyRouteDiagnostics,
  type RouteGenerationDiagnostic,
} from "@/lib/route-generation-diagnostics";

const diagnostics: RouteGenerationDiagnostic = {
  correlationId: "route-123",
  requestedExtraMinutes: 85,
  baselineDurationSeconds: 21_600,
  plannedExplorationStages: [],
  attemptsPlanned: 6,
  attemptsCompleted: 6,
  intendedTargetMinutes: [50, 70],
  adaptiveTargetMinutes: [50, 85],
  actualAddedMinutesReturned: 70,
  outcomeClassification: "TARGET_MET",
  candidateEligibility: [],
  candidateScenicScores: [85, 90],
  finalSelectionReason: "TARGET_BAND_HIGHEST_SCENIC_QUALITY",
  totalServerProcessingDurationMs: 2_100,
};

describe("InternalRouteDiagnostics", () => {
  it("shows the copy control when server diagnostics exist", () => {
    const html = renderToStaticMarkup(<InternalRouteDiagnostics diagnostics={diagnostics} />);
    assert.match(html, /Copy route diagnostics/);
  });

  it("renders nothing when diagnostics are absent", () => {
    assert.equal(renderToStaticMarkup(<InternalRouteDiagnostics />), "");
  });

  it("copies formatted diagnostics", async () => {
    let copied = "";
    const success = await copyRouteDiagnostics(diagnostics, {
      writeText: async (value) => {
        copied = value;
      },
    });
    assert.equal(success, true);
    assert.deepEqual(Object.keys(JSON.parse(copied)), Object.keys(diagnostics));
  });

  it("handles clipboard failure without throwing", async () => {
    const success = await copyRouteDiagnostics(diagnostics, {
      writeText: async () => {
        throw new Error("Clipboard unavailable");
      },
    });
    assert.equal(success, false);
  });
});
