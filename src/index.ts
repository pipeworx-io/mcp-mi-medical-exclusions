interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Shared "count records by a named date field over a year or range" helper —
 * fleet #3170.
 *
 * WHY THIS EXISTS. Four baked-table packs (ny-omig-exclusions,
 * tx-medical-exclusions, ca-medical-exclusions, fl-medical-exclusions) each
 * hold thousands of rows and each had only a list-wide total — no way to
 * answer "how many took effect in year Y" without a caller paging through
 * every row itself. A benchmark probe (fleet #3170/#3149) asked exactly that
 * question against two of them and both returned the SAME list-wide total on
 * every one of 7-8 rounds; the model ran out of rounds and refused rather
 * than get a wrong number. This is the one piece of that fix every pack
 * shares: parsing `year` or `start_date`/`end_date` into an inclusive
 * YYYY-MM-DD range, or a NAMED reason when the input can't be turned into
 * one. It deliberately never returns a silent zero for a bad argument —
 * root CLAUDE.md's silent-zero policy applies to a malformed count request
 * exactly as it does to an upstream outage.
 *
 * WHAT IT DOES NOT DO. It does not touch the rows — each pack's own ISO date
 * field (already YYYY-MM-DD in every one of these four) is filtered by plain
 * string comparison, which is correct for YYYY-MM-DD strings and avoids a
 * Date() parse / timezone trap entirely. Each pack is responsible for saying
 * which of its own fields it counted (data varies: NY/TX/CA have exactly one
 * exclusion-date field each; FL additionally splits "all sanction orders" vs
 * "participation exclusions" within the matched range).
 */

interface DateRange {
  /** Inclusive start date, YYYY-MM-DD. */
  start: string;
  /** Inclusive end date, YYYY-MM-DD. */
  end: string;
  /** Human label for the range, e.g. "2025" or "2024-06-01 to 2025-06-01". */
  label: string;
}

interface DateRangeError {
  error: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Reads `args.year`, `args.start_date` and `args.end_date` and returns:
 *   - `null` if none were passed (no date-range count was requested at all —
 *     the caller should fall through to its normal, non-counting response);
 *   - `{ error }` if something WAS passed but can't be turned into a valid
 *     range (bad format, start after end, year out of a sane bound) — the
 *     caller must surface this as a named reason, never as a zero count;
 *   - `{ start, end, label }` otherwise.
 *
 * start_date/end_date, if either is present, take precedence over `year`
 * (an explicit range is a more specific request than a calendar year).
 */
function parseYearOrDateRange(args: Record<string, unknown>): DateRange | DateRangeError | null {
  const startRaw = typeof args.start_date === 'string' ? args.start_date.trim() : '';
  const endRaw = typeof args.end_date === 'string' ? args.end_date.trim() : '';
  const yearRaw = args.year;
  const yearGiven = yearRaw !== undefined && yearRaw !== null && yearRaw !== '';

  if (!startRaw && !endRaw && !yearGiven) return null;

  if (startRaw || endRaw) {
    if (!DATE_RE.test(startRaw) || !DATE_RE.test(endRaw)) {
      return {
        error:
          `start_date and end_date must BOTH be present and in YYYY-MM-DD form ` +
          `(got start_date=${startRaw ? JSON.stringify(startRaw) : '(missing)'}, end_date=${endRaw ? JSON.stringify(endRaw) : '(missing)'}).`,
      };
    }
    if (startRaw > endRaw) {
      return { error: `start_date (${startRaw}) is after end_date (${endRaw}).` };
    }
    return { start: startRaw, end: endRaw, label: startRaw === endRaw ? startRaw : `${startRaw} to ${endRaw}` };
  }

  const year = Math.floor(Number(yearRaw));
  if (!Number.isFinite(year) || year < 1900 || year > 2100) {
    return { error: `year must be a 4-digit calendar year between 1900 and 2100 (got ${JSON.stringify(yearRaw)}).` };
  }
  return { start: `${year}-01-01`, end: `${year}-12-31`, label: String(year) };
}

function isDateRangeError(r: DateRange | DateRangeError | null): r is DateRangeError {
  return r != null && typeof (r as DateRangeError).error === 'string';
}

/** Inclusive YYYY-MM-DD membership test; `null`/empty dates never match. */
function inRange(date: string | null | undefined, range: DateRange): boolean {
  return Boolean(date) && (date as string) >= range.start && (date as string) <= range.end;
}

const DATE_RANGE_ARG_SCHEMA = {
  year: {
    type: 'number' as const,
    description: 'Count records whose date field falls in this calendar year (e.g. 2025), counted over the WHOLE list, not a page. Ignored if start_date/end_date are given.',
  },
  start_date: {
    type: 'string' as const,
    description: 'Inclusive range start, YYYY-MM-DD. Use with end_date for a custom date range instead of a calendar year.',
  },
  end_date: {
    type: 'string' as const,
    description: 'Inclusive range end, YYYY-MM-DD. Use with start_date for a custom date range instead of a calendar year.',
  },
};
/**
 * Michigan Medicaid provider sanctions screening: the Michigan Department of
 * Health and Human Services (MDHHS) "List of Sanctioned Providers". State
 * counterpart to the federal HHS OIG LEIE (leie pack) and sibling of
 * il/tx/ny/ca/fl-medical-exclusions.
 *
 * SOURCE AND SHAPE. MDHHS publishes the list as a spreadsheet it refreshes
 * as additions and deletions are made (4,111 rows at capture; the sheet's
 * title block carries the publication date, used as data_as_of). It merges
 * sanctions from MDHHS, its Office of Inspector General, Licensing and
 * Regulatory Affairs (LARA) and HHS, so each row names its sanction source.
 * Columns: entity name, last/first/middle name, provider category, NPI,
 * city, license, up to two sanction dates each with a source, and a
 * free-text reason (blank on about 60% of rows). MDHHS warns the list is
 * assembled partly from outside sources and may be incomplete.
 *
 * BAKED, NOT LIVE. Bulk spreadsheet only, so it is copied by
 * scripts/bake-index.mjs, registered in
 * workers/gateway/src/pack-baked-indexes.json, uploaded to KV at deploy and
 * injected as `args._bakedIndex` (fleet #2754). NEVER value-import
 * ./mi-mdhhs-index-data.js here: only the type-only import below.
 *
 * PERSONAL DATA. City is kept for entity rows only; dropped for any
 * individual at ingest. No street address or date of birth is published.
 *
 * MATCHING. An NPI or license match identifies a provider. A name match,
 * even an exact one, is a CANDIDATE: the list has no date of birth.
 *
 * Keyless.
 */
import type { MiMdhhsRow } from './mi-mdhhs-index-data.js';

let ROWS: MiMdhhsRow[] = [];
let DATA_AS_OF = '';
let CAPTURED_AT = '';
let TOTAL_ROWS = 0;

function ensureIndex(args: Record<string, unknown>): void {
  if (ROWS.length) return;
  const idx = args._bakedIndex as Record<string, unknown> | null | undefined;
  const rows = idx?.MI_MDHHS_ROWS;
  if (!Array.isArray(rows) || rows.length === 0) {
    // Loud on purpose: "no sanction found" from an empty table would be
    // indistinguishable from a real clean screening result.
    throw new Error(
      `mi-medical-exclusions: the baked Michigan MDHHS sanctioned providers index is unavailable (${idx == null ? 'not injected' : 'malformed'}). ` +
        'The gateway loads it from KV on the first call into this pack; this is a server-side fault, not a bad query. Retry shortly.',
    );
  }
  ROWS = rows as MiMdhhsRow[];
  DATA_AS_OF = String(idx?.MI_MDHHS_DATA_AS_OF ?? '');
  CAPTURED_AT = String(idx?.MI_MDHHS_CAPTURED_AT ?? '');
  TOTAL_ROWS = Number(idx?.MI_MDHHS_TOTAL_ROWS ?? ROWS.length);
}

const SOURCE_LABEL = 'Michigan Department of Health and Human Services (MDHHS): List of Sanctioned Providers';
const SOURCE_PAGE = 'https://www.michigan.gov/mdhhs/doing-business/providers/providers/billingreimbursement/list-of-sanctioned-providers';

const SCOPE_CAVEAT =
  'MDHHS builds this list partly from outside sources (its own OIG, LARA licensing, HHS) and warns that some providers may not appear. The reason field is free text and is blank on roughly 60% of rows; some values are federal Social Security Act exclusion section numbers (e.g. 1128(a)(1)), not plain-language reasons. There is no date of birth and no reinstatement flag: a row stays listed with a second date (e.g. "Summary Suspension Terminated") when an action was lifted, so read reason and second_sanction_date together before calling anyone currently sanctioned.';

const NOT_AN_ANSWER =
  'Name matches are CANDIDATES, not identifications: the list has no date of birth to tell same-named providers apart. Only an NPI or license-number match identifies a specific provider. Confirm a name match against NPI or license before acting on it.';

const OTHER_LISTS =
  'This checks the Michigan MDHHS sanctioned providers list only. It does not cover the federal HHS OIG LEIE (leie pack), SAM exclusions, or any other state list (see il-medical-exclusions, ny-omig-exclusions, tx-medical-exclusions, ca-medical-exclusions, fl-medical-exclusions).';


// The sheet's source labels are hand-typed (dozens of casing and spelling
// variants of the same few agencies). Group case-insensitively and fold the
// long tail so a count leads with the real picture.
function countBySource(rows: { sanction_source: string | null }[]): Record<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) {
    const k = (r.sanction_source ?? 'unspecified').trim().toUpperCase();
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  const sorted = [...m].sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, 8);
  const rest = sorted.slice(8);
  const out: Record<string, number> = Object.fromEntries(top);
  if (rest.length) out[`OTHER (${rest.length} further labels)`] = rest.reduce((n, [, c]) => n + c, 0);
  return out;
}

