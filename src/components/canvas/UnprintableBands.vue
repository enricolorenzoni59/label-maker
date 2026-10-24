<template>
  <VRect v-for="band in rects" :key="band.key" :config="band.config" />
</template>

<script setup lang="ts">
import { computed } from 'vue';

/**
 * Veils the strips along the label edges the printhead can't reach —
 * e.g. a 15 mm Niimbot roll on the 12 mm D110 head loses 1.5 mm per
 * side. Drawn above the objects so anything placed there visibly
 * disappears, matching the print and the preview.
 *
 * `before` / `after` are dot widths of the two strips across the
 * head; `axis` says which display axis runs across the head ('y' when
 * a tape is shown horizontally).
 */
const props = defineProps<{
  width: number;
  height: number;
  scale: number;
  axis: 'x' | 'y';
  before: number;
  after: number;
}>();

const FILL = 'rgba(120, 113, 108, 0.35)';
const EDGE = 'rgba(120, 113, 108, 0.9)';

const rects = computed(() => {
  const out: { key: string; config: Record<string, unknown> }[] = [];
  const common = {
    fill: FILL,
    stroke: EDGE,
    strokeWidth: 1 / props.scale,
    dash: [4 / props.scale, 3 / props.scale],
    listening: false,
  };
  if (props.before > 0) {
    out.push({
      key: 'before',
      config:
        props.axis === 'y'
          ? { ...common, x: 0, y: 0, width: props.width, height: props.before }
          : { ...common, x: 0, y: 0, width: props.before, height: props.height },
    });
  }
  if (props.after > 0) {
    out.push({
      key: 'after',
      config:
        props.axis === 'y'
          ? {
              ...common,
              x: 0,
              y: props.height - props.after,
              width: props.width,
              height: props.after,
            }
          : {
              ...common,
              x: props.width - props.after,
              y: 0,
              width: props.after,
              height: props.height,
            },
    });
  }
  return out;
});
</script>
