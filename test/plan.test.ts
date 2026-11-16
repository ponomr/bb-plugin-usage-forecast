import { describe, expect, it } from "vitest";
import { planMultiplier, planText } from "../src/shared/plan";

describe("planText", () => {
  it("joins a multiplier above 1 to the plan name (AE1)", () => {
    expect(planText("Max", 5)).toBe("Max 5×");
    expect(planText("Max", 20)).toBe("Max 20×");
  });

  it("keeps one decimal of a fractional multiplier", () => {
    expect(planText("Pro", 1.5)).toBe("Pro 1.5×");
    expect(planText("Pro", 2.25)).toBe("Pro 2.3×");
    expect(planText("Pro", 2.02)).toBe("Pro 2×");
  });

  it("shows the plan name alone without a usable multiplier (AE2)", () => {
    expect(planText("Plus", null)).toBe("Plus");
    expect(planText("Plus", 1)).toBe("Plus");
    expect(planText("Plus", 0)).toBe("Plus");
    expect(planText("Plus", -3)).toBe("Plus");
    expect(planText("Plus", Number.NaN)).toBe("Plus");
    expect(planText("Plus", Number.POSITIVE_INFINITY)).toBe("Plus");
  });

  it("adds nothing to a name that already has a multiplier", () => {
    expect(planText("Max 20x", 20)).toBe("Max 20x");
    expect(planText("Pro 5×", 5)).toBe("Pro 5×");
    expect(planText("Max 5 X", 5)).toBe("Max 5 X");
  });

  it("is null without a plan name, even with a multiplier", () => {
    expect(planText(null, 5)).toBeNull();
    expect(planText("", 5)).toBeNull();
    expect(planText(null, null)).toBeNull();
  });
});

describe("planMultiplier", () => {
  it("reads a finite number above 1 from the host's plan object", () => {
    expect(planMultiplier({ id: "max", multiplier: 5 })).toBe(5);
    expect(planMultiplier({ multiplier: 1.5 })).toBe(1.5);
  });

  it("is null for every other shape", () => {
    for (const plan of [
      undefined,
      null,
      "max",
      5,
      [],
      [5],
      {},
      { id: "max", multiplier: null },
      { multiplier: 1 },
      { multiplier: 0 },
      { multiplier: -2 },
      { multiplier: "abc" },
      { multiplier: "5" },
      { multiplier: Number.NaN },
      { multiplier: Number.POSITIVE_INFINITY },
    ]) {
      expect(planMultiplier(plan)).toBeNull();
    }
  });
});
