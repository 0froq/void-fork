import { defineHandler } from "void";

export interface Props {
  title: string;
}

export const loader = defineHandler<Props>(() => {
  return { title: "Home" };
});

export function head(_c: unknown, props: Props) {
  return {
    title: props.title,
    meta: [{ name: "description", content: "React Pages playground home" }],
  };
}
