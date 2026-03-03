<script setup>
import FeatureGrid from "@components/oss/FeatureGrid.vue";
import Footer from "@components/oss/Footer.vue";
import Hero from "@components/oss/Hero.vue";
import Spacer from "@components/shared/Spacer.vue";
import FileTree from "./FileTree.vue";
import { useData } from "vitepress";
import bg from "./hero-bg.jpg";

const { frontmatter } = useData();

const tree = (ext) => [
  { name: "pages/", children: [{ name: `index${ext}` }, { name: `about${ext}` }] },
  {
    name: "routes/",
    children: [
      {
        name: "api/",
        children: [
          { name: "hello.ts" },
          { name: "users/", children: [{ name: "index.ts" }, { name: "[id].ts" }] },
        ],
      },
    ],
  },
  { name: "migrations/", children: [{ name: "0001_create_users.sql" }] },
  { name: "vite.config.ts" },
  { name: "void.json" },
];
</script>

<template>
  <Hero :background="bg">
    <template #hero-image>
      <div class="hero-file-tree">
        <FileTree :items="tree" default-expanded adapter-tabs />
      </div>
    </template>
  </Hero>

  <Spacer />

  <FeatureGrid />

  <Spacer />

  <Footer
    :heading="frontmatter.footer_heading"
    :subheading="frontmatter.footer_subheading"
    button-text="Get Started"
    button-link="/guide/"
  />
</template>

<style scoped>
.hero-file-tree {
  margin-top: 2rem;
}

@media (min-width: 768px) {
  .hero-file-tree {
    margin-top: 0;
  }
}

.hero-file-tree :deep(.file-tree),
.hero-file-tree :deep(.adapter-tabs) {
  background-color: rgba(0, 0, 0, 0.75);
  backdrop-filter: blur(10px);
  border-color: rgba(255, 255, 255, 0.1);
}
</style>
