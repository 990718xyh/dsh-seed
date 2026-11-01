# Changelog

[中文](CHANGELOG.md) | English

## [0.7.2] - 2026-11-01

- Self-study can read papers now; what it reads is distilled into knowledge cards
- Cards with similar content only get their confidence raised and sources merged, instead of piling up duplicates
- Added time injection: the context gets "morning / afternoon" directly, so the model doesn't have to infer it
- Panel gets a manual trigger entry; no need to wait for the timer
- Fixes: self-study sometimes can't come up with topics, some readable pages fail to fetch, and the log doesn't show which step it got stuck at
- Added rule-change verification: rule additions/changes go through 3 independent agents (pro, con, least-likely-to-hold point), adjudicated by the Lead; disagreements are downgraded to todos instead of deleting the rule; only new and changed rules are verified (rule verification: off by default — spawning 3 agents burns tokens — enable it in local config)
- Injection slimming: convention/prohibition rules are capped at 10 entries and 45 characters each, with an "N more" hint; the rule set is also merged into 15 short sentences

## [0.7.1] - 2026-11-01

- Fixed tool registration timing (tools disappeared after a restart) and the tool count in the injected context (always showed the pre-registration number)
- Startup self-check warns when `id` points at an empty directory

## [0.7.0] - 2026-10-31

A persona plugin that grows by itself: it gives an agent memory, reflection, daily self-study and heartbeat self-check. It consolidates what is worth remembering from a conversation and feeds that context back at the start of the next one; it starts with no preset persona — character and memory grow from use.
