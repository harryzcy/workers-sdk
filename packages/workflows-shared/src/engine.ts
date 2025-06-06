import { DurableObject } from "cloudflare:workers";
import { Context } from "./context";
import {
	INSTANCE_METADATA,
	InstanceEvent,
	InstanceStatus,
	InstanceTrigger,
} from "./instance";
import { WorkflowFatalError } from "./lib/errors";
import {
	ENGINE_TIMEOUT,
	GracePeriodSemaphore,
	startGracePeriod,
} from "./lib/gracePeriodSemaphore";
import { TimePriorityQueue } from "./lib/timePriorityQueue";
import type { Event } from "./context";
import type { InstanceMetadata, RawInstanceLog } from "./instance";
import type { WorkflowEntrypoint, WorkflowEvent } from "cloudflare:workers";

export interface Env {
	USER_WORKFLOW: WorkflowEntrypoint;
}

export type DatabaseWorkflow = {
	name: string;
	id: string;
	created_on: string;
	modified_on: string;
	script_name: string;
	class_name: string | null;
	triggered_on: string | null;
};

export type DatabaseVersion = {
	id: string;
	class_name: string;
	created_on: string;
	modified_on: string;
	workflow_id: string;
	mutable_pipeline_id: string;
};

export type DatabaseInstance = {
	id: string;
	created_on: string;
	modified_on: string;
	workflow_id: string;
	version_id: string;
	status: InstanceStatus;
	started_on: string | null;
	ended_on: string | null;
};

export type Log = {
	event: InstanceEvent;
	group: string | null;
	target: string | null;
	metadata: {
		result: unknown;
		payload: unknown;
	};
};

export type EngineLogs = {
	logs: Log[];
};

const ENGINE_STATUS_KEY = "ENGINE_STATUS";

const EVENT_MAP_PREFIX = "EVENT_MAP";

export class Engine extends DurableObject<Env> {
	logs: Array<unknown> = [];

	isRunning: boolean = false;
	accountId: number | undefined;
	instanceId: string | undefined;
	workflowName: string | undefined;
	timeoutHandler: GracePeriodSemaphore;
	priorityQueue: TimePriorityQueue | undefined;

	waiters: Map<string, Array<(event: Event | PromiseLike<Event>) => void>> =
		new Map();
	eventMap: Map<string, Array<Event>> = new Map();

	constructor(state: DurableObjectState, env: Env) {
		super(state, env);
		void this.ctx.blockConcurrencyWhile(async () => {
			this.ctx.storage.transactionSync(() => {
				try {
					this.ctx.storage.sql.exec(`
						CREATE TABLE IF NOT EXISTS priority_queue (
							id INTEGER PRIMARY KEY NOT NULL,
							created_on TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
							target_timestamp INTEGER NOT NULL,
							action INTEGER NOT NULL, -- should only be 0 or 1 (1 for added, 0 for deleted),
							entryType INTEGER NOT NULL,
							hash TEXT NOT NULL,
							CHECK (action IN (0, 1)), -- guararentee that action can only be 0 or 1
							UNIQUE (action, entryType, hash)
						);
						CREATE TABLE IF NOT EXISTS states (
							id INTEGER PRIMARY KEY NOT NULL,
							groupKey TEXT,
							target TEXT,
							metadata TEXT,
							event INTEGER NOT NULL
						)
					`);
				} catch (e) {
					console.error(e);
					throw e;
				}
			});
		});

		this.timeoutHandler = new GracePeriodSemaphore(
			startGracePeriod,
			ENGINE_TIMEOUT
		);
	}

	writeLog(
		event: InstanceEvent,
		group: string | null,
		target: string | null = null,
		metadata: Record<string, unknown>
	) {
		this.ctx.storage.sql.exec(
			"INSERT INTO states (event, groupKey, target, metadata) VALUES (?, ?, ?, ?)",
			event,
			group,
			target,
			JSON.stringify(metadata)
		);
	}

	readLogsFromStep(_cacheKey: string): RawInstanceLog[] {
		return [];
	}

