import type { ExportRequest, ExportResult } from '@shared/types';

/*
 * PDF export of a generated doc (M06.C). ZERO new dependency: the render is Electron
 * `webContents.printToPDF` against a hidden, locked-down window loading the SAME safe
 * self-contained HTML the "Export HTML" path already builds (sanitized + remote-ref-stripped
 * + CSP'd). printToPDF resolves a `Promise<Buffer>` (web-verified for the current Electron).
 *
 * This module is the Node-testable ORCHESTRATION (render → validate it really is a PDF → save).
 * The BrowserWindow + printToPDF and the save dialog are injected (PdfExportDeps), so the seam
 * runs under Node/Vitest; the real Electron wrappers live in electron/main.ts (coverage-excluded
 * like the other OS seams). The render there writes the HTML to a TEMP FILE and `loadFile`s it
 * (not a data: URL — avoids data-URL length/base-URL quirks on large docs), then unlinks it.
 */

// The printToPDF options. Backgrounds ON (the doc carries its own CSS illustrations) and prefer
// the document's own CSS page size when it declares one. Typed locally so the seam doesn't pull in
// the Electron runtime types under Node.
export interface PdfPrintOptions {
  readonly printBackground: boolean;
  readonly preferCSSPageSize: boolean;
  readonly pageSize: string;
}

export const PDF_OPTIONS: PdfPrintOptions = {
  printBackground: true,
  preferCSSPageSize: true,
  pageSize: 'Letter',
};

export interface PdfExportDeps {
  // Render the assembled HTML to PDF bytes (the hidden-window printToPDF wrapper in main.ts).
  renderHtmlToPdf(html: string, options: PdfPrintOptions): Promise<Buffer>;
  // Write the PDF bytes to a user-chosen path via the save dialog; saved:false on cancel.
  save(defaultName: string, pdf: Buffer): Promise<ExportResult>;
}

// A real PDF always begins with the "%PDF-" magic. Guards against ever writing a non-PDF render
// (e.g. an error page) to a .pdf file.
export function isPdfBuffer(buffer: Buffer): boolean {
  return buffer.length >= 5 && buffer.subarray(0, 5).toString('latin1') === '%PDF-';
}

export async function exportPdf(
  request: ExportRequest,
  deps: PdfExportDeps,
): Promise<ExportResult> {
  const pdf = await deps.renderHtmlToPdf(request.content, PDF_OPTIONS);
  if (!isPdfBuffer(pdf)) {
    throw new Error('pdf-export: render did not produce a PDF');
  }
  return deps.save(request.defaultName, pdf);
}
