#!/usr/bin/env node

// MCP server that provides an ask_user tool.
// When called, it posts the question to the bridge's HTTP API,
// then polls for the user's answer.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BRIDGE_API = process.env.BRIDGE_API_URL || 'http://127.0.0.1:9802';
const ROOM_ID = process.env.BRIDGE_ROOM_ID || null;
const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 300000; // 5 min max wait

const server = new McpServer({
  name: 'ask-user',
  version: '1.0.0',
});

server.tool(
  'ask_user',
  'Ask the user a question with optional multiple-choice options. Use this instead of AskUserQuestion when you need user input.',
  {
    question: z.string().describe('The question to ask the user'),
    header: z.string().optional().describe('Short label for the question (max 12 chars)'),
    options: z.array(z.object({
      label: z.string().describe('Option label (1-5 words)'),
      description: z.string().optional().describe('Description of this option'),
    })).optional().describe('Multiple choice options. Omit for free-text questions.'),
    multiSelect: z.boolean().optional().describe('If true, user can select multiple options before submitting. Defaults to false (pick one).'),
  },
  async ({ question, header, options, multiSelect }) => {
    try {
      // Post question to bridge
      const postRes = await fetch(`${BRIDGE_API}/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, header, options, multiSelect: multiSelect || false, roomId: ROOM_ID }),
      });

      if (!postRes.ok) {
        const err = await postRes.text();
        return { content: [{ type: 'text', text: `Error posting question: ${err}` }] };
      }

      const { questionId } = await postRes.json();

      // Poll for answer
      const deadline = Date.now() + POLL_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

        const pollRes = await fetch(`${BRIDGE_API}/ask/${questionId}`);
        if (!pollRes.ok) continue;

        const data = await pollRes.json();
        if (data.answered) {
          return { content: [{ type: 'text', text: data.answer }] };
        }
      }

      return { content: [{ type: 'text', text: 'Question timed out — no answer received within 5 minutes.' }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
    }
  }
);

server.tool(
  'request_secret',
  'Request a secret from the user via a secure web form. The secret is written to a file and the file path is returned. Use this for API keys, tokens, passwords — anything that should not appear in chat.',
  {
    label: z.string().describe('A short label describing what secret is needed, e.g. "AWS access key" or "database password"'),
  },
  async ({ label }) => {
    try {
      const postRes = await fetch(`${BRIDGE_API}/secret`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label, roomId: ROOM_ID }),
      });

      if (!postRes.ok) {
        const err = await postRes.text();
        return { content: [{ type: 'text', text: `Error requesting secret: ${err}` }] };
      }

      const { secretId } = await postRes.json();

      // Poll for the secret to be submitted
      const deadline = Date.now() + POLL_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

        const pollRes = await fetch(`${BRIDGE_API}/secret/${secretId}`);
        if (!pollRes.ok) continue;

        const data = await pollRes.json();
        if (data.answered) {
          return { content: [{ type: 'text', text: `Secret written to: ${data.path}` }] };
        }
      }

      return { content: [{ type: 'text', text: 'Secret request timed out — no input received within 5 minutes.' }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
