import { lstat, mkdir, readFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import semver from "semver";
import writeFileAtomic from "write-file-atomic";
import { z } from "zod";
import {
  acquireNodeStoreLease,
  type NodeStoreLease,
} from "@fungi.computer/shiitake/node";
import { ShiitakeError } from "@fungi.computer/shiitake";
import { upgradeWoodstockStore } from "@fungi.computer/shiitake/effect";
import { privateSqliteFailureCode } from "./private-sqlite-failure.js";
import {
  createPrivateSqliteOwner,
  openPrivateWritableSqliteDatabase,
  storeWriteBusyTimeoutMs,
} from "./private-sqlite-owner.js";
import { upgradeLocalIdentity } from "./private-local-identity.js";
import { incompatibleLocalExtensionActivations } from "./private-local-extension-records.js";
import {
  createPrivateLocalServiceManager,
  LocalServiceUpdated,
} from "./private-local-service.js";
import { readInstalledLocalClientBuildId } from "./private-local-client-version.js";
import type { PrivateLocalServiceStopResult } from "./private-local-service-contract.js";
import {
  LocalStoreSchemaError,
  probePrivateLocalAgentStoreEntries,
  readPrivateLocalAgentProfile,
} from "./private-local-session-discovery.js";
import {
  assertNoUntrackedServiceOwner,
  privateLocalServiceVersion,
  readServiceRegistration,
  serviceOwnerIsLive,
} from "./private-local-service-discovery.js";

const version = z
  .string()
  .refine((value) => semver.valid(value) !== null, "Invalid semver version");
const versionMarkerSchema = z.strictObject({
  version: z.literal(1),
  release: version,
  spore: version,
  build: z.union([z.literal("source"), z.string().regex(/^[a-f0-9]{64}$/u)]),
});
const newsSchema = z.strictObject({
  release: versionMarkerSchema.shape.release,
  lines: z.array(z.string().max(120)).max(3),
});

export type PriorInstall =
  | Readonly<{ kind: "recorded"; release: string; spore: string }>
  | Readonly<{ kind: "protocol"; protocol: number; build: string }>
  | Readonly<{ kind: "unrecorded" }>;

const markerPath = (home: string) => join(home, ".fungi", "version.json");
const pendingPath = (home: string) =>
  join(home, ".fungi", ".upgrade-in-progress.json");
const pendingSchema = z.strictObject({
  version: z.literal(1),
  prior: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("recorded"),
      release: version,
      spore: version,
    }),
    z.strictObject({
      kind: z.literal("protocol"),
      protocol: z.number().int().nonnegative(),
      build: z.string().min(1),
    }),
    z.strictObject({ kind: z.literal("unrecorded") }),
  ]),
});

/** Persist prior identity before stop removes the only protocol-3 record. */
async function readPendingUpgrade(
  home: string,
): Promise<PriorInstall | undefined> {
  const path = pendingPath(home);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return undefined;
    throw new Error(`Cannot read the in-progress Fungi upgrade at ${path}`, {
      cause,
    });
  }
  try {
    return pendingSchema.parse(JSON.parse(text)).prior;
  } catch (cause) {
    throw new Error(
      `Cannot resume the Fungi upgrade at ${path}: inspect or move this marker aside before retrying`,
      { cause },
    );
  }
}

async function writePendingUpgrade(
  home: string,
  prior: PriorInstall,
): Promise<void> {
  await writeFileAtomic(
    pendingPath(home),
    `${JSON.stringify(pendingSchema.parse({ version: 1, prior }))}\n`,
    { mode: 0o600 },
  );
}

/** A completed version marker supersedes a pending pass left after its write. */
function pendingIsComplete(
  recorded: PriorInstall,
  pending: PriorInstall,
): boolean {
  return (
    recorded.kind === "recorded" &&
    (pending.kind !== "recorded" ||
      recorded.release !== pending.release ||
      recorded.spore !== pending.spore)
  );
}

