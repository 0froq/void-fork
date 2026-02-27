import { defineHandler, type InferProps } from "void";

export type Props = InferProps<typeof loader>;

export const loader = defineHandler(() => {
  return { model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" };
});
