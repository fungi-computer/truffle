// A fixture model-login extension: a fake provider's subscription sign-in. It
// returns the shape Pi's own OAuth auth object has, without Pi or any network.
export default function logins({ z }) {
  const choice = z.enum(["browser", "copy_code"]);
  return [
    {
      providerId: "fixture",
      method: "subscription",
      oauth: {
        name: "Fixture subscription",
        isSubscription: true,
        async login(interaction) {
          interaction.signal.throwIfAborted();
          const method = choice.parse(
            await interaction.prompt({
              type: "select",
              message: "Select fixture login method",
              options: [
                { id: "browser", label: "Browser login" },
                { id: "copy_code", label: "Copy code login" },
              ],
            }),
          );
          return {
            type: "oauth",
            access: "fixture-access",
            refresh: "fixture-refresh",
            expires: Date.now() + 3_600_000,
            fixtureMethod: method,
          };
        },
        refresh(credential) {
          return Promise.resolve({
            ...credential,
            access: "fixture-access-refreshed",
            expires: Date.now() + 3_600_000,
          });
        },
        toAuth(credential) {
          return Promise.resolve({ apiKey: credential.access });
        },
      },
    },
  ];
}