/** Version marker is a label, not permission to accept an older store schema. */
export async function readPriorInstall(home: string): Promise<PriorInstall> {
  const path = markerPath(home);
  let text: string | undefined;
  try {
    text = await readFile(path, "utf8");
  } catch (cause) {
    if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT"))
      throw cause;
  }
  if (text !== undefined) {
    try {
      const marker = versionMarkerSchema.parse(JSON.parse(text));
      return { kind: "recorded", release: marker.release, spore: marker.spore };
    } catch (cause) {
      throw new Error(`Cannot read ${path}: unsupported Fungi version marker`, {
        cause,
      });
    }
  }
  const registration = await readServiceRegistration(
    join(home, ".fungi", "service"),
  );
  if (registration?.kind === "other-protocol")
    return {
      kind: "protocol",
      protocol: registration.lifecycle.protocol,
      build: registration.lifecycle.version,
    };
  return { kind: "unrecorded" };
}

/** Only the completed upgrade pass calls this writer; never write it early. */
export async function writeLocalVersionMarker(
  home: string,
  marker: Omit<z.input<typeof versionMarkerSchema>, "version">,
): Promise<void> {
  const path = markerPath(home);
  const record = versionMarkerSchema.parse({ version: 1, ...marker });
  await mkdir(join(home, ".fungi"), { recursive: true, mode: 0o700 });
  await writeFileAtomic(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

export type LocalUpgradeOptions = Readonly<{
  home?: string;
  directory?: string;
  signal?: AbortSignal;
  /** The package's generated, changelog-checked asset beside its CLI. */
  newsPath: string;
  spore: string;
  /** Tests may supply the same bounded stop contract as the real manager. */
  stopService?: (
    expectedServiceId?: string,
  ) => Promise<PrivateLocalServiceStopResult>;
  /** Override only for an isolated proof of the installed-client identity. */
  installedClientBuildId?: () => Promise<string | undefined>;
}>;

/** Invalid news lines are optional; a missing release label is not safe to mark current. */
export async function readLocalUpgradeNews(path: string) {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  const release = z
    .looseObject({ release: versionMarkerSchema.shape.release })
    .parse(value).release;
  return {
    release,
    lines: newsSchema.safeParse(value).data?.lines ?? [],
  };
}

export type ArchivedArtifact = Readonly<{
  kind: "extension-activations";
  from: string;
  to: string;
}>;
export type LocalUpgradeReport = Readonly<{
  from: PriorInstall;
  to: string;
  service: "stopped" | "killed" | "absent";
  archive: string | undefined;
  archived: readonly ArchivedArtifact[];
  whatsNew: readonly string[];
}>;
export type LocalUpgradeOutcome =
  | Readonly<{ kind: "current" }>
  | Readonly<{ kind: "upgraded"; report: LocalUpgradeReport }>;

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return false;
    throw cause;
  }
}

function archiveSlug(prior: PriorInstall): string {
  if (prior.kind === "recorded") return prior.release;
  if (prior.kind === "unrecorded") return "unversioned";
  const build = prior.build.slice(0, 12);
  return `protocol-${String(prior.protocol)}-${/^[a-f0-9]{12}$/u.test(build) ? build : "source"}`;
}

type IncompatibleArtifact = Readonly<{
  kind: ArchivedArtifact["kind"];
  from: string;
  name: string;
  folder: "extensions";
}>;

async function surveyIncompatibleLocalHome(
  home: string,
): Promise<IncompatibleArtifact[]> {
  const incompatible: IncompatibleArtifact[] = [];
  for (const path of await incompatibleLocalExtensionActivations(home))
    incompatible.push({
      kind: "extension-activations",
      from: path,
      name: "activations.json",
      folder: "extensions",
    });
  return incompatible;
}

async function archiveDestination(
  item: IncompatibleArtifact,
  archive: string,
): Promise<string> {
  const directory = join(archive, item.folder);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const suffix of ["", "-2", "-3", "-4", "-5", "-6", "-7", "-8", "-9"]) {
    const candidate = join(directory, `${item.name}${suffix}`);
    if (!(await exists(candidate))) return candidate;
  }
  throw new Error(
    `Cannot archive ${item.from} under ${directory}: all destinations exist`,
  );
}

