export function toPosixForPolicy(path: string): string {
  if (!path || typeof path !== 'string') return '';
  const match = /^([A-Za-z]):([\\/].*)?$/.exec(path);
  if (match) {
    const rest = (match[2] || '').replace(/\\/g, '/');
    return (`/${match[1]}${rest}`).toLowerCase();
  }
  return path.replace(/\\/g, '/').toLowerCase();
}

export function isCatastrophicPath(path: string, platform: string = process.platform): boolean {
  const normalized = toPosixForPolicy(path);
  if (normalized === '/' || normalized === '/*') return true;
  if (platform !== 'win32') return false;
  return /^\/[a-z]$/.test(normalized)
    || /^\/[a-z]\/$/.test(normalized)
    || /^\/[a-z]\/\*$/.test(normalized);
}

export function isSystemPath(path: string, platform: string = process.platform): boolean {
  const normalized = toPosixForPolicy(path);
  if (platform === 'darwin') {
    return hasPathPrefix(normalized, '/system') || hasPathPrefix(normalized, '/library');
  }
  if (platform === 'win32') {
    const drive = windowsSystemDrive();
    return hasPathPrefix(normalized, `${drive}/windows`)
      || hasPathPrefix(normalized, `${drive}/program files`)
      || hasPathPrefix(normalized, `${drive}/program files (x86)`)
      || hasPathPrefix(normalized, `${drive}/programdata`);
  }
  return false;
}

export function isUnresolvedCatastrophicDelete(path: string, platform: string = process.platform): boolean {
  return isCatastrophicPath(path, platform);
}

function hasPathPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function windowsSystemDrive(): string {
  const configured = process.env['SystemDrive']
    || process.env['SYSTEMDRIVE']
    || process.env['SystemRoot']
    || process.env['SYSTEMROOT']
    || process.env['windir']
    || process.env['WINDIR']
    || 'C:';
  const normalized = toPosixForPolicy(configured);
  const match = /^\/([a-z])(?:\/|$)/.exec(normalized);
  return match ? `/${match[1]}` : '/c';
}
