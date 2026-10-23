/** Local HTTP response budget, checked before text/JSON/schema decoding. */
export async function readBoundedResponse(
  response: Response,
  maximumBytes: number,
  description: string,
): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const declaredBytes = Number(declared);
    if (
      !Number.isSafeInteger(declaredBytes) ||
      declaredBytes < 0 ||
      declaredBytes > maximumBytes
    )
      throw new Error(`${description} response is too large`);
  }
  if (response.body === null)
    throw new Error(`${description} returned no body`);
  const stream = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>(),
  );
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const bytes = next.value;
      size += bytes.byteLength;
      if (size > maximumBytes) {
        await reader.cancel();
        throw new Error(`${description} response is too large`);
      }
      chunks.push(bytes);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}
