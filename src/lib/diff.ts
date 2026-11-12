export type DiffKind = "same" | "add" | "del";

export interface DiffLine {
  kind: DiffKind;
  text: string;
}

/**
 * Above this many changed lines the table would cost more than it is worth
 * (the dialog only shows a short excerpt anyway), so the middle is reported as
 * "all removed, all added" instead of being aligned line by line.
 */
const MAX_DP_LINES = 800;

/**
 * Line diff with a common prefix/suffix trim in front of the LCS table.
 *
 * Version bodies of a note are mostly identical between snapshots, so the
 * trim usually leaves a handful of lines and the quadratic table stays tiny.
 */
export function diffLines(before: string[], after: string[]): DiffLine[] {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) {
    start += 1;
  }
  let endBefore = before.length;
  let endAfter = after.length;
  while (
    endBefore > start &&
    endAfter > start &&
    before[endBefore - 1] === after[endAfter - 1]
  ) {
    endBefore -= 1;
    endAfter -= 1;
  }

  const out: DiffLine[] = [];
  for (let i = 0; i < start; i += 1) out.push({ kind: "same", text: before[i] });

  const a = before.slice(start, endBefore);
  const b = after.slice(start, endAfter);

  if (a.length > MAX_DP_LINES || b.length > MAX_DP_LINES) {
    for (const text of a) out.push({ kind: "del", text });
    for (const text of b) out.push({ kind: "add", text });
  } else if (a.length && b.length) {
    const rows: Uint32Array[] = [];
    for (let i = 0; i <= a.length; i += 1) rows.push(new Uint32Array(b.length + 1));
    for (let i = 1; i <= a.length; i += 1) {
      const row = rows[i];
      const prev = rows[i - 1];
      for (let j = 1; j <= b.length; j += 1) {
        row[j] =
          a[i - 1] === b[j - 1]
            ? prev[j - 1] + 1
            : Math.max(prev[j], row[j - 1]);
      }
    }

    let i = a.length;
    let j = b.length;
    const reversed: DiffLine[] = [];
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
        reversed.push({ kind: "same", text: a[i - 1] });
        i -= 1;
        j -= 1;
      } else if (j > 0 && (i === 0 || rows[i][j - 1] >= rows[i - 1][j])) {
        reversed.push({ kind: "add", text: b[j - 1] });
        j -= 1;
      } else {
        reversed.push({ kind: "del", text: a[i - 1] });
        i -= 1;
      }
    }
    for (let k = reversed.length - 1; k >= 0; k -= 1) out.push(reversed[k]);
  } else {
    for (const text of a) out.push({ kind: "del", text });
    for (const text of b) out.push({ kind: "add", text });
  }

  for (let i = endBefore; i < before.length; i += 1) {
    out.push({ kind: "same", text: before[i] });
  }
  return out;
}