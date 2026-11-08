import { Context } from 'hono';
import * as v from 'valibot';
import { describe, expect, it } from 'vite-plus/test';
import type { CloudContext, CloudEnv } from '../../src/runtime/handler.ts';
import { runValidation, type ValidatorSlots } from '../../src/runtime/validator.ts';
import { encodeFormData, FORM_DATA_HEADER } from '../../src/shared/form-data.ts';
import type { StandardSchemaV1 } from '../../src/standard-schema.ts';

type ValidationIssueBody = {
  error: string;
  issues: Array<{
    slot: string;
    issues: Array<{ message: string; path?: string }>;
  }>;
};

/** Create a mock Standard Schema that always fails with the given issues. */
function failSchema(issues: Array<StandardSchemaV1.Issue>): StandardSchemaV1 {
  return {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate() {
        return { issues };
      },
    },
  };
}

function mockContext(body?: unknown): CloudContext {
  return new Context<CloudEnv>(
    new Request('http://localhost/', { method: 'POST', body: JSON.stringify(body) }),
  );
}

describe('runValidation', () => {
  it('validates native multipart files and repeated fields', async () => {
    const form = new FormData();
    form.append('title', 'Photo');
    form.append('photo', new File(['image'], 'photo.png', { type: 'image/png' }));
    form.append('tags', 'one');
    form.append('tags', 'two');
    const result = await runValidation(
      { body: v.object({ title: v.string(), photo: v.file(), tags: v.array(v.string()) }) },
      new Context<CloudEnv>(new Request('http://localhost/', { method: 'POST', body: form })),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input.body.title).toBe('Photo');
      expect(result.input.body.tags).toEqual(['one', 'two']);
      expect(result.input.body.photo.name).toBe('photo.png');
      expect(await result.input.body.photo.text()).toBe('image');
    }
  });

  it('validates URL-encoded forms without coercing strings', async () => {
    const result = await runValidation(
      { body: v.object({ title: v.string(), enabled: v.literal('0') }) },
      new Context<CloudEnv>(
        new Request('http://localhost/', {
          method: 'POST',
          body: new URLSearchParams({ title: 'Photo', enabled: '0' }),
        }),
      ),
    );
    expect(result).toEqual({ ok: true, input: { body: { title: 'Photo', enabled: '0' } } });
  });

  it('validates encoded nested fields and files without scalar coercion', async () => {
    const result = await runValidation(
      {
        body: v.object({
          quantity: v.number(),
          enabled: v.boolean(),
          note: v.null(),
          profile: v.object({ photos: v.array(v.file()) }),
        }),
      },
      new Context<CloudEnv>(
        new Request('http://localhost/', {
          method: 'POST',
          ...encodeFormData({
            quantity: 3,
            enabled: false,
            note: null,
            profile: { photos: [new File(['image'], 'photo.png')] },
          }),
        }),
      ),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input.body).toEqual({
        quantity: 3,
        enabled: false,
        note: null,
        profile: { photos: [expect.any(File)] },
      });
    }
  });

  it('returns schema issues with nested field paths for multipart requests', async () => {
    const result = await runValidation(
      {
        body: v.object({
          profile: v.object({
            name: v.pipe(v.string(), v.minLength(1, 'Name is required')),
            photo: v.pipe(v.file(), v.maxSize(1, 'Photo is too large')),
          }),
        }),
      },
      new Context<CloudEnv>(
        new Request('http://localhost/', {
          method: 'POST',
          ...encodeFormData({ profile: { name: '', photo: new File(['image'], 'photo.png') } }),
        }),
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      expect(await result.response.json()).toEqual({
        error: 'Validation failed',
        issues: [
          {
            slot: 'body',
            issues: [
              { path: 'profile.name', message: 'Name is required' },
              { path: 'profile.photo', message: 'Photo is too large' },
            ],
          },
        ],
      });
    }
  });

  it.each([
    ['multipart/form-data', 'broken', 'Invalid form body'],
    ['application/json', '{', 'Invalid JSON body'],
  ])('rejects malformed %s bodies', async (contentType, body, error) => {
    const result = await runValidation(
      { body: v.unknown() },
      new Context<CloudEnv>(
        new Request('http://localhost/', {
          method: 'POST',
          headers: { 'Content-Type': contentType },
          body,
        }),
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      expect(await result.response.json()).toEqual({ error });
    }
  });

  it('does not fall back to flat fields when metadata is malformed', async () => {
    const form = new FormData();
    form.append('metadata', '{');
    const result = await runValidation(
      { body: v.unknown() },
      new Context<CloudEnv>(
        new Request('http://localhost/', {
          method: 'POST',
          headers: { [FORM_DATA_HEADER]: 'metadata' },
          body: form,
        }),
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(await result.response.json()).toEqual({ error: 'Invalid form body' });
    }
  });

  it('leaves cached form data available to a handler after validation', async () => {
    const c = new Context<CloudEnv>(
      new Request('http://localhost/', {
        method: 'POST',
        ...encodeFormData({ title: 'Photo', photo: new File(['image'], 'photo.png') }),
      }),
    );
    expect((await runValidation({ body: v.object({ photo: v.file() }) }, c)).ok).toBe(true);
    expect((await c.req.parseBody()).title).toBe('Photo');
    expect((await c.req.parseBody()).photo).toBeInstanceOf(File);
  });

  it('passes with empty validators', async () => {
    const c = mockContext();
    const result = await runValidation({}, c);
    expect(result.ok).toBe(true);
  });

  it('includes path in flattened issues', async () => {
    const validators: ValidatorSlots = {
      body: failSchema([{ message: 'too short', path: [{ key: 'name' }] }]),
    };
    const c = mockContext({ name: '' });
    const result = await runValidation(validators, c);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const json = (await result.response.json()) as ValidationIssueBody;
      expect(json.issues[0].issues[0].path).toBe('name');
    }
  });
});
