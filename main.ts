// main.ts is mend, the CLI SPEC.md specifies. It implements sections 1 to 10 of SPEC.md: the command line, the
// output and exit codes, safe paths, format detection, matching lines at three tiers (section 5), unified diffs
// (section 6), SEARCH/REPLACE blocks (section 7), V4A patches (section 8), JSON edits (section 9) and the
// all-or-nothing write (section 10). Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines plus its own line break and whether it ends with one (SPEC.md section 3). */
interface LineSet {
  lines: string[];
  br: string;
  finalBr: boolean;
}

function splitFile(text: string): LineSet {
  if (text === '') return { lines: [], br: '\n', finalBr: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBr = text.endsWith(br);
  if (finalBr) parts.pop();
  return { lines: parts, br, finalBr };
}

function joinFile(ls: LineSet): string {
  if (ls.lines.length === 0) return '';
  return ls.lines.join(ls.br) + (ls.finalBr ? ls.br : '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

/** One line of N: its text, and the index in O of the context line it is, or null for a new line. */
interface NLine {
  text: string;
  ctx: number | null;
}

/** One edit. `move` names a move edit's [old, new] pair for the R output line (section 2). */
interface Edit {
  apply(tree: Tree): void;
  move?: [string, string];
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* Section 5: matching lines. */

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return a.replace(/[ \t]+$/, '') === b.replace(/[ \t]+$/, '');
  const trim = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  return trim(a) === trim(b);
}

/** All positions where O occurs in lines at tier. */
function occurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = 0; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once (from `from`), with its occurrences. */
function findTierFrom(lines: string[], o: string[], from: number, strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ: number[] = [];
    if (o.length > 0) {
      for (let i = from; i + o.length <= lines.length; i++) {
        let ok = true;
        for (let j = 0; j < o.length; j++) {
          if (!lineEq(lines[i + j]!, o[j]!, t)) {
            ok = false;
            break;
          }
        }
        if (ok) occ.push(i);
      }
    }
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

function findTier(lines: string[], o: string[], strict: boolean): { tier: number; occ: number[] } | null {
  return findTierFrom(lines, o, 0, strict);
}

/** The first line at or after `from` equal to target, at the first tier where one is. */
function findSingle(lines: string[], target: string, from: number, strict: boolean): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < lines.length; i++) {
      if (lineEq(lines[i]!, target, t)) return i;
    }
  }
  return null;
}

/** Build the replacement lines: context lines are the file's own matched lines, other lines are
 * re-indented at tier 2 (section 5) and written as they are at tiers 0 and 1. */
function buildNewLines(n: NLine[], fileLines: string[], occStart: number, o: string[], tier: number): string[] {
  if (tier !== 2) {
    return n.map((nl) => (nl.ctx !== null ? fileLines[occStart + nl.ctx]! : nl.text));
  }
  const F = leadingWs(fileLines[occStart] ?? '');
  const P = leadingWs(o[0] ?? '');
  return n.map((nl) => {
    if (nl.ctx !== null) return fileLines[occStart + nl.ctx]!;
    const t = nl.text;
    if (t === '' || t.trim() === '') return t;
    if (P === '' || t.startsWith(P)) return F + t.slice(P.length);
    return t;
  });
}

/* Section 9: JSON edits. */

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return {
      apply(tree) {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, text);
      },
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return {
      apply(tree) {
        const before = exists(tree);
        const nl = before.indexOf('\n');
        const crlf = nl > 0 && before[nl - 1] === '\r';
        const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
        const t = lf(before);
        const old = lf(oldStr);
        let count = 0;
        for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
        if (count === 0) throw new Fail('no-match', p);
        if (count > 1) throw new Fail('ambiguous', p);
        const at = t.indexOf(old);
        const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
        tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
      },
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return {
      apply(tree) {
        const before = exists(tree);
        const ls = splitFile(before);
        if (line < 0 || line > ls.lines.length) throw new Fail('no-match', p);
        const lines = [...ls.lines];
        lines.splice(line, 0, ...add);
        tree.now.set(p, joinFile({ lines, br: ls.br, finalBr: ls.finalBr }));
      },
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* Section 6: unified diffs. */

interface Hunk {
  a: number;
  o: string[];
  n: NLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noEol: boolean;
  /** A `\` line follows the hunk's last `+` line (false when it has none). */
  plusNoEol: boolean;
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  gitOld: string | null;
  gitNew: string | null;
  newFile: boolean;
  delFile: boolean;
  sawHeaderPair: boolean;
  hunks: Hunk[];
}

/** The path named by a `--- ` or `+++ ` line: text after the four characters, up to the first tab,
 * surrounding spaces removed, with a leading `a/` or `b/` removed. */
function headerPath(line: string): string {
  let s = line.slice(4);
  const tab = s.indexOf('\t');
  if (tab >= 0) s = s.slice(0, tab);
  s = s.trim();
  if (s.startsWith('a/') || s.startsWith('b/')) s = s.slice(2);
  return s;
}

function readHunkBody(lines: string[], start: number, a: number): { hunk: Hunk; next: number } {
  const body: string[] = [];
  let j = start;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
      body.push(l);
      j++;
    } else break;
  }
  // Empty lines at the end of a body are not part of it.
  while (body.length > 0 && (body[body.length - 1] === '' || body[body.length - 1] === ' ')) body.pop();
  let lastCtxPlus = -1;
  let lastPlus = -1;
  for (let k = 0; k < body.length; k++) {
    const l = body[k]!;
    if (l === '' || l[0] === ' ' || l[0] === '+') lastCtxPlus = k;
    if (l[0] === '+') lastPlus = k;
  }
  const followsBackslash = (k: number): boolean => k >= 0 && body[k + 1] !== undefined && body[k + 1]![0] === '\\';
  const noEol = followsBackslash(lastCtxPlus);
  const plusNoEol = followsBackslash(lastPlus);
  const o: string[] = [];
  const n: NLine[] = [];
  for (const l of body) {
    if (l === '' || l[0] === ' ') {
      const t = l === '' ? '' : l.slice(1);
      o.push(t);
      n.push({ text: t, ctx: o.length - 1 });
    } else if (l[0] === '-') {
      o.push(l.slice(1));
    } else if (l[0] === '+') {
      n.push({ text: l.slice(1), ctx: null });
    }
    // `\` lines refer to the body line before them; only noEol/plusNoEol use them.
  }
  return { hunk: { a, o, n, noEol, plusNoEol }, next: j };
}

/** Apply one hunk to a file's lines. `d` is the running length delta of this section's earlier hunks. */
function applyHunk(ls: LineSet, h: Hunk, d: number, strict: boolean, path: string): LineSet {
  if (h.o.length === 0) {
    const at = Math.max(0, Math.min(h.a + d, ls.lines.length));
    const ins = h.n.map((nl) => nl.text);
    const lines = [...ls.lines];
    lines.splice(at, 0, ...ins);
    let finalBr = ls.finalBr;
    if (at === ls.lines.length) finalBr = !h.noEol;
    return { lines, br: ls.br, finalBr };
  }
  const found = findTier(ls.lines, h.o, strict);
  if (!found) throw new Fail('no-match', path);
  const target = h.a - 1 + d;
  let best = found.occ[0]!;
  let bestDist = Math.abs(best - target);
  for (const pos of found.occ) {
    const dist = Math.abs(pos - target);
    if (dist < bestDist) {
      best = pos;
      bestDist = dist;
    }
  }
  const built = buildNewLines(h.n, ls.lines, best, h.o, found.tier);
  const lines = [...ls.lines];
  lines.splice(best, h.o.length, ...built);
  let finalBr = ls.finalBr;
  if (best + h.o.length === ls.lines.length) finalBr = !h.noEol;
  return { lines, br: ls.br, finalBr };
}

function sectionEdit(sec: Section, strict: boolean): Edit {
  const oldP = sec.oldPath ?? sec.renameFrom ?? sec.gitOld ?? '';
  const newP = sec.newPath ?? sec.renameTo ?? sec.gitNew ?? '';
  const oldNull = oldP === '/dev/null';
  const newNull = newP === '/dev/null';
  const isCreate = oldNull || sec.newFile;
  const isDelete = !isCreate && (newNull || sec.delFile);
  const isMove = !isCreate && !isDelete && oldP !== newP;
  const edit: Edit = {
    apply(tree) {
      if (isCreate) {
        if (!safe(newP)) throw new Fail('unsafe', newP);
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
        const plus: string[] = [];
        let noEol = false;
        for (const h of sec.hunks) {
          for (const nl of h.n) if (nl.ctx === null) plus.push(nl.text);
          if (h.n.some((nl) => nl.ctx === null)) noEol = h.plusNoEol;
        }
        tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
        return;
      }
      if (isDelete) {
        if (!safe(oldP)) throw new Fail('unsafe', oldP);
        if (tree.get(oldP) === null) throw new Fail('missing', oldP);
        tree.now.set(oldP, null);
        return;
      }
      if (isMove) {
        if (!safe(oldP)) throw new Fail('unsafe', oldP);
        if (!safe(newP)) throw new Fail('unsafe', newP);
        const cur = tree.get(oldP);
        if (cur === null) throw new Fail('missing', oldP);
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
        let ls = splitFile(cur);
        let d = 0;
        for (const h of sec.hunks) {
          ls = applyHunk(ls, h, d, strict, oldP);
          d += h.n.length - h.o.length;
        }
        tree.now.set(newP, joinFile(ls));
        tree.now.set(oldP, null);
        return;
      }
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      const cur = tree.get(oldP);
      if (cur === null) throw new Fail('missing', oldP);
      let ls = splitFile(cur);
      let d = 0;
      for (const h of sec.hunks) {
        ls = applyHunk(ls, h, d, strict, oldP);
        d += h.n.length - h.o.length;
      }
      tree.now.set(oldP, joinFile(ls));
    },
  };
  if (isMove) edit.move = [oldP, newP];
  return edit;
}

function newSection(gitOld: string | null, gitNew: string | null): Section {
  return {
    oldPath: null,
    newPath: null,
    renameFrom: null,
    renameTo: null,
    gitOld,
    gitNew,
    newFile: false,
    delFile: false,
    sawHeaderPair: false,
    hunks: [],
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let sec: Section | null = null;
  const flush = (): void => {
    if (sec !== null) {
      edits.push(sectionEdit(sec, strict));
      sec = null;
    }
  };
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      flush();
      sec = newSection(m[1]!, m[2]!);
      i++;
      continue;
    }
    if (sec === null) {
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        sec = newSection(null, null);
        sec.oldPath = headerPath(line);
        sec.newPath = headerPath(lines[i + 1]!);
        sec.sawHeaderPair = true;
        i += 2;
        continue;
      }
      if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i++;
      continue;
    }
    if (sec.hunks.length === 0) {
      // Header phase.
      if (line.startsWith('--- ')) {
        if (sec.sawHeaderPair) {
          // A second pair is not part of this header: it starts a new section.
          if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
          flush();
          sec = newSection(null, null);
          sec.oldPath = headerPath(line);
          sec.newPath = headerPath(lines[i + 1]!);
          sec.sawHeaderPair = true;
          i += 2;
          continue;
        }
        if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        sec.oldPath = headerPath(line);
        sec.newPath = headerPath(lines[i + 1]!);
        sec.sawHeaderPair = true;
        i += 2;
        continue;
      }
      if (line.startsWith('@@')) {
        const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
        if (hm === null) throw new Exit2(`error: parse ${i + 1}`);
        const r = readHunkBody(lines, i + 1, Number(hm[1]));
        sec.hunks.push(r.hunk);
        i = r.next;
        continue;
      }
      if (line.startsWith('rename from ')) {
        sec.renameFrom = line.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        sec.renameTo = line.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        sec.newFile = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        sec.delFile = true;
        i++;
        continue;
      }
      // index, modes, similarity, Index: and any other line are ignored.
      i++;
      continue;
    }
    // Hunks phase.
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      flush();
      sec = newSection(null, null);
      sec.oldPath = headerPath(line);
      sec.newPath = headerPath(lines[i + 1]!);
      sec.sawHeaderPair = true;
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (hm === null) throw new Exit2(`error: parse ${i + 1}`);
      const r = readHunkBody(lines, i + 1, Number(hm[1]));
      sec.hunks.push(r.hunk);
      i = r.next;
      continue;
    }
    // Any other line ends the section; re-read it outside any section.
    flush();
  }
  flush();
  return edits;
}

