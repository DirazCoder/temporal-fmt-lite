/*
 * Copyright 2026 DirazCoder
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// no ambient Temporal type since tsconfig only has lib: ["ESNext"], so this is the one
// place that constructs from a namespace (PlainDate.from etc) instead of just reading fields
interface TemporalFactory {
  from(fields: Record<string, number | string | undefined>, options?: { overflow?: 'constrain' | 'reject' }): unknown;
}

export interface TemporalNamespace {
  PlainDate: TemporalFactory;
  PlainTime: TemporalFactory;
  PlainDateTime: TemporalFactory;
  ZonedDateTime: TemporalFactory;
}

let injectedTemporal: TemporalNamespace | undefined;

// anything caching a result tied to which Temporal impl is active (right now just
// tokens.ts's native-Intl probe) registers here so setTemporal() can invalidate it
const onTemporalChanged: Array<() => void> = [];

export function subscribeToTemporalChanges(listener: () => void): void {
  onTemporalChanged.push(listener);
}

/**
 * Explicitly hand temporal-fmt-lite the Temporal implementation to use,
 * instead of relying on a global `Temporal`. Call this once, before your
 * first `format()`/`parse()`.
 *
 * Call with no argument (or `undefined`) to clear the override and fall
 * back to `globalThis.Temporal` again.
 *
 * @example
 * import { Temporal } from 'temporal-polyfill';
 * import { setTemporal } from 'temporal-fmt-lite';
 * setTemporal(Temporal);
 */
export function setTemporal(temporal?: TemporalNamespace): void {
  injectedTemporal = temporal;
  // tokens.ts's native-Intl probe is memoized from whichever impl was active when it
  // first ran, so it'd go stale here otherwise — tell listeners to re-probe
  for (const listener of onTemporalChanged) listener();
}

function resolveTemporal(): TemporalNamespace | undefined {
  return injectedTemporal ?? (globalThis as unknown as { Temporal?: TemporalNamespace }).Temporal;
}

export function getTemporal(): TemporalNamespace {
  const temporal = resolveTemporal();
  if (!temporal) {
    throw new Error(
      'temporal-fmt-lite: parse() needs a Temporal implementation to construct its result. ' +
      'Call setTemporal(Temporal) once at startup, or assign one to globalThis.Temporal ' +
      '(native on Node 26+, or a polyfill like temporal-polyfill).'
    );
  }
  return temporal;
}
