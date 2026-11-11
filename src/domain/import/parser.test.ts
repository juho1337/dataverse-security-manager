import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isPlainAddress, parseEmailList, parseImportFile, toEmailListResult } from './parser';

// Cases mirror the XrmToolBox ImportFileParserTests / EmailListParserTests (names cited in the test titles) and read the same fixture
// files at test time (tests/fixtures/dsm/email-lists, import-files). When the fixture folder is absent the fixture suite says so.

const repoRoot = `${process.cwd().replace(/\\/g, '/')}/../../`;
const fixtures = `${repoRoot}tests/fixtures/dsm/`;
const haveFixtures = existsSync(`${fixtures}import-files/comma-header.csv`);
const fixture = (rel: string): string => readFileSync(`${fixtures}${rel}`, 'utf8');

describe('isPlainAddress', () => {
  it.each(['alex@example.test', 'a.b+tag@sub.example.test', "o'brien@example.test", 'x@a-b.example.test'])('accepts %s', (v) => {
    expect(isPlainAddress(v)).toBe(true);
  });

  it.each([
    '', 'not-an-email', 'missing-at.example.test', 'two@@example.test', '@example.test', 'a@b', 'a@.example.test', 'a@example.', 'a..b@example.test',
    '.a@example.test', 'a.@example.test', 'a b@example.test', 'a,b@example.test', 'a;b@example.test', 'Jane <jane@example.test>', '"quoted"@example.test',
    'a@exa mple.test', 'a@-example.test', 'a@example-.test', 'a\u0000@example.test', 'a\t@example.test', 'ä@example.test',
  ])('rejects %j', (v) => {
    expect(isPlainAddress(v)).toBe(false);
  });
});

describe('parseEmailList', () => {
  it('Null_and_empty_input_give_an_empty_result', () => {
    expect(parseEmailList(null)).toEqual({ valid: [], invalid: [], duplicates: [] });
    expect(parseEmailList('')).toEqual({ valid: [], invalid: [], duplicates: [] });
  });

  it('trims, lower-cases, de-duplicates and skips blanks and comments, reporting what it dropped', () => {
    const r = parseEmailList('﻿  Alex@Example.Test \n\n# note\nmorgan@example.test\nALEX@example.test\nnot an email\n');
    expect(r.valid).toEqual(['alex@example.test', 'morgan@example.test']);
    expect(r.duplicates).toEqual([{ lineNumber: 5, text: 'ALEX@example.test', reason: 'Duplicate of an earlier line.' }]);
    expect(r.invalid).toEqual([{ lineNumber: 6, text: 'not an email', reason: 'Not a plain email address.' }]);
  });

  it('handles mixed line endings', () => {
    expect(parseEmailList('a@example.test\r\nb@example.test\rc@example.test\nd@example.test').valid).toHaveLength(4);
  });
});

