// This file was generated by [ts-rs](https://github.com/Aleph-Alpha/ts-rs). Do not edit this file manually.
import { Canonical } from '../../../types';
import { Goal } from '../../../types';
import { InEnvironment } from '../../../types';
import { ProofTreeNav } from '../../../types';
import { Solution } from '../../../types';

export interface QueryAttempt { canonicalized: Canonical<InEnvironment<Goal>>, solution: Solution | null, trace: ProofTreeNav, }