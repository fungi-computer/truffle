# @fungi.computer/truffle

## 0.2.2

### Patch Changes

- Changes since 0.2.1:

  - fix(local): refuse discovery when a Git-reported path is access-denied
  - fix(local): handle sandbox Git discovery failures explicitly
  - fix(local): make commondir read-only and parse Git output as raw bytes
  - fix(local): ask Git for sandbox Git admin instead of walking payload
  - fix(spore): stop Bun loading Agent project config into host
  - fix(truffle): refuse agent-writable host JavaScript at sandbox admission
  - fix(local): throw typed command preparation refusals directly
  - fix(local): refuse bare sandbox fallback after readiness
  - fix(spore): refuse native permission tampering without bare fallback
  - fix(spore): refuse bare fallback after native digest mismatch
  - fix(spore): keep stale native sweep outside sandbox admission
  - fix(spore): share verified native staging across fallback and Files
  - fix(spore): order native digests and bound sandbox staging
  - fix(spore): anchor native payloads to built JS and stage verified bytes
  - fix(local): refuse Agent-owned native sandbox payloads
  - fix(spore): scope packaged patch helper bind to its file
  - fix(mule): own provider data types at the Pi boundary

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @fungi.computer/knapsack@0.2.1
  - @fungi.computer/shiitake-extensions@0.1.1
  - @fungi.computer/shiitake@0.3.1
  - @fungi.computer/graft@0.1.1
  - @fungi.computer/mycelium@0.2.1
  - @fungi.computer/zookeeper@0.0.2

## 0.2.1

### Patch Changes

- Updated dependencies
  - @fungi.computer/cordyceps@0.3.1

## 0.2.0

### Minor Changes

