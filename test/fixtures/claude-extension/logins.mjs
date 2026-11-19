// The shape of a real subscription extension: it returns Pi's own OAuth auth
// object for the provider. Tests of the account-identity guard run Pi's real
// refresh and 401 recovery through it, with only the network stubbed.
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";

export default () => [
  {
    providerId: "anthropic",
    method: "subscription",
    oauth: anthropicProvider().auth.oauth,
  },
];
