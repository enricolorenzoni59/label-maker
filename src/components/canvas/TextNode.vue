<template>
  <VText
    ref="nodeRef"
    :config="config"
    @click="emit('select', $event)"
    @tap="emit('select', $event)"
    @dblclick="emit('edit')"
    @dbltap="emit('edit')"
    @dragstart="emit('dragstart')"
    @dragmove="onDragMove"
    @dragend="onDragEnd"
    @transformstart="onTransformStart"
    @transform="onTransform"
    @transformend="onTransformEnd"
  />
</template>

<script setup lang="ts">
import { computed, ref, watchPostEffect } from 'vue';
import { applyTemplate, type TextObject } from '@burnmark-io/designer-core';
import { useDataStore } from '@/stores/data';
import { useShiftKey } from '@/composables/useShiftKey';
import { useTransformContext } from '@/composables/useTransformContext';
import { konvaTextBoxHeight } from '@/lib/canvas/text-layout';
import {
  editorTopOffsetFor,
  measureTextContentHeight,
  textFontStyle,
} from '@/lib/canvas/editor-text';

const data = useDataStore();
const shiftKey = useShiftKey();
const { activeAnchor, groupContext } = useTransformContext();

const props = defineProps<{
  object: TextObject;
  selected: boolean;
  draggable: boolean;
}>();

export interface TransformEndPatch {
  x: number;
  y: number;
  width: number;
  height?: number;
  rotation: number;
  fontSize?: number;
  letterSpacing?: number;
}

const emit = defineEmits<{
  (e: 'select', event: unknown): void;
  (e: 'edit'): void;
  (e: 'dragstart'): void;
  (e: 'dragmove', x: number, y: number): void;
  (e: 'dragend', x: number, y: number): void;
  (e: 'transformend', patch: TransformEndPatch): void;
}>();

interface KonvaTextNode {
  width(): number;
  width(n: number): void;
  height(): number;
  height(n: number): void;
  fontSize(): number;
  fontSize(n: number): void;
  scaleX(): number;
  scaleX(s: number): void;
  scaleY(): number;
  scaleY(s: number): void;
  offsetX(n: number): void;
  offsetY(n: number): void;
  x(): number;
  x(n: number): void;
  y(): number;
  y(n: number): void;
  rotation(): number;
  getStage(): { findOne(selector: string): unknown } | null;
}

interface KonvaTransformerLike {
  getActiveAnchor?(): string;
}

interface KonvaNodeRef {
  getNode(): KonvaTextNode;
}

const nodeRef = ref<KonvaNodeRef | null>(null);

const measuredHeight = ref(props.object.height ?? 0);

const renderHeight = computed(() =>
  props.object.autoHeight ? measuredHeight.value : props.object.height,
);

/**
 * WYSIWYG corrections (see `@/lib/canvas/editor-text`). Konva anchors the
 * first line by its middle baseline and *truncates* lines to the node's
 * height; designer-core (print/export) anchors by the alphabetic baseline and
 * lays out every line. The node is shifted and its box sized so the canvas
 * matches the print; every node↔object conversion below undoes the shift.
 */
const renderedText = computed(() => applyTemplate(props.object.content, data.currentVariables));

/** Laid-out height of the rendered text (same engine/wrapping as the node). */
const contentHeight = computed(() => measureTextContentHeight(props.object, renderedText.value));

const topOffset = computed(() => editorTopOffsetFor(props.object, contentHeight.value));

const konvaHeight = computed(() =>
  konvaTextBoxHeight(props.object.autoHeight, props.object.height, contentHeight.value),
);

const config = computed(() => ({
  id: props.object.id,
  name: 'object',
  x: props.object.x + props.object.width / 2,
  y: props.object.y + topOffset.value + renderHeight.value / 2,
  offsetX: props.object.width / 2,
  offsetY: renderHeight.value / 2,
  width: props.object.width,
  height: konvaHeight.value,
  text: renderedText.value,
  fontSize: props.object.fontSize,
  fontFamily: props.object.fontFamily,
  fontStyle: textFontStyle(props.object),
  align: props.object.textAlign,
  // Kept: for a box tall enough Konva already aligns like designer-core, and
  // `editorTopOffsetFor` only adds the overflow offset (so the node bounds stay
  // on the stored box wherever possible).
  verticalAlign: props.object.verticalAlign,
  letterSpacing: props.object.letterSpacing,
  lineHeight: props.object.lineHeight,
  fill: props.object.color,
  rotation: props.object.rotation,
  opacity: props.object.opacity,
  visible: props.object.visible,
  listening: !props.object.locked,
  draggable: props.selected && props.draggable && !props.object.locked,
  wrap: props.object.wrap ? 'word' : 'none',
}));