describe('parseImportFile: plain list and delimiters', () => {
  it('Null_and_empty_input_give_an_empty_plain_result', () => {
    for (const input of [null, undefined, '']) {
      expect(parseImportFile(input)).toMatchObject({ format: 'plainList', rows: [], warnings: [], validEmails: [] });
    }
  });

  it('Plain_list_gives_the_same_outcome_as_EmailListParser', () => {
    const text = 'alex@example.test\nSam@Example.test\nnot an email\nALEX@example.test\n# c\n\n';
    const a = toEmailListResult(parseImportFile(text));
    const b = parseEmailList(text);
    expect(a.valid).toEqual(b.valid);
    expect(a.invalid.map((e) => e.lineNumber)).toEqual(b.invalid.map((e) => e.lineNumber));
    expect(a.duplicates.map((e) => e.lineNumber)).toEqual(b.duplicates.map((e) => e.lineNumber));
  });

  it('Tied_delimiters_are_ambiguous', () => {
    const r = parseImportFile('a,b;c\nx,y;z\n');
    expect(r.rows).toEqual([]);
    expect(r.warnings.join(' ')).toMatch(/delimiter could be ',' or ';'/);
  });

  it('Delimiter_with_the_most_fields_wins_and_quoted_delimiters_are_ignored', () => {
    const r = parseImportFile('name;email;note\n"a;b";alex@example.test;"x,y,z"\n');
    expect(r).toMatchObject({ delimiter: ';', emailColumn: 'email', validEmails: ['alex@example.test'] });
  });

  it('Order_is_preserved_and_comments_and_blank_lines_are_skipped_in_delimited_files', () => {
    const r = parseImportFile('# header comment\nname,email\n\nb,b@example.test\n# mid\na,a@example.test\n');
    expect(r.validEmails).toEqual(['b@example.test', 'a@example.test']);
    expect(r.rows.map((x) => x.lineNumber)).toEqual([4, 6]);
  });

  it('Short_rows_have_no_email', () => {
    const r = parseImportFile('name,email\nonly-name\nb,b@example.test\n');
    expect(r.rows[0]).toMatchObject({ email: null, problem: 'No email in this row.' });
    expect(r.validEmails).toEqual(['b@example.test']);
  });

  it('Two_columns_that_both_look_like_emails_are_ambiguous', () => {
    const r = parseImportFile('a@example.test,b@example.test\nc@example.test,d@example.test\n');
    expect(r.rows).toEqual([]);
    expect(r.warnings.join(' ')).toMatch(/email column is ambiguous/);
  });

  it('Line_numbers_continue_after_a_quoted_field_with_line_breaks', () => {
    const r = parseImportFile('name,email\n"multi\nline",a@example.test\nb,b@example.test\n');
    expect(r.rows.map((x) => [x.lineNumber, x.email])).toEqual([[2, 'a@example.test'], [4, 'b@example.test']]);
  });

  it('Unterminated_quote_nul_characters_formulas_and_mixed_line_endings_are_safe', () => {
    expect(parseImportFile('name,email\na,"unclosed@example.test\n').warnings.join(' ')).toMatch(/quoted field is not closed/);
    const nul = parseImportFile('name,email\na,a\u0000@example.test\r\nb,=1+1\rc,c@example.test\n');
    expect(nul.validEmails).toEqual(['c@example.test']);
    expect(nul.rows.filter((r) => r.problem !== null)).toHaveLength(2);
  });

  it('Row_with_ten_thousand_columns_does_not_throw', () => {
    const header = Array.from({ length: 10_000 }, (_, i) => `c${i}`).join(',');
    const row = Array.from({ length: 10_000 }, (_, i) => (i === 7 ? 'a@example.test' : 'x')).join(',');
    expect(() => parseImportFile(`${header}\n${row}\n`)).not.toThrow();
  });

  it('Large_inputs_are_handled_within_a_time_bound', () => {
    const lines = Array.from({ length: 50_000 }, (_, i) => `user${i}@example.test`).join('\n');
    const start = Date.now();
    const r = parseImportFile(lines);
    expect(r.validEmails).toHaveLength(50_000);
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  it('removes a BOM that survived decoding, in both forms', () => {
    expect(parseImportFile('﻿email,name\nalex@example.test,Alex\n').emailColumn).toBe('email');
    expect(parseImportFile('ï»¿email,name\nalex@example.test,Alex\n').emailColumn).toBe('email');
  });

  it('reports a duplicate with the line of the first occurrence, case-insensitively', () => {
    const r = parseImportFile('email,name\nA@example.test,a\nb@example.test,b\na@EXAMPLE.test,c\n');
    expect(r.rows[2]).toMatchObject({ isDuplicate: true, problem: 'Duplicate of line 2.', email: 'a@example.test' });
    expect(r.validEmails).toEqual(['a@example.test', 'b@example.test']);
  });
});

describe.skipIf(!haveFixtures)('shared fixtures (tests/fixtures/dsm)', () => {
  it('email-lists: valid, comments, CRLF and BOM files give the two addresses', () => {
    for (const f of ['valid.txt', 'comments-and-blank-lines.txt', 'crlf-and-bom.txt']) {
      expect(parseEmailList(fixture(`email-lists/${f}`)).valid, f).toEqual(['alex@example.test', 'morgan@example.test']);
    }
  });

  it('email-lists: duplicates are reported on their lines, invalid entries are all reported', () => {
    const d = parseEmailList(fixture('email-lists/duplicates-and-case.txt'));
    expect(d.valid).toEqual(['alex@example.test', 'morgan@example.test']);
    expect(d.duplicates.map((e) => e.lineNumber)).toEqual([2, 4]);
    const i = parseEmailList(fixture('email-lists/invalid-entries.txt'));
    expect(i.valid).toEqual([]);
    expect(i.invalid).toHaveLength(4);
  });

  it('Comma_header_file_reports_empty_invalid_and_duplicate_rows', () => {
    const r = parseImportFile(fixture('import-files/comma-header.csv'));
    expect(r).toMatchObject({ format: 'delimited', delimiter: ',', emailColumn: 'email', validEmails: ['alex@example.test', 'sam@example.test'] });
    expect(r.rows.map((x) => x.problem)).toEqual([null, null, 'Duplicate of line 3.', 'No email in this row.', 'Not a plain email address.']);
  });

  it('Headerless_file_uses_the_only_email_column_and_warns', () => {
    const r = parseImportFile(fixture('import-files/comma-no-header.csv'));
    expect(r.emailColumn).toBe('(column 2)');
    expect(r.validEmails).toEqual(['alex@example.test', 'sam@example.test']);
    expect(r.warnings.join(' ')).toMatch(/No header found: column 2/);
  });

  it('Semicolon_and_Tab_header_files_are_recognised', () => {
    const s = parseImportFile(fixture('import-files/semicolon-header.csv'));
    expect(s).toMatchObject({ delimiter: ';', emailColumn: 'E-Mail', validEmails: ['alex@example.test', 'sam@example.test'] });
    const t = parseImportFile(fixture('import-files/tab-header.tsv'));
    expect(t).toMatchObject({ delimiter: '\t', emailColumn: 'User Principal Name', validEmails: ['alex@example.test', 'sam@example.test'] });
  });

  it('Bom_is_removed_before_the_header_is_read', () => {
    expect(parseImportFile(fixture('import-files/bom-header.csv')).validEmails).toEqual(['alex@example.test', 'sam@example.test']);
  });

  it('Plain_list_fixture_matches_EmailListParser', () => {
    const text = fixture('import-files/plain-list.txt');
    const r = parseImportFile(text);
    expect(r.format).toBe('plainList');
    expect(r.validEmails).toEqual(['alex@example.test', 'sam@example.test']);
    expect(r.rows.map((x) => x.lineNumber)).toEqual([2, 4, 5, 6, 7]);
    expect(r.rows[3]).toMatchObject({ isDuplicate: true, problem: 'Duplicate of line 2.' });
    expect(toEmailListResult(r).valid).toEqual(parseEmailList(text).valid);
  });

  it('Quoted_fields_with_delimiters_doubled_quotes_and_line_breaks_are_handled', () => {
    const r = parseImportFile(fixture('import-files/quoted-fields.csv'));
    expect(r.validEmails).toEqual(['alex@example.test', 'sam@example.test']);
    expect(r.rows.map((x) => x.lineNumber)).toEqual([2, 3]);
  });

  it('Ambiguous_or_missing_email_column_returns_no_rows_and_a_warning', () => {
    for (const f of ['ambiguous-header.csv', 'no-email-column.csv']) {
      const r = parseImportFile(fixture(`import-files/${f}`));
      expect(r.rows, f).toEqual([]);
      expect(r.warnings.join(' '), f).toMatch(/email column is ambiguous/);
    }
  });
});
