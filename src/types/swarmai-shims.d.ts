/**
 * Type shims for `@swarmai/shared`, `@swarmai/tools`, `@swarmai/plugin-sdk`.
 *
 * These packages live in the SwarmAI monorepo and are not published to
 * npm. The plugin declares them as `peerDependencies` so the host's
 * exact instances are used at runtime; these shims only exist so this
 * standalone plugin can `tsc` without the monorepo source tree.
 *
 * Each shim mirrors the narrow public surface this plugin actually
 * imports — extend cautiously and keep in sync with the real types when
 * the upstream signature changes:
 *
 *   - `@swarmai/shared`     → `z` re-export (zod's default Zod 3 API)
 *   - `@swarmai/tools`      → `register({...})` registry call
 *   - `@swarmai/plugin-sdk` → `PluginAPI` shape
 *
 * When the SwarmAI SDK ships to npm, delete this file and the loose
 * structural types will be replaced by the real package types.
 */

declare module '@swarmai/shared' {
  // Re-export the full Zod API. Zod is a runtime dep of the host and
  // every desktop-* file only uses the chainable builder + `z.infer`,
  // both of which are part of Zod's normal default export. The value
  // `z` and the type-namespace `z` (for `z.infer<>`) are both surfaced
  // via the `export *` so the import behaves the same as `import { z } from 'zod'`.
  export * from 'zod';
}

declare module '@swarmai/tools' {
  import type { z as zodType } from 'zod';

  /**
   * Tool policy tiers — see the host's registry for the full rationale.
   * Mirrors `ToolPolicy` from `@swarmai/plugin-sdk`.
   */
  export type ToolPolicy = 'open' | 'pair-gated' | 'master';

  /**
   * Tool definition the registry accepts. The real `ToolDef` in
   * `@swarmai/plugin-sdk` is wider (audit hooks, deprecation flags,
   * etc.) — this shim only types the fields this plugin sets.
   */
  export interface ToolDef<S extends zodType.ZodType = zodType.ZodType, O = unknown> {
    name: string;
    toolset: string;
    emoji?: string;
    policy: ToolPolicy;
    description: string;
    schema: S;
    handler: (args: zodType.infer<S>) => Promise<O> | O;
    minTier?: string;
  }

  /**
   * Register a tool into the central registry. The host's
   * `@swarmai/tools` exports this same function — at runtime the
   * peer-dep resolution ensures the plugin and host share the SAME
   * function (and therefore the SAME registry).
   */
  export function register<S extends zodType.ZodType, O>(def: ToolDef<S, O>): void;
}

declare module '@swarmai/plugin-sdk' {
  /**
   * The shape of the object the loader passes into `register()`.
   * Mirrors `PluginAPI` from the real SDK; only the surface this plugin
   * touches (none, for v0.1.0 — entry is a no-op log) is exposed here.
   */
  export interface PluginAPI {
    registerProvider(p: unknown): void;
    registerChannel(c: unknown): void;
    registerMemoryProvider(m: unknown): void;
    registerMonitorSource(s: unknown): void;
    registerImageGenerationProvider(p: unknown): void;
    registerSpeechProvider(p: unknown): void;
    registerTranscriptionProvider(p: unknown): void;
    registerMediaUnderstandingProvider(p: unknown): void;
    registerTool(tool: unknown): void;
    registerService(serviceId: string, impl: object): void;
  }
}
