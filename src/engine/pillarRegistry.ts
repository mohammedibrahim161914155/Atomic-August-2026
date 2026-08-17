import { PillarName } from './types';
import { AgentDef } from './pillarRunner';
import { planningPillarGovernorSystemPrompt, planningPillarProsecutorSystemPrompt, planningGovernorPrompt, planningAgents } from './pillars/planning';
import { productionPillarGovernorSystemPrompt, productionPillarProsecutorSystemPrompt, productionGovernorPrompt, productionAgents } from './pillars/production';
import { edgeCasesPillarGovernorSystemPrompt, edgeCasesPillarProsecutorSystemPrompt, edgeCasesGovernorPrompt, edgeCasesAgents } from './pillars/edgeCases';
import { integrationPillarGovernorSystemPrompt, integrationPillarProsecutorSystemPrompt, integrationGovernorPrompt, integrationAgents } from './pillars/integration';
import { securityPillarGovernorSystemPrompt, securityPillarProsecutorSystemPrompt, securityGovernorPrompt, securityAgents } from './pillars/security';
import { qualityPillarGovernorSystemPrompt, qualityPillarProsecutorSystemPrompt, qualityGovernorPrompt, qualityAgents } from './pillars/quality';
import { completenessPillarGovernorSystemPrompt, completenessPillarProsecutorSystemPrompt, completenessGovernorPrompt, completenessAgents } from './pillars/completeness';

export interface PillarDef {
  name: PillarName;
  govSysPrompt: string;
  prosSysPrompt: string;
  staticGovPrompt: string;
  agents: AgentDef[];
}

export const PILLAR_REGISTRY: PillarDef[] = [
  { name: 'planning',     govSysPrompt: planningPillarGovernorSystemPrompt,     prosSysPrompt: planningPillarProsecutorSystemPrompt,     staticGovPrompt: planningGovernorPrompt,     agents: planningAgents },
  { name: 'production',   govSysPrompt: productionPillarGovernorSystemPrompt,   prosSysPrompt: productionPillarProsecutorSystemPrompt,   staticGovPrompt: productionGovernorPrompt,   agents: productionAgents },
  { name: 'edge_cases',   govSysPrompt: edgeCasesPillarGovernorSystemPrompt,    prosSysPrompt: edgeCasesPillarProsecutorSystemPrompt,    staticGovPrompt: edgeCasesGovernorPrompt,    agents: edgeCasesAgents },
  { name: 'integration',  govSysPrompt: integrationPillarGovernorSystemPrompt,  prosSysPrompt: integrationPillarProsecutorSystemPrompt,  staticGovPrompt: integrationGovernorPrompt,  agents: integrationAgents },
  { name: 'security',     govSysPrompt: securityPillarGovernorSystemPrompt,     prosSysPrompt: securityPillarProsecutorSystemPrompt,     staticGovPrompt: securityGovernorPrompt,     agents: securityAgents },
  { name: 'quality',      govSysPrompt: qualityPillarGovernorSystemPrompt,      prosSysPrompt: qualityPillarProsecutorSystemPrompt,     staticGovPrompt: qualityGovernorPrompt,      agents: qualityAgents },
  { name: 'completeness', govSysPrompt: completenessPillarGovernorSystemPrompt, prosSysPrompt: completenessPillarProsecutorSystemPrompt, staticGovPrompt: completenessGovernorPrompt, agents: completenessAgents },
];

export const PILLAR_MAP: Record<PillarName, PillarDef> = Object.fromEntries(
  PILLAR_REGISTRY.map(d => [d.name, d])
) as Record<PillarName, PillarDef>;
