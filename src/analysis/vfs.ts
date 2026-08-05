// vfs.ts — Virtual filesystem for glob expansion

import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { posix as path } from 'node:path';

// ── Windows ↔ POSIX path conversion ──

const IS_WIN32 = process.platform === 'win32';
const MAX_BOUNDED_TEXT_READ_BYTES = 16 * 1024 * 1024;
export const MAX_PREDICTED_TEXT_FILE_BYTES = 16 * 1024;
export const MAX_GLOB_DIRECTORY_SCANS = 4096;
export const MAX_GLOB_VISITED_ENTRIES = 20_000;
export const MAX_GLOB_PATH_CANDIDATES = 20_000;

type TextFileUpdateMode = 'truncate' | 'append';
interface FileEntry {
  kind: 'file';
  text: string | null;
}
interface DirectoryEntry {
  kind: 'directory';
}
type FsEntry = FileEntry | DirectoryEntry;

/**
 * Convert a path to POSIX form (C:\Users\foo → /c/Users/foo).
 * Always detects Windows patterns so cross-platform analysis works.
 *
 * Accepts: C:\Users\foo, C:/Users/foo, c:\users\foo, /c/Users/foo (git-bash),
 * and bare drives C:\ or C: (→ /c).
 */
export function toPosix(p: string): string {
  const fwd = p.replace(/\\/g, '/');
  // Drive letter with separator: C:/foo → /c/foo, C:/ → /c/
  const m = fwd.match(/^([a-zA-Z]):\/(.*)/);
  if (m) return '/' + m[1].toLowerCase() + '/' + m[2];
  // Bare drive letter (no separator): C: → /c
  const b = fwd.match(/^([a-zA-Z]):$/);
  if (b) return '/' + b[1].toLowerCase();
  return fwd;
}

/**
 * Test if a path is absolute. Recognizes both POSIX (`/...`) and Windows
 * drive-letter (`C:\...`, `C:/...`, bare `C:`) forms.
 *
 * `C:foo` (drive-relative, no separator) remains relative — Windows's
 * "current dir on drive X" semantics can't be modeled here.
 */
export function isAbsolutePath(p: string): boolean {
  if (p.length === 0) return false;
  // POSIX absolute
  if (p[0] === '/') return true;
  // Windows drive letter
  if (/^[a-zA-Z]$/.test(p[0]) && p[1] === ':') {
    if (p.length === 2) return true;                   // bare `C:`
    if (p[2] === '/' || p[2] === '\\') return true;    // `C:\...` or `C:/...`
  }
  return false;
}

