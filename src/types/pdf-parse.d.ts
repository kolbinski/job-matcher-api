declare module 'pdf-parse' {
  interface PDFParseResult {
    text: string
    numpages: number
    info: unknown
    metadata: unknown
    version: string
  }
  function pdfParse(dataBuffer: Buffer, options?: Record<string, unknown>): Promise<PDFParseResult>
  export default pdfParse
}
