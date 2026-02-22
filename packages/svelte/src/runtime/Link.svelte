<script>
  import { getContext } from "svelte";

  let { href, method = "GET", data = undefined, preserveScroll = false, viewTransition = undefined, children, ...rest } = $props();

  const router = getContext("__vc_router");

  function onClick(e) {
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

  const isGet = $derived(method.toUpperCase() === "GET");
</script>

{#if isGet}
  <a {href} onclick={onClick} {...rest}>
    {@render children()}
  </a>
{:else}
  <button onclick={onClick} {...rest}>
    {@render children()}
  </button>
{/if}
