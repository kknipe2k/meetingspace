import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';

import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  net,
  safeStorage,
  screen,
  session,
  shell,
  systemPreferences,
} from 'electron';

import type { Asset, ExportRequest, ExportResult, WindowState } from '@shared/types';

import { buildAboutInfo } from './about';
import { createFileSink, createLogger, installConsoleTee } from './logger';
import { registerAssetProtocol, registerAssetScheme } from './asset-protocol';
import { buildAppMenuTemplate, type AppMenuCommands } from './menu';
import { buildContextMenuTemplate } from './context-menu';
import { resolveWindowOptions } from './window-state';
import { nextZoomFactor } from './zoom';
import { APP_CHANNELS, SETTINGS_CHANNELS } from './ipc/channels';
import { ArtifactStore } from './gen/artifact-store';
import type { CorpusImage } from './gen/corpus';
import { createGenerationService } from './gen/generation-service';
import { createInFlightRegistry } from './gen/in-flight-registry';
import { collectRawImages, type RawImage } from './gen/raw-images';
import { TemplateStore } from './gen/template-store';
import { exportPdf, type PdfPrintOptions } from './pdf-export';
import {
  makeThumbnail,
  backfillThumbnails,
  thumbnailAbsolutePath,
  type ThumbnailCodec,
} from './thumbnails';
import { collectBackup, applyBackup, createBackupService } from './backup';
import { registerAssetHandlers } from './ipc/asset-handlers';
import { registerCaptureHandlers } from './ipc/capture-handlers';
import { registerCatalogHandlers } from './ipc/catalog-handlers';
import { registerGenHandlers, type GenIpcService } from './ipc/gen-handlers';
import { registerLlmHandlers } from './ipc/llm-handlers';
import { registerPricingHandlers } from './ipc/pricing-handlers';
import { registerAppExternalHandlers } from './ipc/app-handlers';
import { registerUsageHandlers } from './ipc/usage-handlers';
import type { IpcHandleRegistrar, IpcSyncRegistrar } from './ipc/note-handlers';
import { registerNoteHandlers } from './ipc/note-handlers';
import { registerSearchHandlers } from './ipc/search-handlers';
import { registerSessionHandlers } from './ipc/session-handlers';
import { registerStorageHandlers } from './ipc/storage-handlers';
import { devEnv } from './dev-env';
import { denyWindowOpen, installPermissionHandlers, shouldBlockNavigation } from './window-guards';
import { registerSettingsHandlers } from './ipc/settings-handlers';
import Anthropic from '@anthropic-ai/sdk';
import type { CatalogModel, GatewayModelDiagnosis, ProviderConfig } from '@shared/types';
import {
  accessibleGatewayModels,
  curateGatewayModels,
  gatewayModelProfile,
  maxOutputTokensFor,
  modelLabel,
  normalizeGatewayProfileKey,
  STATIC_CATALOG,
} from '@shared/models';
import { GENERATION_MAX_TOKENS } from '@shared/limits';

import { createAnthropicClient, type AnthropicClientFactory } from './llm/anthropic-client';
import { providerSdkOptions, selectClientFactory } from './llm/provider-config';
import { createModelCatalog } from './llm/model-catalog';
import { diagnoseGatewayModels, GATEWAY_MODEL_TEST_TIMEOUT_MS } from './llm/gateway-diagnostics';
import { createPricingConfig } from './llm/pricing-config';
import { ChatStore } from './storage/chat-store';
import { UsageStore } from './storage/usage-store';
import { createCancelRegistry } from './llm/cancel-registry';
import { createFakeGenerationClient, createFakeStreamingClient } from './llm/fake-streaming-client';
import { createLlmService } from './llm/llm-service';
import { PrefsStore } from './prefs-store';
import { sandboxProbeEnabled } from './sandbox-probe-gate';
import { createCaptureService } from './screen-capture';
import { createFakeCaptureDeps } from './screen-capture-fake';
import { KeyStore } from './secure-store';
import {
  assetsRoot,
  databaseFilePath,
  genTemplatesFilePath,
  keyFilePath,
  prefsFilePath,
  pricingFilePath,
} from './storage/app-paths';
import { backfillAssetSizes } from './storage/asset-backfill';
import { SCHEMA_VERSION } from './storage/schema';
import { AssetStore } from './storage/assets';
import { confinedAssetPath } from './storage/blob-io';
import { closeDatabase, openDatabase } from './storage/db';
import { NoteStore } from './storage/notes';
import { SearchStore } from './storage/search-store';
import { SessionStore } from './storage/sessions';
import { StorageStore } from './storage/storage-store';
import {
  backgroundColorForTheme,
  resolveAppIconPath,
  SECURE_WEB_PREFERENCES,
  WINDOW_DEFAULTS,
} from './window-config';

// A privileged scheme must be registered before the app `ready` event fires.
registerAssetScheme();

// Anthropic vision-supported image types, keyed by file extension. A screenshot
// of an unsupported type is skipped from the generation corpus rather than failing
// the whole request.
const IMAGE_MIME_BY_EXT: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

// Reads a screenshot's bytes for the generation corpus as a base64 image block.
// The on-disk path is resolved through the SAME confinement primitive as the
// asset:// serve path (gotcha §8) — never a raw join — so a malformed relative
// path can't escape the assets root. Returns null for unsupported / unreadable
// assets (the corpus skips them).
function readAssetImage(root: string, asset: Asset): CorpusImage | null {
  const slash = asset.relativePath.indexOf('/');
  const filename = slash >= 0 ? asset.relativePath.slice(slash + 1) : asset.relativePath;
  const mediaType = IMAGE_MIME_BY_EXT[extname(filename).toLowerCase()];
  if (!mediaType) {
    return null;
  }
  const path = confinedAssetPath(root, asset.sessionId, filename);
  if (!path) {
    return null;
  }
  try {
    return { mediaType, data: readFileSync(path).toString('base64') };
  } catch {
    return null;
  }
}