/** Convert a POSIX path to native OS path (/c/Users/foo → C:\Users\foo) */
export function toNative(p: string): string {
  if (!IS_WIN32) return p;
  const m = p.match(/^\/([a-zA-Z])\/(.*)/);
  if (m) return m[1].toUpperCase() + ':\\' + m[2].replace(/\//g, '\\');
  return p;
}

/** Common filesystem interface for glob expansion and bounded text inspection. */
export type TextFileReadResult =
  | { kind: 'text'; text: string; byteLength: number }
  | {
    kind: 'unavailable';
    reason:
      | 'missing'
      | 'directory'
      | 'special-file'
      | 'unreadable'
      | 'overlay-content-unknown'
      | 'too-large'
      | 'not-utf8'
      | 'nul-byte'
      | 'changed-during-read';
  };

export interface IFS {
  exists(absPath: string): boolean;
  isDirectory(absPath: string): boolean;
  isFile(absPath: string): boolean;
  isSymbolicLink(absPath: string): boolean;
  readdir(dirPath: string): string[];
  /** Read a stable, bounded UTF-8 regular file without consulting host commands. */
  readTextFile(absPath: string, maxBytes: number): TextFileReadResult;
  /**
   * Update bounded predicted contents. `null` records an explicit unknown and
   * append never falls back to stale disk data after an overlay mutation.
   */
  updateTextFile(
    absPath: string,
    text: string | null,
    mode: TextFileUpdateMode,
  ): boolean;
  addFile(absPath: string): void;
  addDirectory(absPath: string): void;
  remove(absPath: string): void;
  /** Fork only the bounded overlay; RealFS never copies or walks its disk base. */
  clone(): IFS;
  /** Deterministic key for branch-state deduplication. */
  stateKey(): string;
}

/** Pure in-memory filesystem backed by a flat Map */
export class VirtualFS implements IFS {
  private entries = new Map<string, FsEntry>();

  constructor(paths?: string[]) {
    if (paths) {
      for (const p of paths) {
        if (p.endsWith('/')) {
          this.addDirectory(p.slice(0, -1));
        } else {
          this.addFile(p);
        }
      }
    }
  }

  private norm(p: string): string {
    return path.normalize(p);
  }

  exists(absPath: string): boolean {
    return this.entries.has(this.norm(absPath));
  }

  isDirectory(absPath: string): boolean {
    return this.entries.get(this.norm(absPath))?.kind === 'directory';
  }

  isFile(absPath: string): boolean {
    return this.entries.get(this.norm(absPath))?.kind === 'file';
  }

  isSymbolicLink(): boolean {
    return false;
  }

  readdir(dirPath: string): string[] {
    const dir = this.norm(dirPath);
    const results: string[] = [];
    for (const [p] of this.entries) {
      const parent = path.dirname(p);
      if (parent === dir && p !== dir) {
        results.push(path.basename(p));
      }
    }
    return results.sort();
  }

  readTextFile(absPath: string, maxBytes: number): TextFileReadResult {
    const entry = this.entries.get(this.norm(absPath));
    if (entry === undefined) return { kind: 'unavailable', reason: 'missing' };
    if (entry.kind === 'directory') return { kind: 'unavailable', reason: 'directory' };
    return readOverlayText(entry.text, maxBytes);
  }

  updateTextFile(
    absPath: string,
    text: string | null,
    mode: TextFileUpdateMode,
  ): boolean {
    const n = this.norm(absPath);
    const current = this.entries.get(n);
    if (current?.kind === 'directory') return false;
    const base = mode === 'append'
      ? (current?.kind === 'file' ? current.text : '')
      : '';
    this.entries.set(n, {
      kind: 'file',
      text: combinePredictedText(base, text),
    });
    this._ensureParents(n);
    return true;
  }

  addFile(absPath: string): void {
    const n = this.norm(absPath);
    this.entries.set(n, { kind: 'file', text: null });
    this._ensureParents(n);
  }

  addDirectory(absPath: string): void {
    const n = this.norm(absPath);
    this.entries.set(n, { kind: 'directory' });
    this._ensureParents(n);
  }

  remove(absPath: string): void {
    const n = this.norm(absPath);
    this.entries.delete(n);
    // Also remove children (for rm -rf style)
    const prefix = n + '/';
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) {
        this.entries.delete(key);
      }
    }
  }

  clone(): VirtualFS {
    const copy = new VirtualFS();
    copy.entries = new Map(this.entries);
    return copy;
  }

  stateKey(): string {
    return JSON.stringify([
      'virtual',
      [...this.entries]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([entryPath, entry]) => [entryPath, entryStateKey(entry)]),
    ]);
  }

  private _ensureParents(p: string): void {
    let dir = path.dirname(p);
    while (dir !== p && dir !== '/' && dir !== '.') {
      if (!this.entries.has(dir)) {
        this.entries.set(dir, { kind: 'directory' });
      }
      p = dir;
      dir = path.dirname(dir);
    }
    // Ensure root exists
    if (!this.entries.has('/')) {
      this.entries.set('/', { kind: 'directory' });
    }
  }
}

/** Read-only view of the real disk with an overlay for effect feedback */
export class RealFS implements IFS {
  private added = new Map<string, FsEntry>();
  private removed = new Set<string>();

  private norm(p: string): string {
    return path.normalize(p);
  }

