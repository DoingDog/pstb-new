export const sourceDataEncoding = "utf-8-base64";

const base64ChunkBytes = 3 * 8_192;
const base64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function binaryString(bytes: Uint8Array): string {
  const characters = new Array<string>(bytes.length);
  for (let index = 0; index < bytes.length; index += 1) {
    characters[index] = String.fromCharCode(bytes[index]!);
  }
  return characters.join("");
}

export function encodeSourceData(source: string): string {
  const bytes = new TextEncoder().encode(source);
  const chunks: string[] = [];
  for (let start = 0; start < bytes.length; start += base64ChunkBytes) {
    chunks.push(btoa(binaryString(bytes.subarray(start, Math.min(start + base64ChunkBytes, bytes.length)))));
  }
  return chunks.join("");
}

export function decodeSourceData(encoded: string): string {
  if (!base64.test(encoded)) throw new Error("Invalid source data encoding");

  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}
