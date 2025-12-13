/**
 * XDG-compliant storage paths for Total Recall
 */

import os from 'os';
import path from 'path';

export function getTotalRecallDir(): string {
  if (process.env.TOTALRECALL_CONFIG_DIR) {
    return process.env.TOTALRECALL_CONFIG_DIR;
  }

  const xdgConfigHome = process.env.XDG_CONFIG_HOME;
  if (xdgConfigHome) {
    return path.join(xdgConfigHome, 'totalrecall');
  }

  return path.join(os.homedir(), '.config', 'totalrecall');
}

export function getDbPath(): string {
  if (process.env.TOTALRECALL_DB_PATH) {
    return process.env.TOTALRECALL_DB_PATH;
  }
  return path.join(getTotalRecallDir(), 'synthesis.sqlite');
}