  exists(absPath: string): boolean {
    const n = this.norm(absPath);
    if (this.removed.has(n)) return false;
    if (this.added.has(n)) return true;
    try { fs.statSync(toNative(n)); return true; } catch { return false; }
  }

  isDirectory(absPath: string): boolean {
    const n = this.norm(absPath);
    if (this.removed.has(n)) return false;
    const ov = this.added.get(n);
    if (ov !== undefined) return ov.kind === 'directory';
    try { return fs.statSync(toNative(n)).isDirectory(); } catch { return false; }
  }

  isFile(absPath: string): boolean {
    const n = this.norm(absPath);
    if (this.removed.has(n)) return false;
    const ov = this.added.get(n);
    if (ov !== undefined) return ov.kind === 'file';
    try { return fs.statSync(toNative(n)).isFile(); } catch { return false; }
  }

  isSymbolicLink(absPath: string): boolean {
    const n = this.norm(absPath);
    if (this.removed.has(n) || this.added.has(n)) return false;
    try { return fs.lstatSync(toNative(n)).isSymbolicLink(); } catch { return false; }
  }

  readdir(dirPath: string): string[] {
    const dir = this.norm(dirPath);
    const names = new Set<string>();
    // Real disk entries
    try {
      for (const name of fs.readdirSync(toNative(dir))) {
        const full = path.join(dir, name);
        if (!this.removed.has(full)) {
          names.add(name);
        }
      }
    } catch { /* dir doesn't exist on disk */ }
    // Overlay additions
    for (const [p] of this.added) {
      if (path.dirname(p) === dir) {
        const name = path.basename(p);
        if (!this.removed.has(p)) {
          names.add(name);
        }
      }
    }
    return [...names].sort();
  }

  readTextFile(absPath: string, maxBytes: number): TextFileReadResult {
    const n = this.norm(absPath);
    if (this.removed.has(n)) return { kind: 'unavailable', reason: 'missing' };
    const overlay = this.added.get(n);
    if (overlay?.kind === 'directory') {
      return { kind: 'unavailable', reason: 'directory' };
    }
    if (overlay?.kind === 'file') {
      return readOverlayText(overlay.text, maxBytes);
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0
        || maxBytes > MAX_BOUNDED_TEXT_READ_BYTES) {
      return { kind: 'unavailable', reason: 'too-large' };
    }

    let fd: number;
    try {
      fd = fs.openSync(
        toNative(n),
        fs.constants.O_RDONLY | fs.constants.O_NONBLOCK,
      );
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return { kind: 'unavailable', reason: 'missing' };
      if (code === 'EISDIR') return { kind: 'unavailable', reason: 'directory' };
      return { kind: 'unavailable', reason: 'unreadable' };
    }

    try {
      const before = fs.fstatSync(fd);
      if (before.isDirectory()) return { kind: 'unavailable', reason: 'directory' };
      if (!before.isFile()) return { kind: 'unavailable', reason: 'special-file' };
      if (before.size > maxBytes) return { kind: 'unavailable', reason: 'too-large' };

      const buffer = Buffer.allocUnsafe(maxBytes + 1);
      let length = 0;
      while (length < buffer.length) {
        const count = fs.readSync(fd, buffer, length, buffer.length - length, null);
        if (count === 0) break;
        length += count;
      }
      if (length > maxBytes) return { kind: 'unavailable', reason: 'too-large' };

      const after = fs.fstatSync(fd);
      if (before.size !== length
          || before.size !== after.size
          || before.mtimeMs !== after.mtimeMs
          || before.ctimeMs !== after.ctimeMs) {
        return { kind: 'unavailable', reason: 'changed-during-read' };
      }

      const bytes = buffer.subarray(0, length);
      if (bytes.includes(0)) return { kind: 'unavailable', reason: 'nul-byte' };
      const text = bytes.toString('utf8');
      if (!Buffer.from(text, 'utf8').equals(bytes)) {
        return { kind: 'unavailable', reason: 'not-utf8' };
      }
      return { kind: 'text', text, byteLength: length };
    } catch {
      return { kind: 'unavailable', reason: 'unreadable' };
    } finally {
      try {
        fs.closeSync(fd);
      } catch {
        // The read result remains bounded even if closing an already-open fd fails.
      }
    }
  }

