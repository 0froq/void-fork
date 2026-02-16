import type { Theme } from "vitepress";
import BaseTheme, { themeContextKey } from "@voidzero-dev/vitepress-theme";
import "./styles.css";

export default {
  extends: BaseTheme,
  enhanceApp({ app }) {
    app.provide(themeContextKey, {
      logoDark: "/logo-dark.svg",
      logoLight: "/logo-light.svg",
      logoAlt: "Vite Cloud",
      footerBg: "",
      monoIcon: "",
    });
  },
} satisfies Theme;
