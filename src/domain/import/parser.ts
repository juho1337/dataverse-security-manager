// Parses an imported user list: either one address per line or a CSV/TSV-style file with an email column (issue #271).
// Port of XrmToolBox ImportFileParser / EmailListParser. Pure and side-effect free: it never touches Dataverse and never guesses an
// ambiguous column or delimiter. Reading the file bytes is the caller's job (File API); a BOM that survived decoding is removed here.

export type ImportFileFormat = 'plainList' | 'delimited';

/** One data row of an import file, in file order. */
export interface ImportRow {
  /** 1-based line where the row started. */
  readonly lineNumber: number;
  /** Original text of the row (for display). */
  readonly raw: string;
  /** The lower-cased address of a valid row (also of a duplicate); null when the row has no valid address. */
  readonly email: string | null;
  /** Null when the row is fine, otherwise a short reason. */
  readonly problem: string | null;
  /** Same address as an earlier row (case-insensitive); the first occurrence is not a duplicate. */
  readonly isDuplicate: boolean;
  /** The value that was judged (the email cell, or the line), for messages. */
  readonly text: string;
}

export interface EmailListEntry {
  readonly lineNumber: number;
  readonly text: string;
  readonly reason: string;
}

export interface EmailListResult {
  /** Unique, lower-cased, valid addresses in first-seen order. */
  readonly valid: readonly string[];
  readonly invalid: readonly EmailListEntry[];
  readonly duplicates: readonly EmailListEntry[];
}

export interface ImportFileResult {
  readonly format: ImportFileFormat;
  /** Header name or "(column 2)" when delimited, null for a plain list or when the column is ambiguous. */
  readonly emailColumn: string | null;
  readonly delimiter: string | null;
  /** Every non-blank, non-comment data row in original order. */
  readonly rows: readonly ImportRow[];
  readonly warnings: readonly string[];
  /** Unique, lower-cased valid addresses in first-seen order. */
  readonly validEmails: readonly string[];
}

const DELIMITERS = [',', ';', '\t'] as const;
const EMAIL_HEADERS = new Set(['email', 'mail', 'emailaddress', 'primaryemail', 'internalemailaddress', 'userprincipalname', 'upn']);

const LOCAL = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const DOMAIN = /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

/**
 * True for a plain `local@domain.tld` address: no whitespace, control characters, `,;<>"`, exactly one `@`, a dot-atom local part and a
 * dotted domain. Deliberately stricter than the RFC (no quoted local parts, comments, IP literals or non-ASCII); anything else is
 * reported as invalid, never silently accepted or dropped.
 */
export function isPlainAddress(value: string): boolean {
  if (value.length === 0) return false;
  let at = -1;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    const ch = value[i] as string;
    if (c <= 0x20 || c === 0x7f || /\s/.test(ch) || ch === ',' || ch === ';' || ch === '<' || ch === '>' || ch === '"') return false;
    if (ch === '@') {
      if (at >= 0) return false;
      at = i;
    }
  }
  if (at <= 0 || value.indexOf('.', at) <= at + 1) return false;
  return LOCAL.test(value.slice(0, at)) && DOMAIN.test(value.slice(at + 1));
}

interface RecordRead {
  readonly lineNumber: number;
  readonly raw: string;
  readonly fields: readonly string[];
  readonly unterminated: boolean;
}

/** Reads one logical record at a time (RFC 4180 quoting when a delimiter is given; one field per line otherwise). */
function readRecords(text: string, delimiter: string | null, stopAfterFirstDataRecord = false): RecordRead[] {
  const out: RecordRead[] = [];
  let pos = 0;
  let line = 1;
  while (pos < text.length) {
    const start = pos;
    const startLine = line;
    const fields: string[] = [];
    let sb = '';
    let fieldStart = true;
    let unterminated = false;
    let end = -1;
    while (pos < text.length) {
      const c = text[pos] as string;
      if (delimiter !== null && fieldStart && c === '"') {
        pos++;
        let closed = false;
        while (pos < text.length) {
          const q = text[pos] as string;
          if (q === '"') {
            if (pos + 1 < text.length && text[pos + 1] === '"') {
              sb += '"';
              pos += 2;
              continue;
            }
            pos++;
            closed = true;
            break;
          }
          if (q === '\r') {
            line++;
            if (pos + 1 < text.length && text[pos + 1] === '\n') {
              sb += '\r\n';
              pos += 2;
              continue;
            }
          } else if (q === '\n') line++;
          sb += q;
          pos++;
        }
        if (!closed) unterminated = true;
        fieldStart = false;
        continue;
      }
      if (delimiter !== null && c === delimiter) {
        fields.push(sb);
        sb = '';
        pos++;
        fieldStart = true;
        continue;
      }
      if (c === '\r' || c === '\n') {
        end = pos;
        pos += c === '\r' && pos + 1 < text.length && text[pos + 1] === '\n' ? 2 : 1;
        line++;
        break;
      }
      sb += c;
      pos++;
      fieldStart = false;
    }
    if (end < 0) end = pos;
    fields.push(sb);
    const record: RecordRead = { lineNumber: startLine, raw: text.slice(start, end), fields, unterminated };
    out.push(record);
    if (stopAfterFirstDataRecord && !isSkipped(record)) break;
  }
  return out;
}

