import * as OpenAI from "../types/openai.js";
import * as Gemini from "../types/gemini.js";
import {DEFAULT_TEMPERATURE} from "../utils/constant.js";
import {mapModelToGemini, mapJsonSchemaToGemini} from "./mapper.js";
import {signatureCache} from "./signature-cache.js";
import {getLogger} from "../utils/logger.js";
import chalk from "chalk";

const logger = getLogger("OPENAI-MAPPER", chalk.yellow);

// Models that have thinking/reasoning enabled by default and require thought_signature
const THINKING_MODELS = new Set([
    Gemini.Model.Gemini3ProPreview,
    Gemini.Model.Gemini25Pro,
    Gemini.Model.Gemini25Flash,
]);

export const mapOpenAIChatCompletionRequestToGemini = (
    project: string,
    request: OpenAI.ChatCompletionRequest,
): Gemini.ChatCompletionRequest => {
    const model = mapModelToGemini(request.model);
    const reasoningEffort = request.reasoning_effort ?? request.reasoning?.effort;
    const messages = request.messages ?? [];
    const messagesWithoutSystem = messages.filter((message) => !isSystemMessage(message));
    const geminiRequest: Gemini.ChatCompletionRequestBody = {
        contents: mapOpenAIMessagesToGeminiFormat(messagesWithoutSystem),
        generationConfig: {
            temperature: request.temperature ?? DEFAULT_TEMPERATURE,
        }
    };

    if (messages.length > 0) {
        geminiRequest.systemInstruction = mapSystemInstruction(messages);
    }
    if (request.tools) {
        geminiRequest.tools = [{functionDeclarations: request.tools?.map((tool) => convertOpenAIFunctionToGemini(tool.function))}];
    }
    if (request.tool_choice) {
        geminiRequest.toolConfig = mapToolChoiceToToolConfig(request.tool_choice);
    }

    // Always enable includeThoughts for models that support thinking
    // This ensures we receive thought_signature which is required for tool calls
    if (THINKING_MODELS.has(model)) {
        geminiRequest.generationConfig = {
            ...geminiRequest.generationConfig,
            thinkingConfig: getThinkingConfig(reasoningEffort) ?? {
                // Default thinking config for models that require it
                thinkingBudget: 8192,
                includeThoughts: true,
            },
        };
    } else if (reasoningEffort) {
        // For non-thinking models, only enable if explicitly requested
        geminiRequest.generationConfig = {
            ...geminiRequest.generationConfig,
            thinkingConfig: getThinkingConfig(reasoningEffort),
        };
    }

    return {
        model,
        project,
        request: geminiRequest,
    };
};

const mapSystemInstruction = (messages: OpenAI.ChatMessage[]): Gemini.SystemInstruction | undefined => {
    const systemMessage = messages.find(isSystemMessage);
    if (!systemMessage) {
        return;
    }

    let systemInstruction: Gemini.SystemInstruction | undefined;
    if (typeof systemMessage.content === "string") {
        systemInstruction = {
            parts: [{
                text: systemMessage.content
            }]
        };
    } else if (Array.isArray(systemMessage.content)) {
        const text = systemMessage.content
            .filter((message) => message.type === "text")
            .reduce((prev, next) => prev + next.text, "");

        systemInstruction = {
            parts: [{
                text,
            }]
        };
    }

    return systemInstruction;
};

const mapToolChoiceToToolConfig = (toolChoice?: OpenAI.ToolChoice): Gemini.ToolConfig | undefined => {
    if (!toolChoice) {
        return;
    }

    let mode: "AUTO" | "ANY" | "NONE" = "AUTO";
    let allowedFunctionNames: string[] | undefined = undefined;

    if (toolChoice === "none") {
        mode = "NONE";
    } else if (toolChoice === "auto") {
        mode = "AUTO";
    } else if (typeof toolChoice === "object") {
        mode = "ANY";
        allowedFunctionNames = [toolChoice.function.name];
    }
    return {functionCallingConfig: {mode, allowedFunctionNames}};
};

