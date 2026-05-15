import { defineHandler } from 'void';

export type Props = {
  description: string;
};

export const loader = defineHandler<Props>(() => {
  return { description: 'A legacy static page that can be redirected at deploy time.' };
});
