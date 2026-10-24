import {
  cropBitmap,
  padBitmap,
  renderImage,
  rotateBitmap,
  type LabelBitmap,
  type RawImageData,
} from '@mbtech-nl/bitmap';
import type { MediaDescriptor, PrintEngine } from '@thermal-label/contracts';

/**
 * Hard threshold rather than dithering — niimblue's default (140). On a
 * 96-dot head, dithered anti-aliasing from the 300 → 203 dpi resample
 * turns text edges into speckle.
 */
const THRESHOLD = 140;

export interface NiimbotRaster {
  /** Visual orientation (as designed), scaled to the head's dpi and fitted to its width. */
  visual: LabelBitmap;
  /** Head orientation: `widthPx === engine.headDots`, rows run along the feed. */
  head: LabelBitmap;
}

/**
 * Turn a full-colour design render into the 1bpp bitmap a Niimbot head
 * prints.
 *
 * The design arrives at the document's DPI (300 by default), not the
 * printer's, so it is resampled until the axis that runs across the
 * head matches the media width at `engine.dpi`. Landscape input is the
 * horizontal-tape case: its height runs across the head and it is
 * rotated 90° clockwise — the same transform niimbluelib applies for
 * `printDirection: 'left'`. Portrait input already has its width
 * across the head.
 *
 * The cross-head axis is then centred onto exactly `headDots`: padded
 * when the media is narrower than the head, cropped when it is wider
 * (15 mm rolls on the 12 mm D110 head).
 */
export function rasterizeForHead(
  image: RawImageData,
  engine: Pick<PrintEngine, 'dpi' | 'headDots'>,
  media?: MediaDescriptor,
): NiimbotRaster {
  const landscape = image.width > image.height;
  const crossPx = landscape ? image.height : image.width;
  const targetCross = media ? Math.round((media.widthMm * engine.dpi) / 25.4) : engine.headDots;
  const scaled = resample(image, targetCross / crossPx);
  const bitmap = renderImage(scaled, { threshold: THRESHOLD });
  const visual = fitCross(bitmap, engine.headDots, landscape);
  const head = landscape ? rotateBitmap(visual, 90) : visual;
  return { visual, head };
}

function fitCross(bitmap: LabelBitmap, headDots: number, landscape: boolean): LabelBitmap {
  const cross = landscape ? bitmap.heightPx : bitmap.widthPx;
  if (cross === headDots) return bitmap;
  if (cross > headDots) {
    const offset = Math.floor((cross - headDots) / 2);
    return landscape
      ? cropBitmap(bitmap, 0, offset, bitmap.widthPx, headDots)
      : cropBitmap(bitmap, offset, 0, headDots, bitmap.heightPx);
  }
  const before = Math.floor((headDots - cross) / 2);
  const after = headDots - cross - before;
  return landscape
    ? padBitmap(bitmap, { top: before, bottom: after })
    : padBitmap(bitmap, { left: before, right: after });
}

/**
 * Resample RGBA by `factor`. Downscaling averages every source pixel
 * under each destination pixel (box filter) so thin strokes survive
 * the 300 → 203 dpi drop; upscaling uses nearest-neighbour.
 */
export function resample(image: RawImageData, factor: number): RawImageData {
  const width = Math.max(1, Math.round(image.width * factor));
  const height = Math.max(1, Math.round(image.height * factor));
  if (width === image.width && height === image.height) return image;

  const src = image.data;
  const out = new Uint8Array(width * height * 4);
  const sx = image.width / width;
  const sy = image.height / height;

  for (let y = 0; y < height; y += 1) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.min(image.height, Math.floor((y + 1) * sy)));
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.min(image.width, Math.floor((x + 1) * sx)));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let yy = y0; yy < y1; yy += 1) {
        for (let xx = x0; xx < x1; xx += 1) {
          const i = (yy * image.width + xx) * 4;
          r += src[i]!;
          g += src[i + 1]!;
          b += src[i + 2]!;
          a += src[i + 3]!;
        }
      }
      const n = (y1 - y0) * (x1 - x0);
      const o = (y * width + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
    }
  }
  return { width, height, data: out };
}
