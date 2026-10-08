# mini-letta

A tiny stateful agent with **git-backed memory**, rebuilt step by step from the memory subsystem of [letta-ai/letta-code](https://github.com/letta-ai/letta-code) (reference commit `70ead335`). Companion code for the book 《从 Letta Code 到 Mini-Letta：给 Agent 装上会成长的记忆》.

```text
你：记住：我用 pnpm
  ⚙ bash(cd "$MEMORY_DIR" && printf '- 我用 pnpm' >> human.md && git add human.md && git commit -- human.md)
  ✓ 839a6c6 chore: remember user fact
mini-letta：好的，我已经把这件事记进记忆里了。
```

- Memory is a git repo of Markdown files (MemFS v2 layout); a pre-commit hook validates it.
- Only **committed** memory is compiled into the system prompt; a changed revision reaches a running conversation as a persisted `<memory_update>` reminder.
- The context window is compacted before it overflows; every message stays searchable (BM25 recall).
- After compactions (or every N steps) a **reflection** subagent reviews the transcript in a private git worktree; the harness merges it back.
- Memory syncs between machines through a remote; other agents' memory is hidden by a kernel sandbox (bubblewrap).
- A read-only **Memory Palace** web page shows files, history, conversations and prompts.

## Versions (one tag per Part of the book)

| tag | adds |
|---|---|
| `v0.1` | agent loop, mock LLM, memory blocks compiled into the system prompt |
| `v0.2` | MemFS: per-agent git repo, v2 layout, file/bash tools, embedded pre-commit validator |
| `v0.3` | compiler with deferred memory, per-conversation prompt cache, `<memory_update>`, post-turn reminders |
| `v0.4` | token budget, sliding-window compaction, in-context id list, recall search |
| `v0.5` | reflection: watermark, triggers, worktree, finalize state machine, lock |
| `v1.0` | remote sync, cross-agent isolation (guard + bwrap), Memory Palace, e2e, Docker |

`git diff v0.2 v0.3` shows exactly what a chapter adds.

## Run

```bash
bun install
export MINI_LETTA_HOME=$(mktemp -d)        # never touch real state while playing
bun src/cli.ts chat                        # REPL (mock model, offline)
bun src/cli.ts chat -p "记住：我用 pnpm"     # one turn
bun src/cli.ts prompt [--fresh]            # the system prompt this conversation uses
bun src/cli.ts memory log|tree|path
bun src/cli.ts search 数据库端口            # recall search
bun src/cli.ts compact | recompile | reflect [--instruction ...]
bun src/cli.ts sleeptime --trigger step-count --steps 25
bun src/cli.ts palace --port 8787          # Memory Palace
```

Real model (any OpenAI-compatible server; tested with Ollama `qwen2.5:3b`):

```bash
MINI_LETTA_PROVIDER=openai OPENAI_BASE_URL=http://localhost:11434/v1 MINI_LETTA_MODEL=qwen2.5:3b bun src/cli.ts chat
```

| env | effect |
|---|---|
| `MINI_LETTA_HOME` | storage root (default `~/.mini-letta`) |
| `MINI_LETTA_PROVIDER` | `mock` (default) or `openai` |
| `MINI_LETTA_CONTEXT_WINDOW` | context window in tokens |
| `MINI_LETTA_REMOTE_ROOT` | directory of bare repos acting as the memory server |
| `MINI_LETTA_FS_SANDBOX` | unset: reflection confined · `1`: shells too · `0`: nothing |
| `MINI_LETTA_CONSTRAINTS_UPDATE=1` | allow a commit that changes `.memfs.config.json` |

## Verify

```bash
bun test                     # 46 tests
bun run typecheck
bun run check:cycles
bun scripts/e2e.ts           # the whole story across two "machines"
docker compose up -d && docker compose --profile test run --rm e2e
```
