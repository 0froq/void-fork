import { useContext, useRef, useEffect, type JSX } from "react";
import type { MouseEvent, AnchorHTMLAttributes, ButtonHTMLAttributes } from "react";
import { RouterContext } from "./context";

type PrefetchStrategy = "hover" | "click" | "mount" | "visible";

type CommonProps = {
  href: string;
  method?: string;
  data?: Record<string, unknown>;
  preserveScroll?: boolean;
  viewTransition?: boolean;
  prefetch?: boolean | PrefetchStrategy | PrefetchStrategy[];
  cacheFor?: number | string | [string, string];
};

export type LinkProps = CommonProps &
  Omit<AnchorHTMLAttributes<HTMLAnchorElement>, keyof CommonProps> &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, keyof CommonProps>;

export function Link({
  href,
  method = "GET",
  data,
  preserveScroll = false,
  viewTransition,
  prefetch: prefetchProp = false,
  cacheFor,
  children,
  ...rest
}: LinkProps): JSX.Element {
  const router = useContext(RouterContext);
  const elRef = useRef<HTMLElement | null>(null);

  function getStrategies(): PrefetchStrategy[] {
    if (prefetchProp === false) return [];
    if (prefetchProp === true) return ["hover"];
    if (typeof prefetchProp === "string") return [prefetchProp];
    return prefetchProp;
  }

  function doPrefetch() {
    if (!router?.prefetch) return;
    const current = window.location.pathname + window.location.search;
    if (href === current) return;
    const options: any = {};
    if (cacheFor !== undefined) options.cacheFor = cacheFor;
    if (method) options.method = method;
    router.prefetch(href, options);
  }

  function onClick(e: MouseEvent) {
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button !== 0) return;
    const url = new URL(href, window.location.origin);
    if (url.origin !== window.location.origin) return;

    e.preventDefault();
    router.visit(href, {
      method,
      data,
      preserveScroll,
      viewTransition,
    });
  }

  let hoverTimer: ReturnType<typeof setTimeout> | null = null;

  function onMouseEnter() {
    hoverTimer = setTimeout(doPrefetch, router?._hoverDelay ?? 75);
  }

  function onMouseLeave() {
    if (hoverTimer) {
      clearTimeout(hoverTimer);
      hoverTimer = null;
    }
  }

  function onMouseDown() {
    doPrefetch();
  }

  useEffect(() => {
    const strategies = getStrategies();
    if (strategies.length === 0) return;

    if (strategies.includes("mount")) {
      doPrefetch();
    }

    let observer: IntersectionObserver | null = null;
    if (strategies.includes("visible") && elRef.current) {
      observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) {
            doPrefetch();
            observer?.disconnect();
            observer = null;
          }
        },
        { rootMargin: "0px" },
      );
      observer.observe(elRef.current);
    }

    return () => {
      if (hoverTimer) clearTimeout(hoverTimer);
      if (observer) {
        observer.disconnect();
      }
    };
  });

  const strategies = getStrategies();
  const isGet = method.toUpperCase() === "GET";

  const eventHandlers: Record<string, any> = { onClick };

  if (strategies.includes("hover")) {
    eventHandlers.onMouseEnter = onMouseEnter;
    eventHandlers.onMouseLeave = onMouseLeave;
    eventHandlers.onFocus = doPrefetch;
  }

  if (strategies.includes("click")) {
    eventHandlers.onMouseDown = onMouseDown;
  }

  if (isGet) {
    return (
      <a ref={elRef as any} href={href} {...eventHandlers} {...rest}>
        {children}
      </a>
    );
  }

  return (
    <button
      ref={elRef as any}
      type="button"
      {...eventHandlers}
      {...(rest as ButtonHTMLAttributes<HTMLButtonElement>)}
    >
      {children}
    </button>
  );
}
