<script setup lang="ts">
import { onMounted, ref } from 'vue';

const props = defineProps<{
  header?: boolean;
}>();

const target = ref<string>();

onMounted(() => {
  target.value = 'header.wrapper > div:last-child';
});
</script>

<template>
  <Teleport v-if="header && target" :to="target">
    <a
      class="early-access-cta"
      href="https://tally.so/r/D4VE85"
      rel="noopener noreferrer"
      target="_blank"
    >
      Join early access
    </a>
  </Teleport>
  <a
    v-else-if="!props.header"
    class="early-access-cta"
    href="https://tally.so/r/D4VE85"
    rel="noopener noreferrer"
    target="_blank"
  >
    Join early access
  </a>
</template>
