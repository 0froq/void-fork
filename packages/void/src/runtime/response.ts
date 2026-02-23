/**
 * Convert a handler's return value to a Web Response.
 *
 * - Response → passthrough
 * - null/undefined → 204 No Content
 * - string → text/html
 * - object/array → JSON
 */
export function convertReturnValue(value: unknown): Response {
  if (value instanceof Response) {
    return value;
  }

  if (value === null || value === undefined) {
    return new Response(null, { status: 204 });
  }

  if (typeof value === "string") {
    return new Response(value, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  // object, array, number, boolean → JSON
  return Response.json(value);
}
