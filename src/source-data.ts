export const sourceDataEncoding = "utf-8-base64";

const maxSourceBytes = 10_485_760;
const base64ChunkBytes = 3 * 8_192;
const base64DecodeChunkCharacters = (base64ChunkBytes / 3) * 4;
const maxSourceDataLength = Math.ceil(maxSourceBytes / 3) * 4;

function sourceDataError(): never {
  throw new Error("Invalid source data encoding");
}

function base64Value(character: number): number {
  if (character >= 65 && character <= 90) return character - 65;
  if (character >= 97 && character <= 122) return character - 71;
  if (character >= 48 && character <= 57) return character + 4;
  if (character === 43) return 62;
  if (character === 47) return 63;
  return -1;
}

function binaryString(bytes: Uint8Array): string {
  let binary = "";
  for (let start = 0; start < bytes.length; start += base64ChunkBytes / 3) {
    binary += String.fromCharCode(...bytes.subarray(start, Math.min(start + base64ChunkBytes / 3, bytes.length)));
  }
  return binary;
}

export function encodeSourceData(source: string): string {
  const bytes = new TextEncoder().encode(source);
  const chunks: string[] = [];
  for (let start = 0; start < bytes.length; start += base64ChunkBytes) {
    chunks.push(btoa(binaryString(bytes.subarray(start, Math.min(start + base64ChunkBytes, bytes.length)))));
  }
  return chunks.join("");
}

function decodedByteLength(encoded: string): number {
  if (encoded.length === 0 || encoded.length > maxSourceDataLength || encoded.length % 4 !== 0) sourceDataError();

  const padding = encoded.charCodeAt(encoded.length - 1) === 61
    ? encoded.charCodeAt(encoded.length - 2) === 61 ? 2 : 1
    : 0;
  const dataLength = encoded.length - padding;
  for (let index = 0; index < dataLength; index += 1) {
    if (base64Value(encoded.charCodeAt(index)) < 0) sourceDataError();
  }
  if (padding === 2 && (base64Value(encoded.charCodeAt(dataLength - 1)) & 0x0f) !== 0) sourceDataError();
  if (padding === 1 && (base64Value(encoded.charCodeAt(dataLength - 1)) & 0x03) !== 0) sourceDataError();

  const byteLength = (encoded.length / 4) * 3 - padding;
  if (byteLength > maxSourceBytes) sourceDataError();
  return byteLength;
}

export function decodeSourceData(encoded: string): string {
  decodedByteLength(encoded);

  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const chunks: string[] = [];
  for (let start = 0; start < encoded.length; start += base64DecodeChunkCharacters) {
    const end = Math.min(start + base64DecodeChunkCharacters, encoded.length);
    const binary = atob(encoded.slice(start, end));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    chunks.push(decoder.decode(bytes, { stream: end < encoded.length }));
  }
  chunks.push(decoder.decode());
  return chunks.join("");
}
