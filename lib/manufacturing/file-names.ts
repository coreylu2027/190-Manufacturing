export function safeManufacturingFileName(value: string, fallback: string) {
  const leaf = value.split(/[\\/]/).pop()?.trim() || fallback;
  return leaf.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 240) || fallback;
}

function encodeDispositionFileName(value: string) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function manufacturingContentDisposition(disposition: "inline" | "attachment", fileName: string) {
  const asciiName = fileName
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "_");
  return `${disposition}; filename="${asciiName}"; filename*=UTF-8''${encodeDispositionFileName(fileName)}`;
}
