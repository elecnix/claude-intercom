# claude-intercom

A Claude Code plugin whose MCP channel is itself a peer on the [pi-intercom](https://github.com/nicobailon/pi-intercom) bus. A Claude session can message a Pi session, a Pi session can message a Claude session, and a message that arrives while Claude Code is closed is not silently lost.

## Status

Phase P1: the channel registers on the bus under an id derived from the repository directory, publishes a readable label, republishes both after a disconnect, and starts the broker itself when no Pi session is running. `intercom_status` reports the id, the label and the connection state. Messages are received but not yet handed to the model: the durable outbox and the channel push are P2 and P4, so a message sent to this session today reaches a socket that logs it and nothing more.

## Design in one page

A separate bridge process was rejected: it would duplicate what the broker already is — the connection holder, the queue, the retention window and the identity rules — and a live bridge that cannot answer turns a clear refusal into a silent timeout. `pi-intercom` grants registration to any process through `IntercomClient.connect()`, so the channel is the peer.

Three upstream facts the design rests on, each measured against a private broker rather than assumed:

| Situation | Behaviour |
| --- | --- |
| Peer connected | `delivery: "socket_delivered"` |
| Peer disconnected | `delivery: "queued"`, held in memory for 24 hours |
| `ask` a disconnected peer | refused at once with `E_TARGET_DISCONNECTED`, never queued |
| Reconnect with the same `sessionId` | the queue is replayed in order |
| Broker restarted with mail queued | the mailbox is lost, it lives in memory |
| Second live process claims an id | refused, with the holder's pid and directory |

The consequence that shapes the code: the broker counts a message as delivered once it reaches the socket, so a session that is busy or compacting can lose text the broker already forgot. The channel therefore keeps its own outbox on disk, written before each push, and reads receipts back from Claude's transcript.

## Identity

A session registers under an id chosen per repository and publishes its readable name as a presence label, so a rename never moves the mailbox. The id survives a restart; the label follows a rename.

| | |
| --- | --- |
| id | `claude-<8 hex of sha256(realpath(cwd))>`, so a symlink or a trailing slash names the same mailbox |
| label | `claude@<directory name>`, overridden by `CLAUDE_INTERCOM_LABEL` |
| second session, same repository | the broker refuses an id held by a live process, so the second session takes `-2` and a mailbox of its own |
| disconnect | the same id is reclaimed, the label is republished, retries back off 1 s, 2 s, 4 s to a 30 s cap |

The broker is started by the channel when nothing is listening, so a machine that runs only Claude Code still has a bus.

## The upstream seam

`src/intercom/adapter.ts` is the only file allowed to import `pi-intercom`, pinned at the version in `PI_INTERCOM_CONTRACT`. It imports TypeScript source from inside another package, which works because that package ships `broker/**/*.ts` and declares no `exports` map; `test/unit/adapter-contract.test.ts` fails loudly if either changes, and `test/unit/import-boundary.test.ts` keeps the seam from eroding.

## Install

Installing gets a session registered on the bus and listed by its peers, but nothing
reaches the model yet: messages are received and dropped until the durable outbox and
the channel push land in P2 and P4. There is no entry in the `elecnix-plugins`
marketplace yet, so install from this repository's own manifest as below.

```text
/plugin marketplace add elecnix/claude-intercom
/plugin install claude-intercom@claude-intercom
```

Channels are a research preview. A plugin outside the organization allowlist needs the development flag when the session starts:

```sh
claude --dangerously-load-development-channels plugin:claude-intercom@claude-intercom
```

## Development

Node 24 LTS or newer: the adapter loads TypeScript from `node_modules` through tsx, and Node 24 is the oldest line this repository tests.

```sh
npm ci
npm test
```