- Changes since 0.1.1:

  - fix(local): keep UI lifetime out of inspection inputs
  - fix(acp): retain UI attachments for connection lifetime
  - test(local): bound idle-owner retention by counts, not RSS
  - fix(local): preserve typed incompatible-store refusals
  - fix(local): retain bounded memory type-count maps
  - test(local): require the provider's grant invalidation in the issuer-switch
    proof
  - fix(local): drop preview credentials' unbound machine enrollments on write
  - fix(local)!: partition Fungi machine enrollments by issuer
  - test(local): red - an issuer switch dials B with A's machine enrollment
  - fix(local): treat vanished procfs reads as exited
  - fix(local): make sandbox budget proofs cheap and deterministic
  - test(local): expect a retried human-approved request to report answered
  - test(local): simplify sandbox command filter guards
  - test: clear the bundle's hub and local test lint findings
  - test(local): reach platform sandbox proofs from package suites
  - test(local): cover standalone enrollment store edits directly
  - fix(local): link credential implementation to its full contract
  - fix(mesh): clear the gate Fallow findings on the B4 bundle
  - fix(local): bound machine join acknowledgment bytes
  - fix(local): release transient Oyster enrollment bearer
  - feat(local)!: join standalone Oyster with ephemeral keys
  - docs(local): disclose program-created Git discovery boundaries
  - fix(local): stop Git discovery at nested checkout boundaries
  - fix(local): budget Git discovery by directories
  - fix(local): protect resolved sandbox paths and every Git directory
  - fix(local): own logout in the running Local service
  - refactor(mesh)!: move shared machine-link protocol into Seam
  - test: repair B4 sandbox and TUI qualification fixtures
  - test(mesh): align auth fixtures with repository contracts
  - fix(mesh)!: reauthorize Local machine links at ingress
  - test(local): register sandbox proof entry points
  - fix(mesh): expose transport types and return reservation cases to B1
  - fix(mesh): wire client guards and expose ping failure custody
  - feat(mesh)!: preserve caller-owned intents across Local reconnects
  - feat(mule,shiitake,parakeet)!: separate tool data from model values
  - test(local): repair isolated service recovery fixtures
  - test(local): avoid blocking libuv on lifecycle FIFO
  - test(local): register platform sandbox proof commands
  - fix(local): use maintained transactions for each SQLite driver
  - fix(local): use native nested transactions for SQLite owners
  - test(local): keep HOME retention probe within sandbox folder
  - fix(mesh): retain send failures and account-owned enrollment
  - refactor(local): separate SQLite failure observation from transactions
  - feat(local): bind approval forms to canonical ledger decisions
  - test(mesh): name account-lock coverage at its actual boundary
  - test(mesh): reach real enrollment and expose the next transport RED
  - docs(local): decouple sandbox landing from approval policy
  - feat(mesh): mount Local enrollment route and release listener custody
  - feat(mesh): build member-bound enrollment and home-aware mail routing
  - test: align retry consumers with typed provider ownership
  - test(local): observe completion replies in either model turn
  - fix: align inference event and Local failure type exports
  - feat(local): connect project MCP with private Oyster keys
  - fix(local): identify native peer send requests
  - test(local): await the maintained model stream factory
  - perf(core): compact shipped prompts and file tool schemas
  - fix(shiitake): admit ancestor peers within delegation depth
  - feat(local): join request-owned Agent recall
  - feat(agents): scope send and recall to caller requests
  - fix(local): retain config root in app panes and serve
  - fix(local): stop event observers before recovery
  - fix(local): pin host configuration through runtime and tui
  - chore: checkpoint 8FI before landed Slice 8C join
  - feat(local): bind service and worker config roots
  - feat(local): capture roots across unshared config callers
  - fix(files): share visibility for search roots and entries
  - fix(local): require injected roots for skills and extensions
  - fix(local): require injected credential and exec roots
  - feat(local): freeze injected config root contract and exec RED
  - refactor(files): split search tools and align hosted ignore visibility
  - refactor(mule): require typed retry contracts across model owners
  - refactor(extensions): own conversation Agent roster outside Oyster
  - fix(truffle): expose disabled recovery in private logs and live status
  - fix(truffle): preserve manifests when recovery initialization fails
  - test(truffle): inject the recovery manifest reader without module mocks
  - test: move CLI service logging proof into TUI ownership
  - fix(truffle): load saved recovery references before replacement writes
  - fix(truffle): release writable SQLite files on close
  - fix(truffle): answer readiness before restoring Agent owners
  - fix(truffle): preserve unpatched login proof after merge
  - test: align service diagnostics fixtures with the public contract
  - fix(oyster): keep Agent composition in the existing host pack
  - fix(truffle): classify unpatched Pi token request failures safely
  - fix(shiitake): retain Carrier reply retries in the runtime wake answer
  - fix(truffle): use unpatched Pi and person-only ChatGPT identity
  - test(subagents): align Local roster assertions with collapsed default
  - fix(truffle): observe reply mail after settlement before idle release
  - fix(truffle): let Agents that sent or delegated mail become idle
  - refactor(oyster)!: move the shell client into @fungi.computer/nacre
  - fix(truffle): report a ChatGPT usage limit as a typed reason
  - fix(truffle): never bind the real ChatGPT callback port from tests
  - test(truffle): cover OpenAI turn account rows for the same person
  - fix(truffle): accept OpenAI sign-ins that carry no workspace account
  - fix(truffle): keep auth failure types internal and export the wire result
  - fix(truffle): show why an OpenAI sign-in failed, never as free text
  - fix(truffle): restore typed message for earlier extension records
  - test(local): run Truffle Bun service tests in its batch test:unit
  - test(local): identity tests replace as the installed client
  - fix(truffle): keep reloading, draining and unreadable Agents safe in idle
    release
  - test(truffle): wait for the sub-agents refresh before counting read fds
  - fix(truffle): narrow the OpenAI ID-token catch to jose's JWTInvalid
  - test(local): use a stub launcher in the installed-build ensure tests
  - fix(truffle): release idle Agent owners instead of keeping every one
  - fix(truffle): record drain timeouts in the private service log
  - fix(truffle): keep doctor tests on the public status contract
  - fix(truffle): exchange the OpenAI login code through a Pi hook
  - fix(oyster): prepare the conversation footer record on first use
  - fix(truffle): capture OpenAI workspace from the login ID token
  - fix(local): stale clients never stop the installed service; bound drain
  - fix(oyster): list each conversation's created or sent Agents in its footer
  - fix(truffle): keep service log rotation bounds module-private
  - fix(local): align stop graph with nullable creation attribution
  - feat(truffle): own bounded native service diagnostics sink
  - fix(truffle): accept a concurrently unlinked create journal
  - fix(local): keep model descriptions observational
  - chore(local): checkpoint unqualified service logging draft
  - fix(local): prepare OpenAI capture identity from token claims
  - test(truffle): checkpoint controlled receipt unlink regression
  - fix(shiitake): retain Local-owned failure provenance
  - test(truffle): retain producer registration in rebind fixture
  - test(truffle): reject unused withdrawal in Session fixtures
  - fix(truffle): adopt same-person OpenAI refreshes across pinned turns
  - fix(truffle): use runtime-safe SQLite dispatch and maintained native API
  - fix(truffle): export SQLite public-shape input and output types
  - test(truffle): assert native SQLite failures without silent catches
  - fix(truffle): finalize read-only SQLite statements before closing
  - test(stop-all): qualify final toast pressure and bounded cancellation
  - test(extensions): bound fixture skill discovery to its synthetic project
  - fix(truffle): pin subscription accounts for each turn
  - fix(truffle): bind service signals to the transactional lease owner
  - fix(recall): preserve authorization errors across Session transport
  - fix(truffle): make discovery bounds independent of temporary-root length
  - fix(stop-all): toast rejected requests and await running cancellation
  - feat(truffle): add atomic subscription credential activation
  - chore(oyster): wip extraction pending host adapter corrections
  - fix(tui): stop incompatible recovery and bound rebind attempts
  - feat(spore): show one stop-all summary through pane toasts
  - feat(shiitake): carry process-local tool output snapshots
  - feat(truffle): stop made-by Agent trees without retiring chats
  - fix(reload): verify live snapshots and release removed timers
  - fix(truffle): signal only the process service.json names
  - fix(truffle): never let fungi stop signal its own process
  - chore: checkpoint fungi reload WIP, not ready
  - fix(truffle): name pid-less records and EPERM in fungi stop
  - feat(tui): show a restart overlay and rebind the Session when the service
    returns
  - test(spore): wip CLI e2e for stale-service replacement, not ready
  - fix(subagents): stop projecting the creator into Local sub-agent rows
  - test(goal): bring the goal proofs to the current model and footer
  - feat(truffle): version-checked ensure for every client start
  - fix(truffle): bound fungi stop with SIGTERM, then SIGKILL after 5 s
  - test(zookeeper): the Local and Hub writers' receipts reach the entry
  - fix(truffle): make the blank-key refusal fixed by type and prove it end to
    end
  - fix(zookeeper): encode Session ids once for both writers and prove the real
    paths
  - fix(truffle): show a refused blank API key as plain No key entered in /login
  - fix(truffle): refuse a blank API key at the login prompt
  - fix(tui): make Esc during sign-in a calm cancel
  - test(local): the roster lists Zookeeper's compaction handoff
  - feat(zookeeper): wire the compaction handoff into Hub and Local rosters
  - fix(truffle): keep verified archive on fsync failure; fsync on EEXIST; check
    key
  - refactor(zookeeper): share the golden fixture via ./testing; pnpm-generated
    lock
  - feat(truffle): local file archive writer for Zookeeper compaction archives
  - fix(truffle): open the current-version marked store and ticket the prints
    flake
  - fix(agents): gate open-pane commands behind archive, name unreadable pending
    work
  - fix(agents): serialize archive with admission, refuse pending work and old
    stores
  - feat(subagents): /agents collapses and expands the footer rows; failure log
    names its cause
  - feat(agents): archive agents; an agent tidies the ones it made, a person any
  - test(shiitake): run one Woodstock storage conformance suite on every host
  - feat(shiitake): run on pi-ai 1.3.0
  - fix(local): list unreadable Agents over the wire; name unnamed Agents with
    Cairn words
  - fix(local): shrink each image in a throwaway worker so its memory returns
  - feat(local): shrink Files images in-process before they reach the model
  - fix(computer): make files-patch output truncation explicit
  - fix(truffle): old extension records say how to recover; deterministic skill
    winner
  - fix(local): show an old-schema store in the landing picker as unreadable
  - fix(local): a failure status without a readable body is a typed error
  - fix(skills): propagate non-ENOENT realpath failures for display roots
  - fix(files): one image path through the execute collector, exact signatures,
    fixed windows
  - feat(files): one find tool replaces list, glob and grep
  - feat(local): an Agent creating an Agent cannot give it more than it holds
  - feat(files): read png/jpeg/gif/webp as image parts, refuse over 3 MiB
  - feat(extensions): installed extensions can bring skills
  - fix(exec): unmistakable truncation marker, bonsai checks pin, description
    facts
  - fix(files): search real repos past .git and gitignored trees
  - fix(exec): say when command output is cut at the stream cap
  - fix(local): review fixes for the Agent picker
  - fix(local): /model sets the Agent's default; one startup-model resolver for
    sessions and the landing
  - fix(local): name --db in the several-Agents error
  - fix(local): pick the Agent when a folder has several, and say why select
    fails
  - fix(local): fail loudly on an Agent store that predates the current schema
  - feat(session): show another Agent's message as a compact block
  - refactor(agents): keep the stored default as the one meaning of model
  - fix(local): pass user session locators to Local exec children
  - feat(agents): name, model echo, thinking level and wait bound for native
    subagents
  - fix(skills): trim the model's skills prompt
  - fix(tui): show the thinking level as (level) so narrow footers keep the
    model
  - fix: remove Shiitake dogfood friction in execute, exec, apply_patch and the
    TUI footer
  - test(local): follow the Loop projection without history events
  - feat(oyster): public release 0.2.0

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @fungi.computer/agar@0.3.0
  - @fungi.computer/approvals@0.0.2
  - @fungi.computer/bird-dog@0.1.0
  - @fungi.computer/cairn@0.1.0
  - @fungi.computer/carrier@0.1.0
  - @fungi.computer/cordyceps@0.3.0
  - @fungi.computer/gills@0.2.0
  - @fungi.computer/graft@0.1.0
  - @fungi.computer/knapsack@0.2.0
  - @fungi.computer/lantern@0.3.0
  - @fungi.computer/mycelium@0.2.0
  - @fungi.computer/nacre@0.0.1
  - @fungi.computer/seam@0.1.0
  - @fungi.computer/shiitake-extensions@0.1.0
  - @fungi.computer/shiitake@0.3.0
  - @fungi.computer/veil@0.2.0
  - @fungi.computer/watchdog@0.1.0
  - @fungi.computer/whistle@0.1.0
  - @fungi.computer/zookeeper@0.0.1

## 0.1.1

### Patch Changes

- Initial public release of @fungi.computer/truffle.
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @fungi.computer/agar@0.2.0
  - @fungi.computer/gills@0.1.0
  - @fungi.computer/graft@0.0.1
  - @fungi.computer/knapsack@0.1.0
  - @fungi.computer/lantern@0.2.0
  - @fungi.computer/mycelium@0.1.0
  - @fungi.computer/oyster@0.2.0
  - @fungi.computer/shiitake@0.2.0
  - @fungi.computer/veil@0.1.0
  - @fungi.computer/whistle@0.0.2
  - @fungi.computer/shiitake-extensions@0.0.2
