<script setup>
import ThemeToggle from "./_ThemeToggle.vue" with { island: "load" };
</script>

<template>
  <div class="page">
    <header>
      <nav>
        <span class="nav-links">
          <a href="/">Home</a> | <a href="/posts/getting-started">Getting Started</a> |
          <a href="/posts/code-examples">Code Examples</a>
        </span>
        <ThemeToggle />
      </nav>
      <hr />
    </header>
    <slot />
  </div>
</template>

<style>
.page {
  max-width: 960px;
  margin: 0 auto;
  padding: 1rem;
}

nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

/* Page-level dark mode */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) body {
    background: #0f172a;
    color: #e2e8f0;
  }
}

:root[data-theme="dark"] body {
  background: #0f172a;
  color: #e2e8f0;
}
</style>
