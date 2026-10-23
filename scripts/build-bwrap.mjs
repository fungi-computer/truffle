// Build-time acquisition only. Missing runtime payloads never download on use.
import process from "node:process";

if (process.platform === "linux")
  await import("@fungi.computer/cordyceps/native/bwrap/build.mjs");