const isSystemMessage = (message: OpenAI.ChatMessage): boolean => message.role === "system" || message.role === "developer";

const mapOpenAIMessageToGeminiFormat = (msg: OpenAI.ChatMessage, prevMsg?: OpenAI.ChatMessage): Gemini.ChatMessage => {
    const role = msg.role === "assistant" ? "model" : "user";

    if (msg.role === "tool") {

        const originalToolCall = prevMsg?.tool_calls?.find(
            (tc: OpenAI.ToolCall) => tc.id === msg.tool_call_id
        );

        return {
            role: "user",
            parts: [{
                functionResponse: {
                    name: originalToolCall?.function.name ?? "unknown",
                    response: {
                        result: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)
                    }
                }
            }]
        };
    }

    if (msg.role === "assistant") {
        const parts: Gemini.Part[] = [];
        let content = typeof msg.content === "string" ? msg.content : "";

        // Debug logging (only shown with --log-level debug)
        logger.debug(`Assistant message content: ${content.substring(0, 200)}...`);
        if (msg.tool_calls) {
            logger.debug(`Tool calls: ${JSON.stringify(msg.tool_calls.map(tc => ({id: tc.id, name: tc.function?.name})))}`);
        }
        if (msg.thinking || msg.signature || msg.cot_summary || msg.cot_id) {
            logger.debug(`Thinking fields: thinking=${!!msg.thinking}, signature=${!!msg.signature}, cot_summary=${!!msg.cot_summary}, cot_id=${!!msg.cot_id}`);
        }

        // Try to get thought signature from multiple sources:
        // 1. From message fields (VS Code may include them)
        // 2. From cache using tool_call_ids
        // 3. From <thinking> tags in content (legacy fallback)
        let thoughtSignature: string | undefined = msg.signature || msg.cot_id || msg.reasoning_opaque;
        let thoughtText: string | undefined = msg.thinking || msg.cot_summary || msg.reasoning_text;

        if (msg.tool_calls && msg.tool_calls.length > 0) {
            // Look up signature from cache using tool_call_id
            logger.debug(`Looking up signatures for ${msg.tool_calls.length} tool calls, cache size: ${signatureCache.size}`);
            for (const toolCall of msg.tool_calls) {
                const cached = signatureCache.get(toolCall.id);
                if (cached) {
                    // Cache takes precedence if available
                    thoughtSignature = cached.signature;
                    thoughtText = thoughtText || cached.thoughtText;
                    logger.debug(`Found cached signature for tool_call_id: ${toolCall.id}`);
                    break;
                } else {
                    logger.debug(`No cached signature for tool_call_id: ${toolCall.id}`);
                }
            }
        }

        // Check for thinking block in content (legacy fallback)
        const thinkingMatch = content.match(/<thinking(?:\s+signature="[^"]*")?>([\s\S]*?)<\/thinking>/);
        if (thinkingMatch) {
            thoughtText = thoughtText || thinkingMatch[1];
            // Remove thinking block from content
            content = content.replace(thinkingMatch[0], "").trim();
        }

        // Add thinking part if we have thought text
        if (thoughtText) {
            parts.push({
                text: thoughtText,
                thought: true,
                thought_signature: thoughtSignature
            });
        }

        if (content) {
            parts.push({text: content});
        }

        if (msg.tool_calls && msg.tool_calls.length > 0) {
            for (const toolCall of msg.tool_calls) {
                if (toolCall.type === "function") {
                    parts.push({
                        functionCall: {
                            name: toolCall.function.name,
                            args: JSON.parse(toolCall.function.arguments)
                        },
                        thought_signature: thoughtSignature
                    });
                }
            }
        }

        return {role: "model", parts};
    }

    if (typeof msg.content === "string") {
        return {
            role,
            parts: [{text: msg.content}]
        };
    }

    if (Array.isArray(msg.content)) {
        const parts: Gemini.Part[] = [];
        for (const content of msg.content) {
            if (content.type === "text") {
                // Gemini API merges text parts without delimiter for consecutive user messages
                // which results awkward results
                // E.g: ["Create a file named test.ts", "then add test cases"] results
                // "Create a file named test.tsthen add test cases"
                let text = content.text ?? "";
                if (!text.endsWith("\n")) {
                    text += "\n";
                }
                parts.push({text});
            } else if (content.type === "image_url" && content.image_url) {
                const imageUrl = content.image_url.url;
                const match = imageUrl.match(/^data:(image\/.+);base64,(.+)$/);
                if (match) {
                    parts.push({
                        inlineData: {mimeType: match[1], data: match[2]},
                    });
                }
            }
        }

        return {role, parts};
    }

    // Fallback for unexpected content format
    return {
        role,
        parts: [{text: String(msg.content)}]
    };
};

