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
pnpm turbo:run run build --filter=@fungi.computer/truffle
pnpm --filter @fungi.computer/truffle test
```

The build places the engine in `native/bin` through Cordyceps'
`fungi-apply-patch-build` and Local's dependency closure, then the tests run its
unit and native patch tests. They do not sign in to a provider or start a
customer Agent. Build outputs and test fixtures are disposable. Without a built
engine, Local offers no `apply_patch` tool.

Sandbox policy assertions run in `test:unit` without launching a sandbox: they
exercise the real admission and command renderer with a deterministic startup
probe. Native sandbox qualification lives in `test/*.native.test.ts`, selected
by `test:sandbox:native` through `test:merge`, with one file worker. It retains
the real bwrap/Seatbelt startup, Git write-refusal, child and delegation proofs;
`test:merge` also runs the platform sandbox matrix and native patch suite.

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
the service or erase its Session. The CLI's `fungi stop` sends the service
SIGTERM, which drains its owners; a service still running 5 s later is
SIGKILLed, and its `service.json` and owner lock are removed either way. A
SIGKILL ends only the service process: the shell and exec commands its Agents
started run detached in their own process groups and can keep running after it
([client-surfaces-v1-79](../../issues/client-surfaces-v1/79-stop-the-service-process-groups-on-fungi-stop.md)).
Interrupted turns resume when the service next starts.

The service releases an Agent nothing is using. It counts each request and each
open Session watch on that Agent, and every mail or control operation that
reaches it. An unused Agent with no running or waiting Session, Watchdog job,
scheduled wake, reply still owed a delivery attempt or running background
process is closed after two consecutive idle checks (one per minute). Delivered
reply receipts and dead letters stay in the outbox but owe nothing. Work an
Agent delegated is owed by its child, whose reply mail reopens the parent. It is
then dropped from `~/.fungi/service/owners.json`. The next request, mail or send
reopens it. Shutdown keeps only Agents with work in that file, so a restart
reopens just those. A released Agent's per-Session client PATH binding and
exited background-process logs end with it.

`~/.fungi/service/service.json` and the service's `status` route record its
`version` (the packed CLI's content hash, or `source`) and `protocol` (the
client-service wire contract). Every TUI or CLI start ensures its own build: it
reuses a service of the same version, and otherwise stops the registered one as
`fungi stop` does and starts its own. A window that has already reached a
service never replaces one: it keeps a newer build that speaks its protocol, and
for another protocol shows only "The Fungi service was updated. Restart this
window." Saved Sessions remain on disk throughout.

Version policy: a fresh launch of a different build replaces the running
service, so use one installed build per service directory (`~/.fungi/service`).
Every source checkout counts as the same `source` version, so restart the
service (`fungi stop`) after editing the source.

### Service diagnostics candidate

`private-local-service-log.ts` owns the service's JSON record contract, native
file sink and always-on five-minute sampler. It retains all maintained `bun:jsc`
type counts when the encoded record fits 32 KiB. If not, it emits an explicit
map omission summary rather than selecting a top-N subset or truncating JSON.
Counts include uncollected allocations; they are not retained-root evidence.
Unavailable statistics are explicit, never zero substitutes.

CTO ruling `dc105` selects the runtime's own filesystem primitives, owned by
this same module. The sink opens append with mode `0600` and verifies the
descriptor without chmod repair, checks byte counts on every write, and rotates
using checked native renames. No logger framework, worker, retry loop or second
store is part of this contract.

The candidate policy is one active 1 MiB file plus three 1 MiB backups, not a
four-backup policy. Disposal must precede the existing owner lease release. No
inspector, environment debug switch, forced GC, new service supervisor or
memory-leak fix is implied. The separate 4,096-cycle memory experiment did not
reproduce the reported sustained growth.

The diagnostics resource records startup/ready and observed stop reasons and
owns only its sampler/writer. Both entry paths use the existing listener owner,
which disposes diagnostics before registration removal and lease release.
Diagnostics I/O faults do not stop the service, turns or normal shutdown.

Native fixtures allocate only under this worktree's ignored
`.botanical/service-log-fixtures/`; child HOME and TMPDIR are fixture-owned.
Primitive-only native tests use the diagnostics resource directly; later
service/CLI/doctor proofs load the real consumer closure separately. Short-count
injection controls the maintained SDK return value; it is not an OS-generated
short-write claim. Rename-fault tests use an actual filesystem collision.

CTO decision `ee8f5320e0de` selects continued service operation with explicit
failed diagnostics. The first sink fault latches a bounded code and stable
first-failure ISO timestamp, stops the sampler and attempts writer disposal
once. Later requests read that current resource state, not the startup
connection snapshot. Opening/writing/closing failures are distinct; a failed
heap read emits `memory-unavailable`, never zero statistics. No retries,
separate journal or store, environment switch or new runtime owner is added.

Protocol 2 requires diagnostics on live `/status` and `/inspect` responses; the
registration file remains identity-only. The maintained Zod live decoder rejects
missing diagnostics rather than assuming ACTIVE. `fungi doctor` performs only
the manager's live status read and prints `FAILED <code> since <timestamp>` (or
ACTIVE). It never starts/restarts the service.

The earlier LogTape probe was rejected on native mode and swallowed-rename
failures; it is not an adoption option. Its old candidate tests are superseded
by native-fs tests, with the historical probe preserved separately. Dependency
removal uses the maintained package operation, not hand-edited lock state.
Focused native tests do not qualify the service/CLI/doctor consumer closure or
authorize production enablement; those remain subject to the built-dependency
merge gate.

The service acquires its SQLite owner row and writes its PID and process-start
identity in the same transaction. `service.json` is only a pointer to that row;
a matching file or HTTP handshake alone does not authorize a signal. Before
stopping, the client requires the file to match the live lease owner and checks
that process's start identity (Linux `/proc/<pid>/stat` `starttime`). It checks
the process identity again before each signal. These are separate reads and
`kill` calls: a residual read-to-signal PID-reuse window remains; this is not an
atomic kernel process handle.

On macOS, `ps lstart` has only one-second resolution. No sub-second macOS reader
is implemented, so `fungi stop` and automatic build replacement **refuse to
signal** there with an actionable message. Close the service manually before
launching another build. A possibly live lease is retained conservatively on
platforms without verifiable start identity, even if its PID may have been
reused.

A Session keeps its invoking client's validated executable PATH while its owner
is live. Reconnecting the same live Session with a different PATH is a conflict.
Stop the service before deliberately rebinding that Session to a different
toolchain. Other caller environment variables are not imported.

## Files, tools and models

The local Computer is explicit in execute: `env.computers.local.exec(...)` and
`env.computers.local.files.read/find/edit(...)`. There is no shared `files`
module or Computer role named Home. The host grants the product Home extension
its already-rooted port; Home adopts the single local attachment and supplies
direct `read`, `list`, `glob`, `grep` and native `apply_patch` tools. The same
tool gate admits each direct call. `/home local` is a human command; there is no
model operation that changes Home.

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
  neither. Both forms accept optional `env`: at most 64 string-valued entries,
  each at most 1,024 UTF-16 code units, named `^[A-Z_][A-Z0-9_]*$`. Values are
  passed literally, never interpolated into shell source. Host-owned names
  (`HOME`, `PATH`, session/sandbox locators, temporary-directory and loader
  controls such as `LD_*`/`DYLD_*`) are refused; ambient host secrets remain
  excluded. If a host-trusted Node process ever inherits this caller-supplied
  env, `NODE_OPTIONS` must join the refused list before that path is enabled.
  Either form accepts optional `stdin`
  ([its own bound](src/private-local-exec-launch.ts), not borrowed from Files),
  written to the child once, then closed; there is no interactive stdin. An
  omitted `stdin` closes immediately rather than leaving an open pipe, so a
  reader such as `cat` sees EOF instead of hanging. A direct-form executable the
  host cannot find or run reports a typed refusal naming it, rather than a
  generic sandbox failure.
- [Background processes](src/private-local-computer-processes.ts) support start,
  poll, wait, list and kill on the existing exec surface. `start` takes the same
  shell-or-direct, optional-stdin and bounded-env input as `run`, through the
  existing background process owner (`ManagedProcess`/`spawn`, not `run`'s
  `runPrivateInvocationProcess`). Wait is bounded to 60 seconds. Cancelling a
  wait does not kill the process. Output retains a bounded tail with offsets.
  Session deletion or owner close stops its groups. Process IDs do not survive
  host restart.
- [Guest execution](src/private-workerd-sandbox.ts) uses the maintained workerd
  sandbox and admitted Mycelium capabilities. It reports typed boundary failures
  separately from the native command's result.
- [Models](src/local-models.ts) uses Pi's registry and Veil's allowed login
  methods with the local credential store. Fungi's provider reads its hosted
  catalog through the selected Team and uses Hub billing. Model choice follows a
  Session override, then the Agent's default, then an available provider login;
  there is no per-person remembered model. `/model` in a chat sets that Agent's
  default and thinking level and clears the Session override, so the running
  chat and every new chat with that Agent use it; another Agent is unaffected.
  Agent defaults stay in their Agent store.
  [One resolver](src/private-local-startup-model.ts) decides a new chat's model
  for both a fresh Session and the landing, reading the stored default through
  the same reader as Agent discovery (a store that predates the schema fails
  loudly). The host validates offered models and supported thinking levels.
  `agents.models` lists the `provider/model` addresses offered by signed-in or
  configured providers. `agents.create` accepts an optional name, an optional
  address from that list and an optional thinking level; the new Agent works in
  the project folder and the result returns it with the resolved model.
  `agents.setModel` changes the Agent's default, optionally with a thinking
  level, without replacing Session overrides. An address Local does not offer
  fails as a typed `model:rejected` capability failure and changes nothing.
  Creation and sends refuse missing provider login; failed runs keep a safe,
  actionable diagnostic for `agents.wait`. A hosted Team's key-source choice
  remains an explicit restriction, including when a manual model is selected.
- Archiving tidies a folder's Agents without deleting any. The archived flag
  lives in the Agent's own store next to `created_by`, so the store, its
  Sessions and files stay. An Agent can `agents.archive` and `agents.unarchive`
  an Agent it created, never another Agent or itself; a person runs
  `fungi agents archive|unarchive <id>` for any Agent or presses `a` on the
  landing Agent picker. An archived Agent leaves `agents.list`, discovery (the
  picker and newest-Session resolution) and delegation: `agents.send` to it
  fails as `archive:archived`. `agents.list` with `archived: true`, or
  `fungi agents list --archived`, finds it to restore. Archiving is refused,
  naming the running command, while any Session of the Agent has queued or
  running work, or while it still waits for work it delegated
  (`archive:pending`); the Agent cancels or waits first. Archive and admission
  are serialized per Agent, so a send racing an archive either runs first (and
  the archive is refused) or is refused as archived. A store written before the
  flag reads as unreadable, with the phrase to move it aside; archiving it fails
  as `archive:unreadable`.
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

`@fungi.computer/truffle/extensions` is the one owner of installed extensions.
It keeps package bytes and the install record in `~/.fungi/extensions`, and the
activations its own operations write in `~/.fungi/extensions/activations.json`.
Files in a project or an Agent store never enable anything, so a copied folder
starts disabled.

- `add(source, cwd)` installs a Git URL, npm spec or path with the shipped Bun
  package manager, lifecycle scripts disabled and a private cache. A Git source
  is pinned to the commit Bun resolved; updating is another `add`. A package
  whose declared `./host` entry or terminal program is not built is refused.
  Local paths resolve from the caller's `cwd`, not the private staging folder.
  Directory sources go through Bun's `pm pack --ignore-scripts` before install:
  their installed bytes are an isolated package snapshot, not links back into
  the project. Updating still requires another explicit `add` and activation;
  existing Agents keep their accepted revision and capabilities. Behaviour
  outside the manifest, schemas and hashed config needs an extension version
  bump, per
  [Core's identity contract](../../wiki/3-resources/shiitake-v0.0.1/extensions.md).
  Replacing an active extension can require a service restart.
- `enableProject(root, id)` turns on the extension's client entry and programs
  for that folder, whichever Agent is selected.
- `enableAgent(store, id, requester?)` grants one Agent store the capabilities
  the current revision declares. The Agent keeps an older accepted revision
  until it is enabled again, so an upgrade never widens it silently. A human
  (the CLI) names no requester. When an Agent is the requester it must hold the
  extension itself (granted tools, not only its skills), or the call is refused
  with reason `not-held`.
- `assertHeldByAgent(store, ids)` is that one held-check: it rejects with
  `not-held`, naming every id the Agent lacks. An Agent creating an Agent is
  judged by it before anything exists, so a created Agent never holds more than
  its creator, and a refused request creates nothing.
- `enableAgentSkills(store, id)` opts one Agent store into the skills folder the
  package declares with `fungi.skills` (for example `"./skills"`), with no tools
  granted; a package with no `./host` can be skills-only. The folder is read in
  place from the installed package, ranks below project and personal skills (so
  yours win), and shows as "from <id>". `disableAgentSkills`, `disableAgent` and
  `remove` take it away. Local installed extensions only; Hub-hosted extensions
  are not covered.
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

Local's host-only `presentApproval(sessionId, pending, approvals)` port binds a
genuine canonical `PendingApproval` and member-bound `Approvals` capability to
the requesting Session. `mcpFormApprovalContract` uses the existing Session
extension channel: `pending` contains `{id, approval}`, where `id` is ephemeral
and `approval` is the canonical `ApprovalView`, including host-computed rights.
Optional evidence descriptors pass through with that view. They remain untrusted
display-only metadata, never form input, model input or instructions; this port
does not fetch or decode images.

The Session `answer` command takes `{id, decision, expectedRevision}` with
`decision: "approve" | "deny"`. Only a live selected-Session UI attachment can
schedule a decision. After the Session command commits and the attachment is
rechecked, the client awaits canonical `capability.answer`; that capability
authorizes the answer and its native host owns durable apply/result delivery.
The form id, UI attachment and display data cannot grant operation rights. There
is no second dispatch through MCP `accept`, and no suspended Agent turn. Closing
or rebinding a UI releases its route, not the durable approval record.

This binding is not a TUI renderer or a second ledger. Production submit/apply
composition still needs the canonical ledger/producer owner and host-attested
identity, fence and idempotency facts. The legacy boolean MCP form cannot supply
those facts and is not connected to this Session decision port.

**Pending approvals-bundle join:** boorsr owns the canonical ledger/producer
composition. Local's `observePrivateSqliteOwner(owner, onFailure)` wraps a
supplied owner without choosing transactions or closing its connection. Local
selects the actual driver's maintained transaction API: Watchdog's
`fromNodeSqlite` savepoints for a real Node `DatabaseSync`, and native
`bun:sqlite` `Database.transaction(...)` for the Bun wrapper. The Node adapter
is never passed the Bun wrapper; Bun retains native `close(true)` to finalize
held statements. No savepoint machinery is copied into Local, and the old
non-nestable `BEGIN` adapter is removed.

The same driver laws run through the production opener under Node and Bun:
nested commit/rollback, native failure classification and cause preservation,
host-owned connection lifetime, held-statement finalization, and reopen of
committed data. The canonical submit/get projection tracer also runs against
both actual Local drivers. Additional approvals-bundle driver tests exercise
canonical answer/apply, atomic intent rollback and effect replay across reopen
through unchanged invokeModuleOperation on both drivers. These checks do not
prove production identity/fences, restart result delivery or producer wiring.
The form binding and SQLite adapter ride as consumers in boorsr's approvals
bundle, not as a separate production approval owner.

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
`runPrivateLocalAcpStdio` through `@fungi.computer/truffle/acp-stdio`. It serves
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
pnpm --filter @fungi.computer/truffle typecheck
pnpm --filter @fungi.computer/truffle lint
pnpm --filter @fungi.computer/truffle test:full
```

[Runtime-host tests](test/private-local-runtime-host.test.ts) exercise native
SQLite, provider fixtures, instruction snapshots, replay and close. On Linux
with Bun, `pnpm --dir runtimes/local run proof:sqlite-close` also checks
`/proc/self/fd` immediately after closing an Agent, its create receipt and a
service lease, without requesting garbage collection. This native descriptor
proof is Linux-specific; the ordinary Node suite also checks the writable
adapter's timeout, foreign keys, transaction state and changed rows.
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

`openLocalTeamApps` from `@fungi.computer/truffle/apps` opens the saved
account's selected Team. Its `read`, `requestGill`, `surfaceUrl` and
`openSession` operations keep credentials inside Local and recheck account
selection around reads. Gill requests resolve current directory selectors and
declared actions through the ordinary admitted App door. Hosted Session
transport uses the Local OAuth door and the same Team/resource capability rule
as browser Sessions. Closing a Session client releases observation; it does not
cancel durable work.

The directory grammar lives in `@fungi.computer/nacre/app-directory`. UI handoff
resolves the selected App's published surface on the saved Hub origin, without
putting an access token in the URL. A later account/Team selection retires this
client; open a new client for the new selection.

## Subscription credential activation

`fungi account use-credential --provider anthropic|openai --from-file -` accepts
bounded JSON on stdin:
`{ "expected": <OAuth credential or null>, "credential": <replacement OAuth credential> }`.
Tokens never travel in arguments or replies. Under the credential store's
existing refresh lock, the owner compares the expected provider entry
semantically, preserves every other provider, and atomically persists a 0600
replacement. A stale comparison fails closed with the fixed `conflict` category.
Input and filesystem failures expose only `invalid-input` or `store-failure`,
never parser diagnostics or causes. The machine-readable success is
`{"ok":true}`; failure also writes a bounded
`{"ok":false,"error":{"category":"..."}}` reply and exits nonzero.

Fungi remains the credential refresher. Local pins the Anthropic/OpenAI account
at the accepted turn boundary, including all subsequent tool iterations. Pi
refreshes that same account under the existing store lock while it remains
active; refreshed tokens do not change the pinned identity. The next turn picks
up an activated account without restarting the service.

Pi's `openai` provider uses the ChatGPT direct-token flow, not the legacy
`openai-codex` flow. Its credentials contain `clientId` and `scopes`, but do not
add `accountId`. Local decodes the access token with `jose`; only its issuer and
person `sub` identify the OpenAI subscription. Same-person refreshes are
adopted; a different issuer or subject is not. Workspace metadata is not
identity. An OpenAI grant without a provable person cannot establish turn
continuity. An already-started refresh is committed under Pi's existing lock
before Local decides whether the turn can adopt it; refusal or cancellation must
not discard the rotated refresh token or restore a released pin.

After switching A to B, the current turn may continue using A's still-valid
token, but never refreshes inactive A. If A expires, its next request ends the
turn with the typed, redacted `account-switched-during-turn` refusal: retry on
the next turn using B. Completed tool results remain in the Session. A's durable
inactive credential belongs to the external vault; Local creates no second
inactive-credential authority and does not rotate it behind the vault's back.

For vault capture, `fungi account prepare-credential --provider anthropic`
enriches a fresh Fungi login with Anthropic's OAuth profile account UUID. OpenAI
uses unpatched Pi OAuth: Local neither intercepts the code exchange nor reads
its ID token. After Pi returns a grant, Local requires a usable issuer and
subject in the access token before storage. No OpenAI workspace `accountId` is
captured or retained across refresh. Anthropic still retains its profile
account. `fungi account prepare-credential --provider openai` confirms only the
access token's issuer and subject, without a request or token change. Failures
expose `identity-unavailable` and bounded claim names, never token or claim
values, and preserve the prior entry. A turn detects a different OpenAI person
by issuer and subject and refuses as `account-switched-during-turn`.

Auth tests inject a fixture ChatGPT OAuth provider through `createPrivateModels`
and pass the resulting collection to `runLocalAuthCli`. They do not start Pi's
callback server or bind an OAuth port. Explicit temporary credential paths and
real-file size/mtime guards prevent touching the person's credentials. After
building Truffle's dependencies,
`pnpm --dir runtimes/local proof:unpatched-login` packs Truffle with npm and
signs in through that fixture in an external npm consumer using registry pi-ai
1.3.0. This qualifies the local seam and stored person identity, not a live
OpenAI authorization.

A provider HTTP refusal is reported as `provider_rejected` with its status code
only, never the response body. Use Fungi's ordinary login flow in a private
temporary HOME for additional accounts. External vault managers must reconcile
the live credential before switching and treat activation conflicts as failures,
not overwrite permission. This contract does not authorize a live import, login
change or cutover.
