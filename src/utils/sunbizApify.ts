type ApifyRunStatus = 'READY' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'ABORTED' | 'TIMED-OUT';

type ApifyRun = {
  id: string;
  status: ApifyRunStatus;
  defaultDatasetId: string;
  statusMessage?: string | null;
};

export type SunbizSearchResult = {
  name: string;
  corporationName: string;
  entityName: string;
  documentNumber: string;
  status: string;
  detailUrl: string | null;
  entityType?: string;
  dateFiled?: string;
};

type NormalizedOfficer = {
  Name: string;
  Title: string;
  Address: string;
};

const APIFY_BASE_URL = 'https://api.apify.com/v2';
const PARSEFORGE_ACTOR_ID = process.env.APIFY_SUNBIZ_ACTOR_ID || 'parseforge~sunbiz-florida-business-scraper';
const AUTH_PERSON_FALLBACK_ACTOR_ID =
  process.env.APIFY_SUNBIZ_AUTH_PERSON_ACTOR_ID || 'rKHKYWNfCUkdkzUs6';

function getApifyToken(): string {
  const token = process.env.APIFY_API_TOKEN;
  if (!token) {
    throw new Error('APIFY_API_TOKEN is not configured');
  }
  return token;
}

function apifyHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

async function parseJsonResponse(response: Response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Apify returned non-JSON response: ${text.slice(0, 300)}`);
  }
}

async function getRun(runId: string, token: string): Promise<ApifyRun> {
  const response = await fetch(`${APIFY_BASE_URL}/actor-runs/${runId}`, {
    headers: apifyHeaders(token),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Apify run status failed (${response.status}): ${body.slice(0, 300)}`);
  }

  const json = await response.json();
  return json.data;
}

async function waitForRun(runId: string, token: string, timeoutMs = 170000): Promise<ApifyRun> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const run = await getRun(runId, token);
    if (!['READY', 'RUNNING'].includes(run.status)) {
      return run;
    }
    await new Promise(resolve => setTimeout(resolve, 2500));
  }

  throw new Error(`Timed out waiting for Apify run ${runId}`);
}

