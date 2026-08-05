export function powerShellAnalysisEnabled(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32';
}
