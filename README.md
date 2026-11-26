# claude-intercom

A Claude Code plugin whose MCP channel is itself a peer on the [pi-intercom](https://github.com/nicobailon/pi-intercom) bus. A Claude session can message a Pi session, a Pi session can message a Claude session, and a message that arrives while Claude Code is closed is not silently lost.

## Status

Phase P0: the package skeleton, the plugin manifest, the MCP entry point and the upstream adapter with its contract test. The channel declares the `claude/channel` capability and starts, and `intercom_status` reports the pinned upstream contract. Registration, presence labels, the durable outbox and the push path are the next phases, so a Claude session is not reachable on the bus yet.

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

A session registers under an id chosen per repository and publishes its readable name as a presence label, so a rename never moves the mailbox. The id survives a restart; the label follows `/name`.

## The upstream seam

`src/intercom/adapter.ts` is the only file allowed to import `pi-intercom`, pinned at the version in `PI_INTERCOM_CONTRACT`. It imports TypeScript source from inside another package, which works because that package ships `broker/**/*.ts` and declares no `exports` map; `test/unit/adapter-contract.test.ts` fails loudly if either changes, and `test/unit/import-boundary.test.ts` keeps the seam from eroding.

## Install

Not installable yet: P0 has nothing to deliver until registration and the push path exist.

```text
/plugin marketplace add elecnix/claude-intercom
/plugin install claude-intercom@claude-intercom
```

Channels are a research preview. A plugin outside the organization allowlist needs the development flag when the session starts:

```sh
claude --dangerously-load-development-channels plugin:claude-intercom@claude-intercom
```

## Development

```sh
npm ci
npm test
```
