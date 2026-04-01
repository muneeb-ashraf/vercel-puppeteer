export function normalizeCompanyName(name: string): string {
    if (!name) return "";
  
    return name
      .toUpperCase()
      .trim()
      // collapse multiple spaces
      .replace(/\s+/g, " ")
      // strip periods/commas/slashes (to neutralize differences)
      .replace(/[.,\/]/g, "")
      // normalize common suffixes
      .replace(/\b(LIMITED LIABILITY COMPANY|L L C|LLC)\b/g, "LLC")
      .replace(/\b(INCORPORATED|INC)\b/g, "INC")
      .replace(/\b(CORPORATION|CORP)\b/g, "CORP")
      .replace(/\b(LIMITED|LTD)\b/g, "LTD")
      .replace(/\b(COMPANY|CO)\b/g, "CO")
    
      .trim();
  }

export function getAndAmpersandVariant(name: string): string | null {
  if (/ and /i.test(name)) {
    return name.replace(/ and /gi, ' & ');
  }
  if (/ & /.test(name)) {
    return name.replace(/ & /g, ' and ');
  }
  return null;
}