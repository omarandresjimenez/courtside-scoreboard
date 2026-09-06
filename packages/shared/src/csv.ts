/**
 * Minimal RFC4180-ish CSV parser: quoted fields (with embedded commas,
 * newlines, and "" as an escaped quote), \n and \r\n line endings. No
 * external dependency — the format this app needs to read (tournament
 * software exports) is plain enough that a hand-rolled parser is simpler
 * to audit than pulling in a library for it.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  function endField() {
    row.push(field);
    field = '';
  }
  function endRow() {
    endField();
    rows.push(row);
    row = [];
  }

  while (i < text.length) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += char;
      i += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (char === ',') {
      endField();
      i += 1;
      continue;
    }
    if (char === '\r') {
      i += 1;
      continue;
    }
    if (char === '\n') {
      endRow();
      i += 1;
      continue;
    }
    field += char;
    i += 1;
  }

  // A trailing newline leaves nothing pending; anything else (including a
  // file with no trailing newline at all) is one more row to close out.
  if (field !== '' || row.length > 0) endRow();

  // Rows that are a single empty field are blank lines in the source file.
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}
