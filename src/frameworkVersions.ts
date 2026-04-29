import type { Candidate, Framework } from './models.js';
import { computeWeightedAverage } from './validators.js';

function frameworkStructureKey(framework: Framework): string {
  return JSON.stringify(
    framework.dimensions
      .map((d) => ({
        name: d.name,
        rubric: d.rubric,
        description: d.description,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  );
}

export function frameworkVersionsAreWeightOnlyCompatible(frameworks: Framework[]): boolean {
  if (frameworks.length <= 1) return true;
  const [first, ...rest] = frameworks;
  const key = frameworkStructureKey(first);
  return rest.every((framework) => frameworkStructureKey(framework) === key);
}

export function candidateFrameworkVersion(candidate: Candidate): number | null {
  return candidate.scores?.framework_version ?? (candidate.scores ? 1 : null);
}

export function candidateFrameworkVersions(candidate: Candidate): number[] {
  const versions = new Set<number>();
  const scoreVersion = candidateFrameworkVersion(candidate);
  if (scoreVersion !== null) versions.add(scoreVersion);
  for (const evaluation of candidate.evaluations ?? []) {
    versions.add(evaluation.framework_version ?? 1);
  }
  return Array.from(versions).sort((a, b) => a - b);
}

export function normalizedComparisonScore(
  candidate: Candidate,
  activeFramework: Framework,
  readFrameworkVersion: (role: string, version: number) => Framework,
): number | null {
  const evaluationScores = candidate.evaluations
    .filter((evaluation) => frameworkVersionsAreWeightOnlyCompatible([
      readFrameworkVersion(candidate.role, evaluation.framework_version),
      activeFramework,
    ]))
    .map((evaluation) => computeWeightedAverage(evaluation.scores, activeFramework));

  if (evaluationScores.length > 0) {
    return Math.round(
      (evaluationScores.reduce((sum, score) => sum + score, 0) / evaluationScores.length) * 100,
    ) / 100;
  }

  return candidate.scores
    ? computeWeightedAverage(candidate.scores.dimensions, activeFramework)
    : null;
}
