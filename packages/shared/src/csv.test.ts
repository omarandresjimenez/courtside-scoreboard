import { parseCsv } from './csv.js';

describe('parseCsv', () => {
  it('splits a simple table', () => {
    expect(parseCsv('a,b,c\n1,2,3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('handles \\r\\n line endings', () => {
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('keeps a comma inside a quoted field', () => {
    expect(parseCsv('name,club\n"Doe, John",Bay Club')).toEqual([
      ['name', 'club'],
      ['Doe, John', 'Bay Club'],
    ]);
  });

  it('unescapes a doubled quote inside a quoted field', () => {
    expect(parseCsv('note\n"She said ""hi"""')).toEqual([['note'], ['She said "hi"']]);
  });

  it('keeps a newline inside a quoted field', () => {
    expect(parseCsv('note\n"line one\nline two"')).toEqual([['note'], ['line one\nline two']]);
  });

  it('parses a file with no trailing newline', () => {
    expect(parseCsv('a,b\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('skips blank lines', () => {
    expect(parseCsv('a,b\n1,2\n\n3,4\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
      ['3', '4'],
    ]);
  });

  it('returns an empty array for an empty string', () => {
    expect(parseCsv('')).toEqual([]);
  });
});
