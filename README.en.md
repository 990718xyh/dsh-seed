# dsh-seed

[中文](README.md) | English

**A persona that grows from scratch inside DSH.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![dsh](https://img.shields.io/badge/dsh-%E2%89%A50.2.0-blue)](https://github.com/deepseek-ai/deepseek-harness)

DSH starts over every session. The rules you set, the boundaries you agreed on, the mistakes you already paid for — gone next turn.

A character card fixes "does it feel like a person". It does not fix "does it remember you". A memory plugin remembers facts, but doesn't become anyone because of it.

dsh-seed does both: it records what happened, and grows someone out of it.

## What you get

**No more re-introducing yourself.** Every turn starts by putting back what it calls you, the boundaries you agreed on, and the mistakes you already made. Say "don't ping me on Sundays" once — it holds.

**It changes on its own.** Once there's enough material it rewrites the "who I am" section. It drafts first, passes review, and rolls back when the evidence is thin.

**You can watch it.** The panel shows how many entries each of the nine layers holds, which version of the self-description is live, and how many characters this turn pushed into context.

## Install

Search `dsh-seed` in the **Add plugin** wizard, or use the CLI:

```sh
# browser build
dsh plugin --profile web add github:990718xyh/dsh-seed

# desktop build
dsh plugin --profile desktop add github:990718xyh/dsh-seed
```

Restart DSH afterwards. Don't rush to the panel — talk for a couple of turns first. It has nothing to show until the first turn ends.

## What runs every turn

```
end of turn
 │
 ├─ extract: anything worth keeping from this turn
 │
 ├─ govern: how the new thing relates to the old one
 │     ADD / UPDATE / DELETE / NOOP / DEFER
 │
 ├─ 5 unread events → reflect: judgments, each pinned to event ids
 │
 └─ enough judgments → self: draft → review → commit or reject
```

Extraction and reflection both run on a small model. Failures go to the audit log; they never interrupt the conversation.

## What it does differently

- **Facts are never physically deleted.** Wrong ones get marked `invalid` with an end timestamp, so you can still see why they were believed at the time.
- **Memory strength.** Retrieved once: `+0.05` (capped at 1.0). Unused for a day: `×0.998` (floor 0.1). Names, agreements and prohibitions are pinned — they never fade and are injected every turn.
- **Reflection needs evidence.** Every judgment carries real event ids. Without them it's dropped. Otherwise the model launders its own guesses into things you "said".
- **The self-description has a gate.** Edits go through proposal → review. Thin evidence gets rejected and rolled back.
- **Retrieval.** Unicode-aware tokenizing (CJK bigrams / whole words elsewhere / NFKC), idf weighting plus BM25 length normalization. Entries scoring within 85% of the turn's best match skip the recency decay.
- **Only three things about you are stored.** What to call you, the boundaries you agreed on, what you ruled out. Recording everything means nothing sticks.
- **Zero dependencies.** Only `node:` built-ins. No native modules, no build step.

## Config

`~/.dsh/profiles/<profile>/cordis.patch.yml`:

```yaml
- insert:
    - id: persona
      name: 'dsh-seed'
      config:
        id: seed
        dir: ~/.dsh/persona
        heartbeat: { enabled: true, everyMinutes: 30 }
        study: { enabled: false }
        panel: { enabled: true, route: /persona, port: 8787 }
```

`id` is the data directory name. Leave `llm` unset to follow whichever model is selected — hardcoding it breaks after a model switch with `no API key`, and the whole extraction chain stops silently.

Self-study is off by default. It uses the network and costs money; turn it on when you want it.

> The panel listens on 8787. If that port is taken, change `panel.port` — otherwise the panel never starts and you only get a `panel-error` line in the audit log.

## Data

Everything lives in `~/.dsh/persona/<id>/`, as plain text:

```
journal/<host>.jsonl   every write, append-only
snapshot/base.json     compacted baseline
heartbeat.json         heartbeat state
```

## Uninstall

```sh
dsh plugin --profile desktop remove dsh-seed
```