  updateTextFile(
    absPath: string,
    text: string | null,
    mode: TextFileUpdateMode,
  ): boolean {
    const n = this.norm(absPath);
    const overlay = this.added.get(n);
    if (overlay?.kind === 'directory') return false;

    let base: string | null = '';
    if (mode === 'append') {
      if (overlay?.kind === 'file') {
        base = overlay.text;
      } else if (!this.removed.has(n)) {
        const diskKind = this.diskEntryKind(n);
        if (diskKind === 'directory' || diskKind === 'special') return false;
        if (diskKind === 'unknown') base = null;
        if (diskKind === 'file') {
          const existing = this.readTextFile(
            n,
            MAX_PREDICTED_TEXT_FILE_BYTES,
          );
          base = existing.kind === 'text' ? existing.text : null;
        }
      }
    } else if (overlay === undefined && !this.removed.has(n)) {
      const diskKind = this.diskEntryKind(n);
      if (diskKind === 'directory' || diskKind === 'special') return false;
      if (diskKind === 'unknown') text = null;
    }

    this.removed.delete(n);
    this.added.set(n, {
      kind: 'file',
      text: combinePredictedText(base, text),
    });
    return true;
  }

  addFile(absPath: string): void {
    const n = this.norm(absPath);
    this.removed.delete(n);
    this.added.set(n, { kind: 'file', text: null });
  }

  addDirectory(absPath: string): void {
    const n = this.norm(absPath);
    this.removed.delete(n);
    this.added.set(n, { kind: 'directory' });
  }

  remove(absPath: string): void {
    const n = this.norm(absPath);
    this.added.delete(n);
    this.removed.add(n);
  }

  clone(): RealFS {
    const copy = new RealFS();
    copy.added = new Map(this.added);
    copy.removed = new Set(this.removed);
    return copy;
  }

  stateKey(): string {
    return JSON.stringify([
      'real-overlay',
      [...this.added]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([entryPath, entry]) => [entryPath, entryStateKey(entry)]),
      [...this.removed].sort(),
    ]);
  }

  private diskEntryKind(
    absPath: string,
  ): 'missing' | 'file' | 'directory' | 'special' | 'unknown' {
    try {
      const stat = fs.statSync(toNative(absPath));
      if (stat.isFile()) return 'file';
      if (stat.isDirectory()) return 'directory';
      return 'special';
    } catch (error: unknown) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'missing'
        : 'unknown';
    }
  }
}

function readOverlayText(
  text: string | null,
  maxBytes: number,
): TextFileReadResult {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0
      || maxBytes > MAX_BOUNDED_TEXT_READ_BYTES) {
    return { kind: 'unavailable', reason: 'too-large' };
  }
  if (text === null) {
    return { kind: 'unavailable', reason: 'overlay-content-unknown' };
  }
  const byteLength = Buffer.byteLength(text, 'utf8');
  if (byteLength > maxBytes) {
    return { kind: 'unavailable', reason: 'too-large' };
  }
  if (text.includes('\0')) {
    return { kind: 'unavailable', reason: 'nul-byte' };
  }
  return { kind: 'text', text, byteLength };
}

function combinePredictedText(
  base: string | null,
  addition: string | null,
): string | null {
  if (base === null || addition === null) return null;
  const combined = base + addition;
  return Buffer.byteLength(combined, 'utf8') <= MAX_PREDICTED_TEXT_FILE_BYTES
    ? combined
    : null;
}

function entryStateKey(entry: FsEntry): readonly unknown[] {
  if (entry.kind === 'directory') return ['directory'];
  if (entry.text === null) return ['file', 'unknown'];
  return [
    'file',
    Buffer.byteLength(entry.text, 'utf8'),
    createHash('sha256').update(entry.text, 'utf8').digest('hex'),
  ];
}

