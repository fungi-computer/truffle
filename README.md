# Local runtime

This private runtime hosts Agents and saved Sessions on the same user's machine.
The Fungi terminal consumes it through a persistent local service. It owns
SQLite storage, model credentials, project Files and shell operations, not
terminal rendering. It is an internal workspace, not a standalone npm
installation path.

## Source setup

Use a configured repository checkout with the pinned Node, Bun and pnpm tools.
Local runs its own host build of the native `apply_patch` engine, which
[`@fungi.computer/cordyceps`](../../packages/cordyceps/README.md#native-patch-engine)
owns; Cordyceps' build prerequisites apply. Run from the repository root:

```sh
pnpm turbo:run run build --filter=@fungi.computer/local
pnpm --filter @fungi.computer/local test
```

The build places the engine in `native/bin` through Cordyceps'
`fungi-apply-patch-build` and Local's dependency closure, then the tests run its
unit and native patch tests. They do not sign in to a provider or start a
customer Agent. Build outputs and test fixtures are disposable. Without a built
engine, Local offers no `apply_patch` tool.

## Host and Session lifetime

[openPrivateLocalRuntimeHost](src/private-local-runtime-host.ts) captures the
canonical project root and opens the Agent's SQLite store, Shiitake owner, model
source and tool resources. A fresh Agent store lives under the project's
`.fungi/agents/`. Reopening a store retains its Agent identity and Sessions.
Corrupt, unreadable or already-owned stores remain explicit failures, not
reasons to silently create a replacement.

[openPrivateLocalShiitakeHost](src/private-local-shiitake-host.ts) mounts the
ordinary Shiitake HTTP routes through an injected loopback server opener and
returns the neutral client and `main` Session. Closing it releases the client,
transport and owner. The worker-batch variant owns several named routes on one
server. Closing the batch closes their resources.

The [service manager](src/private-local-service.ts) discovers or starts the same
user's shared background service. It selects project stores and creates or
resumes Sessions through that owner. Closing a client connection does not stop
the service or erase its Session. Explicit service shutdown drains its owners.
The CLI's `fungi stop` requests that shutdown. Clients only reconnect to a
service from the same build. After an upgrade, finish active turns, run
`fungi stop`, then reopen with `fungi resume --last` from the original project.
Saved Sessions remain on disk. This avoids running a service whose installed
sandbox executable was removed by the upgrade; the client never stops an older
service automatically.

A Session keeps its invoking client's validated executable PATH while its owner
is live. Reconnecting the same live Session with a different PATH is a conflict.
Stop the service before deliberately rebinding that Session to a different
toolchain. Other caller environment variables are not imported.

## Files, tools and models

The local Computer is explicit in execute: `env.computers.local.exec(...)` and
`env.computers.local.files.read/list/glob/grep/edit(...)`. There is no shared
`files` module or Computer role named Home. The host grants the product Home
extension its already-rooted port; Home adopts the single local attachment and
supplies direct `read`, `list`, `glob`, `grep` and native `apply_patch` tools.
The same tool gate admits each direct call. `/home local` is a human command;
there is no model operation that changes Home.

- [Files](src/private-invocation-files.ts) captures the project root and rejects
  path or symlink escapes. Native patch follows its own stricter rooted
  contract.
- [Shell commands](src/private-invocation-computer.ts) run POSIX `sh` with the
  OS user's access, a rooted cwd and bounded output. Files containment is not a
  claim that arbitrary shell commands are an OS sandbox. `exec`'s `run` input is
  one Zod boundary over two mutually exclusive forms: the shell form (`command`,
  interpreted by `sh -c`) and a direct form (`executable` and `args`, run with
  no shell interpretation at all, through the same bounded native process owner
  `runPrivateInvocationProcess`). Zod refuses a request carrying both or
  neither. Either form accepts optional `stdin`
  ([its own bound](src/private-local-exec-launch.ts), not borrowed from Files),
  written to the child once, then closed; there is no interactive stdin. An
  omitted `stdin` closes immediately rather than leaving an open pipe, so a
  reader such as `cat` sees EOF instead of hanging. A direct-form executable the
  host cannot find or run reports a typed refusal naming it, rather than a
  generic sandbox failure.
- [Background processes](src/private-local-computer-processes.ts) support start,
  poll, wait, list and kill on the existing exec surface. `start` takes the same
  shell-or-direct, optional-stdin input as `run`, through the existing
  background process owner (`ManagedProcess`/`spawn`, not `run`'s
  `runPrivateInvocationProcess`). Wait is bounded to 60 seconds. Cancelling a
  wait does not kill the process. Output retains a bounded tail with offsets.
  Session deletion or owner close stops its groups. Process IDs do not survive
  host restart.
- [Guest execution](src/private-workerd-sandbox.ts) uses the maintained workerd
  sandbox and admitted Mycelium capabilities. It reports typed boundary failures
  separately from the native command's result.
- [Models](src/local-models.ts) uses Pi's registry and Veil's allowed login
  methods with the local credential store. Fungi's provider reads its hosted
  catalog through the selected Team and uses Hub billing. Model choice follows
  explicit Session, explicit Agent, the person's remembered model in
  `~/.config/fungi/shiitake.json`, a host's Team default, then an available
  provider login. A Session `/model` switch is only that Session's override; it
  never changes an Agent default or another Agent. Agent defaults stay in their
  Agent store. The host validates offered models and supported thinking levels.
  `agents.models` lists the `provider/model` addresses offered by signed-in or
  configured providers. `agents.create` accepts an optional address from that
  list, and `agents.setModel` changes future runs without replacing Session
  overrides. An address Local does not offer fails as a typed `model:rejected`
  capability failure and changes nothing. Creation and sends refuse missing
  provider login; failed runs keep a safe, actionable diagnostic for
  `agents.wait`. A hosted Team's key-source choice remains an explicit
  restriction, including when a manual model is selected.
- [Delegation](src/private-local-delegation.ts) gives each project Agent the
  Hub's `followUp` delegation over its own store. `agents.send` freezes BirdDog
  mail through `fleet.start` and returns the child's `commandId`. The
  [service owner](src/private-local-service-owner.ts) routes mail between its
  project Agents and opens an idle addressee, so a reply wakes an idle parent;
  an active parent runs it next, after its current work. An Agent admits only
  new work that replies to its sender, or a reply that `fleet.authenticateReply`
  verifies against the mail it sent. That reply is authored by the child,
  carries `meta.delegation.reply`, and reaches the model inside
  `<fungi_agent_reply>`. Every other mail is refused.

Root `AGENTS.md` is captured through the rooted Files owner for run
instructions. Missing optional instructions are different from unreadable,
oversized or escaping files. This instruction port stays tied to the project
root independently of Home.

[Skills](src/local-skill-source.ts) use the product extension's `prompt` and
`run_tools` hooks. The prompt lists names and descriptions;
`skill.load({name, file?})` reads instructions or a supporting file through
`execute`. Bodies stay tool output. Discovery diagnostics distinguish empty
roots from skipped or rejected entries and explain them in the skills section.
Raw causes remain redacted in local service logs.

Discovery follows Pi 0.73.1: project `.fungi/skills`, then `.agents/skills` from
the project folder up to its git root, then personal `~/.fungi/skills` and
`~/.agents/skills`. Project roots precede personal roots. Claude and Pi folders
are not defaults. Extra folders are opt-in through a `skills` list in
`.fungi/settings.json` or `~/.fungi/settings.json`, for example:

```json
{ "skills": ["~/.claude/skills"] }
```

Project settings paths are relative to the project; personal settings paths are
relative to `~/.fungi`. `~/` expands to the user's home. Project extra folders
precede personal roots. The first name wins; collisions warn. A directory with
`SKILL.md` is one skill and stops discovery below it; other directories are
searched recursively, excluding dot directories and `node_modules`. This also
finds Claude's `synced/<id-pair>/<skill>/SKILL.md` layout when opted in.

A non-empty description is required. Name-rule violations and descriptions over
1,024 characters warn without rejecting the skill. Only a literal YAML
`disable-model-invocation: true` hides it from model discovery. Discovery stays
inside the canonical root, including symlink targets, with a 16-level depth and
512-entry limit per root. Reads remain inside each selected skill's real
directory, with the existing file and catalog size limits. Scripts are listed,
never executed by this source.

## Installed extensions

`@fungi.computer/local/extensions` is the one owner of installed extensions. It
keeps package bytes and the install record in `~/.fungi/extensions`, and the
activations its own operations write in `~/.fungi/extensions/activations.json`.
Files in a project or an Agent store never enable anything, so a copied folder
starts disabled.

- `add(source)` installs a Git URL, npm spec or path with the shipped Bun
  package manager, lifecycle scripts disabled and a private cache. A Git source
  is pinned to the commit Bun resolved; updating is another `add`. A package
  whose declared `./host` entry or terminal program is not built is refused.
- `enableProject(root, id)` turns on the extension's client entry and programs
  for that folder, whichever Agent is selected.
- `enableAgent(store, id)` grants one Agent store the capabilities the current
  revision declares. The Agent keeps an older accepted revision until it is
  enabled again, so an upgrade never widens it silently.
- `remove(id)` deletes the package and every activation that references it.

The package declares itself in `package.json`:

```json
{
  "exports": { "./host": "./host.mjs" },
  "fungi": {
    "id": "counter",
    "capabilities": ["run_tools"],
    "terminals": [
      { "id": "counter", "name": "Counter", "command": ["./bin/counter.mjs"] }
    ]
  }
}
```

`./host` exports a factory. Local calls it with its own `defineExtension`,
`Mycelium` and `z`, and a 0700 runtime directory for the project. The Agent
store's roster takes the result when that Agent opens, with exactly the accepted
capabilities. The same directory reaches the extension's programs as
`FUNGI_EXTENSION_RUNTIME_DIR`, so a tool can talk to the program a person opened
in a pane. Installed code is trusted and runs as you.
[`local-extensions.bun.test.ts`](test/local-extensions.bun.test.ts) installs the
[counter fixture](test/fixtures/extension-counter/) from a disposable bare Git
repository and calls its tools through the real workerd `execute`.

## Team connections and ACP

A Team MCP connection adds admitted hosted Computer tools to a local Agent. It
does not move the local Files root or Session storage into the Hub.

[Fungi account custody](src/private-fungi-account.ts) supplies the same OAuth
login and locked refresh to MCP and models. `fungi login --provider fungi` opens
browser sign-in and selects a current Team for model billing. The Local model
picker refreshes that Team's live hosted catalog. A fresh Local Agent defaults
to Fungi's catalog default, with `@fungi/luna` as the initial selection before
the catalog is available. A saved Session override takes precedence; signing in
does not replace it. The project MCP endpoint and the model's selected Team are
independent. Switching one does not rewrite the other.

`fungi logout` and Pi logout share Local's sign-out owner: it attempts every
Computer detach before clearing the credential, then retries unconfirmed OAuth
revocation once. Sign-out always removes local credentials. It names Computers
whose detach is unconfirmed and links their Hub Computers pages; a running
backend may still serve until detached there or stopped locally.

The private `credentials.json.pending-logouts.json` journal retains only issuer,
account, login-family, Team, Computer and attach-request IDs plus cleanup
status, never keys, tokens or folder paths. After the next successful
same-account sign-in, Local retries cleanup with the new session before Team
selection. Another account or issuer discards pending intents. The journal
evicts oldest entries above 128 records or 256 KiB with a diagnostic. There is
no startup prompt; Computers and Connected logins provide manual recovery. See
the current
[Computer backend custody](../../wiki/2-areas/computer-execution-backends.md).

[The Fungi provider](src/private-fungi-model-provider.ts) uses Pi's maintained
completion API through the selected Team. It validates the hosted catalog and
does not expose supplier credentials to Local. Sign-in, credit, paused-service
and reachability refusals remain actionable failures. They do not trigger a
supplier fallback. Local key/subscription providers remain available separately.

Attaching a local folder to a Team Computer is a separate dial-out connection
with its own device key, sync and confirmation. It runs commands as the member's
OS user. Offline conflicts keep the Computer's version. The absolute folder path
and private key stay local.

[The ACP stdio adapter](src/private-local-acp-stdio.ts) exports
`runPrivateLocalAcpStdio` through `@fungi.computer/local/acp-stdio`. It serves
stable ACP v1 over the maintained NDJSON stream and the persistent service's
Sessions. The CLI launches this adapter with `fungi acp`; editor configuration
uses executable `fungi` and arguments `["acp"]`. It supports text and image
prompts, embedded text/image resources and resource links, plus Session listing,
loading and cancellation. Terminal-auth clients invoke `fungi acp login` for the
ordinary Fungi login. Nonempty additional directories and supplied MCP servers
are rejected. The admitted directory owns authorization, and closing a client
lease retains durable Session data.

## Check this runtime

From the repository root:

```sh
pnpm --filter @fungi.computer/local typecheck
pnpm --filter @fungi.computer/local lint
pnpm --filter @fungi.computer/local test:full
```

[Runtime-host tests](test/private-local-runtime-host.test.ts) exercise native
SQLite, provider fixtures, instruction snapshots, replay and close.
[Computer tests](test/private-invocation-computer.test.ts) cover process-group
cleanup and deadlines.
[Background-process tests](test/private-local-computer-processes.test.ts) cover
bounded waits and output tails.
[ACP stdio tests](test/private-local-acp-stdio.test.ts) cover protocol
initialization. [Fungi model tests](test/private-fungi-model-provider.test.ts)
cover the live catalog contract, selected-Team billing, streamed fixture replies
and refusal recovery. [Account tests](test/private-fungi-account.test.ts) cover
shared refresh and sign-out custody, including competing processes. Bun service
tests and separate scripts are listed in [package.json](package.json).
Controlled replies do not prove a live provider login, a published CLI release
or a hosted Team deployment.

## Selected-Team App reads

`openLocalTeamApps` from `@fungi.computer/local/apps` opens the saved account's
selected Team. Its `read`, `requestGill`, `surfaceUrl` and `openSession`
operations keep credentials inside Local and recheck account selection around
reads. Gill requests resolve current directory selectors and declared actions
through the ordinary admitted App door. Hosted Session transport uses the Local
OAuth door and the same Team/resource capability rule as browser Sessions.
Closing a Session client releases observation; it does not cancel durable work.

The directory grammar lives in `@fungi.computer/oyster/shell/app-directory`. UI
handoff resolves the selected App's published surface on the saved Hub origin,
without putting an access token in the URL. A later account/Team selection
retires this client; open a new client for the new selection.