watchPostEffect(() => {
  void config.value;
  const node = nodeRef.value?.getNode();
  if (!node) return;
  if (props.object.autoHeight) {
    const h = node.height();
    if (h && h !== measuredHeight.value) measuredHeight.value = h;
  } else if (measuredHeight.value !== props.object.height) {
    measuredHeight.value = props.object.height;
  }
});

function onDragMove(event: { target?: { x?: () => number; y?: () => number } }): void {
  const t = event.target;
  if (!t?.x || !t?.y) return;
  emit('dragmove', t.x() - props.object.width / 2, t.y() - topOffset.value - renderHeight.value / 2);
}

function onDragEnd(event: {
  target?: { x?: () => number; y?: () => number; width?: () => number; height?: () => number };
}): void {
  const t = event.target;
  if (!t?.x || !t?.y) return;
  // For autoHeight text the stored height may differ from what Konva
  // actually rendered — read the live node height to avoid position drift.
  const renderedHeight = props.object.autoHeight && t.height ? t.height() : props.object.height;
  emit('dragend', t.x() - props.object.width / 2, t.y() - topOffset.value - renderedHeight / 2);
}

const MIN_DIM = 10;
const MIN_FONT = 4;

const CORNER_ANCHORS = new Set(['top-left', 'top-right', 'bottom-left', 'bottom-right']);

function isCornerHandle(anchorName: string): boolean {
  return CORNER_ANCHORS.has(anchorName);
}

let dragStartWidth = 0;
let dragStartHeight = 0;
let dragStartFontSize = 0;
let dragStartLetterSpacing = 0;
let dragStartAnchor = '';
let dragStartRotationRad = 0;
// World position of the anchor opposite the dragged one — held fixed
// throughout the drag (the resize "pivot").
let pivotWorldX = 0;
let pivotWorldY = 0;
// Konva reports per-tick scale relative to the node's pre-reset state,
// so multiplying these each tick gives the absolute scale since
// transformstart even though we reset node.scaleX/Y to 1 every tick.
let cumulativeScaleX = 1;
let cumulativeScaleY = 1;

function isProportional(): boolean {
  const corner = isCornerHandle(dragStartAnchor);
  return corner !== shiftKey.value;
}

/**
 * Vector from the bbox centre to the anchor opposite the dragged one,
 * in the node's local (un-rotated) frame.
 */
function localPivotOffset(anchor: string, w: number, h: number): { x: number; y: number } {
  switch (anchor) {
    case 'top-left':
      return { x: w / 2, y: h / 2 };
    case 'top-right':
      return { x: -w / 2, y: h / 2 };
    case 'bottom-left':
      return { x: w / 2, y: -h / 2 };
    case 'bottom-right':
      return { x: -w / 2, y: -h / 2 };
    case 'middle-left':
      return { x: w / 2, y: 0 };
    case 'middle-right':
      return { x: -w / 2, y: 0 };
    case 'top-center':
      return { x: 0, y: h / 2 };
    case 'bottom-center':
      return { x: 0, y: -h / 2 };
    default:
      return { x: 0, y: 0 };
  }
}

function onTransformStart(): void {
  const node = nodeRef.value?.getNode();
  if (!node) return;
  dragStartWidth = props.object.width;
  // The drawn box, not the stored one: when the content overflows the
  // stored height the node is sized to the content (`konvaTextBoxHeight`),
  // and that is the frame the Transformer shows and the user drags.
  dragStartHeight = node.height();
  dragStartFontSize = props.object.fontSize;
  dragStartLetterSpacing = props.object.letterSpacing;
  dragStartAnchor = activeAnchor.value;
  cumulativeScaleX = 1;
  cumulativeScaleY = 1;

  dragStartRotationRad = (props.object.rotation * Math.PI) / 180;
  const cx = props.object.x + dragStartWidth / 2;
  // The node is drawn `topOffset` below the object box, so its centre — the
  // pivot frame for everything below — carries the same shift.
  const cy = props.object.y + topOffset.value + dragStartHeight / 2;
  const off = localPivotOffset(dragStartAnchor, dragStartWidth, dragStartHeight);
  const cosR = Math.cos(dragStartRotationRad);
  const sinR = Math.sin(dragStartRotationRad);
  pivotWorldX = cx + off.x * cosR - off.y * sinR;
  pivotWorldY = cy + off.x * sinR + off.y * cosR;
}

