import { gunzipSync, zstdDecompressSync } from "node:zlib";
import { decode } from "cbor-x";
import pg from "pg";

/**
 * Looks for marker strings in every column of every table of every non-system schema. This is
 * the test behind the claim "ciphertext at rest": plant unique markers in everything a person
 * or an agent can type, run the system, then require that none of them can be found.
 *
 * A value is checked as stored and in every form it can be decoded to: bytea is CBOR-decoded,
 * and byte strings with the Workflow SDK's `zstd` or `gzip` prefix are decompressed, because the
 * SDK compresses payloads and a plain scan would miss compressed plaintext. Each marker is
 * searched as UTF-8, as hex, and as base64 at all three byte alignments.
 */
export interface MarkerHit {
  marker: string;
  schema: string;
  table: string;
  column: string;
  /** How the marker was encoded where it was found, with `+decoded` for a decoded view. */
  encoding: string;
  sample: string;
}

export interface MarkerScan {
  hits: MarkerHit[];
  tables: string[];
  columns: number;
  rows: number;
}

function collectLeaves(value: unknown, out: Buffer[], depth = 0): void {
  if (depth > 20 || value === null || value === undefined) return;

  if (value instanceof Uint8Array) {
    out.push(Buffer.from(value));
  } else if (typeof value === "string") {
    out.push(Buffer.from(value));
  } else if (Array.isArray(value)) {
    for (const item of value) collectLeaves(item, out, depth + 1);
  } else if (value instanceof Map) {
    for (const [key, item] of value) {
      collectLeaves(key, out, depth + 1);
      collectLeaves(item, out, depth + 1);
    }
  } else if (typeof value === "object") {
    for (const item of Object.values(value)) collectLeaves(item, out, depth + 1);
  }
}

/** The value itself plus every view of it that decodes or decompresses. */
function expand(buffer: Buffer, depth = 0): Buffer[] {
  const views = [buffer];

  if (depth > 6) return views;
  const prefix = buffer.subarray(0, 4).toString("latin1");

  if (prefix === "zstd" || prefix === "gzip") {
    try {
      const body = buffer.subarray(4);
      const inner = prefix === "zstd" ? zstdDecompressSync(body) : gunzipSync(body);
      views.push(...expand(inner, depth + 1));
    } catch {
      // Not actually compressed data; the raw view above still gets scanned.
    }

    return views;
  }

  try {
    const leaves: Buffer[] = [];
    collectLeaves(decode(buffer), leaves);

    for (const leaf of leaves) {
      if (!leaf.equals(buffer)) views.push(...expand(leaf, depth + 1));
    }
  } catch {
    // Not CBOR; the raw view above still gets scanned.
  }

  return views;
}

function base64Needles(marker: string): string[] {
  const bytes = Buffer.from(marker, "utf8");
  const needles: string[] = [];

  for (let pad = 0; pad < 3; pad += 1) {
    const encoded = Buffer.concat([Buffer.alloc(pad, 0), bytes]).toString("base64");
    // Drop the characters that depend on the padding before the marker and on what follows it.
    const start = Math.ceil((pad * 4) / 3) + 1;
    needles.push(encoded.slice(start, encoded.length - 4));
  }

  return needles.filter((needle) => needle.length >= 12);
}

export async function scanForMarkers(
  connectionString: string,
  markers: readonly string[],
): Promise<MarkerScan> {
  const client = new pg.Client({ connectionString });
  await client.connect();

  try {
    const { rows: columns } = await client.query<{
      table_schema: string;
      table_name: string;
      column_name: string;
      data_type: string;
    }>(
      `SELECT c.table_schema, c.table_name, c.column_name, c.data_type
         FROM information_schema.columns c
         JOIN information_schema.tables t USING (table_schema, table_name)
        WHERE t.table_type = 'BASE TABLE'
          AND c.table_schema NOT IN ('pg_catalog', 'information_schema')
          AND c.table_schema NOT LIKE 'pg_toast%' AND c.table_schema NOT LIKE 'pg_temp%'
        ORDER BY 1, 2, c.ordinal_position`,
    );

    const byTable = new Map<string, typeof columns>();

    for (const column of columns) {
      const key = `${column.table_schema}.${column.table_name}`;
      byTable.set(key, [...(byTable.get(key) ?? []), column]);
    }

    const needles = markers.map((marker) => ({
      marker,
      forms: [
        ["utf8", marker],
        ["hex", Buffer.from(marker).toString("hex")],
        ...base64Needles(marker).map((needle) => ["base64", needle]),
        ["base64url", Buffer.from(marker).toString("base64url").slice(1, -3)],
      ] as [string, string][],
    }));

    const hits: MarkerHit[] = [];
    let rowCount = 0;

    for (const tableColumns of byTable.values()) {
      const first = tableColumns[0];

      if (!first) continue;

      const select = tableColumns
        .map((column) =>
          column.data_type === "bytea"
            ? `"${column.column_name}"`
            : `"${column.column_name}"::text AS "${column.column_name}"`,
        )
        .join(", ");

      const { rows } = await client.query<Record<string, unknown>>(
        `SELECT ${select} FROM "${first.table_schema}"."${first.table_name}"`,
      );

      rowCount += rows.length;

      for (const row of rows) {
        for (const column of tableColumns) {
          const value = row[column.column_name];

          if (value === null || value === undefined) continue;

          const views = Buffer.isBuffer(value)
            ? expand(value).map((view) => view.toString("latin1"))
            : [String(value)];

          views.forEach((text, viewIndex) => {
            const lower = text.toLowerCase();

            for (const { marker, forms } of needles) {
              for (const [encoding, needle] of forms) {
                const haystack = encoding === "hex" ? lower : text;
                const index = haystack.indexOf(needle);

                if (index === -1) continue;
                hits.push({
                  marker,
                  schema: first.table_schema,
                  table: first.table_name,
                  column: column.column_name,
                  encoding: viewIndex === 0 ? encoding : `${encoding}+decoded`,
                  sample: text
                    .slice(Math.max(0, index - 40), index + needle.length + 20)
                    .replace(/[^\x20-\x7e]/g, "."),
                });
              }
            }
          });
        }
      }
    }

    return { hits, tables: [...byTable.keys()], columns: columns.length, rows: rowCount };
  } finally {
    await client.end();
  }
}
