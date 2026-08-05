// flags.ts — Shell option flags (set -e, -u, -f, -x, etc.)

export interface ShellFlags {
  /** -e: exit on error */
  errexit: boolean;
  /** -u: treat unset variables as error */
  nounset: boolean;
  /** -x: print commands before execution */
  xtrace: boolean;
  /** -f: disable filename expansion (globbing) */
  noglob: boolean;
  /** -n: read commands but do not execute */
  noexec: boolean;
  /** -v: print input lines as read */
  verbose: boolean;
  /** -a: export all variables */
  allexport: boolean;
  /** -b: report background job status immediately */
  notify: boolean;
  /** -h: hash commands */
  hashall: boolean;
  /** -p: privileged mode */
  privileged: boolean;
  /** pipefail: pipeline returns rightmost nonzero status */
  pipefail: boolean;
}

export function default_flags(): ShellFlags {
  return {
    errexit: false,
    nounset: false,
    xtrace: false,
    noglob: false,
    noexec: false,
    verbose: false,
    allexport: false,
    notify: false,
    hashall: true,
    privileged: false,
    pipefail: false,
  };
}

const FLAG_MAP: Record<string, keyof ShellFlags> = {
  'e': 'errexit',
  'u': 'nounset',
  'x': 'xtrace',
  'f': 'noglob',
  'n': 'noexec',
  'v': 'verbose',
  'a': 'allexport',
  'b': 'notify',
  'h': 'hashall',
  'p': 'privileged',
};

/** Apply a `set -X` or `set +X` flag change */
export function apply_set_flag(flags: ShellFlags, char: string, enable: boolean): boolean {
  const key = FLAG_MAP[char];
  if (!key) return false;
  flags[key] = enable;
  return true;
}

/** Apply `set -o name` or `set +o name` */
export function apply_set_option(flags: ShellFlags, name: string, enable: boolean): boolean {
  if (name === 'pipefail') {
    flags.pipefail = enable;
    return true;
  }
  if (name in flags) {
    (flags as unknown as Record<string, boolean>)[name] = enable;
    return true;
  }
  return false;
}
