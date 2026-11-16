import { describe, expect, it } from "vitest";
import { isHidden, joinHiddenProviders, parseHiddenProviders } from "../src/shared/hidden-providers";

describe("parseHiddenProviders", () => {
  it("is empty for an empty or missing value and for anything but a string", () => {
    expect(parseHiddenProviders("")).toEqual([]);
    expect(parseHiddenProviders("  ,, ")).toEqual([]);
    expect(parseHiddenProviders(undefined)).toEqual([]);
    expect(parseHiddenProviders(null)).toEqual([]);
    expect(parseHiddenProviders(5)).toEqual([]);
    expect(parseHiddenProviders(["codex"])).toEqual([]);
  });

  it("splits on commas and whitespace, trims and lower-cases (AE7)", () => {
    expect(parseHiddenProviders(" Codex ,, nope")).toEqual(["codex", "nope"]);
    expect(parseHiddenProviders("acp-opencode, codex")).toEqual(["acp-opencode", "codex"]);
    expect(parseHiddenProviders("acp-opencode codex\n\tclaude-code")).toEqual(["acp-opencode", "codex", "claude-code"]);
  });

  it("keeps each id once", () => {
    expect(parseHiddenProviders("codex, CODEX codex")).toEqual(["codex"]);
  });
});

describe("isHidden", () => {
  it("matches the parsed ids only; an unknown id matches nothing (AE7)", () => {
    const hidden = parseHiddenProviders(" Codex ,, nope");
    expect(isHidden(hidden, "codex")).toBe(true);
    expect(isHidden(hidden, "claude-code")).toBe(false);
    expect(isHidden([], "codex")).toBe(false);
  });
});

describe("joinHiddenProviders", () => {
  it("writes the ids the way the parser reads them", () => {
    const ids = ["acp-opencode", "codex"];
    expect(joinHiddenProviders(ids)).toBe("acp-opencode, codex");
    expect(parseHiddenProviders(joinHiddenProviders(ids))).toEqual(ids);
  });
});
