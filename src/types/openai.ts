export type Role = "user" | "assistant" | "tool" | "system" | "developer";

export type ChatCompletionRequest = {
    model: string;
    messages: ChatMessage[];
    temperature?: number;
    stream?: boolean;
    reasoning_effort?: ReasoningEffort;
    reasoning?: {
        effort?: ReasoningEffort;
    }
    tools?: Tool[];
    tool_choice?: ToolChoice;
};

export enum ReasoningEffort {
    low = "low",
    medium = "medium",
    high = "high",
}

export type Tool = {
    type: "function";
    function: FunctionDeclaration;
};

export type FunctionDeclaration = {
    name: string;
    description: string;
    parameters: object;
};

export type ToolChoice = "none" | "auto" | {type: "function"; function: {name: string}};

export type ToolCall = {
    index: number;
    id: string;
    type: "function";
    function: {
        name: string;
        arguments: string;
    };
};

export type ChatMessage = {
    role: Role;
    content: string | MessageContent[];
    tool_calls?: ToolCall[];
    tool_call_id?: string;
    // Thinking/reasoning fields that clients may include in message history
    // VS Code Copilot uses Anthropic-style fields
    thinking?: string;
    signature?: string;
    // Alternative field names for other providers
    cot_id?: string;
    cot_summary?: string;
    reasoning_opaque?: string;
    reasoning_text?: string;
};

export type MessageContent = {
    type: "text" | "image_url";
    text?: string;
    image_url?: {
        url: string;
        detail?: "low" | "high" | "auto";
    };
};

export interface ChatCompletionResponse {
    id: string;
    object: "chat.completion";
    created: number;
    model: string;
    choices: ChatCompletionChoice[];
    usage?: ChatCompletionUsage;
}

export type ChatCompletionChoice = {
    index: number;
    message: ChatCompletionMessage;
    finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null;
};

export type ChatCompletionMessage = {
    role: "assistant";
    content: string | null;
    tool_calls?: ToolCall[];
};

export type ChatCompletionUsage = {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
};

export type StreamDelta = {
    role?: string;
    content?: string | null;
    tool_calls?: ToolCall[];
    native_tool_calls?: NativeToolResponse[];
    grounding?: unknown;
    // Thinking/reasoning fields - VS Code Copilot expects Anthropic-style format
    // See: vscode-copilot-chat/src/platform/thinking/common/thinking.ts (RawThinkingDelta)
    thinking?: string;      // Anthropic: thinking text content
    signature?: string;     // Anthropic: signature ID for multi-turn conversations
    // Alternative field names for other providers (Azure OpenAI, Copilot API)
    cot_id?: string;
    cot_summary?: string;
    reasoning_opaque?: string;
    reasoning_text?: string;
};

export type NativeToolResponse = {
    type: "search" | "url_context";
    data: unknown;
    metadata?: unknown;
};

export type StreamChunk = {
    id: string;
    object: string;
    created: number;
    model: string;
    choices: [{
        index: number;
        delta: StreamDelta;
        finish_reason: string | null;
        logprobs?: null;
    }];
    usage?: UsageData | null;
};

export type UsageData = {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
};
