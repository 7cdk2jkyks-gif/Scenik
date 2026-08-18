import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ComputedDirections } from "./google-maps.server";
import { evaluateRouteCoherence, ROUTE_COHERENCE_MAX_ENCODED_CHARACTERS } from "./route-coherence";
import {
  budgetUtilisationBand,
  candidateSelectionDiagnostics,
  candidateBudgetUtilisation,
  MIN_ACCEPTABLE_TARGET_SCORE,
  maximumAllowedDurationSeconds,
  routesAreMeaningfullyDifferent,
  selectRouteCandidate,
  MIN_TARGET_UTILISATION,
  TIME_TARGET_SCENIC_QUALITY_GUARDRAIL,
  type ScoredRouteCandidate,
} from "./route-selection";

function candidate(
  originalIndex: number,
  durationSeconds: number,
  score: number,
  distanceMeters = 10_000 + originalIndex * 1_000,
): ScoredRouteCandidate<{ total: number }> {
  const directions: ComputedDirections = {
    encodedPolyline: `polyline-${originalIndex}`,
    distance: `${distanceMeters} m`,
    duration: `${durationSeconds} s`,
    distanceMeters,
    durationSeconds,
    steps: [],
  };
  return { originalIndex, directions, score, scoreResult: { total: score } };
}