function normalize(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}
function digitsOnly(s: string): string {
  return s.replace(/\D/g, '');
}
function isTenDigitNpi(s: string): boolean {
  return /^\d{10}$/.test(s);
}

type MatchType = 'npi_match' | 'license_match' | 'name_candidate_exact' | 'name_candidate_partial';

const MATCH_MEANING: Record<MatchType, string> = {
  npi_match: "The NPI matched exactly against this provider's listed NPI. An NPI identifies one provider, so this is an identification.",
  license_match: 'The license number matched exactly. A license number identifies one provider, so this is an identification.',
  name_candidate_exact: 'The name matched exactly (entity name, person name or last name), but the list has no date of birth to confirm it is the same person. Confirm with NPI or license number before acting.',
  name_candidate_partial: 'The name is a partial match (every query word appears in the listed person name or entity name). A lead to check, not a finding. Confirm with NPI or license number.',
};

function personName(r: MiMdhhsRow): string | null {
  const parts = [r.first_name, r.middle_name, r.last_name].filter((p): p is string => Boolean(p));
  return parts.length ? parts.join(' ') : null;
}

function shape(r: MiMdhhsRow, matchType: MatchType) {
  return {
    provider_name: personName(r),
    entity_name: r.entity_name,
    provider_category: r.provider_category,
    city: r.city,
    license_number: r.license_number,
    npi: r.npi,
    sanction_date: r.sanction_date,
    sanction_source: r.sanction_source,
    second_sanction_date: r.second_sanction_date,
    second_sanction_source: r.second_sanction_source,
    reason: r.reason,
    match_type: matchType,
    what_that_means: MATCH_MEANING[matchType],
  };
}

