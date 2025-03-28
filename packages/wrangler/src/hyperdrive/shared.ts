import type { CachingOptions } from "./client";

export function formatCachingOptions(
	cachingOptions: CachingOptions | undefined
): string {
	switch (cachingOptions?.disabled) {
		case false: {
			if (cachingOptions.stale_while_revalidate === 0) {
				return `max_age: ${cachingOptions.max_age}, stale_while_revalidate: disabled`;
			} else {
				return `max_age: ${cachingOptions.max_age}, stale_while_revalidate: ${cachingOptions.stale_while_revalidate}`;
			}
		}
		case undefined: {
			return "enabled";
		}
		case true: {
			return "disabled";
		}
		default:
			return JSON.stringify(cachingOptions);
	}
}