// Reads a screenshot's RAW bytes as a base64 data: URI for inlining in the HTML export
// (M04.D). Unlike the removed M04.C nativeImage path — which decoded many valid
// screenshots to an empty image and silently dropped them (C-14) — this does NO decode
// and NO downscale: the asset's original bytes are read off the SAME confined asset path
// as the corpus reader (gotcha §8) and base64-encoded. (readAssetImage already returns
// {mediaType, base64}; this thin wrapper just renames the field for the export reader.)
// The collectRawImages orchestration is Node-unit-tested; this OS read is the wrapper.
function readRawExportImage(root: string, asset: Asset): RawImage | null {
  const corpusImage = readAssetImage(root, asset);
  return corpusImage ? { mediaType: corpusImage.mediaType, base64: corpusImage.data } : null;
}

// Writes a renderer-assembled export string to a user-chosen path via the OS save
// dialog (M04.D). The renderer already sanitized + assembled the bytes (one sanitizer —
// decision M04.D); main only writes them. A cancelled dialog is reported, not an error.
// Thin OS wrapper (dialog + fs), excluded from coverage like the other OS seams.
async function saveExportFile(
  request: ExportRequest,
  format: 'html' | 'markdown',
): Promise<ExportResult> {
  const ext = format === 'html' ? 'html' : 'md';
  const filterName = format === 'html' ? 'HTML document' : 'Markdown';
  const result = await dialog.showSaveDialog({
    defaultPath: `${request.defaultName}.${ext}`,
    filters: [{ name: filterName, extensions: [ext] }],
  });
  if (result.canceled || !result.filePath) {
    return { saved: false };
  }
  writeFileSync(result.filePath, request.content, 'utf8');
  return { saved: true, path: result.filePath };
}

/*
 * Render the renderer-assembled, ALREADY-SAFE export HTML to PDF via Electron printToPDF (M06.C;
 * no new dependency). The HTML is written to a TEMP FILE and `loadFile`-d (not a data: URL — that
 * avoids data-URL length / base-URL quirks on large docs), in a HIDDEN, locked-down window:
 * sandboxed, no preload, JS disabled (the doc carries no scripts — it is sanitized — and printToPDF
 * needs none), navigation/new-windows denied. The EXPORT_CSP meta in the doc still applies. The
 * temp file is unlinked and the window destroyed on every path. Thin OS wrapper (coverage-excluded
 * like saveExportFile); the orchestration + the %PDF- guard live in the tested pdf-export seam.
 */
async function renderHtmlToPdf(html: string, options: PdfPrintOptions): Promise<Buffer> {
  const tempPath = join(tmpdir(), `meetingspace-export-${randomUUID()}.html`);
  writeFileSync(tempPath, html, 'utf8');
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: false,
    },
  });
  win.webContents.setWindowOpenHandler(denyWindowOpen);
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  try {
    await win.loadFile(tempPath);
    return await win.webContents.printToPDF({
      printBackground: options.printBackground,
      preferCSSPageSize: options.preferCSSPageSize,
      // options.pageSize is one of the named sizes ('Letter'); narrow to Electron's literal union.
      pageSize: options.pageSize as 'Letter',
    });
  } finally {
    if (!win.isDestroyed()) {
      win.destroy();
    }
    try {
      unlinkSync(tempPath);
    } catch {
      // A leftover temp file in the OS temp dir is harmless; never fail the export over cleanup.
    }
  }
}

// Write rendered PDF bytes to a user-chosen path via the save dialog (M06.C). Thin OS wrapper.
async function savePdfFile(defaultName: string, pdf: Buffer): Promise<ExportResult> {
  const result = await dialog.showSaveDialog({
    defaultPath: `${defaultName}.pdf`,
    filters: [{ name: 'PDF document', extensions: ['pdf'] }],
  });
  if (result.canceled || !result.filePath) {
    return { saved: false };
  }
  writeFileSync(result.filePath, pdf);
  return { saved: true, path: result.filePath };
}

/*
 * The real thumbnail codec (M06.C / F25), wrapping Electron nativeImage. `decode` reports the
 * source size + whether the decode produced an EMPTY image (the C-14 failure mode → the generator
 * returns null and the grid keeps full-res). The OS seam excluded from coverage; the resize logic
 * is the Node-tested makeThumbnail.
 */
function nativeImageThumbnailCodec(): ThumbnailCodec {
  return {
    decode: (bytes) => {
      const image = nativeImage.createFromBuffer(Buffer.from(bytes));
      const size = image.getSize();
      return { width: size.width, height: size.height, empty: image.isEmpty() };
    },
    encodeJpeg: (bytes, targetWidth, quality) =>
      nativeImage
        .createFromBuffer(Buffer.from(bytes))
        .resize({ width: targetWidth })
        .toJPEG(quality),
  };
}

// Save a backup container to a user-chosen path via the save dialog (M06.C). Thin OS wrapper.
async function saveBackupFile(
  blob: Buffer,
): Promise<{ saved: true; path: string } | { saved: false }> {
  const result = await dialog.showSaveDialog({
    defaultPath: 'meetingspace-backup.msbackup',
    filters: [{ name: 'MeetingSpace backup', extensions: ['msbackup'] }],
  });
  if (result.canceled || !result.filePath) {
    return { saved: false };
  }
  writeFileSync(result.filePath, blob);
  return { saved: true, path: result.filePath };
}

// Pick a backup file to restore and read its bytes (M06.C). null when the user cancels. Thin OS
// wrapper; the parse + version-check + apply orchestration lives in the tested backup service.
async function openBackupFile(): Promise<Buffer | null> {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'MeetingSpace backup', extensions: ['msbackup'] }],
  });
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  return readFileSync(result.filePaths[0]!);
}

// The destructive-replace confirm before a restore overwrites the current store (M06.C). Thin OS
// wrapper over the message box.
async function confirmRestoreReplace(): Promise<boolean> {
  const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const options = {
    type: 'warning' as const,
    buttons: ['Cancel', 'Replace & restart'],
    defaultId: 0,
    cancelId: 0,
    title: 'Restore from backup',
    message: 'Replace all current data with this backup?',
    detail:
      'This overwrites every session, note, screenshot, and generated document in this app, then restarts it. This cannot be undone.',
  };
  const result = window
    ? await dialog.showMessageBox(window, options)
    : await dialog.showMessageBox(options);
  return result.response === 1;
}

