# AGENTS.md

<!-- fleet-invariants:start 2026-08-18 -->
## Fleet invariants (all Sandbox agents — 2026-08-18)

1. **Cortex first.** Fleet retrieval brain is **https://cortex.forge-os.ai** (skill sandbox-cortex). Query before cloning/grepping/re-researching. Auth: op://Openclaw/CORTEX_SERVICE_TOKENS/password. brain.makemysandbox.com is DEAD.
2. **Host plane is not assumed.** Many apps moved Render to Coolify/DO (forge-b/forge-c). Before deploy advice check this repo brief + live Coolify/Render status. Never claim Render from memory alone.
3. **Tools you actually have.** Verify live tool list each session. Do not assume Composio/Claude Desktop connectors. Prefer git/gh, 1Password SA, Coolify CLI, gibson-memory.
4. **PR protocol.** Live on agent/<id> only. Ship via PR. Reconcile to canonical every session.
5. **Daily memory.** End non-trivial work with memory/YYYY-MM-DD.md.
6. **Verify, do not claim.** Cron lastRunStatus=ok is not proof — check duration + artifacts.
7. **Python failing is your escaping, not `python3`.** Verify the interpreter before blaming it — it is almost always fine. Two real modes: (a) the file you wrote holds literal `\n` two-char sequences instead of newlines, so the indented body after `with`/`if`/`for` dies with `SyntaxError: unexpected character after line continuation character`; (b) heredocs via `exec` — `shouldSpawnWithShell()` is hard-coded `false`, so `<<EOF` is an argv token, not shell syntax, and `python3` hangs on stdin until the timeout. Rules: write a real `.py` **inside the workspace, never `/tmp`** (OpenClaw's syntax preflight only inspects files under `workdir` — and skips entirely at `security=full`+`ask=off`, our default, so today it never runs at all); `python3 -m py_compile <file>` before you execute it; one-liners only inside `python3 -c`; scheduled jobs run **committed** scripts, never ones regenerated at runtime. **Never re-run a script that just SyntaxError'd** — `cat` it and fix the escaping. Blind retries are the actual token burn. (Rose+Thyme 08-16 + 08-18 x2; morning-brief 08-14.)
8. **Coolify: one deploy path per commit.** Apps auto-deploy on git push (webhook). Do **not** also run `coolify deploy uuid` for that same SHA — double queue (API + webhook) starves forge-c. After push: wait. Manual deploy only if nothing is queued/in_progress after ~5 minutes. Stuck doubles: cancel queued duplicates; leave one in_progress; do not re-fire.
<!-- fleet-invariants:end -->

> Fleet invariants above are synced from the Sandbox workspace canonical copy.
> Edit them there, not here. Repo-specific guidance goes below.
