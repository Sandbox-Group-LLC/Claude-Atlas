# AGENTS.md

<!-- fleet-invariants:start 2026-08-18 -->
## Fleet invariants (all Sandbox agents — 2026-08-18)

1. **Cortex first.** Fleet retrieval brain is **https://cortex.forge-os.ai** (skill sandbox-cortex). Query before cloning/grepping/re-researching. Auth: op://Openclaw/CORTEX_SERVICE_TOKENS/password. brain.makemysandbox.com is DEAD.
2. **Host plane is not assumed.** Many apps moved Render to Coolify/DO (forge-b/forge-c). Before deploy advice check this repo brief + live Coolify/Render status. Never claim Render from memory alone.
3. **Tools you actually have.** Verify live tool list each session. Do not assume Composio/Claude Desktop connectors. Prefer git/gh, 1Password SA, Coolify CLI, gibson-memory.
4. **PR protocol.** Live on agent/<id> only. Ship via PR. Reconcile to canonical every session.
5. **Daily memory.** End non-trivial work with memory/YYYY-MM-DD.md.
6. **Verify, do not claim.** Cron lastRunStatus=ok is not proof — check duration + artifacts.
7. **Never `python3 <<EOF` / `python3 <<'PY'`.** Write a real `.py` **inside the workspace** and run `python3 that/file.py`. Through `exec` a heredoc is not shell syntax, python receives mangled input, and you get `SyntaxError: unexpected character after line continuation character`. Same error if the file you wrote holds literal `\n` two-char sequences instead of newlines. **Seeing that error twice means the fault is yours, not `python3`'s — `cat` the file and look. Never re-run it unchanged; blind retries are the token burn.** `python3 -m py_compile <file>` before executing it; one-liners only inside `python3 -c`; scheduled jobs run committed scripts. (72 real hits on a single agent, measured 2026-08-19.)
8. **Coolify: one deploy path per commit.** Apps auto-deploy on git push (webhook). Do **not** also run `coolify deploy uuid` for that same SHA — double queue (API + webhook) starves forge-c. After push: wait. Manual deploy only if nothing is queued/in_progress after ~5 minutes. Stuck doubles: cancel queued duplicates; leave one in_progress; do not re-fire.
<!-- fleet-invariants:end -->

> Fleet invariants above are synced from the Sandbox workspace canonical copy.
> Edit them there, not here. Repo-specific guidance goes below.
