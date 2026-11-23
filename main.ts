// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
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

type Edit = (tree: Tree) => void;

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
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
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
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
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

/** Section 5: matching lines at three tiers. A file's own line break and final break are kept apart from its lines. */

function leadWS(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

function trimEndWS(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function trimWS(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

interface FileText {
  lines: string[];
  br: '\r\n' | '\n';
  finalBreak: boolean;
}

function splitFileText(text: string): FileText {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { lines: parts, br, finalBreak };
}

function joinFileText(f: FileText): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.finalBreak ? f.br : '');
}

function tierKey(tier: number): (s: string) => string {
  if (tier === 1) return trimEndWS;
  if (tier === 2) return trimWS;
  return (s: string): string => s;
}

/** Positions at or after `from` where O occurs at `tier`; with eofOnly, only ones ending at the last line. */
function occurrences(lines: string[], o: string[], tier: number, from: number, eofOnly: boolean): number[] {
  const key = tierKey(tier);
  const want = o.map(key);
  const out: number[] = [];
  for (let i = from; i + o.length <= lines.length; i++) {
    if (eofOnly && i + o.length !== lines.length) continue;
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (key(lines[i + j]!) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs (at or after `from`), with its positions, or null when it occurs at none. */
function findTier(lines: string[], o: string[], strict: boolean, from: number, eofOnly: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t, from, eofOnly);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** The first line at or after `from` equal to `anchor` at the first tier where one is, or null. */
function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const key = tierKey(t);
    const a = key(anchor);
    for (let i = from; i < lines.length; i++) {
      if (key(lines[i]!) === a) return i;
    }
  }
  return null;
}

function reindent(line: string, p: string, f: string): string {
  if (line === '' || line.trim() === '') return line;
  if (line.startsWith(p)) return f + line.slice(p.length);
  return line;
}

/** One line of N: a context line comes from the file at its O position, any other line is written (re-indented at tier 2). */
interface NEntry {
  ctx: boolean;
  text: string;
  oi: number;
}

function buildN(spec: NEntry[], o: string[], fileLines: string[], pos: number, tier: number): string[] {
  const out: string[] = [];
  const p = o.length > 0 ? leadWS(o[0]!) : '';
  const f = leadWS(fileLines[pos]!);
  for (const e of spec) {
    if (e.ctx) out.push(fileLines[pos + e.oi]!);
    else if (tier === 2) out.push(reindent(e.text, p, f));
    else out.push(e.text);
  }
  return out;
}

/** Section 6: unified diffs. */

interface BodyEntry {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
  noNL: boolean;
}

interface Hunk {
  a: number;
  entries: BodyEntry[];
}

interface UniSection {
  oldP: string | null | undefined;
  newP: string | null | undefined;
  pairSeen: boolean;
  isNew: boolean;
  isDel: boolean;
  hunks: Hunk[];
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_GIT = /^diff --git a\/(.+) b\/(.+)$/;

function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** The path a `--- ` or `+++ ` line names: after the four characters, up to the first tab, trimmed. */
function headerPath(line: string): string | null {
  const t = line.slice(4).split('\t')[0]!.trim();
  if (t === '/dev/null') return null;
  return stripAB(t);
}

/** Whether a `\` line follows the hunk's last context or `+` line. */
function hunkNoNL(h: Hunk): boolean {
  for (let k = h.entries.length - 1; k >= 0; k--) {
    const e = h.entries[k]!;
    if (e.kind === ' ' || e.kind === '+') return e.noNL;
  }
  return false;
}

/** Split a hunk body into O (context and `-` lines) and the lines of N, in body order. */
function hunkON(h: Hunk): { o: string[]; spec: NEntry[] } {
  const o: string[] = [];
  const spec: NEntry[] = [];
  let oi = 0;
  for (const e of h.entries) {
    if (e.kind === ' ') {
      o.push(e.text);
      spec.push({ ctx: true, text: e.text, oi });
      oi++;
    } else if (e.kind === '-') {
      o.push(e.text);
      oi++;
    } else if (e.kind === '+') {
      spec.push({ ctx: false, text: e.text, oi: -1 });
    }
  }
  return { o, spec };
}

function unifiedEdits(lines: string[], strict: boolean, moves: Array<[string, string]>): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let inBody = false;
  let hunk: Hunk | null = null;

  const newSection = (): UniSection => {
    const s: UniSection = { oldP: undefined, newP: undefined, pairSeen: false, isNew: false, isDel: false, hunks: [] };
    sections.push(s);
    cur = s;
    inBody = false;
    hunk = null;
    return s;
  };

  const endBody = (): void => {
    if (hunk !== null) {
      while (hunk.entries.length > 0) {
        const last = hunk.entries[hunk.entries.length - 1]!;
        if (last.kind === ' ' && last.text === '') hunk.entries.pop();
        else break;
      }
    }
    inBody = false;
    hunk = null;
  };

  const startHunk = (line: string, num: number): void => {
    const m = HUNK_HEAD.exec(line);
    if (m === null || cur === null) throw new Exit2(`error: parse ${num}`);
    endBody();
    const h: Hunk = { a: Number(m[1]), entries: [] };
    cur.hunks.push(h);
    hunk = h;
    inBody = true;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const num = i + 1;
    if (inBody) {
      if (line.startsWith('diff --git ')) {
        endBody();
        continue;
      }
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        endBody();
        continue;
      }
      if (line.startsWith('@@')) {
        startHunk(line, num);
        i++;
        continue;
      }
      if (line === '' || line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line.startsWith('\\')) {
        if (line.startsWith('\\')) {
          const prev = hunk!.entries[hunk!.entries.length - 1];
          if (prev !== undefined) prev.noNL = true;
          hunk!.entries.push({ kind: '\\', text: line.slice(1), noNL: false });
        } else if (line === '') {
          hunk!.entries.push({ kind: ' ', text: '', noNL: false });
        } else {
          hunk!.entries.push({ kind: line[0] as ' ' | '-' | '+', text: line.slice(1), noNL: false });
        }
        i++;
        continue;
      }
      endBody();
      continue;
    }
    if (line.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(line);
      if (m === null) throw new Exit2(`error: parse ${num}`);
      const s = newSection();
      s.oldP = m[1]!;
      s.newP = m[2]!;
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && cur.hunks.length === 0 && !cur.pairSeen) {
        cur.oldP = headerPath(line);
        cur.newP = headerPath(lines[i + 1]!);
        cur.pairSeen = true;
      } else {
        const s = newSection();
        s.oldP = headerPath(line);
        s.newP = headerPath(lines[i + 1]!);
        s.pairSeen = true;
      }
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (cur !== null && cur.hunks.length === 0) throw new Exit2(`error: parse ${num + 1}`);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      startHunk(line, num);
      i++;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('+++ ') && !cur.pairSeen) {
        cur.newP = headerPath(line);
      } else if (line.startsWith('rename from ') && !cur.pairSeen) {
        cur.oldP = line.slice('rename from '.length).trim();
      } else if (line.startsWith('rename to ') && !cur.pairSeen) {
        cur.newP = line.slice('rename to '.length).trim();
      } else if (line.startsWith('new file mode')) {
        cur.isNew = true;
      } else if (line.startsWith('deleted file mode')) {
        cur.isDel = true;
      }
    }
    i++;
  }
  endBody();

  const edits: Edit[] = [];
  for (const s of sections) {
    const oldP: string | null = s.oldP === undefined ? null : s.oldP;
    const newP: string | null = s.newP === undefined ? null : s.newP;
    if (oldP === null || s.isNew) {
      if (newP === null) {
        edits.push(() => {});
        continue;
      }
      const plus: Array<{ text: string; noNL: boolean }> = [];
      for (const h of s.hunks) {
        for (const e of h.entries) if (e.kind === '+') plus.push({ text: e.text, noNL: e.noNL });
      }
      const target = newP;
      edits.push((tree) => {
        if (!safe(target)) throw new Fail('unsafe', target);
        if (tree.get(target) !== null) throw new Fail('exists', target);
        const last = plus[plus.length - 1];
        tree.now.set(target, plus.length === 0 ? '' : plus.map((p) => p.text).join('\n') + (last !== undefined && last.noNL ? '' : '\n'));
      });
      continue;
    }
    if (newP === null || s.isDel) {
      const target = oldP;
      edits.push((tree) => {
        if (!safe(target)) throw new Fail('unsafe', target);
        if (tree.get(target) === null) throw new Fail('missing', target);
        tree.now.set(target, null);
      });
      continue;
    }
    const isMove = oldP !== newP;
    const src = oldP;
    const dst = newP;
    edits.push((tree) => {
      if (!safe(src)) throw new Fail('unsafe', src);
      if (isMove && !safe(dst)) throw new Fail('unsafe', dst);
      const before = tree.get(src);
      if (before === null) throw new Fail('missing', src);
      if (isMove && tree.get(dst) !== null) throw new Fail('exists', dst);
      const f = splitFileText(before);
      let d = 0;
      for (const h of s.hunks) {
        const { o, spec } = hunkON(h);
        const noNL = hunkNoNL(h);
        if (o.length === 0) {
          const at = Math.min(h.a + d, f.lines.length);
          const atEnd = h.a + d >= f.lines.length;
          const ins = spec.map((e) => e.text);
          f.lines.splice(at, 0, ...ins);
          if (atEnd) f.finalBreak = !noNL;
          d += ins.length;
        } else {
          const found = findTier(f.lines, o, strict, 0, false);
          if (found === null) throw new Fail('no-match', src);
          const target = h.a - 1 + d;
          let pos = found.occ[0]!;
          let best = Math.abs(pos - target);
          for (const q of found.occ) {
            const dist = Math.abs(q - target);
            if (dist < best) {
              best = dist;
              pos = q;
            }
          }
          const runsToEnd = pos + o.length === f.lines.length;
          const n = buildN(spec, o, f.lines, pos, found.tier);
          f.lines.splice(pos, o.length, ...n);
          if (runsToEnd) f.finalBreak = !noNL;
          d += n.length - o.length;
        }
      }
      const out = joinFileText(f);
      if (isMove) {
        tree.now.set(src, null);
        tree.now.set(dst, out);
        moves.push([src, dst]);
      } else {
        tree.now.set(src, out);
      }
    });
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/** Section 7: SEARCH/REPLACE blocks. */

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = splitFileText(before);
    const found = findTier(f.lines, oldLines, strict, 0, false);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const spec: NEntry[] = newLines.map((t) => ({ ctx: false, text: t, oi: -1 }));
    const n = buildN(spec, oldLines, f.lines, pos, found.tier);
    f.lines.splice(pos, oldLines.length, ...n);
    tree.now.set(path, joinFileText(f));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplace = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchNum = i + 1;
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchNum}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchNum}`);
    const oldLines = lines.slice(i + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    let path: string | null = null;
    for (let j = i - 1; j > prevReplace; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchNum}`);
    prevPath = path;
    prevReplace = rep;
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/** Section 8: V4A patches. */

