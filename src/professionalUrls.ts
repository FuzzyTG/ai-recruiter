import type { ProfessionalUrl, ProfessionalUrlCategory, ProfessionalUrlSource } from './models.js';

const PRIVATE_SOURCE_HOSTS = new Set(['localhost']);
const PRIVATE_SOURCE_SUFFIXES = ['.local', '.internal', '.corp', '.lan', '.home', '.localhost'];
const URL_PATTERN = /https?:\/\/[^\s<>()\[\]{}"']+/gi;

function isPrivateOrInternalUrl(url: string): boolean {
  const parsed = new URL(url);
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return parsed.protocol !== 'https:' && parsed.protocol !== 'http:'
    || PRIVATE_SOURCE_HOSTS.has(hostname)
    || !hostname.includes('.')
    || PRIVATE_SOURCE_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
    || hostname.startsWith('127.')
    || hostname.startsWith('169.254.')
    || hostname === '::1'
    || hostname.startsWith('fc')
    || hostname.startsWith('fd')
    || hostname.startsWith('fe80:')
    || hostname.startsWith('10.')
    || /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname)
    || hostname.startsWith('192.168.');
}

function trimUrl(url: string): string {
  return url.replace(/[\].,;:!?]+$/g, '');
}

function normalizeUrl(url: string): string | null {
  try {
    const parsed = new URL(trimUrl(url));
    if (isPrivateOrInternalUrl(parsed.toString())) return null;
    parsed.hash = '';
    if (parsed.pathname.length > 1) {
      parsed.pathname = parsed.pathname.replace(/\/+$/g, '');
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function classifyUrl(url: string): ProfessionalUrlCategory {
  const parsed = new URL(url);
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === 'github.com' || hostname.endsWith('.github.com')) return 'github';
  if (hostname === 'linkedin.com' || hostname.endsWith('.linkedin.com')) return 'linkedin';
  if (
    hostname === 'medium.com'
    || hostname.endsWith('.medium.com')
    || hostname === 'substack.com'
    || hostname.endsWith('.substack.com')
    || hostname === 'dev.to'
    || hostname.endsWith('.dev.to')
  ) {
    return 'writing';
  }
  return 'portfolio';
}

function appendUrl(
  urls: ProfessionalUrl[],
  seen: Set<string>,
  rawUrl: string,
  source: ProfessionalUrlSource,
): void {
  const url = normalizeUrl(rawUrl);
  if (!url || seen.has(url)) return;
  seen.add(url);
  urls.push({ url, category: classifyUrl(url), source });
}

export function extractProfessionalUrls(input: {
  resumeMarkdown: string;
  portfolioUrls?: string[];
}): ProfessionalUrl[] {
  const urls: ProfessionalUrl[] = [];
  const seen = new Set<string>();

  for (const match of input.resumeMarkdown.matchAll(URL_PATTERN)) {
    appendUrl(urls, seen, match[0], 'resume');
  }

  for (const url of input.portfolioUrls ?? []) {
    appendUrl(urls, seen, url, 'portfolio_urls');
  }

  return urls;
}