function onTransform(): void {
  const node = nodeRef.value?.getNode();
  if (!node) return;

  // When the user drags past the opposite anchor (the pivot), Konva
  // re-targets the transformer to the now-far anchor and starts
  // reporting "growth" from the new direction — that produces the
  // box-grows-upwards-past-the-pivot dance. flipEnabled: false stops
  // the visual flip but not the anchor re-target. Detect the swap and
  // hard-freeze cumulative at the floor for the rest of the drag in
  // that direction.
  const stage = node.getStage();
  const tr = stage?.findOne('Transformer') as KonvaTransformerLike | null;
  const currentAnchor = tr?.getActiveAnchor?.() ?? dragStartAnchor;
  const anchorSwapped = currentAnchor !== '' && currentAnchor !== dragStartAnchor;

  const corner = isCornerHandle(dragStartAnchor);
  const proportional = isProportional();

  const minScaleX = MIN_DIM / dragStartWidth;
  const minScaleY = MIN_DIM / dragStartHeight;
  // In proportional mode, both axes share a single floor — the larger
  // of the two minima — so they clamp together and stay in lock-step.
  // Otherwise the wider axis can keep shrinking past the taller axis's
  // floor, the cumulatives desync, and recovery on the way back out
  // ends up smaller than the user's pre-floor scale.
  const xFloor = proportional ? Math.max(minScaleX, minScaleY) : minScaleX;
  const yFloor = proportional ? Math.max(minScaleX, minScaleY) : minScaleY;

  if (anchorSwapped) {
    // Only peg the axis the user was actually dragging. For edge
    // anchors, the inactive axis stays at 1 throughout; pegging it to
    // its floor would collapse the box on that axis (the 10x10 bug).
    if (corner) {
      cumulativeScaleX = xFloor;
      cumulativeScaleY = yFloor;
    } else {
      const horizEdge = dragStartAnchor === 'middle-left' || dragStartAnchor === 'middle-right';
      if (horizEdge) cumulativeScaleX = xFloor;
      else cumulativeScaleY = yFloor;
    }
  } else {
    // Cap per-tick scale to swallow glitches Konva can report right
    // after an anchor un-swap (its internal reference is stale from
    // our floor-state mutations, so it can spike a single huge sx).
    // 10x per tick is plenty for any real drag speed.
    const sx = Math.max(0.1, Math.min(10, node.scaleX()));
    const sy = Math.max(0.1, Math.min(10, node.scaleY()));
    cumulativeScaleX *= sx;
    cumulativeScaleY *= sy;
    if (cumulativeScaleX < xFloor) cumulativeScaleX = xFloor;
    if (cumulativeScaleY < yFloor) cumulativeScaleY = yFloor;
    // Sanity ceiling so a runaway tick can't blow font sizes to 1000+.
    if (cumulativeScaleX > 50) cumulativeScaleX = 50;
    if (cumulativeScaleY > 50) cumulativeScaleY = 50;
  }

  // Reset scale so Konva renders text by layout, not by visual scaling.
  node.scaleX(1);
  node.scaleY(1);

  let newWidth: number;
  let newHeight: number;
  let newFont = dragStartFontSize;

  if (corner && proportional) {
    // Konva's keepRatio: true gives uniform scale on corner drags, so
    // cumulativeScaleX === cumulativeScaleY (modulo float noise).
    const s = cumulativeScaleX;
    newWidth = Math.max(MIN_DIM, dragStartWidth * s);
    newHeight = Math.max(MIN_DIM, dragStartHeight * s);
    newFont = Math.max(MIN_FONT, dragStartFontSize * s);
  } else if (corner && !proportional) {
    newWidth = Math.max(MIN_DIM, dragStartWidth * cumulativeScaleX);
    newHeight = Math.max(MIN_DIM, dragStartHeight * cumulativeScaleY);
  } else if (!corner && proportional) {
    const isHorizontalEdge =
      dragStartAnchor === 'middle-left' || dragStartAnchor === 'middle-right';
    const s = isHorizontalEdge ? cumulativeScaleX : cumulativeScaleY;
    newWidth = Math.max(MIN_DIM, dragStartWidth * s);
    newHeight = Math.max(MIN_DIM, dragStartHeight * s);
    newFont = Math.max(MIN_FONT, dragStartFontSize * s);
  } else {
    newWidth = Math.max(MIN_DIM, dragStartWidth * cumulativeScaleX);
    newHeight = Math.max(MIN_DIM, dragStartHeight * cumulativeScaleY);
  }

  node.width(newWidth);
  // Always set fontSize so toggling Shift mid-drag snaps the live font
  // back to dragStart in non-proportional mode (and re-engages scaling
  // cleanly when toggled back). dragStart is the no-op value.
  node.fontSize(newFont);
  if (!props.object.autoHeight) {
    // Never below the content: Konva truncates lines past the node's
    // height, which would hide them mid-drag.
    const nextContentHeight = measureTextContentHeight(
      { ...props.object, fontSize: newFont, width: newWidth } as TextObject,
      renderedText.value,
    );
    node.height(konvaTextBoxHeight(false, newHeight, nextContentHeight) ?? newHeight);
  }

  const liveHeight = node.height();

  // Always anchor the bbox at the pivot computed at transformstart.
  // This is robust regardless of how Konva positions the node — at the
  // floor, after an anchor swap, on autoHeight, or on edge+Shift.
  const off = localPivotOffset(dragStartAnchor, newWidth, liveHeight);
  const cosR = Math.cos(dragStartRotationRad);
  const sinR = Math.sin(dragStartRotationRad);
  node.x(pivotWorldX - (off.x * cosR - off.y * sinR));
  node.y(pivotWorldY - (off.x * sinR + off.y * cosR));

  node.offsetX(newWidth / 2);
  node.offsetY(liveHeight / 2);
}

