import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { hasFiles, objectToFormData } from '../../src/pages/client.ts';
import { decodeFormData, encodeFormData, FORM_DATA_HEADER } from '../../src/shared/form-data.ts';

async function roundTrip(source: Record<string, unknown> | Array<unknown>) {
  const encoded = encodeFormData(source);
  const form = await new Request('http://localhost/', { method: 'POST', ...encoded }).formData();
  return { form, data: decodeFormData(form, encoded.headers[FORM_DATA_HEADER]) };
}

afterEach(() => vi.unstubAllGlobals());

describe('multipart form data', () => {
  it('preserves JSON values, nested files and ordinary form fields', async () => {
    const photo = new File(['image'], 'photo.png', { type: 'image/png' });
    const { form, data } = await roundTrip({
      title: 'Photo',
      quantity: 3,
      enabled: false,
      active: true,
      note: null,
      omitted: undefined,
      date: new Date('2026-01-01T00:00:00Z'),
      empty: {},
      tags: [],
      profile: { photos: [photo, new Blob(['blob'], { type: 'text/plain' })] },
    });
    expect(data).toEqual({
      title: 'Photo',
      quantity: 3,
      enabled: false,
      active: true,
      note: null,
      date: '2026-01-01T00:00:00.000Z',
      empty: {},
      tags: [],
      profile: { photos: [expect.any(File), expect.any(File)] },
    });
    const photos = (data as { profile: { photos: Array<File> } }).profile.photos;
    expect(photos[0].name).toBe('photo.png');
    expect(photos[0].type).toBe('image/png');
    expect(await photos[0].text()).toBe('image');
    expect(await photos[1].text()).toBe('blob');
    expect(form.get('title')).toBe('Photo');
    expect(form.get('quantity')).toBe('3');
    expect(form.get('enabled')).toBe('0');
    expect(form.get('active')).toBe('1');
    expect(form.get('note')).toBe('');
    expect(form.get('profile[photos][0]')).toBeInstanceOf(File);
    expect(Array.from(form.values()).filter((value) => value instanceof File)).toHaveLength(2);
  });

  it('preserves the public helper output and append arguments without metadata', () => {
    const form = new FormData();
    form.append('existing', 'value');
    expect(objectToFormData({ enabled: false, list: [1, null], empty: {} }, form, 'profile')).toBe(
      form,
    );
    expect(Array.from(form.entries())).toEqual([
      ['existing', 'value'],
      ['profile[enabled]', '0'],
      ['profile[list][0]', '1'],
      ['profile[list][1]', ''],
    ]);
  });

  it('avoids metadata field collisions and ambiguous bracket paths', async () => {
    const { data } = await roundTrip({
      __void_form_data: 'keep',
      __void_form_data_: 'also keep',
      'profile[photo]': 'literal',
      profile: { photo: new File(['image'], 'photo.png') },
    });
    expect(data).toEqual({
      __void_form_data: 'keep',
      __void_form_data_: 'also keep',
      'profile[photo]': 'literal',
      profile: { photo: expect.any(File) },
    });
  });

  it('normalizes populated and empty FileLists to arrays in multipart data', async () => {
    class TestFileList {
      [index: number]: File;
      declare length: number;
      constructor(...files: Array<File>) {
        Object.assign(this, files);
        Object.defineProperty(this, 'length', { value: files.length });
      }
    }
    vi.stubGlobal('FileList', TestFileList);
    const files = new TestFileList(new File(['one'], 'one.txt'), new File(['two'], 'two.txt'));
    expect(hasFiles({ files })).toBe(true);
    expect(hasFiles({ files: new TestFileList() })).toBe(true);
    expect((await roundTrip({ files: new TestFileList() })).data).toEqual({ files: [] });
    const { form, data } = await roundTrip({ files, empty: new TestFileList() });
    expect(data).toEqual({ files: [expect.any(File), expect.any(File)], empty: [] });
    expect(form.getAll('files[]')).toHaveLength(2);
  });

  it('preserves native JSON serialization alongside files', async () => {
    const values = {
      url: new URL('https://example.com/path'),
      number: Object(3),
      boolean: Object(false),
      invalidDate: new Date(NaN),
      custom: { toJSON: () => ({ quantity: 3 }) },
    };
    const { data } = await roundTrip({ ...values, photo: new File(['one'], 'one.txt') });
    expect(data).toEqual({ ...JSON.parse(JSON.stringify(values)), photo: expect.any(File) });
  });

  it('preserves top-level array bodies', async () => {
    const { data } = await roundTrip([{ photo: new File(['one'], 'one.txt'), quantity: 3 }]);
    expect(data).toEqual([{ photo: expect.any(File), quantity: 3 }]);
  });

  it('keeps prototype-named own fields as data', async () => {
    const source = JSON.parse(
      '{"__proto__":{"photo":null},"constructor":{"prototype":{"photo":null}}}',
    );
    source.__proto__.photo = new File(['one'], 'one.txt');
    source.constructor.prototype.photo = new File(['two'], 'two.txt');
    const { data } = await roundTrip(source);
    expect(Object.getPrototypeOf(data)).toBe(Object.prototype);
    expect(Object.hasOwn(data as object, '__proto__')).toBe(true);
    expect(data).toEqual({
      ['__proto__']: { photo: expect.any(File) },
      constructor: { prototype: { photo: expect.any(File) } },
    });
    expect(Object.hasOwn(Object.prototype, 'photo')).toBe(false);
  });

  it.each([
    null,
    {},
    { files: [] },
    { data: {}, files: null },
    { data: { photo: null }, files: [{ path: ['photo'], index: -1 }] },
    { data: { photo: null }, files: [{ path: ['photo'], index: 0.5 }] },
    { data: { photo: null }, files: [{ path: ['photo'], index: 20 }] },
    { data: { photo: null }, files: [{ path: ['photo'], index: 1 }] },
    { data: { photo: null }, files: [{ path: [], index: 0 }] },
    { data: { photo: null }, files: [{ path: [0], index: 0 }] },
    { data: { photo: null }, files: [{ path: ['missing'], index: 0 }] },
    { data: { photo: 'not a placeholder' }, files: [{ path: ['photo'], index: 0 }] },
    { data: {}, files: [{ path: ['__proto__', 'photo'], index: 0 }] },
    { data: {}, files: [{ path: ['constructor', 'prototype', 'photo'], index: 0 }] },
    {
      data: { photo: null },
      files: [
        { path: ['photo'], index: 0 },
        { path: ['photo'], index: 0 },
      ],
    },
  ])('rejects malformed metadata or unsafe file references: %j', (metadata) => {
    const form = new FormData();
    form.append('photo', new File(['image'], 'photo.png'));
    form.append('metadata', JSON.stringify(metadata));
    expect(() => decodeFormData(form, 'metadata')).toThrow();
    expect(Object.hasOwn(Object.prototype, 'photo')).toBe(false);
  });

  it('requires exactly one text metadata part', () => {
    const form = new FormData();
    expect(() => decodeFormData(form, 'metadata')).toThrow();
    form.append('metadata', new File(['{}'], 'data.json'));
    expect(() => decodeFormData(form, 'metadata')).toThrow();
    form.set('metadata', '{');
    expect(() => decodeFormData(form, 'metadata')).toThrow();
    form.set('metadata', '{"data":{},"files":[]}');
    form.append('metadata', '{"data":{},"files":[]}');
    expect(() => decodeFormData(form, 'metadata')).toThrow();
  });
});
