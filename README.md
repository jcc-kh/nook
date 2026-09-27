# nook

Nook is a personalised iMessage agent that walks you home at night: it watches your live location, checks in when something looks off, and can call you with a real voice that guides you to the nearest open bodega or 24/7 pharmacy.

## Docs

- [CONTEXT.md](CONTEXT.md) — architecture, TypeScript contract, rules, deploy notes
- [TEAM.md](TEAM.md) — Person A / Person B ownership and checklists

## Quick start

```bash
bun install
cp .env.example .env   # set DATABASE_URL from Tiger Cloud
bun run db:migrate
bun run seed:user
bun run seed:history   # ~2 weeks of walks for personalization
bun run typecheck
bun run start          # GET /health — BRAIN_MODE=stub|echo|live
```

### Person B sim suites (no phone)

```bash
bun run sim:l1   # R1 R2 R2x R3 R4 R14
bun run sim:l2   # R5b R7 R8 R9a R10 R16
bun run sim:l3   # R5a R6 R9b R15 (+ baselines)
bun run sim:l4   # R11 R13 getLiveContext resume
```

`BRAIN_MODE=live` wires the real rules brain (needs `DATABASE_URL`).  
`BRAIN_MODE=echo` is Person A’s harness. `stub` logs events only.
