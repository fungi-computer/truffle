/** The Team MCP address is HTTPS, except for an exact loopback host. */
export function parseFungiMcpEndpoint(value: string | URL): URL {
  const endpoint = new URL(value);
  const loopback =
    endpoint.hostname === "localhost" ||
    endpoint.hostname === "127.0.0.1" ||
    endpoint.hostname === "[::1]";
  if (
    !(
      endpoint.protocol === "https:" ||
      (endpoint.protocol === "http:" && loopback)
    ) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error(
      "Fungi MCP requires HTTPS (or HTTP on an exact loopback host) without URL credentials, query or fragment",
    );
  return endpoint;
}