/* Section 7: SEARCH/REPLACE blocks. */

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let prevPath: string | null = null;
  let prevReplaceEnd = 0;
  let i = 0;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = searchLine - 1; j >= prevReplaceEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '') continue;
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = searchLine + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    const oldLines = lines.slice(searchLine + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    const p = path;
    edits.push({
      apply(tree) {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (oldLines.length === 0) {
          if (tree.get(p) !== null) throw new Fail('exists', p);
          tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
          return;
        }
        const cur = tree.get(p);
        if (cur === null) throw new Fail('missing', p);
        const ls = splitFile(cur);
        const found = findTier(ls.lines, oldLines, strict);
        if (!found) throw new Fail('no-match', p);
        if (found.occ.length > 1) throw new Fail('ambiguous', p);
        const start = found.occ[0]!;
        const nl: NLine[] = newLines.map((t) => ({ text: t, ctx: null }));
        const built = buildNewLines(nl, ls.lines, start, oldLines, found.tier);
        const out = [...ls.lines];
        out.splice(start, oldLines.length, ...built);
        tree.now.set(p, joinFile({ lines: out, br: ls.br, finalBr: ls.finalBr }));
      },
    });
    prevPath = path;
    prevReplaceEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

/* Section 8: V4A patches. */

interface VChunk {
  anchor: string | null;
  o: string[];
  n: NLine[];
  eof: boolean;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const end = last;
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < end) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const p = line.slice('*** Add File: '.length).trim();
      i++;
      const raw: { idx: number; text: string }[] = [];
      while (i < end && !isSectionStart(lines[i]!)) {
        raw.push({ idx: i, text: lines[i]! });
        i++;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
      const fileLines: string[] = [];
      for (const r of raw) {
        if (r.text === '') fileLines.push('');
        else if (r.text[0] === '+') fileLines.push(r.text.slice(1));
        else throw new Exit2(`error: parse ${r.idx + 1}`);
      }
      edits.push({
        apply(tree) {
          if (!safe(p)) throw new Fail('unsafe', p);
          if (tree.get(p) !== null) throw new Fail('exists', p);
          tree.now.set(p, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
        },
      });
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const p = line.slice('*** Delete File: '.length).trim();
      edits.push({
        apply(tree) {
          if (!safe(p)) throw new Fail('unsafe', p);
          if (tree.get(p) === null) throw new Fail('missing', p);
          tree.now.set(p, null);
        },
      });
      i++;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const updateLine = i;
      const p = line.slice('*** Update File: '.length).trim();
      i++;
      const raw: { idx: number; text: string }[] = [];
      while (i < end && !isSectionStart(lines[i]!)) {
        raw.push({ idx: i, text: lines[i]! });
        i++;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
      let k = 0;
      while (k < raw.length && blank(raw[k]!.text)) k++;
      let moveTo: string | null = null;
      let bodyStart = 0;
      if (k < raw.length && raw[k]!.text.startsWith('*** Move to: ')) {
        moveTo = raw[k]!.text.slice('*** Move to: '.length).trim();
        bodyStart = k + 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      const flushChunk = (): void => {
        if (cur !== null) {
          chunks.push(cur);
          cur = null;
        }
      };
      for (let j = bodyStart; j < raw.length; j++) {
        const { idx, text } = raw[j]!;
        if (text.startsWith('@@')) {
          flushChunk();
          const anchor = text.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, o: [], n: [], eof: false };
          continue;
        }
        if (text === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${idx + 1}`);
          cur.eof = true;
          flushChunk();
          continue;
        }
        if (text === '' || text[0] === ' ' || text[0] === '-' || text[0] === '+') {
          if (cur === null) cur = { anchor: null, o: [], n: [], eof: false };
          if (text === '' || text[0] === ' ') {
            const t = text === '' ? '' : text.slice(1);
            cur.o.push(t);
            cur.n.push({ text: t, ctx: cur.o.length - 1 });
          } else if (text[0] === '-') {
            cur.o.push(text.slice(1));
          } else {
            cur.n.push({ text: text.slice(1), ctx: null });
          }
          continue;
        }
        throw new Exit2(`error: parse ${idx + 1}`);
      }
      flushChunk();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine + 1}`);
      const mv = moveTo;
      const edit: Edit = {
        apply(tree) {
          if (!safe(p)) throw new Fail('unsafe', p);
          if (mv !== null && !safe(mv)) throw new Fail('unsafe', mv);
          const curText = tree.get(p);
          if (curText === null) throw new Fail('missing', p);
          if (mv !== null && tree.get(mv) !== null) throw new Fail('exists', mv);
          let ls = splitFile(curText);
          let cursor = 0;
          for (const ch of chunks) {
            if (ch.anchor !== null) {
              const at = findSingle(ls.lines, ch.anchor, cursor, strict);
              if (at === null) throw new Fail('no-match', p);
              cursor = at + 1;
            }
            if (ch.o.length === 0) {
              const at = ch.eof ? ls.lines.length : cursor;
              const ins = ch.n.map((nl) => nl.text);
              const out = [...ls.lines];
              out.splice(at, 0, ...ins);
              ls = { lines: out, br: ls.br, finalBr: ls.finalBr };
              cursor = at + ins.length;
              continue;
            }
            const found = findTierFrom(ls.lines, ch.o, cursor, strict);
            if (!found) throw new Fail('no-match', p);
            let occ = found.occ[0]!;
            if (ch.eof) {
              const e = found.occ.find((pos) => pos + ch.o.length === ls.lines.length);
              if (e === undefined) throw new Fail('no-match', p);
              occ = e;
            }
            const built = buildNewLines(ch.n, ls.lines, occ, ch.o, found.tier);
            const out = [...ls.lines];
            out.splice(occ, ch.o.length, ...built);
            ls = { lines: out, br: ls.br, finalBr: ls.finalBr };
            cursor = occ + built.length;
          }
          const outText = joinFile(ls);
          if (mv !== null) {
            tree.now.set(mv, outText);
            tree.now.set(p, null);
          } else {
            tree.now.set(p, outText);
          }
        },
      };
      if (mv !== null) edit.move = [p, mv];
      edits.push(edit);
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

/* Sections 1, 2 and 10: invocation, output and exit codes, order and atomicity. */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  const failedIdx = new Set<number>();
  for (let k = 0; k < edits.length; k++) {
    const edit = edits[k]!;
    const before = new Map(tree.now);
    try {
      edit.apply(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [key, v] of before) tree.now.set(key, v);
      fails.push(e);
      failedIdx.add(k);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Exit 0 rows. A move that succeeded replaces its D and A lines with one R line, sorted by the new path.
  const moveByNew = new Map<string, string>();
  for (let k = 0; k < edits.length; k++) {
    if (failedIdx.has(k)) continue;
    const mv = edits[k]!.move;
    if (mv === undefined) continue;
    const [oldP, newP] = mv;
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      moveByNew.set(newP, oldP);
    }
  }
  const moveSources = new Set<string>(moveByNew.values());
  interface Row {
    key: string;
    text: string;
  }
  const rows: Row[] = [];
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (moveByNew.has(p)) {
      rows.push({ key: p, text: `R ${moveByNew.get(p)} -> ${p}` });
      continue;
    }
    if (moveSources.has(p)) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
