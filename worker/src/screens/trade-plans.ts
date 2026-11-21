import { BLACK, WHITE, bodyHeight, emptyBody, rule } from "./frame";
import { h, type Child, type Node } from "../render";

export interface TradePlan {
  id?: string;
  symbol: string;
  side: "long" | "short";
  status: "watching" | "open";
  entry: number;
  stop: number;
  target: number;
  last?: number;
  quantity: number;
  note?: string;
}

export interface TradePlansPayload {
  schema_version: 1;
  as_of: string;
  market_status?: "pre-market" | "open" | "after-hours" | "closed";
  currency?: string;
  plans: TradePlan[];
}

export interface PlanMetrics {
  /** Price the distance is measured from: last if known, else entry. */
  reference: number;
  referenceLabel: "last" | "entry";
  /** Price distance from reference to stop; <= 0 means the stop is hit or crossed. */
  distanceToStop: number;
  distanceToStopPct: number;
  /** Planned risk: |entry - stop| x quantity. */
  maxLoss: number;
  /** Reward-to-risk from entry. */
  rewardRisk: number;
}

export function planMetrics(p: TradePlan): PlanMetrics {
  const reference = p.last ?? p.entry;
  const distanceToStop = p.side === "long" ? reference - p.stop : p.stop - reference;
  const risk = Math.abs(p.entry - p.stop);
  const reward = Math.abs(p.target - p.entry);
  return {
    reference,
    referenceLabel: p.last === undefined ? "entry" : "last",
    distanceToStop,
    distanceToStopPct: (distanceToStop / reference) * 100,
    maxLoss: risk * p.quantity,
    rewardRisk: risk === 0 ? 0 : reward / risk,
  };
}

function money(value: number, currency: string): string {
  // Compact above 100k so the value fits its column: $1,234,567 -> $1.2M.
  const compact = Math.abs(value) >= 100_000;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    notation: compact ? "compact" : "standard",
    maximumFractionDigits: compact ? 1 : 0,
  }).format(value);
}

/** Two decimals up to 99,999.99; compact above that so it fits its column. */
export function price(value: number): string {
  if (Math.abs(value) < 100_000) return value.toFixed(2);
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function cell(label: string, value: string): Node {
  return h(
    { flexDirection: "column", flexGrow: 1, flexBasis: 0, overflow: "hidden" },
    h({ fontSize: 28, height: 34 }, label),
    h({ fontSize: 46, fontWeight: 700, height: 55 }, value),
  );
}

/** Text for the "To stop" line, and whether it is the inverted STOP HIT alarm. */
export function distanceLabel(p: TradePlan, m: PlanMetrics): { text: string; alarm: boolean } {
  if (m.distanceToStop > 0) {
    return {
      text: `${price(m.distanceToStop)} (${m.distanceToStopPct.toFixed(1)}%) from ${m.referenceLabel}`,
      alarm: false,
    };
  }
  // Only an open position can hit its stop. A plan still waiting for entry
  // just has the price on the far side of the stop: say so, without alarm.
  if (p.status === "open") return { text: "STOP HIT", alarm: true };
  return { text: `${m.referenceLabel} is ${p.side === "long" ? "below" : "above"} the stop`, alarm: false };
}

/** Height of one plan card including its top rule. */
export const CARD_H = 244;
const RULE_H = 4;
const SUMMARY_LINE_H = 41 + 6;
const MORE_LINE_H = RULE_H + 12 + 41;

/** How many plans fit in the body, leaving room for the "+ N more" line when needed. */
export function plansThatFit(total: number, bannerShown: boolean): number {
  const room = bodyHeight(bannerShown) - SUMMARY_LINE_H;
  const all = Math.floor(room / (CARD_H + RULE_H));
  if (total <= all) return total;
  return Math.max(1, Math.floor((room - MORE_LINE_H) / (CARD_H + RULE_H)));
}

function planCard(p: TradePlan, currency: string): Node {
  const m = planMetrics(p);
  const distance = distanceLabel(p, m);
  return h(
    { flexDirection: "column", paddingTop: 14, paddingBottom: 14, height: CARD_H, flexShrink: 0, overflow: "hidden" },
    h(
      { justifyContent: "space-between", alignItems: "flex-end", height: 66 },
      h(
        { alignItems: "flex-end" },
        // Long symbols get a smaller size so the row never runs into "Last".
        h({ fontSize: p.symbol.length > 6 ? 46 : 60, fontWeight: 700, lineHeight: 1 }, p.symbol),
        h(
          { fontSize: 32, fontWeight: 700, marginLeft: 20, marginBottom: 4 },
          `${p.side.toUpperCase()} · ${p.status.toUpperCase()}`,
        ),
      ),
      h({ fontSize: 34, fontWeight: 700, marginBottom: 4 }, p.last === undefined ? "Last n/a" : `Last ${price(p.last)}`),
    ),
    h(
      { marginTop: 10 },
      cell("Entry", price(p.entry)),
      cell("Stop", price(p.stop)),
      cell("Target", price(p.target)),
      cell("Max loss", money(m.maxLoss, currency)),
    ),
    h(
      { marginTop: 10, alignItems: "center", fontSize: 34, fontWeight: 700, height: 41 },
      h({ marginRight: 14 }, "To stop:"),
      distance.alarm ? h({ background: BLACK, color: WHITE, padding: "2px 14px" }, distance.text) : h({}, distance.text),
      h({ marginLeft: "auto", fontSize: 30 }, `R:R ${m.rewardRisk.toFixed(1)}`),
    ),
  );
}

export function tradePlansBody(payload: TradePlansPayload | null, bannerShown: boolean): Child {
  if (!payload) return emptyBody("Waiting for the trading producer");
  if (payload.plans.length === 0) return emptyBody("No open trade plans");
  const currency = payload.currency ?? "USD";
  // Open positions first, then plans still waiting for entry.
  const sorted = [...payload.plans].sort((a, b) => (a.status === b.status ? 0 : a.status === "open" ? -1 : 1));
  const shown = sorted.slice(0, plansThatFit(sorted.length, bannerShown));
  const hidden = sorted.length - shown.length;
  const open = payload.plans.filter((p) => p.status === "open");
  const openRisk = open.reduce((sum, p) => sum + planMetrics(p).maxLoss, 0);

  const children: Child[] = [
    h(
      { justifyContent: "space-between", fontSize: 34, fontWeight: 700, height: 41, marginBottom: 6, flexShrink: 0 },
      h({}, `${open.length} open · ${payload.plans.length - open.length} watching`),
      h({}, `Open risk ${money(openRisk, currency)}`),
    ),
  ];
  for (const p of shown) {
    children.push(rule(RULE_H));
    children.push(planCard(p, currency));
  }
  if (hidden > 0) {
    children.push(rule(RULE_H));
    children.push(h({ fontSize: 34, fontWeight: 700, marginTop: 12, height: 41, flexShrink: 0 }, `+ ${hidden} more not shown`));
  }
  return h({ flexDirection: "column" }, ...children);
}