// Persist the window's size/position/maximized to prefs (M06.A; F4). Uses getNormalBounds so a
// maximized/minimized window still records its restorable geometry. Thin wrapper over the
// Node-tested resolveWindowOptions seam (the inverse, restore, side).
function persistWindowState(window: BrowserWindow, prefsStore: PrefsStore): void {
  if (window.isDestroyed()) {
    return;
  }
  const bounds = window.getNormalBounds();
  const state: WindowState = {
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    maximized: window.isMaximized(),
  };
  prefsStore.set({ windowState: state });
}

// Apply a View-menu zoom step to the focused window and persist it (M06.A; F7). The clamp/step
// math is the Node-tested nextZoomFactor seam; this is the webContents wrapper.
function applyZoom(direction: -1 | 0 | 1, prefsStore: PrefsStore): void {
  const window = BrowserWindow.getFocusedWindow();
  if (!window) {
    return;
  }
  const next = nextZoomFactor(window.webContents.getZoomFactor(), direction);
  window.webContents.setZoomFactor(next);
  prefsStore.set({ zoomFactor: next });
}

// Wire the right-click context menu (M06.A; F2). The editFlags→template mapping is the
// Node-tested buildContextMenuTemplate seam; this is the popup wrapper over the OS menu.
function wireContextMenu(window: BrowserWindow): void {
  window.webContents.on('context-menu', (_event, params) => {
    const template = buildContextMenuTemplate(
      {
        isEditable: params.isEditable,
        editFlags: {
          canCut: params.editFlags.canCut,
          canCopy: params.editFlags.canCopy,
          canPaste: params.editFlags.canPaste,
          canSelectAll: params.editFlags.canSelectAll,
        },
        mediaType: params.mediaType,
        dictionarySuggestions: params.dictionarySuggestions,
        selectionText: params.selectionText,
      },
      {
        replaceMisspelling: (word) => window.webContents.replaceMisspelling(word),
        copyImage: () => window.webContents.copyImageAt(params.x, params.y),
      },
    );
    if (template.length > 0) {
      Menu.buildFromTemplate(template).popup({ window });
    }
  });
}

function createMainWindow(prefsStore: PrefsStore): BrowserWindow {
  const savedState = prefsStore.get().windowState;
  const displays = screen.getAllDisplays().map((display) => ({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
  }));
  const window = new BrowserWindow({
    ...WINDOW_DEFAULTS,
    // Restore the saved geometry, validated against the CURRENT displays (an off-all-displays
    // bound snaps back to primary — F4).
    ...resolveWindowOptions(savedState, displays, WINDOW_DEFAULTS),
    show: false,
    // The live window/taskbar icon (M06.E IRL fix). electron-builder brands only the packaged
    // binary; without this both dev and the packaged app's taskbar show the default Electron icon.
    // Resolved for dev vs packaged in the window-config seam; the png ships via extraResources.
    icon: resolveAppIconPath({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
    }),
    // Follow the OS appearance so a dark-mode user gets no white flash before paint (F5).
    backgroundColor: backgroundColorForTheme(nativeTheme.shouldUseDarkColors),
    webPreferences: {
      ...SECURE_WEB_PREFERENCES,
      preload: join(__dirname, '../preload/preload.js'),
    },
  });

  // Security hardening (audit S6-001): the preload exposes the privileged
  // window.api bridge to the top frame, so deny child windows and block any
  // navigation off the app's own page — a remote origin would otherwise inherit
  // the bridge. External links are not opened in-app (notes are escaped text).
  window.webContents.setWindowOpenHandler(denyWindowOpen);
  window.webContents.on('will-navigate', (event, url) => {
    if (shouldBlockNavigation(url, window.webContents.getURL())) {
      event.preventDefault();
    }
  });

  wireContextMenu(window);

  // Forward full-screen state to the renderer (M06.A IRL fix) so it can raise/clear the
  // full-screen exit toast — the menu bar hides in full screen, so the toast is the way out.
  window.on('enter-full-screen', () =>
    window.webContents.send(APP_CHANNELS.fullScreenChange, true),
  );
  window.on('leave-full-screen', () =>
    window.webContents.send(APP_CHANNELS.fullScreenChange, false),
  );

  // Persist size/position (debounced) and on close (F4).
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleSave = (): void => {
    if (saveTimer) {
      clearTimeout(saveTimer);
    }
    saveTimer = setTimeout(() => persistWindowState(window, prefsStore), 400);
  };
  window.on('resize', scheduleSave);
  window.on('move', scheduleSave);
  window.on('close', () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
    }
    persistWindowState(window, prefsStore);
  });

  // Restore the persisted zoom factor once the page is live (F7).
  window.webContents.on('did-finish-load', () => {
    const zoomFactor = prefsStore.get().zoomFactor;
    if (typeof zoomFactor === 'number') {
      window.webContents.setZoomFactor(zoomFactor);
    }
  });

  window.once('ready-to-show', () => {
    if (savedState?.maximized) {
      window.maximize();
    }
    window.show();
  });

  // E2E-only: in probe mode the window loads probe.html — a TEST-ONLY entry with a
  // permissive CSP — and mounts the sandbox probe (raw, unsanitized malicious HTML
  // rendered through the SAME SandboxedHtmlFrame the white paper uses). The
  // permissive CSP removes the inherited-CSP confound so the iframe sandbox is the
  // SOLE control under test (the e2e proves it blocks scripts behaviorally). Gated
  // by sandboxProbeEnabled (flag set AND !app.isPackaged) so it is structurally
  // unreachable in a shipped build; the production entry is always index.html
  // (strict CSP). Mirrors the MEETINGSPACE_FAKE_LLM gate. (Flagged for the Verifier.)
  const sandboxProbe = sandboxProbeEnabled(devEnv('MEETINGSPACE_SANDBOX_PROBE'), app.isPackaged);

  const devServerUrl = devEnv('ELECTRON_RENDERER_URL');
  if (devServerUrl) {
    void window.loadURL(sandboxProbe ? `${devServerUrl}probe.html?probe=1` : devServerUrl);
  } else {
    const entry = sandboxProbe ? 'probe.html' : 'index.html';
    void window.loadFile(join(__dirname, `../renderer/${entry}`), {
      ...(sandboxProbe ? { query: { probe: '1' } } : {}),
    });
  }

  return window;
}

