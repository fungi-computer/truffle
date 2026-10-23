import { describe, expect, it } from "vitest";
import { privateLocalExecEnvironment } from "../src/private-local-exec-environment.js";

describe("privateLocalExecEnvironment", () => {
  it("passes the user's session locators and nothing else from the host", () => {
    expect(
      privateLocalExecEnvironment("/usr/bin", {
        HOME: "/home/u",
        XDG_RUNTIME_DIR: "/run/user/1000",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
        SECRET_TOKEN: "no",
      }),
    ).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/u",
      XDG_RUNTIME_DIR: "/run/user/1000",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    });
  });

  it("omits session locators the host does not have", () => {
    expect(
      Object.keys(privateLocalExecEnvironment("/usr/bin", { HOME: "/h" })),
    ).toEqual(["PATH", "HOME"]);
  });

  it("keeps the explicitly selected host home when ambient HOME changes", () => {
    const previousHome = process.env.HOME;
    try {
      process.env.HOME = "/disposable/home-b";
      expect(
        privateLocalExecEnvironment("/usr/bin", { HOME: "/disposable/home-a" }),
      ).toEqual({ PATH: "/usr/bin", HOME: "/disposable/home-a" });
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });
});
