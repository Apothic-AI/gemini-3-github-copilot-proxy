import {OAuth2Client} from "google-auth-library";
import * as OpenAI from "../types/openai.js";
import * as Gemini from "../types/gemini.js";
import {CODE_ASSIST_API_VERSION, CODE_ASSIST_ENDPOINT, OPENAI_CHAT_COMPLETION_OBJECT} from "../utils/constant.js";
import {AutoModelSwitchingHelper, type RetryableRequestData} from "./auto-model-switching.js";
import {getLogger, Logger} from "../utils/logger.js";
import {signatureCache} from "./signature-cache.js";
import chalk from "chalk";

/**
 * Custom error class for Gemini API errors with status code information
 */
export class GeminiApiError extends Error {
    constructor(
        message: string,
        public readonly statusCode: number,
        public readonly responseText?: string
    ) {
        super(message);
        this.name = "GeminiApiError";
    }
}

/**
 * Handles communication with Google's Gemini API through the Code Assist endpoint.
 */
export class GeminiApiClient {
    private projectId: string | null = null;
    private firstChunk: boolean = true;
    private readonly creationTime: number;
    private readonly chatID: string;
    private readonly autoSwitcher: AutoModelSwitchingHelper;
    private readonly logger: Logger;

    constructor(
        private readonly authClient: OAuth2Client,
        private readonly googleCloudProject: string | undefined,
        private readonly disableAutoModelSwitch: boolean,
    ) {
        this.googleCloudProject = googleCloudProject;
        this.chatID = `chat-${crypto.randomUUID()}`;
        this.creationTime = Math.floor(Date.now() / 1000);
        this.autoSwitcher = AutoModelSwitchingHelper.getInstance();
        this.logger = getLogger("GEMINI-CLIENT", chalk.blue);
    }

    /**
     * Discovers the Google Cloud project ID.
     */
    public async discoverProjectId(): Promise<string> {
        if (this.googleCloudProject) {
            return this.googleCloudProject;
        }
        if (this.projectId) {
            return this.projectId;
        }

        try {
            const initialProjectId = "default-project";
            const loadResponse = (await this.callEndpoint("loadCodeAssist", {
                cloudaicompanionProject: initialProjectId,
                metadata: {duetProject: initialProjectId},
            })) as Gemini.ProjectDiscoveryResponse;

            if (loadResponse.cloudaicompanionProject) {
                this.projectId = loadResponse.cloudaicompanionProject;
                return loadResponse.cloudaicompanionProject;
            }

            const defaultTier = loadResponse.allowedTiers?.find((tier) => tier.isDefault);
            const tierId = defaultTier?.id ?? "free-tier";
            const onboardRequest = {
                tierId,
                cloudaicompanionProject: initialProjectId,
            };

            // Poll until operation is complete with timeout protection
            const MAX_RETRIES = 30 ;
            let retryCount = 0;
            let lroResponse: Gemini.OnboardUserResponse | undefined;
            while (retryCount < MAX_RETRIES) {
                lroResponse = (await this.callEndpoint("onboardUser", onboardRequest)) as Gemini.OnboardUserResponse;
                if (lroResponse.done) {
                    break;
                }
                await new Promise((resolve) => setTimeout(resolve, 1000));
                retryCount++;
            }

            if (!lroResponse?.done) {
                throw new Error("common:errors.geminiCli.onboardingTimeout");
            }

            this.projectId = lroResponse.response?.cloudaicompanionProject?.id ?? initialProjectId;
            return this.projectId;
        } catch (error: unknown) {
            this.logger.error("Failed to discover project ID", error);
            throw new Error("Could not discover project ID.");
        }
    }

    private async callEndpoint(method: string, body: Record<string, unknown>): Promise<unknown> {
        const {token} = await this.authClient.getAccessToken();
        const response = await fetch(`${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_API_VERSION}:${method}`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify(body),
            },
        );

