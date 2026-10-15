import { isAbsolute, resolve } from "node:path";
import { z } from "zod";

const maximumPathCharacters = 8_192;
const maximumPathDirectories = 64;

/** Only the invoking client's bounded PATH crosses the local service boundary. */
export const privateLocalExecPathSchema = z
  .string()
  .min(1)
  .max(maximumPathCharacters)
  .superRefine((path, context) => {
    const directories = path.split(":");
    if (directories.length > maximumPathDirectories)
      context.addIssue({
        code: "custom",
        message: "PATH has too many directories",
      });
    for (const directory of directories) {
      if (
        directory === "" ||
        !isAbsolute(directory) ||
        /[\p{Cc}\p{Cf}]/u.test(directory)
      ) {
        context.addIssue({
          code: "custom",
          message: "PATH must contain only nonempty absolute directories",
        });
        break;
      }
    }
  });

export function parsePrivateLocalExecPath(value: string): string {
  return privateLocalExecPathSchema.parse(value);
}

/** Resolve shell-relative client entries before the absolute-only RPC boundary. */
export function capturePrivateLocalExecPath(
  value: string,
  clientDirectory: string,
): string {
  const absolute = value
    .split(":")
    .map((directory) =>
      directory === "" || isAbsolute(directory)
        ? directory
        : resolve(clientDirectory, directory),
    );
  return parsePrivateLocalExecPath(absolute.join(":"));
}
