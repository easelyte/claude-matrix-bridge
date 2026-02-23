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

server.tool(
  'share_sensitive_data',
  'CRITICAL: Use this to share ANY sensitive data (API keys, tokens, passwords, credentials) with the user via a secure viewer link instead of posting in chat. Returns a one-time secure URL. The data is NOT logged in conversation history.',
  {
    label: z.string().describe('Short description of the sensitive data, e.g. "Gemini API Key" or "Database Password"'),
    content: z.string().describe('The sensitive data to share securely'),
    ttl: z.number().optional().describe('Time-to-live in seconds (default: 3600 = 1 hour, max: 86400 = 24 hours)'),
  },
  async ({ label, content, ttl }) => {
    try {
      const postRes = await fetch(`${BRIDGE_API}/share-sensitive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label, content, ttl: ttl || 3600, roomId: ROOM_ID }),
      });

      if (!postRes.ok) {
        const err = await postRes.text();
        return { content: [{ type: 'text', text: `Error creating secure link: ${err}` }] };
      }

      const { url, expiresAt } = await postRes.json();
      return {
        content: [{
          type: 'text',
          text: `Secure link created for "${label}":\n${url}\n\nThis link expires at ${new Date(expiresAt).toISOString()} and can only be viewed once.`
        }]
      };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
    }
  }
);

server.tool(
  'redact_message',
  'Redact (delete) a message that was sent by the bridge to the user in the Matrix chat. Use this to remove sensitive information that was accidentally posted. Note: Only messages sent by the bridge bot can be redacted.',
  {
    eventId: z.string().describe('The Matrix event ID of the message to redact'),
    reason: z.string().optional().describe('Optional reason for redacting the message'),
  },
  async ({ eventId, reason }) => {
    try {
      const postRes = await fetch(`${BRIDGE_API}/redact-message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: ROOM_ID, eventId, reason }),
      });

      if (!postRes.ok) {
        const err = await postRes.text();
        return { content: [{ type: 'text', text: `Error redacting message: ${err}` }] };
      }

      return {
        content: [{
          type: 'text',
          text: `Message ${eventId} has been redacted.${reason ? ` Reason: ${reason}` : ''}`
        }]
      };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
