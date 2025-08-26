export function normalizeCompanyName(name: string): string {
    if (!name) return "";
  
    return name
      .toLowerCase()
      .trim()
      .replace(/\s+/g, " ") // collapse multiple spaces
      .replace(/\b(limited liability company|llc|l\.?l\.?c\.?)\b/g, "llc")
      .replace(/\b(incorporated|inc|i\.?n\.?c\.?)\b/g, "inc")
      .replace(/\b(corporation|corp|c\.?o\.?r\.?p\.?)\b/g, "corp")
      .replace(/\b(limited|ltd|l\.?t\.?d\.?)\b/g, "ltd")
      .replace(/\b(company|co|c\.?o\.?)\b/g, "co")
      .replace(/\bbuilds?\b/g, "build") // normalize builds/build
      .trim();
  }