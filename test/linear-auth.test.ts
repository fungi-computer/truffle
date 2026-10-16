import { stripVTControlCharacters } from "node:util";
import { PassThrough } from "node:stream";
import type { AuthEvent } from "@earendil-works/pi-ai";
import { Cli } from "@fungi.computer/lantern";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { linearAuthInteraction } from "../src/linear-auth.js";

beforeEach(() => {
  vi.stubEnv("TERM", "xterm-256color");
  vi.stubEnv("NO_COLOR", undefined);
});
afterEach(() => vi.unstubAllEnvs());

/** Matches `auth-cli.ts#login`'s own augmentation of the `auth_url` event. */
type AuthUrlNotice = Extract<AuthEvent, { type: "auth_url" }> & {
  readonly providerLabel?: string;
};

const openaiAuthorizeUrl =
  "https://auth.openai.com/api/accounts/authorize?client_id=dynamic_agent_client&agent_name_hint=Shiitake&ext_agent_host_id=urn%3Auuid%3A00000000-0000-0000-0000-000000000000&response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fauth%2Fcallback&resource=https%3A%2F%2Fapi.openai.com%2Fv1&scope=openid+profile+email+offline_access+resource.invoke+chatgpt.tokens.use.direct&state=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ&code_challenge=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0123&code_challenge_method=S256&nonce=zyxwvutsrqponmlkjihgfedcba9876543210";

function harness(interactive: boolean) {
  const output = new PassThrough();
  let transcript = "";
  output.on("data", (chunk: Buffer) => {
    transcript += chunk.toString();
  });
  const cli = new Cli({ brand: "fungi-local-auth", output, interactive });
  return { cli, transcript: () => transcript };
}

describe("linearAuthInteraction auth_url notice", () => {
  it("prints the sign-in URL as one whole, copyable line with a heading and instructions", () => {
    const { cli, transcript } = harness(true);
    const notice: AuthUrlNotice = {
      type: "auth_url",
      url: openaiAuthorizeUrl,
      instructions:
        "Complete sign-in in your browser. If the callback does not complete, paste the final redirect URL here.",
      providerLabel: "OpenAI",
    };
    linearAuthInteraction(true, cli).notify(notice);
    const text = transcript();

    // The URL sits inside the prompt frame on one unbroken line: the frame
    // bar, then the whole URL, with no status symbol. (The hyperlink line
    // above also carries the URL inside its OSC 8 escape, so match the
    // line that ends with it.)
    const urlLines = stripVTControlCharacters(text)
      .split("\n")
      .filter((line) => line.endsWith(openaiAuthorizeUrl));
    expect(urlLines).toEqual([`│  ${openaiAuthorizeUrl}`]);

    expect(text).toContain("Sign in to OpenAI");
    expect(text).toContain("Waiting for the browser…");
    expect(text).toContain("Open sign-in page");
    expect(text).toContain(
      "Complete sign-in in your browser. If the callback does not complete, paste the final redirect URL here.",
    );
  });

  it("falls back to a generic heading and default instructions without a provider label", () => {
    const { cli, transcript } = harness(false);
    const notice: AuthUrlNotice = { type: "auth_url", url: openaiAuthorizeUrl };
    linearAuthInteraction(false, cli).notify(notice);
    const text = transcript();

    const urlLine = text
      .split("\n")
      .find((line) => line === openaiAuthorizeUrl);
    expect(urlLine).toBe(openaiAuthorizeUrl);
    expect(text).toContain("Sign in\n");
    expect(text).not.toContain("Sign in to");
    expect(text).toContain(
      "Waiting for the browser… If it doesn't return, paste the final redirect URL here.",
    );
  });

  it("hyperlinks the sign-in label only in an interactive terminal", () => {
    const interactive = harness(true);
    const notice: AuthUrlNotice = {
      type: "auth_url",
      url: openaiAuthorizeUrl,
      providerLabel: "OpenAI",
    };
    linearAuthInteraction(true, interactive.cli).notify(notice);
    const text = interactive.transcript();
    expect(text).toContain(
      `\u001B]8;;${openaiAuthorizeUrl}\u0007Open sign-in page`,
    );
    // The hyperlink line carries the whole URL inside its (invisible) OSC 8
    // escape, so it must be its own single-line clack message too — never a
    // continuation line that would pick up a "│ " gutter in front of it.
    const hyperlinkLine = text
      .split("\n")
      .find((line) => line.includes("\u001B]8;;"));
    expect(hyperlinkLine).toBeDefined();
    expect(hyperlinkLine?.startsWith("●")).toBe(true); // clack's info bullet
    expect(hyperlinkLine).not.toContain("│"); // never a continuation gutter

    const piped = harness(false);
    linearAuthInteraction(false, piped.cli).notify(notice);
    expect(piped.transcript()).not.toContain("\u001B]8;;");
    expect(piped.transcript()).toContain("Open sign-in page");
  });
});