const isSkipped = (r: RecordRead): boolean => {
  const t = r.raw.trim();
  return t.length === 0 || t[0] === '#';
};

const stripBom = (text: string): string => text.replace(new RegExp('^(\uFEFF|\u00EF\u00BB\u00BF)+'), '');

function normalizeHeader(value: string): string {
  let sb = '';
  for (const c of value) if (c !== ' ' && c !== '_' && c !== '-' && !/\s/.test(c)) sb += c.toLowerCase();
  return sb;
}

function addRow(rows: ImportRow[], valid: string[], seen: Map<string, number>, lineNumber: number, raw: string, value: string): void {
  if (value.length === 0) {
    rows.push({ lineNumber, raw, email: null, problem: 'No email in this row.', isDuplicate: false, text: value });
    return;
  }
  if (!isPlainAddress(value)) {
    rows.push({ lineNumber, raw, email: null, problem: 'Not a plain email address.', isDuplicate: false, text: value });
    return;
  }
  const email = value.toLowerCase();
  const first = seen.get(email);
  if (first !== undefined) {
    rows.push({ lineNumber, raw, email, problem: `Duplicate of line ${first}.`, isDuplicate: true, text: value });
    return;
  }
  seen.set(email, lineNumber);
  valid.push(email);
  rows.push({ lineNumber, raw, email, problem: null, isDuplicate: false, text: value });
}

/** The delimiter splitting the first data line into the most fields; none when no delimiter occurs outside quotes. */
function detectDelimiter(text: string): { readonly delimiter: string | null; readonly ambiguous: string | null } {
  const counts = DELIMITERS.map((d) => {
    const first = readRecords(text, d, true).find((r) => !isSkipped(r));
    return first ? first.fields.length - 1 : 0;
  });
  let best = 0;
  for (let i = 1; i < counts.length; i++) if ((counts[i] as number) > (counts[best] as number)) best = i;
  if ((counts[best] as number) === 0) return { delimiter: null, ambiguous: null };
  const names = DELIMITERS.filter((_, i) => counts[i] === counts[best]).map((d) => (d === '\t' ? 'tab' : `'${d}'`));
  if (names.length > 1) return { delimiter: null, ambiguous: names.join(' or ') };
  return { delimiter: DELIMITERS[best] as string, ambiguous: null };
}

function findEmailColumns(records: readonly RecordRead[]): number[] {
  const bad: boolean[] = [];
  const hasValue: boolean[] = [];
  for (const rec of records) {
    for (let i = 0; i < rec.fields.length; i++) {
      while (bad.length <= i) {
        bad.push(false);
        hasValue.push(false);
      }
      if (bad[i]) continue;
      const value = (rec.fields[i] as string).trim();
      if (value.length === 0) continue;
      if (isPlainAddress(value)) hasValue[i] = true;
      else bad[i] = true;
    }
  }
  return bad.flatMap((b, i) => (hasValue[i] && !b ? [i] : []));
}

function parsePlain(text: string): ImportFileResult {
  const rows: ImportRow[] = [];
  const valid: string[] = [];
  const seen = new Map<string, number>();
  for (const record of readRecords(text, null)) {
    if (isSkipped(record)) continue;
    const line = record.raw.trim();
    addRow(rows, valid, seen, record.lineNumber, line, line);
  }
  return { format: 'plainList', emailColumn: null, delimiter: null, rows, warnings: [], validEmails: valid };
}

