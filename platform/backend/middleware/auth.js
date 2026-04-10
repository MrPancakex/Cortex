import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function requireAuth(req, res, next) {
  // Pass-through for now since frontend interacts locally via proxy
  next();
}

export function getAdminToken() {
  try {
    const envPath = path.join(os.homedir(), '.cortex-vault/keys/admin.env');
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf8');
      const match = content.match(/CORTEX_(?:ADMIN_|AGENT_)?TOKEN=(.*)/);
      return match ? match[1].trim() : null;
    }
  } catch (e) {
    return null;
  }
  return null;
}
