import type { Theme } from "vitepress";
import BaseTheme, { themeContextKey } from "@voidzero-dev/vitepress-theme";
import { h } from "vue";
import "virtual:group-icons.css";
import "./styles.css";

import logoDark from "./logo-dark.svg";
import logoLight from "./logo-light.svg";
import voidzeroLogoDark from "./voidzero-logo-dark.svg";
import voidzeroLogoLight from "./voidzero-logo-light.svg";
import footerBg from "@assets/vite/footer-background.jpg";
import monoIcon from "@assets/icons/vite-mono.svg";

function AsideCredit() {
  return h(
    "a",
    {
      href: "https://voidzero.dev",
      target: "_blank",
      rel: "noopener noreferrer",
      style: {
        border: "1px solid var(--vp-c-divider)",
        borderRadius: "4px",
        padding: "12px 16px",
        fontSize: "13px",
        color: "var(--vp-c-text-2)",
        display: "flex",
        alignItems: "center",
        gap: "6px",
        textDecoration: "none",
      },
    },
    [
      h("span", { style: { fontSize: "11px" } }, "brought to you by"),
      h("img", {
        src: voidzeroLogoDark,
        alt: "VoidZero",
        class: "aside-credit-logo-dark",
        style: { height: "9px" },
      }),
      h("img", {
        src: voidzeroLogoLight,
        alt: "VoidZero",
        class: "aside-credit-logo-light",
        style: { height: "9px", display: "none" },
      }),
    ],
  );
}

export default {
  extends: BaseTheme,
  Layout() {
    return h(BaseTheme.Layout, null, {
      "aside-ads-before": () => h(AsideCredit),
    });
  },
  enhanceApp({ app }) {
    app.provide(themeContextKey, {
      logoDark,
      logoLight,
      logoAlt: "Void",
      footerBg,
      monoIcon,
    });
  },
} satisfies Theme;