async function moveToArchive(
  item: IncompatibleArtifact,
  archive: string,
): Promise<ArchivedArtifact> {
  const destination = await archiveDestination(item, archive);
  try {
    await rename(item.from, destination);
  } catch (cause) {
    throw new Error(`Cannot archive ${item.from} to ${destination}`, {
      cause,
    });
  }
  return { kind: item.kind, from: item.from, to: destination };
}

/** Take the host's own lease on a store; a live owner keeps it and nothing moves. */
function acquireStoreLeaseUnlessBusy(
  databasePath: string,
): NodeStoreLease | undefined {
  try {
    return acquireNodeStoreLease(`${databasePath}.owner.sqlite`);
  } catch (cause) {
    const code = privateSqliteFailureCode(cause);
    if (code === "busy" || code === "locked") return undefined;
    throw cause;
  }
}

async function archiveArtifacts(
  incompatible: readonly IncompatibleArtifact[],
  archive: string,
  signal?: AbortSignal,
): Promise<ArchivedArtifact[]> {
  const archived: ArchivedArtifact[] = [];
  for (const item of incompatible) {
    signal?.throwIfAborted();
    archived.push(await moveToArchive(item, archive));
  }
  return archived;
}

/** Folder stores never move: successful upgrades and typed in-place refusals. */
export type LocalFolderUpgradeReport = Readonly<{
  upgraded: readonly string[];
  refused: readonly LocalStoreSchemaError[];
}>;

type FolderStore = Readonly<{
  entry: string;
  databasePath: string;
}>;

/** Upgrade one store's data in place, rolling back a failed migration. */
function upgradeStoreInPlace(databasePath: string): "upgraded" | "unchanged" {
  const database = openPrivateWritableSqliteDatabase(
    databasePath,
    storeWriteBusyTimeoutMs,
  );
  try {
    const owner = createPrivateSqliteOwner(database);
    return owner.transactionSync(() => {
      const identity = upgradeLocalIdentity(database);
      const woodstock = upgradeWoodstockStore(owner);
      return identity || woodstock === "upgraded" ? "upgraded" : "unchanged";
    });
  } catch (cause) {
    if (
      cause instanceof ShiitakeError &&
      cause.boundary === "store" &&
      cause.cause === "incompatible"
    )
      throw new LocalStoreSchemaError(databasePath, "unreadable", { cause });
    throw cause;
  } finally {
    database.close();
  }
}

/** Refuse before taking a write lease; recheck under that lease before upgrading. */
async function settleFolderStore(
  store: FolderStore,
): Promise<Readonly<{ upgraded?: string; refusal?: LocalStoreSchemaError }>> {
  let lease: NodeStoreLease | undefined;
  try {
    readPrivateLocalAgentProfile(store.databasePath);
    // A link and its target remain under the target owner's custody.
    if ((await lstat(store.entry)).isSymbolicLink()) return {};
    lease = acquireStoreLeaseUnlessBusy(store.databasePath);
    if (lease === undefined) return {};
    readPrivateLocalAgentProfile(store.databasePath);
    return upgradeStoreInPlace(store.databasePath) === "upgraded"
      ? { upgraded: store.entry }
      : {};
  } catch (cause) {
    const code = privateSqliteFailureCode(cause);
    if (code === "busy" || code === "locked") return {};
    return {
      refusal:
        cause instanceof LocalStoreSchemaError
          ? cause
          : new LocalStoreSchemaError(store.databasePath, "unreadable", {
              cause,
            }),
    };
  } finally {
    lease?.release();
  }
}

/**
 * Folder stores have their own lifetime, independent of the home release
 * marker. Each Agent store is upgraded in place so its Agent and history stay
 * usable. Refused stores remain exactly where they were, never archived.
 */
