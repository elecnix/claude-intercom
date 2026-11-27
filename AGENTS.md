# Working in this repository

Claude Code sessions become peers on the [pi-intercom](https://github.com/nicobailon/pi-intercom) bus. The design decisions and the measurements behind them are in `README.md`; this file carries the rules that are easy to break by accident.

## Gates

Run these before a pull request. CI runs the same commands.

```sh
npm run typecheck
npm test
```

## Rules that are not style

- **One seam.** `src/intercom/adapter.ts` is the only file that may import `pi-intercom`. `test/unit/import-boundary.test.ts` enforces it. A second import path means an upstream change lands in two places instead of one.
- **Bump the pin with the tests.** Changing `PI_INTERCOM_CONTRACT.version` without re-running the contract test moves a broken assumption into a running session.
- **The broker's `queued` is not success.** A message waiting in the broker mailbox is delivered to nobody yet. A tool result must say so.
- **Write the outbox before the push.** The broker forgets a message the moment it writes it to the socket; a push that never reaches the transcript is lost unless it was already on disk.
- **The label is not the identity.** A session's mailbox is its id. Presence names follow renames and are never used to route.
- **Never mint a new id on reconnect.** The broker keeps a queue against the old id; a fresh one strands it. The label is republished instead, because a rename made while disconnected has to survive the gap.
- **One retry at a time.** A duplicate close event must not arm a second timer.
- **Exit with stdin.** A channel server that outlives its session shows the session as listening when it is gone.

## Phases

P0 skeleton and upstream contract, P1 identity and registration, P2 durable outbox and transcript receipt, P3 the MCP tool surface, P4 the channel push, P5 the test tiers, P6 docs and a doctor command. Each phase is reviewable alone; P0 is merged-ready on its own pull request and P1 stacks on it.

## Test tiers

1. **Unit.** Pure functions and the upstream contract, no broker.
2. **Fake broker.** A Unix socket server speaking the framing protocol, which refuses an unknown message type or a missing field.
3. **Real broker.** A broker started in a scratch `PI_CODING_AGENT_DIR`, never the live one.
4. **Live.** A real Claude Code session and a real Pi session. Only this tier proves that a push starts a turn.
