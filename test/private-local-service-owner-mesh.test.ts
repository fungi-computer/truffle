import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { expect, it } from "vitest";
import type {
  PostDeliveryResult,
  PostEnvelope,
} from "@fungi.computer/carrier/post";
import type { ShiitakeSession } from "@fungi.computer/shiitake";
import type { BirdDogMail } from "@fungi.computer/bird-dog";
import { createLocalMeshLinks } from "../src/private-local-mesh-links.js";
import { createLocalServiceOwners } from "../src/private-local-service-owner.js";
import type { PrivateLocalMailRouting } from "../src/private-local-delegation.js";
import type { EnrolledLocalMachine } from "../src/private-local-mesh-links.js";
import type { OpenLocalServiceRuntime } from "../src/private-local-service-owner.js";
import {
  fixtureEffectiveModel,
  fixtureMailControls,
  fixtureModelControls,
} from "./fixtures/effective-model.js";
import { unusedExtensions } from "./fixtures/unused-extensions.js";

it("forwards a mesh Held receipt through the Local service owner's mail route", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-service-owner-held-"));
  const databasePath = join(
    root,
    ".fungi",
    "agents",
    "local_store_parent",
    "agent.sqlite",
  );
  await mkdir(dirname(databasePath), { recursive: true });
  await writeFile(databasePath, "fixture");
  const record: EnrolledLocalMachine = {
    state: "enrolled",
    requestId: "enrollment",
    invocationRoot: root,
    machineLabel: "Remote",
    target: { kind: "oyster" },
    scopeId: "team",
    deviceId: "machine",
    publicKey: "A".repeat(44),
    privateKey: "fixture-key",
    agents: [
      { localAgentId: "local_store_parent", databasePath, name: "Parent" },
    ],
    bindings: [{ selection: 0, agentId: "local_store_parent" }],
    authority: { kind: "oyster", origin: "https://oyster.example" },
  };
  const held = {
    status: "held",
    reason: "recipient_offline",
    message: "waiting: recipient offline",
  } as const;
  const meshResult: PostDeliveryResult = {
    status: "accepted",
    receipt: held,
  };
  let delivered: PostEnvelope | undefined;
  const deliveries: PostEnvelope[] = [];
  const createdSessions = new Map<string, string>();
  const acceptedCommands = new Map<string, string>();
  const acceptedMails: BirdDogMail[] = [];
  let receiveMesh:
    | ((
        record: EnrolledLocalMachine,
        envelope: PostEnvelope,
      ) => Promise<PostDeliveryResult>)
    | undefined;
  let routing: PrivateLocalMailRouting | undefined;

  const meshLinksFactory: typeof createLocalMeshLinks = ({ receive }) => {
    receiveMesh = receive;
    return {
      refresh: async () => {
        await receive(record, {
          key: "remote-directory",
          kind: "machineDirectory",
          address: { teamId: record.scopeId, deviceId: record.deviceId },
          event: { agents: [{ agentId: "remote-child", name: "Child" }] },
        });
      },
      isCurrent: () => Promise.resolve(true),
      deliver: (_record, envelope) => {
        delivered = envelope;
        deliveries.push(envelope);
        return Promise.resolve(meshResult);
      },
      close: () => Promise.resolve(),
    };
  };
  const openRuntime: OpenLocalServiceRuntime = (options) => {
    routing = options.mail;
    const agentId = basename(dirname(options.databasePath ?? databasePath));
    return Promise.resolve({
      databasePath: options.databasePath ?? databasePath,
      agentId,
      name: agentId,
      listSessions: () => Promise.resolve({ sessions: [], next: undefined }),
      createSession: (requestId) => {
        const sessionId =
          createdSessions.get(requestId) ?? `session-${requestId}`;
        createdSessions.set(requestId, sessionId);
        return Promise.resolve(sessionId);
      },
      deleteSession: () => Promise.resolve(false),
      extensions: unusedExtensions,
      effectiveModel: fixtureEffectiveModel,
      ...fixtureModelControls,
      ...fixtureMailControls,
      acceptMail: (mail) => {
        const sessionId =
          mail.to.sessionId ??
          createdSessions.get(mail.key) ??
          `session-${mail.key}`;
        createdSessions.set(mail.key, sessionId);
        const addressed = { ...mail, to: { ...mail.to, sessionId } };
        acceptedMails.push(addressed);
        const commandId =
          acceptedCommands.get(mail.key) ?? `command-${mail.key}`;
        acceptedCommands.set(mail.key, commandId);
        return Promise.resolve({ status: "accepted", commandId, sessionId });
      },
      getSession: (sessionId: string) =>
        // SAFETY: The fixture observes only the Session address.
        ({ address: `session:${sessionId}` }) as ShiitakeSession,
      bindSessionPath: () => true,
      close: () => Promise.resolve(),
    });
  };

  const owners = createLocalServiceOwners(
    openRuntime,
    undefined,
    undefined,
    60_000,
    undefined,
    undefined,
    {
      home: root,
      credentialPath: join(root, "credentials.json"),
      serviceDirectory: join(root, ".fungi", "service"),
    },
    meshLinksFactory,
  );
  try {
    await owners.select({
      invocationRoot: root,
      databasePath,
      sessionId: "main",
    });
    await owners.refreshMesh();
    if (routing === undefined)
      throw new Error("Local mail routing was not installed");
    await expect(
      routing.deliver({
        key: "request-key",
        from: {
          kind: "agent",
          agentId: "local_store_parent",
          sessionId: "parent-session",
        },
        to: {
          kind: "agent",
          agentId: "remote-child",
          sessionId: "child-session",
        },
        replyTo: [],
        content: "Work",
        createdAt: 1,
      }),
    ).resolves.toEqual(held);
    expect(delivered).toMatchObject({
      key: "request-key",
      kind: "agentMail",
      address: { scopeId: "team", agentId: "remote-child" },
      event: {
        key: "request-key",
        to: { agentId: "remote-child", sessionId: "child-session" },
      },
    });
    if (receiveMesh === undefined)
      throw new Error("Local mesh receiver was not installed");
    const inbound: BirdDogMail = {
      key: "mail-without-session",
      to: { kind: "agent", agentId: "local_store_parent" },
      from: {
        kind: "agent",
        agentId: "remote-child",
        sessionId: "remote-session",
      },
      replyTo: [
        {
          kind: "agent",
          agentId: "remote-child",
          sessionId: "remote-session",
        },
      ],
      content: "Work",
      createdAt: 2,
    };
    const envelope: PostEnvelope = {
      key: inbound.key,
      kind: "agentMail",
      address: { scopeId: "team", agentId: "local_store_parent" },
      event: inbound,
    };
    await expect(receiveMesh(record, envelope)).resolves.toMatchObject({
      status: "accepted",
      receipt: {
        status: "accepted",
        commandId: "command-mail-without-session",
        sessionId: "session-mail-without-session",
      },
    });
    await expect(receiveMesh(record, envelope)).resolves.toMatchObject({
      status: "accepted",
      receipt: {
        status: "accepted",
        commandId: "command-mail-without-session",
        sessionId: "session-mail-without-session",
      },
    });
    expect(createdSessions).toEqual(
      new Map([["mail-without-session", "session-mail-without-session"]]),
    );
    expect(acceptedCommands).toEqual(
      new Map([["mail-without-session", "command-mail-without-session"]]),
    );
    expect(acceptedMails).toHaveLength(2);
    expect(acceptedMails.map(({ to }) => to.sessionId)).toEqual([
      "session-mail-without-session",
      "session-mail-without-session",
    ]);
    expect(deliveries).toHaveLength(1);
  } finally {
    await owners.close();
    await rm(root, { recursive: true });
  }
});
