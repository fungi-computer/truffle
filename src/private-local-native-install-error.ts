import { z } from "zod";

/** The Spore caller owns the release version; Local cannot infer it from its own build ID. */
export function nativePackageStartupError(cause?: unknown): Error {
  const release = z.string().min(1).safeParse(process.env.FUNGI_SPORE_VERSION);
  if (!release.success)
    return new Error(
      "Fungi CLI release version is unavailable; restart Fungi.",
      {
        cause,
      },
    );
  return new Error(
    `Fungi's native package for ${process.platform}-${process.arch} is missing or doesn't match this version. Reinstall: npm i -g @fungi.computer/spore@${release.data}`,
    { cause },
  );
}
