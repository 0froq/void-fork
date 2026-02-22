import { defineHandler } from "vite-cloud";

export interface Props {
  title: string;
}

export const loader = defineHandler<Props>(() => {
  return { title: "Home" };
});
