import type { AppRole } from '../../users/user.types';
import type { ProviderState } from '../providers.service';

export type ProviderTransitionActor = AppRole;

export interface ProviderTransitionRule {
  from: ProviderState;
  to: ProviderState;
  actors: readonly ProviderTransitionActor[];
}

/**
 * Sağlayıcı onay durum makinesi (Faz 10, ADR-0006'daki booking transition map ile
 * aynı desen): geçişler tek bir merkezî tablodan geçer, controller/service içine
 * dağıtılmaz.
 *
 *   DRAFT --submit(PROVIDER)--> PENDING_REVIEW --approve(ADMIN)--> APPROVED
 *                                              \-reject(ADMIN)--> REJECTED
 *   REJECTED --submit(PROVIDER)--> PENDING_REVIEW   (düzeltip yeniden başvurma)
 *   APPROVED --suspend(ADMIN)--> SUSPENDED --reinstate(ADMIN)--> APPROVED
 *
 * `SUPPORT` hiçbir kuralda yer almaz: onay/askıya alma sağlayıcının pazaryerindeki
 * görünürlüğünü doğrudan değiştirir ve destek rolünün yıkıcı/karar verici aksiyon
 * alamaması gerekir (rbac-matrix.md).
 */
export const PROVIDER_TRANSITIONS: readonly ProviderTransitionRule[] = [
  { from: 'DRAFT', to: 'PENDING_REVIEW', actors: ['PROVIDER'] },
  { from: 'PENDING_REVIEW', to: 'APPROVED', actors: ['ADMIN'] },
  { from: 'PENDING_REVIEW', to: 'REJECTED', actors: ['ADMIN'] },
  { from: 'REJECTED', to: 'PENDING_REVIEW', actors: ['PROVIDER'] },
  { from: 'APPROVED', to: 'SUSPENDED', actors: ['ADMIN'] },
  { from: 'SUSPENDED', to: 'APPROVED', actors: ['ADMIN'] },
];

const TRANSITION_INDEX = new Map<string, ProviderTransitionRule>(
  PROVIDER_TRANSITIONS.map((rule) => [`${rule.from}->${rule.to}`, rule]),
);

export function findProviderTransition(
  from: ProviderState,
  to: ProviderState,
): ProviderTransitionRule | undefined {
  return TRANSITION_INDEX.get(`${from}->${to}`);
}

export function isProviderActorAllowed(
  rule: ProviderTransitionRule,
  actor: ProviderTransitionActor,
): boolean {
  return rule.actors.includes(actor);
}