async function getDatasetItems(datasetId: string, token: string): Promise<any[]> {
  const response = await fetch(
    `${APIFY_BASE_URL}/datasets/${datasetId}/items?clean=true&format=json`,
    { headers: apifyHeaders(token) }
  );

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Apify dataset fetch failed (${response.status}): ${body.slice(0, 300)}`);
  }

  const json = await parseJsonResponse(response);
  return Array.isArray(json) ? json : [];
}

export async function runApifyActor(actorId: string, input: Record<string, unknown>, timeoutMs?: number): Promise<any[]> {
  const token = getApifyToken();
  const startResponse = await fetch(`${APIFY_BASE_URL}/actors/${actorId}/runs`, {
    method: 'POST',
    headers: apifyHeaders(token),
    body: JSON.stringify(input),
  });

  if (!startResponse.ok) {
    const body = await startResponse.text().catch(() => '');
    throw new Error(`Apify run start failed (${startResponse.status}): ${body.slice(0, 300)}`);
  }

  const started = await startResponse.json();
  const run: ApifyRun = started.data;
  const completed = await waitForRun(run.id, token, timeoutMs);

  if (completed.status !== 'SUCCEEDED') {
    throw new Error(
      `Apify run ${completed.status}${completed.statusMessage ? `: ${completed.statusMessage}` : ''}`
    );
  }

  return getDatasetItems(completed.defaultDatasetId || run.defaultDatasetId, token);
}

function normalizeStatus(status: unknown): string {
  if (!status) return '';
  const value = String(status).trim();
  if (value.toUpperCase() === 'A') return 'ACTIVE';
  if (value.toUpperCase() === 'I') return 'INACTIVE';
  return value.toUpperCase();
}

function pickString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() && value.trim() !== 'N/A') {
      return value.trim();
    }
  }
  return '';
}

function formatAddress(address: unknown): string {
  if (!address) return '';
  if (typeof address === 'string') return address.trim();

  if (typeof address === 'object') {
    const value = address as Record<string, unknown>;
    const line1 = pickString(value.street, value.address, value.address1, value.line1);
    const line2 = pickString(value.address2, value.line2);
    const city = pickString(value.city);
    const state = pickString(value.state, value.stateCode);
    const zip = pickString(value.zip, value.postalCode);

    const locality = [city, state, zip].filter(Boolean).join(', ').replace(/, ([A-Z]{2}), /, ', $1 ');
    return [line1, line2, locality].filter(Boolean).join(', ');
  }

  return String(address).trim();
}

function normalizeOfficers(...sources: unknown[]): NormalizedOfficer[] {
  const officers: NormalizedOfficer[] = [];

  for (const source of sources) {
    if (!Array.isArray(source)) continue;

    for (const person of source) {
      if (!person || typeof person !== 'object') continue;
      const value = person as Record<string, unknown>;
      const name = pickString(value.Name, value.name, value.officer_name, value.director_name);
      if (!name) continue;

      officers.push({
        Name: name,
        Title: pickString(value.Title, value.title, value.Designation, value.designation, value.position, value.role),
        Address: formatAddress(value.Address || value.address || value.officer_address),
      });
    }
  }

  return officers;
}

export function normalizeParseForgeSearchItem(item: any): SunbizSearchResult | null {
  const name = pickString(item?.corporateName, item?.entityName, item?.name, item?.corporationName);
  const documentNumber = pickString(item?.documentNumber, item?.filingNumber, item?.doc);

  if (!name || !documentNumber) return null;

  return {
    name,
    corporationName: name,
    entityName: name,
    documentNumber,
    status: normalizeStatus(item?.status),
    detailUrl: pickString(item?.detailUrl, item?.url) || null,
    entityType: pickString(item?.corporationType, item?.entityType),
    dateFiled: pickString(item?.dateFiled, item?.filingDate),
  };
}

export function normalizeParseForgeDetail(item: any, extraOfficers: NormalizedOfficer[] = []) {
  const entityName = pickString(item?.corporateName, item?.entityName, item?.name, item?.corporationName);
  const entityType = pickString(item?.corporationType, item?.entityType, item?.filingType);
  const documentNumber = pickString(item?.documentNumber, item?.filingNumber, item?.doc);
  const feiEin = pickString(item?.feiEinNumber, item?.feiEin, item?.feiNumber, item?.ein);
  const dateFiled = pickString(item?.dateFiled, item?.filingDate, item?.fileDate);
  const effectiveDate = pickString(item?.effectiveDate);
  const status = normalizeStatus(item?.status);
  const state = pickString(item?.state, item?.stateCountry) || 'FL';
  const lastEvent = pickString(item?.lastEvent);
  const eventDateFiled = pickString(item?.eventDateFiled);
  const eventEffectiveDate = pickString(item?.eventEffectiveDate);
  const principalAddress = formatAddress(item?.principalAddress);
  const mailingAddress = formatAddress(item?.mailingAddress);
  const registeredAgentName = pickString(item?.registeredAgent?.name, item?.registeredAgentName);
  const registeredAgentAddress = formatAddress(item?.registeredAgent?.address || item?.registeredAgentAddress);
  const officers = [
    ...normalizeOfficers(item?.officers, item?.authorizedPersons, item?.authorized_persons),
    ...extraOfficers,
  ];

  const normalized: Record<string, unknown> = {
    provider: 'apify_parseforge',
    source: 'apify_parseforge',
    entity_name: entityName,
    entity_type: entityType,
    document_number: documentNumber,
    fei_ein: feiEin,
    fei_ein_number: feiEin,
    date_filed: dateFiled,
    filing_date: dateFiled,
    effective_date: effectiveDate,
    state,
    status,
    last_event: lastEvent,
    event_date_filed: eventDateFiled,
    event_effective_date: eventEffectiveDate,
    principal_address: principalAddress,
    principal_address_changed: pickString(item?.principalAddressChanged),
    mailing_address: mailingAddress,
    mailing_address_changed: pickString(item?.mailingAddressChanged),
    registered_agent_name: registeredAgentName,
    registered_agent_address: registeredAgentAddress,
    registered_agent: registeredAgentName,
    registered_agent_changed: pickString(item?.registeredAgent?.nameChanged),
    registered_agent_address_changed: pickString(item?.registeredAgent?.addressChanged),
    officers,
    authorized_persons: officers,
    'Officers/Directors': officers,
    annual_reports: item?.annualReports || [],
    document_images: item?.documentImages || [],
    detail_url: pickString(item?.detailUrl),
    url: pickString(item?.detailUrl),
    scraped_at: pickString(item?.scrapedAt) || new Date().toISOString(),

    'Entity Name': entityName,
    'Entity Type': entityType,
    'Document Number': documentNumber,
    'FEI/EIN Number': feiEin,
    'Date Filed': dateFiled,
    'Effective Date': effectiveDate,
    State: state,
    Status: status,
    'Last Event': lastEvent,
    'Event Date Filed': eventDateFiled,
    'Event Effective Date': eventEffectiveDate,
    'Principal Address': principalAddress,
    'Mailing Address': mailingAddress,
    'Registered Agent Name': registeredAgentName,
    'Registered Agent Address': registeredAgentAddress,
  };

  Object.keys(normalized).forEach(key => {
    const value = normalized[key];
    if (value === '' || value === undefined || value === null) {
      delete normalized[key];
    }
  });

  return normalized;
}

function shouldFetchAuthorizedPersonFallback(normalized: Record<string, unknown>): boolean {
  if (process.env.SUNBIZ_ENABLE_AUTH_PERSON_FALLBACK === 'false') return false;
  const entityType = String(normalized.entity_type || normalized['Entity Type'] || '').toLowerCase();
  const officers = normalized['Officers/Directors'];
  return (
    entityType.includes('limited liability') &&
    (!Array.isArray(officers) || officers.length === 0) &&
    Boolean(normalized.document_number)
  );
}

async function fetchAuthorizedPersons(documentNumber: string, companyName?: string): Promise<NormalizedOfficer[]> {
  const items = await runApifyActor(
    AUTH_PERSON_FALLBACK_ACTOR_ID,
    {
      searchMode: 'documentNumber',
      searchTerms: companyName ? [companyName] : [],
      documentNumbers: [documentNumber],
      maxResults: 1,
    },
    120000
  );

  return normalizeOfficers(items[0]?.authorizedPersons, items[0]?.authorized_persons, items[0]?.officers);
}

export async function searchSunbizWithApify(companyName: string, maxItems = 5): Promise<SunbizSearchResult[]> {
  const items = await runApifyActor(
    PARSEFORGE_ACTOR_ID,
    {
      searchType: 'EntityName',
      searchTerm: companyName,
      maxItems,
      includeDetails: false,
    },
    120000
  );

  return items
    .map(normalizeParseForgeSearchItem)
    .filter((item): item is SunbizSearchResult => Boolean(item));
}

export async function fetchSunbizDetailWithApify(input: {
  companyName?: string;
  documentNumber?: string;
}) {
  const documentNumber = input.documentNumber?.trim();
  const companyName = input.companyName?.trim();

  if (!documentNumber && !companyName) {
    throw new Error('Company name or document number is required');
  }

  const items = await runApifyActor(
    PARSEFORGE_ACTOR_ID,
    {
      searchType: documentNumber ? 'DocumentNumber' : 'EntityName',
      searchTerm: documentNumber || companyName,
      maxItems: 1,
      includeDetails: true,
    },
    170000
  );

  if (!items.length) {
    return null;
  }

  let normalized = normalizeParseForgeDetail(items[0]);

  if (shouldFetchAuthorizedPersonFallback(normalized)) {
    try {
      const extraOfficers = await fetchAuthorizedPersons(String(normalized.document_number), companyName);
      if (extraOfficers.length > 0) {
        normalized = normalizeParseForgeDetail(items[0], extraOfficers);
        normalized.provider_fallback = 'apify_agenscrape_authorized_persons';
      }
    } catch (error) {
      console.warn(
        '[sunbizApify] Authorized-person fallback failed:',
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  return normalized;
}
