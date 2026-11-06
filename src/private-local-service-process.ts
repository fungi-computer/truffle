import { serviceDirectory } from "./private-local-service-discovery.js";
import { runPrivateLocalServiceProcess } from "./private-local-service-supervisor.js";
const directory = process.argv[2];
if (!directory) throw new Error("Local service requires its private directory");
await runPrivateLocalServiceProcess(await serviceDirectory(directory));