describe("selectRouteCandidate", () => {
  it("keeps the Production +18.1 fallback until a qualifying refined target exists", () => {
    const baselineSeconds = 22_064;
    const ordinary = [
      { id: "baseline-0", added: 0, score: 72, coherent: true },
      { id: "scenic-stage-4", added: 41.4, score: 0, coherent: false },
      { id: "scenic-stage-5", added: 18.1, score: 79, coherent: true },
      { id: "scenic-stage-6", added: 12.6, score: 78, coherent: true },
      { id: "scenic-stage-7", added: 13.3, score: 77, coherent: true },
    ].map(({ id, added, score, coherent }, index) => ({
      ...candidate(index, baselineSeconds + added * 60, score),
      candidateId: id,
      routeShapeEligible: coherent,
    }));
    const before = selectRouteCandidate(ordinary, 30);
    assert.equal(before.selected.candidateId, "scenic-stage-5");
    assert.equal(before.timeTargetOutcome, "MEANINGFUL_FALLBACK");

    const qualifyingRefinement = {
      ...candidate(ordinary.length, baselineSeconds + 26.2 * 60, 78),
      candidateId: "duration-refinement-8",
      routeShapeEligible: true,
    };
    const after = selectRouteCandidate([...ordinary, qualifyingRefinement], 30);
    assert.equal(after.selected.candidateId, "duration-refinement-8");
    assert.equal(after.timeTargetOutcome, "TARGET_MET");

    const weakRefinement = {
      ...candidate(ordinary.length, baselineSeconds + 26.2 * 60, 59),
      candidateId: "duration-refinement-weak",
      routeShapeEligible: true,
    };
    assert.equal(
      selectRouteCandidate([...ordinary, weakRefinement], 30).selected.candidateId,
      "scenic-stage-5",
    );
  });

  it("models the captured 30-minute quality guardrail with stable candidate lineage", () => {
    const baselineSeconds = 21_600;
    const captured = [
      { id: "google-alternative-1", added: 11.8, score: 73 },
      { id: "scenic-stage-2", added: 17, score: 57 },
      { id: "scenic-stage-3", added: 18.8, score: 43 },
      { id: "scenic-stage-4", added: 25.4, score: 42 },
    ].map(({ id, added, score }, index) => ({
      ...candidate(index + 1, baselineSeconds + added * 60, score),
      candidateId: id,
      routeShapeEligible: true,
    }));
    const candidates = [
      { ...candidate(0, baselineSeconds, 77), candidateId: "baseline-0" },
      ...captured,
    ];
    const selection = selectRouteCandidate(candidates, 30);
    const diagnostics = candidateSelectionDiagnostics(candidates, selection, 30);

    assert.equal(selection.selected.candidateId, "google-alternative-1");
    assert.equal(selection.timeTargetOutcome, "MEANINGFUL_FALLBACK");
    assert.equal(
      diagnostics.find((item) => item.candidateId === "scenic-stage-4")?.rejectionReason,
      "BELOW_ABSOLUTE_QUALITY_FLOOR",
    );
    assert.equal(73 - 42 > TIME_TARGET_SCENIC_QUALITY_GUARDRAIL, true);
    assert.ok(
      Math.abs(
        candidateBudgetUtilisation(baselineSeconds, baselineSeconds + 25.4 * 60, 30) - 25.4 / 30,
      ) < 1e-12,
    );
  });

  it("cannot rescue incoherent geometry with a higher Scenic Score", () => {
    const coherent = candidate(1, 5_000, 77);
    const incoherent = {
      ...candidate(2, 6_000, 87),
      routeShapeEligible: false,
    };
    const selected = selectRouteCandidate([candidate(0, 4_000, 70), coherent, incoherent], 60);
    assert.equal(selected.selected.originalIndex, 1);
    assert.equal(
      selected.eligible.some((item) => item.originalIndex === 2),
      false,
    );
    const diagnostics = candidateSelectionDiagnostics(
      [candidate(0, 4_000, 70), coherent, incoherent],
      selected,
      60,
    );
    assert.equal(diagnostics.find((item) => item.originalIndex === 1)?.eligible, true);
    assert.equal(
      diagnostics.find((item) => item.originalIndex === 2)?.rejectionReason,
      "INCOHERENT_ROUTE",
    );
  });

  it("keeps the baseline fallback when every generated candidate is incoherent", () => {
    const baseline = candidate(0, 4_000, 70);
    const invalid = { ...candidate(1, 6_000, 99), routeShapeEligible: false };
    const selected = selectRouteCandidate([baseline, invalid], 60);
    assert.equal(selected.selected.originalIndex, 0);
    assert.deepEqual(
      selected.eligible.map((item) => item.originalIndex),
      [0],
    );
  });
  it("keeps the trusted baseline beside an oversized scenic candidate", () => {
    const baseline = { ...candidate(0, 4_000, 70), routeShapeEligible: true };
    const oversizedShape = evaluateRouteCoherence(
      "~".repeat(ROUTE_COHERENCE_MAX_ENCODED_CHARACTERS + 1),
    );
    const oversized = {
      ...candidate(1, 5_000, 99),
      routeShapeEligible: oversizedShape.routeShapeEligible,
    };
    const selected = selectRouteCandidate([baseline, oversized], 60);
    assert.equal(oversizedShape.routeShapeAnalysisStatus, "GEOMETRY_LIMIT_EXCEEDED");
    assert.equal(selected.selected.originalIndex, 0);
  });
  it("recognises a separated corridor even when duration and distance are similar", () => {
    const first = candidate(0, 900, 50).directions;
    const second = candidate(1, 910, 50, first.distanceMeters + 100).directions;
    first.steps = [
      {
        instruction: "Continue",
        distance: "",
        duration: "",
        distanceMeters: 1_000,
        durationSeconds: 60,
        endLat: 51,
        endLng: 0,
      },
    ];
    second.steps = [
      {
        instruction: "Continue",
        distance: "",
        duration: "",
        distanceMeters: 1_000,
        durationSeconds: 60,
        endLat: 51.02,
        endLng: 0,
      },
    ];
    assert.equal(routesAreMeaningfullyDifferent(first, second), true);
  });
  it("expands the duration ceiling for 0, 10, 30 and 60 minutes", () => {
    assert.deepEqual(
      [0, 10, 30, 60].map((minutes) => maximumAllowedDurationSeconds(3_600, minutes)),
      [3_600, 4_200, 5_400, 7_200],
    );
  });
  it("selects the fastest baseline for a zero-minute budget", () => {
    const result = selectRouteCandidate([candidate(0, 600, 50), candidate(1, 620, 90)], 0);
    assert.equal(result.selected.originalIndex, 0);
  });

  it("excludes a candidate adding eleven minutes from a ten-minute budget", () => {
    const result = selectRouteCandidate([candidate(0, 600, 50), candidate(1, 1_260, 90)], 10);
    assert.deepEqual(
      result.eligible.map((item) => item.originalIndex),
      [0],
    );
  });

  it("selects a higher-scoring eligible candidate", () => {
    const result = selectRouteCandidate([candidate(0, 600, 50), candidate(1, 1_080, 70)], 10);
    assert.equal(result.selected.originalIndex, 1);
  });

  it("keeps an over-budget higher-scoring candidate from winning", () => {
    const result = selectRouteCandidate([candidate(0, 600, 50), candidate(1, 1_201, 99)], 10);
    assert.equal(result.selected.originalIndex, 0);
  });

  it("uses duration, distance, then original order as deterministic tie-breaks", () => {
    const result = selectRouteCandidate(
      [candidate(0, 600, 40), candidate(1, 900, 70, 12_000), candidate(2, 900, 70, 11_000)],
      10,
    );
    assert.equal(result.selected.originalIndex, 2);
  });

  it("ignores malformed candidate durations", () => {
    const result = selectRouteCandidate([candidate(0, 600, 50), candidate(1, Number.NaN, 99)], 10);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.selected.originalIndex, 0);
  });

  it("falls back to a valid baseline when an alternative request yields no candidates", () => {
    const result = selectRouteCandidate([candidate(0, 600, 50)], 10);
    assert.equal(result.selected.originalIndex, 0);
    assert.equal(result.candidates.length, 1);
  });

  it("prefers +48 at score 84 over +18 at score 82 for a 60-minute budget", () => {
    const result = selectRouteCandidate(
      [candidate(0, 3_600, 50), candidate(1, 4_680, 82), candidate(2, 6_480, 84)],
      60,
    );
    assert.equal(result.selected.originalIndex, 2);
  });

  it("selects a worthwhile candidate using 80% of an 85-minute allowance", () => {
    const result = selectRouteCandidate(
      [candidate(0, 3_600, 70), candidate(1, 7_680, 76), candidate(2, 8_820, 90)],
      85,
    );
    assert.equal(result.selected.originalIndex, 1);
    assert.equal(result.measuredExtraTimeSeconds, 68 * 60);
    assert.equal(candidateBudgetUtilisation(3_600, 7_680, 85), 0.8);
  });

  it("preserves a +28-minute candidate when the allowance increases from 30 to 85", () => {
    const candidates = [candidate(0, 3_600, 70), candidate(1, 5_280, 82)];
    const thirty = selectRouteCandidate(candidates, 30);
    const eightyFive = selectRouteCandidate(candidates, 85);
    assert.ok(thirty.eligible.some((item) => item.originalIndex === 1));
    assert.ok(eightyFive.eligible.some((item) => item.originalIndex === 1));
    assert.equal(eightyFive.selected.originalIndex, 1);
  });

  it("allows a materially better +15-minute route to beat a weaker +28-minute route", () => {
    const result = selectRouteCandidate(
      [candidate(0, 3_600, 70), candidate(1, 4_500, 90), candidate(2, 5_280, 82)],
      85,
    );
    assert.equal(result.selected.originalIndex, 1);
    assert.equal(
      candidateSelectionDiagnostics(
        [candidate(0, 3_600, 70), candidate(1, 4_500, 90), candidate(2, 5_280, 82)],
        result,
        85,
      ).find((item) => item.selected)?.selectionReason,
      "WEAK_ROUTE_BEST_BALANCE",
    );
  });

  it("prefers a strong target-band route for an 85-minute request", () => {
    const result = selectRouteCandidate(
      [
        candidate(0, 3_600, 70),
        candidate(1, 4_500, 90),
        candidate(2, 5_280, 87),
        candidate(3, 7_800, 84),
      ],
      85,
    );
    assert.equal(result.selected.originalIndex, 3);
    assert.equal(result.timeTargetOutcome, "TARGET_MET");
  });

  it("rejects a target-band route with a severe scenic-quality collapse", () => {
    const result = selectRouteCandidate(
      [candidate(0, 3_600, 70), candidate(1, 4_500, 90), candidate(2, 7_800, 40)],
      85,
    );
    assert.equal(result.selected.originalIndex, 1);
    assert.equal(result.timeTargetOutcome, "WEAK_ROUTE_SELECTED");
  });

  it("does not reselect a target-band route that failed the absolute score floor", () => {
    const input = [candidate(0, 3_600, 50), candidate(1, 7_800, 55)];
    const result = selectRouteCandidate(input, 85);
    assert.equal(result.selected.originalIndex, 0);
    assert.equal(result.timeTargetOutcome, "BASELINE_FALLBACK");
    assert.equal(
      candidateSelectionDiagnostics(input, result, 85)[1].rejectionReason,
      "BELOW_ABSOLUTE_QUALITY_FLOOR",
    );
  });

  it("uses scenic quality rather than duration within the target band", () => {
    const result = selectRouteCandidate(
      [
        candidate(0, 3_600, 70),
        candidate(1, 7_500, 84),
        candidate(2, 7_920, 88),
        candidate(3, 8_520, 86),
      ],
      85,
    );
    assert.equal(result.selected.originalIndex, 2);
    assert.equal(
      candidateSelectionDiagnostics(
        [
          candidate(0, 3_600, 70),
          candidate(1, 7_500, 84),
          candidate(2, 7_920, 88),
          candidate(3, 8_520, 86),
        ],
        result,
        85,
      ).find((item) => item.selected)?.selectionReason,
      "TARGET_BAND_HIGHEST_SCENIC_QUALITY",
    );
  });

  it("uses quality and target proximity when no target-band route exists", () => {
    const result = selectRouteCandidate(
      [candidate(0, 3_600, 70), candidate(1, 4_500, 90), candidate(2, 5_280, 88)],
      85,
    );
    assert.equal(result.selected.originalIndex, 2);
    assert.equal(result.timeTargetOutcome, "WEAK_ROUTE_SELECTED");
  });

  it("prefers an acceptable +28-minute route over +10 for a 30-minute request", () => {
    const result = selectRouteCandidate(
      [candidate(0, 3_600, 70), candidate(1, 4_200, 89), candidate(2, 5_280, 84)],
      30,
    );
    assert.equal(result.selected.originalIndex, 2);
    assert.equal(result.timeTargetOutcome, "TARGET_MET");
  });

  it("enforces the hard maximum for an 85-minute request", () => {
    const result = selectRouteCandidate(
      [candidate(0, 3_600, 70), candidate(1, 7_800, 84), candidate(2, 8_760, 99)],
      85,
    );
    assert.equal(result.selected.originalIndex, 1);
    assert.ok(!result.eligible.some((item) => item.originalIndex === 2));
  });

  it("retains a strong +28-minute route when later candidates are weaker or over budget", () => {
    const result = selectRouteCandidate(
      [
        candidate(0, 3_600, 70),
        candidate(1, 5_280, 88),
        candidate(2, 7_680, 80),
        candidate(3, 8_820, 95),
      ],
      85,
    );
    assert.equal(result.selected.originalIndex, 2);
    assert.ok(result.eligible.some((item) => item.originalIndex === 1));
    assert.ok(!result.eligible.some((item) => item.originalIndex === 3));
  });

  it("diagnoses every candidate without changing selection", () => {
    const baseline = candidate(0, 3_600, 70);
    const duplicate = candidate(1, 3_610, 72, baseline.directions.distanceMeters + 50);
    const valid = candidate(2, 7_680, 76);
    const overBudget = candidate(3, 8_820, 90);
    const input = [baseline, duplicate, valid, overBudget];
    const selection = selectRouteCandidate(input, 85);
    const diagnostics = candidateSelectionDiagnostics(input, selection, 85);
    assert.deepEqual(
      diagnostics.map(
        ({ originalIndex, duplicate: isDuplicate, eligible, selected, rejectionReason }) => ({
          originalIndex,
          duplicate: isDuplicate,
          eligible,
          selected,
          rejectionReason,
        }),
      ),
      [
        {
          originalIndex: 0,
          duplicate: false,
          eligible: true,
          selected: false,
          rejectionReason: "LOWER_UTILISATION_OR_TIEBREAK",
        },
        {
          originalIndex: 1,
          duplicate: true,
          eligible: false,
          selected: false,
          rejectionReason: "DUPLICATE_ROUTE",
        },
        {
          originalIndex: 2,
          duplicate: false,
          eligible: true,
          selected: true,
          rejectionReason: null,
        },
        {
          originalIndex: 3,
          duplicate: false,
          eligible: false,
          selected: false,
          rejectionReason: "OVER_TIME_BUDGET",
        },
      ],
    );
    assert.equal(diagnostics[2].addedMinutes, 68);
    assert.equal(diagnostics[2].allowanceUtilisation, 0.8);
  });

  it("prefers substantially better utilisation within the three-point tolerance", () => {
    const result = selectRouteCandidate(
      [candidate(0, 3_600, 50), candidate(1, 4_680, 82), candidate(2, 6_480, 81)],
      60,
    );
    assert.equal(result.selected.originalIndex, 2);
  });

  it("lets an absolute-floor target route fulfil the explicit allowance", () => {
    const result = selectRouteCandidate(
      [candidate(0, 3_600, 50), candidate(1, 4_680, 82), candidate(2, 6_480, 74)],
      60,
    );
    assert.equal(result.selected.originalIndex, 2);
  });

  it("prefers +23 over +1 when quality is equivalent for a 30-minute budget", () => {
    const result = selectRouteCandidate(
      [candidate(0, 3_600, 50), candidate(1, 3_660, 80), candidate(2, 4_980, 79)],
      30,
    );
    assert.equal(result.selected.originalIndex, 2);
  });

  it("classifies measured extra-time utilisation without changing scores", () => {
    assert.equal(candidateBudgetUtilisation(3_600, 4_680, 60), 0.3);
    assert.equal(budgetUtilisationBand(0.3), "weak");
    assert.equal(budgetUtilisationBand(0.5), "acceptable");
    assert.equal(budgetUtilisationBand(0.7), "strong");
    assert.equal(budgetUtilisationBand(0.9), "near-full");
  });

  it("treats 75% as the named lower bound for target fulfilment", () => {
    assert.equal(MIN_TARGET_UTILISATION, 0.75);
    assert.equal(MIN_ACCEPTABLE_TARGET_SCORE, 60);
    assert.equal(TIME_TARGET_SCENIC_QUALITY_GUARDRAIL, 6);
  });

  it("selects +70 over +15 and +28 for an 85-minute target when quality is acceptable", () => {
    const result = selectRouteCandidate(
      [
        candidate(0, 3_600, 70),
        candidate(1, 4_500, 90),
        candidate(2, 5_280, 87),
        candidate(3, 7_800, 85),
      ],
      85,
    );
    assert.equal(result.selected.originalIndex, 3);
    assert.equal(result.measuredExtraTimeSeconds, 70 * 60);
    assert.equal(result.timeTargetOutcome, "TARGET_MET");
  });

  it("allows a slightly lower-scoring +70 route to beat a score-90 +15 route", () => {
    const result = selectRouteCandidate(
      [candidate(0, 3_600, 70), candidate(1, 4_500, 90), candidate(2, 7_800, 85)],
      85,
    );
    assert.equal(result.selected.originalIndex, 2);
  });

  it("uses the absolute floor rather than a relative target-band guardrail", () => {
    const result = selectRouteCandidate(
      [candidate(0, 3_600, 70), candidate(1, 4_500, 90), candidate(2, 7_800, 80)],
      85,
    );
    assert.equal(result.selected.originalIndex, 2);
    assert.equal(result.timeTargetOutcome, "TARGET_MET");
  });

  it("uses the best legitimate lower candidate when no target-band route exists", () => {
    const result = selectRouteCandidate(
      [candidate(0, 3_600, 70), candidate(1, 4_500, 88), candidate(2, 5_280, 85)],
      85,
    );
    assert.equal(result.selected.originalIndex, 2);
    assert.equal(result.timeTargetOutcome, "WEAK_ROUTE_SELECTED");
  });

  it("prefers +28 over a similarly scenic +10 route for a 30-minute target", () => {
    const result = selectRouteCandidate(
      [candidate(0, 3_600, 70), candidate(1, 4_200, 88), candidate(2, 5_280, 86)],
      30,
    );
    assert.equal(result.selected.originalIndex, 2);
    assert.equal(result.timeTargetOutcome, "TARGET_MET");
  });

  it("never selects a candidate one second beyond the hard maximum", () => {
    const result = selectRouteCandidate(
      [candidate(0, 3_600, 70), candidate(1, 8_700, 82), candidate(2, 8_701, 99)],
      85,
    );
    assert.equal(result.selected.originalIndex, 1);
    assert.ok(result.eligible.every((item) => item.directions.durationSeconds <= 8_700));
  });

  it("preserves candidate Scenic Scores while duration affects only winner selection", () => {
    const input = [candidate(0, 3_600, 70), candidate(1, 4_500, 90), candidate(2, 7_800, 85)];
    const scoresBefore = input.map((item) => item.scoreResult.total);
    const result = selectRouteCandidate(input, 85);
    assert.deepEqual(
      result.candidates.map((item) => item.scoreResult.total),
      scoresBefore,
    );
    assert.equal(result.selected.score, 85);
  });

  it("retains valid candidates discovered at earlier duration stages", () => {
    const input = [
      candidate(0, 3_600, 70),
      candidate(1, 4_500, 84),
      candidate(2, 5_280, 85),
      candidate(3, 7_800, 86),
    ];
    const result = selectRouteCandidate(input, 85);
    assert.deepEqual(
      result.candidates.map((item) => item.originalIndex),
      [0, 1, 2, 3],
    );
  });

  it("selects a safe +150 score-71 target over a +6 score-78 weak route", () => {
    const result = selectRouteCandidate(
      [
        candidate(0, 3_600, 78),
        candidate(1, 3_960, 78),
        candidate(2, 7_380, 71),
        candidate(3, 10_800, 71),
        candidate(4, 12_600, 71),
      ],
      150,
    );
    assert.equal(result.selected.originalIndex, 4);
    assert.equal(result.timeTargetOutcome, "TARGET_MET");
  });

  it("keeps +63 as a meaningful fallback when larger attempts fail", () => {
    const result = selectRouteCandidate(
      [candidate(0, 3_600, 78), candidate(1, 3_960, 78), candidate(2, 7_380, 71)],
      180,
    );
    assert.equal(result.selected.originalIndex, 2);
    assert.equal(result.timeTargetOutcome, "MEANINGFUL_FALLBACK");
  });

  it("rejects a sub-60 meaningful route and applies weak fallback policy", () => {
    const input = [candidate(0, 3_600, 78), candidate(1, 3_960, 78), candidate(2, 7_380, 59)];
    const result = selectRouteCandidate(input, 180);
    assert.equal(result.selected.originalIndex, 1);
    assert.equal(
      candidateSelectionDiagnostics(input, result, 180)[2].rejectionReason,
      "BELOW_ABSOLUTE_QUALITY_FLOOR",
    );
  });

  it("selects +63 for 80 and +24 for 30 despite a stronger +6 score", () => {
    assert.equal(
      selectRouteCandidate(
        [candidate(0, 3_600, 78), candidate(1, 3_960, 78), candidate(2, 7_380, 71)],
        80,
      ).selected.originalIndex,
      2,
    );
    assert.equal(
      selectRouteCandidate(
        [candidate(0, 3_600, 78), candidate(1, 3_960, 78), candidate(2, 5_040, 70)],
        30,
      ).selected.originalIndex,
      2,
    );
  });

  it("uses score within the target band and utilisation within the meaningful band", () => {
    const target = selectRouteCandidate(
      [candidate(0, 3_600, 78), candidate(1, 10_800, 75), candidate(2, 12_600, 72)],
      150,
    );
    assert.equal(target.selected.originalIndex, 1);
    const meaningful = selectRouteCandidate(
      [candidate(0, 3_600, 78), candidate(1, 7_380, 70), candidate(2, 9_000, 68)],
      180,
    );
    assert.equal(meaningful.selected.originalIndex, 2);
    assert.equal(meaningful.timeTargetOutcome, "MEANINGFUL_FALLBACK");
  });

  it("retains the six-point guardrail only for weak utilisation", () => {
    const input = [candidate(0, 3_600, 78), candidate(1, 3_960, 78), candidate(2, 6_600, 71)];
    const result = selectRouteCandidate(input, 180);
    assert.equal(result.selected.originalIndex, 1);
    assert.equal(
      candidateSelectionDiagnostics(input, result, 180)[2].rejectionReason,
      "BELOW_WEAK_QUALITY_GUARDRAIL",
    );
  });

  it("never selects an evidence-free explicit scenic candidate", () => {
    const evidenceFree = {
      ...candidate(1, 8_460, 90),
      source: "scenik" as const,
      evidence: {
        natural: 0,
        historic: 0,
        cultural: 0,
        coastal: 0,
        viewpoint: 0,
        wildlife: 0,
        food: 0,
        otherPoi: 0,
      },
    };
    const input = [candidate(0, 3_600, 70), evidenceFree];
    const result = selectRouteCandidate(input, 85);
    assert.equal(result.selected.originalIndex, 0);
    assert.equal(
      candidateSelectionDiagnostics(input, result, 85)[1].rejectionReason,
      "EVIDENCE_FREE_ROUTE",
    );
  });

  it("keeps unique and fully tied winners stable across complete input permutations", () => {
    const unique = [
      candidate(0, 3_600, 100, 9_000),
      candidate(1, 3_960, 99, 8_000),
      candidate(2, 7_380, 71, 12_000),
      candidate(3, 10_800, 75, 14_000),
      candidate(4, 12_600, 72, 13_000),
    ];
    const permutations = [
      unique,
      [...unique].reverse(),
      [unique[3], unique[1], unique[4], unique[0], unique[2]],
    ];
    assert.deepEqual(
      permutations.map((items) => selectRouteCandidate(items, 180).selected.originalIndex),
      [4, 4, 4],
    );

    const tied = [
      candidate(0, 3_600, 70, 9_000),
      candidate(7, 10_800, 75, 12_000),
      candidate(4, 10_800, 75, 12_000),
    ];
    assert.equal(selectRouteCandidate(tied, 150).selected.originalIndex, 4);
    assert.equal(selectRouteCandidate([...tied].reverse(), 150).selected.originalIndex, 4);
  });
});