async function checkExclusion(args: Record<string, unknown>) {
  const nameRaw = typeof args.name === 'string' ? args.name.trim() : '';
  const npiRaw = typeof args.npi === 'string' ? digitsOnly(args.npi) : '';
  const licenseRaw = typeof args.license === 'string' ? args.license.trim() : '';
  const licenseDigits = licenseRaw ? digitsOnly(licenseRaw) : '';

  if (!nameRaw && !npiRaw && !licenseRaw) {
    return {
      found: false,
      reason: 'no_query',
      hint: 'Pass name (the provider or business to screen), and/or npi, and/or license. An NPI or license match is an identification; a name match is a lead.',
      source: SOURCE_LABEL,
      source_page: SOURCE_PAGE,
      data_as_of: DATA_AS_OF,
    };
  }

  const limit = Math.max(1, Math.min(50, Math.floor(typeof args.limit === 'number' ? args.limit : 10)));
  const screened = { name: nameRaw || null, npi: npiRaw || null, license: licenseRaw || null };

  const npiMatches = npiRaw && isTenDigitNpi(npiRaw) ? ROWS.filter((r) => r.npi && digitsOnly(r.npi) === npiRaw) : [];
  const licenseMatches = licenseDigits
    ? ROWS.filter((r) => r.license_number && digitsOnly(r.license_number).length > 0 && digitsOnly(r.license_number).replace(/^0+/, '') === licenseDigits.replace(/^0+/, ''))
    : [];

  const identitySeen = new Set<MiMdhhsRow>();
  const identityResults: ReturnType<typeof shape>[] = [];
  for (const r of npiMatches) {
    if (identitySeen.has(r)) continue;
    identitySeen.add(r);
    identityResults.push(shape(r, 'npi_match'));
  }
  for (const r of licenseMatches) {
    if (identitySeen.has(r)) continue;
    identitySeen.add(r);
    identityResults.push(shape(r, 'license_match'));
  }

  let nameResults: ReturnType<typeof shape>[] = [];
  if (nameRaw) {
    const qNorm = normalize(nameRaw);
    const qTokens = qNorm.split(' ').filter(Boolean);
    const exact: ReturnType<typeof shape>[] = [];
    const partial: ReturnType<typeof shape>[] = [];
    for (const r of ROWS) {
      if (identitySeen.has(r)) continue;
      const nameNorm = normalize(personName(r) ?? '');
      const lastNorm = r.last_name ? normalize(r.last_name) : '';
      const entNorm = r.entity_name ? normalize(r.entity_name) : '';
      // Exact: the entity name, the whole person name (any word order), or a bare last name.
      const sameWords = nameNorm && nameNorm.split(' ').sort().join(' ') === [...qTokens].sort().join(' ');
      if ((entNorm && qNorm === entNorm) || (nameNorm && (qNorm === nameNorm || sameWords)) || (lastNorm && qNorm === lastNorm)) {
        exact.push(shape(r, 'name_candidate_exact'));
      } else if (qTokens.length > 0 && qTokens.every((t) => nameNorm.includes(t) || entNorm.includes(t))) {
        partial.push(shape(r, 'name_candidate_partial'));
      }
    }
    nameResults = [...exact, ...partial];
  }

  const combined = [...identityResults, ...nameResults];
  const matches = combined.slice(0, limit);

  if (matches.length === 0) {
    return {
      found: false,
      result: 'No match found on the Michigan MDHHS List of Sanctioned Providers for that provider.',
      filters_tried: screened,
      caveat: `${OTHER_LISTS} ${SCOPE_CAVEAT}`,
      source: SOURCE_LABEL,
      source_page: SOURCE_PAGE,
      data_as_of: DATA_AS_OF,
    };
  }

  const bySource = countBySource(combined);

  return {
    found: true,
    screened,
    total_matches: combined.length,
    identification_matches: identityResults.length,
    name_candidate_matches: nameResults.length,
    matches_by_sanction_source: bySource,
    returned: matches.length,
    truncated: combined.length > limit,
    matches,
    not_an_identification: NOT_AN_ANSWER,
    scope_caveat: SCOPE_CAVEAT,
    source: SOURCE_LABEL,
    source_page: SOURCE_PAGE,
    data_as_of: DATA_AS_OF,
  };
}

