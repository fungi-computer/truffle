import type { BirdDogMail } from "@fungi.computer/bird-dog";
import {
  BirdDogError,
  BirdDogMailSchema,
  make as makeBirdDog,
  type BirdDogEffect,
} from "@fungi.computer/bird-dog/effect";
import { createPost, definePostRoute } from "@fungi.computer/carrier/post";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { PrivateSqliteDatabase } from "./private-sqlite-owner.js";
import type {
  DelegationReceipt,
  ShiitakeOptions,
  SqliteOwner,
} from "@fungi.computer/shiitake";
import { messageAuthor } from "@fungi.computer/agar/agents";
import { z } from "zod";

export type PrivateLocalMailOptions = Readonly<{
  /** Admit one reply at its addressed Agent; a rejection retries later. */
  deliver: (mail: BirdDogMail) => Promise<DelegationReceipt>;
  scheduleWake?: (at: number) => void;
  now?: () => number;
}>;

/** Pending mail is existing Watchdog work, including retained future retries. */
export function hasPrivateLocalPendingMail(
  database: PrivateSqliteDatabase,
): Promise<boolean> {
  const row = z
    .object({ pending: z.union([z.literal(0), z.literal(1)]) })
    .parse(
      database
        .prepare(
          "SELECT EXISTS(SELECT 1 FROM watchdog_jobs WHERE lane='post' AND state IN ('queued','running','completing')) AS pending",
        )
        .get(),
    );
  return Promise.resolve(row.pending === 1);
}

/** Local uses Carrier's native Post rows and Shiitake's one delivery lane. */
export function createPrivateLocalMailRoom(
  owner: SqliteOwner,
  options: PrivateLocalMailOptions,
) {
  const now = options.now ?? Date.now;
  const routes = {
    mail: definePostRoute({
      addressKind: "local-agent",
      address: Schema.Struct({ agentId: Schema.String }),
      event: BirdDogMailSchema,
      name: ({ agentId }) => agentId,
      namespace: {
        getByName: (agentId) => ({
          deliver: async (envelope) => {
            const mail = Schema.decodeUnknownSync(BirdDogMailSchema)(
              envelope.event,
            );
            if (mail.to.agentId !== agentId)
              throw new BirdDogError(
                "Local mail recipient does not match its address",
              );
            await options.deliver(mail);
            return "accepted";
          },
        }),
      },
    }),
  };
  let post: ReturnType<typeof createPost<typeof routes>> | undefined;
  const runtime = () => {
    if (post === undefined) throw new BirdDogError("Local Post is not open");
    return post;
  };
  const mailRoom = Effect.runSync(
    makeBirdDog({
      now,
      stage: (mail) =>
        Effect.try({
          try: () => {
            owner.transactionSync(() => {
              for (const event of mail) {
                // The first staged letter retains its stable key and createdAt
                // when a settlement is replayed before its cursor advances.
                if (runtime().read(event.key) === undefined)
                  runtime().send({
                    key: event.key,
                    kind: "mail",
                    address: { agentId: event.to.agentId },
                    event,
                  });
              }
            });
            if (mail.length > 0) options.scheduleWake?.(now());
          },
          catch: (cause) =>
            new BirdDogError("Local mail staging is unavailable", { cause }),
        }),
    }),
  );
  return {
    room: {
      ...mailRoom,
      fanOut: (settlement) => {
        if (settlement.job.outcome !== "cancelled")
          return mailRoom.fanOut(settlement);
        const author = messageAuthor(settlement.meta);
        return mailRoom.fanOut({
          ...settlement,
          content:
            author === undefined
              ? "Work cancelled."
              : `Work cancelled by ${author.name}.`,
        });
      },
    },
    hostJobs: {
      lane: "post",
      open: (watchdog) => {
        post = createPost({
          owner,
          routes,
          transactional: watchdog.transactional,
          now,
          scheduleWake: (at) => {
            options.scheduleWake?.(at);
            return Promise.resolve();
          },
        });
        return {
          retryPolicy: (job) => runtime().retryPolicy(job),
          execute: (job, signal, attempt) =>
            runtime().execute(job, attempt, signal),
        };
      },
    },
  } satisfies Readonly<{
    room: BirdDogEffect;
    hostJobs: NonNullable<ShiitakeOptions["hostJobs"]>;
  }>;
}
