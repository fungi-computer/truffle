import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("Local composes conversation agents from the shared extensions, not Oyster", () => {
  const source = readFileSync(
    new URL("../src/private-local-agent-control.ts", import.meta.url),
    "utf8",
  );
  expect(source).not.toContain("@fungi.computer/oyster");
  expect(source).toContain(
    "@fungi.computer/shiitake-extensions/roster/conversation-agents",
  );
});
