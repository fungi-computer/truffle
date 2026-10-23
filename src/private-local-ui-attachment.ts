import { AsyncLocalStorage } from "node:async_hooks";
import type { Json } from "@fungi.computer/shiitake/extensions";
import { z } from "zod";

export const localUiAttachmentLifetimeSchema = z.enum(["watch", "connection"]);
export type LocalUiAttachmentLifetime = z.infer<
  typeof localUiAttachmentLifetimeSchema
>;

/** Host-held authority; a JSON identity or pending id cannot create one. */
export type LocalUiAttachment = Readonly<{
  sessionId: string;
  signal: AbortSignal;
  close: () => void;
}>;
const attachments = new WeakMap<
  LocalUiAttachment,
  { watches: number; lifetime: LocalUiAttachmentLifetime }
>();

export function createLocalUiAttachment(
  sessionId: string,
  lifetime: LocalUiAttachmentLifetime = "watch",
): LocalUiAttachment {
  const controller = new AbortController();
  const attachment: LocalUiAttachment = {
    sessionId,
    signal: controller.signal,
    close: () => {
      attachments.delete(attachment);
      controller.abort();
    },
  };
  attachments.set(attachment, { watches: 0, lifetime });
  return attachment;
}

export function startLocalUiWatch(
  attachment: LocalUiAttachment,
  sessionId: string,
): (() => void) | undefined {
  const state = attachments.get(attachment);
  if (state === undefined || attachment.sessionId !== sessionId)
    return undefined;
  state.watches += 1;
  let watching = true;
  return () => {
    if (!watching) return;
    watching = false;
    state.watches -= 1;
    // TUI/form authority is watch-scoped. ACP closes each prompt's watch,
    // but its host-issued route belongs to the retained connection binding.
    if (state.lifetime === "watch") attachment.close();
  };
}

type UiCommand = {
  attachment: LocalUiAttachment;
  sessionId: string;
  available: boolean;
  complete?: (committed: boolean) => Promise<Json>;
};
const commands = new AsyncLocalStorage<UiCommand>();

function isAttached(command: UiCommand): boolean {
  return (
    command.attachment.sessionId === command.sessionId &&
    (attachments.get(command.attachment)?.watches ?? 0) > 0
  );
}

/** Authority lasts for one command, not model work that might wake later. */
export function runLocalUiCommand(
  attachment: LocalUiAttachment,
  sessionId: string,
  body: () => Promise<Json>,
): Promise<Json> {
  const command: UiCommand = { attachment, sessionId, available: true };
  return commands.run(command, async () => {
    let result: Json;
    try {
      result = await body();
    } catch (cause) {
      command.available = false;
      await command.complete?.(false);
      throw cause;
    }
    command.available = false;
    return command.complete === undefined
      ? result
      : command.complete(isAttached(command));
  });
}

/** Consume host authority before registering the post-commit continuation. */
export function consumeLocalUiCommand(
  sessionId: string,
): ((complete: (committed: boolean) => Promise<Json>) => void) | undefined {
  const command = commands.getStore();
  if (
    command === undefined ||
    !command.available ||
    command.sessionId !== sessionId ||
    !isAttached(command)
  )
    return undefined;
  command.available = false;
  return (complete) => {
    command.complete = complete;
  };
}
