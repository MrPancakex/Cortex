import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let cachedConfig = null;

export function loadConfig() {
  if (cachedConfig) return cachedConfig;
  
  const defaultPath = path.join(os.homedir(), '.cortexrc.json');
  if (fs.existsSync(defaultPath)) {
    try {
      cachedConfig = JSON.parse(fs.readFileSync(defaultPath, 'utf8'));
      return cachedConfig;
    } catch (e) {
      console.error('Failed to parse .cortexrc.json', e);
    }
  }
  
  cachedConfig = {
    workspace: path.join(os.homedir(), 'Cortex'),
    paths: {
      projects: path.join(os.homedir(), 'Cortex/projects'),
      data: path.join(os.homedir(), 'Cortex/data'),
    },
    ports: {
      backend: 4830,
      gateway: 4840,
      websocket: 4841
    }
  };
  return cachedConfig;
}
