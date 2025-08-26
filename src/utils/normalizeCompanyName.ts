export function normalizeCompanyName(name: string): string {
    if (!name) return "";
  
    return name
      .toUpperCase()
      .trim()
      // collapse multiple spaces
      .replace(/\s+/g, " ")
      // strip periods/commas (to neutralize differences)
      .replace(/[.,]/g, "")
      // normalize common suffixes
      .replace(/\b(LIMITED LIABILITY COMPANY|L L C|LLC)\b/g, "LLC")
      .replace(/\b(INCORPORATED|INC)\b/g, "INC")
      .replace(/\b(CORPORATION|CORP)\b/g, "CORP")
      .replace(/\b(LIMITED|LTD)\b/g, "LTD")
      .replace(/\b(COMPANY|CO)\b/g, "CO")
      // collapse plural mismatch
      .replace(/\bBUILDS?\b/g, "BUILD")
      .trim();
  }
  