// ── Glob matching ──

/** Convert a single glob segment (e.g. *.txt, file?.js, [abc]) to a regex */
function glob_segment_to_regex(segment: string): RegExp {
  let re = '^';
  let i = 0;
  while (i < segment.length) {
    const c = segment[i];
    if (c === '*') {
      re += '[^/]*';
      i++;
    } else if (c === '?') {
      re += '[^/]';
      i++;
    } else if (c === '[') {
      const close = segment.indexOf(']', i + 1);
      if (close === -1) {
        re += '\\[';
        i++;
        continue;
      }
      // Character class — pass through mostly as-is
      let j = i + 1;
      let cls = '[';
      if (j < segment.length && (segment[j] === '!' || segment[j] === '^')) {
        cls += '^';
        j++;
      }
      while (j < segment.length && segment[j] !== ']') {
        cls += segment[j];
        j++;
      }
      if (j < segment.length) {
        cls += ']';
        j++; // skip ']'
      }
      re += cls;
      i = j;
    } else {
      // Escape regex-special chars
      re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      i++;
    }
  }
  re += '$';
  return new RegExp(re);
}

/** Match one path segment against the same wildcard grammar used by glob_expand. */
export function glob_match_segment(pattern: string, value: string): boolean {
  if (value.startsWith('.') && !pattern.startsWith('.')) return false;
  return glob_segment_to_regex(pattern).test(value);
}

/** Check whether a string contains glob metacharacters */
export function has_glob_chars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === '*' || s[i] === '?') return true;
    if (s[i] === '[' && s.indexOf(']', i + 1) !== -1) return true;
  }
  return false;
}

export type GlobExpansionLimitReason =
  | 'directory-scan-limit'
  | 'visited-entry-limit'
  | 'path-candidate-limit'
  | 'match-limit';

export interface GlobExpansionBudget {
  maxDirectoryScans: number;
  maxVisitedEntries: number;
  maxPathCandidates: number;
  directoryScans: number;
  visitedEntries: number;
  pathCandidates: number;
  exhaustedReasons: Set<Exclude<GlobExpansionLimitReason, 'match-limit'>>;
}

export interface GlobExpansionOptions {
  /** Shared structural budget; reuse one instance across a command's words. */
  budget?: GlobExpansionBudget;
  /** Maximum concrete matches retained for this pattern. */
  maxMatches?: number;
}

export interface GlobExpansionResult {
  matches: string[];
  complete: boolean;
  limitReasons: GlobExpansionLimitReason[];
  directoryScans: number;
  visitedEntries: number;
  pathCandidates: number;
}

export function createGlobExpansionBudget(
  limits: Partial<Pick<
    GlobExpansionBudget,
    'maxDirectoryScans' | 'maxVisitedEntries' | 'maxPathCandidates'
  >> = {},
): GlobExpansionBudget {
  return {
    maxDirectoryScans: boundedGlobLimit(
      limits.maxDirectoryScans,
      MAX_GLOB_DIRECTORY_SCANS,
    ),
    maxVisitedEntries: boundedGlobLimit(
      limits.maxVisitedEntries,
      MAX_GLOB_VISITED_ENTRIES,
    ),
    maxPathCandidates: boundedGlobLimit(
      limits.maxPathCandidates,
      MAX_GLOB_PATH_CANDIDATES,
    ),
    directoryScans: 0,
    visitedEntries: 0,
    pathCandidates: 0,
    exhaustedReasons: new Set(),
  };
}

/**
 * Expand one glob against an IFS using bounded, deduplicated path states.
 *
 * GNU Bash collapses adjacent `**` components before traversal. Keeping a set
 * of reachable directories also prevents equivalent globstar decompositions
 * from repeatedly walking and emitting the same filesystem path.
 */
