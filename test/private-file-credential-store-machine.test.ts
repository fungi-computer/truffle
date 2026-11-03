import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createPrivateCredentialStore } from "../src/private-file-credential-store.js";
import type { LocalMachineEnrollment } from "../src/private-local-mesh-record.js";

const origin = "https://oyster.example";
const pending: LocalMachineEnrollment = {
  state: "pending",
  requestId: "machine_join_direct",
  target: { kind: "oyster" },
  invocationRoot: "/project",
  machineLabel: "Laptop",
  publicKey: "A".repeat(43) + "=",
  privateKey: "AAAA",
  agents: [],
};

it("modifies and removes one origin's standalone enrollments under the store lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "fungi-machine-store-"));
  try {
    const store = createPrivateCredentialStore(join(root, "credentials.json"));
    expect(await store.removeMachineEnrollments(origin)).toBe(false);
    await store.modifyMachineEnrollments(origin, (current) => {
      expect(current).toEqual([]);
      return [pending];
    });
    await store.modifyMachineEnrollments(origin, (current) => {
      expect(current).toEqual([pending]);
      return [...current];
    });
    expect(await store.readMachineEnrollments()).toEqual([
      { type: "machine_enrollment", origin, enrollments: [pending] },
    ]);
    expect(await store.removeMachineEnrollments(origin)).toBe(true);
    expect(await store.readMachineEnrollments()).toEqual([]);
    expect(await store.removeMachineEnrollments(origin)).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("keeps one origin's attached folders apart from credentials, enrollments and other origins", async () => {
  const root = await mkdtemp(join(tmpdir(), "fungi-local-backend-store-"));
  try {
    const store = createPrivateCredentialStore(join(root, "credentials.json"));
    const folder = {
      requestId: "local_attach_request_one",
      computerId: "computer_one",
      computerName: "cedar",
      rootPath: "/home/levi/notes",
      hostLabel: "Laptop",
      folderLabel: "notes",
      publicKey: "A".repeat(43) + "=",
      privateKey: "AAAA",
    };
    expect(await store.readLocalBackends(origin)).toEqual([]);
    await store.modifyLocalBackends(origin, (current) => {
      expect(current).toEqual([]);
      return [folder];
    });
    await store.modifyLocalBackends("https://other.example", () => [
      { ...folder, requestId: "local_attach_request_two" },
    ]);
    await store.modifyLocalBackends(origin, (current) =>
      current.map((record) => ({
        ...record,
        backendId: "local-aaaaaaaaaaaaaaaa",
      })),
    );
    expect(await store.readLocalBackends(origin)).toEqual([
      { ...folder, backendId: "local-aaaaaaaaaaaaaaaa" },
    ]);
    expect(
      (await store.readAllLocalBackends()).map((entry) => entry.origin).sort(),
    ).toEqual(["https://other.example", "https://oyster.example"]);
    // A private record is never a model credential or an enrollment.
    expect(await store.list()).toEqual([]);
    expect(await store.readMachineEnrollments()).toEqual([]);
    await store.modifyLocalBackends(origin, () => []);
    expect(await store.readLocalBackends(origin)).toEqual([]);
    expect(await store.readLocalBackends("https://other.example")).toHaveLength(
      1,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
