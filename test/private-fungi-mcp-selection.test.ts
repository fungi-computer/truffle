import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPrivateCredentialStore } from "../src/private-file-credential-store.js";
import { readFungiMcpSelection } from "../src/private-fungi-mcp-selection.js";
import { fungiMcpSelectionSchema } from "../src/private-fungi-mcp-selection-schema.js";
import { privateFungiAccountOAuthProvider } from "../src/private-fungi-account.js";

describe("private hosted Computer OAuth selection", () => {
  it("uses the existing Local credential store for OAuth tokens", async () => {
    const root = await mkdtemp(join(tmpdir(), "fungi-mcp-oauth-"));
    const credentialPath = join(root, "credentials.json");
    const store = createPrivateCredentialStore(credentialPath);
    try {
      const provider = privateFungiAccountOAuthProvider({
        credentialPath,
        issuer: "https://hub.test",
      });
      await provider.saveClientInformation({
        client_id: "registered-local-client",
        redirect_uris: ["http://127.0.0.1:8765/oauth/callback"],
        token_endpoint_auth_method: "none",
      });
      await provider.saveTokens({
        access_token: "access-token",
        refresh_token: "refresh-token",
        token_type: "Bearer",
        expires_in: 60,
      });
      expect(await store.read("fungi")).toMatchObject({
        tokens: {
          access_token: "access-token",
          refresh_token: "refresh-token",
        },
      });
      const connection = readFungiMcpSelection(
        { endpoint: "https://hub.test/api/teams/team-1/mcp" },
        { credentialPath },
      );
      const tokens = await provider.tokens();
      expect(tokens).toMatchObject({
        access_token: "access-token",
        refresh_token: "refresh-token",
      });
      await expect(
        privateFungiAccountOAuthProvider({
          credentialPath,
          issuer: "https://other-hub.test",
        }).tokens(),
      ).rejects.toThrow("Saved Fungi OAuth tokens belong to another issuer");
      expect(connection.endpoint.href).toBe(
        "https://hub.test/api/teams/team-1/mcp",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects credentials supplied through the superseded bearer-file shape", () => {
    expect(
      fungiMcpSelectionSchema.safeParse({
        endpoint: "https://hub.test/api/teams/team-1/mcp",
        credentialFile: "/private/token",
      }).success,
    ).toBe(false);
  });

  it("rejects an HTTP endpoint", () => {
    expect(() =>
      readFungiMcpSelection({
        endpoint: "http://hub.test/api/teams/team-1/mcp",
      }),
    ).toThrow("Invalid Fungi MCP connection selection");
  });

  it.each([
    "http://localhost:8787/api/teams/team-1/mcp",
    "http://127.0.0.1:8787/api/teams/team-1/mcp",
    "http://[::1]:8787/api/teams/team-1/mcp",
  ])("accepts an exact loopback HTTP endpoint: %s", (endpoint) => {
    expect(fungiMcpSelectionSchema.safeParse({ endpoint }).success).toBe(true);
    expect(readFungiMcpSelection({ endpoint }).endpoint.href).toBe(endpoint);
  });

  it.each([
    "http://hub.test/api/teams/team-1/mcp",
    "http://localhost.evil.com/api/teams/team-1/mcp",
    "http://127.0.0.1.nip.io/api/teams/team-1/mcp",
    "http://user@localhost/api/teams/team-1/mcp",
    "http://user:pass@127.0.0.1/api/teams/team-1/mcp",
    "https://user:pass@hub.test/api/teams/team-1/mcp",
  ])("rejects an unsafe MCP endpoint: %s", (endpoint) => {
    expect(fungiMcpSelectionSchema.safeParse({ endpoint }).success).toBe(false);
  });
});
