import { describe, expect, it } from 'vitest';
import { ImageEncoder, PageColorType, type ImageSource } from '@mmote/niimbluelib';
import { getPixel, type LabelBitmap, type RawImageData } from '@mbtech-nl/bitmap';

import { DEVICES, MEDIA } from '../devices';
import { rasterizeForHead, resample } from '../raster';

const ENGINE = DEVICES.D110.engines[0];

/** White RGBA canvas with an optional black rectangle. */
function canvas(
  width: number,
  height: number,
  black?: { x: number; y: number; w: number; h: number },
): RawImageData {
  const data = new Uint8Array(width * height * 4).fill(255);
  if (black) {
    for (let y = black.y; y < black.y + black.h; y += 1) {
      for (let x = black.x; x < black.x + black.w; x += 1) {
        const i = (y * width + x) * 4;
        data[i] = 0;
        data[i + 1] = 0;
        data[i + 2] = 0;
      }
    }
  }
  return { width, height, data };
}

function blackCount(bitmap: LabelBitmap): number {
  let n = 0;
  for (let y = 0; y < bitmap.heightPx; y += 1) {
    for (let x = 0; x < bitmap.widthPx; x += 1) if (getPixel(bitmap, x, y)) n += 1;
  }
  return n;
}

/** Mirrors niimbluelib's `CanvasImageSource` pixel addressing, over a 1bpp bitmap. */
function sourceOf(bitmap: LabelBitmap): ImageSource {
  return {
    width: bitmap.widthPx,
    height: bitmap.heightPx,
    getPixelColor(x, y, dir) {
      const [px, py] = dir === 'left' ? [y, bitmap.heightPx - 1 - x] : [x, y];
      return getPixel(bitmap, px, py) ? 0 : 0xffffff;
    },
  };
}

describe('rasterizeForHead', () => {
  it('scales a 300 dpi 40×12 mm design to the 96-dot head and rotates it', () => {
    // 40 × 12 mm at 300 dpi
    const { visual, head } = rasterizeForHead(canvas(472, 142), ENGINE, MEDIA['niimbot-12x40']);
    expect(visual.heightPx).toBe(96);
    expect(visual.widthPx).toBe(319);
    expect(head.widthPx).toBe(96);
    expect(head.heightPx).toBe(319);
  });

  it('produces the same encoding niimbluelib gets from printDirection "left"', () => {
    const image = canvas(320, 96, { x: 10, y: 5, w: 40, h: 20 });
    const { visual, head } = rasterizeForHead(image, ENGINE, MEDIA['niimbot-12x40']);
    const viaLib = ImageEncoder.encode(sourceOf(visual), PageColorType.SingleColor, 'left');
    const viaUs = ImageEncoder.encode(sourceOf(head), PageColorType.SingleColor, 'top');
    expect(viaUs).toEqual(viaLib);
  });

  it('keeps portrait input unrotated with its width across the head', () => {
    const { visual, head } = rasterizeForHead(canvas(96, 320), ENGINE, MEDIA['niimbot-12x40']);
    expect(head).toBe(visual);
    expect(head.widthPx).toBe(96);
  });

  it('crops the centred 12 mm band out of a 15 mm roll', () => {
    // 50 × 15 mm at 203 dpi = 400 × 120; black band only in the outer 12 dots each side
    const image = canvas(400, 120, { x: 0, y: 0, w: 400, h: 12 });
    const { visual } = rasterizeForHead(image, ENGINE, MEDIA['niimbot-15x50']);
    expect(visual.heightPx).toBe(96);
    expect(blackCount(visual)).toBe(0);
  });

  it('pads media narrower than the head, centred', () => {
    const narrow = { ...MEDIA['niimbot-12x40']!, widthMm: 10 };
    const { visual } = rasterizeForHead(
      canvas(200, 80, { x: 0, y: 0, w: 200, h: 80 }),
      ENGINE,
      narrow,
    );
    expect(visual.heightPx).toBe(96);
    expect(getPixel(visual, 5, 7)).toBe(false);
    expect(getPixel(visual, 5, 8)).toBe(true);
    expect(getPixel(visual, 5, 87)).toBe(true);
    expect(getPixel(visual, 5, 88)).toBe(false);
  });

  it('falls back to the full head width without media', () => {
    expect(rasterizeForHead(canvas(200, 50), ENGINE).visual.heightPx).toBe(96);
  });
});

describe('resample', () => {
  it('box-averages on downscale', () => {
    const image = canvas(2, 1, { x: 0, y: 0, w: 1, h: 1 });
    const out = resample(image, 0.5);
    expect(out.width).toBe(1);
    expect(out.data[0]).toBe(128);
  });

  it('returns the input untouched at factor 1', () => {
    const image = canvas(4, 4);
    expect(resample(image, 1)).toBe(image);
  });
});
