/**
 * Stand-ins for the two hooks the agent panel loads (`useAgent` from
 * agents/react and `useAgentChat` from @cloudflare/ai-chat/react). The real
 * ones open a WebSocket to the mailbox's agent; these keep the conversation in
 * memory and answer from the mail on the page (see ai.ts). No model is called.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { type AgentMessage, type AgentPart, agentHistory, agentReply, setAgentHistory } from "./ai";
import { demo } from "./install";

interface DemoAgent {
	agent: string;
	name: string;
}

function useAgent(options: { agent: string; name: string }): DemoAgent {
	return { agent: options.agent, name: options.name };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function useAgentChat({ agent }: { agent: DemoAgent; getInitialMessages?: unknown }) {
	const mailboxId = agent.name;
	const [messages, setMessagesState] = useState<AgentMessage[]>(() => agentHistory(demo().store, mailboxId));
	const [status, setStatus] = useState<"ready" | "submitted" | "streaming">("ready");
	// Bumped by stop/clear and on unmount, so a reply in progress stops writing.
	const run = useRef(0);
	useEffect(() => () => void run.current++, []);

	const setMessages = useCallback(
		(next: AgentMessage[]) => {
			setAgentHistory(mailboxId, next);
			setMessagesState(next);
		},
		[mailboxId],
	);

	const sendMessage = useCallback(
		async ({ text }: { text: string }) => {
			const mine = ++run.current;
			const base = [...agentHistory(demo().store, mailboxId), { id: `demo-u-${Date.now()}`, role: "user" as const, parts: [{ type: "text", text }] }];
			setMessages(base);
			setStatus("submitted");
			await wait(500);
			if (mine !== run.current) return;

			const parts = agentReply(demo().store, mailboxId, text);
			const reply = (shown: AgentPart[]): AgentMessage => ({ id: `demo-a-${mine}-${base.length}`, role: "assistant", parts: shown });
			setStatus("streaming");
			// Tool steps first, then the answer a few words at a time.
			const shown: AgentPart[] = [];
			for (const part of parts) {
				if (part.type !== "text") {
					shown.push(part);
					setMessages([...base, reply([...shown])]);
					if (part.type !== "step-start") await wait(350);
				} else {
					const words = (part.text ?? "").split(/(?<=\s)/);
					for (let i = 4; i < words.length + 4; i += 4) {
						setMessages([...base, reply([...shown, { type: "text", text: words.slice(0, i).join("") }])]);
						await wait(40);
						if (mine !== run.current) break;
					}
					shown.push(part);
				}
				if (mine !== run.current) return;
			}
			setMessages([...base, reply(parts)]);
			setStatus("ready");
		},
		[mailboxId, setMessages],
	);

	const stop = useCallback(() => {
		run.current++;
		setStatus("ready");
	}, []);

	const clearHistory = useCallback(() => {
		run.current++;
		setStatus("ready");
		setMessages([]);
	}, [setMessages]);

	return { messages, sendMessage, status, clearHistory, stop };
}

export const demoAgentHooks = { useAgent, useAgentChat };
