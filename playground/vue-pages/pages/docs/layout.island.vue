<script setup>
import { useFrontmatter } from "void/md";
import pages from "void/md/pages";

const fm = useFrontmatter();
const docPages = pages.filter((p) => p.path.startsWith("/docs"));
</script>

<style>
@import "@void-x/md/theme";
</style>

<template>
  <div style="display: flex; gap: 2rem; padding: 1rem">
    <aside style="width: 200px; flex-shrink: 0">
      <h3>Docs</h3>
      <nav>
        <ul style="list-style: none; padding: 0">
          <li v-for="page in docPages" :key="page.path" style="margin-bottom: 0.5em">
            <a :href="page.path">{{ page.title }}</a>
          </li>
        </ul>
      </nav>
    </aside>
    <main class="void-md" style="flex: 1; min-width: 0">
      <h1 v-if="fm.title">{{ fm.title }}</h1>
      <slot />
    </main>
  </div>
</template>