async function coverage(args: Record<string, unknown>) {
  const dates = ROWS.map((r) => r.sanction_date).filter((d): d is string => Boolean(d)).sort();
  const countBy = countBySource;

  // Date-range counting (same convention as the sibling state packs, fleet
  // #3170). The counted field is sanction_date, the sheet's first
  // "Sanction Date" column. second_sanction_date is a later event on the
  // same row (often the action being lifted) and is NOT counted.
  const range = parseYearOrDateRange(args);
  if (isDateRangeError(range)) {
    return {
      found: false,
      reason: 'invalid_date_range',
      hint: range.error,
      source: SOURCE_LABEL,
      source_page: SOURCE_PAGE,
      data_as_of: DATA_AS_OF,
    };
  }
  if (range) {
    const inWin = ROWS.filter((r) => inRange(r.sanction_date, range));
    return {
      found: true,
      mode: 'date_range_count',
      count: inWin.length,
      count_by_sanction_source: countBy(inWin),
      date_field_counted: 'sanction_date, the first "Sanction Date" column on the MDHHS list. NOT second_sanction_date, a later event on the same row (often the action being lifted).',
      range: { start: range.start, end: range.end, label: range.label },
      counted_over: `the whole list (${TOTAL_ROWS} rows), not a page`,
      total_rows_all_time: TOTAL_ROWS,
      oldest_sanction_date: dates[0] ?? null,
      newest_sanction_date: dates[dates.length - 1] ?? null,
      data_as_of: DATA_AS_OF,
      index_captured_at: CAPTURED_AT,
      scope_caveat: SCOPE_CAVEAT,
      source: SOURCE_LABEL,
      source_page: SOURCE_PAGE,
    };
  }

  return {
    found: true,
    total_rows: TOTAL_ROWS,
    rows_by_sanction_source: countBy(ROWS),
    individuals: ROWS.filter((r) => r.last_name || r.first_name).length,
    entities_only: ROWS.filter((r) => !r.last_name && !r.first_name).length,
    with_npi: ROWS.filter((r) => r.npi).length,
    with_license_number: ROWS.filter((r) => r.license_number).length,
    with_reason: ROWS.filter((r) => r.reason).length,
    with_second_sanction_date: ROWS.filter((r) => r.second_sanction_date).length,
    distinct_provider_categories: new Set(ROWS.map((r) => r.provider_category).filter(Boolean)).size,
    oldest_sanction_date: dates[0] ?? null,
    newest_sanction_date: dates[dates.length - 1] ?? null,
    data_as_of: DATA_AS_OF,
    index_captured_at: CAPTURED_AT,
    scope_caveat: SCOPE_CAVEAT,
    source: SOURCE_LABEL,
    source_page: SOURCE_PAGE,
  };
}

