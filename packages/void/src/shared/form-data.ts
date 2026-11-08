export const FORM_DATA_HEADER = 'X-Void-Form-Data';

type FileReference = { path: Array<string>; index: number };

type FormEncoder = {
  form: FormData;
  files: Array<FileReference>;
  index: number;
};

export function isFile(value: unknown): boolean {
  return (
    (typeof File !== 'undefined' && value instanceof File) ||
    value instanceof Blob ||
    (typeof FileList !== 'undefined' && value instanceof FileList)
  );
}

export function hasFiles(data: unknown): boolean {
  return (
    isFile(data) ||
    (typeof data === 'object' && data !== null && Object.values(data).some(hasFiles))
  );
}

function appendValue(
  encoder: FormEncoder,
  value: unknown,
  key: string,
  path: Array<string>,
): unknown {
  if (value instanceof Blob) {
    encoder.files.push({ path, index: encoder.index++ });
    if (value instanceof File) {
      encoder.form.append(key, value, value.name);
    } else {
      encoder.form.append(key, value);
    }
    return null;
  }
  if (typeof FileList !== 'undefined' && value instanceof FileList) {
    return Array.from(value, (file, index) =>
      appendValue(encoder, file, `${key}[]`, [...path, String(index)]),
    );
  }
  if (Array.isArray(value)) {
    return Array.from(value, (item, index) =>
      appendValue(encoder, item, `${key}[${index}]`, [...path, String(index)]),
    );
  }
  if (value instanceof Date) {
    value = value.toISOString();
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([child, item]) => [
        child,
        appendValue(encoder, item, `${key}[${child}]`, [...path, child]),
      ]),
    );
  }
  if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) {
    encoder.form.append(
      key,
      value == null ? '' : typeof value === 'boolean' ? (value ? '1' : '0') : String(value),
    );
    encoder.index++;
  }
  return value;
}

function appendObject(
  source: Record<string, unknown>,
  encoder: FormEncoder,
  parentKey?: string,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(source).map(([key, value]) => [
      key,
      appendValue(encoder, value, parentKey ? `${parentKey}[${key}]` : key, [key]),
    ]),
  );
}

export function objectToFormData(
  source: Record<string, unknown>,
  form: FormData = new FormData(),
  parentKey?: string,
): FormData {
  appendObject(source, { form, files: [], index: 0 }, parentKey);
  return form;
}

function normalizeFormData(source: unknown): unknown {
  const paths = new WeakMap<object, Array<string>>();
  const binaries: Array<{ path: Array<string>; value: unknown }> = [];
  const json = JSON.stringify(source, function (key, value: unknown) {
    const parent = paths.get(this);
    const path = parent ? [...parent, key] : [];
    if (isFile(value)) {
      binaries.push({ path, value });
      return null;
    }
    if (value !== null && typeof value === 'object') {
      paths.set(value, path);
    }
    return value;
  });
  const data: unknown = JSON.parse(json);
  for (const { path, value } of binaries) {
    if (path.length === 0) {
      return value;
    }
    let target = data as Record<string, unknown>;
    for (const key of path.slice(0, -1)) {
      target = target[key] as Record<string, unknown>;
    }
    Object.defineProperty(target, path[path.length - 1], {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return data;
}

export function encodeFormData(source: unknown): {
  body: FormData;
  headers: Record<string, string>;
} {
  const encoder: FormEncoder = { form: new FormData(), files: [], index: 0 };
  const normalized = normalizeFormData(source);
  const data = Array.isArray(normalized)
    ? Array.from(normalized, (value, index) =>
        appendValue(encoder, value, String(index), [String(index)]),
      )
    : isRecord(normalized) && !isFile(normalized)
      ? appendObject(normalized, encoder)
      : appendValue(encoder, normalized, '', []);
  let field = '__void_form_data';
  while (encoder.form.has(field)) {
    field += '_';
  }
  // Keep ordinary fields readable by handlers that use Hono's parseBody().
  encoder.form.append(field, JSON.stringify({ data, files: encoder.files }));
  return { body: encoder.form, headers: { [FORM_DATA_HEADER]: field } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function decodeFormData(form: FormData, field: string): unknown {
  const metadata = form.getAll(field);
  if (metadata.length !== 1 || typeof metadata[0] !== 'string') {
    throw new Error('Invalid form metadata');
  }
  const envelope: unknown = JSON.parse(metadata[0]);
  if (!isRecord(envelope) || !Object.hasOwn(envelope, 'data') || !Array.isArray(envelope.files)) {
    throw new Error('Invalid form metadata');
  }
  const values = Array.from(form.values());
  for (const reference of envelope.files) {
    if (
      !isRecord(reference) ||
      !Array.isArray(reference.path) ||
      !reference.path.every((part): part is string => typeof part === 'string') ||
      typeof reference.index !== 'number' ||
      !Number.isSafeInteger(reference.index) ||
      reference.index < 0 ||
      !(values[reference.index] instanceof File)
    ) {
      throw new Error('Invalid form file reference');
    }
    if (reference.path.length === 0) {
      if (envelope.data !== null) {
        throw new Error('Invalid form file placeholder');
      }
      envelope.data = values[reference.index];
      continue;
    }
    let target: unknown = envelope.data;
    for (const [index, key] of reference.path.entries()) {
      if (target === null || typeof target !== 'object' || !Object.hasOwn(target, key)) {
        throw new Error('Invalid form file path');
      }
      const descriptor = Object.getOwnPropertyDescriptor(target, key)!;
      if (index === reference.path.length - 1) {
        if (descriptor.value !== null) {
          throw new Error('Invalid form file placeholder');
        }
        Object.defineProperty(target, key, { ...descriptor, value: values[reference.index] });
      } else {
        target = descriptor.value;
      }
    }
  }
  return envelope.data;
}
