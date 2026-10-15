import {
  Cli,
  isCancel,
  type Option,
  type PasswordOptions,
  type TextOptions,
} from "@fungi.computer/lantern";
import type { AuthEvent, AuthInteraction } from "@earendil-works/pi-ai";

/**
 * Pi's `AuthEvent` carries no provider name. `auth-cli.ts#login` knows the
 * chosen provider before Pi's own login() runs, and stamps this one
 * optional, bounded property onto the `auth_url` event it forwards so the
 * heading below can read it; Pi's event shape otherwise stays exactly as Pi
 * defines it. `notify` below is declared to accept it directly (TS checks
 * object-literal methods bivariantly, same as `AuthInteraction`'s own method
 * signature), so reading it needs no cast.
 */
type NotifiedEvent = AuthEvent & { readonly providerLabel?: string };

const defaultAuthUrlInstructions =
  "Waiting for the browser… If it doesn't return, paste the final redirect URL here.";

/** Pi owns provider flows and credentials; Clack owns only their presentation. */
export function linearAuthInteraction(
  interactive: boolean,
  cli = new Cli({ brand: "fungi-local-auth", interactive }),
): AuthInteraction {
  return {
    async prompt(prompt) {
      if (!interactive)
        throw new Error(
          "Login needs a terminal. Run fungi login or fungi-local-auth login interactively; no credentials were changed.",
        );
      const options: PasswordOptions = {
        message: prompt.message,
      };
      if (prompt.signal !== undefined) options.signal = prompt.signal;
      let answer: string | symbol;
      if (prompt.type === "select") {
        answer = await cli.select({
          ...options,
          options: prompt.options.map((option) => {
            const choice: Option<string> = {
              value: option.id,
              label: option.label,
            };
            if (option.description !== undefined)
              choice.hint = option.description;
            return choice;
          }),
        });
      } else if (prompt.type === "secret" || prompt.type === "manual_code") {
        answer = await cli.password(options);
      } else {
        const textOptions: TextOptions = { ...options };
        if (prompt.placeholder !== undefined)
          textOptions.placeholder = prompt.placeholder;
        answer = await cli.text(textOptions);
      }
      if (isCancel(answer)) throw new Error("Login cancelled.");
      return answer;
    },
    notify(event: NotifiedEvent) {
      switch (event.type) {
        case "auth_url": {
          const heading =
            event.providerLabel === undefined
              ? "Sign in"
              : `Sign in to ${event.providerLabel}`;
          // Each of these is its own single-line clack message, so none of
          // them is a continuation line that could pick up a "│ " gutter —
          // including the hyperlink line, whose OSC 8 escape carries the
          // whole URL even though only the short label is visible.
          cli.info(heading);
          cli.info(cli.link("Open sign-in page", event.url));
          // The URL itself must stay one whole, copyable line: print it
          // outside clack's log box entirely.
          cli.raw(event.url);
          cli.info(event.instructions ?? defaultAuthUrlInstructions);
          break;
        }
        case "device_code":
          cli.info(
            `Open ${event.verificationUri}\nEnter code: ${event.userCode}`,
          );
          break;
        case "info":
          cli.info(
            [
              event.message,
              ...(event.links ?? []).map((link) => link.url),
            ].join("\n"),
          );
          break;
        case "progress":
          cli.step(event.message);
      }
    },
  };
}
