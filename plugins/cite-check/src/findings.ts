/** What every rule and verifier produces. */
import type { PluginAnnotationPart, PluginAnnotationSeverity } from '@cardmirror/plugin-api';

export type Severity = PluginAnnotationSeverity;

export interface Finding {
  /** Stable id of the check (used for "ignore" and the panel). */
  ruleId: string;
  severity: Severity;
  /** One line, shown on hover, in the menu and in the panel. */
  message: string;
  /** Where the mark goes: which part of the card and, optionally, the
   *  exact text (must be a substring of that paragraph). */
  part: PluginAnnotationPart;
  index?: number;
  match?: string;
  /** Came from an online check (kept until the next verify). */
  online?: boolean;
}

/** A positive online result, shown as a ✓ in the panel (never marked). */
export interface Confirmation {
  ruleId: string;
  message: string;
}

export const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

export function sortFindings(list: Finding[]): Finding[] {
  return [...list].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}
