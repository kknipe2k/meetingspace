import type { WindowApi } from '@shared/api';

declare global {
  interface Window {
    readonly api: WindowApi;
  }
}

export {};
