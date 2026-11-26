/**
 * A JPEG's outline for tests: its markers as a camera writes them (start of image, an EXIF orientation, a comment,
 * the frame's size and the end), with no picture data. Enough for a PDF to embed it as it is, and for Montra to read
 * its size and orientation; `note` makes each one's bytes its own.
 */
export function jpeg(o: { width: number; height: number; orientation?: number; note?: string }): Uint8Array {
  const parts: number[][] = [[0xff, 0xd8]];
  if (o.orientation) {
    // APP1 "Exif\0\0", a big-endian TIFF header, one IFD entry: Orientation (0x0112), SHORT, 1 value.
    const body = [
      ...Buffer.from('Exif\0\0', 'latin1'),
      ...[0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08],
      ...[0x00, 0x01],
      ...[0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, o.orientation, 0x00, 0x00],
      ...[0x00, 0x00, 0x00, 0x00],
    ];
    parts.push([0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 0xff, ...body]);
  }
  if (o.note) {
    const text = [...Buffer.from(o.note, 'utf8')];
    parts.push([0xff, 0xfe, (text.length + 2) >> 8, (text.length + 2) & 0xff, ...text]);
  }
  parts.push([
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    o.height >> 8,
    o.height & 0xff,
    o.width >> 8,
    o.width & 0xff,
    0x03,
    ...[0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01],
  ]);
  parts.push([0xff, 0xd9]);
  return Uint8Array.from(parts.flat());
}
