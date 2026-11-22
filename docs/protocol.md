# Backend Protocol

The app-owned JSON-RPC 2.0 protocol between clients (Electron main, companion
clients, SSH peers) and `daemon`, one JSON message per line over stdio, the local
Unix socket and SSH stdio. Provider protocols (Codex app-server, Claude stream
messages, Antigravity and Cursor ACP, MCP) never cross it.

**The catalog is the code.** Methods are in `core/src/backend-protocol/methods.ts`,
typed params/results in the shared request map, error codes in
`core/src/backend-protocol/rpc.ts`, event unions in `core/src/contracts/events.ts`
(`BackendPublishedEvent`: domain facts, provider conversation frames and explicit
client effects are separate exported unions; `client.connectionChanged` is
renderer-local). This document records the conventions behind them.

## Conventions

Creation commands can return an explicit created-agent identity with their client
snapshot when requested. Callers use that identity rather than inferring a command
outcome from the currently selected agent. Legacy snapshot responses retain their
shape; client navigation remains separate from the shared product operation.

- Names are `resource[/subresource]/verb`, lower camel case, action last.
  Desktop-only and backend-internal renames have no aliases: stale local or remote
  daemons must be restarted or synced. Mobile-consumed contracts follow the
  compatibility rules below, including when routed through shared backend methods.
- State-mutating methods return the authoritative `AppSnapshot`. Mutations persist
  before `snapshot.updated` is published. Read acknowledgments use a bounded agent
  metadata event instead of resending the workspace and complete after persistence.
- Scope prefixes matter: `client/*` methods mutate one client's profile
  (navigation, ordering, preferences) and never another client's; the rest are
  backend-scoped. `_clientId` request metadata selects the profile and is stripped
  before dispatch. Forwarded daemon calls use a separate remote-controller profile,
  never the remote desktop's.
- Client commands never load conversations as a side effect. Clients request
  `agent/conversation/load` explicitly, and snapshot queries perform no
  maintenance (startup maintenance is runtime initialization).
  Conversation loads return the full snapshot and refresh workspace metadata by
  default. Desktop recovery opts into `omitSnapshot: true`: it hydrates provider
  frames without workspace refresh and returns `null`, except that it returns the
  full snapshot when hydration rebinds the agent's backend session, and it is
  rejected while a handoff is in progress. Stdio waits for queued
  output to drain before executing this opt-in so replay frames can be delivered.
  Remote agents retain the full composite snapshot response.
  Clients opt into `reportFailure: true` to receive a safe request error when
  hydration fails, independently of event delivery. Without this flag, failed
  hydration retains its snapshot response and `conversation.historyLoadFailed`
  event for compatibility with released clients.
  Unnegotiated clients retain the default request, response and event semantics.
- Location-scoped methods take optional `remoteConnectionId` / `location`; omitted
  means local. Agent-scoped methods route through the agent's owning location.
- Unsupported optional capabilities answer deterministically: archive returns
  `{ supported: false }`; unsupported history or summary reads are errors, never
  empty successes. Provider catalog UI respects advertised capabilities.
- `driver/*`, `workspace/*` and a few `source/*` methods are backend-internal. Client
  code uses the app-level methods.

## Mobile Compatibility

Mobile applications update independently of the desktop and daemon. Every contract
they consume must remain backwards compatible with shipped clients; desktop-only
contracts are exempt. The boundary includes companion operations, pairing and relay
messages, response framing and encoding, streamed workspace and conversation data,
and the shared or SDK-owned data serialized into those messages. A change in a
producer or dependency is a mobile API change when it changes that wire contract.

- Keep existing method names, accepted request shapes and values, defaults, and
  observable behavior. New request fields must be optional for existing operations.
- Preserve existing response and event fields, their types, nullability, units,
  identifiers and meaning. An additive field or enum/union variant is compatible
  only if shipped decoders can safely consume or ignore it.
- New representations, encodings and behaviors require explicit capability
  negotiation or a separate version while the old path remains available. A
  protocol version bump, app restart or forced mobile update does not preserve
  compatibility. Do not remove legacy handling merely because the current mobile
  source uses the replacement.
- Codex approval/request resolutions retain `surface` and
  `surface_disconnected` on the published wire. The daemon translates SDK host
  reasons before publication; current replicas translate them back on receipt.