        if (!response.ok) {
            const errorText = await response.text();
            throw new GeminiApiError(
                `API call failed with status ${response.status}: ${errorText}`,
                response.status,
                errorText
            );
        }

        return response.json();
    }

    /**
     * Get non-streaming completion from Gemini API.
     */
    async getCompletion(
        geminiCompletionRequest: Gemini.ChatCompletionRequest,
        isRetry: boolean = false,
    ): Promise<{
        content: string;
        tool_calls?: OpenAI.ToolCall[];
        usage?: {
            inputTokens: number;
            outputTokens: number;
        };
        _autoSwitchNotification?: string;
    }> {
        try {
            const chunks: OpenAI.StreamChunk[] = [];
            for await (const chunk of this.streamContent(geminiCompletionRequest, isRetry)) {
                chunks.push(chunk);
            }

            let content = "";
            const tool_calls: OpenAI.ToolCall[] = [];
            let usage: {inputTokens: number; outputTokens: number} | undefined;

            for (const chunk of chunks) {
                if (chunk.choices[0].delta.content) {
                    content += chunk.choices[0].delta.content;
                }
                if (chunk.choices[0].delta.tool_calls) {
                    tool_calls.push(...chunk.choices[0].delta.tool_calls);
                }
                if (chunk.usage) {
                    usage = {
                        inputTokens: chunk.usage.prompt_tokens,
                        outputTokens: chunk.usage.completion_tokens,
                    };
                }
            }


            return {
                content,
                tool_calls: tool_calls.length > 0 ? tool_calls : undefined,
                usage,
            };
        } catch (error) {
            if (error instanceof GeminiApiError && 
                !this.disableAutoModelSwitch &&
                this.autoSwitcher.isRateLimitError(error.statusCode) &&
                this.autoSwitcher.shouldAttemptFallback(geminiCompletionRequest.model)) {
                
                // Attempt fallback using auto-switching helper
                return await this.autoSwitcher.handleNonStreamingFallback(
                    geminiCompletionRequest.model,
                    error.statusCode,
                    geminiCompletionRequest,
                    async (model: string, data: RetryableRequestData) => {
                        const updatedRequest = {...data, model} as Gemini.ChatCompletionRequest;
                        return await this.getCompletion(updatedRequest, isRetry);
                    }
                ) as Promise<{
                    content: string;
                    tool_calls?: OpenAI.ToolCall[];
                    usage?: {
                        inputTokens: number;
                        outputTokens: number;
                    };
                    _autoSwitchNotification?: string;
                }>;
            }
            throw error;
        }
    }

    /**
     * Stream content from Gemini API.
     */
    async* streamContent(
        geminiCompletionRequest: Gemini.ChatCompletionRequest,
        isRetry: boolean = false,
    ): AsyncGenerator<OpenAI.StreamChunk> {
        try {
            yield* this.streamContentInternal(geminiCompletionRequest, isRetry);
        } catch (error) {
            if (error instanceof GeminiApiError && 
                !this.disableAutoModelSwitch &&
                this.autoSwitcher.isRateLimitError(error.statusCode) &&
                this.autoSwitcher.shouldAttemptFallback(geminiCompletionRequest.model)) {
                
                // eslint-disable-next-line @typescript-eslint/no-this-alias
                const self = this;
                yield* this.autoSwitcher.handleStreamingFallback(
                    geminiCompletionRequest.model,
                    error.statusCode,
                    geminiCompletionRequest,
                    async function* (model: string, data: RetryableRequestData) {
                        const updatedRequest = {...data, model} as Gemini.ChatCompletionRequest;
                        // Create new client instance to reset firstChunk state
                        const fallbackClient = new GeminiApiClient(
                            self.authClient,
                            self.googleCloudProject,
                            self.disableAutoModelSwitch,
                        );
                        yield* fallbackClient.streamContent(updatedRequest, isRetry);
                    },
                    "openai"
                ) as AsyncIterable<OpenAI.StreamChunk>;
                return;
            }
            throw error;
        }
    }

    /**
     * Internal streaming method with no retry logic
     */
    private async* streamContentInternal(
        geminiCompletionRequest: Gemini.ChatCompletionRequest,
        isRetry: boolean = false,
    ): AsyncGenerator<OpenAI.StreamChunk> {
        const {token} = await this.authClient.getAccessToken();
        const response = await fetch(
            `${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_API_VERSION}:streamGenerateContent?alt=sse`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify(geminiCompletionRequest),
            },
        );

        if (!response.ok) {
            if (response.status === 401 && !isRetry) {
                this.logger.info("Got 401 error, forcing token refresh and retrying...");
                this.authClient.credentials.access_token = undefined;
                yield* this.streamContentInternal(geminiCompletionRequest, true);
                return;
            }
            const errorText = await response.text();
            throw new GeminiApiError(
                `Stream request failed: ${response.status} ${errorText}`,
                response.status,
                errorText
            );
        }

        if (!response.body) {
            throw new Error("Response has no body");
        }

        let toolCallId: string | undefined = undefined;
        let usageData: OpenAI.UsageData | undefined;
        let _thinkingInProgress = false;

        // Track thought signature and text for caching
        let currentThoughtSignature: string | undefined = undefined;
        let accumulatedThoughtText = "";

        // Buffer for parsing <thinking> tags from content (handles streaming chunks)
        let thinkingTagBuffer = "";
        let insideThinkingTag = false;

        for await (const jsonData of this.parseSSEStream(response.body)) {
            const candidate = jsonData.response?.candidates?.[0];

            // Debug logging (only shown with --log-level debug)
            if (this.logger.isDebugEnabled() && candidate?.content?.parts) {
                const partsArray = candidate.content.parts as Gemini.Part[];
                const hasThought = partsArray.some((p: Gemini.Part) => "text" in p && (p as Gemini.TextPart).thought);
                const hasFunctionCall = partsArray.some((p: Gemini.Part) => "functionCall" in p);

                // Only log full structure for thinking or function call parts
                if (hasThought || hasFunctionCall) {
                    this.logger.debug(`Full candidate content: ${JSON.stringify(candidate.content, null, 2).substring(0, 1000)}`);
                }
            }

            if (candidate?.content?.parts) {
                const partsArray = candidate.content.parts as Gemini.Part[];

                for (const part of partsArray) {
                    if ("text" in part) {
                        // Handle text content
                        if (part.thought === true) {
                            // Handle thinking content from Gemini
                            const thinkingText = part.text;

                            // Capture signature and accumulate thought text for caching
                            // Check both naming conventions (Gemini uses thoughtSignature in REST API)
                            const textPart = part as Gemini.TextPart;
                            const sig = textPart.thought_signature || textPart.thoughtSignature;
                            if (sig) {
                                currentThoughtSignature = sig;
                                this.logger.debug("Found signature on thought text part");
                            }
                            accumulatedThoughtText += thinkingText;

                            // Send thinking content using Anthropic-style fields that VS Code Copilot expects
                            // See: vscode-copilot-chat/src/platform/thinking/common/thinking.ts (RawThinkingDelta)
                            // - thinking: string (text content)
                            // - signature: string (ID for multi-turn conversations)
                            const thinkingDelta: OpenAI.StreamDelta = {
                                thinking: thinkingText,
                            };

                            // Include signature - required for multi-turn conversations with tool calls
                            if (currentThoughtSignature) {
                                thinkingDelta.signature = currentThoughtSignature;
                            }

                            if (this.firstChunk) {
                                thinkingDelta.role = "assistant";
                                this.firstChunk = false;
                            }

                            _thinkingInProgress = true;
                            yield this.createOpenAIChunk(thinkingDelta, geminiCompletionRequest.model);
                        } else {
                            // Handle regular content - check for <thinking> tags
                            let text = part.text;

                            // Process text to extract any <thinking> blocks
                            // This handles cases where thinking comes as raw text with tags
                            while (text.length > 0) {
                                if (insideThinkingTag) {
                                    // We're inside a thinking block, look for closing tag
                                    const closeIndex = text.indexOf("</thinking>");
                                    if (closeIndex !== -1) {
                                        // Found closing tag - emit thinking content
                                        const thinkingContent = thinkingTagBuffer + text.substring(0, closeIndex);
                                        thinkingTagBuffer = "";
                                        insideThinkingTag = false;
                                        _thinkingInProgress = false;

                                        // Emit thinking via proper delta field
                                        const thinkingDelta: OpenAI.StreamDelta = {
                                            thinking: thinkingContent,
                                        };
                                        if (currentThoughtSignature) {
                                            thinkingDelta.signature = currentThoughtSignature;
                                        }
                                        if (this.firstChunk) {
                                            thinkingDelta.role = "assistant";
                                            this.firstChunk = false;
                                        }
                                        accumulatedThoughtText += thinkingContent;
                                        yield this.createOpenAIChunk(thinkingDelta, geminiCompletionRequest.model);

                                        // Continue processing remaining text after </thinking>
                                        text = text.substring(closeIndex + "</thinking>".length);
                                    } else {
                                        // No closing tag yet, buffer the content
                                        thinkingTagBuffer += text;
                                        text = "";
                                    }
                                } else {
                                    // Look for opening <thinking> tag
                                    const openIndex = text.indexOf("<thinking>");
                                    if (openIndex !== -1) {
                                        // Found opening tag
                                        const beforeThinking = text.substring(0, openIndex);

                                        // Emit any content before the thinking tag
                                        if (beforeThinking.length > 0) {
                                            const delta: OpenAI.StreamDelta = {content: beforeThinking};
                                            if (this.firstChunk) {
                                                delta.role = "assistant";
                                                this.firstChunk = false;
                                            }
                                            yield this.createOpenAIChunk(delta, geminiCompletionRequest.model);
                                        }

                                        // Start buffering thinking content
                                        insideThinkingTag = true;
                                        _thinkingInProgress = true;
                                        text = text.substring(openIndex + "<thinking>".length);
                                    } else {
                                        // Check for partial opening tag at end of chunk
                                        // (e.g., text ends with "<thin" which might continue with "king>" in next chunk)
                                        let partialTagStart = -1;
                                        const possibleStarts = ["<", "<t", "<th", "<thi", "<thin", "<think", "<thinki", "<thinkin", "<thinking"];
                                        for (const start of possibleStarts) {
                                            if (text.endsWith(start)) {
                                                partialTagStart = text.length - start.length;
                                                break;
                                            }
                                        }

                                        if (partialTagStart !== -1) {
                                            // Emit content before potential partial tag
                                            const safeContent = text.substring(0, partialTagStart);
                                            if (safeContent.length > 0) {
                                                const delta: OpenAI.StreamDelta = {content: safeContent};
                                                if (this.firstChunk) {
                                                    delta.role = "assistant";
                                                    this.firstChunk = false;
                                                }
                                                yield this.createOpenAIChunk(delta, geminiCompletionRequest.model);
                                            }
                                            // Buffer the potential partial tag
                                            thinkingTagBuffer = text.substring(partialTagStart);
                                        } else {
                                            // No thinking tags, emit as regular content
                                            // But first check if we have buffered content that wasn't a tag
                                            if (thinkingTagBuffer.length > 0) {
                                                text = thinkingTagBuffer + text;
                                                thinkingTagBuffer = "";
                                            }

                                            _thinkingInProgress = false;
                                            const delta: OpenAI.StreamDelta = {content: text};
                                            if (this.firstChunk) {
                                                delta.role = "assistant";
                                                this.firstChunk = false;
                                            }
                                            yield this.createOpenAIChunk(delta, geminiCompletionRequest.model);
                                        }
                                        text = "";
                                    }
                                }
                            }
                        }
                    }
                    else if ("functionCall" in part) {
                        // Handle function calls from Gemini
                        _thinkingInProgress = false;

                        // FunctionCallPart can also have thought_signature directly on it
                        // Check both naming conventions (Gemini uses thoughtSignature in REST API)
                        const funcPart = part as Gemini.FunctionCallPart;
                        const funcSig = funcPart.thought_signature || funcPart.thoughtSignature;
                        if (funcSig && !currentThoughtSignature) {
                            currentThoughtSignature = funcSig;
                            this.logger.debug(`Found signature on functionCall part: ${funcSig.substring(0, 50)}...`);
                        }

                        toolCallId = `call_${crypto.randomUUID()}`;

                        // Cache the thought signature with this tool_call_id
                        // This allows us to restore it when the message comes back in the history
                        if (currentThoughtSignature) {
                            signatureCache.store(toolCallId, currentThoughtSignature, accumulatedThoughtText);
                            this.logger.debug(`Cached signature for tool_call_id: ${toolCallId}`);
                        } else {
                            this.logger.debug(`No signature to cache for tool_call_id: ${toolCallId}`);
                        }

                        const delta: OpenAI.StreamDelta = {
                            tool_calls: [{
                                index: 0,
                                id: toolCallId,
                                type: "function",
                                function: {
                                    name: part.functionCall.name,
                                    arguments: JSON.stringify(part.functionCall.args)
                                }
                            }]
                        };

                        if (this.firstChunk) {
                            delta.role = "assistant";
                            delta.content = null;
                            this.firstChunk = false;
                        }

                        yield this.createOpenAIChunk(delta, geminiCompletionRequest.model);
                    }
                }
            }

            if (jsonData.response?.usageMetadata) {
                const usage = jsonData.response.usageMetadata;
                const prompt_tokens = usage.promptTokenCount ?? 0;
                const completion_tokens = usage.candidatesTokenCount ?? 0;
                usageData = {
                    prompt_tokens,
                    completion_tokens,
                    total_tokens: prompt_tokens + completion_tokens,
                };
            }
        }

        // Send final chunk with usage data
        const finishReason = toolCallId ? "tool_calls" : "stop";
        const finalChunk = this.createOpenAIChunk({}, geminiCompletionRequest.model, finishReason);

        if (usageData) {
            finalChunk.usage = usageData;
        }

        yield finalChunk;
    }

    /**
     * Creates an OpenAI stream chunk with the given delta
     */
    private createOpenAIChunk(delta: OpenAI.StreamDelta, modelId: string, finishReason: string | null = null): OpenAI.StreamChunk {
        return {
            id: this.chatID,
            object: OPENAI_CHAT_COMPLETION_OBJECT,
            created: this.creationTime,
            model: modelId,
            choices: [{
                index: 0,
                delta,
                finish_reason: finishReason,
                logprobs: null
            }],
            usage: null
        };
    }

    /**
     * Parses a server-sent event (SSE) stream from the Gemini API.
     */
    private async* parseSSEStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<Gemini.Response> {
        const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = "";
        let objectBuffer = "";

        while (true) {
            const {done, value} = await reader.read();
            if (done) {
                if (objectBuffer) {
                    try {
                        yield JSON.parse(objectBuffer);
                    } catch (e) {
                        this.logger.error("Error parsing final SSE JSON object", e);
                    }
                }
                break;
            }

            buffer += value;
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
                if (line.trim() === "") {
                    if (objectBuffer) {
                        try {
                            yield JSON.parse(objectBuffer);
                        } catch (e) {
                            this.logger.error("Error parsing SSE JSON object", e);
                        }
                        objectBuffer = "";
                    }
                } else if (line.startsWith("data: ")) {
                    objectBuffer += line.substring(6);
                }
            }
        }
    }
}

