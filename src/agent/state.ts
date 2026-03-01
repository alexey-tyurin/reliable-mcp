import { Annotation, MessagesAnnotation } from '@langchain/langgraph';

export interface ToolResult {
  toolName: string;
  content: string;
  isError: boolean;
}

export interface AgentError {
  message: string;
  code: string;
}

export const AgentAnnotation = Annotation.Root({
  ...MessagesAnnotation.spec,
  userId: Annotation<string>(),
  sessionId: Annotation<string>(),
  toolResults: Annotation<ToolResult[]>({
    reducer: (current: ToolResult[], update: ToolResult[]): ToolResult[] => [...current, ...update],
    default: () => [],
  }),
  error: Annotation<AgentError | null>({
    reducer: (_current: AgentError | null, update: AgentError | null): AgentError | null => update,
    default: () => null,
  }),
});

export type AgentState = typeof AgentAnnotation.State;
