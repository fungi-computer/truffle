import { serviceDirectory } from "./private-local-service-discovery.js";
import { runPrivateLocalService } from "./private-local-service-listener.js";
const directory = process.argv[2];
if (!directory) throw new Error("Local service requires its private directory");
await runPrivateLocalService(await serviceDirectory(directory));
