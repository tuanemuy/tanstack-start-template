interface ViteTypeOptions {
  strictImportMetaEnv: unknown;
}

interface ImportMetaEnv {
  readonly VITE_DATABASE_PATH: string;
  readonly VITE_STORAGE_ADAPTER?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
