import { describe, expect, it, vi } from 'vitest';

import type { ExportRequest } from '@shared/types';

import { exportPdf, isPdfBuffer, PDF_OPTIONS, type PdfExportDeps } from '../../electron/pdf-export';

/*
 * PDF export of a generated doc (M06.C). ZERO new dependency: the render is Electron
 * `webContents.printToPDF` against a hidden, locked-down window loading the SAME safe
 * self-contained HTML the "Export HTML" path already builds. This module is the
 * Node-testable orchestration (render → validate it really is a PDF → save); the
 * BrowserWindow/printToPDF + save-dialog are injected so the seam runs under Node, and
 * the real Electron wrappers live in main.ts (coverage-excluded like the other OS seams).
 */
const PDF_BYTES = Buffer.from('%PDF-1.4\n…fake pdf bytes…\n%%EOF');
const request: ExportRequest = {
  content: '<html><body><h1>Doc</h1></body></html>',
  defaultName: 'White paper',
};

function deps(overrides: Partial<PdfExportDeps> = {}): PdfExportDeps {
  return {
    renderHtmlToPdf: vi.fn().mockResolvedValue(PDF_BYTES),
    save: vi.fn().mockResolvedValue({ saved: true, path: 'C:/out/White paper.pdf' }),
    ...overrides,
  };
}

describe('isPdfBuffer', () => {
  it('accepts a buffer beginning with the %PDF- magic', () => {
    expect(isPdfBuffer(PDF_BYTES)).toBe(true);
  });
  it('rejects a buffer that is not a PDF (guards against saving garbage)', () => {
    expect(isPdfBuffer(Buffer.from('<html>not a pdf</html>'))).toBe(false);
    expect(isPdfBuffer(Buffer.alloc(0))).toBe(false);
  });
});

describe('PDF_OPTIONS', () => {
  it('prints backgrounds and prefers the doc CSS page size (the doc carries its own styling)', () => {
    expect(PDF_OPTIONS.printBackground).toBe(true);
    expect(PDF_OPTIONS.preferCSSPageSize).toBe(true);
  });
});

describe('exportPdf', () => {
  it('renders the exact assembled HTML then saves the PDF bytes under the suggested name', async () => {
    const d = deps();
    const result = await exportPdf(request, d);
    expect(d.renderHtmlToPdf).toHaveBeenCalledWith(request.content, PDF_OPTIONS);
    expect(d.save).toHaveBeenCalledWith('White paper', PDF_BYTES);
    expect(result).toEqual({ saved: true, path: 'C:/out/White paper.pdf' });
  });

  it('reports saved:false (not an error) when the user cancels the save dialog', async () => {
    const result = await exportPdf(
      request,
      deps({ save: vi.fn().mockResolvedValue({ saved: false }) }),
    );
    expect(result).toEqual({ saved: false });
  });

  it('NEVER writes a non-PDF render to disk (defense: validate the magic before save)', async () => {
    const save = vi.fn();
    const d = deps({
      renderHtmlToPdf: vi.fn().mockResolvedValue(Buffer.from('<html>oops</html>')),
      save,
    });
    await expect(exportPdf(request, d)).rejects.toThrow();
    expect(save).not.toHaveBeenCalled();
  });
});
