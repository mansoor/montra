/** `subset-font` ships without types: the one call this app makes (ADR-0032). */
declare module 'subset-font' {
  export default function subsetFont(
    font: Uint8Array,
    text: string,
    options?: { targetFormat?: 'sfnt' | 'truetype' | 'woff' | 'woff2'; preserveNameIds?: number[] },
  ): Promise<Buffer>;
}
