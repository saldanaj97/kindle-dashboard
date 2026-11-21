import type { SourceName } from "./config";

export interface StoredPayload<T = unknown> {
  /** When the Worker accepted the payload (ISO 8601). */
  received_at: string;
  payload: T;
}

const key = (source: SourceName) => `latest:${source}`;

export async function putLatest(kv: KVNamespace, source: SourceName, payload: unknown, receivedAt: Date): Promise<void> {
  const value: StoredPayload = { received_at: receivedAt.toISOString(), payload };
  await kv.put(key(source), JSON.stringify(value));
}

export async function getLatest<T>(kv: KVNamespace, source: SourceName): Promise<StoredPayload<T> | null> {
  return kv.get<StoredPayload<T>>(key(source), "json");
}
