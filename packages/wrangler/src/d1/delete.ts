import { fetchResult } from "../cfetch";
import { withConfig } from "../config";
import { confirm } from "../dialogs";
import { logger } from "../logger";
import { requireAuth } from "../user";
import { printWranglerBanner } from "../wrangler-banner";
import { Name } from "./options";
import { getDatabaseByNameOrBinding } from "./utils";
import type {
	CommonYargsArgv,
	StrictYargsOptionsToInterface,
} from "../yargs-types";
import type { Database } from "./types";

export function Options(d1ListYargs: CommonYargsArgv) {
	return Name(d1ListYargs).option("skip-confirmation", {
		describe: "Skip confirmation",
		type: "boolean",
		alias: "y",
		default: false,
	});
}
type HandlerOptions = StrictYargsOptionsToInterface<typeof Options>;
export const Handler = withConfig<HandlerOptions>(
	async ({ name, skipConfirmation, config }): Promise<void> => {
		await printWranglerBanner();
		const accountId = await requireAuth(config);

		const db: Database = await getDatabaseByNameOrBinding(
			config,
			accountId,
			name
		);

		logger.log(`About to delete DB '${name}' (${db.uuid}).`);
		if (!skipConfirmation) {
			const response = await confirm(`Ok to proceed?`);
			if (!response) {
				logger.log(`Not deleting.`);
				return;
			}
		}

		logger.log("Deleting...");

		await fetchResult(`/accounts/${accountId}/d1/database/${db.uuid}`, {
			method: "DELETE",
		});

		logger.log(`Deleted '${name}' successfully.`);
	}
);
