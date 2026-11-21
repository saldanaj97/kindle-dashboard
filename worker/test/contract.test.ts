import { describe, expect, it } from "vitest";
import { SOURCES, type SourceName } from "../src/config";
import { validatePayload } from "../src/validate";
import { summaryExamplePayload, tradeExamplePayload } from "./helpers";

describe("contract examples", () => {
  it("trade-plans example is valid", () => {
    const r = validatePayload("trade-plans", tradeExamplePayload());
    expect(r.errors).toEqual([]);
    expect(r.valid).toBe(true);
  });

  it("market-summary example is valid", () => {
    const r = validatePayload("market-summary", summaryExamplePayload());
    expect(r.errors).toEqual([]);
    expect(r.valid).toBe(true);
  });
});

describe("every schema", () => {
  for (const source of Object.keys(SOURCES) as SourceName[]) {
    it(`${source} requires as_of`, () => {
      const schema = SOURCES[source].schema as { required?: string[] };
      expect(schema.required).toContain("as_of");
    });
  }
});

describe("trade-plans validation", () => {
  const bad = (mutate: (p: any) => void) => {
    const p = tradeExamplePayload();
    mutate(p);
    return validatePayload("trade-plans", p);
  };

  it("rejects a missing as_of", () => {
    const r = bad((p) => delete p.as_of);
    expect(r.valid).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it("rejects as_of without a timezone offset", () => {
    expect(bad((p) => (p.as_of = "2026-11-20T14:35:00")).valid).toBe(false);
  });

  it("rejects an as_of that is not a date", () => {
    expect(bad((p) => (p.as_of = "yesterday")).valid).toBe(false);
  });

  it("accepts as_of with a Z suffix", () => {
    expect(bad((p) => (p.as_of = "2026-11-20T19:35:00Z")).valid).toBe(true);
  });

  it("rejects an unknown top-level field", () => {
    expect(bad((p) => (p.surprise = 1)).valid).toBe(false);
  });

  it("rejects an unknown field on a plan", () => {
    expect(bad((p) => (p.plans[0].surprise = 1)).valid).toBe(false);
  });

  it("rejects a bad side enum", () => {
    const r = bad((p) => (p.plans[0].side = "sideways"));
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.path.includes("/plans/0"))).toBe(true);
  });

  it("rejects a negative price", () => {
    expect(bad((p) => (p.plans[0].entry = -1)).valid).toBe(false);
  });

  it("rejects a non-object payload", () => {
    expect(validatePayload("trade-plans", []).valid).toBe(false);
    expect(validatePayload("trade-plans", null).valid).toBe(false);
  });
});

describe("market-summary validation", () => {
  it("rejects a missing as_of", () => {
    const p = summaryExamplePayload();
    delete p.as_of;
    expect(validatePayload("market-summary", p).valid).toBe(false);
  });

  it("rejects an unknown extra field", () => {
    const p = summaryExamplePayload();
    p.surprise = true;
    expect(validatePayload("market-summary", p).valid).toBe(false);
  });
});
