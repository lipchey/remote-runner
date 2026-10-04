import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { extract } from "./vault.mjs";

export function parseArgs(args) {
  const options = { sinceMs: 3_600_000, event: null, json: false };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (seen.has(flag)) throw new Error("Invalid arguments");
    seen.add(flag);
    if (flag === "--json") options.json = true;
    else if (flag === "--since" && args[i + 1]) {
      const duration = /^([1-9]\d*)([mhd])$/.exec(args[++i]);
      if (!duration) throw new Error("Invalid arguments");
      options.sinceMs = Number(duration[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[duration[2]];
      if (!Number.isSafeInteger(options.sinceMs)) throw new Error("Invalid arguments");
    } else if (flag === "--event" && args[i + 1] && !args[i + 1].startsWith("--")) options.event = args[++i];
    else throw new Error("Invalid arguments");
  }
  return options;
}

export function queryBody({ from, to, queryId, offset }) {
  return {
    queryId,
    timeframe: { from, to },
    view: "events",
    limit: 2000,
    ...(offset === undefined ? {} : { offset }),
    parameters: {
      filters: [{ key: "$metadata.service", operation: "eq", type: "string", value: "runner-router" }],
      filterCombination: "and",
    },
  };
}

export async function queryLogs({ token, accountId, sinceMs, now = Date.now(), fetch = globalThis.fetch }) {
  const timeframe = { from: now - sinceMs, to: now, queryId: randomUUID() };
  const events = [];
  const cursors = new Set();
  let offset;
  while (true) {
    let page;
    try {
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/workers/observability/telemetry/query`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify(queryBody({ ...timeframe, offset })),
        },
      );
      if (!response.ok) throw new Error("API failure");
      const body = await response.json();
      page = body?.result?.events?.events;
      if (body.success === false || !Array.isArray(page)) throw new Error("Invalid response");
    } catch {
      throw new Error("Cloudflare logs query failed; check account access and Workers Observability Write permission");
    }
    if (page.length === 0) return events;
    const cursor = page.at(-1)?.$metadata?.id;
    if (typeof cursor !== "string" || !cursor || cursors.has(cursor))
      throw new Error("Cloudflare logs pagination did not advance");
    events.push(...page);
    cursors.add(cursor);
    offset = cursor;
  }
}

function findRecord(value) {
  if (value === null || typeof value !== "object") return null;
  if (typeof value.event === "string") return value;
  for (const entry of Object.values(value)) {
    const record = findRecord(entry);
    if (record) return record;
  }
  return null;
}

export function eventRecord(event) {
  const record = findRecord(event.source) ?? (typeof event.event === "string" ? event : null);
  if (record) return record;
  try {
    return findRecord(JSON.parse(event.$metadata?.message));
  } catch {
    return null;
  }
}

const kyivTime = new Intl.DateTimeFormat("uk-UA", {
  timeZone: "Europe/Kyiv",
  dateStyle: "short",
  timeStyle: "medium",
  hourCycle: "h23",
});

export function renderEvent(event) {
  const record = eventRecord(event);
  const at = new Date(record?.at ?? event.$metadata?.timestamp);
  const time = Number.isNaN(at.getTime()) ? "time unknown" : `${kyivTime.format(at)} (Київ)`;
  const fields = [time, record?.event ?? "invocation"];
  if (record?.kind !== undefined) fields.push(record.kind);
  if (record && ("desired" in record || "applied" in record))
    fields.push(`${record.desired ?? "?"}→${record.applied ?? "?"}`);
  if (record?.pcHealthy !== undefined) fields.push(`pcHealthy=${record.pcHealthy}`);
  if (record?.heartbeat) fields.push(`hb=${record.heartbeat.ageS}s`);
  for (const mutation of record?.mutations ?? [])
    fields.push(`${mutation.op}(${mutation.labels.join(",")}):${mutation.result}`);
  if (record?.unknownReason) fields.push(record.unknownReason);
  return fields.join(" ").replace(/\s+/g, " ");
}

export async function main(args, readSecret = extract) {
  const options = parseArgs(args);
  const token = readSecret("CLOUDFLARE_REMOTE_RUNNER_TOKEN").trim();
  const accountId = readSecret("CLOUDFLARE_REMOTE_RUNNER_ACCOUNT_ID").trim();
  const events = await queryLogs({ token, accountId, sinceMs: options.sinceMs });
  const selected =
    options.event === null ? events : events.filter((event) => eventRecord(event)?.event === options.event);
  if (options.json) console.log(JSON.stringify(selected, null, 2));
  else for (const event of selected) console.log(renderEvent(event));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
