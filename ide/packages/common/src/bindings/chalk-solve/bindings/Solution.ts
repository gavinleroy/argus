// This file was generated by [ts-rs](https://github.com/Aleph-Alpha/ts-rs). Do not edit this file manually.
import { Canonical } from '../../../types';
import { ConstrainedSubst } from '../../../types';
import { Guidance } from '../../../types';

export type Solution = { Unique: Canonical<ConstrainedSubst> } | { Ambig: Guidance };