import { describeClosed, describeReason, formatDuration, type Freshness } from "../freshness";
import { SCREEN_SIZE } from "../config";
import { FONT, h, type Child, type Node } from "../render";

// E-ink rules for every screen: pure black on white, large type, no thin
// or gray lines. Rules are at least 4 px thick.
export const BLACK = "#000000";
export const WHITE = "#ffffff";
export const PAD = 48;

export function formatTime(iso: string | undefined, timeZone: string): string {
  if (!iso) return "never";
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "unknown";
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(t);
}

// Fixed heights, so each screen body knows exactly how much room it has and
// can show "+ N more" rather than clipping. See bodyHeight().
const PAD_TOP = PAD - 8;
const PAD_BOTTOM = PAD - 16;
const TITLE_H = 88;
const DATA_LINE_H = 44;
const DATA_LINE_MARGINS = 8 + 16;
const HEADER_RULE = 8;
const BANNER_MARGIN = 20;
const BANNER_H = 112;
const BODY_MARGIN = 20;
const FOOTER_H = 4 + 12 + 30;

/** Height in px available to a screen body. */
export function bodyHeight(bannerShown: boolean): number {
  return (
    SCREEN_SIZE.height -
    PAD_TOP -
    PAD_BOTTOM -
    TITLE_H -
    DATA_LINE_H -
    DATA_LINE_MARGINS -
    HEADER_RULE -
    (bannerShown ? BANNER_MARGIN + BANNER_H : 0) -
    BODY_MARGIN -
    FOOTER_H
  );
}

/** Usable width in px inside the screen padding. */
export const CONTENT_WIDTH = SCREEN_SIZE.width - 2 * PAD;

/**
 * Conservative line count for wrapped text. `em` is the assumed average
 * glyph width as a fraction of the font size (Atkinson Hyperlegible runs
 * about 0.5 regular and 0.55 bold; the defaults leave headroom).
 */
export function estimateLines(text: string, fontSize: number, width: number, em = 0.56): number {
  const perLine = Math.max(1, Math.floor(width / (fontSize * em)));
  // Greedy word wrap, so long words push to the next line as Satori does.
  let lines = 1;
  let used = 0;
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const len = word.length;
    if (used === 0) {
      used = len;
    } else if (used + 1 + len <= perLine) {
      used += 1 + len;
    } else {
      lines += 1;
      used = len;
    }
    while (used > perLine) {
      lines += 1;
      used -= perLine;
    }
  }
  return lines;
}

/**
 * Rough rendered width in px of one line of bold text, erring wide. Used
 * where a line must not wrap, such as a footer list of symbols.
 */
export function boldTextWidth(text: string, fontSize: number): number {
  let em = 0;
  for (const ch of text) {
    if (ch === "W" || ch === "M") em += 0.98;
    else if (/[A-Z]/.test(ch)) em += 0.72;
    else if (/[0-9]/.test(ch)) em += 0.62;
    else if (/[a-z]/.test(ch)) em += 0.58;
    else if (ch === " ") em += 0.3;
    else em += 0.45;
  }
  return em * fontSize;
}

export function rule(thickness = 6): Node {
  return h({ width: "100%", height: thickness, background: BLACK, flexShrink: 0 });
}

export interface FrameInput {
  title: string;
  asOf: string | undefined;
  freshness: Freshness;
  now: Date;
  timeZone: string;
  /** Show the market-closed notice when the market is closed. */
  marketNotice: boolean;
  body: Child;
}

/** Quieter than STALE: black outline, not inverted, beside the title. */
function marketClosedNotice(detail: string): Node {
  return h(
    {
      flexDirection: "column",
      alignItems: "flex-end",
      border: `5px solid ${BLACK}`,
      padding: "4px 16px",
      flexShrink: 0,
    },
    h({ fontSize: 30, fontWeight: 700 }, "MARKET CLOSED"),
    h({ fontSize: 24 }, detail),
  );
}

/** Header with the data time, the stale banner when needed, the body, and a footer. */
export function frame({ title, asOf, freshness, now, timeZone, marketNotice, body }: FrameInput): Node {
  const age =
    freshness.ageSeconds === null || freshness.ageSeconds < 0
      ? ""
      : freshness.ageSeconds < 60
        ? " (just now)"
        : ` (${formatDuration(freshness.ageSeconds)} ago)`;
  return h(
    {
      flexDirection: "column",
      width: "100%",
      height: "100%",
      background: WHITE,
      color: BLACK,
      fontFamily: FONT,
      padding: `${PAD_TOP}px ${PAD}px ${PAD_BOTTOM}px`,
    },
    h(
      { justifyContent: "space-between", alignItems: "center", height: TITLE_H, flexShrink: 0 },
      h({ fontSize: 68, fontWeight: 700, lineHeight: 1.1 }, title.toUpperCase()),
      marketNotice && freshness.marketClosed ? marketClosedNotice(describeClosed(freshness.marketClosed)) : null,
    ),
    h(
      { fontSize: 36, fontWeight: 700, height: DATA_LINE_H, marginTop: 8, marginBottom: 16, flexShrink: 0 },
      `Data as of ${formatTime(asOf, timeZone)}${age}`,
    ),
    rule(HEADER_RULE),
    freshness.stale
      ? h(
          {
            flexDirection: "column",
            background: BLACK,
            color: WHITE,
            justifyContent: "center",
            padding: "0 28px",
            height: BANNER_H,
            marginTop: BANNER_MARGIN,
            flexShrink: 0,
            overflow: "hidden",
          },
          h({ fontSize: 44, fontWeight: 700, lineHeight: 1.1 }, "STALE"),
          // Only one data problem applies at a time (see evaluateFreshness).
          ...freshness.reasons
            .slice(0, 1)
            .map((r) => h({ fontSize: 32, fontWeight: 700, marginTop: 6, lineHeight: 1.1 }, describeReason(r))),
        )
      : null,
    h(
      {
        flexDirection: "column",
        height: bodyHeight(freshness.stale),
        flexShrink: 0,
        overflow: "hidden",
        marginTop: BODY_MARGIN,
      },
      body,
    ),
    h({ flexGrow: 1 }),
    rule(4),
    h(
      { justifyContent: "space-between", fontSize: 26, height: 30, marginTop: 12, flexShrink: 0 },
      h({}, `Rendered ${formatTime(now.toISOString(), timeZone)}`),
      h({}, "Display only"),
    ),
  );
}

export function emptyBody(message: string): Node {
  return h(
    { flexGrow: 1, alignItems: "center", justifyContent: "center", fontSize: 48, fontWeight: 700 },
    message,
  );
}
