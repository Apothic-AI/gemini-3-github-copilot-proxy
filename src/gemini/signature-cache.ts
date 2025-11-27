/**
 * SQLite-based persistent cache for thought signatures.
 *
 * Gemini requires thought_signature to be included with function calls that follow
 * thinking blocks. Since VS Code Copilot strips custom attributes from message content,
 * we cache the signature server-side using the tool_call_id as the key.
 *
 * This cache persists across server restarts by storing data in SQLite.
 */

import Database from "better-sqlite3";
import path from "path";
import os from "os";
import fs from "fs";

interface CachedSignature {
    signature: string;
    thoughtText: string;
    timestamp: number;
}

// Cache expiry time: 1 hour (signatures shouldn't be needed after a conversation ends)
const CACHE_EXPIRY_MS = 60 * 60 * 1000;

// Maximum cache size to prevent database bloat
const MAX_CACHE_SIZE = 10000;

class SignatureCache {
    private db: Database.Database;
    private cleanupInterval: ReturnType<typeof setInterval> | null = null;
    private l1Cache = new Map<string, CachedSignature>();
    private static readonly L1_CACHE_SIZE = 1000;

    // Prepared statements for better performance
    private stmtInsert!: Database.Statement;
    private stmtGet!: Database.Statement;
    private stmtHas!: Database.Statement;
    private stmtCount!: Database.Statement;
    private stmtDeleteOldest!: Database.Statement;
    private stmtDeleteExpired!: Database.Statement;

    constructor() {
        // Store in ~/.gemini directory alongside oauth_creds.json
        const geminiDir = path.join(os.homedir(), ".gemini");
        if (!fs.existsSync(geminiDir)) {
            fs.mkdirSync(geminiDir, {recursive: true});
        }

        const dbPath = path.join(geminiDir, "signature-cache.db");
        this.db = new Database(dbPath);

        // Enable WAL mode for better concurrent performance
        this.db.pragma("journal_mode = WAL");

        // Create table if it doesn't exist
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS signatures (
                tool_call_id TEXT PRIMARY KEY,
                signature TEXT NOT NULL,
                thought_text TEXT NOT NULL,
                timestamp INTEGER NOT NULL
            )
        `);

        // Create index on timestamp for efficient cleanup
        this.db.exec(`
            CREATE INDEX IF NOT EXISTS idx_timestamp ON signatures(timestamp)
        `);

        // Prepare statements
        this.prepareStatements();

        // Run cleanup on startup to remove expired entries
        this.cleanup();

        // Run cleanup every 10 minutes
        this.cleanupInterval = setInterval(() => this.cleanup(), 10 * 60 * 1000);
    }

    private prepareStatements(): void {
        this.stmtInsert = this.db.prepare(`
            INSERT OR REPLACE INTO signatures (tool_call_id, signature, thought_text, timestamp)
            VALUES (?, ?, ?, ?)
        `);

        this.stmtGet = this.db.prepare(`
            SELECT signature, thought_text as thoughtText, timestamp
            FROM signatures
            WHERE tool_call_id = ?
        `);

        this.stmtHas = this.db.prepare(`
            SELECT 1 FROM signatures WHERE tool_call_id = ?
        `);

        this.stmtCount = this.db.prepare(`
            SELECT COUNT(*) as count FROM signatures
        `);

        this.stmtDeleteOldest = this.db.prepare(`
            DELETE FROM signatures
            WHERE tool_call_id IN (
                SELECT tool_call_id FROM signatures
                ORDER BY timestamp ASC
                LIMIT ?
            )
        `);

        this.stmtDeleteExpired = this.db.prepare(`
            DELETE FROM signatures WHERE timestamp < ?
        `);
    }

    /**
     * Store a thought signature for a given tool_call_id
     */
    store(toolCallId: string, signature: string, thoughtText: string): void {
        const timestamp = Date.now();
        
        // Update L1 Cache
        if (this.l1Cache.size >= SignatureCache.L1_CACHE_SIZE) {
            const firstKey = this.l1Cache.keys().next().value;
            if (firstKey) this.l1Cache.delete(firstKey);
        }
        this.l1Cache.set(toolCallId, {signature, thoughtText, timestamp});

        // Enforce max size by removing oldest entries if needed
        const count = (this.stmtCount.get() as {count: number}).count;
        if (count >= MAX_CACHE_SIZE) {
            const toDelete = Math.floor(MAX_CACHE_SIZE / 10);
            this.stmtDeleteOldest.run(toDelete);
        }

        this.stmtInsert.run(toolCallId, signature, thoughtText, timestamp);
    }

    /**
     * Retrieve a cached signature by tool_call_id
     */
    get(toolCallId: string): CachedSignature | undefined {
        // Check L1 Cache first
        if (this.l1Cache.has(toolCallId)) {
            return this.l1Cache.get(toolCallId);
        }

        const row = this.stmtGet.get(toolCallId) as {signature: string; thoughtText: string; timestamp: number} | undefined;
        if (!row) {
            return undefined;
        }
        
        const cached = {
            signature: row.signature,
            thoughtText: row.thoughtText,
            timestamp: row.timestamp
        };

        // Populate L1 Cache
        if (this.l1Cache.size >= SignatureCache.L1_CACHE_SIZE) {
            const firstKey = this.l1Cache.keys().next().value;
            if (firstKey) this.l1Cache.delete(firstKey);
        }
        this.l1Cache.set(toolCallId, cached);

        return cached;
    }

    /**
     * Check if a signature exists for a tool_call_id
     */
    has(toolCallId: string): boolean {
        if (this.l1Cache.has(toolCallId)) {
            return true;
        }
        return this.stmtHas.get(toolCallId) !== undefined;
    }

    /**
     * Remove expired entries from the cache
     */
    private cleanup(): void {
        const expiryTime = Date.now() - CACHE_EXPIRY_MS;
        
        // Cleanup L1 Cache
        for (const [key, value] of this.l1Cache.entries()) {
            if (value.timestamp < expiryTime) {
                this.l1Cache.delete(key);
            }
        }

        this.stmtDeleteExpired.run(expiryTime);
    }

    /**
     * Get cache size (for debugging/monitoring)
     */
    get size(): number {
        return (this.stmtCount.get() as {count: number}).count;
    }

    /**
     * Clear all entries from the cache (useful for testing)
     */
    clear(): void {
        this.l1Cache.clear();
        this.db.exec("DELETE FROM signatures");
    }

    /**
     * Stop the cleanup interval and close database (for graceful shutdown)
     */
    destroy(): void {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
        this.db.close();
    }
}

// Singleton instance
export const signatureCache = new SignatureCache();