export async function upgradeLocalFolder(
  folder: string,
  signal?: AbortSignal,
): Promise<LocalFolderUpgradeReport> {
  const root = join(folder, ".fungi");
  if (!(await exists(join(root, "agents"))))
    return { refused: [], upgraded: [] };
  const release = await lockfile.lock(root, {
    lockfilePath: join(root, ".upgrade.lock"),
    realpath: false,
    stale: 30_000,
    update: 10_000,
    retries: { retries: 60, factor: 1.2, minTimeout: 25, maxTimeout: 250 },
  });
  try {
    signal?.throwIfAborted();
    const upgraded: string[] = [];
    const refused: LocalStoreSchemaError[] = [];
    for (const store of await probePrivateLocalAgentStoreEntries(folder)) {
      signal?.throwIfAborted();
      const result = await settleFolderStore(store);
      if (result.upgraded !== undefined) upgraded.push(result.upgraded);
      if (result.refusal !== undefined) refused.push(result.refusal);
    }
    return {
      refused,
      upgraded,
    };
  } finally {
    await release();
  }
}

/** Upgrade → service startup → extensions owner: this lock is always first. */
export async function upgradeLocalHome(
  options: LocalUpgradeOptions,
): Promise<LocalUpgradeOutcome> {
  const home = options.home ?? homedir();
  const spore = versionMarkerSchema.shape.spore.parse(options.spore);
  // A new empty home has no need to read a release artifact to use ordinary
  // commands. A recorded or running older installation needs its label.
  const recorded = await readPriorInstall(home);
  let news =
    recorded.kind === "unrecorded"
      ? undefined
      : await readLocalUpgradeNews(options.newsPath);
  const current = (prior: PriorInstall, release: string | undefined) =>
    prior.kind === "recorded" &&
    release !== undefined &&
    (semver.gt(prior.release, release) ||
      (semver.eq(prior.release, release) && semver.gte(prior.spore, spore)));
  if (current(recorded, news?.release)) return { kind: "current" };
  const root = join(home, ".fungi");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const release = await lockfile.lock(root, {
    lockfilePath: join(root, ".upgrade.lock"),
    realpath: false,
    stale: 30_000,
    update: 10_000,
    retries: { retries: 60, factor: 1.2, minTimeout: 25, maxTimeout: 250 },
  });
  try {
    options.signal?.throwIfAborted();
    const observed = await readPriorInstall(home);
    const pending = await readPendingUpgrade(home);
    const prior =
      pending !== undefined && !pendingIsComplete(observed, pending)
        ? pending
        : observed;
    if (prior.kind === "recorded") {
      news ??= await readLocalUpgradeNews(options.newsPath);
    }
    if (current(prior, news?.release)) return { kind: "current" };
    const directory = options.directory ?? join(root, "service");
    const registration = await readServiceRegistration(directory);
    if (
      prior.kind === "unrecorded" &&
      registration?.kind === "current" &&
      registration.record.version === privateLocalServiceVersion() &&
      (await surveyIncompatibleLocalHome(home)).length === 0
    )
      return { kind: "current" };
    if (prior.kind === "unrecorded" && registration === undefined) {
      const archive = join(root, "archive", archiveSlug(prior));
      if (
        (await surveyIncompatibleLocalHome(home)).length === 0 &&
        !(await exists(join(archive, "extensions", "activations.json")))
      )
        return { kind: "current" };
    }
    // The service stop removes service.json. Record its prior identity while
    // the upgrade lock still holds it, before any stop or archive rename.
    await writePendingUpgrade(home, prior);
    let service: LocalUpgradeReport["service"] = "absent";
    if (registration !== undefined) {
      // The upgrade is no bypass around the service's installed-client check.
      // An uninstalled or stale window cannot signal a different live build.
      if (
        (await exists(join(directory, "owner.sqlite"))) &&
        (await serviceOwnerIsLive(directory)) &&
        privateLocalServiceVersion() !==
          (await (
            options.installedClientBuildId ?? readInstalledLocalClientBuildId
          )())
      )
        throw new LocalServiceUpdated();
      const expectedId =
        registration.kind === "current"
          ? registration.record.serviceId
          : registration.kind === "other-protocol"
            ? registration.lifecycle.serviceId
            : undefined;
      const stop =
        options.stopService ??
        createPrivateLocalServiceManager({ home, directory }).stop;
      const stopped = await stop(expectedId);
      if (stopped.kind === "replaced")
        throw new Error(
          `The Fungi service in ${directory} changed during upgrade; retry before archiving`,
        );
      if (stopped.kind === "stopped" || stopped.kind === "killed")
        service = stopped.kind;
    }
    if (
      (await readServiceRegistration(directory)) !== undefined ||
      ((await exists(join(directory, "owner.sqlite"))) &&
        (await serviceOwnerIsLive(directory)))
    )
      throw new Error(
        `A Fungi service still owns ${directory}; no files were archived`,
      );
    await assertNoUntrackedServiceOwner(directory);
    const archive = join(root, "archive", archiveSlug(prior));
    const incompatible = await surveyIncompatibleLocalHome(home);
    // The installed-registry owner also uses archive/unversioned. Only our
    // own entries indicate an interrupted home upgrade to resume.
    const existingArchive = await exists(
      join(archive, "extensions", "activations.json"),
    );
    if (
      incompatible.length === 0 &&
      !existingArchive &&
      service === "absent" &&
      prior.kind === "unrecorded"
    ) {
      await unlink(pendingPath(home));
      return { kind: "current" };
    }
    news ??= await readLocalUpgradeNews(options.newsPath);
    const archived = await archiveArtifacts(
      incompatible,
      archive,
      options.signal,
    );
    await writeLocalVersionMarker(home, {
      release: news.release,
      spore,
      build: privateLocalServiceVersion(),
    });
    await unlink(pendingPath(home));
    return {
      kind: "upgraded",
      report: {
        from: prior,
        to: news.release,
        service,
        archive: archived.length > 0 || existingArchive ? archive : undefined,
        archived,
        whatsNew: news.lines,
      },
    };
  } finally {
    await release();
  }
}