app
  .whenReady()
  .then(() => {
    // Tee main-process console output to a findable on-disk log (M06.E) — Help ▸ Open Logs Folder
    // reveals it. The logger redacts key-shaped tokens before writing (Hard Rule §10). Thin OS
    // wiring; the redact/format/sink logic is the Node-tested electron/logger.ts seam.
    installConsoleTee(
      createLogger(createFileSink(join(app.getPath('logs'), 'main.log')), () => new Date()),
      console,
    );
    // Deny-by-default web permissions on the app session (audit S9-001) — the renderer needs none
    // (capture is main-side desktopCapturer). Thin OS wiring over the tested window-guards seam.
    installPermissionHandlers(session.defaultSession);
    const db = openDatabase(databaseFilePath());
    // Graceful DB shutdown (ADR-0014). `will-quit` fires after all windows have closed —
    // i.e. AFTER the D-03 pagehide `note:updateSync` flush has committed — so the TRUNCATE
    // checkpoint + close never races that write; it just consolidates the WAL and releases
    // the file lock on a clean quit. Thin OS-call wrapper over the tested `closeDatabase`
    // seam (coverage-excluded, same pattern as the other main-process injections).
    app.on('will-quit', () => closeDatabase(db));
    const root = assetsRoot();
    const assetStore = new AssetStore(db, root);
    // One-time, idempotent byte_size backfill (migration v6 / F28): fill any NULL-sized asset rows
    // from disk so the storage meter is a single cheap query. A second run is a no-op.
    backfillAssetSizes(db, root);
    // Thumbnail derivatives (M06.C / F25). The codec wraps Electron nativeImage; it's shared by the
    // on-save hook (new assets) and the startup backfill (existing assets).
    const thumbnailCodec = nativeImageThumbnailCodec();
    // Generate any MISSING thumbnails OFF the launch path (owner: background, non-blocking) so a
    // large existing store doesn't delay first paint. Idempotent — a second launch finds them all.
    setImmediate(() => {
      try {
        const made = backfillThumbnails(db, root, {
          readBytes: (abs) => {
            try {
              return new Uint8Array(readFileSync(abs));
            } catch {
              return null;
            }
          },
          writeThumb: (abs, buf) => writeFileSync(abs, buf),
          makeThumb: (bytes) => makeThumbnail(bytes, thumbnailCodec),
        });
        if (made > 0) {
          console.log(`[thumbnails] backfilled ${made} thumbnail(s)`);
        }
      } catch (error) {
        console.error('[thumbnails] backfill failed (non-fatal):', error);
      }
    });
    const registrar: IpcHandleRegistrar & IpcSyncRegistrar = {
      handle: (channel, handler) => ipcMain.handle(channel, handler),
      // Sync IPC for the D-03 teardown flush (note:updateSync). The handler sets
      // event.returnValue; ipcMain.on delivers it to the renderer's sendSync.
      on: (channel, handler) => ipcMain.on(channel, handler),
    };
    registerSessionHandlers(registrar, new SessionStore(db), {
      // FK cascade drops the asset rows; remove the blob files too (orphan safety).
      afterSessionDelete: (id) => assetStore.removeSessionAssets(id),
      // Bulk delete (M06.B): a per-session blob-cleanup failure must not half-abort the loop — the
      // rows are already committed. Log it; a leftover dir is a soft orphan, not data loss.
      onCleanupError: (id, error) =>
        console.error(`[session:deleteMany] blob cleanup failed for ${id}:`, error),
    });
    // Full backup/restore (M06.C). The container build/parse/version-check + collect/apply are the
    // tested seams; the dialogs, app.relaunch, and DB close are the OS deps injected here. Restore
    // closes the DB (releases the Windows file lock) BEFORE swapping the files, then relaunches.
    const backupService = createBackupService({
      collect: () =>
        collectBackup({
          db,
          dbFilePath: databaseFilePath(),
          assetsRoot: root,
          appVersion: app.getVersion(),
        }),
      save: (blob) => saveBackupFile(blob),
      pickFile: () => openBackupFile(),
      confirmReplace: () => confirmRestoreReplace(),
      apply: (parsed) =>
        applyBackup({ targetDbFilePath: databaseFilePath(), targetAssetsRoot: root, parsed }),
      closeDb: () => closeDatabase(db),
      currentSchemaVersion: SCHEMA_VERSION,
      // The restart branch is decided + sequenced in the tested service; these are the thin OS
      // wrappers it calls. `app.quit()` (not exit) lets the will-quit handler run its checkpoint
      // close (now idempotent) so the native module + file handle release cleanly — one exit, no
      // zombie. In dev we NEVER call relaunch() (the electron-vite zombie source) — we prompt.
      isPackaged: app.isPackaged,
      relaunch: () => app.relaunch(),
      quit: () => app.quit(),
      notifyRestart: () =>
        dialog.showMessageBoxSync({
          type: 'info',
          title: 'Restore complete',
          message: 'Restored — please restart the app.',
          detail:
            'MeetingSpace will now close. Start it again (npm run dev) to open the restored data.',
        }),
    });
    registerStorageHandlers(registrar, new StorageStore(db), backupService);
    const noteStore = new NoteStore(db);
    registerNoteHandlers(registrar, noteStore);
    // Generate a sibling thumbnail derivative on every successful save (M06.C / F25). A failure
    // never fails the save (asset-handlers guards it) — the grid falls back to full-res.
    registerAssetHandlers(registrar, assetStore, (asset, bytes) => {
      const thumbAbs = thumbnailAbsolutePath(root, asset.sessionId, asset.relativePath);
      if (!thumbAbs) {
        return;
      }
      const thumb = makeThumbnail(bytes, thumbnailCodec);
      if (thumb) {
        writeFileSync(thumbAbs, thumb);
      }
    });
    // Inject the real Electron safeStorage (the OS credential vault) into the
    // Node-tested KeyStore — this construction is the only uncovered wrapper. The
    // key is encrypted here and never reaches the renderer; getKeyForMain() is read
    // only by the main-process SDK call (no IPC channel).
    const keyStore = new KeyStore(safeStorage, keyFilePath());
    const prefsStore = new PrefsStore(prefsFilePath());
    // E2E onboarding isolation (M06.E): the existing Playwright suite launches against a fresh
    // userData (MEETINGSPACE_USER_DATA), which would otherwise trip the first-run overlay and gate
    // every spec. When that override is present we mark onboarding already-seen so the suite runs
    // the main surface; the dedicated onboarding spec opts back in with MEETINGSPACE_FIRST_RUN=1.
    // Both env reads go through the !app.isPackaged-gated devEnv accessor, so a packaged build
    // never honors them and a real first run always sees onboarding.
    if (devEnv('MEETINGSPACE_USER_DATA') && devEnv('MEETINGSPACE_FIRST_RUN') !== '1') {
      prefsStore.set({ onboardingSeen: true });
    }
    registerSettingsHandlers(registrar, keyStore, prefsStore);
    // M07.D provider switch (REVIEW-V11 F19): the active provider is read from prefs PER CALL,
    // so switching anthropic↔gateway in Settings takes effect on the next chat/generation with
    // no restart. selectClientFactory re-routes the gateway path (baseURL + bearer, apiKey null);
    // the credential reader fetches the ACTIVE provider's secret (anthropic-key.enc vs
    // gateway-credential.enc). Both the chat AND generation services share this seam.
    const readProvider = () => prefsStore.get().provider ?? ({ provider: 'anthropic' } as const);
    const providerKeyReader = {
      getKeyForMain: () => keyStore.getKeyForMain(readProvider().provider),
    };

    // Gateway networking via Electron's Chromium stack (net.fetch). Unlike Node's fetch (minimal
    // proxy support), net.fetch follows the OS proxy configuration (incl. PAC/WPAD) and supports
    // Basic/Digest/NTLM/Kerberos/Negotiate proxy auth + the OS certificate store. We keep the default
    // session's proxy in sync with the gateway's configured proxyUrl (system proxy when none set),
    // then route the gateway SDK calls (chat, generation, ping) through net.fetch.
    let appliedProxyRules: string | null = null;
    const ensureGatewayProxy = async (): Promise<void> => {
      const provider = readProvider();
      const rules = provider.provider === 'gateway' && provider.proxyUrl ? provider.proxyUrl : '';
      if (rules !== appliedProxyRules) {
        appliedProxyRules = rules;
        await session.defaultSession.setProxy(rules ? { proxyRules: rules } : { mode: 'system' });
      }
    };
    const netFetch = ((input: unknown, init?: unknown) =>
      ensureGatewayProxy().then(() =>
        net.fetch(
          input as Parameters<typeof net.fetch>[0],
          init as Parameters<typeof net.fetch>[1],
        ),
      )) as unknown as typeof globalThis.fetch;
    const providerClientFactory: AnthropicClientFactory = (options) => {
      const provider = readProvider();
      const withGatewayFetch =
        provider.provider === 'gateway' ? { ...options, fetch: netFetch } : options;
      return selectClientFactory(provider, createAnthropicClient)(withGatewayFetch);
    };

    // Gateway connectivity check (Settings ▸ Test connection). Routes through net.fetch like the
    // chat/generation gateway calls, so it exercises the real proxy + auth + cert path.
    registrar.handle(SETTINGS_CHANNELS.pingGateway, async () => {
      const provider = readProvider();
      if (provider.provider !== 'gateway') {
        return { ok: false, error: 'Not configured as gateway provider.' };
      }
      const credential = providerKeyReader.getKeyForMain();
      if (!credential) {
        return { ok: false, error: 'No gateway token saved. Save a token first.' };
      }
      try {
        const opts = providerSdkOptions(provider, credential);
        const pingClient = new Anthropic({
          apiKey: opts.apiKey,
          ...(opts.authToken != null ? { authToken: opts.authToken } : {}),
          ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
          maxRetries: 0,
          timeout: GATEWAY_MODEL_TEST_TIMEOUT_MS,
          fetch: netFetch,
        });
        await pingClient.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        });
        return { ok: true };
      } catch (error) {
        const status = (error as { status?: number } | null)?.status;
        const msg = (error as { message?: string } | null)?.message ?? String(error);
        return { ok: false, error: status ? `HTTP ${status}: ${msg}` : msg };
      }
    });

    // M06.D persistence + counters. ChatStore persists the conversation (ADR-0020); the pricing
    // config drives cost (ADR-0021, updatable file); the UsageStore records real usage and rolls
    // it up (cost computed at read time from the config). None of these touch the key.
    const chatStore = new ChatStore(db);
    const pricingConfig = createPricingConfig(pricingFilePath());
    const usageStore = new UsageStore(db, { priceFor: (model) => pricingConfig.priceFor(model) });

    // The dynamic model catalog (ADR-0021; closes F22/TD-012). Direct Anthropic reads /v1/models.
    // Gateways use their persisted URL-scoped profile so opening a picker never causes network or
    // billable diagnostic traffic; Settings owns the explicit list refresh and model tests.
    const GATEWAY_MODELS: CatalogModel[] = [
      { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', maxOutputTokens: 64e3 },
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', maxOutputTokens: 64e3 },
    ];
    const fetchServedModels = async (provider: ProviderConfig): Promise<CatalogModel[]> => {
      const credential = keyStore.getKeyForMain(provider.provider);
      const opts = providerSdkOptions(provider, credential);
      const client = new Anthropic({
        apiKey: opts.apiKey,
        ...(opts.authToken != null ? { authToken: opts.authToken } : {}),
        ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
        // Route the gateway's models query through the SAME Chromium/proxy stack as chat + ping
        // (net.fetch) — a bare Node fetch would bypass the corp proxy and fail. maxRetries 0 keeps a
        // missing /v1/models from stalling an explicit Settings refresh on SDK backoff.
        ...(provider.provider === 'gateway'
          ? { fetch: netFetch, maxRetries: 0, timeout: GATEWAY_MODEL_TEST_TIMEOUT_MS }
          : {}),
      });
      const fetchModels = async (): Promise<CatalogModel[]> => {
        const page = (await client.models.list()) as { data?: unknown[] };
        return (page.data ?? []).map((entry): CatalogModel => {
          const raw = entry as { id: string; display_name?: string; max_tokens?: number };
          return {
            id: raw.id,
            label: raw.display_name ?? modelLabel(raw.id),
            maxOutputTokens: raw.max_tokens ?? maxOutputTokensFor(raw.id) ?? GENERATION_MAX_TOKENS,
          };
        });
      };
      return fetchModels();
    };

    // Gateway pickers are local after setup: use the persisted, URL-scoped profile and never probe or
    // list models just because a picker opened. The explicit Settings refresh updates this profile.
    const configuredGatewayModels = (
      provider: Extract<ProviderConfig, { provider: 'gateway' }>,
    ): CatalogModel[] => {
      const profile = gatewayModelProfile(prefsStore.get(), provider.baseURL);
      const knownModels = profile.models.length > 0 ? profile.models : GATEWAY_MODELS;
      // Hide any id the diagnostics proved is substituted before curation, so a model the gateway
      // silently swaps never reaches the chat/generation dropdowns.
      return curateGatewayModels(
        accessibleGatewayModels(knownModels, profile.verifications),
        profile.curatedModelIds,
      );
    };
    const listModels = async (provider: ProviderConfig): Promise<CatalogModel[]> =>
      provider.provider === 'anthropic'
        ? fetchServedModels(provider)
        : configuredGatewayModels(provider);

    // Gateway diagnostics (curated picker, Settings). `listGatewayModels` returns the FULL advertised
    // set (uncurated) for the panel to choose from; `diagnoseGatewayModels` pings each chosen id and
    // reports the model the gateway ACTUALLY serves — exposing a substitution (you ask for Sonnet, it
    // serves 3.5 Sonnet) before you commit. Both route through net.fetch (the corp proxy path) and
    // read the credential per call; the token never crosses back. Gateway-only.
    registrar.handle(SETTINGS_CHANNELS.listGatewayModels, async () => {
      const provider = readProvider();
      if (provider.provider !== 'gateway') {
        return [] as CatalogModel[];
      }
      const models = await fetchServedModels(provider);
      if (models.length === 0) {
        throw new Error('The gateway returned an empty model list.');
      }
      return models;
    });
    registrar.handle(SETTINGS_CHANNELS.diagnoseGatewayModels, async (_event, raw) => {
      const ids = Array.isArray(raw)
        ? raw.filter((value): value is string => typeof value === 'string')
        : [];
      const provider = readProvider();
      if (provider.provider !== 'gateway' || ids.length === 0) {
        return [] as GatewayModelDiagnosis[];
      }
      const credential = providerKeyReader.getKeyForMain();
      if (!credential) {
        const testedAt = Date.now();
        return ids.map(
          (id): GatewayModelDiagnosis => ({
            id,
            served: null,
            ok: false,
            status: 'unavailable',
            testedAt,
            error: 'No gateway token saved.',
          }),
        );
      }
      const opts = providerSdkOptions(provider, credential);
      const probe = new Anthropic({
        apiKey: opts.apiKey,
        ...(opts.authToken != null ? { authToken: opts.authToken } : {}),
        ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
        maxRetries: 0,
        timeout: GATEWAY_MODEL_TEST_TIMEOUT_MS,
        fetch: netFetch,
      });
      // Probe with a STREAMING request carrying real content — the same shape chat uses — because a
      // corporate governance layer only redirects streaming requests with content. A non-streaming
      // max_tokens:1 "ping" slips past that redirect and falsely reports a substituted model (e.g.
      // Opus → Sonnet) as available. finalMessage().model is the id the gateway ACTUALLY served.
      return diagnoseGatewayModels(ids, async (id, signal) => {
        const stream = probe.messages.stream(
          {
            model: id,
            max_tokens: 16,
            messages: [{ role: 'user', content: 'hi' }],
          },
          { signal },
        );
        const final = await stream.finalMessage();
        return final.model;
      });
    });
    // Main-process-only Anthropic path (M03.B; M03.C grounds it in the session's
    // notes via noteStore). The service reads the key via keyStore.getKeyForMain()
    // per call and streams over typed IPC; the renderer never sees the key or the
    // SDK. The default global fetch is used in prod; tests inject a fake fetch into
    // createAnthropicClient.
    //
    // E2E seam (M03.C): when MEETINGSPACE_FAKE_LLM=1 AND the build is UNPACKAGED, the
    // chat e2e runs against a canned-stream client + a FAKE key reader — so it never
    // touches the real KeyStore, the SDK, or the network. The `!app.isPackaged` gate
    // makes this path structurally unreachable in a shipped build, so it can neither
    // read nor expose the user's real key. (Flagged for the Verifier security pass.)
    const fakeLlm = devEnv('MEETINGSPACE_FAKE_LLM') === '1' && !app.isPackaged;

    // The catalog uses the real lister in production; in FAKE_LLM mode it rejects so the catalog
    // stays the deterministic static list (no network in the e2e). Warmed once at startup (non-
    // blocking) in production so the model-aware generation cap reads live ceilings.
    const modelCatalog = createModelCatalog({
      getContext: () => {
        const provider = readProvider();
        return {
          key:
            provider.provider === 'gateway'
              ? `gateway:${normalizeGatewayProfileKey(provider.baseURL)}`
              : 'anthropic',
          fallback:
            provider.provider === 'gateway' ? configuredGatewayModels(provider) : STATIC_CATALOG,
          listModels: fakeLlm
            ? () => Promise.reject(new Error('fake-llm: static catalog'))
            : () => listModels(provider),
        };
      },
    });
    if (!fakeLlm) {
      void modelCatalog.list();
    }

    // Audit S3-001: validate the renderer-supplied model against the LIVE catalog main-side (the
    // service defaults to the static floor; this widens it to live-fetched models). An unknown/
    // forged id is defaulted before it reaches the SDK `model` field.
    const isKnownModel = (model: string): boolean => modelCatalog.isKnownModel(model);

    registerLlmHandlers(
      registrar,
      fakeLlm
        ? createLlmService({
            keyStore: { getKeyForMain: () => 'sk-ant-e2e-fake' },
            clientFactory: createFakeStreamingClient,
            notes: noteStore,
            chat: chatStore,
            usage: usageStore,
            isKnownModel,
          })
        : createLlmService({
            keyStore: providerKeyReader,
            clientFactory: providerClientFactory,
            notes: noteStore,
            chat: chatStore,
            usage: usageStore,
            isKnownModel,
          }),
      // SEPARATE cancel registries per streaming domain (M07.A; F11) so a gen:cancel can
      // never abort a chat stream and vice versa.
      createCancelRegistry(),
    );
    // Document generation (M04.A). Reuses the M03 main-only SDK path (no second SDK
    // surface): the generation service reads the key per call, assembles the session
    // corpus (notes as text via noteStore, screenshots as base64 image blocks read
    // through the confined asset path), streams Part 1 (FOCUS doc), and persists it
    // to the documents table (artifactStore). Templates live in a userData JSON file
    // (templateStore) — never SQLite, never the key. The same MEETINGSPACE_FAKE_LLM
    // + unpackaged gate as chat lets the generation IRL/e2e run with no real key,
    // SDK, or network.
    const templateStore = new TemplateStore(genTemplatesFilePath());
    const artifactStore = new ArtifactStore(db);
    const assetReader = {
      listAssets: (sessionId: string) => assetStore.listAssets(sessionId),
      readImage: (asset: Asset) => readAssetImage(root, asset),
    };
    // M07.B e2e seam: optionally hold each fake generation stream open so the app-level run
    // toast's live window is observable across a modal close (the toast-survives-close repro).
    // 0/unset keeps the synchronous fake. Read here (Electron context) via the gated accessor.
    const fakeGenDelayMs = Number(devEnv('MEETINGSPACE_FAKE_GEN_DELAY_MS') ?? '0');
    // M07.C fix #4 e2e seam: 'css' makes the fake's CSS route fail validation, so the
    // failure-surfaces e2e can pin the modal alert + the app-level error toast.
    const fakeGenFailMode = devEnv('MEETINGSPACE_FAKE_GEN_FAIL') ?? '';
    // The model-aware generation cap (ADR-0021): resolve the LIVE per-model ceiling off the catalog
    // cache, with the static seed as the offline fallback. For every current model the live value
    // equals the static seed, so the resolved cap is unchanged — this only guards a future sub-32K
    // or gateway-presented model from a max_tokens overrun.
    const modelMaxTokens = (model: string): number | null =>
      modelCatalog.cachedMaxTokens(model) ?? maxOutputTokensFor(model);
    const generationService = fakeLlm
      ? createGenerationService({
          keyStore: { getKeyForMain: () => 'sk-ant-e2e-fake' },
          // The gen fake emits canned FOCUS text (Part 1) and script-bearing HTML
          // (Part 2) so the e2e exercises the real sanitize + sandbox path.
          clientFactory: () => createFakeGenerationClient(fakeGenDelayMs, fakeGenFailMode),
          templates: templateStore,
          notes: noteStore,
          assets: assetReader,
          artifacts: artifactStore,
          modelMaxTokens,
          isKnownModel,
          usage: usageStore,
        })
      : createGenerationService({
          keyStore: providerKeyReader,
          clientFactory: providerClientFactory,
          templates: templateStore,
          notes: noteStore,
          assets: assetReader,
          artifacts: artifactStore,
          modelMaxTokens,
          isKnownModel,
          usage: usageStore,
        });
    const genIpc: GenIpcService = {
      generateFocus: (request, handlers) => generationService.generateFocus(request, handlers),
      generateWhitepaper: (request, handlers) =>
        generationService.generateWhitepaper(request, handlers),
      generateMinutes: (request, handlers) => generationService.generateMinutes(request, handlers),
      buildRawDoc: (sessionId) => generationService.buildRawDoc(sessionId),
      // M04.D export: raw-bytes screenshot acquisition (no nativeImage decode — C-14
      // resolved) for the renderer to inline, plus the save-dialog file write.
      exportImages: (sessionId) =>
        collectRawImages(
          {
            listAssets: (sid) => assetStore.listAssets(sid),
            readRawImage: (asset) => readRawExportImage(root, asset),
          },
          sessionId,
        ),
      exportHtml: (request) => saveExportFile(request, 'html'),
      exportMarkdown: (request) => saveExportFile(request, 'markdown'),
      // M06.C: render the SAME assembled self-contained HTML to PDF via printToPDF (no new dep).
      exportPdf: (request) => exportPdf(request, { renderHtmlToPdf, save: savePdfFile }),
      listTemplates: () => templateStore.listTemplates(),
      saveTemplate: (parts) => templateStore.saveTemplate(parts),
      updateTemplate: (id, parts) => templateStore.updateTemplate(id, parts),
      getTemplate: (id) => templateStore.getTemplate(id),
      deleteTemplate: (id) => templateStore.deleteTemplate(id),
      getArtifacts: (sessionId) => artifactStore.getArtifacts(sessionId),
      // M07.B (F16): latest-per-kind for the modal's mount fetch.
      getLatestArtifacts: (sessionId) => artifactStore.getLatestArtifacts(sessionId),
    };
    // M07.B (F12): the truthful-modal main side — a per-session in-flight registry (gen:status
    // reattach source) and a window broadcast for gen:artifact-saved so an open modal refreshes
    // its slot the moment a background run persists. Generation decouples from the modal, so the
    // run keeps streaming after a close; these let the renderer rediscover its state on reopen.
    const broadcastToWindows = (channel: string, payload: unknown): void => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send(channel, payload);
        }
      }
    };
    registerGenHandlers(registrar, genIpc, createCancelRegistry(), {
      inFlight: createInFlightRegistry(),
      broadcast: broadcastToWindows,
      // Name the run toast by the template driving it (Default or a user template).
      resolveTemplateName: (templateId) =>
        templateStore.getTemplate(templateId ?? 'default')?.name ?? 'Default',
    });
    // Cross-session full-text search (M04.D). SearchStore reads the v4 FTS5 indexes over
    // the same db handle; no key, no SDK, no network — purely a read over local content.
    registerSearchHandlers(registrar, new SearchStore(db));

    // M06.D: the dynamic catalog + passive usage surfaces. The catalog list/refresh fail soft to
    // the static list (never empty); the usage summary/pricing are plain reads — no key crosses.
    registerCatalogHandlers(registrar, {
      list: () => modelCatalog.list(),
      refresh: () => modelCatalog.refresh(),
    });
    registerUsageHandlers(registrar, {
      summary: (sessionId) => usageStore.summary(sessionId),
      // M10.A (ADR-0027): the pricing read now carries priced + unpriced. Unpriced = the active
      // provider's catalog models with no config price (prefix-aware), so Settings can prompt the
      // user to set one. Reads the live catalog (fails soft to the static list — never empty).
      pricing: async () => ({
        priced: pricingConfig.entries(),
        unpriced: pricingConfig.unpricedModels(await modelCatalog.list()),
      }),
    });
    // M10.A (ADR-0027): the in-app price-override WRITE channel. Validates main-side, persists a
    // user override atomically, and reprices the live UsageStore closure with no restart.
    registerPricingHandlers(registrar, {
      update: (model, price) => pricingConfig.updatePrice(model, price),
      // M10.B (§10): drop a user override — reverts a seed model to its seed price, returns a
      // non-seed model to unpriced, repricing the live UsageStore closure with no restart.
      delete: (model) => pricingConfig.removePrice(model),
    });
    // Inject the real Electron screen-capture OS calls into the (Node-tested)
    // capture service — this wiring is the only uncovered line of the seam. The
    // MEETINGSPACE_FAKE_CAPTURE seam (unpackaged only; mirrors the FAKE_LLM gate)
    // swaps in deterministic canned sources for the TD-008 picker visual baseline.
    const fakeCapture = devEnv('MEETINGSPACE_FAKE_CAPTURE') === '1' && !app.isPackaged;
    registerCaptureHandlers(
      registrar,
      createCaptureService(
        fakeCapture
          ? createFakeCaptureDeps()
          : {
              getSources: (options) =>
                desktopCapturer.getSources({
                  types: [...options.types] as ('screen' | 'window')[],
                  thumbnailSize: options.thumbnailSize,
                }),
              getMediaAccessStatus: (mediaType) =>
                systemPreferences.getMediaAccessStatus(mediaType),
              getDisplays: () =>
                screen.getAllDisplays().map((display) => ({
                  id: display.id,
                  size: display.size,
                  scaleFactor: display.scaleFactor,
                })),
              platform: process.platform,
            },
      ),
    );
    registerAssetProtocol(root);

    // Native application menu (M06.A; F1/F30) — built in the SAME change that replaces the
    // default menu, so the macOS clipboard accelerators the default provided are preserved;
    // DevTools/Reload are omitted in packaged builds. Find / New Session forward to the
    // renderer over app:command (the renderer also owns the Ctrl/Cmd+F / +N keypress).
    const menuCommands: AppMenuCommands = {
      newSession: () =>
        BrowserWindow.getFocusedWindow()?.webContents.send(APP_CHANNELS.command, 'new-session'),
      focusSearch: () =>
        BrowserWindow.getFocusedWindow()?.webContents.send(APP_CHANNELS.command, 'find'),
      zoomIn: () => applyZoom(1, prefsStore),
      zoomOut: () => applyZoom(-1, prefsStore),
      zoomReset: () => applyZoom(0, prefsStore),
      setTheme: (preference) =>
        BrowserWindow.getFocusedWindow()?.webContents.send(
          APP_CHANNELS.command,
          `theme:${preference}`,
        ),
      // M06.E Help menu. About shows the version + AI-disclosure (no update affordance — ADR-0023);
      // Open Logs Folder reveals app.getPath('logs') where main.log is teed. Thin OS wrappers; the
      // About content is the Node-tested buildAboutInfo seam.
      showAbout: () => {
        const about = buildAboutInfo(app.getVersion());
        const window = BrowserWindow.getFocusedWindow();
        const options = { type: 'info' as const, ...about };
        if (window) {
          void dialog.showMessageBox(window, options);
        } else {
          void dialog.showMessageBox(options);
        }
      },
      openLogs: () => void shell.openPath(app.getPath('logs')),
    };
    // Renderer→main: leave full screen (the toast's Exit control).
    registrar.handle(APP_CHANNELS.exitFullScreen, () => {
      BrowserWindow.getFocusedWindow()?.setFullScreen(false);
    });
    // M10.B ext#2: open the Anthropic pricing docs in the OS browser (argument-less; the handler
    // opens the hardcoded constant, never a renderer-supplied URL — deny-all window policy stands).
    registerAppExternalHandlers(registrar, { openExternal: (url) => void shell.openExternal(url) });
    Menu.setApplicationMenu(
      Menu.buildFromTemplate(
        buildAppMenuTemplate({
          platform: process.platform,
          isPackaged: app.isPackaged,
          commands: menuCommands,
        }),
      ),
    );

    createMainWindow(prefsStore);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow(prefsStore);
      }
    });
  })
  .catch((error: unknown) => {
    console.error('main: failed to start', error);
    app.quit();
  });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
