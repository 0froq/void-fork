import * as v from 'valibot';
import { defineHandler } from 'void';

export const loader = defineHandler(() => ({}));
export const action = defineHandler.withValidator({
  body: v.object({
    email: v.pipe(v.string(), v.minLength(1, 'Email is required')),
    name: v.pipe(v.string(), v.minLength(1, 'Name is required')),
    profile: v.object({ name: v.string() }),
    tags: v.array(v.string()),
    photo: v.optional(v.nullable(v.pipe(v.file(), v.maxSize(4, 'File is too large')))),
    quantity: v.optional(v.literal(3)),
    published: v.optional(v.literal(false)),
    note: v.optional(v.null()),
  }),
})(() => {});