- Prove compatibility through the owning runtime with released-client regression
  cases as specified in [testing.md](testing.md#mobile-compatibility-evidence).
  Passing checks against shared current types alone do not establish compatibility.

## Directions

- **Client → daemon:** product requests.
- **daemon → client notifications:** one method, `backend/event/notify`, carrying a
  sequenced `AppBackendEvent` and a small derived `clientState`.
- **Connection configuration:** `client/wire/configure` is answered by the transport
  for its own connection and never reaches the application. `{ snapshots: 'compact' }`
  makes every snapshot sent on that connection (results, `snapshot.updated`, snapshots
  beside other events) omit the proposal of finished Mission runs
  (`compactClientSnapshot`); the daemon keeps them. A compact snapshot is authoritative
  for the client that asked for it. A connection that never asks receives complete
  snapshots, which is what remote controllers and the CLI rely on; the phone is served
  its own projection by the companion gateway and never through such a connection.
- **daemon → client requests:** host callbacks for native effects only (open
  external, browser open/execute, spoken announcement, permission surfaces),
  currently implemented by Electron. Unknown methods answer `methodNotFound`; a
  throwing callback answers `internalError`. Each side owns the request IDs it
  sends.

## Synchronization

`snapshot/get` returns `{ snapshot, lastEventSeq, clientState }`. The snapshot is
authoritative and transcript-free; between snapshots clients replay only sequenced
`daemon` events through the shared reducer.

Electron and the renderer use a subscribe-buffer-snapshot barrier: subscribe, buffer
notifications while reading `snapshot/get`, discard snapshot-owned events at or below
`lastEventSeq`, apply only contiguous events above it. Provider frames received during or after
a synchronization barrier retain their own revision checks: the product snapshot cannot
replace their transcript data. For a connection attempt Electron opens the barrier
before it starts the connection and keeps it through the health check, the connection
configuration and the read, so a notification it receives meanwhile is replayed against
the state read at the end and not judged against the sequence of the connection being
replaced; a failed attempt drops what it buffered. A gap triggers a fresh
barrier, with one exception: a gap revealed by an incoming live `snapshot.updated` that
carries a complete snapshot and its `clientState` is repaired from that event, since a
read would return the same state. Electron then publishes a client-sourced snapshot
naming the backend sequence it is current to (`lastBackendEventSeq`), and a window
continues from it without reading the state again. A gap found while replaying the
events buffered behind a barrier always starts another read. After any repair the renderer treats cached provider
frames as possibly behind, because an app snapshot cannot replace a missed provider
completion event: conversations on screen are re-requested at once, the others when
they are shown or when their next frame arrives.
Clients ignore unknown event types.

A transport under backpressure keeps only the newest of the snapshots queued back to
back, never moving it ahead of another event. When the survivor directly follows the
snapshot it replaced, it carries `coveredFromSeq`, the first sequence it stands in for,
and a receiver treats the sequences from there to its own as delivered
(`continuesEventSequence`). When an event between the two was dropped for lack of
room, the survivor carries no such claim and the receiver sees the gap.

Provider conversations travel as one bounded reset followed by revisioned deltas in
`codex.conversation*`, `claude.conversation*` and `antigravity.conversation*` frames.
Electron forwards them unreduced; clients validate session identity, reject stale
or gapped revisions and rehydrate through app-owned conversation operations.

Event ingress is untrusted on every transport (stdio, socket, SSH, WebSocket):
decode the complete typed event before publishing. A malformed notification is
logged with structural path/reason only (never payload values) and dropped without
closing the connection or disturbing pending requests. Malformed JSON or JSON-RPC
framing keeps each transport's own error and reconnect policy.

## Lifecycles Owned By The Protocol

- **Agent requests** (approvals, questions, tool confirmations) appear in
  `AppSnapshot.agentRequests` through `agentRequest.created` / `.resolved`, with
  native transcript frames unchanged. Provider handles are never persisted;
  responses route by agent and request ID, guard concurrent submissions, allow retry
  after transport failure, and are invalidated by release or resolution. An
  untargeted response is accepted only when its request ID is unambiguous.
  Codex snapshots reconcile pending client requests, including missed resolutions;
  question lifecycle decisions remain in the provider runtime and are not persisted by Korus.
  Antigravity and Cursor native questions/approvals use app-owned answered/decision/cancelled
  outcomes; clients never interpret ACP frames.
- **Plan review** persists proposal identity, content and decision status
  (`Agent.planReview`). Replaying a completion never reopens a resolved proposal;
  the response command rejects stale or conflicting decisions, accepts an identical
  one idempotently, and stays pending until prompt acceptance succeeds. Cancel
  submits nothing.
- **Provider authentication:** `provider/authenticate` routes explicit Antigravity and Cursor
  native login/cancellation to the owning daemon. Connection observations remain
  separate from saved enablement.
- **Provider usage:** quota events update per-engine state; remote quota stays on
  its owning host. Missing utilization is not zero. `provider/usage/get` returning
  `null` means no subscription quota, not a failure. Authentication metadata on
  connection observations is runtime-only and credential-free.
- **Reconnect:** a dropped established connection retries the same transport; it
  never starts a fresh bundled daemon (see
  [backend-architecture.md](backend-architecture.md#transports)).

## Attachments

Local desktop registry resolution is the trusted ingestion boundary; renderer paths
are never provider input. Remote prompts reject them before forwarding until trusted transfer exists.

## Ownership

Product state belongs to `daemon`; Electron and the renderer cache snapshots and
replay events and never invent mutations. Filesystem reads, git, provider tokens
and calls, automations and scheduling stay in `daemon`. Electron owns only native
affordances (windows, menus, dialogs, `openExternal`, native permission callbacks,
speech helper and playback, process launching, transport plumbing).
