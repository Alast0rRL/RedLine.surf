import qrcode from 'qrcode-generator';

/** QR без data URL и innerHTML: один path с чёрными модулями на белом фоне. */
export function QrCode({ value, label = 'QR-код приглашения' }: { value: string; label?: string }) {
  const qr = qrcode(0, 'M');
  qr.addData(value);
  qr.make();
  const count = qr.getModuleCount();
  const total = count + 8; // тихая зона 4 модуля с каждой стороны
  let path = '';
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) path += `M${col + 4} ${row + 4}h1v1h-1z`;
    }
  }
  return (
    <svg
      className="qr-code"
      role="img"
      aria-label={label}
      viewBox={`0 0 ${total} ${total}`}
      shapeRendering="crispEdges"
    >
      <rect width={total} height={total} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
