import { defineConfig } from "vite";
import { voidPlugin } from "void";
import { voidReact } from "@void-x/react";
import { voidMarkdown } from "@void-x/md";

export default defineConfig({
  plugins: [voidPlugin(), voidReact(), voidMarkdown()],
});