	readLogs(): EngineLogs {
		const logs = [
			...this.ctx.storage.sql.exec<{
				event: InstanceEvent;
				groupKey: string | null;
				target: string | null;
				metadata: string;
			}>("SELECT event, groupKey, target, metadata FROM states"),
		];

		return {
			logs: logs.map((log) => ({
				...log,
				metadata: JSON.parse(log.metadata),
				group: log.groupKey,
			})),
		};
	}

	async getStatus(
		_accountId: number,
		_instanceId: string
	): Promise<InstanceStatus> {
		if (this.accountId === undefined) {
			// Engine could have restarted, so we try to restore from its state
			const metadata =
				await this.ctx.storage.get<InstanceMetadata>(INSTANCE_METADATA);
			if (metadata === undefined) {
				// metadata was never set, so we assume the engine was never started
				throw new Error("Engine was never started");
			}

			this.accountId = metadata.accountId;
			this.instanceId = metadata.instance.id;
			this.workflowName = metadata.workflow.name;
		}

		const res = await this.ctx.storage.get<InstanceStatus>(ENGINE_STATUS_KEY);

		// NOTE(lduarte): if status don't exist, means that engine is running for the first time, so we assume queued
		if (res === undefined) {
			return InstanceStatus.Queued;
		}
		return res;
	}

	async setStatus(
		accountId: number,
		instanceId: string,
		status: InstanceStatus
	): Promise<void> {
		await this.ctx.storage.put(ENGINE_STATUS_KEY, status);
	}

	async abort(_reason: string) {
		// TODO: Maybe don't actually kill but instead check a flag and return early if true
	}

	async storeEventMap() {
		// TODO: this can be more efficient, but oh well
		await this.ctx.blockConcurrencyWhile(async () => {
			for (const [key, value] of this.eventMap.entries()) {
				for (const eventIdx in value) {
					await this.ctx.storage.put(
						`${EVENT_MAP_PREFIX}\n${key}\n${eventIdx}`,
						value[eventIdx]
					);
				}
			}
		});
	}

	async restoreEventMap() {
		await this.ctx.blockConcurrencyWhile(async () => {
			// FIXME(lduarte): can this OoM the DO in the production?
			const entries = await this.ctx.storage.list<Event>({
				prefix: EVENT_MAP_PREFIX,
			});
			for (const [key, value] of entries) {
				const [_, eventType, _idx] = key.split("\n");
				// NOTE(lduarte): safe to do because list returns keys in ascending order, so
				// indexes will be correctly ordered
				const eventList = this.eventMap.get(eventType) ?? [];
				eventList.push(value);
				this.eventMap.set(eventType, eventList);
			}
		});
	}

	async receiveEvent(event: {
		timestamp: Date;
		payload: unknown;
		type: string;
	}) {
		// Always queue the event first
		// TODO: Persist it across lifetimes
		// There are four possible cases here:
		// - There is a callback waiting, send it
		// - There is no callback waiting but engine is alive, store it
		// - Engine is not awake and is in Waiting status, store it and start it up
		// - Engine is not awake and is in Paused (or another terminal) status, store it
		// - Engine is not awake and is Errored or Terminated, this should not get called
		let eventTypeQueue = this.eventMap.get(event.type) ?? [];
		eventTypeQueue.push(event as Event);
		await this.storeEventMap();
		// TODO: persist eventMap - it can be over 2MiB
		this.eventMap.set(event.type, eventTypeQueue);

		// if the engine is running
		if (this.isRunning) {
			// Attempt to get the callback and run it
			const callbacks = this.waiters.get(event.type);
			if (callbacks) {
				const callback = callbacks[0];
				if (callback) {
					callback(event);
					// Remove it from the list of callbacks
					callbacks.shift();
					this.waiters.set(event.type, callbacks);

					eventTypeQueue = this.eventMap.get(event.type) ?? [];
					eventTypeQueue.shift();
					this.eventMap.set(event.type, eventTypeQueue);

					return;
				}
			}
		} else {
			const metadata =
				await this.ctx.storage.get<InstanceMetadata>(INSTANCE_METADATA);
			if (metadata === undefined) {
				throw new Error("Engine was never started");
			}

			void this.init(
				metadata.accountId,
				metadata.workflow,
				metadata.version,
				metadata.instance,
				metadata.event
			);
		}
	}

