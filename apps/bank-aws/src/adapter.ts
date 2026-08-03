// Lambda Function URL (payload format 2.0) <-> web-standard Request/Response.
//
// Fidelity rules that the bank's signed-request auth depends on:
// - The URL handed to the router must be the ORIGINAL viewer URL: rawPath +
//   rawQueryString verbatim (authdocs sign pathname + query), and the host
//   from x-forwarded-host when CloudFront injected it (the Function URL host
//   is an implementation detail).
// - Bodies must reach the handler byte-for-byte (body_sha256 binding), so
//   base64 event bodies are decoded, and responses are always base64-encoded
//   on the way out — Function URLs deliver them verbatim.

export type FunctionUrlEvent = {
  rawPath: string;
  rawQueryString?: string;
  headers?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
  requestContext: { http: { method: string } };
};

export type FunctionUrlResult = {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  isBase64Encoded: boolean;
};

const BODYLESS_METHODS = new Set(['GET', 'HEAD']);

export function eventToRequest(event: FunctionUrlEvent): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(event.headers ?? {})) {
    if (v !== undefined) headers.set(k, v);
  }
  const proto = headers.get('x-forwarded-proto') ?? 'https';
  const host = headers.get('x-forwarded-host') ?? headers.get('host') ?? 'localhost';
  const qs = event.rawQueryString ? `?${event.rawQueryString}` : '';
  const url = `${proto}://${host}${event.rawPath}${qs}`;
  const method = event.requestContext.http.method.toUpperCase();

  let body: Uint8Array<ArrayBuffer> | string | undefined;
  if (event.body !== undefined && !BODYLESS_METHODS.has(method)) {
    body = event.isBase64Encoded
      ? Uint8Array.from(Buffer.from(event.body, 'base64'))
      : event.body;
  }
  return new Request(url, { method, headers, body });
}

export async function responseToResult(response: Response): Promise<FunctionUrlResult> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  return {
    statusCode: response.status,
    headers,
    body: Buffer.from(bytes).toString('base64'),
    isBase64Encoded: true,
  };
}
