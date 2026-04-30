import type { ResearchCard, ResearchClaimType } from './models.js';

export const RESEARCH_CLAIM_TYPES = [
  'project',
  'public_profile',
  'writing',
  'talk',
  'publication',
  'company_context',
  'other',
] as const satisfies readonly ResearchClaimType[];

const RESEARCH_CLAIM_TYPE_SET = new Set<string>(RESEARCH_CLAIM_TYPES);
const PRIVATE_SOURCE_HOSTS = new Set(['localhost']);
const PRIVATE_SOURCE_SUFFIXES = ['.local', '.internal', '.corp', '.lan', '.home', '.localhost'];

function isPrivateResearchSourceUrl(sourceUrl: string): boolean {
  const parsed = new URL(sourceUrl);
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return parsed.protocol !== 'https:'
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

export function validateResearchCards(cards: ResearchCard[]): string | null {
  if (cards.length < 1 || cards.length > 5) {
    return 'Research card saves must include 1 to 5 approved cards.';
  }

  for (const card of cards) {
    if (!RESEARCH_CLAIM_TYPE_SET.has(card.claim_type)) {
      return `Invalid claim_type: ${card.claim_type}`;
    }
    if (card.source_backed_facts.length < 1) {
      return 'Each research card must include at least one source_backed_facts entry.';
    }
    for (const fact of card.source_backed_facts) {
      if (fact.sources.length < 1) {
        return 'Each source-backed fact must include at least one sources entry.';
      }
      for (const source of fact.sources) {
        try {
          if (isPrivateResearchSourceUrl(source.url)) {
            return `Research source must be a public HTTPS URL: ${source.url}`;
          }
        } catch {
          return `Research source must include a valid URL: ${source.url}`;
        }
      }
    }
  }

  return null;
}
