# @pipeworx/mi-medical-exclusions

Michigan Medicaid provider sanctions screening. Check a provider by name, NPI or
license number against the Michigan Department of Health and Human Services
(MDHHS) List of Sanctioned Providers, the state-level counterpart to the federal
HHS OIG LEIE (`leie` pack) and sibling of `il-medical-exclusions`,
`tx-medical-exclusions`, `ny-omig-exclusions`, `ca-medical-exclusions` and
`fl-medical-exclusions`.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1866+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `mi_medical_check_exclusion(name?, npi?, license?, limit?)`: screens a provider.
  An NPI or license match is an **identification**; a name match, even an exact
  one, is a **candidate lead only** (no date of birth is published). The response
  leads with counts by sanction source, then the matches. Each match carries the
  sanction date and source, a second sanction date and source where present
  (often the action being lifted), provider category and MDHHS's reason text. A
  no-match names the filters tried.
- `mi_medical_exclusion_coverage(year? | start_date? end_date?)`: totals by
  sanction source, individuals vs businesses, NPI, license and reason coverage,
  oldest and newest sanction date and the list's own publication date. With
  `year` or a date range it **counts** sanctions in that window over the whole
  list, split by sanction source. The counted field is `sanction_date` (the first
  Sanction Date column), never the second date; the response says so.

## Auth

Keyless.

## Data source

Michigan Department of Health and Human Services, List of Sanctioned Providers
(4,111 rows at capture). It merges sanctions from MDHHS, its Office of Inspector
General, Licensing and Regulatory Affairs, the former DCH and HHS; each row names
its source. `data_as_of` is the publication date printed on the list itself.

## What the list does and does not say

- MDHHS says the list is built partly from outside sources and may be incomplete.
- The reason field is free text and is **blank on about 60% of rows**; some values
  are Social Security Act section numbers such as `1128(a)(1)`, not plain language.
- No date of birth and no reinstatement flag. When an action was lifted the row
  usually stays with a second date (for example "Summary Suspension Terminated"),
  so read `reason` and `second_sanction_date` together before calling anyone
  currently sanctioned.

## Personal data

The list has a City column. It is kept for **businesses only**; for any individual
it is dropped at ingest, and a test asserts it. No street address or date of birth
is published or served. This follows the standing rule for state exclusion packs:
name plus the sanction record plus the date, never an address for an individual.

## How the data is served

The publication is a bulk spreadsheet, not a query service. It is copied by
`scripts/bake-index.mjs`, registered in
`workers/gateway/src/pack-baked-indexes.json`, uploaded to KV at deploy and
injected as `args._bakedIndex` (never a module-scope import; fleet #2754). A
missing or malformed injection throws loudly rather than answering "not found".

Refresh: re-run `node mcps/mi-medical-exclusions/scripts/bake-index.mjs` and
commit; there is no scheduled refresh yet, same as the sibling baked packs.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "mi-medical-exclusions": {
      "url": "https://gateway.pipeworx.io/mi-medical-exclusions/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/mi-medical-exclusions/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1866+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/mi_medical_check_exclusion \
  -H 'Content-Type: application/json' \
  -d '{"name":"1st Priority Physical Therapy"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/mi_medical_check_exclusion`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "mi-medical-exclusions": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-mi-medical-exclusions"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-mi-medical-exclusions
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Mi Medical Exclusions data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
