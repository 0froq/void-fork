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
@import "void/md/theme";

body {
  background: #f6f6f6;
  color: #1a1a2e;
}

.page {
  max-width: 960px;
  margin: 0 auto;
  padding: 1rem;
}

nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 0;
  margin-bottom: 30px;
  border-bottom: 1px solid var(--vmd-border);
}

.nav-links a {
  margin: 0 10px;
}

.nav-links a:first-child {
  margin-left: 0;
}

/* Auto (system) dark mode */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) body {
    background: #161718;
    color: #e2e8f0;
  }
}

/* Explicit dark mode */
:root[data-theme="dark"] body {
  background: #161718;
  color: #e2e8f0;
}
</style>