export function glob_expand_bounded(
  pattern: string,
  cwd: string,
  vfs: IFS,
  options: GlobExpansionOptions = {},
): GlobExpansionResult {
  // Make pattern absolute — toPosix handles C:\... drive paths
  const posixPattern = toPosix(pattern);
  const absPattern = isAbsolutePath(pattern) ? posixPattern : path.join(cwd, posixPattern);

  // Bash's glob library collapses a slash-separated run of ** components.
  const segments = collapseAdjacentGlobstars(
    absPattern.split('/').filter(s => s !== ''),
  );
  const budget = options.budget ?? createGlobExpansionBudget();
  const maxMatches = boundedGlobLimit(
    options.maxMatches,
    Number.MAX_SAFE_INTEGER,
    true,
  );
  const localReasons = new Set<GlobExpansionLimitReason>();
  const directoryCache = new Map<string, BoundedDirectoryRead>();

  // Start from root — on Windows POSIX paths like /d/VMShare/...,
  // the first segment is the drive letter. Combine it with '/' to form
  // '/d' so toNative() can convert it to 'D:\' for fs access.
  let candidates: Set<string>;
  let startIdx: number;
  if (IS_WIN32 && segments.length > 0 && /^[a-zA-Z]$/.test(segments[0])) {
    candidates = new Set(['/' + segments[0]]);
    startIdx = 1;
  } else {
    candidates = new Set(['/']);
    startIdx = 0;
  }

  for (let si = startIdx; si < segments.length; si++) {
    const seg = segments[si];
    const isLast = si === segments.length - 1;
    const nextCandidates = new Set<string>();

    if (seg === '**') {
      expandGlobstarCandidates(
        candidates,
        nextCandidates,
        isLast,
        vfs,
        budget,
        maxMatches,
        localReasons,
        directoryCache,
      );
    } else if (has_glob_chars(seg)) {
      // Wildcard segment: readdir + match
      const re = glob_segment_to_regex(seg);
      for (const cand of candidates) {
        if (!vfs.isDirectory(cand)) continue;
        const read = readGlobDirectory(cand, vfs, budget, directoryCache);
        if (!read.complete) {
          for (const reason of budget.exhaustedReasons) localReasons.add(reason);
        }
        for (const name of read.names) {
          // * and ? don't match leading dot (default, dotglob off)
          if (name.startsWith('.') && !seg.startsWith('.')) continue;
          if (re.test(name)) {
            const added = addGlobPath(
              nextCandidates,
              path.join(cand, name),
              isLast,
              budget,
              maxMatches,
              localReasons,
            );
            if (!added) break;
          }
        }
        if (globExpansionStopped(budget, localReasons)) break;
      }
    } else {
      // Literal segment: check existence
      for (const cand of candidates) {
        const full = path.join(cand, seg);
        if (vfs.exists(full)) {
          const added = addGlobPath(
            nextCandidates,
            full,
            isLast,
            budget,
            maxMatches,
            localReasons,
          );
          if (!added) break;
        }
      }
    }

    candidates = nextCandidates;
    if (candidates.size === 0) break;
  }

  const limitReasons = [
    ...new Set([
      ...budget.exhaustedReasons,
      ...localReasons,
    ]),
  ].sort();
  return {
    matches: [...candidates].sort(),
    complete: limitReasons.length === 0,
    limitReasons,
    directoryScans: budget.directoryScans,
    visitedEntries: budget.visitedEntries,
    pathCandidates: budget.pathCandidates,
  };
}

/**
 * Compatibility wrapper for consumers that only need a path list.
 * An unresolved original pattern represents any matches omitted by budgets.
 */
export function glob_expand(
  pattern: string,
  cwd: string,
  vfs: IFS,
): string[] {
  const result = glob_expand_bounded(pattern, cwd, vfs);
  return result.complete
    ? result.matches
    : [...new Set([...result.matches, pattern])];
}

interface BoundedDirectoryRead {
  names: string[];
  complete: boolean;
}

function collapseAdjacentGlobstars(segments: readonly string[]): string[] {
  const collapsed: string[] = [];
  for (const segment of segments) {
    if (segment === '**' && collapsed[collapsed.length - 1] === '**') continue;
    collapsed.push(segment);
  }
  return collapsed;
}

