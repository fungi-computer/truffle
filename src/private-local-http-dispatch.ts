export type RequestIdleClock = {
  timeout: (request: Request, seconds: number) => void;
};

/** Bun's socket clock must stay off while a command or quiet SSE is pending. */
export async function dispatchPrivateLocalRequest(
  request: Request,
  clock: RequestIdleClock,
  fetch: (request: Request) => Response | Promise<Response>,
): Promise<Response> {
  clock.timeout(request, 0);
  try {
    const response = await fetch(request);
    if (!response.headers.get("content-type")?.startsWith("text/event-stream"))
      clock.timeout(request, 10);
    return response;
  } catch (cause) {
    clock.timeout(request, 10);
    throw cause;
  }
}
