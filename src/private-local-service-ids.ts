import { defineIdFamily } from "@fungi.computer/cairn";

export const localServiceIds = defineIdFamily({
  family: "local-service",
  version: 1,
  kinds: {
    service: { prefix: "local_service" },
  },
});