	async userTriggeredTerminate() {}

	async init(
		accountId: number,
		workflow: DatabaseWorkflow,
		version: DatabaseVersion,
		instance: DatabaseInstance,
		event: WorkflowEvent<unknown>
	) {
		if (this.priorityQueue === undefined) {
			this.priorityQueue = new TimePriorityQueue(
				this.ctx,
				// this.env,
				{
					accountId,
					workflow,
					version,
					instance,
					event,
				}
			);
		}

		if (this.isRunning) {
			return;
		}

		this.priorityQueue.popPastEntries();
		await this.priorityQueue.handleNextAlarm();

		// We are not running and are possibly starting a new lifetime
		this.accountId = accountId;
		this.instanceId = instance.id;
		this.workflowName = workflow.name;

		const status = await this.getStatus(accountId, instance.id);
		if (
			[
				InstanceStatus.Errored, // TODO (WOR-85): Remove this once upgrade story is done
				InstanceStatus.Terminated,
				InstanceStatus.Complete,
			].includes(status)
		) {
			return;
		}

		if ((await this.ctx.storage.get(INSTANCE_METADATA)) == undefined) {
			const instanceMetadata: InstanceMetadata = {
				accountId,
				workflow,
				version,
				instance,
				event,
			};
			await this.ctx.storage.put(INSTANCE_METADATA, instanceMetadata);

			// TODO (WOR-78): We currently don't have a queue mechanism
			// WORKFLOW_QUEUED should happen before engine is spun up
			this.writeLog(InstanceEvent.WORKFLOW_QUEUED, null, null, {
				params: event.payload,
				versionId: version.id,
				trigger: {
					source: InstanceTrigger.API,
				},
			});
			this.writeLog(InstanceEvent.WORKFLOW_START, null, null, {});
		}

		// restore eventMap so that waitForEvent across lifetimes works correctly
		await this.restoreEventMap();

		const stubStep = new Context(this, this.ctx);

		const workflowRunningHandler = async () => {
			await this.ctx.storage.transaction(async () => {
				// manually start the grace period
				// startGracePeriod(this, this.timeoutHandler.timeoutMs);
				await this.setStatus(accountId, instance.id, InstanceStatus.Running);
			});
		};
		this.isRunning = true;
		void workflowRunningHandler();
		try {
			const target = this.env.USER_WORKFLOW;
			const result = await target.run(event, stubStep);
			this.writeLog(InstanceEvent.WORKFLOW_SUCCESS, null, null, {
				result,
			});
			// NOTE(lduarte): we want to run this in a transaction to guarentee ordering with running setstatus call
			// in case that it returns immediately
			await this.ctx.storage.transaction(async () => {
				await this.setStatus(accountId, instance.id, InstanceStatus.Complete);
			});
			this.isRunning = false;
		} catch (err) {
			let error;
			if (err instanceof Error) {
				if (
					err.name === "NonRetryableError" ||
					err.message.startsWith("NonRetryableError")
				) {
					this.writeLog(InstanceEvent.WORKFLOW_FAILURE, null, null, {
						error: new WorkflowFatalError(
							`The execution of the Workflow instance was terminated, as a step threw an NonRetryableError and it was not handled`
						),
					});

					await this.setStatus(accountId, instance.id, InstanceStatus.Errored);
					await this.abort(`A step threw a NonRetryableError`);
					this.isRunning = false;
					return;
				}
				error = {
					message: err.message,
					name: err.name,
				};
			} else {
				error = {
					name: "Error",
					message: err,
				};
			}

			this.writeLog(InstanceEvent.WORKFLOW_FAILURE, null, null, {
				error,
			});
			// NOTE(lduarte): we want to run this in a transaction to guarentee ordering with running setstatus call
			// in case that it throws immediately
			await this.ctx.storage.transaction(async () => {
				await this.setStatus(accountId, instance.id, InstanceStatus.Errored);
			});
			this.isRunning = false;
		}

		return {
			id: instance.id,
		};
	}
}