const mapOpenAIMessagesToGeminiFormat = (messages: OpenAI.ChatMessage[]): Gemini.ChatMessage[] => {
    const geminiMessages: Gemini.ChatMessage[] = [];
    
    for (let i = 0; i < messages.length; i++) {
        const message = messages[i];

        if (message.role === "tool") {
            // Collect all consecutive tool messages
            const toolMessages = [message];
            while (i + 1 < messages.length && messages[i + 1].role === "tool") {
                toolMessages.push(messages[i + 1]);
                i++;
            }

            // Find the assistant message that triggered these calls
            let assistantMessage: OpenAI.ChatMessage | undefined;
            for (let j = i - toolMessages.length; j >= 0; j--) {
                if (messages[j].role === "assistant" && messages[j].tool_calls) {
                    assistantMessage = messages[j];
                    break;
                }
            }

            const parts: Gemini.Part[] = toolMessages.map(toolMsg => {
                const toolCallId = toolMsg.tool_call_id;
                const toolCall = assistantMessage?.tool_calls?.find(tc => tc.id === toolCallId);

                return {
                    functionResponse: {
                        name: toolCall?.function.name ?? "unknown",
                        response: {
                            result: typeof toolMsg.content === "string" ? toolMsg.content : JSON.stringify(toolMsg.content)
                        }
                    }
                };
            });

            geminiMessages.push({
                role: "user",
                parts: parts
            });
        } else {
            geminiMessages.push(mapOpenAIMessageToGeminiFormat(message));
        }
    }
    return geminiMessages;
};

const getThinkingConfig = (reasoningEffort?: string): Gemini.ThinkingConfig | undefined => {
    if (!reasoningEffort) {
        return;
    }

    const key = reasoningEffort as OpenAI.ReasoningEffort;
    if (!(key in thinkingBudgetMap)) {
        return;
    }

    return {
        thinkingBudget: thinkingBudgetMap[key],
        includeThoughts: true,
    };
};

const thinkingBudgetMap: Record<OpenAI.ReasoningEffort, number> = {
    [OpenAI.ReasoningEffort.low]: 1024,
    [OpenAI.ReasoningEffort.medium]: 8192,
    [OpenAI.ReasoningEffort.high]: 24576,
};

const convertOpenAIFunctionToGemini = (fn: OpenAI.FunctionDeclaration): Gemini.FunctionDeclaration => {
    // Only keep the fields that are valid for Gemini FunctionDeclaration
    const {name, description, parameters, ...extraFields} = fn;

    if (!parameters) {
        return {
            name: name || "",
            description: description || "",
            parameters: {}
        };
    }

    // Convert OpenAI JSON Schema to Gemini function parameters format
    const convertedParameters = mapJsonSchemaToGemini(parameters);

    return {
        name: name || "",
        description: description || "",
        parameters: convertedParameters
    };
};

