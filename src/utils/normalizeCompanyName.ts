export function normalizeCompanyName(name: string): string {
    if (!name) return "";
  
    let normalized = name
      .trim()
      // collapse multiple spaces
      .replace(/\b(limited liability company|l l c|llc)\b/g, "llc")
      .replace(/\b(incorporated|inc)\b/g, "inc")
      .replace(/\b(corporation|corp)\b/g, "corp")
      .replace(/\b(limited|ltd)\b/g, "ltd")
      .replace(/\b(company|co)\b/g, "co")
  
    // Ensure comma before legal suffixes (if missing)
    normalized = normalized.replace(
      /\s+(llc|inc|corp|ltd|co)\b/g,
      ", $1"
    );
  
    return normalized.trim();
  }
  