type V4aKind = 'add' | 'delete' | 'update';

function v4aKind(line: string): V4aKind | null {
  if (line.startsWith('*** Add File:')) return 'add';
  if (line.startsWith('*** Delete File:')) return 'delete';
  if (line.startsWith('*** Update File:')) return 'update';
  return null;
}

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  entries: Array<{ kind: ' ' | '-' | '+'; text: string }>;
}

function v4aSectionEdit(
  kind: V4aKind,
  path: string,
  body: Array<{ text: string; num: number }>,
  headNum: number,
  strict: boolean,
  moves: Array<[string, string]>,
): Edit {
  if (kind === 'add') {
    const out: string[] = [];
    for (const b of body) {
      if (b.text.startsWith('+')) out.push(b.text.slice(1));
      else if (b.text === '') out.push('');
      else throw new Exit2(`error: parse ${b.num}`);
    }
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, out.length === 0 ? '' : out.join('\n') + '\n');
    };
  }
  if (kind === 'delete') {
    if (body.length > 0) throw new Exit2(`error: parse ${body[0]!.num}`);
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
    };
  }
  let idx = 0;
  let moveTo: string | null = null;
  if (body.length > 0 && body[0]!.text.startsWith('*** Move to:')) {
    moveTo = body[0]!.text.slice('*** Move to:'.length).trim();
    idx = 1;
  }
  const chunks: V4aChunk[] = [];
  let chunk: V4aChunk | null = null;
  for (; idx < body.length; idx++) {
    const b = body[idx]!;
    const t = b.text;
    if (t.startsWith('@@')) {
      const a = t.slice(2).trim();
      chunk = { anchor: a === '' ? null : a, eof: false, entries: [] };
      chunks.push(chunk);
    } else if (t === '*** End of File') {
      if (chunk === null) throw new Exit2(`error: parse ${b.num}`);
      chunk.eof = true;
      chunk = null;
    } else if (t.startsWith(' ') || t.startsWith('-') || t.startsWith('+') || t === '') {
      if (chunk === null) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${b.num}`);
        chunk = { anchor: null, eof: false, entries: [] };
        chunks.push(chunk);
      }
      chunk.entries.push({ kind: t === '' ? ' ' : (t[0] as ' ' | '-' | '+'), text: t === '' ? '' : t.slice(1) });
    } else {
      throw new Exit2(`error: parse ${b.num}`);
    }
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headNum}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = splitFileText(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const at = findAnchor(f.lines, ch.anchor, cursor, strict);
        if (at === null) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      const o: string[] = [];
      const spec: NEntry[] = [];
      let oi = 0;
      for (const e of ch.entries) {
        if (e.kind === ' ') {
          o.push(e.text);
          spec.push({ ctx: true, text: e.text, oi });
          oi++;
        } else if (e.kind === '-') {
          o.push(e.text);
          oi++;
        } else {
          spec.push({ ctx: false, text: e.text, oi: -1 });
        }
      }
      if (o.length === 0) {
        const at = ch.eof ? f.lines.length : cursor;
        const ins = spec.map((e) => e.text);
        f.lines.splice(at, 0, ...ins);
        cursor = at + ins.length;
      } else {
        const found = findTier(f.lines, o, strict, cursor, ch.eof);
        if (found === null) throw new Fail('no-match', path);
        const pos = found.occ[0]!;
        const n = buildN(spec, o, f.lines, pos, found.tier);
        f.lines.splice(pos, o.length, ...n);
        cursor = pos + n.length;
      }
    }
    const out = joinFileText(f);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean, moves: Array<[string, string]>): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    const kind = v4aKind(line);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const prefix = kind === 'add' ? '*** Add File:' : kind === 'delete' ? '*** Delete File:' : '*** Update File:';
    const path = line.slice(prefix.length).trim();
    const body: Array<{ text: string; num: number }> = [];
    let j = i + 1;
    while (j < last) {
      if (v4aKind(lines[j]!) !== null) break;
      body.push({ text: lines[j]!, num: j + 1 });
      j++;
    }
    while (body.length > 0 && blank(body[body.length - 1]!.text)) body.pop();
    edits.push(v4aSectionEdit(kind, path, body, i + 1, strict, moves));
    i = j;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

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
  const moves: Array<[string, string]> = [];
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict, moves)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict, moves);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const moved: Array<{ sort: string; line: string }> = [];
  const covered = new Set<string>();
  for (const [oldP, newP] of moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      moved.push({ sort: newP, line: `R ${oldP} -> ${newP}` });
      covered.add(oldP);
      covered.add(newP);
    }
  }
  const rows: Array<{ sort: string; line: string }> = [...moved];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (covered.has(p)) continue;
    rows.push({ sort: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.sort), Buffer.from(b.sort)));
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
  const outRows = rows.map((r) => r.line);
  return { code: 0, out: [...outRows, `ok: ${outRows.length} ${outRows.length === 1 ? 'file' : 'files'}`] };
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
