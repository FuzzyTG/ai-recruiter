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
          new URL(source.url);
        } catch {
          return `Research source must include a valid URL: ${source.url}`;
        }
      }
    }
  }

  return null;
}
