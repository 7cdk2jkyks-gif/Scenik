import { describe, expect, test } from "bun:test";
import { journeyEvidenceLine, journeyTitle } from "./journey-naming";

describe("journeyTitle", () => {
  test("selects deterministic titles from verified dominant evidence", () => {
    const input = {
      evidence: { natural: 4, historic: 1 },
      themes: ["Forest"],
      discoveries: [{ category: "Woodland" }],
    };
    expect(journeyTitle(input)).toBe("Woodland Escape");
    expect(journeyTitle(input)).toBe("Woodland Escape");
  });

  test("uses a safe fallback when no verified evidence supports a claim", () => {
    expect(journeyTitle({ themes: ["Forest"], evidence: {} })).toBe("The Scenic Journey");
  });

  test("does not put an unsupported selected theme into the title", () => {
    expect(
      journeyTitle({
        themes: ["Coastal"],
        evidence: { historic: 3, coastal: 0 },
        discoveries: [{ category: "History museum" }],
      }),
    ).toBe("Heritage Run");
  });

  test("uses a mixed title when verified families are equally strong", () => {
    expect(journeyTitle({ evidence: { historic: 2, viewpoint: 2 } })).toBe("Discovery Drive");
  });
});

describe("journeyEvidenceLine", () => {
  test("mentions only supported evidence families", () => {
    expect(
      journeyEvidenceLine({
        evidence: { coastal: 2 },
        themes: ["Forest"],
        discoveries: [{ category: "Lake" }],
      }),
    ).toBe("One waterside discovery shaped this journey.");
  });

  test("uses verified discovery categories and counts when available", () => {
    expect(
      journeyEvidenceLine({
        evidence: { natural: 4 },
        discoveries: [{ category: "Woodland" }, { category: "Forest" }],
      }),
    ).toBe("Two woodland discoveries shaped this journey.");
  });

  test("uses deterministic British list grammar and mid-sentence casing", () => {
    expect(
      journeyEvidenceLine({
        discoveries: [
          { category: "Park" },
          { category: "Nature reserve" },
          { category: "Woodland" },
          { category: "Historic place" },
          { category: "Castle" },
          { category: "Art gallery" },
        ],
      }),
    ).toBe(
      "One woodland discovery, two natural discoveries, two historic discoveries, and one cultural discovery shaped this journey.",
    );
  });

  test("counts every discovery once across all families in stable order", () => {
    const discoveries = [
      { category: "Forest" },
      { category: "Park" },
      { category: "Historic museum" },
      { category: "River" },
      { category: "Scenic viewpoint" },
      { category: "Art gallery" },
      { category: "Planetarium" },
    ];
    const expected =
      "One woodland discovery, one natural discovery, one historic discovery, one waterside discovery, one viewpoint discovery, one cultural discovery, and one other discovery shaped this journey.";
    expect(journeyEvidenceLine({ discoveries })).toBe(expected);
    expect(journeyEvidenceLine({ discoveries: [...discoveries].reverse() })).toBe(expected);
  });

  test("uses deterministic first-match classification for a multi-matching category", () => {
    expect(
      journeyEvidenceLine({ discoveries: [{ category: "Woodland nature reserve museum" }] }),
    ).toBe("One woodland discovery shaped this journey.");
  });

  test("counts a missing legacy category in the friendly fallback family", () => {
    expect(journeyEvidenceLine({ discoveries: [{}] })).toBe(
      "One other discovery shaped this journey.",
    );
  });

  test("preserves one-family, two-family and three-family grammar", () => {
    expect(journeyEvidenceLine({ discoveries: [{ category: "Unknown legacy category" }] })).toBe(
      "One other discovery shaped this journey.",
    );
    expect(
      journeyEvidenceLine({ discoveries: [{ category: "Forest" }, { category: "Castle" }] }),
    ).toBe("One woodland discovery and one historic discovery shaped this journey.");
    expect(
      journeyEvidenceLine({
        discoveries: [{ category: "Forest" }, { category: "Castle" }, { category: "Lake" }],
      }),
    ).toBe(
      "One woodland discovery, one historic discovery, and one waterside discovery shaped this journey.",
    );
  });

  test("accounts for the fourteen-item Production-shaped fixture", () => {
    const discoveries = [
      ...Array.from({ length: 4 }, () => ({ category: "Woodland" })),
      { category: "Historic place" },
      ...Array.from({ length: 3 }, () => ({ category: "Waterside" })),
      ...Array.from({ length: 6 }, () => ({ category: "legacy_verified_type" })),
    ];
    expect(discoveries).toHaveLength(14);
    expect(journeyEvidenceLine({ discoveries })).toBe(
      "4 woodland discoveries, one historic discovery, three waterside discoveries, and 6 other discoveries shaped this journey.",
    );
  });

  test("uses only the supplied final timeline and retains the empty fallback", () => {
    const fullTimeline = Array.from({ length: 8 }, () => ({ category: "Park" }));
    expect(journeyEvidenceLine({ discoveries: fullTimeline })).toBe(
      "8 natural discoveries shaped this journey.",
    );
    expect(journeyEvidenceLine({ discoveries: fullTimeline.slice(0, 4) })).toBe(
      "4 natural discoveries shaped this journey.",
    );
    expect(journeyEvidenceLine({ discoveries: [] })).toBe(
      "Measured road variety shaped this journey.",
    );
  });
});
