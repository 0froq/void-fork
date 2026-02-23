import type { Theme } from "vitepress";
import BaseTheme, { themeContextKey } from "@voidzero-dev/vitepress-theme";
import "virtual:group-icons.css";
import "./styles.css";

import logoDark from "./logo-dark.svg";
import logoLight from "./logo-light.svg";
import footerBg from "@assets/vite/footer-background.jpg";
import monoIcon from "@assets/icons/vite-mono.svg";

export default {
  extends: BaseTheme,
  enhanceApp({ app }) {
    app.provide(themeContextKey, {
      logoDark,
      logoLight,
      logoAlt: "Vite Cloud",
      footerBg,
      monoIcon,
    });
  },
} satisfies Theme;