function onTransformEnd(): void {
  const node = nodeRef.value?.getNode();
  if (!node) return;

  const proportional = isProportional();
  const newWidth = node.width();
  const newHeight = node.height();

  // In a multi-select context compute position relative to group centre
  // so the relative layout is preserved across scale/rotate operations.
  const ctx = groupContext.value;
  const snap = ctx?.perObject.get(props.object.id);
  let posX: number;
  let posY: number;
  if (ctx && snap) {
    const scaleX = newWidth / snap.width;
    const scaleY = newHeight / snap.height;
    const dRotDeg = node.rotation() - snap.rotation;
    const dRotRad = (dRotDeg * Math.PI) / 180;
    const ox = snap.offsetX * scaleX;
    const oy = snap.offsetY * scaleY;
    const cosD = Math.cos(dRotRad);
    const sinD = Math.sin(dRotRad);
    const newCx = ctx.centre.x + (ox * cosD - oy * sinD);
    const newCy = ctx.centre.y + (ox * sinD + oy * cosD);
    posX = newCx - newWidth / 2;
    posY = newCy - newHeight / 2;
  } else {
    posX = node.x() - newWidth / 2;
    // The WYSIWYG offset depends on the font size and, in the overflow case,
    // on the box/content height — all of which a resize changes. Recompute it
    // from the post-transform values, or the stored `y` lands the text a few
    // dots off (and it jumps on the next render).
    const nextFontSize = proportional ? Math.max(MIN_FONT, node.fontSize()) : props.object.fontSize;
    const nextObject = {
      ...props.object,
      fontSize: nextFontSize,
      width: newWidth,
      height: newHeight,
    } as TextObject;
    const nextContentHeight = measureTextContentHeight(nextObject, renderedText.value);
    posY = node.y() - editorTopOffsetFor(nextObject, nextContentHeight) - newHeight / 2;
  }

  const patch: TransformEndPatch = {
    x: posX,
    y: posY,
    width: newWidth,
    rotation: node.rotation(),
  };
  if (!props.object.autoHeight) {
    patch.height = newHeight;
  }
  if (proportional) {
    const liveFont = Math.max(MIN_FONT, node.fontSize());
    patch.fontSize = liveFont;
    const fontScale = liveFont / dragStartFontSize;
    patch.letterSpacing = Math.max(0, dragStartLetterSpacing * fontScale);
  }

  emit('transformend', patch);
}
</script>
