import { defineComponent, h, inject } from "vue";

export const Link = defineComponent({
  name: "Link",
  props: {
    href: { type: String, required: true },
    method: { type: String, default: "GET" },
    data: { type: Object, default: undefined },
    preserveScroll: { type: Boolean, default: false },
    viewTransition: { type: Boolean, default: undefined },
  },
  setup(props, { slots, attrs }) {
    const router = inject<any>("__vc_router", null);

    function onClick(e: MouseEvent) {
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button !== 0) return;
      const url = new URL(props.href, window.location.origin);
      if (url.origin !== window.location.origin) return;

      e.preventDefault();
      router.visit(props.href, {
        method: props.method,
        data: props.data,
        preserveScroll: props.preserveScroll,
        viewTransition: props.viewTransition,
      });
    }

    return () =>
      h(
        props.method.toUpperCase() === "GET" ? "a" : "button",
        {
          ...(props.method.toUpperCase() === "GET" ? { href: props.href } : {}),
          onClick,
          ...attrs,
        },
        slots.default?.(),
      );
  },
});
