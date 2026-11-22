import { Validator, type OutputUnit } from "@cfworker/json-schema";
import { SOURCES, type SourceName } from "./config";

// @cfworker/json-schema validates without code generation, which Workers forbid.
const validators = new Map<SourceName, Validator>();

function validatorFor(source: SourceName): Validator {
  let v = validators.get(source);
  if (!v) {
    v = new Validator(SOURCES[source].schema as Record<string, unknown>, "2020-12", false);
    validators.set(source, v);
  }
  return v;
}

export interface ValidationResult {
  valid: boolean;
  errors: { path: string; message: string }[];
}

interface PlanPrices {
  side: "long" | "short";
  entry: number;
  stop: number;
  target: number;
}

/**
 * Rules JSON Schema can't express: prices must be ordered by side.
 * Long: stop < entry < target. Short: target < entry < stop.
 */
function semanticErrors(source: SourceName, payload: unknown): ValidationResult["errors"] {
  if (source !== "trade-plans") return [];
  const plans = (payload as { plans: PlanPrices[] }).plans;
  const errors: ValidationResult["errors"] = [];
  plans.forEach((p, i) => {
    const ok = p.side === "long" ? p.stop < p.entry && p.entry < p.target : p.target < p.entry && p.entry < p.stop;
    if (!ok) {
      errors.push({
        path: `#/plans/${i}`,
        message:
          p.side === "long"
            ? "long plan needs stop < entry < target"
            : "short plan needs target < entry < stop",
      });
    }
  });
  return errors.slice(0, 20);
}

// as_of before this is a producer bug, and New York time-zone math is undefined before 1883.
const EARLIEST_AS_OF_MS = Date.UTC(2000, 0, 1);

/**
 * Checks for every source. JSON.parse turns huge literals like 1e999 into
 * Infinity, which the schema accepts but KV stores as null.
 */
function genericErrors(payload: unknown): ValidationResult["errors"] {
  const errors: ValidationResult["errors"] = [];
  const walk = (v: unknown, path: string) => {
    if (typeof v === "number" && !Number.isFinite(v)) errors.push({ path, message: "number must be finite" });
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}/${i}`));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, `${path}/${k}`);
  };
  walk(payload, "#");
  const asOf = (payload as { as_of?: unknown }).as_of;
  if (typeof asOf === "string" && Date.parse(asOf) < EARLIEST_AS_OF_MS) {
    errors.push({ path: "#/as_of", message: "as_of must be on or after 2000-01-01" });
  }
  return errors;
}

export function validatePayload(source: SourceName, payload: unknown): ValidationResult {
  const result = validatorFor(source).validate(payload);
  if (result.valid) {
    const errors = [...genericErrors(payload), ...semanticErrors(source, payload)].slice(0, 20);
    return { valid: errors.length === 0, errors };
  }
  return {
    valid: result.valid,
    // Keep only the leaf errors; the parents just say "a child failed".
    errors: result.errors
      .filter((e: OutputUnit) => !/^(properties|items|\$ref|allOf)$/.test(e.keyword))
      .slice(0, 20)
      .map((e: OutputUnit) => ({ path: e.instanceLocation, message: e.error })),
  };
}
