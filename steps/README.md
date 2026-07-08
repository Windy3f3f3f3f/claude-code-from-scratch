# Runnable steps

Every code chapter of the tutorial has a **runnable code state**. Each one runs
with **no API key** against a local mock model, so you can enter the code as it
stands at the end of chapter *N* and watch it work:

```bash
npm install                      # once, at the repo root

node steps/run.mjs --list        # list every runnable step
node steps/run.mjs 7             # chapter 7 demo, no key (local mock)
node steps/run.mjs 7 --diff      # what chapter 7 added over the previous step
node steps/run.mjs 7 --py        # the Python version
```

The demo replays a scripted scenario so the output is deterministic. To drive a
step with your **own** prompt against a **real** model, add `--live` and put a
key in `.env` at the repo root:

```bash
cp .env.example .env             # then set ANTHROPIC_API_KEY (a relay URL works too)
node steps/run.mjs 2 --live -- "create hello.txt with the text hi"
```

The runnable steps cover chapters 1–12 and 15 (chapters 13/14 add no code); run
`node steps/run.mjs --list` for the full map. A few landmarks:

| Step | Chapter | The agent can now… |
|------|---------|--------------------|
| 1 | Agent loop | talk to the model in a loop and call one tool (`read_file`) |
| 6 | Permissions | a gate blocks dangerous tool calls |
| 7 | Context | summarize (compact) older messages when history grows |
| 11 | Multi-agent | fork a read-only sub-agent to investigate |
| 12 | MCP | connect an external stdio tool server |
| 15 | Autonomy | `/goal` chases a condition; `--auto` gates writes with a classifier |

## How it works — one source, generated snapshots

There is **one** source of truth in `steps/canonical/` (`ts/` and `py/`). A small
generator (`build.mjs`) slices it into self-contained, runnable snapshots under
`steps/dist/<step>/` — so the per-chapter code can never drift from the real
code, because it *is* the real code.

`run.mjs` builds the snapshots on first use, so you never call `build.mjs`
directly unless you want to inspect the output.

The canonical files carry step markers in comments:

```ts
//#step >=2          // keep the block below from step 2 onward
...
//#step <=2          // an "elif": used instead when building step 1 or 2
...
//#endstep
```

Python uses the same markers with a `#` leader (`#step >=2` … `#endstep`).
Lines outside any marker appear in every step. Consecutive `#step` lines before
an `#endstep` act as if/elif — the first branch whose condition matches the
target step wins.

## Adding or changing a step

1. Edit the canonical files under `steps/canonical/{ts,py}` (keep the two
   languages mirrored).
2. Register any new file and the step it first appears in, in `build.mjs`
   (`FILES`), and add the step to `STEPS`.
3. `node steps/run.mjs <N>` to regenerate and run.
