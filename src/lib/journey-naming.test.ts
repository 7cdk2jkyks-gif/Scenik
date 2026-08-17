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
      "One woodland discovery, two historic discoveries, and one cultural discovery shaped this journey.",
    );
  });
});
