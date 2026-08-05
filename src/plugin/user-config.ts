import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const CONFIG_DIR = '.atuin-shell-guard';
const CONFIG_FILE = 'config.json';
const INSTALLATION_ID = 'installation-id';
const CLOUD_REVIEW = 'cloud-review';

export type CloudReviewSetting = 'yes' | 'no';

export function ensureInstallationConfig(homeDir: string = os.homedir()): boolean {
  return getInstallationId(homeDir) !== null;
}

export function getInstallationId(homeDir: string = os.homedir()): string | null {
  const config = ensureUserConfig(homeDir);
  if (!config) return null;
  const installationId = config[INSTALLATION_ID];
  return typeof installationId === 'string' && installationId.length > 0
    ? installationId
    : null;
}

export function getCloudReviewSetting(
  homeDir: string = os.homedir(),
): CloudReviewSetting | null {
  const config = ensureUserConfig(homeDir);
  if (!config) return null;
  const value = config[CLOUD_REVIEW];
  return value === 'yes' || value === 'no' ? value : null;
}

function ensureUserConfig(homeDir: string): Record<string, unknown> | null {
  try {
    const configDir = path.join(homeDir, CONFIG_DIR);
    const configPath = path.join(configDir, CONFIG_FILE);
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });

    let config: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (!isRecord(parsed)) return null;
      config = parsed;
    } catch (err: unknown) {
      if (!isErrorCode(err, 'ENOENT')) return null;
    }

    let changed = false;
    if (Object.prototype.hasOwnProperty.call(config, INSTALLATION_ID)) {
      const installationId = config[INSTALLATION_ID];
      if (typeof installationId !== 'string' || installationId.length === 0) return null;
    } else {
      config[INSTALLATION_ID] = randomUUID();
      changed = true;
    }

    if (!Object.prototype.hasOwnProperty.call(config, CLOUD_REVIEW)) {
      config[CLOUD_REVIEW] = 'yes';
      changed = true;
    }

    if (changed) {
      fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
    }
    return config;
  } catch {
    // Configuration must never interfere with a hook safety decision.
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isErrorCode(value: unknown, code: string): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value && value.code === code;
}
