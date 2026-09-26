# nook

Nook is a personalised iMessage agent that walks you home at night: it watches your live location, checks in when something looks off, and can call you with a real voice that guides you to the nearest open bodega or 24/7 pharmacy.

## Docs

- [CONTEXT.md](CONTEXT.md) — architecture, TypeScript contract, rules, deploy notes
- [TEAM.md](TEAM.md) — Person A / Person B ownership and checklists

## Quick start (hour-0 scaffold)

```bash
bun install
bun run typecheck
bun run start          # HTTP /health on PORT (default 3000)
BRAIN_MODE=echo bun run smoke
```

Copy `.env.example` → `.env` and fill keys as you add Spectrum / Tiger / ElevenLabs.

`BRAIN_MODE=stub` (default): empty brain, logs events.  
`BRAIN_MODE=echo`: Person A harness — echoes `UserText` as `SendText`.