function parseDelimited(text: string, delimiter: string): ImportFileResult {
  const rows: ImportRow[] = [];
  const warnings: string[] = [];
  const valid: string[] = [];
  const records = readRecords(text, delimiter);
  if (records.some((r) => r.unterminated)) warnings.push('A quoted field is not closed; the rest of the file was read as part of that field.');
  const data = records.filter((r) => !isSkipped(r));

  let column = -1;
  let hasHeader = false;
  let columnName: string | null = null;
  const head = data[0];
  if (head) {
    const matches = head.fields.flatMap((f, i) => (EMAIL_HEADERS.has(normalizeHeader(f)) ? [i] : []));
    if (matches.length === 1) {
      column = matches[0] as number;
      hasHeader = true;
      columnName = (head.fields[column] as string).trim();
    } else if (matches.length === 0) {
      const candidates = findEmailColumns(data);
      if (candidates.length === 1) {
        column = candidates[0] as number;
        columnName = `(column ${column + 1})`;
        warnings.push(`No header found: column ${column + 1} was used because every value in it looks like an email address.`);
      }
    }
  }

  if (column < 0) {
    warnings.push('The email column is ambiguous: no single column is named like an email column or contains only email addresses, so the file was not read.');
    return { format: 'delimited', emailColumn: null, delimiter, rows, warnings, validEmails: valid };
  }

  const seen = new Map<string, number>();
  for (let r = hasHeader ? 1 : 0; r < data.length; r++) {
    const rec = data[r] as RecordRead;
    const cell = column < rec.fields.length ? (rec.fields[column] as string).trim() : '';
    addRow(rows, valid, seen, rec.lineNumber, rec.raw, cell);
  }
  return { format: 'delimited', emailColumn: columnName, delimiter, rows, warnings, validEmails: valid };
}

/**
 * @param text File content (already decoded). The format is detected from the content, not from a file name.
 */
export function parseImportFile(text: string | null | undefined): ImportFileResult {
  if (!text) return { format: 'plainList', emailColumn: null, delimiter: null, rows: [], warnings: [], validEmails: [] };
  const clean = stripBom(text);
  const { delimiter, ambiguous } = detectDelimiter(clean);
  if (ambiguous !== null) {
    return {
      format: 'delimited',
      emailColumn: null,
      delimiter: null,
      rows: [],
      warnings: [`The email column is ambiguous: the delimiter could be ${ambiguous}, so the file was not read.`],
      validEmails: [],
    };
  }
  return delimiter === null ? parsePlain(clean) : parseDelimited(clean, delimiter);
}

/** The classic one-address-per-line view of a parse result: invalid and duplicate lines reported separately. */
export function toEmailListResult(file: ImportFileResult): EmailListResult {
  const invalid: EmailListEntry[] = [];
  const duplicates: EmailListEntry[] = [];
  for (const row of file.rows) {
    if (row.isDuplicate) duplicates.push({ lineNumber: row.lineNumber, text: row.text, reason: 'Duplicate of an earlier line.' });
    else if (row.problem !== null) invalid.push({ lineNumber: row.lineNumber, text: row.text, reason: row.problem });
  }
  return { valid: file.validEmails, invalid, duplicates };
}

/**
 * Parses a one-address-per-line list: surrounding whitespace and a leading BOM are removed, blank lines and lines starting with '#' are
 * skipped, addresses are lower-cased and de-duplicated, anything that is not a plain address is reported.
 */
export function parseEmailList(text: string | null | undefined): EmailListResult {
  if (!text) return { valid: [], invalid: [], duplicates: [] };
  const valid: string[] = [];
  const invalid: EmailListEntry[] = [];
  const duplicates: EmailListEntry[] = [];
  const seen = new Set<string>();
  stripBom(text)
    .split(/\r\n|\n|\r/)
    .forEach((raw, i) => {
      const line = raw.trim();
      if (line.length === 0 || line.startsWith('#')) return;
      if (!isPlainAddress(line)) {
        invalid.push({ lineNumber: i + 1, text: line, reason: 'Not a plain email address.' });
        return;
      }
      const normalized = line.toLowerCase();
      if (seen.has(normalized)) duplicates.push({ lineNumber: i + 1, text: line, reason: 'Duplicate of an earlier line.' });
      else {
        seen.add(normalized);
        valid.push(normalized);
      }
    });
  return { valid, invalid, duplicates };
}
