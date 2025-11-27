/**
 * In-memory cache for thought signatures.
 *
 * Gemini requires thought_signature to be included with function calls that follow
 * thinking blocks. Since VS Code Copilot strips custom attributes from message content,
 * we cache the signature server-side using the tool_call_id as the key.
 */

interface CachedSignature {
    signature: string;
    thoughtText: string;
    timestamp: number;
}

// Cache expiry time: 1 hour (signatures shouldn't be needed after a conversation ends)
const CACHE_EXPIRY_MS = 60 * 60 * 1000;

// Maximum cache size to prevent memory leaks
const MAX_CACHE_SIZE = 10000;

class SignatureCache {
    private cache: Map<string, CachedSignature> = new Map();
    private cleanupInterval: ReturnType<typeof setInterval> | null = null;

    constructor() {
        // Run cleanup every 10 minutes
        this.cleanupInterval = setInterval(() => this.cleanup(), 10 * 60 * 1000);
    }

    /**
     * Store a thought signature for a given tool_call_id
     */
    store(toolCallId: string, signature: string, thoughtText: string): void {
        // Enforce max size by removing oldest entries if needed
        if (this.cache.size >= MAX_CACHE_SIZE) {
            const oldest = Array.from(this.cache.entries())
                .sort((a, b) => a[1].timestamp - b[1].timestamp)
                .slice(0, Math.floor(MAX_CACHE_SIZE / 10));

            for (const [key] of oldest) {
                this.cache.delete(key);
            }
        }

        this.cache.set(toolCallId, {
            signature,
            thoughtText,
            timestamp: Date.now()
        });
    }

    /**
     * Retrieve a cached signature by tool_call_id
     */
    get(toolCallId: string): CachedSignature | undefined {
        return this.cache.get(toolCallId);
    }

    /**
     * Check if a signature exists for a tool_call_id
     */
    has(toolCallId: string): boolean {
        return this.cache.has(toolCallId);
    }

    /**
     * Remove expired entries from the cache
     */
    private cleanup(): void {
        const now = Date.now();
        for (const [key, value] of this.cache.entries()) {
            if (now - value.timestamp > CACHE_EXPIRY_MS) {
                this.cache.delete(key);
            }
        }
    }

    /**
     * Get cache size (for debugging/monitoring)
     */
    get size(): number {
        return this.cache.size;
    }

    /**
     * Stop the cleanup interval (for graceful shutdown)
     */
    destroy(): void {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
    }
}

// Singleton instance
export const signatureCache = new SignatureCache();
