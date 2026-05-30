/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SYMPHONY_DATA_SOURCE?: string;
  readonly VITE_SYMPHONY_API_BASE_URL?: string;
  readonly VITE_SYMPHONY_WEB_BASE_PATH?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module "*.css";