const tools: McpToolExport['tools'] = [
  {
    name: 'mi_medical_check_exclusion',
    description:
      'Is this healthcare provider sanctioned or excluded from the Michigan Medicaid program? Screens a person or business name, an NPI, and/or a license number against the Michigan Department of Health and Human Services (MDHHS) List of Sanctioned Providers, which merges sanctions from MDHHS, its Office of Inspector General, Licensing and Regulatory Affairs and HHS. State-level counterpart to the federal HHS OIG LEIE (leie pack) for Michigan, sibling of il_medical_check_exclusion, tx_medical_check_exclusion, ny_omig_check_exclusion and ca_medical_check_exclusion. '
      + 'Answers "is this provider on the Michigan Medicaid sanction list", "check this NPI against Michigan sanctions", or pre-payment/credentialing screening for a Michigan Medicaid provider. '
      + 'An NPI or license-number match is an IDENTIFICATION; a name match, even an exact one, is a CANDIDATE lead only (no date of birth is published). Each match carries the sanction date and source, a second sanction date and source where present (often the action being lifted), the provider category and MDHHS\'s free-text reason (blank on about 60% of rows). The response leads with counts by sanction source. City is served for businesses only; no street addresses. Sourced from MDHHS, keyless.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Provider or business name to screen, e.g. "1st Priority Physical Therapy" or "Oshiyoye". Any word order.' },
        npi: { type: 'string', description: "The provider's 10-digit NPI, if known. An NPI match is an identification. Always pass it when known." },
        license: { type: 'string', description: 'Michigan professional license number, if known. A license match is an identification.' },
        limit: { type: 'number', description: 'Maximum matches to return (default 10, max 50).' },
      },
    },
  },
  {
    name: 'mi_medical_exclusion_coverage',
    description:
      'What the Michigan MDHHS List of Sanctioned Providers covers and how current it is: total rows, counts by sanction source (MDHHS, MDHHS-OIG, LARA, DCH, HHS), individuals vs businesses, how many carry an NPI, license number or reason, oldest and newest sanction date, and the list\'s own publication date. Use to check the screening data is fresh enough before a compliance decision. '
      + 'Pass year (e.g. 2025) or start_date/end_date to instead COUNT how many sanctions have a sanction date in that year or range, counted over the whole list rather than a page, split by sanction source. The response names the date field counted (sanction_date, the first Sanction Date column, never the second date). Sourced from MDHHS, keyless.',
    inputSchema: { type: 'object' as const, properties: { ...DATE_RANGE_ARG_SCHEMA } },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  ensureIndex(args);
  switch (name) {
    case 'mi_medical_check_exclusion':
      return checkExclusion(args);
    case 'mi_medical_exclusion_coverage':
      return coverage(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export { tools, callTool };
export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
