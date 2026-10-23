import { expect, it } from "vitest";
import { fauxModelSource, memoryHost } from "@fungi.computer/shiitake/testing";
import { createMcpFormSession } from "../src/private-mcp-form-session.js";
import {
  consumeLocalUiCommand,
  createLocalUiAttachment,
  runLocalUiCommand,
} from "../src/private-local-ui-attachment.js";

it("the TUI's default watch-scoped attachment still closes with its Session watch", async () => {
  const host = await memoryHost({ model: fauxModelSource([]) });
  const sessionId = await host.agent.createSession("tui-watch-lifetime");
  const attachment = createLocalUiAttachment(sessionId);
  const session = createMcpFormSession().bindSession(
    sessionId,
    host.agent.session(sessionId),
    attachment,
  );
  try {
    const watch = await session.watch();
    expect(attachment.signal.aborted).toBe(false);
    await watch.close();
    expect(attachment.signal.aborted).toBe(true);
  } finally {
    attachment.close();
    await host.close();
  }
});

it("an ACP connection-scoped attachment survives consecutive prompt watches until its connection closes", async () => {
  const host = await memoryHost({ model: fauxModelSource([]) });
  const sessionId = await host.agent.createSession("acp-watch-lifetime");
  const attachment = createLocalUiAttachment(sessionId, "connection");
  const session = createMcpFormSession().bindSession(
    sessionId,
    host.agent.session(sessionId),
    attachment,
  );
  const authority = () =>
    runLocalUiCommand(attachment, sessionId, () =>
      Promise.resolve({
        attached: consumeLocalUiCommand(sessionId) !== undefined,
      }),
    );
  try {
    const first = await session.watch();
    await first.close();
    expect(attachment.signal.aborted).toBe(false);
    expect(await authority()).toEqual({ attached: false });
    const second = await session.watch();
    // Closing an already released first watch must not revoke a later watch.
    await first.close();
    expect(attachment.signal.aborted).toBe(false);
    expect(await authority()).toEqual({ attached: true });
    const observer = await session.watch();
    await second.close();
    expect(attachment.signal.aborted).toBe(false);
    expect(await authority()).toEqual({ attached: true });
    await observer.close();
    expect(await authority()).toEqual({ attached: false });
    attachment.close();
    expect(attachment.signal.aborted).toBe(true);
  } finally {
    attachment.close();
    await host.close();
  }
});
