import Konva from 'konva';
import type { TextObject } from '@burnmark-io/designer-core';
import { textYCorrectionFor, textBlockAlignOffsetY } from './text-layout';

/** Canvas `font` style for a text object (mirrors what the Konva node gets). */
export function textFontStyle(object: Pick<TextObject, 'fontStyle' | 'fontWeight'>): string {
  const parts: string[] = [];
  if (object.fontStyle === 'italic') parts.push('italic');
  if (object.fontWeight === 'bold') parts.push('bold');
  return parts.length === 0 ? 'normal' : parts.join(' ');
}

/**
 * Laid-out height of `text` at `object`'s font/width/wrap, measured with a
 * detached `Konva.Text` — the same engine (and wrapping) as the canvas node.
 *
 * Falls back to the stored height when no 2D context is available (jsdom).
 */
export function measureTextContentHeight(object: TextObject, text: string): number {
  try {
    const measurer = new Konva.Text({
      text,
      fontFamily: object.fontFamily,
      fontSize: object.fontSize,
      fontStyle: textFontStyle(object),
      letterSpacing: object.letterSpacing,
      lineHeight: object.lineHeight,
      width: object.width,
      wrap: object.wrap ? 'word' : 'none',
      padding: 0,
    });
    const height = measurer.height();
    measurer.destroy();
    return height > 0 ? height : object.height;
  } catch {
    return object.height;
  }
}

/**
 * Total local-y shift to apply to the canvas text node so it matches the print
 * renderer: the first-baseline correction plus designer-core's block offset.
 *
 * The block offset is only needed when the content overflows the box — for a
 * box tall enough, Konva's own `verticalAlign` already puts the block where
 * designer-core does, and leaving it to Konva keeps the node bounds (and thus
 * the Transformer outline / hit testing) on the stored box.
 */
export function editorTopOffsetFor(object: TextObject, contentHeight: number): number {
  const boxHeight = object.autoHeight ? contentHeight : object.height;
  const overflowOffset =
    contentHeight > boxHeight
      ? textBlockAlignOffsetY(boxHeight, contentHeight, object.verticalAlign)
      : 0;
  return overflowOffset + textYCorrectionFor(object);
}
