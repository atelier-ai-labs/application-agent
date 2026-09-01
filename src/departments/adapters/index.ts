import type { DepartmentAdapter } from "./types";
import { applicationAgentAdapter } from "./applicationAgent";
import { nhlIntelligenceAdapter } from "./nhlIntelligence";
import { quantIntelligenceAdapter } from "./quantIntelligence";

export const adapters: Readonly<Record<string, DepartmentAdapter>> = {
  [applicationAgentAdapter.id]: applicationAgentAdapter,
  [nhlIntelligenceAdapter.id]: nhlIntelligenceAdapter,
  [quantIntelligenceAdapter.id]: quantIntelligenceAdapter,
};

export function getAdapter(adapterId: string): DepartmentAdapter | undefined {
  return adapters[adapterId];
}

export { applicationAgentAdapter, nhlIntelligenceAdapter, quantIntelligenceAdapter };
export type { AdapterRequestContext, DepartmentAdapter } from "./types";