function expandGlobstarCandidates(
  roots: ReadonlySet<string>,
  output: Set<string>,
  terminal: boolean,
  vfs: IFS,
  budget: GlobExpansionBudget,
  maxMatches: number,
  localReasons: Set<GlobExpansionLimitReason>,
  directoryCache: Map<string, BoundedDirectoryRead>,
): void {
  const queue = [...roots];
  const reachable = new Set(roots);
  let cursor = 0;

  while (cursor < queue.length) {
    const directory = queue[cursor++];
    if (!addGlobPath(
      output,
      directory,
      terminal,
      budget,
      maxMatches,
      localReasons,
      false,
    )) {
      return;
    }

    const read = readGlobDirectory(directory, vfs, budget, directoryCache);
    if (!read.complete) {
      for (const reason of budget.exhaustedReasons) localReasons.add(reason);
    }
    for (const name of read.names) {
      // Bash globstar does not select or descend through dot entries by default.
      if (name.startsWith('.')) continue;
      const full = path.join(directory, name);
      if (terminal && !addGlobPath(
        output,
        full,
        true,
        budget,
        maxMatches,
        localReasons,
        false,
      )) {
        return;
      }
      if (!vfs.isDirectory(full)
          || vfs.isSymbolicLink(full)
          || reachable.has(full)) {
        continue;
      }
      if (!consumeGlobCandidate(budget)) {
        localReasons.add('path-candidate-limit');
        return;
      }
      reachable.add(full);
      queue.push(full);
      if (!terminal) output.add(full);
    }
    if (budget.exhaustedReasons.size > 0) return;
  }
}

function readGlobDirectory(
  directory: string,
  vfs: IFS,
  budget: GlobExpansionBudget,
  cache: Map<string, BoundedDirectoryRead>,
): BoundedDirectoryRead {
  const cached = cache.get(directory);
  if (cached) return cached;
  if (budget.directoryScans >= budget.maxDirectoryScans) {
    budget.exhaustedReasons.add('directory-scan-limit');
    return { names: [], complete: false };
  }
  budget.directoryScans++;

  const names = vfs.readdir(directory);
  const remaining = budget.maxVisitedEntries - budget.visitedEntries;
  if (names.length > remaining) {
    const bounded = {
      names: names.slice(0, Math.max(0, remaining)),
      complete: false,
    };
    budget.visitedEntries += bounded.names.length;
    budget.exhaustedReasons.add('visited-entry-limit');
    cache.set(directory, bounded);
    return bounded;
  }

  budget.visitedEntries += names.length;
  const complete = { names, complete: true };
  cache.set(directory, complete);
  return complete;
}

function addGlobPath(
  output: Set<string>,
  value: string,
  terminal: boolean,
  budget: GlobExpansionBudget,
  maxMatches: number,
  reasons: Set<GlobExpansionLimitReason>,
  consumeCandidate = true,
): boolean {
  if (output.has(value)) return true;
  if (terminal) {
    if (output.size >= maxMatches) {
      reasons.add('match-limit');
      return false;
    }
  } else if (consumeCandidate && !consumeGlobCandidate(budget)) {
    reasons.add('path-candidate-limit');
    return false;
  }
  output.add(value);
  return true;
}

function consumeGlobCandidate(budget: GlobExpansionBudget): boolean {
  if (budget.pathCandidates >= budget.maxPathCandidates) {
    budget.exhaustedReasons.add('path-candidate-limit');
    return false;
  }
  budget.pathCandidates++;
  return true;
}

function globExpansionStopped(
  budget: GlobExpansionBudget,
  localReasons: ReadonlySet<GlobExpansionLimitReason>,
): boolean {
  return budget.exhaustedReasons.size > 0 || localReasons.has('match-limit');
}

function boundedGlobLimit(
  value: number | undefined,
  fallback: number,
  allowZero = false,
): number {
  if (value === undefined) return fallback;
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(value) || value < minimum) return fallback;
  return value;
}
