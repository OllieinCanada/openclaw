/**
 * Lazy channel registry value loader.
 *
 * Resolves plugin sub-surfaces from request-scoped and process-root registries.
 */
import type { PluginChannelRegistration } from "../../plugins/registry-types.js";
import { getActivePluginRegistry } from "../../plugins/runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import type { ChannelId } from "./channel-id.types.js";

type ChannelRegistryValueResolver<TValue> = (
  entry: PluginChannelRegistration,
) => TValue | undefined;

/**
 * Creates a lazy loader that resolves one value from the available channel registries.
 */
export function createChannelRegistryLoader<TValue>(
  resolveValue: ChannelRegistryValueResolver<TValue>,
): (id: ChannelId) => Promise<TValue | undefined> {
  return async (id: ChannelId): Promise<TValue | undefined> => {
    const resolveFromRegistry = (
      registry: ReturnType<typeof getActivePluginRegistry> | undefined,
    ): TValue | undefined => {
      const pluginEntry = registry?.channels.find((entry) => entry.plugin.id === id);
      return pluginEntry ? resolveValue(pluginEntry) : undefined;
    };

    // Plugin tool scopes can omit process-root channel registrations. Scoped
    // values stay authoritative, but a missing value falls through to the root.
    return (
      resolveFromRegistry(getPluginRuntimeGatewayRequestScope()?.pluginRegistry) ??
      resolveFromRegistry(getActivePluginRegistry())
    );
  };
}
