/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ALLOW_SIM?: string;
  readonly VITE_CORTEX_SIM?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
