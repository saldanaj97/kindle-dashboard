import { satori } from "@cf-wasm/satori/workerd";
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm";
import regular from "@fontsource/atkinson-hyperlegible/files/atkinson-hyperlegible-latin-400-normal.woff";
import bold from "@fontsource/atkinson-hyperlegible/files/atkinson-hyperlegible-latin-700-normal.woff";
import { SCREEN_SIZE } from "./config";
import { encodeGrayPng, rgbaToGray } from "./png";

// Rendering: Satori lays out a small element tree and emits SVG; resvg
// rasterises it; the RGBA pixels become an 8-bit grayscale PNG.
// workerd cannot compile WebAssembly from bytes at runtime, so both wasm
// binaries are imported as modules (@cf-wasm/satori does this for Yoga).

export type Style = Record<string, string | number>;
export interface Node {
  type: string;
  props: { style?: Style; children?: Child | Child[] };
}
export type Child = Node | string | null | undefined | false;

/** Builds a Satori element. Every box is a flex container so Satori lays out children. */
export function h(style: Style, ...children: Child[]): Node {
  const kids = children.filter((c): c is Node | string => c !== null && c !== undefined && c !== false);
  return { type: "div", props: { style: { display: "flex", ...style }, children: kids } };
}

export const FONT = "Atkinson Hyperlegible";

/**
 * Runs `init` once and shares the result. If it fails, the cached promise is
 * dropped so the next call tries again instead of failing forever.
 */
export function onceWithRetry(init: () => Promise<void>): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => {
    pending ??= init().catch((err: unknown) => {
      pending = undefined;
      throw err;
    });
    return pending;
  };
}

const ensureResvg = onceWithRetry(() => initWasm(resvgWasm));

export async function renderPng(root: Node): Promise<Uint8Array> {
  await ensureResvg();
  const svg = await satori(root as never, {
    width: SCREEN_SIZE.width,
    height: SCREEN_SIZE.height,
    fonts: [
      { name: FONT, data: regular, weight: 400, style: "normal" },
      { name: FONT, data: bold, weight: 700, style: "normal" },
    ],
  });
  const resvg = new Resvg(svg, { background: "#ffffff" });
  try {
    const image = resvg.render();
    try {
      const gray = rgbaToGray(image.pixels, image.width, image.height);
      return await encodeGrayPng(gray, image.width, image.height);
    } finally {
      image.free();
    }
  } finally {
    resvg.free();
  }
}
