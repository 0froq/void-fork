import { defineHandler } from 'void';

export type Props = {
  title: string;
};

export const loader = defineHandler<Props>(() => {
  return { title: 'Visit Await' };
});