export function formatLocalUpgradeNotice(
  report: LocalUpgradeReport,
): readonly string[] {
  const from =
    report.from.kind === "recorded"
      ? report.from.release
      : report.from.kind === "protocol"
        ? `an earlier Fungi (protocol ${String(report.from.protocol)})`
        : "an earlier Fungi";
  const lines = [`Upgraded ${from} → ${report.to}`];
  if (report.service === "stopped")
    lines.push("Stopped the old Fungi service.");
  if (report.service === "killed")
    lines.push("Stopped the old Fungi service after its exit deadline.");
  lines.push(...archiveLines(report));
  const news = report.whatsNew.slice(0, 3);
  if (news.length > 0)
    lines.push("What's new:", ...news.map((line) => `  • ${line}`));
  return lines;
}

/** The archive's own lines: what moved, where, and that nothing was deleted. */
function archiveLines(
  report: Pick<LocalUpgradeReport, "archive" | "archived">,
): readonly string[] {
  if (report.archive === undefined) return [];
  const activations = report.archived[0];
  return [
    report.archived.length === 0
      ? "The earlier archive is still at"
      : "Archived extension activations to",
    `  ${report.archive} (nothing was deleted)`,
    ...(activations !== undefined
      ? [`  Extension activations: ${activations.to}`]
      : []),
  ];
}

export function formatLocalFolderUpgradeNotice(
  report: LocalFolderUpgradeReport,
): readonly string[] {
  const upgraded = report.upgraded.length;
  return [
    ...(upgraded > 0
      ? [
          `Upgraded ${String(upgraded)} Agent ${upgraded === 1 ? "store" : "stores"} to this Fungi (nothing was lost)`,
        ]
      : []),
    ...report.refused.flatMap((refusal) => [
      refusal.message,
      `  ${refusal.databasePath}`,
    ]),
  ];
}
