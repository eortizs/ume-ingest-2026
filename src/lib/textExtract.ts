export interface ExtractedText {
  text: string;
  source: 'paste' | 'txt' | 'pdf';
  bytes: number;
  warning?: string;
}

export async function extractTextFromFile(
  file: File,
): Promise<ExtractedText> {
  const name = file.name.toLowerCase();
  const buf = Buffer.from(await file.arrayBuffer());
  if (name.endsWith('.pdf')) {
    const mod = await import('pdf-parse');
    type PdfParse = (
      b: Buffer,
    ) => Promise<{ text: string; numpages: number }>;
    const candidate = mod as unknown as { default?: PdfParse } & PdfParse;
    const pdfParse: PdfParse = candidate.default ?? candidate;
    const out = await pdfParse(buf);
    const text = (out.text ?? '').trim();
    if (!text) {
      return {
        text: '',
        source: 'pdf',
        bytes: buf.length,
        warning: 'No text extracted from PDF (encrypted or image-only?).',
      };
    }
    return { text, source: 'pdf', bytes: buf.length };
  }
  if (name.endsWith('.txt') || name.endsWith('.md')) {
    return {
      text: buf.toString('utf8'),
      source: 'txt',
      bytes: buf.length,
    };
  }
  return {
    text: buf.toString('utf8'),
    source: 'txt',
    bytes: buf.length,
    warning: `Unknown extension; treated as utf8 text.`,
  };
}