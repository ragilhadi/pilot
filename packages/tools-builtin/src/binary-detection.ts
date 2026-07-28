import path from "node:path";

/**
 * Extensions treated as binary without reading the file. Extension matching is a fast pre-filter;
 * `isBinaryContent` is the authority for anything not listed here.
 */
const binaryExtensions = new Set([
  ".7z",
  ".avi",
  ".bin",
  ".bmp",
  ".class",
  ".dll",
  ".doc",
  ".docx",
  ".exe",
  ".gif",
  ".gz",
  ".ico",
  ".jar",
  ".jpeg",
  ".jpg",
  ".mov",
  ".mp3",
  ".mp4",
  ".pdf",
  ".png",
  ".so",
  ".tar",
  ".wasm",
  ".webp",
  ".woff",
  ".woff2",
  ".zip",
]);

export function hasBinaryExtension(filePath: string): boolean {
  return binaryExtensions.has(path.extname(filePath).toLocaleLowerCase("en-US"));
}

/** Null bytes, invalid UTF-8, or a high proportion of control characters all mean "not text". */
export function isBinaryContent(sample: Uint8Array): boolean {
  if (sample.includes(0)) {
    return true;
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample);
  } catch {
    return true;
  }
  let suspicious = 0;
  for (const byte of sample) {
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) {
      suspicious += 1;
    }
  }
  return sample.length > 0 && suspicious / sample.length > 0.3;
}
