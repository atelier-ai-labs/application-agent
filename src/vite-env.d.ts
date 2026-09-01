/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_NHL_API_BASE_URL?: string;
  readonly VITE_QUANT_API_BASE_URL?: string;
  readonly VITE_REMOTIVE_API_BASE_URL?: string;
  readonly VITE_LEVER_API_BASE_URL?: string;
  /** Comma-separated public Lever SITE identifiers; blank keeps Lever disabled. */
  readonly VITE_LEVER_SITES?: string;
  readonly VITE_GREENHOUSE_API_BASE_URL?: string;
  /** Comma-separated public Greenhouse board tokens; blank keeps Greenhouse disabled. */
  readonly VITE_GREENHOUSE_BOARDS?: string;
  /** Opt into the server-backed bounded Brave reference discovery source. */
  readonly VITE_BROAD_DISCOVERY_ENABLED?: string;
  readonly VITE_EXECUTION_HOST_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
