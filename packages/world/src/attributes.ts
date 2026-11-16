import {
  AttributeValidationError,
  type CreateEventParams,
  type CreateEventRequest,
  type QueuePayload,
  type RunCreatedEventRequest,
  type World,
} from "@workflow/world";

/**
 * What is stored in place of a run attribute's value when its key is not on the list of keys
 * that may stay readable.
 */
export const WITHHELD_ATTRIBUTE_VALUE = "[withheld]";

/**
 * Attribute keys whose values stay readable on every encrypting World. The Workflow SDK and the
 * Postgres World read these themselves, and none of them carries anything a person or an agent
 * typed: a retention setting and two run ids.
 */
export const ALWAYS_READABLE_ATTRIBUTE_KEYS: readonly string[] = [
  "$retention",
  "$rootRunId",
  "$parentRunId",
];

type Attributes = Record<string, string>;

type Change = { key: string; value: string | null };

/**
 * Run attributes are never encrypted: the Workflow SDK stores them as plain metadata, in the
 * run's row, in the `run_created`, `run_started` and `attr_set` events, and in the queued job
 * that starts a run. Encrypting them here is not possible, because the World and the runtimes
 * on top of it read some of them back.
 *
 * So this replaces the value of every attribute whose key is not on the readable list, on each
 * of those paths, before the upstream World sees it. The key stays, the value becomes
 * {@link WITHHELD_ATTRIBUTE_VALUE}. A runtime that puts content in an attribute (eve copies the
 * first user message into `$eve.title`) then stores the placeholder, not the content.
 *
 * One write cannot be replaced: `setAttributes()` called in a workflow body. On every replay
 * the SDK compares the stored event with the values the body asked for, and a replaced value
 * reads as a diverged replay. That write is refused instead, with the validation error the SDK
 * turns into a failed run. Set such an attribute from a step, or list its key as readable.
 *
 * The World is changed in place, so the upstream World's own references to `events` and `runs`
 * go through the same check.
 */
export function withholdRunAttributes(world: World, readableKeys: readonly string[]): void {
  const readable = new Set([...ALWAYS_READABLE_ATTRIBUTE_KEYS, ...readableKeys]);

  const attributes = (given: Attributes): Attributes => {
    const kept: Attributes = {};

    for (const [key, value] of Object.entries(given)) {
      kept[key] = readable.has(key) ? value : WITHHELD_ATTRIBUTE_VALUE;
    }

    return kept;
  };

  const changes = (given: readonly Change[]): Change[] =>
    given.map((change) =>
      change.value === null || readable.has(change.key)
        ? change
        : { key: change.key, value: WITHHELD_ATTRIBUTE_VALUE },
    );

  /** `run_created` and `run_started` carry `attributes`; `attr_set` carries `changes`. */
  const event = <T extends CreateEventRequest | RunCreatedEventRequest>(given: T): T => {
    if (given.eventType === "run_created" || given.eventType === "run_started") {
      const data = given.eventData;

      if (!data?.attributes) return given;

      return { ...given, eventData: { ...data, attributes: attributes(data.attributes) } };
    }

    if (given.eventType === "attr_set") {
      const data = given.eventData;

      if (data.writer.type === "workflow") {
        const refused = data.changes.find(({ key, value }) => value !== null && !readable.has(key));

        if (refused) {
          throw new AttributeValidationError(
            `run attribute ${JSON.stringify(refused.key)} is not listed as readable, so its value cannot be stored; set it from a step or list the key`,
          );
        }

        return given;
      }

      return { ...given, eventData: { ...data, changes: changes(data.changes) } };
    }

    return given;
  };

  /** The job that starts a run carries the run's attributes in `runInput`. */
  const message = (given: QueuePayload): QueuePayload => {
    if (!("runInput" in given)) return given;
    const runInput = given.runInput;

    if (!runInput?.attributes) return given;

    return { ...given, runInput: { ...runInput, attributes: attributes(runInput.attributes) } };
  };

  const events = world.events;
  const create = events.create.bind(events);
  events.create = ((runId: string, data: CreateEventRequest, params?: CreateEventParams) =>
    create(runId, event(data), params)) as typeof events.create;

  const createBatch = events.createBatch?.bind(events);

  if (createBatch) {
    events.createBatch = (runId, batch, params) =>
      createBatch(
        runId,
        batch.map((entry) => ({ ...entry, event: event(entry.event) })),
        params,
      );
  }

  const runs = world.runs;
  const setAttributes = runs.experimentalSetAttributes?.bind(runs);

  if (setAttributes) {
    runs.experimentalSetAttributes = (runId, given, options) =>
      setAttributes(runId, changes(given), options);
  }

  const queue = world.queue.bind(world);
  world.queue = (name, payload, options) => queue(name, message(payload), options);

  const queueBatch = world.queueBatch?.bind(world);

  if (queueBatch) {
    world.queueBatch = (name, messages) =>
      queueBatch(
        name,
        messages.map((entry) => ({ ...entry, message: message(entry.message) })),
      );
  }
}
