import { copyFile, mkdir } from "node:fs/promises";
import { URL } from "node:url";

const source = new URL("../src/seatbelt/safe-base.sbpl", import.meta.url);
const output = new URL("../dist/seatbelt/", import.meta.url);
await mkdir(output, { recursive: true });
await copyFile(source, new URL("safe-base.sbpl", output));
