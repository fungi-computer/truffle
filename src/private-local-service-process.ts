import { serviceDirectory } from "./private-local-service-discovery.js";
import { runPrivateLocalService } from "./private-local-service-listener.js";
import { capturePrivateLocalConfigRoot } from "./private-local-config-root.js";
const directory = process.argv[2];
if (!directory) throw new Error("Local service requires its private directory");
const root = capturePrivateLocalConfigRoot();
await runPrivateLocalService(
  await serviceDirectory(directory),
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  root,
);
