// This file was generated by [ts-rs](https://github.com/Aleph-Alpha/ts-rs). Do not edit this file manually.

export interface TreeTopology<I extends string | number | symbol> { children: Record<I, Array<I>>, parent: Record<I, I>, }