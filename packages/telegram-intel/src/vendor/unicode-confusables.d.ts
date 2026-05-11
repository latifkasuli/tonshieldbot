/**
 * Ambient type declarations for `unicode-confusables@0.1.1`.
 *
 * Upstream ships a file at `index.ts.d` (sic) and references `index.d.ts`
 * in package.json, so TypeScript can't auto-resolve types. We hand-declare
 * the surface we actually use until the upstream fix lands.
 *
 * Source: <https://github.com/lastcanal/unicode-confusables>
 */
declare module "unicode-confusables" {
  /**
   * Replace each confusable codepoint in `input` with its TR39 prototype
   * (the "skeleton" form, e.g. Cyrillic а → Latin a). Pass-through for
   * pure-ASCII input.
   */
  export function rectifyConfusion(input: string): string;

  /**
   * True iff `input` contains at least one codepoint that has a TR39
   * confusable mapping. Useful as a fast pre-check before computing the
   * full skeleton.
   */
  export function isConfusing(input: string): boolean;

  /**
   * Returns the list of confusable codepoint positions found in `input`,
   * along with their TR39 prototype. We don't currently consume this from
   * production code; declared for parity with the upstream surface.
   */
  export function confusables(
    input: string,
  ): readonly { readonly point: string; readonly position: number; readonly similar_to: string }[];
}
