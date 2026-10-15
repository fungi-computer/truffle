/** Shared refusal for Fungi login refresh, model calls and MCP connections. */
export class FungiSignInRequiredError extends Error {
  override readonly name = "FungiSignInRequiredError";
  constructor(options?: ErrorOptions) {
    super("Sign in to Fungi again to use models and Computers", options);
  }
}
