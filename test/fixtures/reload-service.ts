import { createModels } from "@earendil-works/pi-ai";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { z } from "zod";
import { runPrivateLocalService } from "../../src/private-local-service-listener.js";
import { serviceDirectory } from "../../src/private-local-service-discovery.js";
import { openPrivateLocalRuntimeHost } from "../../dist/private-local-runtime-host.js";

const [directory, gate] = z
  .tuple([z.string(), z.url()])
  .parse(process.argv.slice(2));
const faux = fauxProvider({
  provider: "reload-fixture",
  models: [{ id: "reload-model", name: "Reload" }],
});
const pathCode =
  'return await env.computers.local.exec({command: \'printf "%s" "$PATH"\'});';
const remoteCode = 'return await env.fungiMcp.execute({code: "reload probe"});';
const tool = (code: string) =>
  fauxAssistantMessage(fauxToolCall("execute", { code }), {
    stopReason: "toolUse",
  });
faux.setResponses([
  async () => {
    await fetch(gate);
    return tool(pathCode);
  },
  fauxAssistantMessage("first complete"),
  tool(pathCode),
  tool(remoteCode),
  fauxAssistantMessage("second complete"),
  tool(pathCode),
  tool(remoteCode),
  fauxAssistantMessage("third complete"),
]);
const models = createModels();
models.setProvider(faux.provider);
await runPrivateLocalService(await serviceDirectory(directory), (options) =>
  openPrivateLocalRuntimeHost(
    {
      ...options,
      providerId: "reload-fixture",
      modelId: "reload-model",
    },
    models,
  ),
);
