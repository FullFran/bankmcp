import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { findOwnTransfers, type AccountTransaction } from "./data.ts";

/**
 * Plugins add tools and prompts to the MCP server without changing this code base.
 * BANKMCP_PLUGINS names modules (comma-separated paths); each exports `register(server, ctx)`.
 * They are loaded once at startup, and a plugin that fails to load, or that registers a name
 * already taken, stops startup instead of leaving a half-registered server.
 * Plugins get read-only bank data through `ctx`; they never see tokens, sessions or keys.
 * A token granted bank:attest alone never sees plugin tools.
 */

export interface PluginAccount {
  uid: string;
  name?: string;
  label?: string;
  currency?: string;
  iban?: string;
}

export interface PluginTransaction extends AccountTransaction {
  /** True when the transaction moves money between two connected accounts (both legs), card repayments included. */
  own_transfer: boolean;
}

export interface PluginChecked {
  account: string;
  uid: string;
  from: string;
  to: string;
  transactions: number;
  complete: boolean;
  error?: string;
}

export interface PluginBalance {
  uid: string;
  account: string;
  currency?: string;
  booked?: number;
  available?: number;
  error?: string;
}

export interface PluginContext {
  /** Connected accounts. */
  accounts(): PluginAccount[];
  /** Transactions across accounts (default all) for YYYY-MM-DD dates, with own transfers marked. */
  transactions(opts: { accounts?: string[]; from: string; to: string }): Promise<{ transactions: PluginTransaction[]; checked: PluginChecked[] }>;
  /** Current balances of the given accounts (default all); an account that cannot be read carries `error`. */
  balances(opts?: { accounts?: string[] }): Promise<PluginBalance[]>;
}

export interface BankPlugin {
  /** Where the plugin was loaded from, for error messages. */
  path: string;
  register(server: McpServer, ctx: PluginContext): void;
}

/** Paths from a BANKMCP_PLUGINS value; empty when unset or blank. */
export function pluginPaths(spec: string | undefined): string[] {
  return (spec ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => (isAbsolute(p) ? p : resolve(p)));
}

/** Imports each plugin module and checks it exports `register`. Throws naming the path on failure. */
export async function importPlugins(spec: string | undefined): Promise<BankPlugin[]> {
  const plugins: BankPlugin[] = [];
  for (const path of pluginPaths(spec)) {
    let mod: { register?: unknown };
    try {
      mod = await import(pathToFileURL(path).href);
    } catch (err) {
      throw new Error(`Plugin ${path} could not be loaded: ${(err as Error).message}`);
    }
    if (typeof mod.register !== "function") throw new Error(`Plugin ${path} does not export a register function.`);
    plugins.push({ path, register: mod.register as BankPlugin["register"] });
  }
  return plugins;
}

/** Marks both legs of transfers between connected accounts, using the same rule as monthly_summary. */
export function markOwnTransfers<T extends AccountTransaction>(list: T[], ownIds: string[]): (T & { own_transfer: boolean })[] {
  const transfers = findOwnTransfers(list, ownIds);
  return list.map((t) => ({ ...t, own_transfer: transfers.has(t) }));
}
