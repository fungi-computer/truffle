import type { BirdDogMail } from "@fungi.computer/bird-dog";
import {
  BirdDogError,
  hasPendingDelivery,
  make as makeBirdDog,
  type BirdDogEffect,
  type EffectBirdDogOptions,
} from "@fungi.computer/bird-dog/effect";
import * as Effect from "effect/Effect";
import type { PrivateSqliteDatabase } from "./private-sqlite-owner.js";
import type { Accepted } from "@fungi.computer/shiitake";
import { messageAuthor } from "@fungi.computer/agar/agents";
import { z } from "zod";

export type PrivateLocalMailOptions = Readonly<{
  /** Admit one reply at its addressed Agent; a rejection retries later. */
  deliver: (mail: BirdDogMail) => Promise<Accepted>;
  scheduleWake?: (at: number) => void;
  now?: () => number;
}>;
const outboxValue = z.object({ value: z.string() });
const outboxRows = z.array(
  z.object({ key: z.string(), value: z.string() }).readonly(),
);

function storeFailure(cause: unknown): BirdDogError {
  return new BirdDogError("local mail store is unavailable", { cause });
}

/** The Agent store's BirdDog outbox rows. */
function localOutbox(
  database: PrivateSqliteDatabase,
): EffectBirdDogOptions["outbox"] {
  return {
    read: (key: string) =>
      Effect.try({
        try: () => {
          const statement = database.prepare(
            "SELECT value FROM local_birddog_outbox WHERE key = ?",
          );
          const row = outboxValue.safeParse(statement.get(key));
          return row.success ? row.data.value : undefined;
        },
        catch: storeFailure,
      }),
    put: (key, value) =>
      Effect.try({
        try: () => {
          database
            .prepare(
              "INSERT INTO local_birddog_outbox (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            )
            .run(key, value);
        },
        catch: storeFailure,
      }),
    list: (limit, afterKey) =>
      Effect.try({
        try: () =>
          outboxRows.parse(
            database
              .prepare(
                "SELECT key, value FROM local_birddog_outbox WHERE (? IS NULL OR key > ?) ORDER BY key LIMIT ?",
              )
              .all(afterKey ?? null, afterKey ?? null, limit),
          ),
        catch: storeFailure,
      }),
    delete: (key) =>
      Effect.try({
        try: () => {
          database
            .prepare("DELETE FROM local_birddog_outbox WHERE key = ?")
            .run(key);
        },
        catch: storeFailure,
      }),
  };
}

/** Whether this Agent's outbox still owes any reply a delivery attempt. */
export function hasPrivateLocalPendingMail(
  database: PrivateSqliteDatabase,
): Promise<boolean> {
  return Effect.runPromise(hasPendingDelivery(localOutbox(database)));
}

export function createPrivateLocalMailRoom(
  database: PrivateSqliteDatabase,
  options: PrivateLocalMailOptions,
): BirdDogEffect {
  database.exec(
    "CREATE TABLE IF NOT EXISTS local_birddog_outbox (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)",
  );
  const room = Effect.runSync(
    makeBirdDog({
      outbox: localOutbox(database),
      post: (mail) =>
        Effect.tryPromise({
          try: async () => {
            await options.deliver(mail);
            return true;
          },
          catch: (cause) =>
            new BirdDogError("local recipient rejected mail", { cause }),
        }).pipe(
          Effect.catch((cause) =>
            Effect.logError(
              "Local mail recipient rejected delivery",
              cause,
            ).pipe(Effect.as(false)),
          ),
        ),
      scheduleWake: (at) => Effect.sync(() => options.scheduleWake?.(at)),
      now: options.now ?? (() => Date.now()),
    }),
  );
  return {
    ...room,
    fanOut: (settlement) => {
      if (settlement.job.outcome !== "cancelled")
        return room.fanOut(settlement);
      const author = messageAuthor(settlement.meta);
      return room.fanOut({
        ...settlement,
        content:
          author === undefined
            ? "Work cancelled."
            : `Work cancelled by ${author.name}.`,
      });
    },
  };
}
