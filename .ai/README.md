# AI Documentation Guide

## For AI Agents

**Start here**: Read `context.md` (~3KB, 120 lines) - it has:
- File navigation map (where everything is)
- Core rules (must-follow conventions)
- Common task patterns
- Critical gotchas

**Don't**: Read all docs at session start (wastes tokens)

## For Human Developers

Start with `../README.md` for full project overview.

## Document Sizes

| File | Size | Lines | Purpose |
|------|------|-------|---------|
| `context.md` | 3KB | 120 | Entry point (read every session) |

**Total**: ~3KB / 120 lines

## Maintenance

**Update when**:
- Major refactor → Update `context.md` architecture
- New module → Add to `context.md` file map
- New gotcha → Add to `context.md` warnings
- Command changes → Update IPC pattern

**Keep lean**: `context.md` should stay <10KB

---

This `.ai/` directory provides AI-optimized context. Compatible with Claude / GPT-4 / Cursor / Copilot / Windsurf.
