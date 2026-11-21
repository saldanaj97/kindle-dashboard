import { describe, expect, it } from "vitest";
import { encodeGrayPng, readPngInfo, rgbaToGray } from "../src/png";

describe("encodeGrayPng", () => {
  it("writes a readable grayscale IHDR", async () => {
    const png = await encodeGrayPng(new Uint8Array(6 * 4).fill(128), 6, 4);
    expect(readPngInfo(png)).toEqual({ width: 6, height: 4, bitDepth: 8, colorType: 0 });
  });

  it("round-trips pixel data through inflate", async () => {
    const gray = Uint8Array.from([0, 64, 128, 255, 10, 20]);
    const png = await encodeGrayPng(gray, 3, 2);
    // Find the IDAT chunk and inflate it.
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    let off = 8;
    let idat: Uint8Array | null = null;
    while (off < png.length) {
      const len = view.getUint32(off);
      const type = String.fromCharCode(...png.subarray(off + 4, off + 8));
      if (type === "IDAT") idat = png.subarray(off + 8, off + 8 + len);
      off += 12 + len;
    }
    const stream = new Blob([idat!]).stream().pipeThrough(new DecompressionStream("deflate"));
    const raw = new Uint8Array(await new Response(stream).arrayBuffer());
    expect(raw.length).toBe(8);
    expect(Array.from(raw.subarray(1, 4))).toEqual([0, 64, 128]);
    expect(Array.from(raw.subarray(5, 8))).toEqual([255, 10, 20]);
  });

  it("rejects a buffer that does not match the dimensions", async () => {
    await expect(encodeGrayPng(new Uint8Array(5), 2, 2)).rejects.toThrow();
  });
});

describe("readPngInfo", () => {
  it("throws on non-PNG bytes", () => {
    expect(() => readPngInfo(new Uint8Array(64))).toThrow("not a PNG");
  });
});

describe("rgbaToGray", () => {
  it("composites fully transparent pixels to white", () => {
    expect(Array.from(rgbaToGray(Uint8Array.from([0, 0, 0, 0]), 1, 1))).toEqual([255]);
  });

  it("keeps opaque black and white", () => {
    const g = rgbaToGray(Uint8Array.from([0, 0, 0, 255, 255, 255, 255, 255]), 2, 1);
    expect(Array.from(g)).toEqual([0, 255]);
  });

  it("blends half-transparent black to mid gray", () => {
    const g = rgbaToGray(Uint8Array.from([0, 0, 0, 128]), 1, 1);
    expect(g[0]).toBeGreaterThan(120);
    expect(g[0]).toBeLessThan(135);
  });
});
