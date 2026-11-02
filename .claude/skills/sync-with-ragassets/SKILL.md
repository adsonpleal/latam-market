---
name: sync-with-ragassets
description: Refresh data/latam-items.json from the client tables published by ragassets. Use after a RO LATAM client update, when a new item is not found by the search, or when the catalogue looks old (a name in Spanish, a stale description).
---

# Sync the catalogue with ragassets

## Why this exists

The service searches for an item by name, and that name comes from
`data/latam-items.json` — fourteen-thousand-odd items in pt-BR, committed to the repository
and shipped inside the deploy tar. The file is vendored on purpose: the server comes up as a
single bundle on EC2 and loads the catalogue **before** it listens, so fetching it over the
network at boot would tie "the market is up" to "a second host is up".

Vendoring has a cost, though: the copy goes stale on its own. The source is
[ragassets](https://github.com/adsonpleal/ragassets), which extracts the game client's
tables and publishes them at `https://assets.latam-tools.com.br/raw/`. One single source,
always current, with no sibling checkout on the machine — the catalogue used to be copied
from the latam-ro-calc checkout next door, which required the sibling to be present **and**
already up to date, and left the catalogue here as old as the older `git pull` of the two.

## When to run it

- After a RO LATAM client update (new items, translated names).
- When someone complains that the search cannot find an item that exists in the game.
- When a name comes out in Spanish: a sign that the translation reached the client and not
  here.

Before running it, check whether ragassets has already regenerated the tables for the new
client version — syncing against an old table gets you nowhere.

## How to run it

```bash
pnpm sync:items
```

Fetches `https://assets.latam-tools.com.br/raw/items.json` and rewrites
`data/latam-items.json`. Without network, with ragassets next door:

```bash
node tools/sync-items.mjs --input ../ragassets/resources/raw/items.json
```

It also takes `--url` (another source) and `--out` (another destination). The former
`LATAM_ITEMS_SOURCE` is gone: it pointed at an already-converted catalogue, and the source
is now the client's raw table — the same name with incompatible content would give an error
that is hard to understand.

## What it produces

`data/latam-items.json`: an object keyed by item id, compact JSON, ~6.6 MB.

```json
{"501":{"name":"Poção Vermelha","description":"…","aegisName":"빨간포션"}}
```

`description`, `aegisName` and `slots` are optional and **disappear** when empty (`slots: 0`
is the absence of a slot). Key order is part of the format: it is what makes two generations
of the same data come out byte for byte identical.

The script prints the count before and after, and warns when the new catalogue has fewer
items than the previous one — which almost always means the source was only half there.

## How to check it

```bash
git diff --stat data/latam-items.json
```

- **No diff** is what to expect when the client has not changed since the last sync. It is
  also the test that the script did not touch the format: if the source is the same and the
  file changed, the problem is the conversion, not the data.
- **With a diff**, look at the count the script printed. A new item coming in is normal
  after a client update; items vanishing en masse is not.

Afterwards:

```bash
pnpm test        # includes the conversion's format test
pnpm typecheck
```

A diff here fires **both** deploys: the service (which embeds the file in the tar) and the
interface (`web-deploy.yml` watches this path, because `web/scripts/build-catalogue.mjs`
generates the descriptions and the untradable list from it). It is worth a commit of its
own, so `git log` shows when the catalogue moved.

## What stays in Portuguese, and why

- `name:` in the frontmatter is the skill's identifier: renaming it breaks every reference
  to it.
- Command, flag, script, file, JSON field and product names are called, not read — they stay
  as they are spelled.
- Strings quoted from the game or the interface (`"Poção Vermelha"`, `"빨간포션"`) are the
  data itself. The catalogue is pt-BR, so translating an example would make this skill
  describe a file that does not exist.
