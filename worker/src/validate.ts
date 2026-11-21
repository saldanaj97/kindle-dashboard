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

export function validatePayload(source: SourceName, payload: unknown): ValidationResult {
  const result = validatorFor(source).validate(payload);
  if (result.valid) {
    const errors = semanticErrors(source, payload);
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
