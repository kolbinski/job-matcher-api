declare module 'html-pdf-node' {
  interface PdfFile {
    content?: string
    url?: string
  }

  interface PdfOptions {
    format?: string
    margin?: { top?: string; bottom?: string; left?: string; right?: string }
    args?: string[]
    [key: string]: unknown
  }

  function generatePdf(file: PdfFile, options: PdfOptions): Promise<Buffer>

  export { generatePdf }
  export default { generatePdf }
}
