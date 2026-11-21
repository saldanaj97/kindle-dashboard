import { BLACK, CONTENT_WIDTH, bodyHeight, boldTextWidth, emptyBody, estimateLines, rule } from "./frame";
import { h, type Child, type Node } from "../render";

export interface MarketSummaryPayload {
  schema_version: 1;
  as_of: string;
  market_status?: "pre-market" | "open" | "after-hours" | "closed";
  session: "pre-market" | "end-of-day";
  headline: string;
  points: string[];
  indices?: { symbol: string; last?: number; change_pct: number }[];
  plans?: { watching?: number; open?: number; closed_today?: number };
  watch?: string[];
}

/** "+0.12%", "-0.08%"; no sign when the value rounds to zero ("0.00%"). */
export function signed(pct: number): string {
  const text = Math.abs(pct).toFixed(2);
  if (Number(text) === 0) return `${text}%`;
  return `${pct > 0 ? "+" : "-"}${text}%`;
}

function indexBox(i: { symbol: string; last?: number; change_pct: number }): Node {
  return h(
    {
      flexDirection: "column",
      flexGrow: 1,
      flexBasis: 0,
      border: `5px solid ${BLACK}`,
      padding: "10px 12px",
      marginRight: 16,
      overflow: "hidden",
    },
    h({ fontSize: 32, fontWeight: 700, height: 38 }, i.symbol),
    h({ fontSize: 44, fontWeight: 700, height: 53 }, signed(i.change_pct)),
    h({ fontSize: 28, height: 34 }, i.last === undefined ? " " : i.last.toFixed(2)),
  );
}

export function sessionLabel(session: MarketSummaryPayload["session"]): string {
  return session === "pre-market" ? "Pre-market" : "End of day";
}

// Layout sizes. Heights are fixed so the body can budget space exactly.
const LABEL_H = 41;
const HEADLINE_SIZE = 54;
const HEADLINE_LINE_H = 62;
const INDICES_H = 5 * 2 + 10 * 2 + 38 + 53 + 34 + 20; // border, padding, rows, margin
const POINT_SIZE = 36;
const POINT_LINE_H = 47;
const POINT_GAP = 10;
const BULLET_W = 36;
const FOOTER_LINE_H = 41 + 6;
const MORE_LINE_H = POINT_GAP + POINT_LINE_H;
const FOOTER_SIZE = 34;

function watchLine(shown: string[], hidden: number): string {
  return `Watch: ${shown.join("  ")}${hidden ? `  +${hidden}` : ""}`;
}

export interface SummaryLayout {
  headlineLines: number;
  pointsShown: number;
  pointsHidden: number;
  watchShown: string[];
  watchHidden: number;
}

/** Decides what fits: points that don't fit become a "+ N more" line, and the footer always stays. */
export function summaryLayout(payload: MarketSummaryPayload, bannerShown: boolean): SummaryLayout {
  const watch = payload.watch ?? [];
  // Watch symbols on one line: as many as fit, then "+N".
  const watchShown: string[] = [];
  for (const sym of watch) {
    const next = [...watchShown, sym];
    const rest = watch.length - next.length;
    if (boldTextWidth(watchLine(next, rest), FOOTER_SIZE) > CONTENT_WIDTH) break;
    watchShown.push(sym);
  }
  const footerLines = (watch.length ? 1 : 0) + (payload.plans ? 1 : 0);
  const footerH = footerLines ? 4 + 6 + footerLines * FOOTER_LINE_H : 0;

  const headlineLines = Math.min(3, estimateLines(payload.headline, HEADLINE_SIZE, CONTENT_WIDTH, 0.58));
  let room =
    bodyHeight(bannerShown) -
    footerH -
    LABEL_H -
    (6 + headlineLines * HEADLINE_LINE_H + 20) -
    (payload.indices?.length ? INDICES_H : 0) -
    (4 + 12); // rule and gap above the points

  const heights = payload.points.map(
    (p) => POINT_GAP + estimateLines(p, POINT_SIZE, CONTENT_WIDTH - BULLET_W, 0.5) * POINT_LINE_H,
  );
  let shown = 0;
  for (let i = 0; i < heights.length; i++) {
    const needMore = i + 1 < heights.length;
    if (heights[i]! + (needMore ? MORE_LINE_H : 0) > room) break;
    room -= heights[i]!;
    shown++;
  }
  return {
    headlineLines,
    pointsShown: shown,
    pointsHidden: payload.points.length - shown,
    watchShown,
    watchHidden: watch.length - watchShown.length,
  };
}

export function marketSummaryBody(payload: MarketSummaryPayload | null, bannerShown: boolean): Child {
  if (!payload) return emptyBody("Waiting for the summary producer");
  const layout = summaryLayout(payload, bannerShown);

  const main: Child[] = [
    h({ fontSize: 34, fontWeight: 700, height: LABEL_H, flexShrink: 0 }, sessionLabel(payload.session).toUpperCase()),
    h(
      {
        fontSize: HEADLINE_SIZE,
        fontWeight: 700,
        lineHeight: `${HEADLINE_LINE_H}px`,
        height: layout.headlineLines * HEADLINE_LINE_H,
        marginTop: 6,
        marginBottom: 20,
        overflow: "hidden",
        flexShrink: 0,
      },
      payload.headline,
    ),
  ];
  if (payload.indices?.length) {
    main.push(h({ marginBottom: 20, marginRight: -16, flexShrink: 0 }, ...payload.indices.map(indexBox)));
  }
  main.push(rule(4));
  const points: Child[] = payload.points.slice(0, layout.pointsShown).map((p) =>
    h(
      { fontSize: POINT_SIZE, lineHeight: `${POINT_LINE_H}px`, marginTop: POINT_GAP, flexShrink: 0 },
      h({ fontWeight: 700, width: BULLET_W, flexShrink: 0 }, "•"),
      h({ flexGrow: 1, flexShrink: 1, flexBasis: 0 }, p),
    ),
  );
  if (layout.pointsHidden > 0) {
    points.push(
      h(
        { fontSize: POINT_SIZE, fontWeight: 700, lineHeight: `${POINT_LINE_H}px`, marginTop: POINT_GAP, flexShrink: 0 },
        `+ ${layout.pointsHidden} more not shown`,
      ),
    );
  }
  main.push(h({ flexDirection: "column", marginTop: 12 }, ...points));

  const footer: string[] = [];
  if (payload.watch?.length) {
    footer.push(watchLine(layout.watchShown, layout.watchHidden));
  }
  if (payload.plans) {
    const { watching = 0, open = 0, closed_today = 0 } = payload.plans;
    footer.push(`Plans: ${open} open · ${watching} watching · ${closed_today} closed`);
  }

  return h(
    { flexDirection: "column", height: "100%" },
    // Main content may be cut by the budget above, never the footer.
    h({ flexDirection: "column", flexGrow: 1, flexShrink: 1, overflow: "hidden" }, ...main),
    footer.length
      ? h(
          { flexDirection: "column", flexShrink: 0 },
          rule(4),
          h(
            { flexDirection: "column", marginTop: 6 },
            ...footer.map((line) =>
              h({ fontSize: FOOTER_SIZE, fontWeight: 700, height: 41, marginTop: 6, overflow: "hidden" }, line),
            ),
          ),
        )
      : null,
  );
}
